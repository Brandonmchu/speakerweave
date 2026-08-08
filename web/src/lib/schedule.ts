/**
 * Pure scheduling model + conflict detection for the agenda grid.
 *
 * Deliberately framework-free and side-effect-free so it can be unit tested in
 * isolation and, later, mirrored 1:1 by the Python implementation against the
 * same JSON fixtures (PLAN.md §3 — "one canonical fixture suite consumed by
 * BOTH the TS and Python implementations").
 *
 * Time is modelled as *minutes from the start of the conference day* rather
 * than as timestamps. The grid is a fixed slot lattice (15 minutes), so integer
 * minute offsets keep every comparison exact — no timezone maths, no DST edge
 * cases, no floating point. Turning an offset into a real timestamp is the
 * server's job at save time.
 */

/** Width of one grid slot, in minutes. */
export const SLOT_MINUTES = 15
/** 09:00 — first bookable minute of the day. */
export const DAY_START_MIN = 9 * 60
/** 17:00 — first minute that is no longer bookable (half-open, like intervals). */
export const DAY_END_MIN = 17 * 60
/** Number of rows in the grid: 32. */
export const SLOT_COUNT = (DAY_END_MIN - DAY_START_MIN) / SLOT_MINUTES

export interface SpikeSession {
  id: string
  title: string
  speakerIds: string[]
  /** Always a multiple of SLOT_MINUTES for the fixed-slot grid. */
  durationMin: number
  /** Palette key, resolved to Tailwind classes by the view layer. */
  color: string
  /** null / undefined = not placed in a room yet. */
  roomId?: string | null
  /** Minutes from midnight; null / undefined = unscheduled. */
  startMin?: number | null
}

export type ConflictType = 'room_overlap' | 'speaker_overlap'

export interface Conflict {
  type: ConflictType
  /** Always ordered by (startMin, id) so the pair is stable across runs. */
  sessionIds: [string, string]
  /** Human-readable, operator-facing. e.g. "Ada Lovelace is in two rooms at 09:30". */
  detail: string
}

/**
 * Display names used to build `detail` strings. Optional — without them the
 * detection is identical, the messages just fall back to raw ids.
 */
export interface ScheduleLabels {
  speakers?: Record<string, string>
  rooms?: Record<string, string>
}

/** A session that is definitely placed: both a room and a start time. */
export type ScheduledSession = SpikeSession & { roomId: string; startMin: number }

/** A session participates in conflict detection only once it has room + time. */
export function isScheduled(session: SpikeSession): session is ScheduledSession {
  return (
    session.roomId != null &&
    session.roomId !== '' &&
    session.startMin != null &&
    Number.isFinite(session.startMin)
  )
}

/** Exclusive end of the session's half-open interval [start, end). */
export function endMin(session: ScheduledSession): number {
  return session.startMin + session.durationMin
}

/** How many grid rows a session occupies. */
export function durationSlots(session: Pick<SpikeSession, 'durationMin'>): number {
  return Math.max(1, Math.ceil(session.durationMin / SLOT_MINUTES))
}

export function slotToMinutes(slot: number): number {
  return DAY_START_MIN + slot * SLOT_MINUTES
}

export function minutesToSlot(minutes: number): number {
  return Math.round((minutes - DAY_START_MIN) / SLOT_MINUTES)
}

