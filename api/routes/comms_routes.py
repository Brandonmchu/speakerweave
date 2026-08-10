"""Authenticated, organization-scoped organizer communications endpoints."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, model_validator

from auth import get_current_user_and_org
from services.comms import (
    communication_log,
    delete_template,
    list_templates,
    patch_template,
    resolve_recipients,
    send_communication,
    upsert_template,
)

router = APIRouter(prefix="/api", tags=["comms"])

Role = Literal["speaker", "submitter", "chairperson", "moderator"]
SessionStatus = Literal[
    "draft",
    "pending",
    "accept_queue",
    "accepted",
    "decline_queue",
    "declined",
    "withdrawn",
]


class TemplateCreateRequest(BaseModel):
    key: str = Field(..., min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    subject: str = Field(..., min_length=1, max_length=300)
    body_html: str = Field(..., min_length=1)


class TemplatePatchRequest(BaseModel):
    key: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    subject: str | None = Field(default=None, min_length=1, max_length=300)
    body_html: str | None = Field(default=None, min_length=1)


class AudienceRequest(BaseModel):
    roles: list[Role] | None = None
    statuses: list[SessionStatus] | None = None
    all_roster: bool = False
    contact_ids: list[str] | None = Field(default=None, max_length=10_000)


class SendRequest(BaseModel):
    template_key: str | None = Field(default=None, min_length=1, max_length=80)
    subject: str | None = Field(default=None, min_length=1, max_length=300)
    body_html: str | None = Field(default=None, min_length=1)
    audience: AudienceRequest = Field(default_factory=AudienceRequest)

    @model_validator(mode="after")
    def validate_message_source(self):
        custom_fields = self.subject is not None or self.body_html is not None
        if self.template_key and custom_fields:
            raise ValueError("Choose a template or provide a custom subject and body, not both")
        if not self.template_key and (self.subject is None or self.body_html is None):
            raise ValueError("Provide template_key or both subject and body_html")
        return self


@router.get("/events/{event_id}/email-templates")
async def get_email_templates(
    event_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return {"templates": await list_templates(event_id, org_id)}


@router.post("/events/{event_id}/email-templates")
async def save_email_template(
    event_id: str,
    payload: TemplateCreateRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    template = await upsert_template(
        event_id,
        org_id,
        key=payload.key.strip(),
        subject=payload.subject.strip(),
        body_html=payload.body_html,
    )
    return {"template": template}


@router.patch("/email-templates/{template_id}")
async def update_email_template(
    template_id: str,
    payload: TemplatePatchRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    provided = payload.model_dump(exclude_unset=True)
    patch: dict[str, str] = {}
    if "key" in provided and payload.key is not None:
        patch["key"] = payload.key.strip()
    if "subject" in provided and payload.subject is not None:
        patch["subject"] = payload.subject.strip()
    if "body_html" in provided and payload.body_html is not None:
        patch["body_html"] = payload.body_html
    if not patch:
        raise HTTPException(status_code=400, detail="Nothing to update")
    return {"template": await patch_template(template_id, org_id, patch)}


@router.delete("/email-templates/{template_id}", status_code=204)
async def remove_email_template(
    template_id: str,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    await delete_template(template_id, org_id)
    return Response(status_code=204)


def _split_query(values: list[str] | None) -> list[str] | None:
    if not values:
        return None
    result = [part.strip() for value in values for part in value.split(",") if part.strip()]
    return list(dict.fromkeys(result)) or None


def _validate_filters(
    roles: list[str] | None,
    statuses: list[str] | None,
) -> tuple[list[str] | None, list[str] | None]:
    valid_roles = {"speaker", "submitter", "chairperson", "moderator"}
    valid_statuses = {
        "draft",
        "pending",
        "accept_queue",
        "accepted",
        "decline_queue",
        "declined",
        "withdrawn",
    }
    unknown_roles = sorted(set(roles or []) - valid_roles)
    unknown_statuses = sorted(set(statuses or []) - valid_statuses)
    if unknown_roles:
        raise HTTPException(status_code=400, detail=f"Unknown role(s): {', '.join(unknown_roles)}")
    if unknown_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown session status(es): {', '.join(unknown_statuses)}",
        )
    return roles, statuses


@router.get("/events/{event_id}/comms/recipients-preview")
async def recipients_preview(
    event_id: str,
    roles: Annotated[list[str] | None, Query()] = None,
    statuses: Annotated[list[str] | None, Query()] = None,
    all_roster: bool = False,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    parsed_roles, parsed_statuses = _validate_filters(_split_query(roles), _split_query(statuses))
    _event, recipients = await resolve_recipients(
        event_id,
        org_id,
        roles=parsed_roles,
        statuses=parsed_statuses,
        all_roster=all_roster,
    )
    if all_roster:
        available = recipients
    else:
        _event, available = await resolve_recipients(
            event_id,
            org_id,
            all_roster=True,
        )

    def _summary(recipient: dict) -> dict:
        return {
            "contact_id": recipient.get("id"),
            "name": recipient.get("full_name"),
            "email": recipient.get("email"),
        }

    return {
        "count": len(recipients),
        "sample": [recipient["full_name"] for recipient in recipients[:5]],
        "recipients": [_summary(recipient) for recipient in recipients],
        "available_recipients": [_summary(recipient) for recipient in available],
    }


@router.post("/events/{event_id}/comms/send")
async def send_event_communication(
    event_id: str,
    payload: SendRequest,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return await send_communication(
        event_id,
        org_id,
        roles=list(payload.audience.roles) if payload.audience.roles else None,
        statuses=list(payload.audience.statuses) if payload.audience.statuses else None,
        all_roster=payload.audience.all_roster,
        contact_ids=payload.audience.contact_ids,
        template_key=payload.template_key,
        subject=payload.subject,
        body_html=payload.body_html,
    )


@router.get("/events/{event_id}/comms/log")
async def get_communication_log(
    event_id: str,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    auth: tuple = Depends(get_current_user_and_org),
):
    _user_id, org_id = auth
    return {"log": await communication_log(event_id, org_id, limit=limit)}
