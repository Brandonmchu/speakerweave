/**
 * The product, embedded in the marketing page.
 *
 * A borderless re-creation of the SpeakerWeave admin shell — the same rail, top
 * bar, page headers, tables, dot statuses and agenda grid the signed-in app
 * renders — so a visitor can read the real thing without an account. It is real
 * DOM (crisp at any zoom, selectable, keyboard reachable), not a screenshot.
 *
 * Three rules this file is built around:
 *
 *   1. The DATA is the demo workspace. Every name, title, session, score,
 *      status and onboarding count below comes from `api/scripts/seed_demo.py`
 *      (AI Builders Summit 2026), so the mock and the live demo agree.
 *   2. The STRUCTURE is the app's. Class idiom, spacing and type scale mirror
 *      `shell/AppShell.tsx`, `pages/Inbox.tsx`, `pages/Agenda.tsx`,
 *      `pages/Speakers.tsx` and `pages/ContentLibrary.tsx`.
 *   3. NOTHING here implies a write. Reads are real (screen switching, status
 *      filtering, row selection, day/view switching, expanding a speaker's
 *      tasks); every action that would POST is a <span>, so it is not focusable
 *      and cannot be mistaken for a live control.
 *
 * Styling lives in `styles/site-appwindow.css`, prefixed `swa-` and scoped
 * under `.sw-site`. No Tailwind utilities: the app sets `important: '#root'`,
 * so a utility would beat this sheet and would carry the site's inverted
 * palette rather than the app's warm paper. The palette is re-declared locally
 * for the same reason.
 */
import { Fragment, useState, type JSX } from 'react'

import { avatarGradient } from '@/ui/avatar'

import '../styles/site-appwindow.css'

/* -------------------------------------------------------------------------- */
/* Seed data — api/scripts/seed_demo.py                                        */
/* -------------------------------------------------------------------------- */

const EVENT_NAME = 'AI Builders Summit 2026'
const EVENT_DATES = 'Oct 12 – Oct 13, 2026'
/** The event's first day, in the event's own zone. Drives the live countdown. */
const EVENT_START = Date.UTC(2026, 9, 12, 15, 0, 0) // 2026-10-12 08:00 -07:00

interface Contact {
  id: string
  name: string
  email: string
  company: string
  role: string
  /** Committed under `web/public/speakers/`; null falls back to a gradient tile. */
  photo: string | null
}

/** The seeder's contact UUIDs, so a gradient tile here matches the live demo. */
function contactId(index: number): string {
  return `dacc0000-0000-0000-0000-${String(index).padStart(12, '0')}`
}

// (first, last, company, title, has_headshot) — `_CONTACT_SPEC`, in seed order.
const CONTACT_SPEC: Array<[string, string, string, string, boolean]> = [
  ['Ada', 'Okafor', 'Lumen AI', 'VP of Engineering', true],
  ['Priya', 'Raman', 'VectorWorks', 'Staff ML Engineer', true],
  ['Marco', 'Bianchi', 'DeepIndex', 'Research Scientist', true],
  ['Elena', 'Vasquez', 'FineTune Labs', 'Founder & CEO', true],
  ['James', 'Park', 'RedTeam AI', 'Principal Security Researcher', true],
  ['Aisha', 'Bello', 'AgentGrid', 'Head of Product', true],
  ['David', 'Chen', 'Boring Robots', 'Co-founder & CTO', true],
  ['Yuki', 'Tanaka', 'PixelMind', 'Research Engineer', true],
  ['Omar', 'Haddad', 'ToolChain', 'Staff Developer Advocate', true],
  ['Grace', 'Lin', 'FineTune Labs', 'ML Engineer', true],
  ['Tomas', 'Novak', 'ToolChain', 'Solutions Architect', true],
  ['Sarah', 'Whitman', 'TinyML Co', 'Senior Engineer', true],
  ['Raj', 'Patel', 'TraceStack', 'Observability Lead', true],
  ['Nina', 'Sorensen', 'SynthGen', 'Data Scientist', false],
  ['Lucas', 'Meyer', 'Ferrous AI', 'Systems Engineer', true],
  ['Hannah', 'Cole', 'Trustworthy Labs', 'Director of UX', true],
  ['Wei', 'Zhang', 'StructOut', 'Senior Engineer', true],
  ['Fatima', 'Al-Sayed', 'MultiModal Inc', 'Research Scientist', true],
  ['Brad', 'Sullivan', 'ChainForward', 'Consultant', false],
  ['Chloe', 'Dubois', 'Wordsmith AI', 'Prompt Engineer', false],
]

const CONTACTS: Contact[] = CONTACT_SPEC.map(([first, last, company, role, photo], index) => ({
  id: contactId(index + 1),
  name: `${first} ${last}`,
  email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, '')}@example.com`,
  company,
  role,
  photo: photo
    ? `/speakers/${`${first}-${last}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`
    : null,
}))

/** 1-based, like the seeder's contact indexes. */
function who(index: number): Contact {
  return CONTACTS[index - 1]
}

/* -------------------------------------------------------------------------- */
/* Status vocabulary — Inbox.tsx STATUS_META, ContentLibrary.tsx STATUS_META    */
/* -------------------------------------------------------------------------- */

type Tone = 'pending' | 'accepted' | 'queue' | 'declined' | 'neutral' | 'overdue'

type SubmissionStatus =
  | 'pending'
  | 'accept_queue'
  | 'accepted'
  | 'decline_queue'
  | 'declined'
  | 'withdrawn'

const STATUS_META: Record<SubmissionStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'pending' },
  accept_queue: { label: 'Accept Queue', tone: 'queue' },
  accepted: { label: 'Accepted', tone: 'accepted' },
  decline_queue: { label: 'Decline Queue', tone: 'queue' },
  declined: { label: 'Declined', tone: 'declined' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
}

/* -------------------------------------------------------------------------- */
/* Submissions — `_SESSION_SPEC` + the seeded review scores                     */
/* -------------------------------------------------------------------------- */

interface SubmissionRow {
  id: string
  title: string
  /** Seed contact index of the submitter. */
  by: number
  track: 'Engineering' | 'Product' | 'Research'
  /** Weighted average of the seeded reviews, or '—' when nobody scored it. */
  score: string
  status: SubmissionStatus
  submitted: string
}

