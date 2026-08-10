"""Evaluation workflow operations shared by organizer and reviewer routes.

The Supabase service-role client bypasses RLS.  Every query in this module is
therefore scoped by the authenticated org, including join-table lookups.
"""

from __future__ import annotations

import html
import logging
import math
import os
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from postgrest.exceptions import APIError

from auth import verify_org_access
from services import magic_links
from services.supabase_helpers import db, first, rows
from supabase_client import supabase

logger = logging.getLogger(__name__)

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


# ── review window (migration 008) ──────────────────────────────────────────
# A plan may declare when reviewing opens and when it closes. BOTH BOUNDS ARE
# OPTIONAL and a missing bound is no bound, so every plan written before 008 —
# including the seeded demo plan — keeps accepting reviews exactly as it did.

WINDOW_FIELDS = ("opens_at", "closes_at")

# Flipped off the first time the database says these columns aren't there, so an
# API running ahead of migration 008 degrades to "no window" instead of 500ing
# on every plan write. Never flipped back on: a process restart re-probes.
_window_columns_present = True


def _parse_timestamp(value: Any) -> datetime | None:
    """A tolerant read of a stored/POSTed instant, always tz-aware (UTC)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip()
        if not text:
            return None
        if text[-1] in "Zz":
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _normalize_window_value(value: Any, *, field: str) -> str | None:
    """A date input's value ("2026-10-01") or a full instant, stored as ISO.

    A bare date means the whole day: the open bound starts at midnight and the
    close bound runs to the last second, which is what an organizer typing
    "reviews close Oct 10" means.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) == 10 and text.count("-") == 2:
        text = f"{text}T23:59:59" if field == "closes_at" else f"{text}T00:00:00"
    parsed = _parse_timestamp(text)
    if parsed is None:
        raise HTTPException(status_code=400, detail=f"'{field}' must be a date or a timestamp")
    return parsed.isoformat()


def _validate_window_order(opens_at: Any, closes_at: Any) -> None:
    opens, closes = _parse_timestamp(opens_at), _parse_timestamp(closes_at)
    if opens and closes and closes < opens:
        raise HTTPException(status_code=400, detail="The review window closes before it opens")


def _window_patch(values: dict) -> dict:
    """{opens_at, closes_at} for the keys the caller actually sent."""
    return {
        field: _normalize_window_value(values.get(field), field=field)
        for field in WINDOW_FIELDS
        if field in values
    }


def _has_window(payload: dict) -> bool:
    return any(field in payload for field in WINDOW_FIELDS)


def _strip_window(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if key not in WINDOW_FIELDS}


def _mentions_window_column(exc: Exception) -> bool:
    message = str(exc)
    return any(field in message for field in WINDOW_FIELDS)


async def _write_plan_row(payload: dict, build: Callable[[dict], Any], label: str) -> Any:
    """Run a plan insert/update, surviving a database without migration 008.

    The window columns are additive and nullable, so the only thing that can go
    wrong on an un-migrated database is writing them at all — in which case the
    dates are dropped (and remembered as unsupported) and the rest of the plan
    still saves.
    """
    global _window_columns_present
    attempt = dict(payload) if _window_columns_present else _strip_window(payload)
    try:
        return await db(lambda: build(attempt), label)
    except Exception as exc:
        if not _has_window(attempt) or not _mentions_window_column(exc):
            raise
        _window_columns_present = False
        logger.warning(
            "evaluation: review-window columns are missing (migration 008 not applied) — "
            "saving %s without dates",
            label,
        )
        return await db(lambda: build(_strip_window(payload)), f"{label}_no_window")


def _plan_out(plan: dict) -> dict:
    """A plan row that always carries the window keys, migrated or not."""
    return {**plan, **{field: plan.get(field) for field in WINDOW_FIELDS}}


def _friendly_instant(moment: datetime) -> str:
    return f"{moment:%b} {moment.day}, {moment.year}"


