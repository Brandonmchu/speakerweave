import { useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { restrictToWindowEdges } from '@dnd-kit/modifiers'
import { AlertTriangle, CalendarDays, CheckCircle2, Inbox, RotateCcw } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  assignLanes,
  clampStartSlot,
  conflictedSessionIds,
  conflictsForSession,
  detectConflicts,
  durationSlots,
  formatDuration,
  formatMinutes,
  formatRange,
  isScheduled,
  minutesToSlot,
  slotToMinutes,
  DAY_START_MIN,
  SLOT_COUNT,
  SLOT_MINUTES,
  type Conflict,
  type ScheduleLabels,
  type SpikeSession,
} from '@/lib/schedule'
import { Button } from '@/ui/button'

/* -------------------------------------------------------------------------- */
/* SPIKE — client-side only, hardcoded data, zero backend calls.              */
/*                                                                            */
/* This is the PLAN.md §6 Day-0 go/no-go for the agenda builder: a fixed-slot  */
/* room x time grid with constrained drag and live conflict highlighting. The  */
/* geometry and the drag mechanics here are meant to survive into the real     */
/* builder; only the data source is throwaway.                                */
/* -------------------------------------------------------------------------- */

/** Pixel height of one 15-minute slot. 32 slots => a 768px day. */
const SLOT_PX = 24
const GRID_HEIGHT = SLOT_COUNT * SLOT_PX

interface Room {
  id: string
  name: string
  capacity: number
}

const ROOMS: Room[] = [
  { id: 'room-a', name: 'Main Hall', capacity: 400 },
  { id: 'room-b', name: 'Workshop Room', capacity: 60 },
]

const SPEAKERS: Record<string, { name: string; initials: string }> = {
  ada: { name: 'Ada Lovelace', initials: 'AL' },
  grace: { name: 'Grace Hopper', initials: 'GH' },
  alan: { name: 'Alan Turing', initials: 'AT' },
}

const LABELS: ScheduleLabels = {
  speakers: Object.fromEntries(Object.entries(SPEAKERS).map(([id, s]) => [id, s.name])),
  rooms: Object.fromEntries(ROOMS.map((r) => [r.id, r.name])),
}

/**
 * Five sessions across three speakers. Two are pre-scheduled and deliberately
 * collide (Ada is in both rooms at 09:30) so the conflict panel has something to
 * say on first paint — mirrors the seeded demo requirement in PLAN.md §5.
 */
function seedSessions(): SpikeSession[] {
  return [
    {
      id: 'sess-keynote',
      title: 'Opening Keynote: The Analytical Engine at 200',
      speakerIds: ['ada'],
      durationMin: 45,
      color: 'indigo',
      roomId: 'room-a',
      startMin: 9 * 60 + 30,
    },
    {
      id: 'sess-compilers',
      title: 'Hands-on: Compilers from Scratch',
      speakerIds: ['ada', 'grace'],
      durationMin: 60,
      color: 'violet',
      roomId: 'room-b',
      startMin: 9 * 60 + 30,
    },
    {
      id: 'sess-debugging',
      title: 'Debugging the Undebuggable',
      speakerIds: ['alan'],
      durationMin: 30,
      color: 'sky',
      roomId: null,
      startMin: null,
    },
    {
      id: 'sess-types',
      title: 'Type Systems for Conference Ops',
      speakerIds: ['grace', 'alan'],
      durationMin: 45,
      color: 'emerald',
      roomId: null,
      startMin: null,
    },
    {
      id: 'sess-committee',
      title: 'Scaling the Program Committee',
      speakerIds: ['ada'],
      durationMin: 60,
      color: 'amber',
      roomId: null,
      startMin: null,
    },
  ]
}

/**
 * Full class strings so Tailwind's scanner can see them — never build these by
 * interpolation.
 */
