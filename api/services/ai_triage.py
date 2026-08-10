"""AI first-pass triage over a plan's submissions (ABS-14).

A program chair with two hundred abstracts wants a ranked first pass before
the committee reads anything: what is this talk, roughly how strong is it, and
should it advance, be discussed, or be declined. That is what this module
produces — one short summary, one numeric score, one suggested disposition and
the reasoning behind it, per submission.

Two properties matter more than the model choice:

*   **One call, not N.** Every submission goes into a single request, so the
    cost of a triage click is bounded by the size of the CFP rather than
    multiplied by it (see ``build_user_prompt``). A 20-submission plan is a
    fraction of a cent on ``claude-haiku-4-5``.
*   **It degrades, it never breaks.** With no ``ANTHROPIC_API_KEY`` — and on
    any API failure — the caller still gets a full result set, computed from
    the reviewer scores that already exist and labelled ``source:
    "heuristic"`` so the UI can say plainly that no model was involved. A
    triage button that 500s on a demo deployment is worse than one that is
    honest about running on arithmetic.

Nothing here talks to the database; ``services.evaluations`` gathers the
submissions, persists the result on the plan, and applies human overrides.
"""

from __future__ import annotations

import json
import logging
import math
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

# Cheap and fast: triage is a first pass over many short abstracts, not the
# committee's final judgement.
MODEL = "claude-haiku-4-5"
MAX_OUTPUT_TOKENS = 8000

SUGGESTIONS = ("advance", "discuss", "decline")
# Bounds on what one call may carry, so a runaway CFP can't produce a request
# that costs more than the organizer expects (or overflows the context).
MAX_SUBMISSIONS = 40
MAX_ABSTRACT_CHARS = 1200
MAX_SUMMARY_CHARS = 400
MAX_RATIONALE_CHARS = 600

SYSTEM_PROMPT = (
    "You are helping a conference program chair trim a first pass over "
    "submitted talk abstracts. For EACH submission you are given, write:\n"
    "  - summary: one or two sentences on what the talk actually covers, in "
    "concrete terms drawn from the abstract itself.\n"
    "  - score: a first-pass rating on the scale you are told to use, where "
    "the top of the scale is a talk you would program without hesitation.\n"
    "  - suggestion: 'advance' (strong, move it forward), 'discuss' (worth a "
    "committee conversation) or 'decline'.\n"
    "  - rationale: one or two sentences saying WHY, referring to this "
    "abstract's specifics — its topic, its claims, its audience fit — and to "
    "the reviewer scores when any are supplied. Never write a sentence that "
    "would apply equally well to a different submission.\n"
    "You are advisory. Human reviewers decide; say what you actually see, "
    "including when an abstract is too thin to judge."
)

TRIAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "summary": {"type": "string"},
                    "score": {"type": "number"},
                    "suggestion": {"type": "string", "enum": list(SUGGESTIONS)},
                    "rationale": {"type": "string"},
                },
                "required": ["session_id", "summary", "score", "suggestion", "rationale"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def api_key() -> str | None:
    """The configured Anthropic key, or None when triage must run on arithmetic."""
    key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
    return key or None


def scale_max(scale: Any) -> int:
    """The top of a plan's rating scale ('1_5' -> 5, '1_10' -> 10)."""
    return 10 if str(scale) == "1_10" else 5


def _clip(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def build_user_prompt(submissions: list[dict], *, top: int, criteria: list[str]) -> str:
    """Every submission in ONE message — the reason a triage click is cheap.

    Sending one request per abstract would multiply both latency and cost by
    the size of the CFP for no gain in quality; the model sees the whole field
    here, which is also what lets it calibrate 'advance' against the rest.
    """
    lines = [
        f"Rate every submission on a 1-{top} scale (higher is better).",
    ]
    if criteria:
        lines.append("The committee's scorecard weighs: " + ", ".join(criteria) + ".")
    lines.append(
        f"Return one item per submission, {len(submissions)} in total, using the "
        "session_id exactly as given."
    )
    lines.append("")
    for index, submission in enumerate(submissions, start=1):
        lines.append(f"--- Submission {index} ---")
        lines.append(f"session_id: {submission['session_id']}")
        lines.append(f"title: {_clip(submission.get('title'), 300) or 'Untitled'}")
        if submission.get("track"):
            lines.append(f"track: {_clip(submission['track'], 120)}")
        if submission.get("status"):
            lines.append(f"current status: {submission['status']}")
        review_count = int(submission.get("review_count") or 0)
        if review_count and submission.get("avg_score") is not None:
            lines.append(
                f"reviewer scores so far: {submission['avg_score']} average "
                f"from {review_count} completed review(s), on the same 1-{top} scale"
            )
        else:
            lines.append("reviewer scores so far: none yet")
        abstract = _clip(submission.get("abstract"), MAX_ABSTRACT_CHARS)
        lines.append("abstract:")
        lines.append(abstract or "(no abstract text was submitted)")
        lines.append("")
    return "\n".join(lines).strip()


async def _call_anthropic(system: str, prompt: str, *, key: str) -> dict:
    """One structured-output call. Patched wholesale in tests — never networked there."""
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=key)
    response = await client.messages.create(
        model=MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": TRIAGE_SCHEMA}},
    )
    text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
    if not text.strip():
        raise ValueError("The triage model returned no content")
    return json.loads(text)


def _coerce_score(raw: Any, *, top: int) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return round(min(max(value, 1.0), float(top)), 2)


def _suggestion_from_score(score: float | None, *, top: int) -> str:
    if score is None:
        return "discuss"
    ratio = score / top
    if ratio >= 0.75:
        return "advance"
    if ratio >= 0.5:
        return "discuss"
    return "decline"


def heuristic_items(submissions: list[dict], *, top: int) -> list[dict]:
    """Score-based triage for when no model is configured.

    Deliberately simple and deliberately labelled: it ranks on the reviewer
    scores that already exist and says so, rather than inventing prose that
    would read as if a model had judged the abstract.
    """
    items: list[dict] = []
    for submission in submissions:
        review_count = int(submission.get("review_count") or 0)
        score = _coerce_score(submission.get("avg_score"), top=top) if review_count else None
        suggestion = _suggestion_from_score(score, top=top)
        if score is None:
            rationale = (
                "No completed reviews yet, so this is ranked as undecided rather "
                "than judged. Configure an AI key or collect reviews for a real "
                "first pass."
            )
        else:
            rationale = (
                f"Ranked from the committee's own numbers: {score} average across "
                f"{review_count} completed review(s) on a 1-{top} scale."
            )
        abstract = _clip(submission.get("abstract"), 220)
        items.append(
            {
                "session_id": submission["session_id"],
                "title": submission.get("title") or "Untitled",
                "summary": abstract or "No abstract text was submitted.",
                "score": score,
                "suggestion": suggestion,
                "rationale": rationale,
            }
        )
    return items


def _rank(items: list[dict]) -> list[dict]:
    """Best first — the whole point of a triage list is the top of it."""
    order = {"advance": 0, "discuss": 1, "decline": 2}
    return sorted(
        items,
        key=lambda item: (
            order.get(str(item.get("suggestion")), 1),
            -(item.get("score") if isinstance(item.get("score"), (int, float)) else -1),
            str(item.get("title") or "").casefold(),
        ),
    )


def _merge_model_items(submissions: list[dict], raw_items: Any, *, top: int) -> list[dict]:
    """Trust the model's judgement, never its bookkeeping.

    The session ids, titles and the set of submissions come from our own rows;
    only the prose and the numbers come from the model, clamped to the plan's
    scale. A submission the model skipped falls back to the heuristic entry so
    the organizer never sees a short list with no explanation.
    """
    by_id: dict[str, dict] = {}
    if isinstance(raw_items, list):
        for entry in raw_items:
            if not isinstance(entry, dict):
                continue
            session_id = str(entry.get("session_id") or "")
            if session_id:
                by_id[session_id] = entry

    fallback = {item["session_id"]: item for item in heuristic_items(submissions, top=top)}
    items: list[dict] = []
    for submission in submissions:
        session_id = submission["session_id"]
        entry = by_id.get(session_id)
        if not entry:
            items.append(fallback[session_id])
            continue
        score = _coerce_score(entry.get("score"), top=top)
        suggestion = str(entry.get("suggestion") or "").strip().lower()
        if suggestion not in SUGGESTIONS:
            suggestion = _suggestion_from_score(score, top=top)
        items.append(
            {
                "session_id": session_id,
                "title": submission.get("title") or "Untitled",
                "summary": _clip(entry.get("summary"), MAX_SUMMARY_CHARS)
                or fallback[session_id]["summary"],
                "score": score,
                "suggestion": suggestion,
                "rationale": _clip(entry.get("rationale"), MAX_RATIONALE_CHARS)
                or "The model returned no rationale for this submission.",
            }
        )
    return items


async def triage(
    submissions: list[dict],
    *,
    scale: str = "1_5",
    criteria: list[str] | None = None,
) -> dict:
    """Triage every submission in one shot; never raise on a model failure.

    Returns ``{generated_at, source, model, items[]}`` where ``source`` is
    ``"anthropic"`` when the model produced the prose and ``"heuristic"`` when
    it did not — the UI labels the two differently on purpose.
    """
    top = scale_max(scale)
    considered = submissions[:MAX_SUBMISSIONS]
    if not considered:
        return {"generated_at": _now(), "source": "heuristic", "model": None, "items": []}

    key = api_key()
    if not key:
        return {
            "generated_at": _now(),
            "source": "heuristic",
            "model": None,
            "items": _rank(heuristic_items(considered, top=top)),
            "truncated": len(submissions) > len(considered),
        }

    prompt = build_user_prompt(considered, top=top, criteria=criteria or [])
    try:
        payload = await _call_anthropic(SYSTEM_PROMPT, prompt, key=key)
    except Exception:
        # A triage button that 500s is worse than one that says it fell back.
        logger.warning("ai triage: model call failed, falling back to scores", exc_info=True)
        return {
            "generated_at": _now(),
            "source": "heuristic",
            "model": None,
            "items": _rank(heuristic_items(considered, top=top)),
            "degraded": True,
            "truncated": len(submissions) > len(considered),
        }

    items = _merge_model_items(considered, (payload or {}).get("items"), top=top)
    return {
        "generated_at": _now(),
        "source": "anthropic",
        "model": MODEL,
        "items": _rank(items),
        "truncated": len(submissions) > len(considered),
    }