/** Newest first — the inbox's default sort. */
const SUBMISSIONS: SubmissionRow[] = [
  { id: 'SESS-114', title: 'Designing Trustworthy AI Product Experiences', by: 16, track: 'Product', score: '3.3', status: 'pending', submitted: '4 days ago' },
  { id: 'SESS-113', title: 'From Notebook to Nginx: Serving Models in Rust', by: 15, track: 'Engineering', score: '4.0', status: 'pending', submitted: '5 days ago' },
  { id: 'SESS-112', title: "Synthetic Data Pipelines That Don't Lie", by: 14, track: 'Research', score: '3.3', status: 'pending', submitted: '6 days ago' },
  { id: 'SESS-111', title: 'Observability for LLM Applications', by: 13, track: 'Product', score: '3.5', status: 'pending', submitted: '7 days ago' },
  { id: 'SESS-110', title: 'Small Models, Big Wins: The Case for 3B Parameters', by: 12, track: 'Engineering', score: '4.7', status: 'pending', submitted: '8 days ago' },
  { id: 'SESS-115', title: 'Guardrails: Structured Outputs Without the Pain', by: 17, track: 'Engineering', score: '4.3', status: 'accept_queue', submitted: '9 days ago' },
  { id: 'SESS-116', title: 'Retrieval Beyond Text: Multimodal RAG', by: 18, track: 'Research', score: '—', status: 'accept_queue', submitted: '9 days ago' },
  { id: 'SESS-117', title: 'Blockchain Meets LLMs: A New Paradigm', by: 19, track: 'Product', score: '—', status: 'decline_queue', submitted: '10 days ago' },
  { id: 'SESS-118', title: 'Why Prompt Engineering Is Dead', by: 20, track: 'Product', score: '—', status: 'declined', submitted: '11 days ago' },
  { id: 'SESS-119', title: 'GPU Poor: Training on a Budget', by: 1, track: 'Engineering', score: '—', status: 'withdrawn', submitted: '12 days ago' },
  { id: 'SESS-120', title: 'The Ethics of Autonomous Agents', by: 5, track: 'Research', score: '—', status: 'withdrawn', submitted: '13 days ago' },
  { id: 'SESS-109', title: 'Hands-On: Building Tool-Using Agents', by: 9, track: 'Engineering', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-107', title: "The Agentic Future Is Boring (And That's Good)", by: 7, track: 'Product', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-108', title: 'Multimodal Models at Scale: Text, Image, and Beyond', by: 8, track: 'Research', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-105', title: 'Prompt Injection: A Live Teardown', by: 5, track: 'Research', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-106', title: 'Evaluating LLM Agents That Actually Ship', by: 6, track: 'Product', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-104', title: 'Hands-On: Fine-Tuning Open Models for Your Domain', by: 4, track: 'Engineering', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-102', title: 'RAG in Production: Lessons From 10 Billion Queries', by: 2, track: 'Engineering', score: '2.6', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-103', title: 'Vector Databases Under the Hood', by: 3, track: 'Research', score: '—', status: 'accepted', submitted: 'about 1 month ago' },
  { id: 'SESS-101', title: 'Scaling Frontier Models Without Scaling Your Bill', by: 1, track: 'Engineering', score: '4.7', status: 'accepted', submitted: 'about 1 month ago' },
]

type TabKey = 'all' | SubmissionStatus

const SUBMISSION_TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'accept_queue', label: 'Accept Queue' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'decline_queue', label: 'Decline Queue' },
  { key: 'declined', label: 'Declined' },
]

/** Rows per page — the inbox's own footer control, fixed here. */
const PAGE_SIZE = 10

/* -------------------------------------------------------------------------- */
/* Agenda — the scheduled half of `_SESSION_SPEC`                              */
/* -------------------------------------------------------------------------- */

/** Pixel height of one slot, and the event's 15-minute slot size. */
const SLOT_PX = 24
const SLOT_MIN = 15
/**
 * The event's day runs 08:00–18:00. The frame shows the busy window rather
 * than 40 empty-ended slots — the same grid, cropped the way a screenshot is.
 */
const WINDOW_START = 9 * 60
const WINDOW_END = 12 * 60 + 30
const SLOT_COUNT = (WINDOW_END - WINDOW_START) / SLOT_MIN

const ROOMS = [
  { id: 'main', name: 'Main Stage', capacity: 400 },
  { id: 'wa', name: 'Workshop A', capacity: 80 },
  { id: 'wb', name: 'Workshop B', capacity: 80 },
]

/** Track -> the card's 3px stripe, hashed exactly as Agenda.tsx hashes it. */
const TRACK_TONE: Record<string, 'neutral' | 'accepted' | 'pending'> = {
  Engineering: 'neutral',
  Product: 'accepted',
  Research: 'pending',
}

interface Placed {
  id: string
  title: string
  room: string
  day: 1 | 2
  /** Minutes past local midnight. */
  start: number
  duration: number
  track: keyof typeof TRACK_TONE
  speakers: number[]
}

const PLACED: Placed[] = [
  { id: 'SESS-101', title: 'Scaling Frontier Models Without Scaling Your Bill', room: 'main', day: 1, start: 540, duration: 45, track: 'Engineering', speakers: [1] },
  { id: 'SESS-105', title: 'Prompt Injection: A Live Teardown', room: 'main', day: 1, start: 600, duration: 15, track: 'Research', speakers: [5] },
  { id: 'SESS-106', title: 'Evaluating LLM Agents That Actually Ship', room: 'main', day: 1, start: 660, duration: 30, track: 'Product', speakers: [6] },
  { id: 'SESS-102', title: 'RAG in Production: Lessons From 10 Billion Queries', room: 'wa', day: 1, start: 600, duration: 30, track: 'Engineering', speakers: [2] },
  { id: 'SESS-104', title: 'Hands-On: Fine-Tuning Open Models for Your Domain', room: 'wa', day: 1, start: 660, duration: 90, track: 'Engineering', speakers: [4, 10] },
  { id: 'SESS-103', title: 'Vector Databases Under the Hood', room: 'wb', day: 1, start: 600, duration: 30, track: 'Research', speakers: [2, 3] },
  { id: 'SESS-107', title: "The Agentic Future Is Boring (And That's Good)", room: 'main', day: 2, start: 540, duration: 45, track: 'Product', speakers: [7] },
  { id: 'SESS-108', title: 'Multimodal Models at Scale: Text, Image, and Beyond', room: 'wa', day: 2, start: 600, duration: 30, track: 'Research', speakers: [8] },
  { id: 'SESS-109', title: 'Hands-On: Building Tool-Using Agents', room: 'wb', day: 2, start: 600, duration: 90, track: 'Engineering', speakers: [9, 11] },
]

/**
 * The seeder's deliberate double-booking: Priya Raman is the primary speaker on
 * both 10:00 sessions, in two different rooms. `lib/schedule.ts` words it
 * exactly like this.
 */