def ensure_review_window_open(plan: dict, *, now: datetime | None = None) -> None:
    """403 unless the plan's review window is currently open.

    Applies to every reviewer write, draft included — the window is the
    deadline, and a draft saved after it would be a review the organizer never
    asked for. NULL bounds are no bounds, so an un-dated plan is unrestricted.
    """
    opens_at = _parse_timestamp(plan.get("opens_at"))
    closes_at = _parse_timestamp(plan.get("closes_at"))
    if opens_at is None and closes_at is None:
        return
    moment = now or datetime.now(timezone.utc)
    if opens_at is not None and moment < opens_at:
        raise HTTPException(
            status_code=403,
            detail=f"The review window opens {_friendly_instant(opens_at)} — reviews aren't open yet.",
        )
    if closes_at is not None and moment > closes_at:
        raise HTTPException(
            status_code=403,
            detail=f"The review window closed {_friendly_instant(closes_at)}.",
        )


def review_open_state(plan: dict, *, now: datetime | None = None) -> tuple[bool, str | None]:
    """``(can a reviewer write, why not)`` — the reviewer portal's closed-state.

    The portal used to decide this itself from ``plan.status`` alone, which
    disagreed with the server in both directions: a plan the organizer had not
    opened yet showed a bare "Review closed" over a window that was plainly
    valid, and a plan whose window had run out still showed open controls that
    403'd on save. This is the single verdict, derived from exactly what
    :func:`save_review` enforces, and it carries the reason so the portal can
    say which of the two it is instead of contradicting the dates beside it.
    """
    status = plan.get("status")
    if status != "open":
        if status == "closed":
            return False, "This review round has been closed by the organizer."
        return False, "This review round hasn't opened yet — the organizer still has it in draft."
    try:
        ensure_review_window_open(plan, now=now)
    except HTTPException as exc:
        return False, str(exc.detail)
    return True, None


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


# ── criterion kinds (ABS-03) ───────────────────────────────────────────────
# A criterion used to be one thing: a number on the plan's scale. It can now
# also collect a CHOICE from a fixed list ("Which track does this belong in?")
# or free TEXT ("What would you tell the speaker?") — the two questions a
# scorecard needs that a 1–5 rating cannot express.
#
# The stored shapes are unchanged: a criterion is still an entry in the plan's
# `criteria` jsonb and a review is still `{criterion_name: value}`. A criterion
# with NO `kind` key IS a scale criterion, and `normalize_criteria` never
# writes the key for one, so every plan and review written before this change
# validates, scores, and aggregates byte-identically.
#
# Weight belongs to scale criteria only. Choice and text criteria collect an
# answer rather than a score, so they carry weight 0, sit outside the 100%
# total, and never move the weighted overall. A plan made entirely of them is
# legal and simply has no overall (None) — every reader handles that already.

CRITERION_KINDS = ("scale", "select", "text")
# The kinds a reviewer must answer before submitting. Text is deliberately
# absent: prose can't be demanded the way a rating can, and an empty box is
# indistinguishable from an unanswered one.
REQUIRED_KINDS = ("scale", "select")
MAX_TEXT_ANSWER = 2000
MAX_SELECT_OPTIONS = 50
MAX_OPTION_LENGTH = 200


def criterion_kind(criterion: dict) -> str:
    """'scale' | 'select' | 'text'. An absent (or unrecognized) kind is scale."""
    kind = str(criterion.get("kind") or "scale").strip().lower()
    return kind if kind in CRITERION_KINDS else "scale"


def criterion_options(criterion: dict) -> list[str]:
    """The choices a select criterion offers ([] for any other kind)."""
    raw = criterion.get("options")
    if not isinstance(raw, (list, tuple)):
        return []
    return [str(option) for option in raw]


def is_scale_criterion(criterion: dict) -> bool:
    """True for the numeric criterion that has always existed."""
    return criterion_kind(criterion) == "scale"


