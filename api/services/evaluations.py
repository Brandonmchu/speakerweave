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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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

    evaluator_summary: list[dict] = []
    for evaluator in evaluators:
        mine = [row for row in assignments if row["evaluator_id"] == evaluator["id"]]
        mine_reviews = [review_by_assignment[row["id"]] for row in mine if row["id"] in review_by_assignment]
        evaluator_summary.append(
            {
                **evaluator,
                "assignment_count": len(mine),
                "review_count": len(mine_reviews),
                "complete_count": sum(not bool(row.get("is_draft")) for row in mine_reviews),
            }
        )

    by_session: dict[str, dict] = {}
    for assignment in assignments:
        session_id = assignment["session_id"]
        entry = by_session.setdefault(
            session_id, {"session_id": session_id, "assignment_count": 0, "review_count": 0}
        )
        entry["assignment_count"] += 1
        if assignment["id"] in review_by_assignment:
            entry["review_count"] += 1

    return {
        "plan": plan,
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


async def add_evaluator(org_id: str, plan_id: str, email_address: str, name: str) -> dict:
    await fetch_plan(plan_id, org_id)
    normalized_email = email_address.strip().lower()
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
        return existing
    evaluator = first(
        await db(
            lambda: supabase.table("evaluators")
            .insert(
                {
                    "org_id": org_id,
                    "plan_id": plan_id,
                    "email": normalized_email,
                    "name": name.strip(),
                }
            )
            .execute(),
            "evaluation_evaluator_create",
        )
    )
    if not evaluator:
        raise HTTPException(status_code=500, detail="Could not add evaluator")
    return evaluator


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
    desired = [
        {
            "org_id": org_id,
            "plan_id": plan_id,
            "evaluator_id": evaluator["id"],
            "session_id": session["id"],
        }
        for evaluator in evaluators
        for session in sessions
        if (evaluator["id"], session["id"]) not in existing_keys
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
                .select("id, title, friendly_id, status")
                .in_("id", session_ids)
                .eq("event_id", plan["event_id"])
                .eq("org_id", org_id)
                .execute(),
                "evaluation_summary_sessions",
            )
        )

    session_by_id = {row["id"]: row for row in sessions}
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