const CONFLICTS = [
  {
    detail: 'Priya Raman is in two rooms at 10:00',
    pair: ['RAG in Production: Lessons From 10 Billion Queries', 'Vector Databases Under the Hood'],
    ids: ['SESS-102', 'SESS-103'],
  },
]
const CONFLICTED = new Set(CONFLICTS.flatMap((conflict) => conflict.ids))

/** Everything still in the tray — the unaccepted half of the programme. */
const UNSCHEDULED: Array<{ id: string; title: string; duration: number; track: keyof typeof TRACK_TONE }> = [
  { id: 'SESS-110', title: 'Small Models, Big Wins: The Case for 3B Parameters', duration: 30, track: 'Engineering' },
  { id: 'SESS-111', title: 'Observability for LLM Applications', duration: 30, track: 'Product' },
  { id: 'SESS-112', title: "Synthetic Data Pipelines That Don't Lie", duration: 30, track: 'Research' },
  { id: 'SESS-113', title: 'From Notebook to Nginx: Serving Models in Rust', duration: 30, track: 'Engineering' },
  { id: 'SESS-114', title: 'Designing Trustworthy AI Product Experiences', duration: 30, track: 'Product' },
  { id: 'SESS-115', title: 'Guardrails: Structured Outputs Without the Pain', duration: 30, track: 'Engineering' },
  { id: 'SESS-116', title: 'Retrieval Beyond Text: Multimodal RAG', duration: 30, track: 'Research' },
  { id: 'SESS-117', title: 'Blockchain Meets LLMs: A New Paradigm', duration: 30, track: 'Product' },
  { id: 'SESS-118', title: 'Why Prompt Engineering Is Dead', duration: 15, track: 'Product' },
  { id: 'SESS-119', title: 'GPU Poor: Training on a Budget', duration: 30, track: 'Engineering' },
  { id: 'SESS-120', title: 'The Ethics of Autonomous Agents', duration: 30, track: 'Research' },
]

const DAYS: Array<{ day: 1 | 2; label: string }> = [
  { day: 1, label: 'Mon, Oct 12' },
  { day: 2, label: 'Tue, Oct 13' },
]

type AgendaView = 'list' | 'day' | 'week' | 'rooms' | 'conflicts'

const AGENDA_VIEWS: Array<{ id: AgendaView; label: string }> = [
  { id: 'list', label: 'List' },
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'conflicts', label: 'Conflicts' },
]

/* -------------------------------------------------------------------------- */
/* Speakers — `_TASK_ASSIGNMENTS` over the six canonical onboarding tasks       */
/* -------------------------------------------------------------------------- */

interface RosterRow {
  /** Seed contact index. */
  contact: number
  status: 'invited' | 'confirmed' | null
  sessions: number
  done: number
  total: number
  portal: string
  invited: boolean
  tasks: Array<{ name: string; state: 'done' | 'todo' | 'review' | 'redo' }>
}

/** `CANONICAL_TASKS` in services/onboarding.py, in order. */
const CANONICAL_TASKS = [
  'Hotel stay requirement form',
  'Flight reimbursement form',
  'Finalize talk description',
  'Finalize bio/photos',
  'Announce participation',
  'Invite colleagues with speaker discount',
]

/** `_TASK_DUE_DAYS` — deadlines are offsets from the seed, one per task. */
const TASK_DUE_DAYS = [10, 12, 14, 16, 18, 20]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "Aug 26, 2026" — lib/dueDate.ts's format. Resolved from the offset at render
 * so a deadline in this frame is never a date that has already gone by.
 */