const PALETTE: Record<string, { surface: string; bar: string; title: string; meta: string; chip: string }> = {
  indigo: {
    surface: 'bg-indigo-50 border-indigo-200',
    bar: 'bg-indigo-500',
    title: 'text-indigo-950',
    meta: 'text-indigo-700',
    chip: 'bg-indigo-100 text-indigo-700 ring-indigo-200',
  },
  violet: {
    surface: 'bg-violet-50 border-violet-200',
    bar: 'bg-violet-500',
    title: 'text-violet-950',
    meta: 'text-violet-700',
    chip: 'bg-violet-100 text-violet-700 ring-violet-200',
  },
  sky: {
    surface: 'bg-sky-50 border-sky-200',
    bar: 'bg-sky-500',
    title: 'text-sky-950',
    meta: 'text-sky-700',
    chip: 'bg-sky-100 text-sky-700 ring-sky-200',
  },
  emerald: {
    surface: 'bg-emerald-50 border-emerald-200',
    bar: 'bg-emerald-500',
    title: 'text-emerald-950',
    meta: 'text-emerald-700',
    chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  },
  amber: {
    surface: 'bg-amber-50 border-amber-200',
    bar: 'bg-amber-500',
    title: 'text-amber-950',
    meta: 'text-amber-700',
    chip: 'bg-amber-100 text-amber-700 ring-amber-200',
  },
}

function palette(color: string) {
  return PALETTE[color] ?? PALETTE.indigo
}

/* -------------------------------------------------------------------------- */
/* Droppable identity                                                         */
/* -------------------------------------------------------------------------- */

type DropData = { type: 'cell'; roomId: string; slot: number } | { type: 'unscheduled' }

const UNSCHEDULED_ID = 'zone:unscheduled'
const cellId = (roomId: string, slot: number) => `cell:${roomId}:${slot}`

/** Where a drag would land, plus the conflicts that placement would create. */
interface Preview {
  roomId: string
  startSlot: number
  slots: number
  conflicts: Conflict[]
}

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

function SpeakerChips({ session, className }: { session: SpikeSession; className?: string }) {
  const colors = palette(session.color)
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {session.speakerIds.map((id) => {
        const speaker = SPEAKERS[id]
        return (
          <span
            key={id}
            title={speaker?.name ?? id}
            className={cn(
              'flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ring-1',
              colors.chip
            )}
          >
            {speaker?.initials ?? id.slice(0, 2).toUpperCase()}
          </span>
        )
      })}
    </div>
  )
}

/**
 * One session card. Shared by the sidebar, the grid and the drag overlay so the
 * preview is pixel-identical to the thing being dragged.
 */
