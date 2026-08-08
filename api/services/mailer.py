"""Outbound email, with the calendar part built the way mail clients need it.

The whole point of this module is the MIME shape:

    multipart/mixed
    ├── multipart/alternative
    │   ├── text/plain
    │   ├── text/html
    │   └── text/calendar; charset=utf-8; method=REQUEST   <- native invite UI
    └── application/ics; name=invite.ics (attachment)      <- everyone else

The calendar part must be an *alternative* carrying the `method=` parameter.
Ship it only as an attachment and Gmail/Outlook show a paperclip instead of
Yes/No/Maybe buttons — which is the entire feature.

The message is assembled with the legacy `email.mime` classes (compat32
policy) rather than EmailMessage on purpose: EmailMessage's policy rewrites
Content-Type params into quoted form (`method="REQUEST"`) and, worse,
normalizes CRLF to LF inside text parts — which would corrupt the ICS body.

No RESEND_API_KEY => dev mode: the .eml is written to outbox_dev/ so the exact
bytes can be inspected (or dragged into a mail client) without sending.
"""

from __future__ import annotations

import base64
import html as html_module
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from email import encoders
from email.header import Header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid, parseaddr
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

RESEND_ENDPOINT = "https://api.resend.com/emails"
DEFAULT_FROM_EMAIL = "invites@dais.events"
DEFAULT_FROM_NAME = "dais"
DEFAULT_OUTBOX_DIR = "outbox_dev"
ICS_FILENAME = "invite.ics"


class MailerError(RuntimeError):
    """Delivery failed. Callers record it per-recipient and keep going."""


def _env(name: str, default: str = "") -> str:
    # Read at call time, not import time: tests monkeypatch these.
    return (os.getenv(name) or default).strip()


def from_address() -> str:
    return formataddr(
        (
            _env("MAIL_FROM_NAME", DEFAULT_FROM_NAME),
            _env("MAIL_FROM_EMAIL", DEFAULT_FROM_EMAIL),
        )
    )


def _header(value: str) -> str:
    """ASCII passes through readable; anything else gets RFC 2047 encoded."""
    return value if value.isascii() else Header(value, "utf-8").encode()


def html_to_text(html: str) -> str:
    """Crude but adequate text/plain fallback — no templating engine here."""
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", html or "")
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|tr|h[1-6]|li)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_module.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def build_message(
    to: str,
    subject: str,
    html: str,
    ics_content: str | None = None,
    ics_method: str | None = None,
    sender: str | None = None,
) -> MIMEMultipart:
    """Assemble the multipart message described in the module docstring."""
    root = MIMEMultipart("mixed")
    root["From"] = _header(sender or from_address())
    root["To"] = _header(to)
    root["Subject"] = _header(subject)
    root["Date"] = formatdate(localtime=True)
    root["Message-ID"] = make_msgid(domain=parseaddr(from_address())[1].split("@")[-1] or None)

    alternative = MIMEMultipart("alternative")
    alternative.attach(MIMEText(html_to_text(html), "plain", "utf-8"))
    alternative.attach(MIMEText(html, "html", "utf-8"))

    if ics_content:
        method = (ics_method or "REQUEST").upper()
        calendar = MIMEText(ics_content, "calendar", "utf-8")
        # requote=False keeps these unquoted (`method=REQUEST`), the form every
        # client documents and the one least likely to be mis-sniffed.
        calendar.set_param("method", method, requote=False)
        calendar.set_param("component", "VEVENT", requote=False)
        alternative.attach(calendar)

    root.attach(alternative)

    if ics_content:
        attachment = MIMEBase("application", "ics", name=ICS_FILENAME)
        attachment.set_payload(ics_content.encode("utf-8"))
        encoders.encode_base64(attachment)
        attachment.add_header("Content-Disposition", "attachment", filename=ICS_FILENAME)
        root.attach(attachment)

    return root


def _outbox_dir() -> Path:
    path = Path(_env("OUTBOX_DIR", DEFAULT_OUTBOX_DIR))
    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def _slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")[:60] or "message"


def write_dev_eml(message: MIMEMultipart, to: str) -> Path:
    # Microseconds, not seconds: a burst of invites must still sort in send
    # order when you list the outbox (or read it back in a test).
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    name = f"{stamp}-{_slug(to)}-{uuid.uuid4().hex[:8]}.eml"
    path = _outbox_dir() / name
    path.write_text(message.as_string(), encoding="utf-8")
    return path


async def _send_via_resend(
    api_key: str,
    to: str,
    subject: str,
    html: str,
    ics_content: str | None,
    ics_method: str | None,
) -> dict:
    payload: dict = {
        "from": from_address(),
        "to": [to],
        "subject": subject,
        "html": html,
        "text": html_to_text(html),
    }
    if ics_content:
        method = (ics_method or "REQUEST").upper()
        payload["attachments"] = [
            {
                "filename": ICS_FILENAME,
                "content": base64.b64encode(ics_content.encode("utf-8")).decode("ascii"),
                # Resend builds the MIME tree; content_type is the only lever we
                # have on it, so the method parameter rides along here.
                "content_type": f"text/calendar; charset=utf-8; method={method}",
            }
        ]

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0)) as client:
            response = await client.post(
                RESEND_ENDPOINT,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except httpx.HTTPError as exc:
        raise MailerError(f"Resend request failed: {exc}") from exc

    if response.status_code >= 400:
        raise MailerError(f"Resend rejected the message ({response.status_code}): {response.text}")

    body = response.json() if response.content else {}
    return {"dev": False, "provider": "resend", "id": body.get("id"), "to": to}


async def send_email(
    to: str,
    subject: str,
    html: str,
    ics_content: str | None = None,
    ics_method: str | None = None,
) -> dict:
    """Send one message. Returns a delivery receipt; raises MailerError on failure.

    Without RESEND_API_KEY nothing leaves the box: the message is written to
    outbox_dev/ and reported as {"dev": True, ...}.
    """
    api_key = _env("RESEND_API_KEY")
    if not api_key:
        message = build_message(to, subject, html, ics_content, ics_method)
        path = write_dev_eml(message, to)
        logger.info("mailer[dev]: wrote %s to=%s subject=%r", path, to, subject)
        return {"dev": True, "provider": "outbox", "path": str(path), "to": to}

    receipt = await _send_via_resend(api_key, to, subject, html, ics_content, ics_method)
    logger.info("mailer: sent id=%s to=%s subject=%r", receipt.get("id"), to, subject)
    return receipt