function dueDate(daysAhead: number): string {
  const date = new Date(Date.now() + daysAhead * 86_400_000)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

const allDone = CANONICAL_TASKS.map((name) => ({ name, state: 'done' as const }))

const ROSTER: RosterRow[] = [
  {
    contact: 1, status: 'confirmed', sessions: 2, done: 6, total: 6, portal: '2 hours ago', invited: true,
    tasks: allDone,
  },
  {
    contact: 2, status: 'confirmed', sessions: 2, done: 1, total: 4, portal: '1 day ago', invited: false,
    tasks: [
      { name: CANONICAL_TASKS[0], state: 'done' },
      { name: CANONICAL_TASKS[1], state: 'todo' },
      { name: CANONICAL_TASKS[2], state: 'todo' },
      { name: CANONICAL_TASKS[3], state: 'review' },
    ],
  },
  {
    contact: 3, status: 'invited', sessions: 1, done: 0, total: 2, portal: '3 hours ago', invited: false,
    tasks: [
      { name: CANONICAL_TASKS[0], state: 'review' },
      { name: CANONICAL_TASKS[2], state: 'todo' },
    ],
  },
  {
    contact: 4, status: 'confirmed', sessions: 1, done: 6, total: 6, portal: '1 day ago', invited: true,
    tasks: allDone,
  },
  {
    contact: 5, status: 'invited', sessions: 2, done: 2, total: 2, portal: 'Never', invited: false,
    tasks: [
      { name: CANONICAL_TASKS[0], state: 'done' },
      { name: CANONICAL_TASKS[1], state: 'done' },
    ],
  },
  {
    contact: 6, status: 'confirmed', sessions: 1, done: 1, total: 2, portal: '5 hours ago', invited: false,
    tasks: [
      { name: CANONICAL_TASKS[0], state: 'done' },
      { name: CANONICAL_TASKS[1], state: 'todo' },
    ],
  },
  {
    contact: 7, status: null, sessions: 1, done: 0, total: 2, portal: 'Never', invited: false,
    tasks: [
      { name: CANONICAL_TASKS[0], state: 'todo' },
      { name: CANONICAL_TASKS[2], state: 'todo' },
    ],
  },
  {
    contact: 8, status: 'invited', sessions: 1, done: 0, total: 2, portal: '2 days ago', invited: false,
    tasks: [
      { name: CANONICAL_TASKS[3], state: 'redo' },
      { name: CANONICAL_TASKS[0], state: 'todo' },
    ],
  },
  {
    contact: 9, status: null, sessions: 1, done: 0, total: 1, portal: 'Never', invited: false,
    tasks: [{ name: CANONICAL_TASKS[0], state: 'todo' }],
  },
  {
    contact: 10, status: 'confirmed', sessions: 1, done: 6, total: 6, portal: '6 hours ago', invited: false,
    tasks: allDone,
  },
]

const TASK_STATE_LABEL: Record<'done' | 'todo' | 'review' | 'redo', string> = {
  done: 'Done',
  todo: 'Not done',
  review: 'In review',
  redo: 'Needs changes',
}

/* -------------------------------------------------------------------------- */
/* Content — the collected half of onboarding, per speaker x requirement        */
/* -------------------------------------------------------------------------- */

type ContentState = 'received' | 'needs_changes' | 'missing'

const CONTENT_META: Record<ContentState, { label: string; tone: Tone }> = {
  received: { label: 'Received', tone: 'accepted' },
  needs_changes: { label: 'Needs changes', tone: 'pending' },
  missing: { label: 'Missing', tone: 'declined' },
}

/** `CONTENT_TYPES` in services/content_pipeline.py, minus the "other" bucket. */
const REQUIREMENTS: Array<{ key: string; label: string }> = [
  { key: 'slides', label: 'Slides' },
  { key: 'headshot', label: 'Headshot' },
  { key: 'bio', label: 'Bio' },
]

/**
 * Requirement -> the canonical task it is collected against, so a row's due date
 * is the deadline of its soonest outstanding item rather than a made-up one.
 * Slides ride on "Finalize talk description"; headshot and bio on
 * "Finalize bio/photos".
 */
const REQUIREMENT_DUE_DAYS = [TASK_DUE_DAYS[2], TASK_DUE_DAYS[3], TASK_DUE_DAYS[3]]

const CONTENT_MATRIX: Array<{ contact: number; cells: ContentState[] }> = [
  { contact: 1, cells: ['received', 'received', 'received'] },
  { contact: 2, cells: ['missing', 'received', 'received'] },
  { contact: 3, cells: ['missing', 'missing', 'received'] },
  { contact: 4, cells: ['received', 'received', 'received'] },
  { contact: 5, cells: ['missing', 'received', 'received'] },
  { contact: 6, cells: ['received', 'received', 'missing'] },
  { contact: 7, cells: ['missing', 'missing', 'missing'] },
  { contact: 8, cells: ['needs_changes', 'needs_changes', 'received'] },
  { contact: 9, cells: ['missing', 'missing', 'received'] },
  { contact: 10, cells: ['received', 'received', 'received'] },
]

/** The deadline that actually matters for a row: its soonest open requirement. */
function soonestDue(cells: ContentState[]): number | null {
  const open = cells
    .map((cell, index) => (cell === 'received' ? null : REQUIREMENT_DUE_DAYS[index]))
    .filter((days): days is number => days !== null)
  return open.length > 0 ? Math.min(...open) : null
}

const CONTENT_TOTALS = CONTENT_MATRIX.reduce(
  (totals, row) => {
    for (const cell of row.cells) totals[cell] += 1
    return totals
  },
  { received: 0, needs_changes: 0, missing: 0 } as Record<ContentState, number>
)
const CONTENT_TOTAL = CONTENT_MATRIX.length * REQUIREMENTS.length
const CONTENT_OUTSTANDING = CONTENT_MATRIX.filter((row) =>
  row.cells.some((cell) => cell !== 'received')
).length

/* -------------------------------------------------------------------------- */
/* Navigation — AppShell.tsx NAV                                               */
/* -------------------------------------------------------------------------- */

export type ScreenKey = 'submissions' | 'agenda' | 'speakers' | 'content'

interface NavItem {
  label: string
  /** Present only on the four screens this frame actually renders. */
  screen?: ScreenKey
  count?: number
}

const NAV: Array<{ label?: string; items: NavItem[] }> = [
  { items: [{ label: 'Today' }] },
  {
    label: 'Program',
    items: [
      { label: 'Submissions', screen: 'submissions', count: SUBMISSIONS.length },
      { label: 'Forms' },
      { label: 'Evaluation', count: 10 },
      { label: 'Agenda', screen: 'agenda', count: PLACED.length },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Speakers', screen: 'speakers', count: CONTACTS.length },
      { label: 'Content', screen: 'content', count: CONTENT_TOTAL },
      { label: 'Comms' },
    ],
  },
  { label: 'CRM', items: [{ label: 'Directory' }, { label: 'Pipeline' }] },
  { label: 'Configure', items: [{ label: 'Settings' }] },
]

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** "SESS-114" -> 24px tile. Machine values are mono; initials are not. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

/**
 * A person, at whatever size the row wants. A seeded headshot is a real <img>
 * (the files ship with the site); everyone else gets the app's gradient tile,
 * from the same `avatarGradient` the product uses, so the colour is identical.
 */
function Avatar({ contact, size }: { contact: Contact; size: number }) {
  if (contact.photo) {
    return (
      <img
        className="swa-avatar"
        src={contact.photo}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        style={{ width: size, height: size }}
      />
    )
  }
  const [start, end] = avatarGradient(contact.id)
  return (
    <span
      className="swa-avatar swa-avatar-gradient"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundImage: `linear-gradient(145deg, ${start}, ${end})`,
        fontSize: Math.max(9, Math.round(size * 0.34)),
      }}
    >
      {initialsOf(contact.name)}
    </span>
  )
}

/** A 5px dot plus a label in body colour — never a filled badge. */
function Dot({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className="swa-dot" data-tone={tone}>
      {children}
    </span>
  )
}

/** ui/progress.tsx: a 1px rule, 52px wide, filled green to `value / max`. */
function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <span
      className="swa-meter"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <span className="swa-meter-fill" style={{ width: `${pct}%` }} />
    </span>
  )
}

/** Dashboard.tsx StatBlock — mono numeral over a 12.5px muted label. */
function StatBlock({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div className="swa-stat">
      <p className="swa-stat-value">{value}</p>
      <p className="swa-stat-label">
        {label}
        {hint ? <span> · {hint}</span> : null}
      </p>
    </div>
  )
}

function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="swa-pagehead">
      <div className="swa-pagehead-text">
        <h3 className="swa-page-title">{title}</h3>
        <p className="swa-page-subtitle">{subtitle}</p>
      </div>
      {actions ? <div className="swa-actions">{actions}</div> : null}
    </div>
  )
}

/**
 * Every action that would write is inert by construction — a span, not a
 * button, so it can never be focused or activated. The label is still readable:
 * "Publish schedule" is part of what the screenshot says about the product.
 */
function FakeButton({ tone = 'ghost', children }: { tone?: 'ghost' | 'primary'; children: React.ReactNode }) {
  return (
    <span className="swa-btn" data-tone={tone}>
      {children}
    </span>
  )
}

/** The read-only "Find or ask" field from the app's top bar. */
function SearchField({ placeholder, wide }: { placeholder: string; wide?: boolean }) {
  return (
    <span className="swa-field" data-wide={wide ? 'true' : undefined} aria-hidden="true">
      <svg className="swa-field-icon" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="swa-field-text">{placeholder}</span>
    </span>
  )
}

