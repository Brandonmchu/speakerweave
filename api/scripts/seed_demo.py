#!/usr/bin/env python3
"""Realistic demo-data seeder for the dais AI Builders Summit demo event.

Fills every organizer feature with compelling, real-looking content so a live
demo shows a full funnel, a scheduled agenda (with a deliberate speaker
double-booking), an onboarding dashboard with a spread of speaker progress, an
evaluation plan mid-review, and a non-empty comms log.

Two entrypoints:

    venv/bin/python -m scripts.seed_demo reset   # delete only demo-seeded rows
    venv/bin/python -m scripts.seed_demo seed    # reset, then insert (idempotent)
    venv/bin/python -m scripts.seed_demo seed --namespace a  # clone workspace

Everything this script writes carries a FIXED demo UUID (or hangs off a row that
does), so `reset()` deletes precisely the demo rows and never touches the event,
its rooms/tracks/formats/fields/CFP form, or any unrelated (e.g. E2E test) data.
Uses the service-role Supabase client directly (see supabase_client.py).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import re
import sys
from datetime import datetime, timedelta, timezone

from scripts.mint_dev_token import mint_dev_token

# Run as a module (`-m scripts.seed_demo`) from the api/ directory so the
# project root is importable.
from services.onboarding import CANONICAL_TASKS, provision_speaker_onboarding
from supabase_client import supabase

# ── fixed identifiers of the pre-existing demo event and its taxonomy ────────
ORG = "org_dev"
EVENT = "11111111-1111-1111-1111-111111111111"

TRACK_ENG = "22222222-2222-2222-2222-222222222201"
TRACK_PROD = "22222222-2222-2222-2222-222222222202"
TRACK_RES = "22222222-2222-2222-2222-222222222203"

ROOM_MAIN = "33333333-3333-3333-3333-333333333301"
ROOM_A = "33333333-3333-3333-3333-333333333302"
ROOM_B = "33333333-3333-3333-3333-333333333303"

FMT_KEYNOTE = "44444444-4444-4444-4444-444444444401"  # 45m
FMT_TALK = "44444444-4444-4444-4444-444444444402"  # 30m
FMT_LIGHTNING = "44444444-4444-4444-4444-444444444403"  # 15m
FMT_WORKSHOP = "44444444-4444-4444-4444-444444444404"  # 90m

CFP_FORM = "66666666-6666-6666-6666-666666666601"

F_ABSTRACT = "55555555-5555-5555-5555-555555555501"
F_TRACK = "55555555-5555-5555-5555-555555555502"
F_FORMAT = "55555555-5555-5555-5555-555555555503"
F_TAKEAWAYS = "55555555-5555-5555-5555-555555555504"
F_BIO = "55555555-5555-5555-5555-555555555505"
F_PRIOR = "55555555-5555-5555-5555-555555555506"
F_SPOKEN = "55555555-5555-5555-5555-555555555507"
QUESTION_RULE = "77777777-7777-7777-7777-777777777701"

EVENT_SLUG = "ai-builders-summit"
FORM_SLUG = "call-for-speakers"

_NAMESPACE_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62})\Z")
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)


def validate_namespace(namespace: str) -> str:
    """Validate a namespace for safe use in both org ids and public slugs."""
    if not _NAMESPACE_RE.fullmatch(namespace):
        raise ValueError(
            "namespace must be 1-63 lowercase letters, digits, or hyphens, "
            "and cannot start with a hyphen"
        )
    return namespace


def namespace_byte(namespace: str) -> str:
    """Return the stable byte reserved for a namespace's cloned UUIDs.

    Single-letter namespaces deliberately map a -> aa, b -> ab, ... z -> c3
    for readable test replicas. Longer namespaces use the first SHA-256 byte.
    As requested, the scheme has a one-byte namespace space, so callers should
    avoid namespace-byte collisions when keeping more than one clone.
    """
    namespace = validate_namespace(namespace)
    if len(namespace) == 1 and "a" <= namespace <= "z":
        return f"{0xAA + ord(namespace) - ord('a'):02x}"
    return hashlib.sha256(namespace.encode("utf-8")).hexdigest()[:2]


def remap(uuid_value: str, namespace: str | None) -> str:
    """Replace a seeded UUID's first byte for ``namespace``; no-op by default."""
    if namespace is None:
        return uuid_value
    if not _UUID_RE.fullmatch(uuid_value):
        raise ValueError(f"not a canonical UUID: {uuid_value!r}")
    return namespace_byte(namespace) + uuid_value[2:]


def org_id(namespace: str | None) -> str:
    return ORG if namespace is None else f"org_replica_{validate_namespace(namespace)}"


def event_slug(namespace: str | None) -> str:
    return EVENT_SLUG if namespace is None else f"{EVENT_SLUG}-{validate_namespace(namespace)}"


def form_slug(namespace: str | None) -> str:
    return FORM_SLUG if namespace is None else f"{FORM_SLUG}-{validate_namespace(namespace)}"


def _scope_seed_value(value, namespace: str | None):
    """Recursively scope seeded UUIDs, UUID-keyed JSON, and org references."""
    if namespace is None:
        return value
    if isinstance(value, dict):
        return {
            _scope_seed_value(key, namespace): _scope_seed_value(item, namespace)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_scope_seed_value(item, namespace) for item in value]
    if isinstance(value, tuple):
        return tuple(_scope_seed_value(item, namespace) for item in value)
    if value == ORG:
        return org_id(namespace)
    if isinstance(value, str) and _UUID_RE.fullmatch(value):
        return remap(value, namespace)
    return value


def _scope_rows(rows: list[dict], namespace: str | None) -> list[dict]:
    return _scope_seed_value(rows, namespace)

# ── demo-row UUID factories (hex-only prefixes = "this is demo-seeded") ───────
def _contact_id(i: int) -> str:
    return f"dacc0000-0000-0000-0000-{i:012d}"


def _session_id(i: int) -> str:
    return f"da550000-0000-0000-0000-{i:012d}"


PORTAL_ID = "da700000-0000-0000-0000-000000000001"


def _task_id(i: int) -> str:
    return f"da7a0000-0000-0000-0000-{i:012d}"


PLAN_ID = "dae70000-0000-0000-0000-000000000001"


def _evaluator_id(i: int) -> str:
    return f"dae7e000-0000-0000-0000-{i:012d}"


def _assignment_id(i: int) -> str:
    return f"a5510000-0000-0000-0000-{i:012d}"


def _review_id(i: int) -> str:
    return f"9e770000-0000-0000-0000-{i:012d}"


def _template_id(i: int) -> str:
    return f"ea700000-0000-0000-0000-{i:012d}"


def _outbox_id(i: int) -> str:
    return f"ea7b0000-0000-0000-0000-{i:012d}"


NOW = datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _ago(**kw) -> str:
    return _iso(NOW - timedelta(**kw))


def _ahead(**kw) -> str:
    return _iso(NOW + timedelta(**kw))


# Schedule anchors. October 2026 is PDT (UTC-7); storing the offset keeps the
# wall-clock readable and lands the sessions inside the event's 08:00–18:00 day.
OFF = "-07:00"
D1 = "2026-10-12"
D2 = "2026-10-13"


def _at(day: str, hhmm: str) -> str:
    return f"{day}T{hhmm}:00{OFF}"


