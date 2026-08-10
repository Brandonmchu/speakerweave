"""Public org-token API for conference integrations.

Authentication follows the existing Sessionboard-compatible contract:
``x-access-token: dais_…`` resolves to one organization, and every operation is
delegated to :mod:`services.integration_api`, the same org-scoped layer used by
the hosted MCP server.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field

from deps.api_key_deps import get_api_org
from services import integration_api

router = APIRouter(prefix="/v1", tags=["v1-public"])


class SearchRequest(BaseModel):
    status: str | None = None
    track: str | None = None
    page: int = 1
    pageSize: int = integration_api.DEFAULT_PAGE_SIZE


class SubmissionCreateRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    abstract: str = Field(default="", max_length=50_000)
    submitter_email: str = Field(..., min_length=3, max_length=320)
    submitter_first_name: str = Field(default="", max_length=200)
    submitter_last_name: str = Field(default="", max_length=200)
    track_id: str | None = Field(default=None, max_length=64)
    format_id: str | None = Field(default=None, max_length=64)


class SubmissionPatchRequest(BaseModel):
    status: str | None = None
    title: str | None = Field(default=None, max_length=300)
    abstract: str | None = Field(default=None, max_length=50_000)


class SpeakerCreateRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)
    first_name: str = Field(default="", max_length=200)
    last_name: str = Field(default="", max_length=200)
    company_name: str | None = Field(default=None, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    about: str | None = Field(default=None, max_length=50_000)
    speaker_status: str | None = Field(default=None, max_length=32)
    logistics_notes: str | None = Field(default=None, max_length=50_000)


class SpeakerPatchRequest(BaseModel):
    first_name: str | None = Field(default=None, max_length=200)
    last_name: str | None = Field(default=None, max_length=200)
    email: str | None = Field(default=None, max_length=320)
    company_name: str | None = Field(default=None, max_length=300)
    title: str | None = Field(default=None, max_length=300)
    about: str | None = Field(default=None, max_length=50_000)
    photo_url: str | None = Field(default=None, max_length=2_000)
    pronouns: str | None = Field(default=None, max_length=100)
    linkedin_url: str | None = Field(default=None, max_length=2_000)
    twitter_url: str | None = Field(default=None, max_length=2_000)
    phone: str | None = Field(default=None, max_length=100)
    speaker_status: str | None = Field(default=None, max_length=32)
    logistics_notes: str | None = Field(default=None, max_length=50_000)


class SchedulePlacementRequest(BaseModel):
    room: str = Field(..., min_length=1, max_length=300)
    start: str = Field(..., min_length=1, max_length=100)


def _paging(page: int, page_size: int) -> tuple[int, int]:
    return integration_api.validate_paging(page, page_size)


@router.get("/events")
async def list_events(
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    """List events in the token's organization, newest first."""
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_events(org_id, page=page, page_size=page_size)


@router.get("/events/{event_id}")
async def get_event(event_id: str, auth: tuple = Depends(get_api_org)) -> dict:
    """Get one event, returning 404 for an event outside the token's org."""
    org_id, _scopes = auth
    return {"data": await integration_api.get_event(org_id, event_id)}


