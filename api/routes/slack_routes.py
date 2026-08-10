"""Slack Events API boundary: verified, fast-acknowledged, and loop-safe."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

from auth import get_current_user_and_org
from services import slack_agent

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


@router.post("/api/slack/events")
async def slack_events(request: Request, background_tasks: BackgroundTasks) -> dict[str, Any]:
    body = await request.body()
    if not verify_slack_signature(
        body,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
    ):
        raise HTTPException(status_code=401, detail="Invalid Slack request signature")
    try:
        payload = json.loads(body)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack event payload") from exc

    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge")}

    event = payload.get("event") or {}
    if isinstance(event, dict) and _is_actionable_event(event):
        # Temporary binding until each Slack workspace has its own integration
        # row. Never trust an org id from the Slack payload itself.
        org_id = (os.getenv("SLACK_DEFAULT_ORG") or "org_dev").strip() or "org_dev"
        background_tasks.add_task(slack_agent.handle_event, event, org_id)
    return {"ok": True}


@router.get("/api/integrations/slack/status")
async def slack_status(
    auth: tuple = Depends(get_current_user_and_org),
) -> dict[str, Any]:
    # Auth is required because the default org binding is operational config,
    # even though no secret values are ever returned.
    _user_id, _org_id = auth
    return slack_agent.configured_status()