# ═══════════════════════════════════════════════════════════════════════════
# CONTACTS (speakers)
# ═══════════════════════════════════════════════════════════════════════════
# (first, last, company, title, pronouns, bio, has_photo, portal_ago_hours)
_CONTACT_SPEC = [
    ("Ada", "Okafor", "Lumen AI", "VP of Engineering", "she/her",
     ("Ada leads the infrastructure org at Lumen AI, where she has spent the last "
     "four years driving down the cost of large-model training. She previously "
     "built distributed systems at two hyperscalers."), True, 2),
    ("Priya", "Raman", "VectorWorks", "Staff ML Engineer", "she/her",
     ("Priya works on retrieval systems that serve billions of queries a day. She "
     "is a frequent speaker on production RAG and vector search."), True, 24),
    ("Marco", "Bianchi", "DeepIndex", "Research Scientist", "he/him",
     ("Marco researches the internals of approximate nearest-neighbour indexes and "
     "how they behave under real-world drift."), True, 3),
    ("Elena", "Vasquez", "FineTune Labs", "Founder & CEO", "she/her",
     ("Elena founded FineTune Labs to make domain adaptation of open models a "
     "one-afternoon task. She teaches a popular workshop on the same."), True, 30),
    ("James", "Park", "RedTeam AI", "Principal Security Researcher", "he/him",
     ("James breaks language models for a living and writes about what he finds. He "
     "runs the RedTeam AI disclosure program."), True, None),
    ("Aisha", "Bello", "AgentGrid", "Head of Product", "she/her",
     ("Aisha has shipped three agent products to production and has strong opinions "
     "about what 'evaluation' should actually mean for a shipping team."), True, 5),
    ("David", "Chen", "Boring Robots", "Co-founder & CTO", "he/him",
     ("David believes the best AI systems are the least exciting ones. He builds "
     "reliable automation for unglamorous industries."), True, None),
    ("Yuki", "Tanaka", "PixelMind", "Research Engineer", "they/them",
     ("Yuki works at the intersection of vision and language, building multimodal "
     "models that run at scale in production."), True, 48),
    ("Omar", "Haddad", "ToolChain", "Staff Developer Advocate", "he/him",
     ("Omar helps developers build agents that use tools well. He maintains several "
     "widely used open-source agent libraries."), True, None),
    ("Grace", "Lin", "FineTune Labs", "ML Engineer", "she/her",
     ("Grace builds the fine-tuning pipelines behind FineTune Labs' product and "
     "co-teaches its hands-on workshops."), True, 6),
    ("Tomas", "Novak", "ToolChain", "Solutions Architect", "he/him",
     ("Tomas helps enterprise teams put tool-using agents into production without "
     "setting anything on fire."), True, None),
    ("Sarah", "Whitman", "TinyML Co", "Senior Engineer", "she/her",
     ("Sarah is obsessed with getting the most out of the smallest possible model "
     "and deploying it at the edge."), True, None),
    ("Raj", "Patel", "TraceStack", "Observability Lead", "he/him",
     ("Raj builds the tracing and evaluation tooling that lets teams actually debug "
     "their LLM applications in production."), True, None),
    ("Nina", "Sorensen", "SynthGen", "Data Scientist", "she/her",
     ("Nina designs synthetic-data pipelines and studies where they quietly go "
     "wrong."), False, None),
    ("Lucas", "Meyer", "Ferrous AI", "Systems Engineer", "he/him",
     ("Lucas serves models from Rust and enjoys telling people how much latency he "
     "saved doing it."), True, None),
    ("Hannah", "Cole", "Trustworthy Labs", "Director of UX", "she/her",
     ("Hannah designs AI product experiences that people can actually trust, and "
     "researches what 'trust' means when the model is wrong."), True, None),
    ("Wei", "Zhang", "StructOut", "Senior Engineer", "he/him",
     ("Wei works on structured generation and constrained decoding so that model "
     "output is valid by construction."), True, 45),
    ("Fatima", "Al-Sayed", "MultiModal Inc", "Research Scientist", "she/her",
     ("Fatima researches retrieval over images, audio and text, and how to fuse "
     "them without losing the plot."), True, None),
    ("Brad", "Sullivan", "ChainForward", "Consultant", "he/him",
     "Brad consults on emerging technology strategy.", False, None),
    ("Chloe", "Dubois", "Wordsmith AI", "Prompt Engineer", "she/her",
     ("Chloe crafts prompts for a living and has thoughts about where the craft is "
     "headed."), False, None),
]