def _normalize_options(name: str, raw: Any) -> list[str]:
    """A select criterion's choices: non-empty, de-duplicated, capped."""
    if isinstance(raw, str):
        raw = raw.split(",")
    if raw is None or not isinstance(raw, (list, tuple)):
        raise HTTPException(
            status_code=400, detail=f"Criterion '{name}' needs a list of choices"
        )
    options: list[str] = []
    seen: set[str] = set()
    for item in raw:
        option = str(item).strip()
        if not option:
            continue
        if len(option) > MAX_OPTION_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=f"A choice for '{name}' is longer than {MAX_OPTION_LENGTH} characters",
            )
        key = option.casefold()
        if key in seen:
            continue
        seen.add(key)
        options.append(option)
    if not options:
        raise HTTPException(
            status_code=400, detail=f"Criterion '{name}' needs at least one choice"
        )
    if len(options) > MAX_SELECT_OPTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Criterion '{name}' can offer at most {MAX_SELECT_OPTIONS} choices",
        )
    return options


def normalize_criteria(criteria: list[dict] | None) -> list[dict]:
    """Return validated criteria with stable names and numeric weights.

    A scale criterion normalizes to exactly `{name, weight}` — the pre-ABS-03
    shape, with no `kind` key — so re-saving an existing plan rewrites it
    unchanged. Only scale weights count toward the 100% total, and a plan with
    no scale criteria has nothing to weight, so the rule is skipped.
    """
    source = DEFAULT_CRITERIA if criteria is None else criteria
    if not source:
        raise HTTPException(status_code=400, detail="At least one criterion is required")

    normalized: list[dict] = []
    seen: set[str] = set()
    for item in source:
        name = str(item.get("name") or "").strip()
        kind = str(item.get("kind") or "scale").strip().lower()
        if kind not in CRITERION_KINDS:
            raise HTTPException(
                status_code=400,
                detail=f"Criterion '{name or 'Unnamed'}' has an unknown type: {kind}",
            )
        weight = 0.0
        if kind == "scale":
            try:
                weight = float(item.get("weight"))
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Criterion '{name or 'Unnamed'}' needs a numeric weight",
                ) from exc
        if not name:
            raise HTTPException(status_code=400, detail="Criterion names cannot be empty")
        key = name.casefold()
        if key in seen:
            raise HTTPException(status_code=400, detail=f"Criterion names must be unique: {name}")
        if kind == "scale" and (not math.isfinite(weight) or weight <= 0):
            raise HTTPException(status_code=400, detail=f"Criterion '{name}' needs a positive weight")
        seen.add(key)
        if kind == "scale":
            normalized.append(
                {"name": name, "weight": int(weight) if weight.is_integer() else weight}
            )
        elif kind == "select":
            normalized.append(
                {
                    "name": name,
                    "weight": 0,
                    "kind": "select",
                    "options": _normalize_options(name, item.get("options")),
                }
            )
        else:
            normalized.append({"name": name, "weight": 0, "kind": "text"})

    scale_weights = [float(item["weight"]) for item in normalized if is_scale_criterion(item)]
    if scale_weights and abs(sum(scale_weights) - 100) > 0.001:
        raise HTTPException(status_code=400, detail="Criterion weights must add up to 100")
    return normalized


