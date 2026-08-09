"""Evaluation workflow operations shared by organizer and reviewer routes.

The Supabase service-role client bypasses RLS.  Every query in this module is
therefore scoped by the authenticated org, including join-table lookups.
"""

from __future__ import annotations

import html
import math
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from auth import verify_org_access
from services import magic_links
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

DEFAULT_CRITERIA = [
    {"name": "Relevance", "weight": 40},
    {"name": "Originality", "weight": 30},
    {"name": "Speaker", "weight": 20},
    {"name": "Clarity", "weight": 10},
]
REVIEWABLE_STATUSES = {"pending", "accept_queue"}
ASSIGNMENT_MODES = ("all_to_all", "by_track")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── multi-track helpers (migration 004) ────────────────────────────────────
# A session's tracks live in `session_tracks`; `sessions.track_id` remains the
# PRIMARY track (the first one selected) and is still written by every writer,
# so nothing that reads track_id had to change.


def _track_sort_key(track: dict) -> tuple[int, str]:
    return (
        track["order"] if isinstance(track.get("order"), int) else 0,
        str(track.get("name") or "").casefold(),
    )


def _public_track(track: dict) -> dict:
    return {"id": track["id"], "name": track.get("name"), "color": track.get("color")}


def normalize_track_ids(raw: Any) -> list[str]:
    """A tolerant read of `evaluators.track_ids` (uuid[], possibly absent).

    Empty means "reviews every track" — the state every evaluator created
    before migration 004 is in.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        # A driver that hands back the raw Postgres array literal.
        raw = raw.strip("{}").split(",") if raw.strip("{}") else []
    if not isinstance(raw, (list, tuple, set)):
        return []
    seen: list[str] = []
    for item in raw:
        value = str(item).strip().strip('"')
        if value and value not in seen:
            seen.append(value)
    return seen


async def list_event_tracks(org_id: str, event_id: str) -> list[dict]:
    """The event's tracks as {id, name, color}, in the organizer's own order."""
    found = rows(
        await db(
            lambda: supabase.table("tracks")
            .select("id, name, color, order")
            .eq("event_id", event_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_event_tracks",
        )
    )
    return [_public_track(track) for track in sorted(found, key=_track_sort_key)]


async def tracks_for_sessions(org_id: str, sessions: list[dict]) -> dict[str, list[dict]]:
    """{session_id: [{id, name, color}]} for a batch of session rows.

    Two queries for any number of sessions — the membership rows, then the
    track rows — so callers never fan out per session. The session's own
    `track_id` is unioned in (and sorted first) so a row written before the 004
    backfill, or by a writer that only sets the primary column, still reports
    its track.
    """
    session_ids = [str(session["id"]) for session in sessions if session.get("id")]
    if not session_ids:
        return {}

    memberships = rows(
        await db(
            lambda: supabase.table("session_tracks")
            .select("session_id, track_id")
            .in_("session_id", session_ids)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_session_tracks",
        )
    )
    ids_by_session: dict[str, list[str]] = {session_id: [] for session_id in session_ids}
    for row in memberships:
        session_id, track_id = str(row.get("session_id")), row.get("track_id")
        if session_id in ids_by_session and track_id and track_id not in ids_by_session[session_id]:
            ids_by_session[session_id].append(str(track_id))
    primary_by_session: dict[str, str | None] = {}
    for session in sessions:
        session_id = str(session.get("id"))
        primary = session.get("track_id")
        primary_by_session[session_id] = str(primary) if primary else None
        if primary and session_id in ids_by_session and str(primary) not in ids_by_session[session_id]:
            ids_by_session[session_id].append(str(primary))

    track_ids = sorted({track_id for ids in ids_by_session.values() for track_id in ids})
    tracks: list[dict] = []
    if track_ids:
        tracks = rows(
            await db(
                lambda: supabase.table("tracks")
                .select("id, name, color, order")
                .in_("id", track_ids)
                .eq("org_id", org_id)
                .execute(),
                "evaluation_tracks_by_id",
            )
        )
    by_id = {str(track["id"]): track for track in tracks}

    resolved: dict[str, list[dict]] = {}
    for session_id, ids in ids_by_session.items():
        found = [by_id[track_id] for track_id in ids if track_id in by_id]
        primary = primary_by_session.get(session_id)
        found.sort(key=lambda track: (str(track["id"]) != primary, *_track_sort_key(track)))
        resolved[session_id] = [_public_track(track) for track in found]
    return resolved


def normalize_criteria(criteria: list[dict] | None) -> list[dict]:
    """Return validated criteria with stable names and numeric weights."""
    source = DEFAULT_CRITERIA if criteria is None else criteria
    if not source:
        raise HTTPException(status_code=400, detail="At least one criterion is required")

    normalized: list[dict] = []
    seen: set[str] = set()
    for item in source:
        name = str(item.get("name") or "").strip()
        try:
            weight = float(item.get("weight"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail=f"Criterion '{name or 'Unnamed'}' needs a numeric weight"
            ) from exc
        if not name:
            raise HTTPException(status_code=400, detail="Criterion names cannot be empty")
        key = name.casefold()
        if key in seen:
            raise HTTPException(status_code=400, detail=f"Criterion names must be unique: {name}")
        if not math.isfinite(weight) or weight <= 0:
            raise HTTPException(status_code=400, detail=f"Criterion '{name}' needs a positive weight")
        seen.add(key)
        normalized.append(
            {"name": name, "weight": int(weight) if weight.is_integer() else weight}
        )

    total = sum(float(item["weight"]) for item in normalized)
    if abs(total - 100) > 0.001:
        raise HTTPException(status_code=400, detail="Criterion weights must add up to 100")
    return normalized


def weighted_overall(scores: dict[str, Any], criteria: list[dict]) -> float | None:
    """Calculate a weighted mean on the plan's native score scale.

    Missing or non-numeric values make the result incomplete rather than
    silently treating an unanswered criterion as zero.
    """
    if not criteria:
        return None
    weighted_sum = 0.0
    weight_sum = 0.0
    for criterion in criteria:
        name = str(criterion.get("name") or "")
        value = scores.get(name)
        if isinstance(value, bool):
            return None
        try:
            score = float(value)
            weight = float(criterion.get("weight"))
        except (TypeError, ValueError):
            return None
        if not math.isfinite(score) or not math.isfinite(weight):
            return None
        weighted_sum += score * weight
        weight_sum += weight
    if weight_sum <= 0:
        return None
    return round(weighted_sum / weight_sum, 2)


async def _fetch_event(event_id: str, org_id: str) -> dict:
    event = first(
        await db(
            lambda: supabase.table("events")
            .select("*")
            .eq("id", event_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_event_lookup",
        )
    )
    return verify_org_access(event, org_id, "Event")


async def fetch_plan(plan_id: str, org_id: str) -> dict:
    plan = first(
        await db(
            lambda: supabase.table("evaluation_plans")
            .select("*")
            .eq("id", plan_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_plan_lookup",
        )
    )
    return verify_org_access(plan, org_id, "Evaluation plan")


async def create_plan(org_id: str, event_id: str, values: dict) -> dict:
    await _fetch_event(event_id, org_id)
    record = {
        "org_id": org_id,
        "event_id": event_id,
        "name": str(values["name"]).strip(),
        "instructions": str(values.get("instructions") or "").strip(),
        "anonymized": bool(values.get("anonymized", False)),
        "scale": values.get("scale") or "1_5",
        "criteria": normalize_criteria(values.get("criteria")),
        "status": "draft",
        "session_filter": {},
    }
    plan = first(
        await db(
            lambda: supabase.table("evaluation_plans").insert(record).execute(),
            "evaluation_plan_create",
        )
    )
    if not plan:
        raise HTTPException(status_code=500, detail="Could not create evaluation plan")
    return plan


async def list_plans(org_id: str, event_id: str) -> list[dict]:
    await _fetch_event(event_id, org_id)
    plans = rows(
        await db(
            lambda: supabase.table("evaluation_plans")
            .select("*")
            .eq("event_id", event_id)
            .eq("org_id", org_id)
            .order("created_at", desc=True)
            .execute(),
            "evaluation_plan_list",
        )
    )
    if not plans:
        return []

    plan_ids = [plan["id"] for plan in plans]
    evaluators = rows(
        await db(
            lambda: supabase.table("evaluators")
            .select("id, plan_id")
            .in_("plan_id", plan_ids)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_plan_list_evaluators",
        )
    )
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("id, plan_id")
            .in_("plan_id", plan_ids)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_plan_list_assignments",
        )
    )
    assignment_ids = [assignment["id"] for assignment in assignments]
    reviews: list[dict] = []
    if assignment_ids:
        reviews = rows(
            await db(
                lambda: supabase.table("reviews")
                .select("id, assignment_id, is_draft")
                .in_("assignment_id", assignment_ids)
                .eq("org_id", org_id)
                .execute(),
                "evaluation_plan_list_reviews",
            )
        )

    evaluator_counts: dict[str, int] = {}
    assignment_counts: dict[str, int] = {}
    plan_by_assignment = {row["id"]: row["plan_id"] for row in assignments}
    review_counts: dict[str, int] = {}
    for evaluator in evaluators:
        evaluator_counts[evaluator["plan_id"]] = evaluator_counts.get(evaluator["plan_id"], 0) + 1
    for assignment in assignments:
        assignment_counts[assignment["plan_id"]] = assignment_counts.get(assignment["plan_id"], 0) + 1
    for review in reviews:
        plan_id = plan_by_assignment.get(review.get("assignment_id"))
        if plan_id:
            review_counts[plan_id] = review_counts.get(plan_id, 0) + 1

    return [
        {
            **plan,
            "evaluator_count": evaluator_counts.get(plan["id"], 0),
            "assignment_count": assignment_counts.get(plan["id"], 0),
            "review_count": review_counts.get(plan["id"], 0),
        }
        for plan in plans
    ]


async def get_plan_detail(org_id: str, plan_id: str) -> dict:
    plan = await fetch_plan(plan_id, org_id)
    evaluators = rows(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .order("name")
            .execute(),
            "evaluation_detail_evaluators",
        )
    )
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_detail_assignments",
        )
    )
    assignment_ids = [assignment["id"] for assignment in assignments]
    reviews: list[dict] = []
    if assignment_ids:
        reviews = rows(
            await db(
                lambda: supabase.table("reviews")
                .select("assignment_id, is_draft, abstained")
                .in_("assignment_id", assignment_ids)
                .eq("org_id", org_id)
                .execute(),
                "evaluation_detail_reviews",
            )
        )
    review_by_assignment = {row["assignment_id"]: row for row in reviews}

    # The event's tracks, plus the tracks each assigned session actually
    # carries — both batched, so the detail response stays two extra queries
    # regardless of how many sessions the plan covers.
    event_tracks = await list_event_tracks(org_id, plan["event_id"])
    track_by_id = {track["id"]: track for track in event_tracks}
    assigned_session_ids = sorted({row["session_id"] for row in assignments})
    assigned_sessions: list[dict] = []
    if assigned_session_ids:
        assigned_sessions = rows(
            await db(
                lambda: supabase.table("sessions")
                .select("id, title, friendly_id, status, track_id")
                .in_("id", assigned_session_ids)
                .eq("event_id", plan["event_id"])
                .eq("org_id", org_id)
                .execute(),
                "evaluation_detail_sessions",
            )
        )
    session_tracks = await tracks_for_sessions(org_id, assigned_sessions)
    session_by_id = {row["id"]: row for row in assigned_sessions}

    evaluator_summary: list[dict] = []
    for evaluator in evaluators:
        mine = [row for row in assignments if row["evaluator_id"] == evaluator["id"]]
        mine_reviews = [review_by_assignment[row["id"]] for row in mine if row["id"] in review_by_assignment]
        covered = normalize_track_ids(evaluator.get("track_ids"))
        evaluator_summary.append(
            {
                **evaluator,
                # empty = reviews every track
                "track_ids": covered,
                "tracks": [track_by_id[track_id] for track_id in covered if track_id in track_by_id],
                "assignment_count": len(mine),
                "review_count": len(mine_reviews),
                "complete_count": sum(not bool(row.get("is_draft")) for row in mine_reviews),
            }
        )

    by_session: dict[str, dict] = {}
    for assignment in assignments:
        session_id = assignment["session_id"]
        session = session_by_id.get(session_id) or {}
        entry = by_session.setdefault(
            session_id,
            {
                "session_id": session_id,
                "title": session.get("title"),
                "friendly_id": session.get("friendly_id"),
                "status": session.get("status"),
                # primary track stays available under its original name
                "track_id": session.get("track_id"),
                "tracks": session_tracks.get(session_id, []),
                "assignment_count": 0,
                "review_count": 0,
            },
        )
        entry["assignment_count"] += 1
        if assignment["id"] in review_by_assignment:
            entry["review_count"] += 1

    return {
        "plan": plan,
        "tracks": event_tracks,
        "evaluators": evaluator_summary,
        "assignments": {
            "total": len(assignments),
            "reviewed": len(reviews),
            "complete": sum(not bool(row.get("is_draft")) for row in reviews),
            "by_session": list(by_session.values()),
        },
    }


async def update_plan(org_id: str, plan_id: str, patch: dict) -> dict:
    await fetch_plan(plan_id, org_id)
    if "name" in patch:
        patch["name"] = str(patch["name"]).strip()
    if "instructions" in patch:
        patch["instructions"] = str(patch["instructions"] or "").strip()
    if "criteria" in patch:
        patch["criteria"] = normalize_criteria(patch["criteria"])
    updated = first(
        await db(
            lambda: supabase.table("evaluation_plans")
            .update(patch)
            .eq("id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_plan_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Evaluation plan not found")
    return updated


async def _validate_track_ids(org_id: str, event_id: str, track_ids: Any) -> list[str]:
    """Track ids an evaluator may cover: this event's tracks, in its own order.

    Empty means "every track", which is what an evaluator with no selection
    has always meant. An id from another event (or another org) is a 400 rather
    than a silently dropped filter — a reviewer scoped to nothing would look
    scoped to everything.
    """
    wanted = normalize_track_ids(track_ids)
    if not wanted:
        return []
    available = await list_event_tracks(org_id, event_id)
    known = {track["id"] for track in available}
    unknown = [track_id for track_id in wanted if track_id not in known]
    if unknown:
        raise HTTPException(status_code=400, detail="One or more tracks were not found")
    return [track["id"] for track in available if track["id"] in set(wanted)]


async def add_evaluator(
    org_id: str,
    plan_id: str,
    email_address: str,
    name: str,
    track_ids: Any = None,
) -> dict:
    plan = await fetch_plan(plan_id, org_id)
    normalized_email = email_address.strip().lower()
    covered = (
        None if track_ids is None else await _validate_track_ids(org_id, plan["event_id"], track_ids)
    )
    existing = first(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("email", normalized_email)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_evaluator_existing",
        )
    )
    if existing:
        # Re-adding an existing reviewer stays a no-op unless the caller sent a
        # track selection, in which case it is an edit.
        if covered is None:
            return existing
        return await update_evaluator(org_id, plan_id, existing["id"], {"track_ids": covered})
    evaluator = first(
        await db(
            lambda: supabase.table("evaluators")
            .insert(
                {
                    "org_id": org_id,
                    "plan_id": plan_id,
                    "email": normalized_email,
                    "name": name.strip(),
                    "track_ids": covered or [],
                }
            )
            .execute(),
            "evaluation_evaluator_create",
        )
    )
    if not evaluator:
        raise HTTPException(status_code=500, detail="Could not add evaluator")
    return evaluator


async def update_evaluator(org_id: str, plan_id: str, evaluator_id: str, patch: dict) -> dict:
    """Rename a reviewer or change the tracks they cover."""
    plan = await fetch_plan(plan_id, org_id)
    existing = first(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("id", evaluator_id)
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_evaluator_patch_lookup",
        )
    )
    verify_org_access(existing, org_id, "Evaluator")

    values: dict[str, Any] = {}
    if "name" in patch:
        values["name"] = str(patch["name"] or "").strip()
    if "track_ids" in patch:
        values["track_ids"] = await _validate_track_ids(
            org_id, plan["event_id"], patch["track_ids"]
        )
    if not values:
        raise HTTPException(status_code=400, detail="Nothing to update")

    updated = first(
        await db(
            lambda: supabase.table("evaluators")
            .update(values)
            .eq("id", evaluator_id)
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_evaluator_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Evaluator not found")
    return updated


async def delete_evaluator(org_id: str, plan_id: str, evaluator_id: str) -> None:
    await fetch_plan(plan_id, org_id)
    evaluator = first(
        await db(
            lambda: supabase.table("evaluators")
            .select("id, org_id")
            .eq("id", evaluator_id)
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_evaluator_lookup",
        )
    )
    verify_org_access(evaluator, org_id, "Evaluator")
    await db(
        lambda: supabase.table("evaluators")
        .delete()
        .eq("id", evaluator_id)
        .eq("plan_id", plan_id)
        .eq("org_id", org_id)
        .execute(),
        "evaluation_evaluator_delete",
    )


def _matches_session_filter(session: dict, session_filter: dict) -> bool:
    if not session_filter:
        return session.get("status") in REVIEWABLE_STATUSES
    statuses = session_filter.get("statuses")
    if statuses is None and session_filter.get("status") is not None:
        statuses = [session_filter["status"]]
    if statuses is not None and session.get("status") not in statuses:
        return False
    session_ids = session_filter.get("session_ids")
    if session_ids is not None and session.get("id") not in session_ids:
        return False
    for key in ("track_id", "format_id", "level_id", "is_abstract"):
        expected = session_filter.get(key)
        if expected is None:
            continue
        if isinstance(expected, list):
            if session.get(key) not in expected:
                return False
        elif session.get(key) != expected:
            return False
    return True


async def assign_all_to_all(
    org_id: str,
    plan_id: str,
    *,
    session_ids: list[str] | None,
    evaluator_ids: list[str] | None,
) -> dict:
    """Every candidate reviewer × every candidate session (the original mode)."""
    return await assign_sessions(
        org_id, plan_id, mode="all_to_all", session_ids=session_ids, evaluator_ids=evaluator_ids
    )


async def assign_sessions(
    org_id: str,
    plan_id: str,
    *,
    mode: str = "all_to_all",
    session_ids: list[str] | None = None,
    evaluator_ids: list[str] | None = None,
) -> dict:
    """Create the missing (evaluator, session) assignments for a plan.

    `all_to_all` pairs everyone with everything. `by_track` pairs a reviewer
    only with sessions whose track set intersects the tracks they cover, where
    a reviewer with no tracks selected covers all of them. Both dedupe against
    what already exists, so re-running is a no-op.
    """
    if mode not in ASSIGNMENT_MODES:
        raise HTTPException(status_code=400, detail=f"Unknown assignment mode: {mode}")
    plan = await fetch_plan(plan_id, org_id)
    evaluator_query = (
        supabase.table("evaluators")
        .select("*")
        .eq("plan_id", plan_id)
        .eq("org_id", org_id)
    )
    if evaluator_ids is not None:
        evaluator_query = evaluator_query.in_("id", evaluator_ids)
    evaluators = rows(await db(lambda: evaluator_query.execute(), "evaluation_assign_evaluators"))
    if evaluator_ids is not None and {row["id"] for row in evaluators} != set(evaluator_ids):
        raise HTTPException(status_code=404, detail="One or more evaluators were not found")

    session_query = (
        supabase.table("sessions")
        .select("*")
        .eq("event_id", plan["event_id"])
        .eq("org_id", org_id)
    )
    if session_ids is not None:
        session_query = session_query.in_("id", session_ids)
    sessions = rows(await db(lambda: session_query.execute(), "evaluation_assign_sessions"))
    if session_ids is not None:
        if {row["id"] for row in sessions} != set(session_ids):
            raise HTTPException(status_code=404, detail="One or more sessions were not found")
    else:
        sessions = [
            session
            for session in sessions
            if _matches_session_filter(session, plan.get("session_filter") or {})
        ]

    existing = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("plan_id, evaluator_id, session_id")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_assign_existing",
        )
    )
    existing_keys = {(row["evaluator_id"], row["session_id"]) for row in existing}

    track_ids_by_session: dict[str, set[str]] = {}
    if mode == "by_track":
        track_ids_by_session = {
            session_id: {track["id"] for track in tracks}
            for session_id, tracks in (await tracks_for_sessions(org_id, sessions)).items()
        }

    def _pairs(evaluator: dict, session: dict) -> bool:
        if (evaluator["id"], session["id"]) in existing_keys:
            return False
        if mode != "by_track":
            return True
        covered = set(normalize_track_ids(evaluator.get("track_ids")))
        if not covered:
            # No selection = reviews every track.
            return True
        return bool(covered & track_ids_by_session.get(session["id"], set()))

    desired = [
        {
            "org_id": org_id,
            "plan_id": plan_id,
            "evaluator_id": evaluator["id"],
            "session_id": session["id"],
        }
        for evaluator in evaluators
        for session in sessions
        if _pairs(evaluator, session)
    ]
    created: list[dict] = []
    if desired:
        created = rows(
            await db(
                lambda: supabase.table("assignments")
                .upsert(desired, on_conflict="plan_id,evaluator_id,session_id")
                .execute(),
                "evaluation_assign_create",
            )
        )
    return {
        "created": len(created),
        "total": len(existing_keys) + len(created),
        "session_count": len(sessions),
        "evaluator_count": len(evaluators),
        "assignments": created,
    }


async def open_plan(org_id: str, plan_id: str) -> dict:
    plan = await fetch_plan(plan_id, org_id)
    event = await _fetch_event(plan["event_id"], org_id)
    evaluators = rows(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .order("name")
            .execute(),
            "evaluation_open_evaluators",
        )
    )
    opened_at = _now()
    updated_plan = first(
        await db(
            lambda: supabase.table("evaluation_plans")
            .update({"status": "open"})
            .eq("id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_open_plan",
        )
    )
    if not updated_plan:
        raise HTTPException(status_code=404, detail="Evaluation plan not found")

    frontend_url = (os.getenv("FRONTEND_URL") or "http://localhost:5173").rstrip("/")
    queued = 0
    for evaluator in evaluators:
        token = await magic_links.mint(
            org_id,
            "review",
            evaluator_id=evaluator["id"],
            ttl_hours=168,
        )
        reviewer_link = f"{frontend_url}/review/{token}"
        subject = f"[{event['name']}] You've been invited to review"
        greeting = html.escape(evaluator.get("name") or "Reviewer")
        event_name = html.escape(str(event["name"]))
        plan_name = html.escape(str(plan["name"]))
        body_html = (
            f"<p>Hello {greeting},</p>"
            f"<p>You've been invited to review submissions for {event_name} "
            f"as part of {plan_name}.</p>"
            f'<p><a href="{html.escape(reviewer_link)}">Open your review portal</a></p>'
        )
        await db(
            lambda evaluator=evaluator, reviewer_link=reviewer_link, subject=subject, body_html=body_html: (
                supabase.table("email_outbox")
                .upsert(
                    {
                        "org_id": org_id,
                        "event_id": plan["event_id"],
                        "contact_id": None,
                        "template_key": "evaluation_invite",
                        "payload": {
                            "to": evaluator["email"],
                            "subject": subject,
                            "body_html": body_html,
                            "reviewer_link": reviewer_link,
                            "evaluator_id": evaluator["id"],
                            "plan_id": plan_id,
                        },
                        "dedupe_key": f"evaluation-invite:{plan_id}:{evaluator['id']}",
                        "status": "queued",
                        "attempts": 0,
                        "last_error": None,
                    },
                    on_conflict="event_id,dedupe_key",
                )
                .execute()
            ),
            "evaluation_open_queue_invite",
        )
        await db(
            lambda evaluator=evaluator: supabase.table("evaluators")
            .update({"invited_at": opened_at})
            .eq("id", evaluator["id"])
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_open_mark_invited",
        )
        queued += 1
    return {"plan": updated_plan, "count": queued}


async def reviewer_links(org_id: str, plan_id: str) -> list[dict]:
    """Mint a fresh review magic link for every evaluator on the plan.

    A read-style helper the admin can call on demand to grab shareable reviewer
    links while email delivery is deferred. Minting fresh is intentional — any
    previously issued link stays valid until it expires.
    """
    await fetch_plan(plan_id, org_id)
    evaluators = rows(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .order("name")
            .execute(),
            "evaluation_reviewer_links_evaluators",
        )
    )
    frontend_url = (os.getenv("FRONTEND_URL") or "http://localhost:5173").rstrip("/")
    links: list[dict] = []
    for evaluator in evaluators:
        token = await magic_links.mint(
            org_id,
            "review",
            evaluator_id=evaluator["id"],
            ttl_hours=168,
        )
        links.append(
            {
                "evaluator_id": evaluator["id"],
                "name": evaluator.get("name") or "",
                "email": evaluator.get("email"),
                "review_url": f"{frontend_url}/review/{token}",
            }
        )
    return links


async def get_summary(org_id: str, plan_id: str) -> dict:
    plan = await fetch_plan(plan_id, org_id)
    criteria = normalize_criteria(plan.get("criteria") or [])
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_summary_assignments",
        )
    )
    assignment_ids = [assignment["id"] for assignment in assignments]
    reviews: list[dict] = []
    if assignment_ids:
        reviews = rows(
            await db(
                lambda: supabase.table("reviews")
                .select("*")
                .in_("assignment_id", assignment_ids)
                .eq("org_id", org_id)
                .execute(),
                "evaluation_summary_reviews",
            )
        )
    session_ids = sorted({assignment["session_id"] for assignment in assignments})
    sessions: list[dict] = []
    if session_ids:
        sessions = rows(
            await db(
                lambda: supabase.table("sessions")
                .select("id, title, friendly_id, status, track_id")
                .in_("id", session_ids)
                .eq("event_id", plan["event_id"])
                .eq("org_id", org_id)
                .execute(),
                "evaluation_summary_sessions",
            )
        )

    session_by_id = {row["id"]: row for row in sessions}
    session_tracks = await tracks_for_sessions(org_id, sessions)
    score_lists: dict[str, list[float]] = {session_id: [] for session_id in session_ids}
    completed_counts: dict[str, int] = {session_id: 0 for session_id in session_ids}
    abstained_counts: dict[str, int] = {session_id: 0 for session_id in session_ids}
    assignment_by_id = {row["id"]: row for row in assignments}
    for review in reviews:
        assignment = assignment_by_id.get(review.get("assignment_id"))
        if not assignment or bool(review.get("is_draft")):
            continue
        session_id = assignment["session_id"]
        completed_counts[session_id] += 1
        if bool(review.get("abstained")):
            abstained_counts[session_id] += 1
            continue
        overall = weighted_overall(review.get("scores") or {}, criteria)
        if overall is not None:
            score_lists[session_id].append(overall)

    per_session: list[dict] = []
    for session_id in session_ids:
        scores = score_lists[session_id]
        score_range = round(max(scores) - min(scores), 2) if len(scores) >= 2 else 0.0
        session = session_by_id.get(session_id) or {"id": session_id, "title": "Unknown session"}
        per_session.append(
            {
                "session_id": session_id,
                "title": session.get("title") or "Untitled",
                "friendly_id": session.get("friendly_id"),
                "status": session.get("status"),
                "tracks": session_tracks.get(session_id, []),
                "avg_overall": round(sum(scores) / len(scores), 2) if scores else None,
                "review_count": len(scores),
                "completed_count": completed_counts[session_id],
                "abstained_count": abstained_counts[session_id],
                "score_range": score_range,
            }
        )
    per_session.sort(
        key=lambda item: (
            item["avg_overall"] is None,
            -(item["avg_overall"] or 0),
            str(item["title"]),
        )
    )
    top_sessions = [item for item in per_session if item["avg_overall"] is not None][:5]
    thought_provoking = sorted(
        [item for item in per_session if item["review_count"] >= 2],
        key=lambda item: (-item["score_range"], str(item["title"])),
    )[:5]
    return {
        "started": len(reviews),
        "in_progress": sum(bool(row.get("is_draft")) for row in reviews),
        "complete": sum(not bool(row.get("is_draft")) for row in reviews),
        "assignment_count": len(assignments),
        "per_session": per_session,
        "top_sessions": top_sessions,
        "thought_provoking": thought_provoking,
    }


def _empty_review_aggregate() -> dict:
    return {
        "review_count": 0,
        "completed_count": 0,
        "abstained_count": 0,
        "any_abstained": False,
        "avg_overall": None,
        "scale": "1_5",
        "criteria": [],
        "reviews": [],
    }


async def session_review_aggregate(org_id: str, session_id: str) -> dict:
    """Everything reviewers wrote about ONE session, aggregated for the organizer.

    This closes the review roundtrip: reviewers score a session on a plan's
    weighted scorecard, and this is where those scores and comments finally reach
    the organizer who has to decide. Every query is org-scoped — the service-role
    client bypasses RLS, so a dropped predicate is a cross-org leak.

    Only completed (submitted, non-draft) reviews are surfaced; a draft is a
    reviewer's private scratch pad. Reviewer identity is withheld for any review
    whose plan is `anonymized`, in which case the verdict is labelled
    "Reviewer N" and carries no name or email.

    The caller is expected to have already verified the session belongs to the
    org (this returns an empty aggregate for an unknown/foreign session rather
    than raising).
    """
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("id, plan_id, evaluator_id, session_id")
            .eq("session_id", session_id)
            .eq("org_id", org_id)
            .execute(),
            "session_reviews_assignments",
        )
    )
    if not assignments:
        return _empty_review_aggregate()

    assignment_by_id = {row["id"]: row for row in assignments}
    assignment_ids = list(assignment_by_id)
    plan_ids = sorted({row["plan_id"] for row in assignments if row.get("plan_id")})
    evaluator_ids = sorted({row["evaluator_id"] for row in assignments if row.get("evaluator_id")})

    plans: list[dict] = []
    if plan_ids:
        plans = rows(
            await db(
                lambda: supabase.table("evaluation_plans")
                .select("id, criteria, scale, anonymized")
                .in_("id", plan_ids)
                .eq("org_id", org_id)
                .execute(),
                "session_reviews_plans",
            )
        )
    plan_by_id = {row["id"]: row for row in plans}

    evaluators: list[dict] = []
    if evaluator_ids:
        evaluators = rows(
            await db(
                lambda: supabase.table("evaluators")
                .select("id, name, email")
                .in_("id", evaluator_ids)
                .eq("org_id", org_id)
                .execute(),
                "session_reviews_evaluators",
            )
        )
    evaluator_by_id = {row["id"]: row for row in evaluators}

    reviews = rows(
        await db(
            lambda: supabase.table("reviews")
            .select("*")
            .in_("assignment_id", assignment_ids)
            .eq("org_id", org_id)
            .execute(),
            "session_reviews",
        )
    )
    completed = [review for review in reviews if not bool(review.get("is_draft"))]
    completed.sort(key=lambda review: str(review.get("submitted_at") or review.get("updated_at") or ""))

    # Criteria come from the plan(s) covering the session, unioned by name with
    # the first weight winning, so a per-criterion column reads the same order the
    # reviewer scored in.
    criteria_order: list[dict] = []
    seen_criteria: set[str] = set()
    scale = "1_5"
    for plan_id in plan_ids:
        plan = plan_by_id.get(plan_id) or {}
        if plan.get("scale"):
            scale = str(plan["scale"])
        for criterion in plan.get("criteria") or []:
            name = str(criterion.get("name") or "").strip()
            key = name.casefold()
            if not name or key in seen_criteria:
                continue
            seen_criteria.add(key)
            criteria_order.append({"name": name, "weight": criterion.get("weight")})

    criterion_scores: dict[str, list[float]] = {item["name"]: [] for item in criteria_order}
    overalls: list[float] = []
    abstained_count = 0
    verdicts: list[dict] = []
    for index, review in enumerate(completed, start=1):
        assignment = assignment_by_id.get(review.get("assignment_id")) or {}
        plan = plan_by_id.get(assignment.get("plan_id")) or {}
        anonymized = bool(plan.get("anonymized"))
        abstained = bool(review.get("abstained"))
        if anonymized:
            reviewer = f"Reviewer {index}"
        else:
            evaluator = evaluator_by_id.get(assignment.get("evaluator_id")) or {}
            reviewer = (
                str(evaluator.get("name") or "").strip()
                or evaluator.get("email")
                or f"Reviewer {index}"
            )
        overall = review.get("overall")
        if overall is None and not abstained:
            overall = weighted_overall(review.get("scores") or {}, plan.get("criteria") or [])

        if abstained:
            abstained_count += 1
        else:
            if overall is not None:
                overalls.append(float(overall))
            for name, value in (review.get("scores") or {}).items():
                if name in criterion_scores and isinstance(value, (int, float)) and not isinstance(value, bool):
                    criterion_scores[name].append(float(value))

        verdicts.append(
            {
                "reviewer": reviewer,
                "anonymized": anonymized,
                "overall": round(float(overall), 2) if overall is not None else None,
                "comment": review.get("comment"),
                "scores": {} if abstained else (review.get("scores") or {}),
                "abstained": abstained,
                "abstain_reason": review.get("abstain_reason") if abstained else None,
            }
        )

    criteria_out = [
        {
            "name": item["name"],
            "weight": item["weight"],
            "average": (
                round(sum(criterion_scores[item["name"]]) / len(criterion_scores[item["name"]]), 2)
                if criterion_scores[item["name"]]
                else None
            ),
        }
        for item in criteria_order
    ]

    return {
        "review_count": len(completed),
        "completed_count": len(completed),
        "abstained_count": abstained_count,
        "any_abstained": abstained_count > 0,
        "avg_overall": round(sum(overalls) / len(overalls), 2) if overalls else None,
        "scale": scale,
        "criteria": criteria_out,
        "reviews": verdicts,
    }


async def get_session_reviews(org_id: str, session_id: str) -> dict:
    """The org-scoped review aggregate for a session, 404 if it isn't ours.

    Unlike `session_review_aggregate`, this verifies the session belongs to the
    org first, so a dedicated endpoint can't be used to probe another org's ids.
    """
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, org_id")
            .eq("id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "session_reviews_session_lookup",
        )
    )
    verify_org_access(session, org_id, "Session")
    return await session_review_aggregate(org_id, session_id)


async def session_review_scores(org_id: str, session_ids: list[str]) -> dict[str, dict]:
    """{session_id: {"review_score": avg|None, "review_count": int}} for a batch.

    Powers the inbox's average-score column: three queries for any number of
    submissions (assignments, then reviews), so listing a hundred submissions
    never fans out per row. Only completed, non-abstained reviews contribute a
    score; the count is completed reviews (abstentions included).
    """
    if not session_ids:
        return {}
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("id, session_id")
            .in_("session_id", session_ids)
            .eq("org_id", org_id)
            .execute(),
            "session_scores_assignments",
        )
    )
    if not assignments:
        return {}
    session_by_assignment = {row["id"]: row["session_id"] for row in assignments}
    assignment_ids = list(session_by_assignment)
    reviews = rows(
        await db(
            lambda: supabase.table("reviews")
            .select("assignment_id, overall, is_draft, abstained")
            .in_("assignment_id", assignment_ids)
            .eq("org_id", org_id)
            .execute(),
            "session_scores_reviews",
        )
    )
    score_lists: dict[str, list[float]] = {}
    completed_counts: dict[str, int] = {}
    for review in reviews:
        if bool(review.get("is_draft")):
            continue
        session_id = session_by_assignment.get(review.get("assignment_id"))
        if not session_id:
            continue
        completed_counts[session_id] = completed_counts.get(session_id, 0) + 1
        overall = review.get("overall")
        if not bool(review.get("abstained")) and overall is not None:
            score_lists.setdefault(session_id, []).append(float(overall))
    result: dict[str, dict] = {}
    for session_id in {row["session_id"] for row in assignments}:
        scores = score_lists.get(session_id, [])
        result[session_id] = {
            "review_score": round(sum(scores) / len(scores), 2) if scores else None,
            "review_count": completed_counts.get(session_id, 0),
        }
    return result


async def _speaker_map(session_ids: list[str], org_id: str) -> dict[str, list[dict]]:
    if not session_ids:
        return {}
    participants = rows(
        await db(
            lambda: supabase.table("session_participants")
            .select("session_id, contact_id, role, is_primary")
            .in_("session_id", session_ids)
            .eq("org_id", org_id)
            .execute(),
            "review_speaker_participants",
        )
    )
    participants = [
        row for row in participants if row.get("role") in {"speaker", "submitter"}
    ]
    contact_ids = sorted({row["contact_id"] for row in participants if row.get("contact_id")})
    contacts: list[dict] = []
    if contact_ids:
        contacts = rows(
            await db(
                lambda: supabase.table("contacts")
                .select("id, first_name, last_name, company_name, title, about")
                .in_("id", contact_ids)
                .eq("org_id", org_id)
                .execute(),
                "review_speaker_contacts",
            )
        )
    contacts_by_id = {row["id"]: row for row in contacts}
    result: dict[str, list[dict]] = {session_id: [] for session_id in session_ids}
    participants.sort(key=lambda row: (not bool(row.get("is_primary")), str(row.get("role"))))
    for participant in participants:
        contact = contacts_by_id.get(participant.get("contact_id"))
        if not contact:
            continue
        result.setdefault(participant["session_id"], []).append(
            {**contact, "role": participant.get("role"), "is_primary": participant.get("is_primary")}
        )
    return result


async def reviewer_home(org_id: str, evaluator_id: str) -> dict:
    evaluator = first(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("id", evaluator_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_evaluator_lookup",
        )
    )
    evaluator = verify_org_access(evaluator, org_id, "Evaluator")
    plan = await fetch_plan(evaluator["plan_id"], org_id)
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("*")
            .eq("evaluator_id", evaluator_id)
            .eq("plan_id", plan["id"])
            .eq("org_id", org_id)
            .execute(),
            "review_home_assignments",
        )
    )
    assignment_ids = [row["id"] for row in assignments]
    reviews: list[dict] = []
    if assignment_ids:
        reviews = rows(
            await db(
                lambda: supabase.table("reviews")
                .select("assignment_id, is_draft, abstained")
                .in_("assignment_id", assignment_ids)
                .eq("org_id", org_id)
                .execute(),
                "review_home_reviews",
            )
        )
    review_by_assignment = {row["assignment_id"]: row for row in reviews}
    session_ids = [row["session_id"] for row in assignments]
    sessions: list[dict] = []
    if session_ids:
        sessions = rows(
            await db(
                lambda: supabase.table("sessions")
                .select("id, title, description, friendly_id")
                .in_("id", session_ids)
                .eq("event_id", plan["event_id"])
                .eq("org_id", org_id)
                .execute(),
                "review_home_sessions",
            )
        )
    session_by_id = {row["id"]: row for row in sessions}
    speakers = {} if plan.get("anonymized") else await _speaker_map(session_ids, org_id)

    output_assignments: list[dict] = []
    for assignment in assignments:
        session = dict(session_by_id.get(assignment["session_id"]) or {})
        if not session:
            continue
        if not plan.get("anonymized"):
            session["speakers"] = speakers.get(assignment["session_id"], [])
            session["speaker"] = (session["speakers"] or [None])[0]
        review = review_by_assignment.get(assignment["id"])
        status = "pending"
        if review:
            status = "in_progress" if review.get("is_draft") else "reviewed"
        output_assignments.append(
            {
                "assignment_id": assignment["id"],
                "session": session,
                "review_status": status,
            }
        )

    return {
        "evaluator": evaluator,
        "plan": {
            key: plan.get(key)
            for key in ("id", "name", "instructions", "scale", "criteria", "anonymized", "status")
        },
        "assignments": output_assignments,
    }


async def _review_context(org_id: str, evaluator_id: str, assignment_id: str) -> tuple[dict, dict]:
    assignment = first(
        await db(
            lambda: supabase.table("assignments")
            .select("*")
            .eq("id", assignment_id)
            .eq("evaluator_id", evaluator_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_assignment_lookup",
        )
    )
    assignment = verify_org_access(assignment, org_id, "Assignment")
    plan = await fetch_plan(assignment["plan_id"], org_id)
    evaluator = first(
        await db(
            lambda: supabase.table("evaluators")
            .select("id, plan_id, org_id")
            .eq("id", evaluator_id)
            .eq("plan_id", plan["id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_assignment_evaluator",
        )
    )
    verify_org_access(evaluator, org_id, "Evaluator")
    return assignment, plan


async def reviewer_submission(org_id: str, evaluator_id: str, assignment_id: str) -> dict:
    assignment, plan = await _review_context(org_id, evaluator_id, assignment_id)
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("*")
            .eq("id", assignment["session_id"])
            .eq("event_id", plan["event_id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_submission_lookup",
        )
    )
    session = verify_org_access(session, org_id, "Session")
    if plan.get("anonymized"):
        session.pop("submitter_contact_id", None)
    else:
        speakers = await _speaker_map([session["id"]], org_id)
        session["speakers"] = speakers.get(session["id"], [])
        session["speaker"] = (session["speakers"] or [None])[0]
    review = first(
        await db(
            lambda: supabase.table("reviews")
            .select("*")
            .eq("assignment_id", assignment_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_submission_existing",
        )
    )
    return {"assignment_id": assignment_id, "session": session, "review": review}


def _validate_scores(
    scores: dict[str, Any], criteria: list[dict], scale: str, *, final: bool, abstained: bool
) -> dict[str, float]:
    names = [str(item["name"]) for item in criteria]
    unknown = sorted(set(scores) - set(names))
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown criterion: {unknown[0]}")
    if final and not abstained:
        missing = [name for name in names if name not in scores]
        if missing:
            raise HTTPException(status_code=400, detail=f"Score required for: {missing[0]}")
    maximum = 10 if scale == "1_10" else 5
    normalized: dict[str, float] = {}
    for name, raw_value in scores.items():
        if isinstance(raw_value, bool):
            raise HTTPException(status_code=400, detail=f"Score for '{name}' must be a number")
        try:
            value = float(raw_value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail=f"Score for '{name}' must be a number"
            ) from exc
        if not math.isfinite(value) or value < 1 or value > maximum:
            raise HTTPException(
                status_code=400, detail=f"Score for '{name}' must be between 1 and {maximum}"
            )
        normalized[name] = int(value) if value.is_integer() else value
    return normalized


async def save_review(
    org_id: str,
    evaluator_id: str,
    assignment_id: str,
    values: dict,
) -> dict:
    assignment, plan = await _review_context(org_id, evaluator_id, assignment_id)
    if plan.get("status") != "open":
        raise HTTPException(status_code=409, detail="This evaluation plan is not open")
    criteria = normalize_criteria(plan.get("criteria") or [])
    is_draft = bool(values.get("is_draft", True))
    abstained = bool(values.get("abstained", False))
    abstain_reason = str(values.get("abstain_reason") or "").strip() or None
    if abstained and not is_draft and not abstain_reason:
        raise HTTPException(status_code=400, detail="Add a reason before submitting an abstention")
    scores = _validate_scores(
        values.get("scores") or {},
        criteria,
        plan.get("scale") or "1_5",
        final=not is_draft,
        abstained=abstained,
    )
    timestamp = _now()
    record = {
        "scores": {} if abstained else scores,
        "overall": None if abstained else weighted_overall(scores, criteria),
        "comment": str(values.get("comment") or "").strip() or None,
        "abstained": abstained,
        "abstain_reason": abstain_reason if abstained else None,
        "is_draft": is_draft,
        "updated_at": timestamp,
        "submitted_at": None if is_draft else timestamp,
    }
    existing = first(
        await db(
            lambda: supabase.table("reviews")
            .select("id")
            .eq("assignment_id", assignment_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "review_save_existing",
        )
    )
    if existing:
        review = first(
            await db(
                lambda: supabase.table("reviews")
                .update(record)
                .eq("id", existing["id"])
                .eq("assignment_id", assignment_id)
                .eq("org_id", org_id)
                .execute(),
                "review_save_update",
            )
        )
    else:
        review = first(
            await db(
                lambda: supabase.table("reviews")
                .insert(
                    {
                        **record,
                        "org_id": org_id,
                        "assignment_id": assignment["id"],
                        "started_at": timestamp,
                    }
                )
                .execute(),
                "review_save_insert",
            )
        )
    if not review:
        raise HTTPException(status_code=500, detail="Could not save review")
    await db(
        lambda: supabase.table("evaluators")
        .update({"last_active_at": timestamp})
        .eq("id", evaluator_id)
        .eq("plan_id", plan["id"])
        .eq("org_id", org_id)
        .execute(),
        "review_mark_active",
    )
    return review
