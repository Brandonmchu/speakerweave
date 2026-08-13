#!/usr/bin/env python3
"""Extra org_dev demo events themed on the AI Engineer conference series.

Seeds four additional events alongside the flagship AI Builders Summit so the
demo workspace reads as a real multi-event operation — the same annual calendar
the AI Engineer team (ai.engineer / Latent.Space) actually runs, each caught at
a different lifecycle stage:

    AI Engineer New York 2026    CFP open, wave-1 review underway
    AI Engineer Code Summit 2026 invite-only, agenda being scheduled
    AI Engineer Europe 2027      announced, early invited keynotes
    AI Engineer World's Fair 2027 planning, keynotes + early proposals

People are fictional (all @example.com) except the two public conference hosts,
who appear only as confirmed keynote speakers — never inside a review pipeline.

org_dev only — deliberately no namespace support, so the eval-replica seed path
(seed_demo --namespace X) is untouched.

    venv/bin/python -m scripts.seed_aie_events seed   # reset + insert (idempotent)
    venv/bin/python -m scripts.seed_aie_events reset  # delete these events only
    venv/bin/python -m scripts.seed_aie_events full   # seed_demo first, then this

Every row carries a fixed UUID beginning `eeeeeee` — a first byte outside the
replica remap range for single-letter namespaces (aa..c3) — so reset() deletes
precisely these rows and can never collide with seed_demo's identifiers.
"""

from __future__ import annotations

import argparse
import sys

from supabase_client import supabase

ORG = "org_dev"
ORG_NAME = "AI Engineer"

FLAGSHIP_EVENT = "11111111-1111-1111-1111-111111111111"  # AI Builders Summit


# ── fixed identifiers ────────────────────────────────────────────────────────
# kind: 1 event, 2 track, 3 room, 4 format, 5 contact, 6 session
def _id(kind: int, n: int) -> str:
    return f"eeeeeee{kind:x}-0000-4000-8000-{n:012d}"


def event_id(e: int) -> str:
    return _id(1, e)


def track_id(e: int, i: int) -> str:
    return _id(2, e * 100 + i)


def room_id(e: int, i: int) -> str:
    return _id(3, e * 100 + i)


def fmt_id(e: int, i: int) -> str:
    return _id(4, e * 100 + i)


def contact_id(e: int, i: int) -> str:
    return _id(5, e * 1000 + i)


def session_id(e: int, i: int) -> str:
    return _id(6, e * 1000 + i)


def _p(*paras: str) -> str:
    return "".join(f"<p>{para}</p>" for para in paras)


# ═══════════════════════════════════════════════════════════════════════════
# EVENT SPECS
# ═══════════════════════════════════════════════════════════════════════════
# Dates, cities and venues follow the published ai.engineer calendar as of
# August 2026; Europe 2027 is announced date-TBA, so its days are placeholders.
#
# contacts: (first, last, company, title, pronouns, bio)
# sessions: dicts — title, status, track (1-based), fmt (1-based),
#           speaker (contact index; also submitter), days (submitted N days
#           ago), abstract, optional co (co-speaker index), optional
#           room/start/end for scheduled slots.

