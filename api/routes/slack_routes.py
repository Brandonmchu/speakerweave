"""Slack Events API boundary: verified, fast-acknowledged, and loop-safe."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any
from urllib.parse import parse_qs

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse

from agent import permissions
from auth import get_current_user_and_org
from services import slack_bridge

router = APIRouter(tags=["slack"])
REPLAY_WINDOW_SECONDS = 5 * 60


def verify_slack_signature(
    body: bytes,
    timestamp: str | None,
    signature: str | None,
    *,
    secret: str | None = None,
    now: float | None = None,
) -> bool:
    signing_secret = (secret if secret is not None else os.getenv("SLACK_SIGNING_SECRET") or "").strip()
    if not signing_secret or not timestamp or not signature:
        return False
    try:
        sent_at = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs((time.time() if now is None else now) - sent_at) > REPLAY_WINDOW_SECONDS:
        return False
    base = b"v0:" + timestamp.encode("ascii") + b":" + body
    expected = "v0=" + hmac.new(signing_secret.encode("utf-8"), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def _is_actionable_event(event: dict[str, Any]) -> bool:
    if event.get("bot_id") or event.get("subtype") == "bot_message":
        return False
    event_type = event.get("type")
    return event_type == "app_mention" or (
        event_type == "message" and event.get("channel_type") == "im"
    )


async def _resolve_interactivity(payload: dict[str, Any], org_id: str) -> None:
    action = (payload.get("actions") or [{}])[0]
    action_id = str(action.get("action_id") or "")
    request_id = str(action.get("value") or "")
    approved = action_id == "permission_approve"
    resolved = await permissions.resolve_permission(request_id, org_id, approved)
    user = payload.get("user") or {}
    name = str(
        user.get("username") or user.get("name") or user.get("id") or "someone"
    )
    if not resolved:
        text = "This approval was already handled or expired."
    elif approved:
        text = f"✅ Approved by {name}"
    else:
        text = f"🚫 Denied by {name}"
    await slack_bridge.replace_permission_card(str(payload.get("response_url") or ""), text)


def _parse_interactivity(body: bytes) -> dict[str, Any] | None:
    try:
        form = parse_qs(body.decode("utf-8"))
        payload_raw = (form.get("payload") or [""])[0]
        payload = json.loads(payload_raw)
    except (UnicodeDecodeError, TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("type") != "block_actions":
        return None
    actions = payload.get("actions") or []
    if not actions or not isinstance(actions[0], dict):
        return None
    action_id = actions[0].get("action_id")
    if action_id not in {"permission_approve", "permission_deny"}:
        return None
    if not str(actions[0].get("value") or ""):
        return None
    return payload


@router.post("/api/slack/events")
async def slack_events(
    request: Request, background_tasks: BackgroundTasks
) -> Any:
    body = await request.body()
    if not verify_slack_signature(
        body,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
    ):
        raise HTTPException(status_code=401, detail="Invalid Slack request signature")

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().casefold()
    if content_type == "application/x-www-form-urlencoded":
        payload = _parse_interactivity(body)
        if payload is not None:
            background_tasks.add_task(
                _resolve_interactivity, payload, slack_bridge.default_org_id()
            )
        return PlainTextResponse("")
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="Unsupported Slack content type")

    try:
        payload = json.loads(body)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack event payload") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid Slack event payload")

    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}

    event = payload.get("event") or {}
    if isinstance(event, dict) and _is_actionable_event(event):
        # Temporary binding until each Slack workspace has its own integration
        # row. Never trust an org id from the Slack payload itself.
        org_id = slack_bridge.default_org_id()
        background_tasks.add_task(
            slack_bridge.handle_event, event, org_id, str(payload.get("event_id") or "")
        )
    return {"ok": True}


@router.get("/api/integrations/slack/status")
async def slack_status(
    auth: tuple = Depends(get_current_user_and_org),
) -> dict[str, Any]:
    # Auth is required because the default org binding is operational config,
    # even though no secret values are ever returned.
    _user_id, _org_id = auth
    return slack_bridge.configured_status()