def weighted_overall(scores: dict[str, Any], criteria: list[dict]) -> float | None:
    """Calculate a weighted mean on the plan's native score scale.

    Only SCALE criteria take part — a choice or a paragraph has no place in a
    mean, and skipping them leaves the number identical to what the same plan
    would produce without them. Missing or non-numeric values make the result
    incomplete rather than silently treating an unanswered criterion as zero,
    and a plan with no scale criteria has no overall at all (None).
    """
    if not criteria:
        return None
    weighted_sum = 0.0
    weight_sum = 0.0
    for criterion in criteria:
        if not is_scale_criterion(criterion):
            continue
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
    window = _window_patch({field: values.get(field) for field in WINDOW_FIELDS})
    _validate_window_order(window.get("opens_at"), window.get("closes_at"))
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
        **window,
    }
    plan = first(
        await _write_plan_row(
            record,
            lambda payload: supabase.table("evaluation_plans").insert(payload).execute(),
            "evaluation_plan_create",
        )
    )
    if not plan:
        raise HTTPException(status_code=500, detail="Could not create evaluation plan")
    return _plan_out(plan)


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
            **_plan_out(plan),
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
        "plan": _plan_out(plan),
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
    existing = await fetch_plan(plan_id, org_id)
    if "name" in patch:
        patch["name"] = str(patch["name"]).strip()
    if "instructions" in patch:
        patch["instructions"] = str(patch["instructions"] or "").strip()
    if "criteria" in patch:
        patch["criteria"] = normalize_criteria(patch["criteria"])
    if _has_window(patch):
        patch.update(_window_patch(patch))
        # A patch that only moves one bound is still checked against the other.
        _validate_window_order(
            patch.get("opens_at", existing.get("opens_at")),
            patch.get("closes_at", existing.get("closes_at")),
        )
    updated = first(
        await _write_plan_row(
            patch,
            lambda payload: supabase.table("evaluation_plans")
            .update(payload)
            .eq("id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_plan_update",
        )
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Evaluation plan not found")
    return _plan_out(updated)


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


# ── per-submission assignment (ABS-05) ─────────────────────────────────────
# Assigning by track is a bulk stroke; a program chair also needs the single
# deliberate pairing — "Ada should read THIS one". These three calls are that,
# and they compose with the bulk modes because every mode dedupes on the same
# (plan, evaluator, session) key.


async def _plan_evaluator(org_id: str, plan_id: str, evaluator_id: str) -> dict:
    evaluator = first(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("id", evaluator_id)
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_assignment_evaluator",
        )
    )
    return verify_org_access(evaluator, org_id, "Evaluator")


async def _plan_session(org_id: str, plan: dict, session_id: str) -> dict:
    session = first(
        await db(
            lambda: supabase.table("sessions")
            .select("id, title, friendly_id, status, track_id, org_id")
            .eq("id", session_id)
            .eq("event_id", plan["event_id"])
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_assignment_session",
        )
    )
    return verify_org_access(session, org_id, "Session")


def _reviewer_label(evaluator: dict) -> str:
    return str(evaluator.get("name") or "").strip() or str(evaluator.get("email") or "Reviewer")


def _review_status(review: dict | None) -> str:
    if not review:
        return "pending"
    return "in_progress" if bool(review.get("is_draft")) else "reviewed"


async def create_assignment(
    org_id: str, plan_id: str, evaluator_id: str, session_id: str
) -> dict:
    """Assign ONE reviewer to ONE submission. 409 if the pair already exists."""
    plan = await fetch_plan(plan_id, org_id)
    evaluator = await _plan_evaluator(org_id, plan_id, evaluator_id)
    session = await _plan_session(org_id, plan, session_id)
    existing = first(
        await db(
            lambda: supabase.table("assignments")
            .select("id")
            .eq("plan_id", plan_id)
            .eq("evaluator_id", evaluator_id)
            .eq("session_id", session_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_assignment_existing",
        )
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"{_reviewer_label(evaluator)} is already assigned to this submission",
        )
    try:
        created = first(
            await db(
                lambda: supabase.table("assignments")
                .insert(
                    {
                        "org_id": org_id,
                        "plan_id": plan_id,
                        "evaluator_id": evaluator_id,
                        "session_id": session_id,
                    }
                )
                .execute(),
                "evaluation_assignment_create",
            )
        )
    except APIError as exc:
        # The pre-check above races a concurrent identical create; the unique
        # constraint is the real arbiter — surface it as the promised 409.
        if getattr(exc, "code", "") == "23505":
            raise HTTPException(
                status_code=409,
                detail=f"{_reviewer_label(evaluator)} is already assigned to this submission",
            ) from exc
        raise
    if not created:
        raise HTTPException(status_code=500, detail="Could not create the assignment")
    return {
        **created,
        "evaluator_name": evaluator.get("name") or "",
        "evaluator_email": evaluator.get("email"),
        "session_title": session.get("title"),
        "review_status": "pending",
    }


async def delete_assignment(org_id: str, plan_id: str, assignment_id: str) -> None:
    """Unassign one reviewer from one submission, dropping their review with it."""
    await fetch_plan(plan_id, org_id)
    assignment = first(
        await db(
            lambda: supabase.table("assignments")
            .select("id, org_id")
            .eq("id", assignment_id)
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .limit(1)
            .execute(),
            "evaluation_assignment_lookup",
        )
    )
    verify_org_access(assignment, org_id, "Assignment")
    # One scoped delete: reviews.assignment_id is ON DELETE CASCADE, so Postgres
    # removes the review atomically with its assignment. Deleting the review in
    # a separate first step could lose it and then leave the assignment behind
    # if the second write failed.
    await db(
        lambda: supabase.table("assignments")
        .delete()
        .eq("id", assignment_id)
        .eq("plan_id", plan_id)
        .eq("org_id", org_id)
        .execute(),
        "evaluation_assignment_delete",
    )


async def assignment_board(org_id: str, plan_id: str) -> dict:
    """Every reviewable submission with the reviewers currently on it.

    Backs the per-submission assignment UI: one row per candidate submission,
    each carrying its assignments (with reviewer name and how far along they
    are) so the organizer can add or drop a single reviewer without touching
    the bulk modes. A flat set of queries — never one per submission.
    """
    plan = await fetch_plan(plan_id, org_id)
    evaluators = rows(
        await db(
            lambda: supabase.table("evaluators")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .order("name")
            .execute(),
            "evaluation_board_evaluators",
        )
    )
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("*")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_board_assignments",
        )
    )
    assignment_ids = [row["id"] for row in assignments]
    reviews: list[dict] = []
    if assignment_ids:
        reviews = rows(
            await db(
                lambda: supabase.table("reviews")
                .select("assignment_id, is_draft")
                .in_("assignment_id", assignment_ids)
                .eq("org_id", org_id)
                .execute(),
                "evaluation_board_reviews",
            )
        )
    review_by_assignment = {row["assignment_id"]: row for row in reviews}
    evaluator_by_id = {row["id"]: row for row in evaluators}

    all_sessions = rows(
        await db(
            lambda: supabase.table("sessions")
            .select("id, title, friendly_id, status, track_id")
            .eq("event_id", plan["event_id"])
            .eq("org_id", org_id)
            .execute(),
            "evaluation_board_sessions",
        )
    )
    assigned_ids = {row["session_id"] for row in assignments}
    session_filter = plan.get("session_filter") or {}
    # Candidates are what the plan covers, plus anything already assigned — a
    # submission whose status has moved on stays visible while reviewers are
    # still attached to it.
    candidates = [
        session
        for session in all_sessions
        if session["id"] in assigned_ids or _matches_session_filter(session, session_filter)
    ]
    candidates.sort(key=lambda session: str(session.get("title") or "").casefold())
    session_tracks = await tracks_for_sessions(org_id, candidates)

    by_session: dict[str, list[dict]] = {}
    for assignment in assignments:
        evaluator = evaluator_by_id.get(assignment["evaluator_id"])
        if not evaluator:
            continue
        by_session.setdefault(assignment["session_id"], []).append(
            {
                "assignment_id": assignment["id"],
                "evaluator_id": assignment["evaluator_id"],
                "name": evaluator.get("name") or "",
                "email": evaluator.get("email"),
                "review_status": _review_status(review_by_assignment.get(assignment["id"])),
            }
        )
    for entries in by_session.values():
        entries.sort(key=lambda entry: (str(entry["name"] or entry["email"] or "").casefold()))

    return {
        "evaluators": [
            {
                "id": evaluator["id"],
                "name": evaluator.get("name") or "",
                "email": evaluator.get("email"),
                "track_ids": normalize_track_ids(evaluator.get("track_ids")),
            }
            for evaluator in evaluators
        ],
        "sessions": [
            {
                "session_id": session["id"],
                "title": session.get("title") or "Untitled",
                "friendly_id": session.get("friendly_id"),
                "status": session.get("status"),
                "tracks": session_tracks.get(session["id"], []),
                "assignments": by_session.get(session["id"], []),
            }
            for session in candidates
        ],
    }