/** A NativeSelect, frozen at its current value. */
function FakeSelect({ label, value }: { label?: string; value: string }) {
  return (
    <span className="swa-selectwrap" aria-hidden="true">
      {label ? <span className="swa-selectlabel">{label}</span> : null}
      <span className="swa-select">
        {value}
        <svg viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Shell chrome                                                                */
/* -------------------------------------------------------------------------- */

/** The mark: an S ribbon woven through a diagonal thread. ui/brand.tsx. */
function BrandMark() {
  return (
    <span className="swa-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <path d="M9.9 22.3 L13.7 18.5" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <path d="M19.8 12.4 L21.8 10.4" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <path
          d="M21.7 9.2c-1.1-1.2-2.8-1.9-4.7-1.9-2.9 0-5 1.6-5 3.9 0 2.1 1.5 3.2 4.3 3.9l1.3.3"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M20.4 16.8c1.8.6 2.7 1.5 2.7 2.9 0 2.3-2.1 3.9-5 3.9-1.9 0-3.6-.7-4.7-1.9"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  )
}

function Chevrons() {
  return (
    <svg className="swa-chevrons" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3.5 4.75 6 2.25l2.5 2.5M3.5 7.25 6 9.75l2.5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** "61 days out" — computed, so the frame never goes stale on the landing page. */
function countdown(): string {
  const days = Math.ceil((EVENT_START - Date.now()) / 86_400_000)
  if (days > 1) return `${days} days out`
  if (days === 1) return '1 day out'
  if (days === 0) return 'starts today'
  return 'event underway'
}

function Rail({ screen, onSelect }: { screen: ScreenKey; onSelect: (next: ScreenKey) => void }) {
  return (
    <div className="swa-rail">
      <div className="swa-brand">
        <BrandMark />
        <span className="swa-wordmark">SpeakerWeave</span>
      </div>

      <div className="swa-eventbox">
        <span className="swa-eventswitch">
          <span className="swa-eventtext">
            <span className="swa-eventname">{EVENT_NAME}</span>
            <span className="swa-eventmeta">
              {EVENT_DATES} · {countdown()}
            </span>
          </span>
          <Chevrons />
        </span>
      </div>

      <nav className="swa-nav" aria-label="Product areas">
        {NAV.map((section, index) => (
          <div className="swa-navgroup" key={section.label ?? `group-${index}`}>
            {section.label ? <div className="swa-section-label">{section.label}</div> : null}
            <div className="swa-navitems">
              {section.items.map((item) =>
                item.screen ? (
                  <button
                    key={item.label}
                    type="button"
                    className="swa-navitem"
                    aria-current={screen === item.screen ? 'page' : undefined}
                    onClick={() => onSelect(item.screen as ScreenKey)}
                  >
                    <span className="swa-navlabel">{item.label}</span>
                    {item.count === undefined ? null : (
                      <span className="swa-navcount">{item.count}</span>
                    )}
                  </button>
                ) : (
                  // Not wired to a screen here, so not a control: same face,
                  // no focus ring, nothing to click.
                  <span key={item.label} className="swa-navitem" data-static="true">
                    <span className="swa-navlabel">{item.label}</span>
                    {item.count === undefined ? null : (
                      <span className="swa-navcount">{item.count}</span>
                    )}
                  </span>
                )
              )}
            </div>
          </div>
        ))}
      </nav>

      <div className="swa-railfoot">
        <span className="swa-account">
          <span
            className="swa-avatar swa-avatar-gradient"
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              backgroundImage: 'linear-gradient(145deg, #DFAB92, #A97FA8)',
              fontSize: 10,
            }}
          >
            DO
          </span>
          <span className="swa-accounttext">
            <span className="swa-accountname">Demo Organizer</span>
            <span className="swa-accountorg">Demo workspace</span>
          </span>
          <Chevrons />
        </span>
      </div>
    </div>
  )
}

function TopBar() {
  return (
    <div className="swa-topbar">
      <span className="swa-search" aria-hidden="true">
        <span className="swa-search-text">Find or ask</span>
        <kbd className="swa-kbd">/</kbd>
      </span>
      <div className="swa-topbar-right">
        <span className="swa-btn swa-topbar-link" data-tone="ghost" aria-hidden="true">
          View public page
        </span>
        <span className="swa-ask" aria-hidden="true">
          <svg viewBox="0 0 14 14" fill="none" className="swa-sparkle">
            <path d="M7 1.4 8.2 5.1 11.9 6.3 8.2 7.5 7 11.2 5.8 7.5 2.1 6.3 5.8 5.1Z" fill="currentColor" />
          </svg>
          Ask
          <kbd className="swa-kbd">⌘K</kbd>
        </span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Screen: Submissions                                                         */
/* -------------------------------------------------------------------------- */

function SubmissionsScreen() {
  const [tab, setTab] = useState<TabKey>('all')
  const [openId, setOpenId] = useState<string | null>('SESS-114')

  const rows = tab === 'all' ? SUBMISSIONS : SUBMISSIONS.filter((row) => row.status === tab)
  const page = rows.slice(0, PAGE_SIZE)
  const count = (key: TabKey) =>
    key === 'all' ? SUBMISSIONS.length : SUBMISSIONS.filter((row) => row.status === key).length

  return (
    <>
      <PageHead
        title="Submissions"
        subtitle={`Review and triage session submissions for ${EVENT_NAME}.`}
        actions={<FakeButton tone="primary">Add submission</FakeButton>}
      />

      <div className="swa-tabs" role="tablist" aria-label="Submission status">
        {SUBMISSION_TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="swa-tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
            <span className="swa-tabcount">{count(key)}</span>
          </button>
        ))}
      </div>

      <div className="swa-toolbar">
        <SearchField placeholder="Search all submissions…" wide />
        <FakeSelect label="Sort" value="Newest first" />
        <FakeSelect label="Track" value="All tracks" />
        <FakeSelect label="Status" value="All statuses" />
        <FakeButton>Options</FakeButton>
      </div>

      <div className="swa-tablewrap">
        <table className="swa-table swa-table-submissions">
          <thead>
            <tr>
              <th>ID</th>
              <th>Source</th>
              <th>Title</th>
              <th>Submitter</th>
              <th>Track</th>
              <th>Score</th>
              <th>Status</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {page.map((row) => {
              const meta = STATUS_META[row.status]
              const contact = who(row.by)
              return (
                <tr
                  key={row.id}
                  className="swa-row"
                  tabIndex={0}
                  data-selected={openId === row.id ? 'true' : undefined}
                  aria-label={`${row.title}, ${meta.label}`}
                  onClick={() => setOpenId(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setOpenId(row.id)
                    }
                  }}
                >
                  <td className="swa-mono swa-muted">{row.id}</td>
                  <td className="swa-muted">Form</td>
                  <td>
                    <span className="swa-title">{row.title}</span>
                  </td>
                  <td>
                    <span className="swa-person">
                      <Avatar contact={contact} size={24} />
                      <span className="swa-persontext">
                        <span className="swa-personname">{contact.name}</span>
                        <span className="swa-personmeta">{contact.email}</span>
                      </span>
                    </span>
                  </td>
                  <td className="swa-muted">{row.track}</td>
                  <td className="swa-mono swa-score">{row.score}</td>
                  <td>
                    <Dot tone={meta.tone}>{meta.label}</Dot>
                  </td>
                  <td className="swa-mono swa-muted swa-tiny">{row.submitted}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="swa-tablefoot">
        <span>
          1–{page.length} of {rows.length} rows
        </span>
        <span className="swa-pager" aria-hidden="true">
          <span className="swa-pagebtn">‹</span>
          <span className="swa-pagebtn" data-current="true">
            1
          </span>
          {rows.length > PAGE_SIZE ? <span className="swa-pagebtn">2</span> : null}
          <span className="swa-pagebtn">›</span>
        </span>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Screen: Agenda                                                              */
/* -------------------------------------------------------------------------- */

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

function SpeakerChips({ ids, size = 18 }: { ids: number[]; size?: number }) {
  return (
    <span className="swa-chips">
      {ids.map((index) => {
        const contact = who(index)
        const [start, end] = avatarGradient(contact.id)
        return (
          <span
            key={contact.id}
            className="swa-avatar swa-avatar-gradient"
            title={contact.name}
            aria-hidden="true"
            style={{
              width: size,
              height: size,
              backgroundImage: `linear-gradient(145deg, ${start}, ${end})`,
              fontSize: Math.max(9, Math.round(size * 0.34)),
            }}
          >
            {initialsOf(contact.name)}
          </span>
        )
      })}
    </span>
  )
}

function GridCard({ session }: { session: Placed }) {
  const slots = Math.max(1, Math.ceil(session.duration / SLOT_MIN))
  const conflicted = CONFLICTED.has(session.id)
  // A 30-minute card gets one line of title and an inline meta row; one slot has
  // no room for a second line at all. Same rule as Agenda.tsx's `dense`.
  const dense = session.duration <= 30
  return (
    <div
      className="swa-card swa-card-placed"
      data-conflicted={conflicted ? 'true' : undefined}
      data-single={slots === 1 ? 'true' : undefined}
      style={{
        top: ((session.start - WINDOW_START) / SLOT_MIN) * SLOT_PX + 1,
        height: slots * SLOT_PX - 2,
      }}
    >
      <span className="swa-cardbar" data-tone={TRACK_TONE[session.track]} />
      <span className="swa-cardbody">
        <span className="swa-cardtitle" data-single={slots === 1 || dense ? 'true' : undefined}>
          {conflicted ? <span className="swa-conflictdot" aria-label="Has a conflict" /> : null}
          {session.title}
        </span>
        {slots === 1 ? null : (
          <span className="swa-cardmeta">
            <span className="swa-mono swa-cardtime">
              {clock(session.start)} – {clock(session.start + session.duration)}
              <span className="swa-cardduration"> · {duration(session.duration)}</span>
            </span>
            <SpeakerChips ids={session.speakers} />
          </span>
        )}
      </span>
    </div>
  )
}

function ConflictsPanel() {
  return (
    <div className="swa-conflicts" data-count={CONFLICTS.length}>
      <div className="swa-conflicthead">
        <span className="swa-conflictdot" />
        <span className="swa-conflicttitle">Conflicts ({CONFLICTS.length})</span>
      </div>
      <ul className="swa-conflictlist">
        {CONFLICTS.map((conflict) => (
          <li key={conflict.detail}>
            <span className="swa-conflictdetail">{conflict.detail}</span>
            <span className="swa-conflictpair">
              {conflict.pair[0]} ↔ {conflict.pair[1]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RoomGrid({ day }: { day: 1 | 2 }) {
  const hours: number[] = []
  for (let minutes = WINDOW_START; minutes <= WINDOW_END; minutes += 60) hours.push(minutes)

  return (
    <div className="swa-gridwrap">
      <div className="swa-grid">
        <div className="swa-gridhead">
          <div className="swa-gutter-head" />
          {ROOMS.map((room) => (
            <div className="swa-roomhead" key={room.id}>
              <div className="swa-roomname">{room.name}</div>
              <div className="swa-mono swa-roomcap">Capacity {room.capacity}</div>
            </div>
          ))}
        </div>

        <div className="swa-gridbody">
          <div className="swa-gutter" style={{ height: SLOT_COUNT * SLOT_PX }}>
            {hours.map((minutes) => (
              <span
                className="swa-mono swa-gutterlabel"
                key={minutes}
                style={{ top: ((minutes - WINDOW_START) / SLOT_MIN) * SLOT_PX }}
              >
                {clock(minutes)}
              </span>
            ))}
          </div>

          {ROOMS.map((room) => (
            <div className="swa-roomcol" key={room.id}>
              <div className="swa-lattice" style={{ height: SLOT_COUNT * SLOT_PX }}>
                {Array.from({ length: SLOT_COUNT }, (_, slot) => (
                  <div
                    key={slot}
                    className="swa-slot"
                    data-hour={slot % 4 === 0 ? 'true' : undefined}
                    style={{ height: SLOT_PX }}
                  />
                ))}
              </div>
              <div className="swa-cardlayer">
                {PLACED.filter((session) => session.day === day && session.room === room.id).map(
                  (session) => (
                    <GridCard key={session.id} session={session} />
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AgendaScreen() {
  const [view, setView] = useState<AgendaView>('rooms')
  const [day, setDay] = useState<1 | 2>(1)

  const scheduled = [...PLACED].sort((a, b) => a.day - b.day || a.start - b.start)

  return (
    <>
      <PageHead
        title="Agenda"
        subtitle={`Drag a session onto the grid for ${EVENT_NAME}, or hit Place and click a slot. Conflicts are flagged live, before you drop.`}
        actions={
          <>
            <span className="swa-mono swa-countnote">
              {PLACED.length} scheduled · {UNSCHEDULED.length} unscheduled
            </span>
            <FakeButton>Refresh</FakeButton>
            <FakeButton>Auto-place remaining ({UNSCHEDULED.length})</FakeButton>
            <FakeButton tone="primary">Publish schedule</FakeButton>
          </>
        }
      />

      <div className="swa-viewtabs" role="tablist" aria-label="Agenda views">
        {AGENDA_VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="swa-viewtab"
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {label}
            {id === 'conflicts' ? <span className="swa-tabcount">{CONFLICTS.length}</span> : null}
          </button>
        ))}
      </div>

      {view === 'list' ? (
        <>
          <p className="swa-mono swa-tznote">Times shown in America/Los_Angeles (PDT)</p>
          <ul className="swa-list">
            {scheduled.map((session) => (
              <li className="swa-listrow" key={session.id}>
                <span className="swa-mono swa-listtime">
                  {clock(session.start)} – {clock(session.start + session.duration)}
                </span>
                <span className="swa-listbar" data-tone={TRACK_TONE[session.track]} />
                <span className="swa-listtext">
                  <span className="swa-listtitle">
                    <span className="swa-listname">{session.title}</span>
                    {CONFLICTED.has(session.id) ? (
                      <span className="swa-inlineconflict">
                        <span className="swa-conflictdot" /> Conflict
                      </span>
                    ) : null}
                  </span>
                  <span className="swa-mono swa-listmeta">
                    {ROOMS.find((room) => room.id === session.room)?.name} ·{' '}
                    {duration(session.duration)} ·{' '}
                    {session.speakers.map((index) => who(index).name).join(', ')}
                  </span>
                </span>
                <SpeakerChips ids={session.speakers} />
              </li>
            ))}
          </ul>
        </>
      ) : view === 'conflicts' ? (
        <div className="swa-conflictview">
          <ConflictsPanel />
          <div className="swa-flagged">
            {PLACED.filter((session) => CONFLICTED.has(session.id)).map((session) => (
              <div className="swa-card swa-card-flat" key={session.id}>
                <span className="swa-cardbar" data-tone={TRACK_TONE[session.track]} />
                <span className="swa-cardbody">
                  <span className="swa-cardtitle">
                    <span className="swa-conflictdot" />
                    {session.title}
                  </span>
                  <span className="swa-cardmeta">
                    <span className="swa-mono swa-cardtime">
                      {clock(session.start)} – {clock(session.start + session.duration)}
                      <span className="swa-cardduration"> · {duration(session.duration)}</span>
                    </span>
                    <SpeakerChips ids={session.speakers} />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="swa-dayrow">
            <div className="swa-dayswitch" role="tablist" aria-label="Conference day">
              {DAYS.map((entry, index) => (
                <button
                  key={entry.day}
                  type="button"
                  role="tab"
                  className="swa-daytab"
                  aria-selected={day === entry.day}
                  onClick={() => setDay(entry.day)}
                >
                  <span className="swa-daynum">Day {index + 1}</span>
                  {entry.label}
                </button>
              ))}
            </div>
            <p className="swa-mono swa-tznote">Times shown in America/Los_Angeles (PDT)</p>
          </div>

          {view === 'day' ? (
            <p className="swa-viewnote">
              Day view spans every room for the event day — drag to reschedule, exactly like Rooms.
            </p>
          ) : null}
          {view === 'week' ? (
            <p className="swa-viewnote">
              Week view rolls up to the room grid for now — drag sessions the same way you do in
              Rooms.
            </p>
          ) : null}

          <ConflictsPanel />

          <div className="swa-agendabody">
            <div className="swa-tray">
              <div className="swa-trayhead">
                <span>Unscheduled</span>
                <span className="swa-mono swa-traycount">{UNSCHEDULED.length}</span>
              </div>
              <div className="swa-traylist">
                {UNSCHEDULED.map((session) => (
                  <div className="swa-card swa-card-tray" key={session.id}>
                    <span className="swa-cardbar" data-tone={TRACK_TONE[session.track]} />
                    <span className="swa-cardbody">
                      <span className="swa-cardtitle swa-cardtitle-tray">{session.title}</span>
                      <span className="swa-mono swa-cardtime">{duration(session.duration)}</span>
                    </span>
                    <span className="swa-place" aria-hidden="true">
                      Place
                    </span>
                  </div>
                ))}
              </div>
              <p className="swa-traynote">
                15-minute slots, 08:00–18:00. Drop a scheduled card back here to unschedule it.
              </p>
            </div>

            <RoomGrid day={day} />
          </div>
        </>
      )}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Screen: Speakers                                                            */
/* -------------------------------------------------------------------------- */

const WORKFLOW_META: Record<'invited' | 'confirmed', { label: string; tone: Tone }> = {
  invited: { label: 'Invited', tone: 'pending' },
  confirmed: { label: 'Confirmed', tone: 'accepted' },
}

function SpeakersScreen() {
  const [expanded, setExpanded] = useState<number | null>(2)

  return (
    <>
      <PageHead
        title="Speakers"
        subtitle={`Manage your speaker roster, onboarding, and communications for ${EVENT_NAME}.`}
        actions={
          <>
            <FakeButton>Import CSV</FakeButton>
            <FakeButton>Export CSV</FakeButton>
            <FakeButton tone="primary">Add speaker</FakeButton>
          </>
        }
      />

      <div className="swa-toolbar">
        <SearchField placeholder="Search name, email, or company" wide />
        <FakeSelect value="All onboarding" />
        <FakeSelect value="All speakers" />
        <FakeSelect value="Any status" />
        <FakeButton>Add task</FakeButton>
      </div>

      <div className="swa-tablewrap">
        <table className="swa-table swa-table-speakers">
          <thead>
            <tr>
              <th>Speaker</th>
              <th>Company</th>
              <th>Status</th>
              <th>Sessions</th>
              <th>Onboarding</th>
              <th>Last portal visit</th>
              <th className="swa-right">Invite</th>
            </tr>
          </thead>
          <tbody>
            {ROSTER.map((row) => {
              const contact = who(row.contact)
              const open = expanded === row.contact
              const complete = row.done === row.total
              return (
                <Fragment key={contact.id}>
                <tr className="swa-row">
                  <td>
                    <span className="swa-person">
                      <Avatar contact={contact} size={24} />
                      <span className="swa-persontext">
                        <span className="swa-personname">{contact.name}</span>
                        <span className="swa-personmeta">{contact.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className="swa-persontext">
                      <span className="swa-companyname">{contact.company}</span>
                      <span className="swa-personmeta">{contact.role}</span>
                    </span>
                  </td>
                  <td>
                    {row.status ? (
                      <Dot tone={WORKFLOW_META[row.status].tone}>{WORKFLOW_META[row.status].label}</Dot>
                    ) : (
                      <span className="swa-muted">—</span>
                    )}
                  </td>
                  <td className="swa-mono swa-num">{row.sessions}</td>
                  <td>
                    <button
                      type="button"
                      className="swa-onboarding"
                      aria-expanded={open}
                      aria-label={`${open ? 'Hide' : 'Show'} tasks for ${contact.name}`}
                      onClick={() => setExpanded(open ? null : row.contact)}
                    >
                      <Meter
                        value={row.done}
                        max={row.total}
                        label={`${contact.name} onboarding progress`}
                      />
                      {complete ? (
                        <Dot tone="accepted">Done</Dot>
                      ) : (
                        <span className="swa-mono swa-tiny swa-muted">
                          {row.done}/{row.total}
                        </span>
                      )}
                      <svg
                        className="swa-caret"
                        data-open={open ? 'true' : undefined}
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </button>
                  </td>
                  <td className="swa-mono swa-tiny swa-muted">{row.portal}</td>
                  <td className="swa-right">
                    <FakeButton tone={row.invited ? 'ghost' : 'primary'}>
                      {row.invited ? 'Resend' : 'Send invite'}
                    </FakeButton>
                  </td>
                </tr>
                {open ? (
                  <tr className="swa-subrow">
                    <td colSpan={7}>
                      <ul className="swa-tasklist" aria-label={`Tasks for ${contact.name}`}>
                        {row.tasks.map((task) => (
                          <li key={task.name}>
                            <span
                              className="swa-taskdot"
                              data-tone={task.state === 'done' ? 'accepted' : 'neutral'}
                            />
                            <span className="swa-taskname" data-done={task.state === 'done' ? 'true' : undefined}>
                              {task.name}{' '}
                              <span className="swa-faint">· {TASK_STATE_LABEL[task.state]}</span>
                            </span>
                            <span className="swa-mono swa-faint swa-taskdue">
                              Due {dueDate(TASK_DUE_DAYS[CANONICAL_TASKS.indexOf(task.name)] ?? 14)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Screen: Content                                                             */
/* -------------------------------------------------------------------------- */

function ContentScreen() {
  const [picked, setPicked] = useState<number | null>(8)

  return (
    <>
      <PageHead
        title="Content"
        subtitle={`Every slide deck, headshot and bio your speakers have sent for ${EVENT_NAME}.`}
        actions={
          <>
            <FakeButton>Remind outstanding ({CONTENT_OUTSTANDING})</FakeButton>
            <FakeButton tone="primary">Export all content</FakeButton>
          </>
        }
      />

      <div className="swa-stats">
        <StatBlock value={CONTENT_TOTAL} label="Total" />
        <StatBlock
          value={CONTENT_TOTALS.received}
          label="Received"
          hint={`${Math.round((CONTENT_TOTALS.received / CONTENT_TOTAL) * 100)}% collected`}
        />
        <StatBlock value={CONTENT_TOTALS.needs_changes} label="Needs changes" />
        <StatBlock value={CONTENT_TOTALS.missing} label="Missing" />
      </div>

      <div className="swa-toolbar">
        <FakeSelect value="All types" />
        <FakeSelect value="All statuses" />
        <span className="swa-mono swa-tiny swa-faint swa-toolbar-end">
          {CONTENT_MATRIX.length} of {CONTENT_MATRIX.length}
        </span>
      </div>

      <div className="swa-tablewrap">
        <table className="swa-table swa-table-content">
          <thead>
            <tr>
              <th>Speaker</th>
              {REQUIREMENTS.map((requirement) => (
                <th key={requirement.key}>{requirement.label}</th>
              ))}
              <th>Due</th>
              <th>Collected</th>
            </tr>
          </thead>
          <tbody>
            {CONTENT_MATRIX.map((row) => {
              const contact = who(row.contact)
              const done = row.cells.filter((cell) => cell === 'received').length
              const due = soonestDue(row.cells)
              return (
                <tr
                  key={contact.id}
                  className="swa-row"
                  tabIndex={0}
                  data-selected={picked === row.contact ? 'true' : undefined}
                  aria-label={`${contact.name}, ${done} of ${REQUIREMENTS.length} collected`}
                  onClick={() => setPicked(row.contact)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setPicked(row.contact)
                    }
                  }}
                >
                  <td>
                    <span className="swa-person">
                      <Avatar contact={contact} size={24} />
                      <span className="swa-persontext">
                        <span className="swa-personname">{contact.name}</span>
                        <span className="swa-personmeta">{contact.company}</span>
                      </span>
                    </span>
                  </td>
                  {row.cells.map((cell, index) => (
                    <td key={REQUIREMENTS[index].key}>
                      <Dot tone={CONTENT_META[cell].tone}>{CONTENT_META[cell].label}</Dot>
                    </td>
                  ))}
                  <td>
                    {due === null ? (
                      <span className="swa-mono swa-tiny swa-faint">—</span>
                    ) : (
                      <span className="swa-mono swa-tiny">{dueDate(due)}</span>
                    )}
                  </td>
                  <td>
                    <span className="swa-collected">
                      <Meter
                        value={done}
                        max={REQUIREMENTS.length}
                        label={`${contact.name} content collected`}
                      />
                      <span className="swa-mono swa-tiny swa-muted">
                        {done}/{REQUIREMENTS.length}
                      </span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="swa-tablefoot">
        {CONTENT_OUTSTANDING} speakers still outstanding on required content.
      </p>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                       */
/* -------------------------------------------------------------------------- */

const SCREEN_TABS: Array<{ key: ScreenKey; label: string }> = [
  { key: 'submissions', label: 'Submissions' },
  { key: 'agenda', label: 'Agenda' },
  { key: 'speakers', label: 'Speakers' },
  { key: 'content', label: 'Content' },
]

/**
 * The admin interface, real DOM rather than a screenshot.
 *
 * Uncontrolled by default; pass `screen` to drive it from outside (the landing
 * page's benefit tabs do), and `onScreenChange` to hear about clicks on its own
 * rail so the outside stays in step.
 */
export function AppWindow({
  screen: controlled,
  onScreenChange,
}: {
  screen?: ScreenKey
  onScreenChange?: (next: ScreenKey) => void
} = {}): JSX.Element {
  const [own, setOwn] = useState<ScreenKey>('submissions')
  const screen = controlled ?? own
  const setScreen = (next: ScreenKey) => {
    setOwn(next)
    onScreenChange?.(next)
  }

  return (
    <div className="swa-frame" role="group" aria-label="SpeakerWeave admin interface">
      <div className="swa-shell">
        <Rail screen={screen} onSelect={setScreen} />

        <div className="swa-main">
          {/* Under 900px the rail is gone; the same four destinations ride
              above the top bar so the frame stays navigable on a phone. */}
          <nav className="swa-compactnav" aria-label="Product areas">
            {SCREEN_TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="swa-compactitem"
                aria-current={screen === entry.key ? 'page' : undefined}
                onClick={() => setScreen(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <TopBar />

          <div className="swa-page">
            {screen === 'submissions' ? <SubmissionsScreen /> : null}
            {screen === 'agenda' ? <AgendaScreen /> : null}
            {screen === 'speakers' ? <SpeakersScreen /> : null}
            {screen === 'content' ? <ContentScreen /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