/** 570 -> "09:30". 24h clock keeps the grid gutter narrow and unambiguous. */
export function formatMinutes(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "09:30 – 10:15" for a placed session. */
export function formatRange(session: ScheduledSession): string {
  return `${formatMinutes(session.startMin)} – ${formatMinutes(endMin(session))}`
}

export function formatDuration(durationMin: number): string {
  if (durationMin < 60) return `${durationMin} min`
  const h = Math.floor(durationMin / 60)
  const m = durationMin % 60
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`
}

/**
 * HALF-OPEN overlap: [aStart, aEnd) vs [bStart, bEnd).
 * A session ending at minute X does NOT collide with one starting at X, which
 * is the whole point — back-to-back programming is the normal case.
 * Returns the first shared minute, or null when they merely touch / miss.
 */
export function overlapStart(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): number | null {
  const start = Math.max(aStart, bStart)
  const end = Math.min(aEnd, bEnd)
  return start < end ? start : null
}

function speakerName(id: string, labels: ScheduleLabels): string {
  return labels.speakers?.[id] ?? id
}

function roomName(id: string, labels: ScheduleLabels): string {
  return labels.rooms?.[id] ?? id
}

/** Stable pair ordering: earlier start first, id as the tiebreak. */
function orderPair(a: ScheduledSession, b: ScheduledSession): [string, string] {
  if (a.startMin < b.startMin) return [a.id, b.id]
  if (b.startMin < a.startMin) return [b.id, a.id]
  return a.id <= b.id ? [a.id, b.id] : [b.id, a.id]
}

/**
 * Every conflict between exactly two placed sessions.
 *
 * A pair can produce more than one conflict — same room *and* a shared speaker
 * is two distinct problems, and two shared speakers are two distinct problems
 * too, because the operator has to resolve each by name.
 */
export function pairConflicts(
  a: ScheduledSession,
  b: ScheduledSession,
  labels: ScheduleLabels = {}
): Conflict[] {
  const at = overlapStart(a.startMin, endMin(a), b.startMin, endMin(b))
  if (at === null) return []

  const sessionIds = orderPair(a, b)
  const when = formatMinutes(at)
  const sameRoom = a.roomId === b.roomId
  const conflicts: Conflict[] = []

  if (sameRoom) {
    conflicts.push({
      type: 'room_overlap',
      sessionIds,
      detail: `${roomName(a.roomId, labels)} is double-booked at ${when}`,
    })
  }

  const bSpeakers = new Set(b.speakerIds)
  for (const speakerId of a.speakerIds) {
    if (!bSpeakers.has(speakerId)) continue
    conflicts.push({
      type: 'speaker_overlap',
      sessionIds,
      detail: sameRoom
        ? `${speakerName(speakerId, labels)} is booked twice at ${when}`
        : `${speakerName(speakerId, labels)} is in two rooms at ${when}`,
    })
  }

  return conflicts
}

/**
 * Full sweep over the schedule. Unscheduled sessions are ignored entirely.
 *
 * Sorting by start lets the inner loop stop as soon as a candidate starts at or
 * after the current session's end — everything later starts later still. In
 * practice that is near-linear for a real agenda, which matters because this
 * runs on every drop and on every mutation of the session list.
 */
export function detectConflicts(
  sessions: SpikeSession[],
  labels: ScheduleLabels = {}
): Conflict[] {
  const placed = sessions
    .filter(isScheduled)
    .sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id))

  const conflicts: Conflict[] = []
  for (let i = 0; i < placed.length; i += 1) {
    const a = placed[i]
    const aEnd = endMin(a)
    for (let j = i + 1; j < placed.length; j += 1) {
      const b = placed[j]
      if (b.startMin >= aEnd) break
      conflicts.push(...pairConflicts(a, b, labels))
    }
  }
  return conflicts
}

/**
 * The *delta* used while dragging: conflicts introduced by one candidate
 * placement, checked against everything else. O(n) instead of O(n²), so a
 * pointer move never pays for the whole schedule (PLAN.md §3: "during drag:
 * evaluate the dragged session against candidates only").
 */
export function conflictsForSession(
  candidate: SpikeSession,
  others: SpikeSession[],
  labels: ScheduleLabels = {}
): Conflict[] {
  if (!isScheduled(candidate)) return []
  const conflicts: Conflict[] = []
  for (const other of others) {
    if (other.id === candidate.id) continue
    if (!isScheduled(other)) continue
    conflicts.push(...pairConflicts(candidate, other, labels))
  }
  return conflicts
}

export interface Lane {
  /** 0-based column within the overlapping cluster. */
  lane: number
  /** How many columns that cluster needs. */
  lanes: number
}

/**
 * Side-by-side placement for sessions that overlap inside one room.
 *
 * Without this, a double-booked room renders one card exactly on top of the
 * other and the conflict becomes invisible — the opposite of what the red ring
 * is for. Sessions are grouped into clusters of transitively-overlapping
 * sessions, then greedily packed into the fewest lanes; every card in a cluster
 * shares the cluster's lane count so their widths line up.
 */
export function assignLanes(sessions: ScheduledSession[]): Map<string, Lane> {
  const sorted = [...sessions].sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id))
  const result = new Map<string, Lane>()

  let cluster: ScheduledSession[] = []
  let clusterEnd = Number.NEGATIVE_INFINITY

  const flush = () => {
    if (cluster.length === 0) return
    /** Exclusive end of the last session placed in each lane. */
    const laneEnds: number[] = []
    const laneOf = new Map<string, number>()
    for (const session of cluster) {
      // Half-open again: a lane freed at exactly this start is reusable.
      let lane = laneEnds.findIndex((end) => end <= session.startMin)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(0)
      }
      laneEnds[lane] = endMin(session)
      laneOf.set(session.id, lane)
    }
    for (const session of cluster) {
      result.set(session.id, { lane: laneOf.get(session.id) ?? 0, lanes: laneEnds.length })
    }
    cluster = []
    clusterEnd = Number.NEGATIVE_INFINITY
  }

  for (const session of sorted) {
    if (cluster.length > 0 && session.startMin >= clusterEnd) flush()
    cluster.push(session)
    clusterEnd = Math.max(clusterEnd, endMin(session))
  }
  flush()

  return result
}

/** Ids of every session touched by at least one conflict — drives the red ring. */
export function conflictedSessionIds(conflicts: Conflict[]): Set<string> {
  const ids = new Set<string>()
  for (const conflict of conflicts) {
    ids.add(conflict.sessionIds[0])
    ids.add(conflict.sessionIds[1])
  }
  return ids
}

/** Keep a placement inside the day: a session may not spill past DAY_END_MIN. */
export function clampStartSlot(slot: number, session: Pick<SpikeSession, 'durationMin'>): number {
  const max = Math.max(0, SLOT_COUNT - durationSlots(session))
  return Math.min(Math.max(slot, 0), max)
}