# ── targeted reminders (ABS-09) ────────────────────────────────────────────


def _incomplete_by_evaluator(assignments: list[dict], reviews: list[dict]) -> dict[str, int]:
    """{evaluator_id: assignments with no submitted review}.

    Incomplete means "no review row at all" OR "a draft" — a reviewer who saved
    a scratch draft and stopped is exactly who a reminder is for.
    """
    review_by_assignment = {row["assignment_id"]: row for row in reviews}
    pending: dict[str, int] = {}
    for assignment in assignments:
        review = review_by_assignment.get(assignment["id"])
        if review is not None and not bool(review.get("is_draft")):
            continue
        evaluator_id = assignment["evaluator_id"]
        pending[evaluator_id] = pending.get(evaluator_id, 0) + 1
    return pending


async def remind_laggards(org_id: str, plan_id: str) -> dict:
    """Email only the reviewers with unfinished work — not the whole committee.

    Idempotent per day: the outbox row is keyed
    `eval-laggard:{evaluator_id}:{YYYY-MM-DD}`, so a second click the same day
    reminds nobody instead of storming inboxes.
    """
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
            "evaluation_remind_evaluators",
        )
    )
    assignments = rows(
        await db(
            lambda: supabase.table("assignments")
            .select("id, evaluator_id, session_id")
            .eq("plan_id", plan_id)
            .eq("org_id", org_id)
            .execute(),
            "evaluation_remind_assignments",
        )
    )
    assignment_ids = [row["id"] for row in assignments]
    reviews: list[dict] = []
    if assignment_ids:
        reviews = rows(
            await db(
                lambda: supabase.table("reviews")
                .select("assignment_id, is_draft")
                .in_("assignment_id", assignment_ids)
                .eq("org_id", org_id)
                .execute(),
                "evaluation_remind_reviews",
            )
        )
    pending = _incomplete_by_evaluator(assignments, reviews)
    laggards = [row for row in evaluators if pending.get(row["id"], 0) > 0]

    frontend_url = (os.getenv("FRONTEND_URL") or "http://localhost:5173").rstrip("/")
    today = datetime.now(timezone.utc).date().isoformat()
    closes_at = _parse_timestamp(plan.get("closes_at"))
    reminded: list[str] = []
    skipped: list[str] = []

    for evaluator in laggards:
        dedupe_key = f"eval-laggard:{evaluator['id']}:{today}"
        already = rows(
            await db(
                lambda dedupe_key=dedupe_key: supabase.table("email_outbox")
                .select("id")
                .eq("event_id", plan["event_id"])
                .eq("dedupe_key", dedupe_key)
                .limit(1)
                .execute(),
                "evaluation_remind_dedupe",
            )
        )
        if already:
            skipped.append(_reviewer_label(evaluator))
            continue

        outstanding = pending.get(evaluator["id"], 0)
        token = await magic_links.mint(org_id, "review", evaluator_id=evaluator["id"], ttl_hours=168)
        reviewer_link = f"{frontend_url}/review/{token}"
        noun = "review" if outstanding == 1 else "reviews"
        subject = f"[{event['name']}] {outstanding} {noun} still to complete"
        deadline = (
            f"<p>The review window closes {html.escape(_friendly_instant(closes_at))}.</p>"
            if closes_at
            else ""
        )
        body_html = (
            f"<p>Hello {html.escape(_reviewer_label(evaluator))},</p>"
            f"<p>You still have {outstanding} unfinished {noun} for "
            f"{html.escape(str(event['name']))} ({html.escape(str(plan['name']))}).</p>"
            f"{deadline}"
            f'<p><a href="{html.escape(reviewer_link)}">Finish your reviews</a></p>'
        )
        await db(
            lambda evaluator=evaluator, dedupe_key=dedupe_key, subject=subject, body_html=body_html, reviewer_link=reviewer_link, outstanding=outstanding: (
                supabase.table("email_outbox")
                .upsert(
                    {
                        "org_id": org_id,
                        "event_id": plan["event_id"],
                        "contact_id": None,
                        "template_key": "evaluation_reminder",
                        "payload": {
                            "to": evaluator["email"],
                            "subject": subject,
                            "body_html": body_html,
                            "reviewer_link": reviewer_link,
                            "evaluator_id": evaluator["id"],
                            "plan_id": plan_id,
                            "outstanding": outstanding,
                        },
                        "dedupe_key": dedupe_key,
                        "status": "queued",
                        "attempts": 0,
                        "last_error": None,
                    },
                    on_conflict="event_id,dedupe_key",
                )
                .execute()
            ),
            "evaluation_remind_queue",
        )
        reminded.append(_reviewer_label(evaluator))

    return {
        "reminded": len(reminded),
        "evaluators": reminded,
        "skipped": len(skipped),
        "already_reminded": skipped,
        "incomplete_reviewers": len(laggards),
        "outstanding": sum(pending.values()),
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
    return {"plan": _plan_out(updated_plan), "count": queued}


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
            criteria_order.append(
                {
                    "name": name,
                    "weight": criterion.get("weight"),
                    "kind": criterion_kind(criterion),
                    "options": criterion_options(criterion),
                }
            )

    # Scale criteria average, exactly as before. A choice criterion instead
    # tallies how often each option was picked, and a text criterion collects
    # the responses against the (already anonymized) reviewer label.
    criterion_scores: dict[str, list[float]] = {
        item["name"]: [] for item in criteria_order if item["kind"] == "scale"
    }
    criterion_counts: dict[str, dict[str, int]] = {
        item["name"]: {} for item in criteria_order if item["kind"] == "select"
    }
    criterion_responses: dict[str, list[dict]] = {
        item["name"]: [] for item in criteria_order if item["kind"] == "text"
    }
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
                numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
                written = isinstance(value, str) and bool(value.strip())
                if name in criterion_scores and numeric:
                    criterion_scores[name].append(float(value))
                elif name in criterion_counts and written:
                    tally = criterion_counts[name]
                    tally[value] = tally.get(value, 0) + 1
                elif name in criterion_responses and written:
                    criterion_responses[name].append({"reviewer": reviewer, "value": value})

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

    # `average` stays the scale criterion's number and is None for the other
    # kinds, so a reader that only knows about averages skips them untouched;
    # `counts`/`responses` are the new, additive fields carrying the rest.
    criteria_out: list[dict] = []
    for item in criteria_order:
        name = item["name"]
        collected = criterion_scores.get(name) or []
        entry = {
            "name": name,
            "weight": item["weight"],
            "average": round(sum(collected) / len(collected), 2) if collected else None,
            "kind": item["kind"],
        }
        if item["kind"] == "select":
            entry["options"] = item["options"]
            entry["counts"] = criterion_counts.get(name, {})
        elif item["kind"] == "text":
            entry["responses"] = criterion_responses.get(name, [])
        criteria_out.append(entry)

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

    # One entry per PERSON, not per participant row. A CFP submitter is stored
    # twice on purpose — once as 'speaker', once as 'submitter' — so that adding
    # a co-speaker can't drop them from the program. Handing both rows to the
    # reviewer printed "Presented by Priya Raman, Priya Raman". The roles are
    # merged onto the single entry instead, so nothing is lost.
    seen: dict[tuple[str, str], dict] = {}
    for participant in participants:
        contact = contacts_by_id.get(participant.get("contact_id"))
        if not contact:
            continue
        session_id = participant["session_id"]
        key = (str(session_id), str(contact["id"]))
        role = participant.get("role")
        existing = seen.get(key)
        if existing:
            if role and role not in existing["roles"]:
                existing["roles"].append(role)
            existing["is_primary"] = bool(existing.get("is_primary")) or bool(
                participant.get("is_primary")
            )
            continue
        entry = {
            **contact,
            # `role` stays the first (most primary) role for every existing
            # reader; `roles` is the full set for anything that wants to label.
            "role": role,
            "roles": [role] if role else [],
            "is_primary": bool(participant.get("is_primary")),
        }
        seen[key] = entry
        result.setdefault(session_id, []).append(entry)
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

    review_open, closed_reason = review_open_state(plan)
    return {
        "evaluator": evaluator,
        "plan": {
            **{
                key: plan.get(key)
                for key in (
                    "id",
                    "name",
                    "instructions",
                    "scale",
                    "criteria",
                    "anonymized",
                    "status",
                    # the reviewer should see their own deadline
                    *WINDOW_FIELDS,
                )
            },
            # Whether this reviewer can actually write, decided here rather than
            # inferred from `status` in the browser — see review_open_state.
            "review_open": review_open,
            "closed_reason": closed_reason,
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


def _validate_choice(name: str, raw_value: Any, criterion: dict) -> str:
    """A select answer: exactly one of that criterion's own options."""
    options = criterion_options(criterion)
    value = raw_value.strip() if isinstance(raw_value, str) else None
    if value is None or value not in options:
        raise HTTPException(
            status_code=400,
            detail=f"Answer for '{name}' must be one of: {', '.join(options)}",
        )
    return value


def _validate_text(name: str, raw_value: Any) -> str:
    """A free-text answer: any string, capped so one reviewer can't paste a book."""
    if not isinstance(raw_value, str):
        raise HTTPException(status_code=400, detail=f"Answer for '{name}' must be text")
    value = raw_value.strip()
    if len(value) > MAX_TEXT_ANSWER:
        raise HTTPException(
            status_code=400,
            detail=f"Answer for '{name}' must be {MAX_TEXT_ANSWER} characters or fewer",
        )
    return value


def _validate_scores(
    scores: dict[str, Any], criteria: list[dict], scale: str, *, final: bool, abstained: bool
) -> dict[str, Any]:
    """Check a reviewer's answers against the plan's criteria.

    A scale criterion is validated exactly as it always was — a number on the
    plan's scale — so an old plan scored by an old client behaves identically.
    A select answer must be one of that criterion's options; a text answer is
    any string within `MAX_TEXT_ANSWER`. A blank select/text answer is dropped
    rather than stored, so "cleared the field" and "never answered" are one
    state, and text is optional even on a final submit.
    """
    by_name = {str(item["name"]): item for item in criteria}
    unknown = sorted(set(scores) - set(by_name))
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown criterion: {unknown[0]}")
    # An emptied choice/text field is no answer at all. Scale values are left
    # exactly as sent — "" there is still the "must be a number" 400 it was.
    scores = {
        name: value
        for name, value in scores.items()
        if not (
            not is_scale_criterion(by_name[name])
            and isinstance(value, str)
            and not value.strip()
        )
    }
    if final and not abstained:
        missing = [
            name
            for name, criterion in by_name.items()
            if criterion_kind(criterion) in REQUIRED_KINDS and name not in scores
        ]
        if missing:
            raise HTTPException(status_code=400, detail=f"Score required for: {missing[0]}")
    maximum = 10 if scale == "1_10" else 5
    normalized: dict[str, Any] = {}
    for name, raw_value in scores.items():
        kind = criterion_kind(by_name[name])
        if kind == "select":
            normalized[name] = _validate_choice(name, raw_value, by_name[name])
            continue
        if kind == "text":
            normalized[name] = _validate_text(name, raw_value)
            continue
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
    ensure_review_window_open(plan)
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