function SessionCard({
  session,
  conflicted,
  dense,
  dragging,
  className,
}: {
  session: SpikeSession
  conflicted?: boolean
  /** 30-minute cards get one line of title and an inline meta row. */
  dense?: boolean
  dragging?: boolean
  className?: string
}) {
  const colors = palette(session.color)
  const timing = isScheduled(session) ? formatRange(session) : formatDuration(session.durationMin)

  return (
    <div
      className={cn(
        'relative flex h-full overflow-hidden rounded-md border shadow-soft transition-shadow',
        colors.surface,
        conflicted && 'ring-2 ring-destructive ring-offset-1 ring-offset-card',
        dragging && 'shadow-lifted',
        className
      )}
    >
      <div className={cn('w-1 shrink-0', colors.bar)} />
      <div className={cn('flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2 py-1.5')}>
        <div className="flex items-start gap-1.5">
          <p
            className={cn(
              'min-w-0 flex-1 text-[12px] font-semibold leading-tight',
              colors.title,
              dense ? 'truncate' : 'line-clamp-2'
            )}
          >
            {session.title}
          </p>
          {conflicted && (
            <span
              aria-label="Has a conflict"
              className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-destructive ring-2 ring-destructive/25"
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={cn('truncate text-[11px] leading-none tabular-nums', colors.meta)}>
            {timing}
            {isScheduled(session) && (
              <span className="ml-1 opacity-70">· {formatDuration(session.durationMin)}</span>
            )}
          </span>
          <SpeakerChips session={session} className="shrink-0" />
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Draggables                                                                  */
/* -------------------------------------------------------------------------- */

function DraggableCard({
  session,
  conflicted,
  style,
  dense,
  className,
}: {
  session: SpikeSession
  conflicted: boolean
  style?: React.CSSProperties
  dense?: boolean
  className?: string
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: session.id,
    data: { sessionId: session.id },
  })

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="session-card"
      data-session-id={session.id}
      {...listeners}
      {...attributes}
      className={cn(
        // touch-none is required or the browser scrolls instead of dragging.
        'cursor-grab touch-none select-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
        isDragging && 'opacity-30',
        className
      )}
    >
      <SessionCard session={session} conflicted={conflicted} dense={dense} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One (room, slot) droppable. Kept deliberately dumb: every droppable
 * re-renders when the DndContext's `over` changes, so the cheapest possible
 * render here is what keeps a 64-cell grid at 60fps. All hover feedback is
 * drawn once, by the ghost layer above.
 */
function SlotCell({ roomId, slot }: { roomId: string; slot: number }) {
  const { setNodeRef } = useDroppable({
    id: cellId(roomId, slot),
    data: { type: 'cell', roomId, slot } satisfies DropData,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ height: SLOT_PX }}
      className={cn('border-t', slot % 4 === 0 ? 'border-border' : 'border-border/45')}
    />
  )
}

/** The translucent "it would land here" box, spanning the full duration. */
function DropGhost({ preview }: { preview: Preview }) {
  const conflicting = preview.conflicts.length > 0
  return (
    <div
      data-testid="drop-ghost"
      data-conflicting={conflicting}
      className={cn(
        'pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-dashed transition-[top] duration-75',
        conflicting
          ? 'border-destructive bg-destructive/10'
          : 'border-primary bg-primary/10'
      )}
      style={{ top: preview.startSlot * SLOT_PX, height: preview.slots * SLOT_PX }}
    >
      <span
        className={cn(
          'absolute -top-2.5 left-2 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight tabular-nums shadow-soft',
          conflicting ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'
        )}
      >
        {formatMinutes(slotToMinutes(preview.startSlot))}
        {conflicting && ' · conflict'}
      </span>
    </div>
  )
}

function RoomColumn({
  room,
  sessions,
  conflictedIds,
  preview,
}: {
  room: Room
  sessions: SpikeSession[]
  conflictedIds: Set<string>
  preview: Preview | null
}) {
  // Overlapping sessions share the column width instead of hiding each other.
  const placed = useMemo(
    () => sessions.filter(isScheduled).filter((s) => s.roomId === room.id),
    [sessions, room.id]
  )
  const lanesById = useMemo(() => assignLanes(placed), [placed])

  return (
    <div
      data-testid="room-column"
      data-room-id={room.id}
      className="relative min-w-0 flex-1 border-l border-border first:border-l-0"
    >
      {/* Droppable lattice — 32 cells, one per 15-minute slot. */}
      <div style={{ height: GRID_HEIGHT }}>
        {Array.from({ length: SLOT_COUNT }, (_, slot) => (
          <SlotCell key={slot} roomId={room.id} slot={slot} />
        ))}
      </div>

      {/* Cards float above the lattice; the layer itself must not eat pointer
          events or the cells underneath would never be hit-tested. */}
      <div className="pointer-events-none absolute inset-0">
        {placed.map((session) => {
          const top = minutesToSlot(session.startMin) * SLOT_PX
          const height = durationSlots(session) * SLOT_PX
          const { lane, lanes } = lanesById.get(session.id) ?? { lane: 0, lanes: 1 }
          return (
            <DraggableCard
              key={session.id}
              session={session}
              conflicted={conflictedIds.has(session.id)}
              dense={session.durationMin <= 30 || lanes > 1}
              className="pointer-events-auto absolute z-10"
              style={{
                top: top + 1,
                height: height - 2,
                left: `calc(${(lane / lanes) * 100}% + 4px)`,
                width: `calc(${100 / lanes}% - 8px)`,
              }}
            />
          )
        })}
        {preview?.roomId === room.id && <DropGhost preview={preview} />}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                     */
/* -------------------------------------------------------------------------- */

function UnscheduledPanel({
  sessions,
  conflictedIds,
  active,
}: {
  sessions: SpikeSession[]
  conflictedIds: Set<string>
  active: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: UNSCHEDULED_ID,
    data: { type: 'unscheduled' } satisfies DropData,
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="unscheduled-panel"
      className={cn(
        'flex flex-col rounded-lg border bg-card shadow-soft transition-colors',
        isOver && active ? 'border-primary bg-primary-subtle' : 'border-border'
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Inbox className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Unscheduled</span>
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
          {sessions.length}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-2">
        {sessions.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            Everything is on the grid. Drag a card back here to unschedule it.
          </p>
        ) : (
          sessions.map((session) => (
            <DraggableCard
              key={session.id}
              session={session}
              conflicted={conflictedIds.has(session.id)}
              className="h-[54px]"
            />
          ))
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Conflicts panel                                                             */
/* -------------------------------------------------------------------------- */

function ConflictsPanel({
  conflicts,
  titles,
}: {
  conflicts: Conflict[]
  titles: Map<string, string>
}) {
  if (conflicts.length === 0) {
    return (
      <div
        data-testid="conflicts-panel"
        data-conflict-count={0}
        className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success-strong" />
        <span className="text-sm font-medium text-success-strong">No conflicts</span>
        <span className="truncate text-xs text-muted-foreground">
          Every scheduled session has its own room and no speaker is in two places at once.
        </span>
      </div>
    )
  }

  return (
    <div
      data-testid="conflicts-panel"
      data-conflict-count={conflicts.length}
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="text-sm font-semibold text-destructive-strong">
          Conflicts ({conflicts.length})
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {conflicts.map((conflict, i) => (
          <li
            key={`${conflict.type}-${conflict.sessionIds.join('-')}-${i}`}
            className="flex flex-wrap items-baseline gap-x-2 pl-6 text-xs"
          >
            <span className="font-medium text-destructive-strong">{conflict.detail}</span>
            <span className="truncate text-muted-foreground">
              {titles.get(conflict.sessionIds[0])} ↔ {titles.get(conflict.sessionIds[1])}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

/** clientY of whatever event started the drag, so we know where the card was grabbed. */
function activatorClientY(event: Event | null): number | null {
  if (!event) return null
  if ('clientY' in event) return (event as PointerEvent).clientY
  const touch = (event as TouchEvent).touches?.[0]
  return touch ? touch.clientY : null
}

/**
 * The card element the drag started on.
 *
 * dnd-kit's `active` exposes no node, and `active.rect.current.initial` is still
 * null inside onDragStart — it is populated a tick later. Walking up from the
 * activator's target is the one thing that is definitely settled at that moment,
 * and the source node has not been transformed yet (the DragOverlay is what
 * moves), so its rect is the card's resting position.
 */
function activatorCardNode(event: DragStartEvent): HTMLElement | null {
  const target = event.activatorEvent.target
  return target instanceof Element ? target.closest<HTMLElement>('[data-session-id]') : null
}

export function Agenda() {
  const [sessions, setSessions] = useState<SpikeSession[]>(seedSessions)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)

  /**
   * Which slot *within* the dragged card the pointer grabbed. Without it, a
   * 60-minute card grabbed by its middle would jump upward on drop. Held in a
   * ref because it changes once per drag and must never trigger a render.
   */
  const grabSlotOffset = useRef(0)
  /** Last target we computed conflicts for — skips redundant work + renders. */
  const lastTargetKey = useRef<string | null>(null)

  const sensors = useSensors(
    // A few pixels of slop so a click on a card is still a click, not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  // Full recompute, but only when the schedule actually changes — never during
  // a pointer move.
  const conflicts = useMemo(() => detectConflicts(sessions, LABELS), [sessions])
  const conflictedIds = useMemo(() => conflictedSessionIds(conflicts), [conflicts])
  const titles = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions])
  const unscheduled = useMemo(() => sessions.filter((s) => !isScheduled(s)), [sessions])
  const scheduledCount = sessions.length - unscheduled.length

  const activeSession = activeId ? (sessions.find((s) => s.id === activeId) ?? null) : null

  function resolveTarget(
    session: SpikeSession,
    data: DropData | undefined
  ): { roomId: string; startSlot: number } | null {
    if (!data || data.type !== 'cell') return null
    const startSlot = clampStartSlot(data.slot - grabSlotOffset.current, session)
    return { roomId: data.roomId, startSlot }
  }

  function handleDragStart(event: DragStartEvent) {
    const session = sessions.find((s) => s.id === event.active.id)
    setActiveId(session?.id ?? null)
    setPreview(null)
    lastTargetKey.current = null

    // Grab offset only makes sense for a card that is already slot-aligned;
    // sidebar cards always anchor to their top edge.
    const node = activatorCardNode(event)
    const y = activatorClientY(event.activatorEvent)
    if (session && isScheduled(session) && node && y != null) {
      const offset = Math.floor((y - node.getBoundingClientRect().top) / SLOT_PX)
      grabSlotOffset.current = Math.min(Math.max(offset, 0), durationSlots(session) - 1)
    } else {
      grabSlotOffset.current = 0
    }
  }

  /**
   * dnd-kit fires this only when the hovered droppable changes, not on every
   * pointer move — so the cost here is one O(n) delta per ~24px of travel, and
   * the guard below collapses the cases where two different cells resolve to
   * the same placement.
   */
  function handleDragOver(event: DragOverEvent) {
    const session = sessions.find((s) => s.id === event.active.id)
    if (!session) return

    const target = resolveTarget(session, event.over?.data.current as DropData | undefined)
    if (!target) {
      if (lastTargetKey.current !== null) {
        lastTargetKey.current = null
        setPreview(null)
      }
      return
    }

    const key = `${target.roomId}:${target.startSlot}`
    if (key === lastTargetKey.current) return
    lastTargetKey.current = key

    // Delta only: the dragged session against everything else. Never a full sweep.
    const candidate: SpikeSession = {
      ...session,
      roomId: target.roomId,
      startMin: slotToMinutes(target.startSlot),
    }
    setPreview({
      roomId: target.roomId,
      startSlot: target.startSlot,
      slots: durationSlots(session),
      conflicts: conflictsForSession(candidate, sessions, LABELS),
    })
  }

  function endDrag() {
    setActiveId(null)
    setPreview(null)
    lastTargetKey.current = null
    grabSlotOffset.current = 0
  }

  function handleDragEnd(event: DragEndEvent) {
    const session = sessions.find((s) => s.id === event.active.id)
    const data = event.over?.data.current as DropData | undefined

    if (session && data?.type === 'unscheduled') {
      setSessions((prev) =>
        prev.map((s) => (s.id === session.id ? { ...s, roomId: null, startMin: null } : s))
      )
    } else if (session) {
      const target = resolveTarget(session, data)
      if (target) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === session.id
              ? { ...s, roomId: target.roomId, startMin: slotToMinutes(target.startSlot) }
              : s
          )
        )
      }
    }
    endDrag()
  }

  const hours = Array.from({ length: SLOT_COUNT / 4 + 1 }, (_, i) => DAY_START_MIN + i * 60)

  return (
    <DndContext
      sensors={sensors}
      // The grid is a non-overlapping lattice, so "which cell is the pointer
      // in" is both the cheapest and the most predictable answer. Rect-based
      // strategies fight the absolutely-positioned cards.
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={endDrag}
    >
      <div className="px-4 py-6 md:px-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Agenda</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Drag sessions onto the grid. Conflicts are flagged while you drag, before you drop.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline tabular-nums">
              {scheduledCount} scheduled · {unscheduled.length} unscheduled
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSessions(seedSessions())
                endDrag()
              }}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </div>
        </header>

        <div className="mt-5">
          <ConflictsPanel conflicts={conflicts} titles={titles} />
        </div>

        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="w-full shrink-0 lg:sticky lg:top-4 lg:w-64">
            <UnscheduledPanel
              sessions={unscheduled}
              conflictedIds={conflictedIds}
              active={activeId !== null}
            />
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              15-minute slots, 09:00–17:00. Drop a scheduled card back here to unschedule it.
            </p>
          </div>

          <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            {/* Room header. Sticks to the top of the app shell's scroll area so
                the column you are dropping into stays labelled. */}
            <div className="sticky top-0 z-30 flex border-b border-border bg-card">
              <div className="w-14 shrink-0 border-r border-border" />
              {ROOMS.map((room) => (
                <div key={room.id} className="min-w-0 flex-1 border-l border-border px-3 py-2 first:border-l-0">
                  <div className="truncate text-sm font-semibold text-foreground">{room.name}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Capacity {room.capacity}
                  </div>
                </div>
              ))}
            </div>

            {/* py-3 gives the 09:00 and 17:00 gutter labels room to sit centred
                on the day's first and last line instead of being clipped. */}
            <div className="flex py-3">
              {/* Time gutter — a label on every hour boundary. */}
              <div className="relative w-14 shrink-0 border-r border-border" style={{ height: GRID_HEIGHT }}>
                {hours.map((minutes) => (
                  <div
                    key={minutes}
                    className="absolute right-2 -translate-y-1/2 text-2xs font-medium tabular-nums text-muted-foreground"
                    style={{ top: ((minutes - DAY_START_MIN) / SLOT_MINUTES) * SLOT_PX }}
                  >
                    {formatMinutes(minutes)}
                  </div>
                ))}
              </div>

              {ROOMS.map((room) => (
                <RoomColumn
                  key={room.id}
                  room={room}
                  sessions={sessions}
                  conflictedIds={conflictedIds}
                  preview={preview}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Drag preview. dropAnimation is off: the card is already re-rendered at
          its new slot, so animating the overlay back onto it only adds lag. */}
      <DragOverlay modifiers={[restrictToWindowEdges]} dropAnimation={null} zIndex={100}>
        {activeSession ? (
          <SessionCard
            session={activeSession}
            dense={activeSession.durationMin <= 30}
            dragging
            conflicted={(preview?.conflicts.length ?? 0) > 0}
            className="cursor-grabbing"
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