@router.get("/events/{event_id}/sessions")
@router.get("/events/{event_id}/submissions")
async def list_submissions(
    event_id: str,
    status: str | None = Query(default=None),
    track: str | None = Query(default=None),
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    """List an event's sessions/submissions with status and track filters."""
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_submissions(
        org_id,
        event_id=event_id,
        status=status,
        track=track,
        page=page,
        page_size=page_size,
    )


@router.post("/events/{event_id}/sessions/search")
@router.post("/events/{event_id}/submissions/search")
async def search_submissions(
    event_id: str,
    body: SearchRequest | None = None,
    auth: tuple = Depends(get_api_org),
) -> dict:
    """Search submissions using a Sessionboard-compatible JSON body."""
    org_id, _scopes = auth
    query = body or SearchRequest()
    page, page_size = _paging(query.page, query.pageSize)
    return await integration_api.list_submissions(
        org_id,
        event_id=event_id,
        status=query.status,
        track=query.track,
        page=page,
        page_size=page_size,
    )


@router.get("/submissions/{submission_id}")
async def get_submission(
    submission_id: str, auth: tuple = Depends(get_api_org)
) -> dict:
    org_id, _scopes = auth
    return {"data": await integration_api.get_submission(org_id, submission_id)}


@router.post(
    "/events/{event_id}/submissions", status_code=status.HTTP_201_CREATED
)
async def create_submission(
    event_id: str,
    body: SubmissionCreateRequest,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    return {
        "data": await integration_api.create_submission(
            org_id, event_id, **body.model_dump()
        )
    }


@router.patch("/submissions/{submission_id}")
async def update_submission(
    submission_id: str,
    body: SubmissionPatchRequest,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    provided = body.model_dump(exclude_unset=True)
    return {
        "data": await integration_api.update_submission(
            org_id,
            submission_id,
            status=body.status,
            title=body.title,
            abstract=body.abstract,
            fields_set=set(provided),
        )
    }


@router.get("/events/{event_id}/contacts")
async def list_contacts(
    event_id: str,
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    """Legacy Sessionboard alias for the event speaker collection."""
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    result = await integration_api.list_speakers(
        org_id, event_id=event_id, page=page, page_size=page_size
    )
    result["data"] = [
        {
            "id": row["id"],
            "full_name": row["full_name"],
            "email": row["email"],
            "company_name": row["company_name"],
            "title": row["title"],
            "about": row["about"],
        }
        for row in result["data"]
    ]
    return result


@router.post("/events/{event_id}/contacts/search")
async def search_contacts(
    event_id: str,
    body: SearchRequest | None = None,
    auth: tuple = Depends(get_api_org),
) -> dict:
    query = body or SearchRequest()
    return await list_contacts(
        event_id,
        page=query.page,
        pageSize=query.pageSize,
        auth=auth,
    )


@router.get("/events/{event_id}/speakers")
async def list_speakers(
    event_id: str,
    status: str | None = Query(default=None),
    filter: str | None = Query(default=None),
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_speakers(
        org_id,
        event_id=event_id,
        status=status,
        filter_text=filter,
        page=page,
        page_size=page_size,
    )


@router.get("/speakers/{speaker_id}")
async def get_speaker(speaker_id: str, auth: tuple = Depends(get_api_org)) -> dict:
    org_id, _scopes = auth
    return {"data": await integration_api.get_speaker(org_id, speaker_id)}


@router.post("/events/{event_id}/speakers", status_code=status.HTTP_201_CREATED)
async def create_speaker(
    event_id: str,
    body: SpeakerCreateRequest,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    return {
        "data": await integration_api.create_speaker(
            org_id, event_id, **body.model_dump()
        )
    }


@router.patch("/speakers/{speaker_id}")
async def update_speaker(
    speaker_id: str,
    body: SpeakerPatchRequest,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    return {
        "data": await integration_api.update_speaker(
            org_id, speaker_id, body.model_dump(exclude_unset=True)
        )
    }


@router.get("/events/{event_id}/schedule")
async def get_schedule(event_id: str, auth: tuple = Depends(get_api_org)) -> dict:
    org_id, _scopes = auth
    return {"data": await integration_api.list_schedule(org_id, event_id)}


@router.put("/sessions/{submission_id}/schedule")
async def place_session(
    submission_id: str,
    body: SchedulePlacementRequest,
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    return {
        "data": await integration_api.place_session(
            org_id, submission_id, body.room, body.start
        )
    }


@router.delete("/sessions/{submission_id}/schedule")
async def unschedule_session(
    submission_id: str, auth: tuple = Depends(get_api_org)
) -> dict:
    org_id, _scopes = auth
    return {"data": await integration_api.unschedule_session(org_id, submission_id)}


@router.get("/events/{event_id}/tracks")
async def list_tracks(
    event_id: str,
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_taxonomy(
        org_id, event_id, "tracks", page=page, page_size=page_size
    )


@router.get("/events/{event_id}/formats")
async def list_formats(
    event_id: str,
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_taxonomy(
        org_id, event_id, "formats", page=page, page_size=page_size
    )


@router.get("/events/{event_id}/rooms")
async def list_rooms(
    event_id: str,
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_taxonomy(
        org_id, event_id, "rooms", page=page, page_size=page_size
    )


@router.get("/events/{event_id}/content-items")
async def list_content_items(
    event_id: str,
    status: str | None = Query(default=None),
    type: str | None = Query(default=None),
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_content_items(
        org_id,
        event_id,
        status=status,
        item_type=type,
        page=page,
        page_size=page_size,
    )


@router.get("/events/{event_id}/content-status")
async def get_content_status(
    event_id: str, auth: tuple = Depends(get_api_org)
) -> dict:
    org_id, _scopes = auth
    return {"data": await integration_api.content_status(org_id, event_id)}


@router.get("/events/{event_id}/evaluation-plans")
async def list_evaluation_plans(
    event_id: str,
    page: int = Query(default=1),
    pageSize: int = Query(default=integration_api.DEFAULT_PAGE_SIZE),
    auth: tuple = Depends(get_api_org),
) -> dict:
    org_id, _scopes = auth
    page, page_size = _paging(page, pageSize)
    return await integration_api.list_evaluation_plans(
        org_id, event_id, page=page, page_size=page_size
    )


@router.get("/evaluation-plans/{plan_id}/summary")
async def get_evaluation_summary(
    plan_id: str, auth: tuple = Depends(get_api_org)
) -> dict:
    org_id, _scopes = auth
    return {"data": await integration_api.evaluation_summary(org_id, plan_id)}