def headshot_path(first: str, last: str) -> str:
    """Web path of a seeded speaker's headshot.

    The images are static assets committed under `web/public/speakers/`, served
    from the app origin, so the demo has no third-party avatar dependency. A
    missing file is a legitimate state, not a break: every surface that renders
    a speaker falls back to the gradient-plus-initials tile.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", f"{first} {last}".lower()).strip("-")
    return f"/speakers/{slug}.jpg"


def build_contacts() -> list[dict]:
    rows: list[dict] = []
    for idx, (first, last, company, title, pronouns, bio, photo, portal_h) in enumerate(
        _CONTACT_SPEC, start=1
    ):
        email = f"{first.lower()}.{last.lower().replace(' ', '')}@example.com"
        row = {
            "id": _contact_id(idx),
            "org_id": ORG,
            "event_id": EVENT,
            "email": email,
            "first_name": first,
            "last_name": last,
            "company_name": company,
            "title": title,
            "about": bio,
            "pronouns": pronouns,
            "linkedin_url": f"https://www.linkedin.com/in/{first.lower()}-{last.lower().replace(' ', '')}",
            "custom_fields": {"_demo": True},
        }
        if photo:
            row["photo_url"] = headshot_path(first, last)
        if portal_h is not None:
            row["last_portal_access_at"] = _ago(hours=portal_h)
        rows.append(row)
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# SESSIONS
# ═══════════════════════════════════════════════════════════════════════════
# Each spec: key, title, html abstract, status, track, format, is_abstract,
# submitter contact index, submitted_ago_days, optional schedule (room, s, e),
# and a takeaways/prior-talk pair for form_answers realism.
def _p(*paras: str) -> str:
    return "".join(f"<p>{para}</p>" for para in paras)


_SESSION_SPEC = [
    # ---- ACCEPTED (9) — scheduled below ------------------------------------
    {"key": "acc1", "raw": 101, "status": "accepted", "track": TRACK_ENG, "fmt": FMT_KEYNOTE,
         "submitter": 1, "days": 40, "room": ROOM_MAIN, "start": _at(D1, "09:00"), "end": _at(D1, "09:45"),
         "title": "Scaling Frontier Models Without Scaling Your Bill",
         "abstract": _p(
             "Training a frontier model used to mean writing a very large cheque. It "
             "doesn't have to. This keynote walks through the architectural and "
             "scheduling decisions that let us cut training cost by <strong>62%</strong> "
             "while <em>improving</em> eval scores.",
             "We'll cover mixed-precision gotchas, why your GPUs are idle more than you "
             "think, and the boring operational wins that matter more than any clever "
             "kernel."),
         "takeaways": "Where training budgets actually leak, and the three changes that recover most of it.",
         "prior": "https://www.youtube.com/watch?v=demo-scaling"},
    {"key": "acc2", "raw": 102, "status": "accepted", "track": TRACK_ENG, "fmt": FMT_TALK,
         "submitter": 2, "days": 39, "room": ROOM_A, "start": _at(D1, "10:00"), "end": _at(D1, "10:30"),
         "title": "RAG in Production: Lessons From 10 Billion Queries",
         "abstract": _p(
             "Retrieval-augmented generation looks trivial in a notebook and terrifying "
             "at scale. After serving over ten billion production queries, we've learned "
             "which failure modes actually bite.",
             "Chunking strategies that survive contact with real documents, when to "
             "rerank and when it's a waste of latency, and how to keep your index fresh "
             "without melting your write path."),
         "takeaways": "A production RAG checklist you can apply the same week.",
         "prior": "https://www.youtube.com/watch?v=demo-rag"},
    {"key": "acc3", "raw": 103, "status": "accepted", "track": TRACK_RES, "fmt": FMT_TALK,
         "submitter": 3, "days": 39, "room": ROOM_B, "start": _at(D1, "10:00"), "end": _at(D1, "10:30"),
         "title": "Vector Databases Under the Hood",
         "abstract": _p(
             "Everyone uses a vector database; few know what happens inside one. We open "
             "up HNSW and IVF, show how recall and latency actually trade off, and "
             "explain why your p99 gets worse as your index grows.",
             "Expect diagrams, benchmarks, and a healthy suspicion of any vendor's "
             "recall number."),
         "takeaways": "How to reason about ANN recall/latency instead of trusting a marketing slide.",
         "prior": None},
    {"key": "acc4", "raw": 104, "status": "accepted", "track": TRACK_ENG, "fmt": FMT_WORKSHOP,
         "submitter": 4, "days": 38, "room": ROOM_A, "start": _at(D1, "11:00"), "end": _at(D1, "12:30"),
         "title": "Hands-On: Fine-Tuning Open Models for Your Domain",
         "abstract": _p(
             "Bring a laptop. In ninety minutes you'll take an open base model and adapt "
             "it to a real domain dataset using LoRA, evaluate whether it actually "
             "improved, and package it for serving.",
             "We supply the data and the GPUs; you leave with a working recipe and the "
             "judgement to know when fine-tuning is the wrong answer."),
         "takeaways": "A repeatable LoRA fine-tuning recipe and a nose for when not to use it.",
         "prior": "https://www.youtube.com/watch?v=demo-finetune"},
    {"key": "acc5", "raw": 105, "status": "accepted", "track": TRACK_RES, "fmt": FMT_LIGHTNING,
         "submitter": 5, "days": 37, "room": ROOM_MAIN, "start": _at(D1, "10:00"), "end": _at(D1, "10:15"),
         "title": "Prompt Injection: A Live Teardown",
         "abstract": _p(
             "Fifteen minutes, one live target, and every prompt-injection trick that "
             "still works in 2026. We'll exfiltrate a system prompt, hijack a tool call, "
             "and then show the mitigations that actually hold up."),
         "takeaways": "The current prompt-injection threat model and the defenses worth deploying.",
         "prior": None},
    {"key": "acc6", "raw": 106, "status": "accepted", "track": TRACK_PROD, "fmt": FMT_TALK,
         "submitter": 6, "days": 37, "room": ROOM_MAIN, "start": _at(D1, "11:00"), "end": _at(D1, "11:30"),
         "title": "Evaluating LLM Agents That Actually Ship",
         "abstract": _p(
             "Offline benchmarks say your agent is great; production says otherwise. This "
             "talk is about closing that gap: task-grounded evals, human-in-the-loop "
             "grading that scales, and the metrics that predict whether users will keep "
             "using the thing."),
         "takeaways": "An eval strategy that correlates with real product outcomes.",
         "prior": "https://www.youtube.com/watch?v=demo-evals"},
    {"key": "acc7", "raw": 107, "status": "accepted", "track": TRACK_PROD, "fmt": FMT_KEYNOTE,
         "submitter": 7, "days": 36, "room": ROOM_MAIN, "start": _at(D2, "09:00"), "end": _at(D2, "09:45"),
         "title": "The Agentic Future Is Boring (And That's Good)",
         "abstract": _p(
             "The most valuable AI agents won't be autonomous wizards; they'll be "
             "dependable coworkers doing narrow jobs extremely well. A keynote in praise "
             "of scope, guardrails, and the unglamorous engineering that makes agents "
             "trustworthy enough to deploy."),
         "takeaways": "Why narrow, boring agents beat ambitious ones in the real world.",
         "prior": None},
    {"key": "acc8", "raw": 108, "status": "accepted", "track": TRACK_RES, "fmt": FMT_TALK,
         "submitter": 8, "days": 36, "room": ROOM_A, "start": _at(D2, "10:00"), "end": _at(D2, "10:30"),
         "title": "Multimodal Models at Scale: Text, Image, and Beyond",
         "abstract": _p(
             "Serving a model that reads text and images at production scale is a "
             "different sport from serving a text-only one. We cover tokenization of "
             "pixels, cache design when half your context is an image, and the batching "
             "tricks that keep the GPUs busy."),
         "takeaways": "Concrete serving patterns for multimodal inference at scale.",
         "prior": "https://www.youtube.com/watch?v=demo-multimodal"},
    {"key": "acc9", "raw": 109, "status": "accepted", "track": TRACK_ENG, "fmt": FMT_WORKSHOP,
         "submitter": 9, "days": 35, "room": ROOM_B, "start": _at(D2, "10:00"), "end": _at(D2, "11:30"),
         "title": "Hands-On: Building Tool-Using Agents",
         "abstract": _p(
             "A ninety-minute build: start from an empty file and finish with an agent "
             "that plans, calls real tools, recovers from tool errors, and knows when to "
             "stop. We'll wire up function calling, add retries and timeouts, and stress "
             "the whole thing until it breaks."),
         "takeaways": "A working, resilient tool-using agent and the patterns behind it.",
         "prior": None},
    # ---- PENDING (5) --------------------------------------------------------
    {"key": "pen1", "raw": 110, "status": "pending", "track": TRACK_ENG, "fmt": FMT_TALK,
         "submitter": 12, "days": 8,
         "title": "Small Models, Big Wins: The Case for 3B Parameters",
         "abstract": _p(
             "Not every problem needs a 400B-parameter model. We show how a carefully "
             "tuned 3B model, quantized and run at the edge, beats a giant API on cost, "
             "latency, and privacy for a surprising range of tasks."),
         "takeaways": "A decision framework for when small-and-local wins.",
         "prior": None},
    {"key": "pen2", "raw": 111, "status": "pending", "track": TRACK_PROD, "fmt": FMT_TALK,
         "submitter": 13, "days": 7,
         "title": "Observability for LLM Applications",
         "abstract": _p(
             "You can't fix what you can't see. This talk covers tracing prompts and "
             "tool calls end to end, capturing the inputs that caused a bad output, and "
             "turning that firehose into dashboards a human can act on."),
         "takeaways": "A practical LLM observability stack you can adopt incrementally.",
         "prior": "https://www.youtube.com/watch?v=demo-observability"},
    {"key": "pen3", "raw": 112, "status": "pending", "track": TRACK_RES, "fmt": FMT_TALK,
         "submitter": 14, "days": 6,
         "title": "Synthetic Data Pipelines That Don't Lie",
         "abstract": _p(
             "Synthetic data can save your project or quietly poison it. We walk through "
             "generating training data with LLMs, the distribution-shift traps that hide "
             "in it, and the validation gates that catch a bad batch before it ships."),
         "takeaways": "How to trust — and verify — synthetic training data.",
         "prior": None},
    {"key": "pen4", "raw": 113, "status": "pending", "track": TRACK_ENG, "fmt": FMT_TALK,
         "submitter": 15, "days": 5,
         "title": "From Notebook to Nginx: Serving Models in Rust",
         "abstract": _p(
             "A tour of moving an inference service from a comfortable Python notebook to "
             "a lean Rust server, and the latency and memory wins that follow. Includes "
             "the parts that hurt."),
         "takeaways": "When rewriting your serving layer in Rust pays for itself.",
         "prior": None},
    {"key": "pen5", "raw": 114, "status": "pending", "track": TRACK_PROD, "fmt": FMT_TALK,
         "submitter": 16, "days": 4,
         "title": "Designing Trustworthy AI Product Experiences",
         "abstract": _p(
             "Users forgive a wrong answer; they don't forgive being misled about "
             "confidence. This talk is about interface patterns — citations, uncertainty, "
             "graceful failure — that build durable trust in AI features."),
         "takeaways": "A pattern library for honest, trustworthy AI UX.",
         "prior": "https://www.youtube.com/watch?v=demo-trust"},
    # ---- ACCEPT QUEUE (2) ---------------------------------------------------
    {"key": "aq1", "raw": 115, "status": "accept_queue", "track": TRACK_ENG, "fmt": FMT_TALK,
         "submitter": 17, "days": 9,
         "title": "Guardrails: Structured Outputs Without the Pain",
         "abstract": _p(
             "Constrained decoding and schema-guided generation, explained by someone who "
             "ships it. Get valid JSON every time without regex duct tape, and understand "
             "the latency cost of each approach."),
         "takeaways": "Reliable structured output, and what each method costs you.",
         "prior": None},
    {"key": "aq2", "raw": 116, "status": "accept_queue", "track": TRACK_RES, "fmt": FMT_TALK,
         "submitter": 18, "days": 9,
         "title": "Retrieval Beyond Text: Multimodal RAG",
         "abstract": _p(
             "What happens when the thing you want to retrieve is an image, a chart, or a "
             "slice of audio? We extend RAG to multiple modalities and confront the "
             "embedding-alignment problem head on."),
         "takeaways": "How to build retrieval that spans modalities without losing recall.",
         "prior": None},
    # ---- DECLINE QUEUE / DECLINED (2) --------------------------------------
    {"key": "dq1", "raw": 117, "status": "decline_queue", "track": TRACK_PROD, "fmt": FMT_TALK,
         "submitter": 19, "days": 10,
         "title": "Blockchain Meets LLMs: A New Paradigm",
         "abstract": _p(
             "A proposal to anchor model outputs on-chain for provenance and to "
             "incentivize inference with a token. Explores a decentralized marketplace "
             "for prompts and completions."),
         "takeaways": "A vision for tokenized, on-chain AI provenance.",
         "prior": None},
    {"key": "dd1", "raw": 118, "status": "declined", "track": TRACK_PROD, "fmt": FMT_LIGHTNING,
         "submitter": 20, "days": 11,
         "title": "Why Prompt Engineering Is Dead",
         "abstract": _p(
             "A provocative five-minute argument that hand-crafted prompts are a "
             "transitional technology and that models will soon need none of it."),
         "takeaways": "A contrarian take on the future of prompting.",
         "prior": None},
    # ---- WITHDRAWN (2) — resubmitters who pulled a second entry -------------
    {"key": "wd1", "raw": 119, "status": "withdrawn", "track": TRACK_ENG, "fmt": FMT_TALK,
         "submitter": 1, "days": 12,
         "title": "GPU Poor: Training on a Budget",
         "abstract": _p(
             "How to train useful models when you have four GPUs and a dream. Withdrawn "
             "by the speaker in favour of their keynote."),
         "takeaways": "Squeezing real results out of a tiny cluster.",
         "prior": None},
    {"key": "wd2", "raw": 120, "status": "withdrawn", "track": TRACK_RES, "fmt": FMT_TALK,
         "submitter": 5, "days": 13,
         "title": "The Ethics of Autonomous Agents",
         "abstract": _p(
             "A survey of the accountability gaps that open up when agents act without a "
             "human in the loop. Withdrawn due to a scheduling conflict."),
         "takeaways": "The open accountability questions for autonomous agents.",
         "prior": None},
]


def build_sessions() -> list[dict]:
    rows: list[dict] = []
    for idx, spec in enumerate(_SESSION_SPEC, start=1):
        answers = {
            F_ABSTRACT: spec["abstract"],
            F_TRACK: {TRACK_ENG: "Engineering", TRACK_PROD: "Product", TRACK_RES: "Research"}[spec["track"]],
            F_FORMAT: {
                FMT_KEYNOTE: "Keynote", FMT_TALK: "Talk",
                FMT_LIGHTNING: "Lightning Talk", FMT_WORKSHOP: "Workshop",
            }[spec["fmt"]],
            F_TAKEAWAYS: spec["takeaways"],
            F_SPOKEN: spec["prior"] is not None,
        }
        if spec.get("prior"):
            answers[F_PRIOR] = spec["prior"]
        row = {
            "id": _session_id(idx),
            "org_id": ORG,
            "event_id": EVENT,
            "friendly_id_raw": spec["raw"],
            "title": spec["title"],
            "description": spec["abstract"],
            "status": spec["status"],
            # Accepted talks are program sessions now; the rest are still abstracts.
            "is_abstract": spec["status"] != "accepted",
            "track_id": spec["track"],
            "format_id": spec["fmt"],
            "source_form_id": CFP_FORM,
            "form_answers": answers,
            "submitter_contact_id": _contact_id(spec["submitter"]),
            "submitted_at": _ago(days=spec["days"]),
        }
        if spec.get("room"):
            row["room_id"] = spec["room"]
            row["starts_at"] = spec["start"]
            row["ends_at"] = spec["end"]
        rows.append(row)
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# SESSION PARTICIPANTS
# ═══════════════════════════════════════════════════════════════════════════
# key -> [(contact_idx, role, is_primary)].  Priya Raman (contact 2) is the
# deliberate double-booking: primary speaker on acc2 (Workshop A) AND acc3
# (Workshop B), both Day 1 10:00–10:30 — a speaker conflict across two rooms.
_PARTICIPANTS = {
    "acc1": [(1, "submitter", False), (1, "speaker", True)],
    "acc2": [(2, "submitter", False), (2, "speaker", True)],
    "acc3": [(3, "submitter", False), (2, "speaker", True), (3, "speaker", False)],
    "acc4": [(4, "submitter", False), (4, "speaker", True), (10, "speaker", False)],
    "acc5": [(5, "submitter", False), (5, "speaker", True)],
    "acc6": [(6, "submitter", False), (6, "speaker", True)],
    "acc7": [(7, "submitter", False), (7, "speaker", True)],
    "acc8": [(8, "submitter", False), (8, "speaker", True)],
    "acc9": [(9, "submitter", False), (9, "speaker", True), (11, "speaker", False)],
    "pen1": [(12, "submitter", False), (12, "speaker", True)],
    "pen2": [(13, "submitter", False), (13, "speaker", True)],
    "pen3": [(14, "submitter", False), (14, "speaker", True)],
    "pen4": [(15, "submitter", False), (15, "speaker", True)],
    "pen5": [(16, "submitter", False), (16, "speaker", True)],
    "aq1": [(17, "submitter", False), (17, "speaker", True)],
    "aq2": [(18, "submitter", False), (18, "speaker", True)],
    "dq1": [(19, "submitter", False), (19, "speaker", True)],
    "dd1": [(20, "submitter", False), (20, "speaker", True)],
    "wd1": [(1, "submitter", False), (1, "speaker", True)],
    "wd2": [(5, "submitter", False), (5, "speaker", True)],
}


def build_participants() -> list[dict]:
    key_to_id = {spec["key"]: _session_id(i) for i, spec in enumerate(_SESSION_SPEC, start=1)}
    rows: list[dict] = []
    for key, people in _PARTICIPANTS.items():
        for contact_idx, role, primary in people:
            rows.append({
                "org_id": ORG,
                "session_id": key_to_id[key],
                "contact_id": _contact_id(contact_idx),
                "role": role,
                "is_primary": primary,
            })
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# PORTAL + TASKS + TASK ASSIGNMENTS
# ═══════════════════════════════════════════════════════════════════════════
def build_portal() -> dict:
    return {
        "id": PORTAL_ID,
        "org_id": ORG,
        "event_id": EVENT,
        "name": "Speakers",
        "welcome_html": (
            "<h2>Welcome, speaker!</h2><p>Everything you need to get ready for "
            "<strong>AI Builders Summit 2026</strong> lives here — confirm your "
            "details, upload your headshot and slides, and check off your onboarding "
            "tasks below.</p>"
        ),
        "accent_color": "#4F46E5",
    }


# One source of truth with acceptance provisioning. Deadlines stay demo-only:
# they make the onboarding dashboard useful without changing canonical policy.
_TASK_DUE_DAYS = (10, 12, 14, 16, 18, 20)


def build_tasks() -> list[dict]:
    rows: list[dict] = []
    for i, (task, due) in enumerate(zip(CANONICAL_TASKS, _TASK_DUE_DAYS), start=1):
        rows.append({
            "id": _task_id(i),
            "org_id": ORG,
            "event_id": EVENT,
            "portal_id": PORTAL_ID,
            "kind": task["kind"],
            "name": task["name"],
            "description": task["description"],
            "link_url": task["link_url"],
            "required": True,
            "due_at": _ahead(days=due),
            "order": i,
        })
    return rows


# contact_idx -> [(task_idx, status)].  Statuses: todo/submitted/approved/denied/done.
# approved+done count as finished; a contact with a portal visit AND zero
# outstanding assignments reads as onboarding-complete on the dashboard.
# NOTE: the ONBOARDED contacts must have ALL 6 canonical tasks finished — the
# accept flow auto-provisions every canonical task, and a single leftover to-do
# would drop them out of "onboarded". So they list all of tasks 1..6.
_TASK_ASSIGNMENTS = {
    1: [(1, "done"), (2, "approved"), (3, "done"), (4, "approved"), (5, "done"), (6, "approved")],   # portal ✓ -> ONBOARDED
    4: [(1, "done"), (2, "done"), (3, "done"), (4, "done"), (5, "done"), (6, "done")],               # portal ✓ -> ONBOARDED
    10: [(1, "approved"), (2, "approved"), (3, "approved"), (4, "approved"), (5, "approved"), (6, "approved")],  # portal ✓ -> ONBOARDED
    2: [(1, "done"), (2, "todo"), (3, "todo"), (4, "submitted")],      # portal ✓, 3 outstanding
    3: [(1, "submitted"), (3, "todo")],                                # portal ✓, 2 outstanding
    6: [(1, "done"), (2, "todo")],                                     # portal ✓, 1 outstanding
    8: [(4, "denied"), (1, "todo")],                                   # portal ✓, 2 outstanding
    5: [(1, "done"), (2, "done")],                                     # no portal -> not complete
    7: [(1, "todo"), (3, "todo")],                                     # no portal, 2 outstanding
    9: [(1, "todo")],                                                  # no portal, 1 outstanding
    11: [(5, "todo"), (6, "todo")],                                    # no portal, 2 outstanding
}


def build_task_assignments() -> list[dict]:
    rows: list[dict] = []
    for contact_idx, items in _TASK_ASSIGNMENTS.items():
        for task_idx, status in items:
            row = {
                "org_id": ORG,
                "task_id": _task_id(task_idx),
                "contact_id": _contact_id(contact_idx),
                "status": status,
            }
            if status in ("done", "approved"):
                row["completed_at"] = _ago(days=1)
            rows.append(row)
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# EVALUATION PLAN + EVALUATORS + ASSIGNMENTS + REVIEWS
# ═══════════════════════════════════════════════════════════════════════════
CRITERIA = [
    {"name": "Relevance", "weight": 40},
    {"name": "Originality", "weight": 30},
    {"name": "Speaker", "weight": 20},
    {"name": "Clarity", "weight": 10},
]
_CRIT_NAMES = ["Relevance", "Originality", "Speaker", "Clarity"]


def build_plan() -> dict:
    return {
        "id": PLAN_ID,
        "org_id": ORG,
        "event_id": EVENT,
        "name": "Program Committee Review",
        "instructions": (
            "Score each submission on the four criteria using the 1–5 scale. Favour "
            "talks that are relevant to a builder audience, teach something new, and "
            "are led by a speaker who can deliver. Abstain if you have a conflict of "
            "interest."
        ),
        "anonymized": False,
        "scale": "1_5",
        "criteria": CRITERIA,
        "status": "open",
        "session_filter": {},
    }


_EVALUATORS = [
    (1, "Dr. Nadia Feldman", "nadia.feldman@example.com"),
    (2, "Marcus Bell", "marcus.bell@example.com"),
    (3, "Sofia Ortega", "sofia.ortega@example.com"),
]


def build_evaluators() -> list[dict]:
    return [
        {
            "id": _evaluator_id(i),
            "org_id": ORG,
            "plan_id": PLAN_ID,
            "email": email,
            "name": name,
            "invited_at": _ago(days=6),
            "last_active_at": _ago(days=1, hours=i),
        }
        for i, name, email in _EVALUATORS
    ]


# Sessions under review: all pending + accept_queue + three accepted.
_EVAL_SESSION_KEYS = ["pen1", "pen2", "pen3", "pen4", "pen5", "aq1", "aq2", "acc1", "acc2", "acc6"]

# (session_key, evaluator_idx) -> review directive.
#   tuple (R,O,S,C)            = completed, scored
#   ("draft", (R,O,S,C))       = in-progress draft
#   ("abstain", reason)        = submitted abstention
# Absent pairs are assignments with no review yet (still pending).
_REVIEWS = {
    ("pen1", 1): ((5, 5, 5, 4), "Exactly the kind of practical, cost-focused talk our audience needs."),
    ("pen1", 2): ((5, 4, 5, 5), "Clear framing, strong speaker. Easy yes."),
    ("pen1", 3): ((4, 5, 4, 5), None),
    ("pen2", 1): ((2, 2, 3, 2), "Feels like a solved problem — not much new here."),
    ("pen2", 2): ((5, 5, 4, 5), "Strongly disagree with the low score; this is a gap in most stacks."),
    ("pen2", 3): ("draft", (3, 3, 3, 3)),
    ("pen3", 1): ((3, 3, 3, 3), None),
    ("pen3", 2): ((4, 3, 3, 4), "Solid, if a little narrow."),
    ("pen4", 1): ((4, 4, 4, 4), "Good engineering talk; would attend."),
    ("pen4", 3): ("abstain", "I advise this speaker's company and shouldn't score it."),
    ("pen5", 2): ((3, 4, 3, 3), None),
    ("aq1", 1): ((5, 4, 4, 4), "Structured output is a perennial pain point — great fit."),
    ("aq1", 3): ((4, 4, 5, 4), None),
    ("aq2", 2): ("abstain", "Conflict of interest — former colleague."),
    ("aq2", 3): ("draft", (4, 4, 4, 4)),
    ("acc1", 1): ((4, 5, 4, 5), "Keynote-worthy. The cost numbers are compelling."),
    ("acc1", 2): ((5, 5, 5, 4), None),
    ("acc2", 3): ((3, 2, 3, 2), "Useful but covers well-trodden ground."),
}


def _weighted(scores4: tuple) -> float:
    total = sum(s * c["weight"] for s, c in zip(scores4, CRITERIA))
    return round(total / 100.0, 2)


def build_assignments_and_reviews() -> tuple[list[dict], list[dict]]:
    key_to_sid = {spec["key"]: _session_id(i) for i, spec in enumerate(_SESSION_SPEC, start=1)}
    assignments: list[dict] = []
    reviews: list[dict] = []
    a_index = 0
    r_index = 0
    for skey in _EVAL_SESSION_KEYS:
        for ev in (1, 2, 3):
            a_index += 1
            aid = _assignment_id(a_index)
            assignments.append({
                "id": aid,
                "org_id": ORG,
                "plan_id": PLAN_ID,
                "evaluator_id": _evaluator_id(ev),
                "session_id": key_to_sid[skey],
            })
            directive = _REVIEWS.get((skey, ev))
            if directive is None:
                continue
            r_index += 1
            rid = _review_id(r_index)
            started = _ago(days=4, hours=r_index)
            updated = _ago(days=1, hours=r_index)
            if isinstance(directive, tuple) and directive and directive[0] == "abstain":
                reviews.append({
                    "id": rid, "org_id": ORG, "assignment_id": aid,
                    "scores": {}, "overall": None, "comment": None,
                    "abstained": True, "abstain_reason": directive[1],
                    "is_draft": False, "started_at": started, "updated_at": updated,
                    "submitted_at": updated,
                })
            elif isinstance(directive, tuple) and directive and directive[0] == "draft":
                s4 = directive[1]
                reviews.append({
                    "id": rid, "org_id": ORG, "assignment_id": aid,
                    "scores": dict(zip(_CRIT_NAMES, s4)), "overall": _weighted(s4),
                    "comment": None, "abstained": False, "abstain_reason": None,
                    "is_draft": True, "started_at": started, "updated_at": updated,
                    "submitted_at": None,
                })
            else:
                # completed, scored — directive is (scores4, comment_or_none)
                s4, comment = directive
                reviews.append({
                    "id": rid, "org_id": ORG, "assignment_id": aid,
                    "scores": dict(zip(_CRIT_NAMES, s4)), "overall": _weighted(s4),
                    "comment": comment, "abstained": False, "abstain_reason": None,
                    "is_draft": False, "started_at": started, "updated_at": updated,
                    "submitted_at": updated,
                })
    return assignments, reviews


# ═══════════════════════════════════════════════════════════════════════════
# COMMS: templates + outbox
# ═══════════════════════════════════════════════════════════════════════════
def build_email_templates() -> list[dict]:
    return [
        {
            "id": _template_id(1), "org_id": ORG, "event_id": EVENT, "key": "accept",
            "subject": "Your talk was accepted for AI Builders Summit 2026",
            "body_html": (
                "<p>Congratulations! Your session <strong>{{session_title}}</strong> has "
                "been accepted for AI Builders Summit 2026.</p><p>We'll follow up shortly "
                "with scheduling and your speaker portal.</p>"
            ),
        },
        {
            "id": _template_id(2), "org_id": ORG, "event_id": EVENT, "key": "decline",
            "subject": "An update on your AI Builders Summit submission",
            "body_html": (
                "<p>Thank you for submitting <strong>{{session_title}}</strong>. We had an "
                "exceptional set of proposals this year and, unfortunately, could not fit "
                "yours into the program. We hope you'll submit again next year.</p>"
            ),
        },
        {
            "id": _template_id(3), "org_id": ORG, "event_id": EVENT, "key": "portal_invite",
            "subject": "[AI Builders Summit 2026] Your speaker portal",
            "body_html": (
                "<p>You're speaking at AI Builders Summit 2026! Your speaker portal is "
                "where you confirm details, upload your headshot and slides, and check off "
                "onboarding tasks.</p><p><a href=\"#\">Open your portal</a></p>"
            ),
        },
    ]


# (outbox idx, contact idx, template_key, sent_ago_days, subject)
_OUTBOX = [
    (1, 1, "portal_invite", 5, "[AI Builders Summit 2026] Your speaker portal"),
    (2, 2, "accept", 3, "Your talk was accepted for AI Builders Summit 2026"),
    (3, 4, "portal_invite", 4, "[AI Builders Summit 2026] Your speaker portal"),
    (4, 6, "accept", 2, "Your talk was accepted for AI Builders Summit 2026"),
    (5, 19, "decline", 1, "An update on your AI Builders Summit submission"),
]


def build_outbox() -> list[dict]:
    rows: list[dict] = []
    for i, contact_idx, key, days, subject in _OUTBOX:
        rows.append({
            "id": _outbox_id(i),
            "org_id": ORG,
            "event_id": EVENT,
            "contact_id": _contact_id(contact_idx),
            "template_key": key,
            "payload": {"subject": subject, "to": f"speaker{contact_idx}@example.com"},
            "dedupe_key": f"demo-outbox-{i}",
            "status": "sent",
            "sent_at": _ago(days=days),
            "send_after": _ago(days=days),
            "created_at": _ago(days=days, hours=1),
        })
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# COLLECTED CONTENT (files behind the delivered onboarding items)
# ═══════════════════════════════════════════════════════════════════════════
# A task_assignment status is a CLAIM ("we have their headshot"); the files row
# is the evidence. Seeding the claim without the evidence produced a content
# library that said "Received" over a detail panel reading "Nothing uploaded
# yet" — so every delivered item below gets a real object in the bucket, a real
# files row, and the assignment pointer that makes it current.
#
# contact_idx -> how many versions that speaker uploaded of task 4's headshot.
# Two versions on one of them so version history / restore has something to show.
CONTENT_TASK_IDX = 4  # "Finalize bio/photos" — the one file_request task
_CONTENT_FILES = {1: 1, 2: 1, 4: 2, 8: 1, 10: 1}
# Tint per speaker so the seeded headshots are visibly different files.
_CONTENT_TINTS = {1: (74, 98, 226), 2: (16, 152, 118), 4: (206, 96, 54), 8: (140, 84, 196), 10: (35, 130, 190)}


def _png(rgb: tuple[int, int, int], size: int = 240) -> bytes:
    """A small solid-colour PNG — a stand-in headshot with real image bytes.

    Written by hand (zlib + struct) so the seeder needs no image dependency and
    the bytes still pass the upload validator's magic-byte sniff.
    """
    import struct
    import zlib

    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def seed_content_files(namespace: str | None = None) -> int:
    """Give every delivered content item a real file, version history and pointer.

    Idempotent: an assignment that already has files is left alone, and the
    storage upload upserts, so re-running never duplicates a version.
    """
    scoped_org = org_id(namespace)
    scoped_event = remap(EVENT, namespace)
    task_id = remap(_task_id(CONTENT_TASK_IDX), namespace)
    assignments = (
        supabase.table("task_assignments")
        .select("id, contact_id, status, file_id")
        .eq("org_id", scoped_org)
        .eq("task_id", task_id)
        .execute()
        .data
        or []
    )
    by_contact = {a.get("contact_id"): a for a in assignments}

    written = 0
    for contact_idx, version_count in _CONTENT_FILES.items():
        contact_id = remap(_contact_id(contact_idx), namespace)
        assignment = by_contact.get(contact_id)
        if not assignment:
            continue
        existing = (
            supabase.table("files")
            .select("id")
            .eq("org_id", scoped_org)
            .eq("task_assignment_id", assignment["id"])
            .execute()
            .data
            or []
        )
        if existing:
            continue

        current_id = None
        for version in range(1, version_count + 1):
            path = f"{scoped_org}/{contact_id}/demo-headshot-v{version}.png"
            data = _png(_CONTENT_TINTS.get(contact_idx, (90, 90, 110)))
            supabase.storage.from_("portal-files").upload(
                path, data, {"content-type": "image/png", "upsert": "true"}
            )
            row = (
                supabase.table("files")
                .insert(
                    {
                        "org_id": scoped_org,
                        "event_id": scoped_event,
                        "contact_id": contact_id,
                        "task_assignment_id": assignment["id"],
                        "bucket_path": path,
                        "filename": f"headshot-v{version}.png",
                        "mimetype": "image/png",
                        "size": len(data),
                        "version": version,
                        "created_at": _ago(days=version_count - version + 2),
                    }
                )
                .execute()
                .data
            )
            if row:
                current_id = row[0]["id"]
                written += 1

        if current_id:
            supabase.table("task_assignments").update({"file_id": current_id}).eq(
                "id", assignment["id"]
            ).eq("org_id", scoped_org).execute()

        # The denied item is only a story if the speaker can read WHY.
        if assignment.get("status") == "denied":
            supabase.table("content_comments").insert(
                {
                    "org_id": scoped_org,
                    "event_id": scoped_event,
                    "task_assignment_id": assignment["id"],
                    "contact_id": contact_id,
                    "author_role": "organizer",
                    "author_label": "Organizer",
                    "body": (
                        "Thanks! This one is a little low-res for the printed program — "
                        "could you send a version at least 1200px wide?"
                    ),
                    "created_at": _ago(days=1),
                }
            ).execute()
    return written


# ═══════════════════════════════════════════════════════════════════════════
# RESET / SEED
# ═══════════════════════════════════════════════════════════════════════════
_ALL_CONTACT_IDS = [_contact_id(i) for i in range(1, len(_CONTACT_SPEC) + 1)]
_ALL_SESSION_IDS = [_session_id(i) for i in range(1, len(_SESSION_SPEC) + 1)]
_ALL_TASK_IDS = [_task_id(i) for i in range(1, len(CANONICAL_TASKS) + 1)]
_ALL_TEMPLATE_IDS = [_template_id(i) for i in range(1, 4)]
_ALL_OUTBOX_IDS = [_outbox_id(i) for i in range(1, len(_OUTBOX) + 1)]


def _build_prerequisites(namespace: str) -> list[tuple[str, list[dict]]]:
    """Clone the structural rows that migration 002 provides for ``org_dev``."""
    rows: list[tuple[str, list[dict]]] = [
        ("orgs", [{"org_id": ORG, "name": "Dais Dev Org"}]),
        (
            "events",
            [
                {
                    "id": EVENT,
                    "org_id": ORG,
                    "name": "AI Builders Summit 2026",
                    "slug": event_slug(namespace),
                    "starts_at": "2026-10-12 08:00-07",
                    "ends_at": "2026-10-13 18:00-07",
                    "timezone": "America/Los_Angeles",
                    "location": "San Francisco, CA",
                }
            ],
        ),
        (
            "tracks",
            [
                {
                    "id": TRACK_ENG,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Engineering",
                    "color": "#4F46E5",
                    "order": 0,
                },
                {
                    "id": TRACK_PROD,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Product",
                    "color": "#0EA5E9",
                    "order": 1,
                },
                {
                    "id": TRACK_RES,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Research",
                    "color": "#10B981",
                    "order": 2,
                },
            ],
        ),
        (
            "rooms",
            [
                {
                    "id": ROOM_MAIN,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Main Stage",
                    "order": 0,
                    "capacity": 400,
                },
                {
                    "id": ROOM_A,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Workshop A",
                    "order": 1,
                    "capacity": 80,
                },
                {
                    "id": ROOM_B,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Workshop B",
                    "order": 2,
                    "capacity": 80,
                },
            ],
        ),
        (
            "formats",
            [
                {
                    "id": FMT_KEYNOTE,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Keynote",
                    "default_duration_min": 45,
                },
                {
                    "id": FMT_TALK,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Talk",
                    "default_duration_min": 30,
                },
                {
                    "id": FMT_LIGHTNING,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Lightning Talk",
                    "default_duration_min": 15,
                },
                {
                    "id": FMT_WORKSHOP,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "name": "Workshop",
                    "default_duration_min": 90,
                },
            ],
        ),
        (
            "fields",
            [
                {
                    "id": F_ABSTRACT,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "session",
                    "internal_name": "abstract",
                    "public_name": "Abstract",
                    "field_type": "textarea",
                    "options": {
                        "max_length": 2000,
                        "help": "One paragraph. What will the audience learn?",
                    },
                    "required": True,
                },
                {
                    "id": F_TRACK,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "session",
                    "internal_name": "track_choice",
                    "public_name": "Track",
                    "field_type": "dropdown",
                    "options": {"choices": ["Engineering", "Product", "Research"]},
                    "required": True,
                },
                {
                    "id": F_FORMAT,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "session",
                    "internal_name": "format_choice",
                    "public_name": "Session format",
                    "field_type": "dropdown",
                    "options": {
                        "choices": ["Keynote", "Talk", "Lightning Talk", "Workshop"]
                    },
                    "required": True,
                },
                {
                    "id": F_TAKEAWAYS,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "session",
                    "internal_name": "takeaways",
                    "public_name": "Key takeaways",
                    "field_type": "textarea",
                    "options": {
                        "max_length": 1000,
                        "help": "3-5 bullets the attendee leaves with.",
                    },
                    "required": False,
                },
                {
                    "id": F_BIO,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "contact",
                    "internal_name": "speaker_bio",
                    "public_name": "Speaker bio",
                    "field_type": "textarea",
                    "options": {"max_length": 1500},
                    "required": True,
                },
                {
                    "id": F_PRIOR,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "session",
                    "internal_name": "prior_talk",
                    "public_name": "Link to a prior talk recording",
                    "field_type": "url",
                    "options": {"help": "Only shown if you have spoken before."},
                    "required": False,
                },
                {
                    "id": F_SPOKEN,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "scope": "session",
                    "internal_name": "spoken_before",
                    "public_name": "Have you spoken at a conference before?",
                    "field_type": "checkbox",
                    "options": {},
                    "required": False,
                },
            ],
        ),
        (
            "forms",
            [
                {
                    "id": CFP_FORM,
                    "org_id": ORG,
                    "event_id": EVENT,
                    "slug": form_slug(namespace),
                    "name": "Call for Speakers",
                    "kind": "cfp",
                    "welcome_html": (
                        "<h2>Welcome to the AI Builders Summit CFP!</h2><p>Sessions for "
                        "our agenda will be selected from these submissions. Submissions "
                        "close soon — we can't wait to read yours.</p>"
                    ),
                    "settings": {"submission_limit": 3, "max_speakers": 6},
                }
            ],
        ),
        (
            "form_fields",
            [
                {
                    "org_id": ORG,
                    "form_id": CFP_FORM,
                    "field_id": field_id,
                    "page": 3,
                    "order": order,
                    "required": required,
                }
                for field_id, order, required in (
                    (F_ABSTRACT, 0, True),
                    (F_TRACK, 1, True),
                    (F_FORMAT, 2, True),
                    (F_TAKEAWAYS, 3, False),
                    (F_SPOKEN, 4, False),
                    (F_PRIOR, 5, False),
                )
            ],
        ),
        (
            "question_rules",
            [
                {
                    "id": QUESTION_RULE,
                    "org_id": ORG,
                    "form_id": CFP_FORM,
                    "target_field_id": F_PRIOR,
                    "logic": {
                        "when": [{"field": F_SPOKEN, "op": "eq", "value": True}],
                        "match": "all",
                        "action": "show",
                    },
                }
            ],
        ),
    ]
    return [(table, _scope_rows(table_rows, namespace)) for table, table_rows in rows]


def _bootstrap_namespace(namespace: str) -> None:
    for table, rows in _build_prerequisites(namespace):
        _insert(table, rows)


def reset(namespace: str | None = None) -> None:
    """Delete only demo-seeded rows, in FK-safe order. Never touches the event,
    its rooms/tracks/formats/fields/CFP form, or any non-demo rows.

    A namespaced org is itself disposable, so its structural prerequisites and
    org row are removed after the same child-first cleanup.
    """
    t = supabase.table
    scoped_org = org_id(namespace)
    scoped_event = remap(EVENT, namespace)
    scoped_session_ids = [remap(value, namespace) for value in _ALL_SESSION_IDS]

    # org_dev is exclusively the demo org, so a clean reset clears ALL of its
    # rows (including anything created by live demo usage — decisions,
    # invites, portal edits, extra submissions) by org_id, in FK-safe order
    # (children before parents). Structural rows are preserved because they
    # live in the tables we deliberately DON'T touch below (events, rooms,
    # tracks, formats, levels, tags, fields, forms, form_fields,
    # question_rules, routing_rules).
    for table in (
        "content_comments",    # -> task_assignments, contacts
        "files",               # -> contacts, sessions, task_assignments
    ):
        t(table).delete().eq("org_id", scoped_org).execute()

    if namespace is not None:
        t("resource_pages").delete().eq("org_id", scoped_org).execute()
    for table in (
        "reviews",             # -> assignments
        "assignments",         # -> plan, session
        "evaluators",          # -> plan
        "evaluation_plans",
        "task_assignments",    # -> tasks, contacts
        "calendar_invites",    # -> sessions, contacts
        "magic_link_tokens",   # -> contacts
        "email_outbox",        # -> contacts
        "tasks",               # -> sessions, portals
        "portals",
        "session_participants",  # -> sessions, contacts
        "session_tracks",        # -> sessions, tracks (migration 004)
    ):
        t(table).delete().eq("org_id", scoped_org).execute()

    # session_tags has no org_id column — scope by the seeded session ids.
    t("session_tags").delete().in_("session_id", scoped_session_ids).execute()

    # parents last
    t("sessions").delete().eq("org_id", scoped_org).execute()
    t("email_templates").delete().eq("org_id", scoped_org).execute()
    t("contacts").delete().eq("org_id", scoped_org).execute()

    if namespace is not None:
        # Replicas are disposable workspaces, including structural or live-test
        # data accumulated beneath the org since it was seeded.
        for table in (
            "directory_notes",
            "directory_stage_history",
            "directory_segments",
            "directory_custom_fields",
            "directory_people",
            "routing_rules",
            "question_rules",
            "form_fields",
            "api_tokens",
            "events_log",
        ):
            t(table).delete().eq("org_id", scoped_org).execute()

        t("friendly_id_counters").delete().eq("event_id", scoped_event).execute()
        for table in ("forms", "fields", "levels", "tags", "rooms", "tracks", "formats"):
            t(table).delete().eq("org_id", scoped_org).execute()
        t("events").delete().eq("org_id", scoped_org).execute()
        t("org_memberships").delete().eq("org_id", scoped_org).execute()
        t("orgs").delete().eq("org_id", scoped_org).execute()
        print(f"reset: demo rows deleted for {scoped_org}")
    else:
        print("reset: demo rows deleted")


def _insert(table: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    supabase.table(table).insert(rows).execute()
    return len(rows)


async def _provision_accepted_speakers(namespace: str | None = None) -> int:
    """Fill missing canonical assignments without disturbing seeded progress."""
    created = 0
    for index, spec in enumerate(_SESSION_SPEC, start=1):
        if spec["status"] == "accepted":
            created += await provision_speaker_onboarding(
                org_id(namespace),
                remap(EVENT, namespace),
                remap(_session_id(index), namespace),
            )
    return created


def seed(namespace: str | None = None) -> dict:
    """Idempotent: reset, then insert the full demo dataset."""
    reset(namespace)
    if namespace is not None:
        _bootstrap_namespace(namespace)
    counts: dict[str, int] = {}

    counts["contacts"] = _insert("contacts", _scope_rows(build_contacts(), namespace))
    counts["sessions"] = _insert("sessions", _scope_rows(build_sessions(), namespace))
    counts["session_participants"] = _insert(
        "session_participants", _scope_rows(build_participants(), namespace)
    )
    counts["portals"] = _insert("portals", _scope_rows([build_portal()], namespace))
    counts["tasks"] = _insert("tasks", _scope_rows(build_tasks(), namespace))
    counts["task_assignments"] = _insert(
        "task_assignments", _scope_rows(build_task_assignments(), namespace)
    )
    counts["task_assignments"] += asyncio.run(_provision_accepted_speakers(namespace))
    counts["files"] = seed_content_files(namespace)
    counts["evaluation_plans"] = _insert(
        "evaluation_plans", _scope_rows([build_plan()], namespace)
    )
    counts["evaluators"] = _insert(
        "evaluators", _scope_rows(build_evaluators(), namespace)
    )
    assignments, reviews = build_assignments_and_reviews()
    counts["assignments"] = _insert("assignments", _scope_rows(assignments, namespace))
    counts["reviews"] = _insert("reviews", _scope_rows(reviews, namespace))
    counts["email_templates"] = _insert(
        "email_templates", _scope_rows(build_email_templates(), namespace)
    )
    counts["email_outbox"] = _insert(
        "email_outbox", _scope_rows(build_outbox(), namespace)
    )

    print("seed: inserted")
    for table, n in counts.items():
        print(f"  {table:22s} {n}")
    if namespace is not None:
        scoped_org = org_id(namespace)
        print(f"org id: {scoped_org}")
        print(f"event slug: {event_slug(namespace)}")
        print(f"dev token: {mint_dev_token(org=scoped_org)}")
    return counts


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="seed", choices=("seed", "reset", "content"))
    parser.add_argument("--namespace", type=validate_namespace)
    args = parser.parse_args(argv[1:])

    if args.command == "reset":
        reset(args.namespace)
    elif args.command == "seed":
        seed(args.namespace)
    else:
        # Backfill just the collected files onto an already-seeded database.
        print(f"content: {seed_content_files(args.namespace)} file version(s) written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