EVENTS: dict[int, dict] = {
    # ── 1 · AI Engineer New York 2026 — CFP open, wave-1 review ────────────
    1: {
        "name": "AI Engineer New York 2026",
        "slug": "aie-new-york-2026",
        "starts_at": "2026-10-12 08:00-04",
        "ends_at": "2026-10-14 18:00-04",
        "timezone": "America/New_York",
        "location": "Sheraton New York Times Square, NYC",
        "branding": {"accent": "#123C7A", "heading_font": "space-grotesk"},
        "tracks": [
            ("AI in Finance", "#123C7A"),
            ("Agent Engineering", "#0E7490"),
            ("Leadership", "#92400E"),
        ],
        "rooms": [("Metropolitan Ballroom", 800), ("Empire Room", 250)],
        "formats": [
            ("Keynote", 30),
            ("Stage Talk", 20),
            ("Lightning Talk", 10),
            ("Workshop", 120),
        ],
        "contacts": [
            (
                "Imani",
                "Fletcher",
                "Ledgerline",
                "Head of AI Platform",
                "she/her",
                (
                    "Imani runs the AI platform group at a mid-size asset manager, where "
                    "every model ships with a compliance officer's signature."
                ),
            ),
            (
                "Viktor",
                "Osei",
                "Basel Harbor",
                "Staff ML Engineer",
                "he/him",
                (
                    "Viktor builds retrieval systems over forty years of scanned trade "
                    "documents and lives to tell about it."
                ),
            ),
            (
                "Margaux",
                "Chen",
                "Copperwick Capital",
                "Quant Platform Lead",
                "she/her",
                (
                    "Margaux's team gives portfolio managers agents that draft research "
                    "notes — and audit trails their regulators actually accept."
                ),
            ),
            (
                "Dele",
                "Adeyemi",
                "Northgate Insurance",
                "Director of Data Science",
                "he/him",
                (
                    "Dele modernises underwriting at a hundred-year-old insurer, one "
                    "carefully evaluated model at a time."
                ),
            ),
            (
                "Sofia",
                "Marchetti",
                "Brightvault",
                "Founding Engineer",
                "she/her",
                (
                    "Sofia is employee three at a fintech building agentic back-office "
                    "automation for community banks."
                ),
            ),
            (
                "Ezra",
                "Blum",
                "Halcyon Markets",
                "VP, Trading Technology",
                "he/him",
                (
                    "Ezra has spent fifteen years on trading-desk infrastructure and now "
                    "decides which parts an agent is allowed to touch."
                ),
            ),
            (
                "Anya",
                "Petrova",
                "Signalwharf",
                "Applied Scientist",
                "she/her",
                (
                    "Anya works on fraud triage models that read like case files and "
                    "escalate like seasoned investigators."
                ),
            ),
            (
                "Kofi",
                "Mensah",
                "Draycott & Co",
                "Principal Engineer",
                "he/him",
                (
                    "Kofi leads the KYC automation programme at a private bank with "
                    "opinions about handwriting recognition."
                ),
            ),
            (
                "Lea",
                "Fontaine",
                "Tapestry Compliance",
                "Co-founder & CTO",
                "she/her",
                (
                    "Lea builds LLM tooling that regulators can subpoena without anyone "
                    "having a bad week."
                ),
            ),
            (
                "Marcus",
                "Hale",
                "Ironbridge Analytics",
                "Senior ML Engineer",
                "he/him",
                (
                    "Marcus evaluates credit-risk copilots and writes the internal evals "
                    "his bank now treats as policy."
                ),
            ),
            (
                "Priyanka",
                "Desai",
                "Meridian Trust",
                "Head of Innovation",
                "she/her",
                (
                    "Priyanka runs the innovation office at a custodian bank and has "
                    "shipped three agent pilots past model-risk review."
                ),
            ),
            (
                "Tobias",
                "Lindqvist",
                "Skiff Financial",
                "Platform Engineer",
                "he/him",
                (
                    "Tobias keeps a hedge fund's research agents inside their sandbox "
                    "and out of the news."
                ),
            ),
            (
                "Renata",
                "Alvarez",
                "Cobble Hill Systems",
                "Engineering Manager",
                "she/her",
                (
                    "Renata manages the team that automated a clearing house's most "
                    "boring, most regulated workflow."
                ),
            ),
            (
                "Yusuf",
                "Kaya",
                "Pierpoint Digital",
                "Staff Engineer",
                "he/him",
                (
                    "Yusuf builds voice agents for retail banking that know when to "
                    "hand the call to a human."
                ),
            ),
        ],
        "sessions": [
            {
                "title": "Agents on the Trading Desk: What Compliance Let Us Ship",
                "status": "accepted",
                "track": 1,
                "fmt": 1,
                "speaker": 6,
                "days": 18,
                "abstract": _p(
                    "A frank tour of two years putting agentic tooling in front of "
                    "traders at a regulated desk: what model-risk review approved, "
                    "what it killed, and the audit architecture that made the "
                    "difference."
                ),
            },
            {
                "title": "The Leadership Track Opener: Buying vs Building in Year Three",
                "status": "accepted",
                "track": 3,
                "fmt": 1,
                "speaker": 11,
                "days": 15,
                "abstract": _p(
                    "Three years into enterprise AI, the build-vs-buy math has "
                    "inverted twice. A custodian bank's innovation head walks "
                    "through the decisions that aged well and the ones that "
                    "didn't."
                ),
            },
            {
                "title": "RAG Under Regulation: Retrieval Inside a Bank",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 2,
                "days": 6,
                "abstract": _p(
                    "Retrieval over forty years of scanned trade documents, where "
                    "a wrong citation is a compliance incident. Chunking, OCR "
                    "repair, and the eval harness that keeps recall honest."
                ),
            },
            {
                "title": "Underwriting Copilots: Shipping Past Model-Risk Review",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 4,
                "days": 5,
                "abstract": _p(
                    "How a hundred-year-old insurer got an underwriting copilot "
                    "through model governance: the documentation, the challenger "
                    "models, and the humans still in the loop."
                ),
            },
            {
                "title": "Fraud Triage Agents That Escalate Like Investigators",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 7,
                "days": 6,
                "abstract": _p(
                    "Fraud queues are agent-shaped work: read the case, gather "
                    "context, decide or escalate. What changed when we let a model "
                    "hold the pen on first-pass triage."
                ),
            },
            {
                "title": "KYC Document Extraction at a Private Bank",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 8,
                "days": 4,
                "abstract": _p(
                    "Handwritten forms, six languages, zero tolerance for silent "
                    "errors. A production pipeline for KYC extraction, and the "
                    "human-review economics that decide what to automate."
                ),
            },
            {
                "title": "The Hedge Fund Research Agent Stack",
                "status": "accept_queue",
                "track": 2,
                "fmt": 2,
                "speaker": 12,
                "days": 9,
                "abstract": _p(
                    "The sandboxing, entitlements and data-boundary design behind "
                    "research agents at a fund where information barriers are a "
                    "legal fact, not a config flag."
                ),
            },
            {
                "title": "Compliance-Grade Audit Trails for LLM Products",
                "status": "accept_queue",
                "track": 2,
                "fmt": 2,
                "speaker": 9,
                "days": 8,
                "abstract": _p(
                    "What 'show your work' means when the worker is a model: "
                    "replayable traces, tamper-evident logs, and the retention "
                    "story your counsel will actually sign."
                ),
            },
            {
                "title": "Voice Agents in Retail Banking: The Handoff Problem",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 14,
                "days": 3,
                "abstract": _p(
                    "The hardest part of a banking voice agent isn't the voice — "
                    "it's knowing when to stop. Detection, warm transfer, and the "
                    "metrics that caught our worst failure mode."
                ),
            },
            {
                "title": "Credit-Risk Copilot Evals as Internal Policy",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 10,
                "days": 2,
                "abstract": _p(
                    "We turned our eval suite into a governance artifact: versioned, "
                    "signed off, and blocking release. The template, the fights, "
                    "and the incidents it has since prevented."
                ),
            },
            {
                "title": "Agentic Back Office for Community Banks",
                "status": "pending",
                "track": 2,
                "fmt": 3,
                "speaker": 5,
                "days": 2,
                "abstract": _p(
                    "Community banks run on fax machines and heroics. Ten minutes "
                    "on the unglamorous agent product replacing both."
                ),
            },
            {
                "title": "Clearing-House Automation: A Case Study in Boring",
                "status": "decline_queue",
                "track": 3,
                "fmt": 2,
                "speaker": 13,
                "days": 11,
                "abstract": _p(
                    "A retrospective on automating a clearing workflow end-to-end. "
                    "(Committee note: strong story, but overlaps the trading-desk "
                    "keynote's ground.)"
                ),
            },
            {
                "title": "Quant Research Notes, Drafted by Agents",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 3,
                "days": 1,
                "abstract": _p(
                    "Portfolio managers now get first-draft research notes from an "
                    "agent with citations back to source filings. The drafting "
                    "loop, the review UX, and what the PMs actually changed."
                ),
            },
        ],
    },
    # ── 2 · AI Engineer Code Summit 2026 — invite-only, scheduling ─────────
    2: {
        "name": "AI Engineer Code Summit 2026",
        "slug": "aie-code-summit-2026",
        "starts_at": "2026-11-11 08:00-08",
        "ends_at": "2026-11-13 18:00-08",
        "timezone": "America/Los_Angeles",
        "location": "San Francisco, CA",
        "branding": {"accent": "#C2410C", "heading_font": "jetbrains-mono"},
        "tracks": [
            ("AI Leadership", "#7C2D12"),
            ("AI Engineering", "#C2410C"),
            ("Workshops", "#0F766E"),
        ],
        "rooms": [("Summit Stage", 300), ("Workshop Studio", 60)],
        "formats": [
            ("Keynote", 30),
            ("Stage Talk", 20),
            ("Lightning Talk", 10),
            ("Workshop", 120),
        ],
        "contacts": [
            (
                "Nadia",
                "Rahman",
                "Forgeline",
                "Principal Engineer",
                "she/her",
                (
                    "Nadia runs a fleet of coding agents against a twelve-million-line "
                    "monorepo and has the incident reviews to prove it."
                ),
            ),
            (
                "Caleb",
                "Ostrander",
                "Hullworks",
                "CTO",
                "he/him",
                (
                    "Caleb rebuilt his company's delivery process around agent-written "
                    "code and human-owned review."
                ),
            ),
            (
                "Mei",
                "Nakamura",
                "Tessellate AI",
                "Staff Engineer",
                "she/her",
                (
                    "Mei builds the eval harnesses that decide whether a coding agent's "
                    "pull request ever reaches a human."
                ),
            ),
            (
                "Jonas",
                "Weber",
                "Kilnhouse",
                "Head of Developer Platform",
                "he/him",
                (
                    "Jonas owns the sandbox and permission model that lets three hundred "
                    "engineers run agents without paging security."
                ),
            ),
            (
                "Tamsin",
                "Okoro",
                "Brightloop",
                "Engineering Director",
                "she/her",
                (
                    "Tamsin led one of the first enterprise rollouts where agents close "
                    "more tickets than contractors."
                ),
            ),
            (
                "Ravi",
                "Subramanian",
                "Chisel Systems",
                "Founding Engineer",
                "he/him",
                (
                    "Ravi works on code-review tooling purpose-built for diffs no human "
                    "wrote."
                ),
            ),
            (
                "Astrid",
                "Holm",
                "Nordwind Software",
                "Senior Staff Engineer",
                "she/her",
                (
                    "Astrid maintains the internal harness that turned a legacy ERP "
                    "team into an agent-fleet operation."
                ),
            ),
            (
                "Diego",
                "Fuentes",
                "Patchbay",
                "Co-founder",
                "he/him",
                (
                    "Diego is building CI for the agent era, where the test suite is "
                    "the spec and the diff is negotiable."
                ),
            ),
            (
                "Hana",
                "Yoshida",
                "Loomcell",
                "Research Engineer",
                "she/her",
                (
                    "Hana studies long-horizon coding tasks and why agents lose the "
                    "plot at hour three."
                ),
            ),
            (
                "Owen",
                "Gallagher",
                "Ferrite Labs",
                "Platform Lead",
                "he/him",
                (
                    "Owen serves code models to two thousand internal developers and "
                    "measures everything twice."
                ),
            ),
            (
                "Zainab",
                "Idris",
                "Stackpine",
                "Engineering Manager",
                "she/her",
                (
                    "Zainab manages a team where every engineer is also an agent "
                    "operator, and the org chart shows it."
                ),
            ),
            (
                "Petr",
                "Kovar",
                "Duskcode",
                "Staff Engineer",
                "he/him",
                (
                    "Petr writes the guardrails that keep autonomous refactors from "
                    "becoming autonomous outages."
                ),
            ),
        ],
        "sessions": [
            {
                "title": "Opening Keynote: The Year Coding Agents Grew Up",
                "status": "accepted",
                "track": 1,
                "fmt": 1,
                "speaker": 2,
                "days": 30,
                "room": 1,
                "start": "2026-11-11T09:00:00-08:00",
                "end": "2026-11-11T09:30:00-08:00",
                "abstract": _p(
                    "From autocomplete to accountable teammate: what changed in "
                    "enterprise codebases this year, told through delivery data "
                    "from teams that restructured around agent-written code."
                ),
            },
            {
                "title": "Harness Engineering: Lessons from 10,000 Agent Hours",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 1,
                "days": 28,
                "room": 1,
                "start": "2026-11-12T09:00:00-08:00",
                "end": "2026-11-12T09:30:00-08:00",
                "abstract": _p(
                    "The harness — not the model — decides whether an agent fleet "
                    "compounds or thrashes. Queueing, checkpointing, review gates "
                    "and the metrics that predict a runaway before it happens."
                ),
            },
            {
                "title": "Code Review When the Author Is a Machine",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 6,
                "days": 26,
                "room": 1,
                "start": "2026-11-12T09:45:00-08:00",
                "end": "2026-11-12T10:05:00-08:00",
                "abstract": _p(
                    "Human review practices assume a human author who can be "
                    "embarrassed. What review looks like when the author is a "
                    "model: verification-first workflows and reviewer tooling "
                    "that scales past diff-reading."
                ),
            },
            {
                "title": "Evals for Coding Agents That Don't Lie to You",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 3,
                "days": 25,
                "room": 1,
                "start": "2026-11-12T10:15:00-08:00",
                "end": "2026-11-12T10:35:00-08:00",
                "abstract": _p(
                    "Passing tests is not the same as working software. Building "
                    "eval harnesses that catch reward hacking, spec drift, and "
                    "the flaky-test laundering agents love."
                ),
            },
            {
                "title": "Sandboxes, Entitlements, and the Blast-Radius Budget",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 4,
                "days": 24,
                "room": 1,
                "start": "2026-11-12T11:00:00-08:00",
                "end": "2026-11-12T11:20:00-08:00",
                "abstract": _p(
                    "A permission model for agent fleets: what they may read, "
                    "write, and deploy — and how we budget blast radius so a bad "
                    "afternoon stays an afternoon."
                ),
            },
            {
                "title": "From Copilot to Coworker: An Enterprise Adoption Curve",
                "status": "accepted",
                "track": 1,
                "fmt": 2,
                "speaker": 5,
                "days": 22,
                "room": 1,
                "start": "2026-11-12T11:30:00-08:00",
                "end": "2026-11-12T11:50:00-08:00",
                "abstract": _p(
                    "Eighteen months of adoption data from a 400-engineer org: "
                    "where agents stuck, where they stalled, and the management "
                    "practices that made the difference."
                ),
            },
            {
                "title": "Long-Horizon Coding Tasks: Why Agents Lose the Plot",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 9,
                "days": 20,
                "room": 1,
                "start": "2026-11-12T13:00:00-08:00",
                "end": "2026-11-12T13:20:00-08:00",
                "abstract": _p(
                    "Empirical work on multi-hour coding sessions: where context "
                    "management fails, what checkpointing actually preserves, and "
                    "the surprisingly small interventions that double task "
                    "completion."
                ),
            },
            {
                "title": "CI for the Agent Era",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 8,
                "days": 19,
                "room": 1,
                "start": "2026-11-12T13:30:00-08:00",
                "end": "2026-11-12T13:50:00-08:00",
                "abstract": _p(
                    "When agents open forty pull requests a day, CI becomes the "
                    "real reviewer. Rebuilding the pipeline as the source of "
                    "truth agents negotiate against."
                ),
            },
            {
                "title": "Build Your Own Agent Harness (Hands-On)",
                "status": "accepted",
                "track": 3,
                "fmt": 4,
                "speaker": 7,
                "days": 18,
                "room": 2,
                "start": "2026-11-13T09:00:00-08:00",
                "end": "2026-11-13T11:00:00-08:00",
                "abstract": _p(
                    "Bring a laptop; leave with a working harness. Task queues, "
                    "worktree isolation, review gates and progress surfaces, "
                    "built live on an open-source stack."
                ),
            },
            {
                "title": "Guardrails for Autonomous Refactors (Hands-On)",
                "status": "accepted",
                "track": 3,
                "fmt": 4,
                "speaker": 12,
                "days": 16,
                "room": 2,
                "start": "2026-11-13T13:00:00-08:00",
                "end": "2026-11-13T15:00:00-08:00",
                "abstract": _p(
                    "A workshop on constraint systems for large-scale automated "
                    "refactoring: invariants, canary builds, and rollback "
                    "budgets — applied to a real legacy codebase."
                ),
            },
            {
                "title": "Serving Code Models to 2,000 Developers",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 10,
                "days": 8,
                "abstract": _p(
                    "Latency budgets, capacity planning and the cost curves of an "
                    "internal code-model platform — with the dashboards we wish "
                    "we'd built first."
                ),
            },
            {
                "title": "The Agent Operator: A New Engineering Role",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 11,
                "days": 7,
                "abstract": _p(
                    "We rewrote job ladders around agent operation. What the role "
                    "actually is, how we interview for it, and what happened to "
                    "the engineers who hated the idea."
                ),
            },
        ],
    },
    # ── 3 · AI Engineer Europe 2027 — announced, early planning ────────────
    3: {
        "name": "AI Engineer Europe 2027",
        "slug": "aie-europe-2027",
        "starts_at": "2027-02-17 09:00+00",
        "ends_at": "2027-02-19 17:00+00",
        "timezone": "Europe/London",
        "location": "London, UK (venue TBA)",
        "branding": {"accent": "#0F766E", "heading_font": "space-grotesk"},
        "tracks": [("Main Stage", "#0F766E"), ("Agents in Production", "#155E75")],
        "rooms": [("Main Hall", 600)],
        "formats": [("Keynote", 30), ("Stage Talk", 20), ("Workshop", 120)],
        "contacts": [
            (
                "Ines",
                "Beaumont",
                "Cartographe",
                "VP of Engineering",
                "she/her",
                (
                    "Ines leads engineering at a Paris scale-up shipping multilingual "
                    "agents across nine EU markets."
                ),
            ),
            (
                "Lars",
                "Vestergaard",
                "Fjordworks",
                "Principal Engineer",
                "he/him",
                (
                    "Lars builds on-prem inference for customers whose data cannot "
                    "leave the building, let alone the continent."
                ),
            ),
            (
                "Amara",
                "Nwosu",
                "Kestrel Labs",
                "Head of Applied AI",
                "she/her",
                (
                    "Amara runs applied AI at a London fintech and chairs a working "
                    "group on EU AI Act compliance engineering."
                ),
            ),
            (
                "Mateo",
                "Ribeiro",
                "Alfama Systems",
                "Staff Engineer",
                "he/him",
                (
                    "Mateo works on evaluation for languages the benchmark suites "
                    "forgot."
                ),
            ),
            (
                "Greta",
                "Hoffmann",
                "Tannenbaum Software",
                "Engineering Director",
                "she/her",
                (
                    "Greta modernises German industrial software with agents that "
                    "respect a works council."
                ),
            ),
            (
                "Ciaran",
                "Doyle",
                "Slievemore",
                "Co-founder & CTO",
                "he/him",
                (
                    "Ciaran builds developer tooling from Dublin and has strong "
                    "opinions about latency to us-east-1."
                ),
            ),
        ],
        "sessions": [
            {
                "title": "Opening Keynote: AI Engineering Under the AI Act",
                "status": "accepted",
                "track": 1,
                "fmt": 1,
                "speaker": 3,
                "days": 12,
                "abstract": _p(
                    "The EU AI Act stopped being a slide and started being a "
                    "sprint ticket. What compliance engineering actually looks "
                    "like in production, from someone shipping under it."
                ),
            },
            {
                "title": "Sovereign Inference: On-Prem Agents at Scale",
                "status": "accepted",
                "track": 2,
                "fmt": 2,
                "speaker": 2,
                "days": 10,
                "abstract": _p(
                    "Running serious agent workloads where the data cannot leave "
                    "the building: hardware reality, model selection, and the "
                    "operational playbook."
                ),
            },
            {
                "title": "Multilingual Evals: Benchmarks the Leaderboards Forgot",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 4,
                "days": 5,
                "abstract": _p(
                    "Evaluation infrastructure for Portuguese, Polish and Finnish "
                    "product surfaces — and the failure modes English-only evals "
                    "never see."
                ),
            },
            {
                "title": "Agents and the Works Council",
                "status": "pending",
                "track": 1,
                "fmt": 2,
                "speaker": 5,
                "days": 4,
                "abstract": _p(
                    "Deploying agent tooling in a German industrial group means "
                    "co-determination, not just change management. A candid "
                    "account of doing it right."
                ),
            },
            {
                "title": "Nine Markets, One Agent: Localisation as Architecture",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 1,
                "days": 3,
                "abstract": _p(
                    "Localisation is not a translation pass — it's an "
                    "architecture decision. How we structure prompts, retrieval "
                    "and evals for nine EU markets from one codebase."
                ),
            },
        ],
    },
    # ── 4 · AI Engineer World's Fair 2027 — planning, early keynotes ───────
    4: {
        "name": "AI Engineer World's Fair 2027",
        "slug": "aie-worlds-fair-2027",
        "starts_at": "2027-06-29 08:00-07",
        "ends_at": "2027-07-02 18:00-07",
        "timezone": "America/Los_Angeles",
        "location": "Moscone West, San Francisco",
        "branding": {"accent": "#7C3AED", "heading_font": "space-grotesk"},
        "tracks": [
            ("Keynotes", "#7C3AED"),
            ("Agentic Engineering", "#C2410C"),
            ("Evals", "#0F766E"),
            ("Context Engineering", "#1D4ED8"),
            ("Voice & Realtime", "#BE185D"),
            ("Generative Media", "#A16207"),
        ],
        "rooms": [("Keynote Hall", 3000), ("Track Stage 1", 400)],
        "formats": [
            ("Keynote", 30),
            ("Stage Talk", 20),
            ("Lightning Talk", 10),
            ("Workshop", 120),
        ],
        "contacts": [
            (
                "Shawn",
                "Wang",
                "Latent.Space",
                "Curator, AI Engineer",
                "he/him",
                (
                    "swyx is the curator of the AI Engineer conference series and "
                    "co-host of the Latent Space podcast."
                ),
            ),
            (
                "Alessio",
                "Fanelli",
                "Latent.Space",
                "Co-host, Latent Space",
                "he/him",
                (
                    "Alessio co-hosts the Latent Space podcast and spends the rest of "
                    "his time with early-stage AI infrastructure companies."
                ),
            ),
            (
                "Noor",
                "Haddad",
                "Quillon",
                "Staff Engineer",
                "she/her",
                (
                    "Noor builds context-assembly pipelines that decide what a model "
                    "gets to know, and when."
                ),
            ),
            (
                "Felix",
                "Arnaud",
                "Chorale",
                "Founding Engineer",
                "he/him",
                (
                    "Felix ships realtime voice agents with sub-300ms turnarounds and "
                    "a graveyard of abandoned architectures."
                ),
            ),
            (
                "Rosa",
                "Delgado",
                "Emberlane",
                "Research Engineer",
                "she/her",
                (
                    "Rosa studies memory and continual learning for agents that are "
                    "supposed to remember last quarter."
                ),
            ),
            (
                "Kenji",
                "Mori",
                "Graphetto",
                "Principal Engineer",
                "he/him",
                (
                    "Kenji works on retrieval graphs that stay coherent while ten "
                    "agents write to them at once."
                ),
            ),
            (
                "Bianca",
                "Rossi",
                "Lanternfish AI",
                "Head of Product Engineering",
                "she/her",
                (
                    "Bianca leads product engineering on a generative-video tool used "
                    "by three broadcast networks."
                ),
            ),
            (
                "Samuel",
                "Boateng",
                "Bellwether Systems",
                "Engineering Lead",
                "he/him",
                (
                    "Samuel runs evals for a foundation-model customer with a "
                    "seven-figure inference bill and receipts to match."
                ),
            ),
            (
                "Iris",
                "Van Dijk",
                "Windrose AI",
                "Staff Engineer",
                "she/her",
                (
                    "Iris builds agent observability tooling and believes every trace "
                    "should read like a story."
                ),
            ),
            (
                "Jae",
                "Park",
                "Coldstart",
                "Co-founder & CTO",
                "he/him",
                (
                    "Jae is building inference infrastructure for models that wake up "
                    "fast and scale to zero faster."
                ),
            ),
        ],
        "sessions": [
            {
                "title": "Opening Keynote: The State of AI Engineering",
                "status": "accepted",
                "track": 1,
                "fmt": 1,
                "speaker": 1,
                "days": 21,
                "abstract": _p(
                    "The annual state of the discipline: what the industry "
                    "shipped, what it abandoned, and where AI engineering goes "
                    "next. Placeholder title — final keynote framing lands with "
                    "the spring program."
                ),
            },
            {
                "title": "Latent Space Live: The Year in Agents",
                "status": "accepted",
                "track": 1,
                "fmt": 1,
                "speaker": 2,
                "days": 21,
                "abstract": _p(
                    "The Latent Space year-in-review, live: the papers, launches "
                    "and quiet infrastructure shifts that actually mattered, with "
                    "the podcast's usual disrespect for hype."
                ),
            },
            {
                "title": "Context Engineering at the Trillion-Token Scale",
                "status": "accepted",
                "track": 4,
                "fmt": 2,
                "speaker": 3,
                "days": 14,
                "abstract": _p(
                    "Invited talk. Context assembly as a first-class system: "
                    "budgeting, provenance, and the pipelines that decide what a "
                    "model gets to know."
                ),
            },
            {
                "title": "Sub-300ms: Voice Agents Without the Uncanny Pause",
                "status": "accepted",
                "track": 5,
                "fmt": 2,
                "speaker": 4,
                "days": 14,
                "abstract": _p(
                    "Invited talk. The architecture behind conversational "
                    "latency people stop noticing — and the three designs we "
                    "buried getting there."
                ),
            },
            {
                "title": "Agent Memory That Survives the Quarter",
                "status": "pending",
                "track": 3,
                "fmt": 2,
                "speaker": 5,
                "days": 7,
                "abstract": _p(
                    "Continual learning for production agents: what to persist, "
                    "what to forget, and how to evaluate memory without leaking "
                    "the future into the past."
                ),
            },
            {
                "title": "Concurrent Retrieval Graphs: Ten Writers, One Truth",
                "status": "pending",
                "track": 4,
                "fmt": 2,
                "speaker": 6,
                "days": 6,
                "abstract": _p(
                    "Keeping a knowledge graph coherent while a fleet of agents "
                    "reads and writes concurrently: conflict semantics, repair "
                    "jobs, and the invariants worth enforcing."
                ),
            },
            {
                "title": "Broadcast-Grade Generative Video, Reviewed by Humans",
                "status": "pending",
                "track": 6,
                "fmt": 2,
                "speaker": 7,
                "days": 5,
                "abstract": _p(
                    "What it takes to put generated footage on air: review "
                    "workflows, provenance metadata, and the editorial standards "
                    "that survived contact with the tools."
                ),
            },
            {
                "title": "The Seven-Figure Eval Bill: Making It Pay",
                "status": "pending",
                "track": 3,
                "fmt": 2,
                "speaker": 8,
                "days": 5,
                "abstract": _p(
                    "When inference spend hits seven figures, evals become a "
                    "finance function. Cost-aware evaluation design and the "
                    "regressions it caught before customers did."
                ),
            },
            {
                "title": "Traces That Read Like Stories: Agent Observability",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 9,
                "days": 4,
                "abstract": _p(
                    "Observability for agent systems that humans can actually "
                    "debug: narrative traces, decision summaries, and the "
                    "tooling that turned incident review from archaeology into "
                    "reading."
                ),
            },
            {
                "title": "Scale-to-Zero Inference for Bursty Agent Fleets",
                "status": "pending",
                "track": 2,
                "fmt": 2,
                "speaker": 10,
                "days": 3,
                "abstract": _p(
                    "Agent workloads are bursty in ways serving stacks hate. "
                    "Cold-start engineering, snapshot restore, and the cost "
                    "curves of scaling to zero without punishing latency."
                ),
            },
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# ROW BUILDERS
# ═══════════════════════════════════════════════════════════════════════════
def _ago_days(days: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def build_all() -> dict[str, list[dict]]:
    """Return {table: rows} for every seeded event, in insert order."""
    out: dict[str, list[dict]] = {
        "events": [],
        "tracks": [],
        "rooms": [],
        "formats": [],
        "contacts": [],
        "sessions": [],
        "session_participants": [],
    }
    for e, spec in EVENTS.items():
        out["events"].append(
            {
                "id": event_id(e),
                "org_id": ORG,
                "name": spec["name"],
                "slug": spec["slug"],
                "starts_at": spec["starts_at"],
                "ends_at": spec["ends_at"],
                "timezone": spec["timezone"],
                "location": spec["location"],
                "branding": spec["branding"],
            }
        )
        for i, (name, color) in enumerate(spec["tracks"], start=1):
            out["tracks"].append(
                {
                    "id": track_id(e, i),
                    "org_id": ORG,
                    "event_id": event_id(e),
                    "name": name,
                    "color": color,
                    "order": i - 1,
                }
            )
        for i, (name, capacity) in enumerate(spec["rooms"], start=1):
            out["rooms"].append(
                {
                    "id": room_id(e, i),
                    "org_id": ORG,
                    "event_id": event_id(e),
                    "name": name,
                    "order": i - 1,
                    "capacity": capacity,
                }
            )
        for i, (name, minutes) in enumerate(spec["formats"], start=1):
            out["formats"].append(
                {
                    "id": fmt_id(e, i),
                    "org_id": ORG,
                    "event_id": event_id(e),
                    "name": name,
                    "default_duration_min": minutes,
                }
            )
        for i, (first, last, company, title, pronouns, bio) in enumerate(
            spec["contacts"], start=1
        ):
            out["contacts"].append(
                {
                    "id": contact_id(e, i),
                    "org_id": ORG,
                    "event_id": event_id(e),
                    "email": f"{first.lower()}.{last.lower().replace(' ', '')}@example.com",
                    "first_name": first,
                    "last_name": last,
                    "company_name": company,
                    "title": title,
                    "about": bio,
                    "pronouns": pronouns,
                    "custom_fields": {"_demo": True},
                }
            )
        for i, s in enumerate(spec["sessions"], start=1):
            row = {
                "id": session_id(e, i),
                "org_id": ORG,
                "event_id": event_id(e),
                "friendly_id_raw": 100 + i,
                "title": s["title"],
                "description": s["abstract"],
                "status": s["status"],
                "is_abstract": s["status"] != "accepted",
                "track_id": track_id(e, s["track"]),
                "format_id": fmt_id(e, s["fmt"]),
                "submitter_contact_id": contact_id(e, s["speaker"]),
                "submitted_at": _ago_days(s["days"]),
            }
            if s.get("room"):
                row["room_id"] = room_id(e, s["room"])
                row["starts_at"] = s["start"]
                row["ends_at"] = s["end"]
            out["sessions"].append(row)
            out["session_participants"].append(
                {
                    "org_id": ORG,
                    "session_id": session_id(e, i),
                    "contact_id": contact_id(e, s["speaker"]),
                    "role": "submitter",
                    "is_primary": False,
                }
            )
            out["session_participants"].append(
                {
                    "org_id": ORG,
                    "session_id": session_id(e, i),
                    "contact_id": contact_id(e, s["speaker"]),
                    "role": "speaker",
                    "is_primary": True,
                }
            )
            if s.get("co"):
                out["session_participants"].append(
                    {
                        "org_id": ORG,
                        "session_id": session_id(e, i),
                        "contact_id": contact_id(e, s["co"]),
                        "role": "speaker",
                        "is_primary": False,
                    }
                )
    return out


# ═══════════════════════════════════════════════════════════════════════════
# RESET / SEED
# ═══════════════════════════════════════════════════════════════════════════
def _all_ids() -> tuple[list[str], list[str], list[str]]:
    evts = [event_id(e) for e in EVENTS]
    sess = [
        session_id(e, i)
        for e, spec in EVENTS.items()
        for i in range(1, len(spec["sessions"]) + 1)
    ]
    ppl = [
        contact_id(e, i)
        for e, spec in EVENTS.items()
        for i in range(1, len(spec["contacts"]) + 1)
    ]
    return evts, sess, ppl


def reset() -> None:
    """Delete these events and everything beneath them, in FK-safe order.

    Judges are invited to click freely, so live usage may have hung invites,
    tasks, decisions, or evaluation plans off these events between reseeds —
    each child table is cleared by event/session/contact scope before the
    structural rows go.
    """
    t = supabase.table
    evts, sess, ppl = _all_ids()

    plan_rows = (
        t("evaluation_plans").select("id").in_("event_id", evts).execute().data or []
    )
    plan_ids = [r["id"] for r in plan_rows]
    if plan_ids:
        assignment_rows = (
            t("assignments").select("id").in_("plan_id", plan_ids).execute().data or []
        )
        assignment_ids = [r["id"] for r in assignment_rows]
        if assignment_ids:
            t("reviews").delete().in_("assignment_id", assignment_ids).execute()
        t("assignments").delete().in_("plan_id", plan_ids).execute()
        t("evaluators").delete().in_("plan_id", plan_ids).execute()
        t("evaluation_plans").delete().in_("id", plan_ids).execute()

    for table, column, ids in (
        ("content_comments", "contact_id", ppl),
        ("files", "session_id", sess),
        ("files", "contact_id", ppl),
        ("task_assignments", "contact_id", ppl),
        ("calendar_invites", "session_id", sess),
        ("calendar_invites", "contact_id", ppl),
        ("magic_link_tokens", "contact_id", ppl),
        ("email_outbox", "contact_id", ppl),
        ("tasks", "event_id", evts),
        ("portals", "event_id", evts),
        ("session_participants", "session_id", sess),
        ("session_tracks", "session_id", sess),
        ("session_tags", "session_id", sess),
    ):
        t(table).delete().in_(column, ids).execute()

    t("sessions").delete().in_("event_id", evts).execute()
    t("contacts").delete().in_("event_id", evts).execute()
    t("friendly_id_counters").delete().in_("event_id", evts).execute()
    for table in ("formats", "rooms", "tracks"):
        t(table).delete().in_("event_id", evts).execute()
    t("events").delete().in_("id", evts).execute()
    print(f"reset: {len(evts)} AIE events deleted")


def seed() -> dict:
    """Idempotent: reset, then insert all four events and their data."""
    reset()
    supabase.table("orgs").update({"name": ORG_NAME}).eq("org_id", ORG).execute()
    counts: dict[str, int] = {}
    for table, rows in build_all().items():
        if rows:
            supabase.table(table).insert(rows).execute()
        counts[table] = len(rows)
    print("seed: inserted")
    for table, n in counts.items():
        print(f"  {table:22s} {n}")
    return counts


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", nargs="?", default="seed", choices=("seed", "reset", "full")
    )
    args = parser.parse_args(argv[1:])

    if args.command == "reset":
        reset()
    elif args.command == "seed":
        seed()
    else:
        # Full demo reseed: flagship first (its reset clears org_dev children
        # org-wide, including anything beneath these events), then the AIE set.
        from scripts import seed_demo

        seed_demo.seed()
        seed()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
