import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import {
  AlertCircle,
  AlertTriangle,
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  CheckCircle2,
  Clock,
  Columns3,
  ExternalLink,
  Inbox,
  List,
  RotateCcw,
  Send,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react'

import { ApiError, apiGet, unwrapList, type EventSummary } from '@/lib/api'
import {
  addMinutesToIso,
  agendaDays,
  autoPlaceSchedule,
  buildZonedTimestamp,
  getAgenda,
  getAgendaConflicts,
  gridGeometry,
  localEpochMinutes,
  outsideEventDays,
  publishSchedule,
  scheduleSession,
  zoneHint,
  zonedDay,
  zonedMinutes,
  type Agenda as AgendaPayload,
  type AgendaRoom,
  type AgendaSession,
  type AutoPlaceResult,
  type GridGeometry,
  type PublishResult,
  type SchedulePatch,
  type ServerConflict,
} from '@/lib/scheduleApi'
import { cn } from '@/lib/utils'
import {
  assignLanes,
  conflictedSessionIds,
  conflictsForSession,
  detectConflicts,
  formatDuration,
  formatMinutes,
  formatRange,
  isScheduled,
  overlapStart,
  type Conflict,
  type ScheduledSession,
  type ScheduleLabels,
  type SpikeSession,
} from '@/lib/schedule'
import { Button } from '@/ui/button'
import { EmptyState } from '@/ui/empty-state'
import { Skeleton } from '@/ui/skeleton'
import { toast } from '@/ui/use-toast'

/* -------------------------------------------------------------------------- */
/* The agenda builder: a room x time grid over the event's real sessions.      */
/*                                                                            */
/* The geometry and drag mechanics came out of the PLAN.md §6 spike; the data  */
/* is now the API's. Three rules the wiring is built around:                   */
/*                                                                            */
/*   1. Conflicts are detected TWICE. lib/schedule.ts runs in the browser so   */
/*      the ghost turns red before the drop; the server sweeps the same rules  */
/*      (api/services/scheduling.py) and is the authority we reconcile with.   */
/*   2. A drop is optimistic. The card lands, then PATCHes; a 409 (Postgres    */
/*      refusing a room double-book) puts it back where it was.                */
/*   3. A drag never refetches the board. The agenda query is written to       */
/*      locally; only the cheap conflicts query is invalidated afterwards.     */
/* -------------------------------------------------------------------------- */

/** Pixel height of one slot. */
const SLOT_PX = 24

interface Speaker {
  name: string
  initials: string
}

type SpeakerRegistry = Record<string, Speaker>

/**
 * Speaker names for the initial chips. In a context rather than threaded
 * through six components: every card in the tree wants it, none of them wants
 * to know where it came from.
 */
const SpeakersContext = createContext<SpeakerRegistry>({})

/**
 * Full class strings so Tailwind's scanner can see them — never build these by
 * interpolation.
 */
const PALETTE: Record<string, { surface: string; bar: string; title: string; meta: string; chip: string }> = {
  slate: {
    surface: 'border-status-queue/25 bg-status-queue/10',
    bar: 'bg-status-queue',
    title: 'text-foreground',
    meta: 'text-muted-foreground',
    chip: 'bg-status-queue/10 text-foreground ring-status-queue/20',
  },
  violet: {
    surface: 'border-primary/20 bg-primary-subtle',
    bar: 'bg-primary',
    title: 'text-foreground',
    meta: 'text-muted-foreground',
    chip: 'bg-primary-subtle text-foreground ring-primary/20',
  },
  sky: {
    surface: 'border-status-neutral/60 bg-status-neutral/15',
    bar: 'bg-status-neutral',
    title: 'text-foreground',
    meta: 'text-muted-foreground',
    chip: 'bg-status-neutral/20 text-foreground ring-status-neutral/50',
  },
  emerald: {
    surface: 'border-success/25 bg-success/10',
    bar: 'bg-success',
    title: 'text-foreground',
    meta: 'text-muted-foreground',
    chip: 'bg-success/10 text-foreground ring-success/20',
  },
  amber: {
    surface: 'border-warning/25 bg-warning/10',
    bar: 'bg-warning',
    title: 'text-foreground',
    meta: 'text-muted-foreground',
    chip: 'bg-warning/10 text-foreground ring-warning/20',
  },
}

const PALETTE_KEYS = Object.keys(PALETTE)

function palette(color: string) {
  return PALETTE[color] ?? PALETTE.slate
}

/**
 * Track -> palette slot. Tracks carry a hex colour, but the card styling is a
 * matched set of five Tailwind ramps (surface/bar/title/meta/chip) that a raw
 * hex can't fill in. Hashing the track id keeps every session in a track the
 * same colour and keeps that colour stable across reloads.
 */
function paletteFor(trackId: string | null | undefined): string {
  if (!trackId) return 'slate'
  let hash = 0
  for (let i = 0; i < trackId.length; i += 1) {
    hash = (hash * 31 + trackId.charCodeAt(i)) >>> 0
  }
  return PALETTE_KEYS[hash % PALETTE_KEYS.length]
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/*                                                                            */
/* The event owns its own day window and slot width, so the slot<->minute maths */
/* is parameterised here rather than taken from lib/schedule.ts's spike        */
/* constants. Everything else in that module (conflict detection, lanes,       */
/* formatting) is geometry-free and used as-is.                               */
/* -------------------------------------------------------------------------- */

const slotToMin = (grid: GridGeometry, slot: number) => grid.dayStartMin + slot * grid.slotMinutes

const minToSlot = (grid: GridGeometry, minutes: number) =>
  Math.round((minutes - grid.dayStartMin) / grid.slotMinutes)

const slotsFor = (grid: GridGeometry, durationMin: number) =>
  Math.max(1, Math.ceil(durationMin / grid.slotMinutes))

/** Keep a placement inside the day: a session may not spill past day_end. */
function clampSlot(grid: GridGeometry, slot: number, durationMin: number): number {
  const max = Math.max(0, grid.slotCount - slotsFor(grid, durationMin))
  return Math.min(Math.max(slot, 0), max)
}

/* -------------------------------------------------------------------------- */
/* Wire -> card model                                                          */
/* -------------------------------------------------------------------------- */

function speakerRegistry(sessions: AgendaSession[]): SpeakerRegistry {
  const registry: SpeakerRegistry = {}
  for (const session of sessions) {
    for (const speaker of session.speakers ?? []) {
      if (registry[speaker.contact_id]) continue
      const first = (speaker.first_name ?? '').trim()
      const last = (speaker.last_name ?? '').trim()
      const name = [first, last].filter(Boolean).join(' ') || speaker.contact_id
      const initials =
        `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase() ||
        speaker.contact_id.slice(0, 2).toUpperCase()
      registry[speaker.contact_id] = { name, initials }
    }
  }
  return registry
}

/** A grid card plus the event-local day it sits on (null while unscheduled). */
interface GridSession extends SpikeSession {
  day: string | null
}

/** A placed grid card — keeps `day` through the narrowing that `isScheduled`
 *  (typed on the base `SpikeSession`) would otherwise drop. */
type ScheduledGridSession = GridSession & ScheduledSession

const isScheduledGrid = (session: GridSession): session is ScheduledGridSession =>
  isScheduled(session)

/**
 * One API session -> the card the grid drags. Minutes, not timestamps, and the
 * minutes are the event-LOCAL clock (via `zone`), so a card sits where the
 * public schedule says it does, not where the browser's own offset would put it.
 */
function toCard(session: AgendaSession, zone: string | null): GridSession {
  const startMin = zonedMinutes(session.starts_at, zone)
  return {
    id: session.id,
    title: session.title || 'Untitled session',
    speakerIds: (session.speakers ?? []).map((speaker) => speaker.contact_id),
    durationMin: session.duration_min > 0 ? session.duration_min : 30,
    color: paletteFor(session.track_id),
    // A session with a room but no start is not placed — the grid has nowhere
    // to draw it, so it stays in the tray until it is given a time.
    roomId: startMin === null ? null : (session.room_id ?? null),
    startMin,
    day: zonedDay(session.starts_at, zone),
  }
}

/**
 * The same card in the conflict detector's time domain.
 *
 * Layout needs minutes past local midnight; overlap arithmetic needs the whole
 * instant so equal clock times on different conference days do not alias. The
 * instant is shifted into the event's local clock (a constant, overlap-invariant
 * shift) so the conflict `detail` prints the same time the grid shows.
 */
function toConflictCard(session: AgendaSession, zone: string | null): SpikeSession {
  const card = toCard(session, zone)
  const startMin = localEpochMinutes(session.starts_at, zone)
  return {
    ...card,
    roomId: startMin === null ? null : (session.room_id ?? null),
    startMin,
  }
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
  const speakers = useContext(SpeakersContext)
  const colors = palette(session.color)
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {session.speakerIds.map((id) => {
        const speaker = speakers[id]
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
        'relative flex h-full overflow-hidden rounded-md border transition-shadow',
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
  selected,
  onSelect,
  action,
}: {
  session: SpikeSession
  conflicted: boolean
  style?: React.CSSProperties
  dense?: boolean
  className?: string
  /** Armed for click-to-assign — draws the blue selection ring. */
  selected?: boolean
  /** A plain click (no drag) picks the card up for click-to-assign. */
  onSelect?: () => void
  /** Corner affordance: "Place" in the tray, "Unschedule" on the grid. */
  action?: React.ReactNode
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
      data-selected={selected ? 'true' : undefined}
      // A click that never became a drag (the sensor needs 4px of travel first)
      // selects the card instead — the click-to-assign entry point.
      onClick={onSelect}
      {...listeners}
      {...attributes}
      className={cn(
        // touch-none is required or the browser scrolls instead of dragging.
        // `group/card` lets the corner action reveal on hover. `relative` is the
        // action's positioning context; a passed `absolute` (grid cards) wins.
        'group/card relative cursor-grab touch-none select-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
        isDragging && 'opacity-30',
        selected && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
        className
      )}
    >
      <SessionCard session={session} conflicted={conflicted} dense={dense} />
      {action}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Grid                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One (room, slot) droppable — and, for keyboard/agent access, a real click
 * target. Kept deliberately dumb: every droppable re-renders when the
 * DndContext's `over` changes, so the cheapest possible render here is what
 * keeps the grid at 60fps. `memo` keeps the parent's per-drag preview renders
 * from touching it; only its own `over` subscription and a selection toggle
 * ever re-render it.
 *
 * The cell carries a stable `data-testid="slot-<roomId>-<HHMM>"` plus a
 * button role and time-stamped aria-label so a session can be placed without a
 * drag: select a card, click a slot. Present in EVERY slot, empty or not, so
 * any minute of the day is a legal, taggable destination — the card layer
 * above is `pointer-events-none` except on the cards themselves, so an empty
 * slot is always the thing under the pointer.
 */
const SlotCell = memo(function SlotCell({
  roomId,
  roomName,
  slot,
  slotsPerHour,
  grid,
  selecting,
  onPlace,
}: {
  roomId: string
  roomName: string
  slot: number
  slotsPerHour: number
  grid: GridGeometry
  /** A card is armed for placement, so cells advertise themselves as targets. */
  selecting: boolean
  onPlace: (roomId: string, slot: number) => void
}) {
  const { setNodeRef } = useDroppable({
    id: cellId(roomId, slot),
    data: { type: 'cell', roomId, slot } satisfies DropData,
  })

  const timeLabel = formatMinutes(slotToMin(grid, slot))

  return (
    <div
      ref={setNodeRef}
      role="button"
      // Out of the tab order until a card is armed, so the day isn't 100+ dead
      // tab stops; reachable by keyboard the moment placement is in play.
      tabIndex={selecting ? 0 : -1}
      aria-label={`${roomName} ${timeLabel}`}
      data-testid={`slot-${roomId}-${timeLabel.replace(':', '')}`}
      onClick={() => onPlace(roomId, slot)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onPlace(roomId, slot)
        }
      }}
      style={{ height: SLOT_PX }}
      className={cn(
        'border-t outline-none',
        slot % slotsPerHour === 0 ? 'border-border' : 'border-border/45',
        selecting &&
          'cursor-pointer hover:bg-primary/10 focus-visible:bg-primary/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary'
      )}
    />
  )
})

/** The translucent "it would land here" box, spanning the full duration. */
function DropGhost({ preview, grid }: { preview: Preview; grid: GridGeometry }) {
  const conflicting = preview.conflicts.length > 0
  return (
    <div
      data-testid="drop-ghost"
      data-conflicting={conflicting}
      className={cn(
        'pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-dashed transition-[top] duration-75',
        conflicting
          ? 'border-destructive bg-destructive/10'
          : 'border-foreground bg-foreground/[0.045]'
      )}
      style={{ top: preview.startSlot * SLOT_PX, height: preview.slots * SLOT_PX }}
    >
      <span
        className={cn(
          'absolute -top-2.5 left-2 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight tabular-nums shadow-soft',
          conflicting ? 'bg-destructive text-destructive-foreground' : 'bg-foreground text-white'
        )}
      >
        {formatMinutes(slotToMin(grid, preview.startSlot))}
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
  grid,
  selectedId,
  selecting,
  onSelect,
  onUnschedule,
  onPlaceSlot,
}: {
  room: AgendaRoom
  sessions: SpikeSession[]
  conflictedIds: Set<string>
  preview: Preview | null
  grid: GridGeometry
  /** Which card is armed for click-to-assign (draws its selection ring). */
  selectedId: string | null
  /** Any card is armed — cells advertise themselves as drop targets. */
  selecting: boolean
  onSelect: (id: string) => void
  onUnschedule: (id: string) => void
  onPlaceSlot: (roomId: string, slot: number) => void
}) {
  // Overlapping sessions share the column width instead of hiding each other.
  const placed = useMemo(
    () => sessions.filter(isScheduled).filter((s) => s.roomId === room.id),
    [sessions, room.id]
  )
  const lanesById = useMemo(() => assignLanes(placed), [placed])
  const slotsPerHour = Math.max(1, Math.round(60 / grid.slotMinutes))

  return (
    <div
      data-testid="room-column"
      data-room-id={room.id}
      className="relative min-w-0 flex-1 border-l border-border first:border-l-0"
    >
      {/* Droppable lattice — one cell per slot. Also the click-to-assign grid. */}
      <div style={{ height: grid.slotCount * SLOT_PX }}>
        {Array.from({ length: grid.slotCount }, (_, slot) => (
          <SlotCell
            key={slot}
            roomId={room.id}
            roomName={room.name}
            slot={slot}
            slotsPerHour={slotsPerHour}
            grid={grid}
            selecting={selecting}
            onPlace={onPlaceSlot}
          />
        ))}
      </div>

      {/* Cards float above the lattice; the layer itself must not eat pointer
          events or the cells underneath would never be hit-tested. */}
      <div className="pointer-events-none absolute inset-0">
        {placed.map((session) => {
          const top = minToSlot(grid, session.startMin) * SLOT_PX
          const height = slotsFor(grid, session.durationMin) * SLOT_PX
          const { lane, lanes } = lanesById.get(session.id) ?? { lane: 0, lanes: 1 }
          return (
            <DraggableCard
              key={session.id}
              session={session}
              conflicted={conflictedIds.has(session.id)}
              dense={session.durationMin <= 30 || lanes > 1}
              className="pointer-events-auto absolute z-10"
              selected={selectedId === session.id}
              onSelect={() => onSelect(session.id)}
              action={
                <button
                  type="button"
                  data-testid={`unschedule-${session.id}`}
                  aria-label={`Unschedule ${session.title}`}
                  title="Send back to unscheduled"
                  // Keep pointerdown off the drag sensor and the click off the
                  // card's select handler — this button does one thing only.
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onUnschedule(session.id)
                  }}
          className="absolute right-0.5 top-0.5 z-20 inline-flex h-4 w-4 items-center justify-center rounded border border-border bg-card/90 text-muted-foreground opacity-0 transition-opacity hover:border-destructive hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              }
              style={{
                top: top + 1,
                height: height - 2,
                left: `calc(${(lane / lanes) * 100}% + 4px)`,
                width: `calc(${100 / lanes}% - 8px)`,
              }}
            />
          )
        })}
        {preview?.roomId === room.id && <DropGhost preview={preview} grid={grid} />}
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
  selectedId,
  onSelect,
}: {
  sessions: SpikeSession[]
  conflictedIds: Set<string>
  active: boolean
  /** Which tray card is armed for click-to-assign. */
  selectedId: string | null
  onSelect: (id: string) => void
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
        'flex flex-col rounded-lg border bg-card transition-colors',
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
            <div key={session.id} data-testid={`unscheduled-${session.id}`}>
              <DraggableCard
                session={session}
                conflicted={conflictedIds.has(session.id)}
                className="h-[54px]"
                selected={selectedId === session.id}
                onSelect={() => onSelect(session.id)}
                action={
                  <button
                    type="button"
                    data-testid={`place-${session.id}`}
                    aria-label={`Schedule ${session.title}`}
                    title="Pick a slot on the grid to schedule this"
                    // Don't let a press start a drag, and don't double-fire the
                    // card's own select handler underneath.
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onSelect(session.id)
                    }}
                    className={cn(
                      'absolute right-1 top-1 z-10 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none transition-colors',
                      selectedId === session.id
                        ? 'border-foreground bg-foreground text-white'
                        : 'border-border bg-card/90 text-muted-foreground hover:border-primary hover:text-primary'
                    )}
                  >
                    <CalendarPlus className="h-3 w-3" />
                    {selectedId === session.id ? 'Selected' : 'Place'}
                  </button>
                }
              />
            </div>
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
/* View tabs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sessionboard-style view switcher. "Rooms" is our drag grid (default); the
 * others are lighter reads over the same data — no wizard, no second tool.
 */
type AgendaView = 'list' | 'day' | 'week' | 'rooms' | 'conflicts'

const VIEW_TABS: { id: AgendaView; label: string; Icon: LucideIcon }[] = [
  { id: 'list', label: 'List', Icon: List },
  { id: 'day', label: 'Day', Icon: CalendarDays },
  { id: 'week', label: 'Week', Icon: CalendarRange },
  { id: 'rooms', label: 'Rooms', Icon: Columns3 },
  { id: 'conflicts', label: 'Conflicts', Icon: AlertTriangle },
]

function ViewTabs({
  value,
  onChange,
  conflictCount,
}: {
  value: AgendaView
  onChange: (view: AgendaView) => void
  conflictCount: number
}) {
  return (
    <div
      role="tablist"
      aria-label="Agenda views"
      className="mt-5 flex items-center gap-1 overflow-x-auto border-b border-border"
    >
      {VIEW_TABS.map(({ id, label, Icon }) => {
        const active = value === id
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`agenda-tab-${id}`}
            onClick={() => onChange(id)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            {id === 'conflicts' && conflictCount > 0 && (
              <span className="ml-0.5 rounded-full bg-destructive/10 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-destructive">
                {conflictCount}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Grey helper strip that tells day/week they are riding on the room grid. */
function ViewNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <CalendarDays className="h-4 w-4 shrink-0" />
      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Day switcher + timezone note                                                */
/* -------------------------------------------------------------------------- */

/** "Mon, Oct 12" from a YYYY-MM-DD key, parsed as a plain calendar date so it
 *  never shifts a day under a timezone conversion. */
function formatDayTab(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (!y || !m || !d) return dateKey
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(y, m - 1, d))
}

/**
 * The pseudo-day the out-of-range placements are gathered under. Deliberately
 * not a date: it is not a day of the conference, which is the whole point.
 */
const OUTSIDE_DAY = '__outside__'

/**
 * The day switcher for a multi-day event. One tab per CONFERENCE day — the
 * event's configured span and nothing else — plus, when the data has drifted, a
 * final tab collecting placements that fall outside it.
 *
 * The grid, drag-and-drop and click-to-place all operate on the selected day. A
 * single-day event with no strays never renders this (the caller guards).
 */
function DaySwitcher({
  days,
  value,
  outsideCount,
  onChange,
}: {
  days: string[]
  value: string
  /** How many scheduled sessions sit outside the event's dates. 0 hides the tab. */
  outsideCount: number
  onChange: (day: string) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Conference day"
      data-testid="day-switcher"
      className="flex items-center gap-1 overflow-x-auto"
    >
      {days.map((d, index) => {
        const active = value === d
        return (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`agenda-day-tab-${d}`}
            onClick={() => onChange(d)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-foreground text-white'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <span className="text-2xs font-semibold uppercase tracking-wide opacity-75">
              Day {index + 1}
            </span>
            {formatDayTab(d)}
          </button>
        )
      })}
      {outsideCount > 0 && (
        <button
          type="button"
          role="tab"
          aria-selected={value === OUTSIDE_DAY}
          data-testid="agenda-day-tab-outside"
          data-outside-count={outsideCount}
          onClick={() => onChange(OUTSIDE_DAY)}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            value === OUTSIDE_DAY
              ? 'bg-destructive text-destructive-foreground shadow-soft'
              : 'text-destructive hover:bg-destructive/10'
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Outside event dates ({outsideCount})
        </button>
      )}
    </div>
  )
}

/**
 * The stray placements, and the one-click way out of each.
 *
 * A session here has a real time and a real room, on a date the conference does
 * not run. There is no honest grid to draw it on — so it gets a list, a reason,
 * and a button that puts it back in the tray where it can be scheduled properly.
 */
function OutsideEventDatesPanel({
  sessions,
  rooms,
  onUnschedule,
}: {
  sessions: GridSession[]
  rooms: Map<string, string>
  onUnschedule: (id: string) => void
}) {
  return (
    <div className="space-y-3">
      <div
        data-testid="outside-dates-warning"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <p className="text-foreground">
          <strong className="font-semibold text-destructive-strong">
            {sessions.length} session{sessions.length === 1 ? '' : 's'} scheduled outside the
            event dates.
          </strong>{' '}
          These are not on any conference day, so they do not appear on the grid or on your
          public schedule. Move each one back to the unscheduled tray, then place it on a real
          day.
        </p>
      </div>

      <ul className="divide-y divide-border overflow-hidden bg-card">
        {sessions.map((session) => (
          <li
            key={session.id}
            data-testid={`outside-session-${session.id}`}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-foreground">{session.title}</p>
              <p className="truncate text-xs text-muted-foreground tabular-nums">
                {session.day ? formatDayTab(session.day) : 'Unknown day'}
                {session.startMin != null && ` · ${formatMinutes(session.startMin)}`}
                {session.roomId && ` · ${rooms.get(session.roomId) ?? session.roomId}`}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              data-testid={`outside-unschedule-${session.id}`}
              onClick={() => onUnschedule(session.id)}
            >
              <Inbox className="h-3.5 w-3.5" />
              Move to tray
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "Times shown in America/Los_Angeles (PDT)" — mirrors the public schedule so a
 *  reader knows the grid is in the EVENT's zone, not their own browser's. */
function TzNote({ hint }: { hint: string }) {
  if (!hint) return null
  return (
    <p
      data-testid="agenda-tz-note"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Clock className="h-3.5 w-3.5 shrink-0" />
      Times shown in {hint}
    </p>
  )
}

/* -------------------------------------------------------------------------- */
/* List view                                                                   */
/* -------------------------------------------------------------------------- */

/** Every scheduled session, in day-then-start order — the plainest possible read. */
function ListView({
  sessions,
  conflictedIds,
  rooms,
}: {
  sessions: GridSession[]
  conflictedIds: Set<string>
  rooms: Map<string, string>
}) {
  const speakerNames = useContext(SpeakersContext)
  const scheduled = useMemo(
    () =>
      sessions
        .filter(isScheduledGrid)
        // Day first so a multi-day programme reads day 1 then day 2, not every
        // 09:00 lumped together; start time within a day.
        .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? '') || a.startMin - b.startMin),
    [sessions]
  )

  return (
    <div className="mt-4 overflow-hidden bg-card">
      {scheduled.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-muted-foreground">
          Nothing scheduled yet. Switch to the Rooms view to drag sessions onto the grid.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {scheduled.map((session) => {
            const colors = palette(session.color)
            const conflicted = conflictedIds.has(session.id)
            const speakers = session.speakerIds
              .map((id) => speakerNames[id]?.name ?? id)
              .join(', ')
            return (
              <li key={session.id} className="flex items-center gap-4 px-5 py-3">
                <div className="w-24 shrink-0 text-sm font-medium tabular-nums text-foreground">
                  {formatRange(session)}
                </div>
                <span className={cn('h-9 w-1 shrink-0 rounded-full', colors.bar)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-foreground">{session.title}</p>
                    {conflicted && (
                      <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-2xs font-semibold text-destructive">
                        Conflict
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {rooms.get(session.roomId) ?? session.roomId} · {formatDuration(session.durationMin)}
                    {speakers && ` · ${speakers}`}
                  </p>
                </div>
                <SpeakerChips session={session} className="shrink-0" />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Conflicts view                                                              */
/* -------------------------------------------------------------------------- */

/** Just the sessions that collide — the conflict banner plus their cards. */
function ConflictsView({
  conflicts,
  sessions,
  conflictedIds,
  titles,
}: {
  conflicts: Conflict[]
  sessions: SpikeSession[]
  conflictedIds: Set<string>
  titles: Map<string, string>
}) {
  const flagged = useMemo(
    () => sessions.filter((s) => conflictedIds.has(s.id)),
    [sessions, conflictedIds]
  )

  return (
    <div className="mt-4 space-y-4">
      <ConflictsPanel conflicts={conflicts} titles={titles} />
      {flagged.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {flagged.map((session) => (
            <div key={session.id} className="h-16">
              <SessionCard session={session} conflicted />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Conflict reconciliation                                                     */
/* -------------------------------------------------------------------------- */

const conflictKey = (conflict: Conflict) =>
  `${conflict.type}|${conflict.sessionIds[0]}|${conflict.sessionIds[1]}`

/**
 * Client conflicts first, then anything the server saw that the browser did
 * not.
 *
 * The client list is what the operator is looking at right now — it includes
 * the card still under their finger. The server list can lag a drop by one
 * request, so a server entry is only trusted while the two sessions still
 * overlap in the current local model; otherwise a conflict the organizer just
 * fixed would flicker back for a moment.
 */
function mergeConflicts(
  client: Conflict[],
  server: ServerConflict[] | undefined,
  byId: Map<string, SpikeSession>
): Conflict[] {
  if (!server?.length) return client

  const merged = [...client]
  const seen = new Set(client.map(conflictKey))

  for (const row of server) {
    const [first, second] = row.session_ids ?? []
    const a = byId.get(first)
    const b = byId.get(second)
    if (!a || !b || !isScheduled(a) || !isScheduled(b)) continue
    if (
      overlapStart(
        a.startMin,
        a.startMin + a.durationMin,
        b.startMin,
        b.startMin + b.durationMin
      ) === null
    ) {
      continue
    }

    const entry: Conflict = { type: row.type, sessionIds: [first, second], detail: row.detail }
    const key = conflictKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged
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
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  // The card armed for click-to-assign — the drag-free path. Select a card
  // (tray "Place" or a click on a grid card), then click a slot to place/move
  // it. Independent of `activeId`, which is the *drag* in flight.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Rooms (the drag grid) is the default read; the other tabs are lighter views
  // over the same data.
  const [view, setView] = useState<AgendaView>('rooms')
  // Which conference day the grid is showing. A multi-day event switches between
  // days; a single-day event has exactly one and shows no switcher. Empty until
  // the board loads and the first real day is known.
  const [selectedDay, setSelectedDay] = useState('')
  // The confirmation shown after "Publish schedule" — the timestamp + the public
  // URL to share. Cleared only by publishing again.
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null)
  // What the last "Auto-place remaining" run did. Kept on screen (not just in a
  // toast) because the interesting half is what it *couldn't* place and why —
  // that list is a to-do, and a toast that vanishes is no place for one.
  const [autoPlaceResult, setAutoPlaceResult] = useState<AutoPlaceResult | null>(null)

  /**
   * Which slot *within* the dragged card the pointer grabbed. Without it, a
   * 60-minute card grabbed by its middle would jump upward on drop. Held in a
   * ref because it changes once per drag and must never trigger a render.
   */
  const grabSlotOffset = useRef(0)
  /** Last target we computed conflicts for — skips redundant work + renders. */
  const lastTargetKey = useRef<string | null>(null)
  /**
   * A drag that just ended fires a synthetic click on the card it landed on;
   * this suppresses that click so a drop doesn't also arm the card for
   * click-to-assign. Cleared on the next tick, once the stray click is past.
   */
  const justDragged = useRef(false)

  const sensors = useSensors(
    // A few pixels of slop so a click on a card is still a click, not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  // The org's first event, exactly as the submissions inbox picks it.
  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const eventId = eventsQuery.data?.[0]?.id

  const agendaKey = ['agenda', eventId]
  const conflictsKey = ['agenda-conflicts', eventId]

  const agendaQuery = useQuery({
    queryKey: agendaKey,
    queryFn: () => getAgenda(eventId!),
    enabled: Boolean(eventId),
  })
  const conflictsQuery = useQuery({
    queryKey: conflictsKey,
    queryFn: () => getAgendaConflicts(eventId!),
    enabled: Boolean(eventId),
  })

  const agenda = agendaQuery.data
  // The zone every time on this grid is labelled and grouped in: the event's
  // own, exactly like the public schedule. Never the browser's.
  const zone = agenda?.event?.timezone ?? null
  const grid = useMemo(() => gridGeometry(agenda?.event), [agenda?.event])

  // Every day the builder can show: the event's configured span, and only that.
  const days = useMemo(() => agendaDays(agenda, zone), [agenda, zone])
  // Placements that landed on no conference day at all — a date change left them
  // behind, or they predate the span. Their own tab, never a fake day tab.
  const outsideIds = useMemo(
    () => new Set(outsideEventDays(agenda, zone).map((session) => session.id)),
    [agenda, zone]
  )
  // Every selectable tab, in order. The stray group is last and only exists
  // while there is something in it.
  const dayOptions = useMemo(
    () => (outsideIds.size > 0 ? [...days, OUTSIDE_DAY] : days),
    [days, outsideIds]
  )
  useEffect(() => {
    if (dayOptions.length && !dayOptions.includes(selectedDay)) setSelectedDay(dayOptions[0])
  }, [dayOptions, selectedDay])
  // The day actually in view: the selection when it is still valid, else the
  // first real day. Guards the frame between the board loading and the effect
  // re-homing a now-stale selection, so the grid never filters on a dead day.
  const day =
    selectedDay && dayOptions.includes(selectedDay)
      ? selectedDay
      : (days[0] ?? new Date().toISOString().slice(0, 10))
  const showingOutside = day === OUTSIDE_DAY

  const sessions = useMemo(
    () => (agenda?.sessions ?? []).map((s) => toCard(s, zone)),
    [agenda?.sessions, zone]
  )
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])
  const conflictSessions = useMemo(
    () => (agenda?.sessions ?? []).map((s) => toConflictCard(s, zone)),
    [agenda?.sessions, zone]
  )
  const conflictById = useMemo(
    () => new Map(conflictSessions.map((session) => [session.id, session])),
    [conflictSessions]
  )
  const rooms = useMemo(() => agenda?.rooms ?? [], [agenda?.rooms])
  const speakers = useMemo(() => speakerRegistry(agenda?.sessions ?? []), [agenda?.sessions])

  const roomNames = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms])
  const labels: ScheduleLabels = useMemo(
    () => ({
      rooms: Object.fromEntries(rooms.map((room) => [room.id, room.name])),
      speakers: Object.fromEntries(Object.entries(speakers).map(([id, s]) => [id, s.name])),
    }),
    [rooms, speakers]
  )

  // Full recompute, but only when the schedule actually changes — never during
  // a pointer move.
  const clientConflicts = useMemo(
    () => detectConflicts(conflictSessions, labels),
    [conflictSessions, labels]
  )
  const conflicts = useMemo(
    () => mergeConflicts(clientConflicts, conflictsQuery.data, conflictById),
    [clientConflicts, conflictsQuery.data, conflictById]
  )
  const conflictedIds = useMemo(() => conflictedSessionIds(conflicts), [conflicts])
  const titles = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions])
  const unscheduled = useMemo(() => sessions.filter((s) => !isScheduled(s)), [sessions])
  const scheduledCount = sessions.length - unscheduled.length
  // What the grid draws: the selected day's placed cards, plus the day-less
  // tray. Cards on other days are hidden here, but still counted in the header
  // and still swept for conflicts (which compare absolute instants, not days).
  const gridSessions = useMemo(
    () => sessions.filter((s) => !isScheduled(s) || (s.day === day && !outsideIds.has(s.id))),
    [sessions, day, outsideIds]
  )
  /** The stray placements themselves, earliest first — the "Outside" tab's list. */
  const outsideSessions = useMemo(
    () =>
      sessions
        .filter((s) => outsideIds.has(s.id))
        .sort(
          (a, b) =>
            (a.day ?? '').localeCompare(b.day ?? '') ||
            (a.startMin ?? 0) - (b.startMin ?? 0) ||
            a.title.localeCompare(b.title)
        ),
    [sessions, outsideIds]
  )
  // A real instant so the tz hint resolves the right abbreviation (PST vs PDT).
  const zoneReferenceIso =
    agenda?.event?.starts_at ??
    (agenda?.sessions ?? []).find((s) => s.starts_at)?.starts_at ??
    null

  const activeSession = activeId ? (byId.get(activeId) ?? null) : null
  const selectedSession = selectedId ? (byId.get(selectedId) ?? null) : null

  // The public schedule link surfaced after publishing. The server hands it back;
  // the event slug is a fallback so the confirmation always has somewhere to go.
  const eventSlug = agenda?.event?.slug ?? eventsQuery.data?.[0]?.slug ?? null
  const publishUrl = publishResult
    ? (publishResult.public_url ?? (eventSlug ? `/e/${eventSlug}/schedule` : null))
    : null

  /**
   * The drop, persisted.
   *
   * Optimistic: the card is already where it was dropped, so this only ever
   * has to *undo*. The board is never refetched here — the response is written
   * straight into the cache and only the conflicts sweep is invalidated, so
   * dragging twenty sessions costs twenty small writes, not twenty boards.
   */
  const move = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SchedulePatch }) => scheduleSession(id, patch),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: agendaKey })
      const previous = queryClient.getQueryData<AgendaPayload>(agendaKey)
      queryClient.setQueryData<AgendaPayload>(agendaKey, (current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
            }
          : current
      )
      return { previous }
    },
    onSuccess: (session, { id }) => {
      // The row the server actually wrote wins over what we guessed. Duration
      // stays local: it is derived, and an unscheduled session has no ends_at
      // left to derive it from.
      queryClient.setQueryData<AgendaPayload>(agendaKey, (current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.map((s) =>
                s.id === id
                  ? {
                      ...s,
                      starts_at: session?.starts_at ?? null,
                      ends_at: session?.ends_at ?? null,
                      room_id: session?.room_id ?? null,
                    }
                  : s
              ),
            }
          : current
      )
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(agendaKey, context.previous)
      const doubleBooked = error instanceof ApiError && error.status === 409
      toast({
        variant: 'destructive',
        title: doubleBooked ? 'Room double-booked' : "Couldn't save that move",
        description: doubleBooked
          ? 'Another session already has that room at that time.'
          : error.message,
      })
    },
    onSettled: () => {
      // Only the conflict sweep — the board itself is already correct.
      queryClient.invalidateQueries({ queryKey: conflictsKey })
    },
  })

  /**
   * "Auto-place remaining" — the whole tray, in one action.
   *
   * The server does the choosing (api/services/auto_place.py): it walks the
   * event's real days, slots and rooms and takes the first opening that creates
   * ZERO conflicts, validated with the same rule engine this page reconciles
   * against. So the board is refetched rather than patched optimistically —
   * there is nothing to guess, and the placements it made are ordinary ones the
   * organizer can immediately drag, move or unschedule.
   */
  const autoPlace = useMutation({
    mutationFn: () => autoPlaceSchedule(eventId!),
    onSuccess: async (result) => {
      setAutoPlaceResult(result)
      // Both queries: the board changed, so its conflict sweep did too.
      await Promise.all([agendaQuery.refetch(), conflictsQuery.refetch()])
      const placed = result.placed.length
      const skipped = result.skipped.length
      toast({
        title: `Placed ${placed} session${placed === 1 ? '' : 's'}, skipped ${skipped}`,
        description:
          skipped === 0
            ? 'Every remaining session found a conflict-free slot.'
            : result.skipped
                .slice(0, 3)
                .map((entry) => `${entry.title ?? entry.id}: ${entry.reason}`)
                .join(' · '),
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: "Couldn't auto-place the remaining sessions",
        description: error.message,
      })
    },
  })

  /**
   * Publish the programme. This does NOT flip public visibility — the published
   * schedule already serves accepted+scheduled sessions. It records the moment,
   * then shows the organizer the public URL to share.
   */
  const publish = useMutation({
    mutationFn: () => publishSchedule(eventId!),
    onSuccess: (result) => {
      setPublishResult(result)
      toast({
        title: 'Schedule published',
        description: result.public_url
          ? `Live at ${result.public_url}`
          : 'Your public schedule is live.',
      })
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: "Couldn't publish the schedule",
        description: error.message,
      })
    },
  })

  function resolveTarget(
    session: SpikeSession,
    data: DropData | undefined
  ): { roomId: string; startSlot: number } | null {
    if (!data || data.type !== 'cell') return null
    const startSlot = clampSlot(grid, data.slot - grabSlotOffset.current, session.durationMin)
    return { roomId: data.roomId, startSlot }
  }

  /** Persist a placement (or the lack of one), skipping no-op drops. */
  function commit(session: GridSession, target: { roomId: string; startSlot: number } | null) {
    const roomId = target?.roomId ?? null
    const startMin = target ? slotToMin(grid, target.startSlot) : null
    // A placement always lands on the day currently IN VIEW — the grid only
    // shows, and only accepts drops for, the selected day, so the target date is
    // never the card's own stored day (which may be a day the user just switched
    // away from). Comparing the day too means a move to another day at the same
    // clock + room is never mistaken for a no-op.
    const targetDay = target ? day : null
    if (
      (session.roomId ?? null) === roomId &&
      (session.startMin ?? null) === startMin &&
      (session.day ?? null) === targetDay
    ) {
      return
    }

    let patch: SchedulePatch
    if (target && startMin !== null) {
      // Resolve the START to a single instant, then derive the end from the
      // original duration — so a session spanning a DST change keeps its real
      // length instead of stretching (or shrinking) when each wall-time is
      // converted to an instant independently.
      const startsAt = buildZonedTimestamp(day, startMin, zone)
      patch = {
        room_id: roomId,
        starts_at: startsAt,
        ends_at: addMinutesToIso(startsAt, session.durationMin),
      }
    } else {
      patch = { room_id: null, starts_at: null, ends_at: null }
    }

    move.mutate({ id: session.id, patch })
  }

  /* ---- occupancy ---------------------------------------------------------- */

  /**
   * The card already lying across `[startMin, startMin + durationMin)` in this
   * room, on the day in view — i.e. the reason a placement cannot go there.
   *
   * The grid draws cards ABOVE the droppable lattice, so an occupied slot is
   * physically un-clickable: the pointer lands on the card, not the cell. That
   * used to mean click-to-place onto a taken slot did nothing at all and said
   * nothing either. This is what turns that silence into an answer.
   */
  function occupantAt(
    roomId: string,
    startMin: number,
    durationMin: number,
    excludeId: string
  ): GridSession | null {
    const end = startMin + durationMin
    for (const other of gridSessions) {
      if (other.id === excludeId) continue
      if (!isScheduledGrid(other)) continue
      if (other.roomId !== roomId || other.day !== day) continue
      if (overlapStart(other.startMin, other.startMin + other.durationMin, startMin, end) !== null) {
        return other
      }
    }
    return null
  }

  /** The one message an occupied slot gives back, whether clicked or dropped on. */
  function refuseOccupied(occupant: GridSession) {
    toast({
      variant: 'destructive',
      title: `Slot occupied by ${occupant.title}`,
      description: 'Pick a free slot, or move that session out of the way first.',
    })
  }

  /* ---- click-to-assign: the drag-free path -------------------------------- */

  /** Arm a card for placement (or disarm it if it's already the armed one). */
  const selectSession = useCallback((id: string) => {
    // A click synthesised by a just-finished drag must not re-arm the card.
    if (justDragged.current) return
    setSelectedId((prev) => (prev === id ? null : id))
  }, [])

  /**
   * A click on a card that is already ON the grid.
   *
   * With nothing armed this is "pick this up to move it" — the ordinary select.
   * With something else armed it is an attempted placement onto the slot this
   * card is sitting in, so it answers instead of silently switching the armed
   * card out from under the organizer.
   */
  function selectGridCard(id: string) {
    if (justDragged.current) return
    const occupant = byId.get(id)
    if (selectedId && selectedId !== id && occupant) {
      refuseOccupied(occupant)
      return
    }
    setSelectedId((prev) => (prev === id ? null : id))
  }

  /** The "Unschedule" / × affordance on a placed card — back to the tray. */
  function unschedule(id: string) {
    const session = byId.get(id)
    if (session) commit(session, null)
    setSelectedId((prev) => (prev === id ? null : prev))
  }

  /**
   * Drop the armed card into a clicked slot. The top of the card lands on the
   * clicked slot (no grab offset — a click has no grab point), clamped to the
   * day; then the same `commit` the drag path uses persists it.
   */
  function placeInSlot(roomId: string, slot: number) {
    if (!selectedId) return
    const session = byId.get(selectedId)
    if (!session) {
      setSelectedId(null)
      return
    }
    const startSlot = clampSlot(grid, slot, session.durationMin)
    // A long card can reach into an occupied slot from an empty one, so the
    // check is on the whole range it would cover, not on the clicked cell.
    const occupant = occupantAt(roomId, slotToMin(grid, startSlot), session.durationMin, session.id)
    if (occupant) {
      // The selection stays armed: the next click should be another slot, not
      // another trip through the tray.
      refuseOccupied(occupant)
      return
    }
    commit(session, { roomId, startSlot })
    setSelectedId(null)
  }

  // A stable identity for the memoized cells, always calling the latest closure
  // (which closes over the current selection, board and geometry).
  const placeInSlotRef = useRef(placeInSlot)
  placeInSlotRef.current = placeInSlot
  const onPlaceSlot = useCallback((roomId: string, slot: number) => {
    placeInSlotRef.current(roomId, slot)
  }, [])

  // Escape disarms the current selection — the keyboard's Cancel.
  useEffect(() => {
    if (!selectedId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  function handleDragStart(event: DragStartEvent) {
    const session = byId.get(String(event.active.id))
    setActiveId(session?.id ?? null)
    setPreview(null)
    // Drag and click-to-assign are mutually exclusive modes.
    setSelectedId(null)
    lastTargetKey.current = null

    // Grab offset only makes sense for a card that is already slot-aligned;
    // sidebar cards always anchor to their top edge.
    const node = activatorCardNode(event)
    const y = activatorClientY(event.activatorEvent)
    if (session && isScheduled(session) && node && y != null) {
      const offset = Math.floor((y - node.getBoundingClientRect().top) / SLOT_PX)
      grabSlotOffset.current = Math.min(Math.max(offset, 0), slotsFor(grid, session.durationMin) - 1)
    } else {
      grabSlotOffset.current = 0
    }
  }

  /**
   * dnd-kit fires this only when the hovered droppable changes, not on every
   * pointer move — so the cost here is one O(n) delta per row of travel, and
   * the guard below collapses the cases where two different cells resolve to
   * the same placement.
   */
  function handleDragOver(event: DragOverEvent) {
    const session = byId.get(String(event.active.id))
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
    // The preview lands on the day in view — the same day `commit` will store to.
    const startMin = localEpochMinutes(
      buildZonedTimestamp(day, slotToMin(grid, target.startSlot), zone),
      zone
    )
    const candidate: SpikeSession = {
      ...session,
      roomId: target.roomId,
      startMin,
    }
    setPreview({
      roomId: target.roomId,
      startSlot: target.startSlot,
      slots: slotsFor(grid, session.durationMin),
      conflicts: conflictsForSession(candidate, conflictSessions, labels),
    })
  }

  function endDrag() {
    setActiveId(null)
    setPreview(null)
    lastTargetKey.current = null
    grabSlotOffset.current = 0
    // Swallow the click the browser fires on the drop target right after a drag.
    justDragged.current = true
    window.setTimeout(() => {
      justDragged.current = false
    }, 0)
  }

  function handleDragEnd(event: DragEndEvent) {
    const session = byId.get(String(event.active.id))
    const data = event.over?.data.current as DropData | undefined

    if (session && data?.type === 'unscheduled') {
      commit(session, null)
    } else if (session) {
      const target = resolveTarget(session, data)
      if (target) {
        // Same rule as click-to-place, same message: a drop onto a taken slot is
        // refused with the name of what is already there.
        const occupant = occupantAt(
          target.roomId,
          slotToMin(grid, target.startSlot),
          session.durationMin,
          session.id
        )
        if (occupant) refuseOccupied(occupant)
        else commit(session, target)
      }
    }
    endDrag()
  }

  const hours = useMemo(() => {
    const count = Math.floor((grid.dayEndMin - grid.dayStartMin) / 60)
    return Array.from({ length: count + 1 }, (_, i) => grid.dayStartMin + i * 60)
  }, [grid])

  const error = eventsQuery.error ?? agendaQuery.error
  const isLoading = eventsQuery.isPending || (Boolean(eventId) && agendaQuery.isPending)
  const eventName = agenda?.event?.name ?? eventsQuery.data?.[0]?.name

  /** One card frame for every state that isn't the grid. */
  const panel = (children: React.ReactNode) => (
    <div className="mt-4 overflow-hidden bg-card">
      {children}
    </div>
  )

  let body: React.ReactNode = null
  if (error) {
    body = panel(
      <EmptyState
        icon={<AlertCircle className="h-6 w-6 text-destructive" />}
        title="Couldn't load the agenda"
        description={error.message}
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              eventsQuery.refetch()
              agendaQuery.refetch()
            }}
          >
            Try again
          </Button>
        }
      />
    )
  } else if (isLoading) {
    body = panel(
      <div className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    )
  } else if (!eventId) {
    body = panel(
      <EmptyState
        icon={<CalendarDays className="h-6 w-6 text-muted-foreground" />}
        title="No events yet"
        description="Create an event first, then its accepted sessions will show up here."
      />
    )
  } else if (sessions.length === 0) {
    body = panel(
      <EmptyState
        icon={<CalendarDays className="h-6 w-6 text-muted-foreground" />}
        title="Nothing to schedule"
        description="No accepted sessions yet — accept submissions to build the agenda"
      />
    )
  } else if (view === 'list') {
    body = (
      <>
        <div className="mt-4">
          <TzNote hint={zoneHint(zone, zoneReferenceIso)} />
        </div>
        <ListView sessions={sessions} conflictedIds={conflictedIds} rooms={roomNames} />
      </>
    )
  } else if (view === 'conflicts') {
    body = (
      <ConflictsView
        conflicts={conflicts}
        sessions={sessions}
        conflictedIds={conflictedIds}
        titles={titles}
      />
    )
  } else {
    body = (
      <>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          {days.length > 1 || outsideSessions.length > 0 ? (
            <DaySwitcher
              days={days}
              value={day}
              outsideCount={outsideSessions.length}
              onChange={setSelectedDay}
            />
          ) : (
            <span />
          )}
          <TzNote hint={zoneHint(zone, zoneReferenceIso)} />
        </div>

        {view === 'day' && (
          <ViewNote>
            Day view spans every room for the event day — drag to reschedule, exactly like Rooms.
          </ViewNote>
        )}
        {view === 'week' && (
          <ViewNote>
            Week view rolls up to the room grid for now — drag sessions the same way you do in Rooms.
          </ViewNote>
        )}

        <div className="mt-4">
          <ConflictsPanel conflicts={conflicts} titles={titles} />
        </div>

        {selectedSession && (
          <div
            data-testid="placement-banner"
            className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary-subtle px-3 py-2 text-sm"
          >
            <CalendarPlus className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-foreground">
              Placing <strong className="font-semibold">{selectedSession.title}</strong> — click a
              slot to {isScheduled(selectedSession) ? 'move' : 'schedule'} it.
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              data-testid="placement-cancel"
              onClick={() => setSelectedId(null)}
            >
              Cancel
            </Button>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="w-full shrink-0 lg:sticky lg:top-4 lg:w-64">
            <UnscheduledPanel
              sessions={unscheduled}
              conflictedIds={conflictedIds}
              active={activeId !== null}
              selectedId={selectedId}
              onSelect={selectSession}
            />
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              {grid.slotMinutes}-minute slots, {formatMinutes(grid.dayStartMin)}–
              {formatMinutes(grid.dayEndMin)}. Drop a scheduled card back here to unschedule it.
            </p>
          </div>

          <div
            className={cn(
              'min-w-0 flex-1',
              !showingOutside && 'overflow-hidden bg-card'
            )}
          >
            {showingOutside ? (
              <OutsideEventDatesPanel
                sessions={outsideSessions}
                rooms={roomNames}
                onUnschedule={unschedule}
              />
            ) : rooms.length === 0 ? (
              <EmptyState
                icon={<Columns3 className="h-6 w-6 text-muted-foreground" />}
                title="No rooms yet"
                description="Add rooms in Settings and they become the columns of this grid."
              />
            ) : (
              <>
                {/* Room header. Sticks to the top of the app shell's scroll area so
                    the column you are dropping into stays labelled. */}
                <div className="sticky top-0 z-30 flex border-b border-border bg-card">
                  <div className="w-14 shrink-0 border-r border-border" />
                  {rooms.map((room) => (
                    <div key={room.id} className="min-w-0 flex-1 border-l border-border px-3 py-2 first:border-l-0">
                      <div className="truncate text-sm font-semibold text-foreground">{room.name}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {room.capacity == null ? 'Capacity —' : `Capacity ${room.capacity}`}
                      </div>
                    </div>
                  ))}
                </div>

                {/* py-3 gives the first and last gutter labels room to sit centred
                    on the day's first and last line instead of being clipped. */}
                <div className="flex py-3">
                  {/* Time gutter — a label on every hour boundary. */}
                  <div
                    className="relative w-14 shrink-0 border-r border-border"
                    style={{ height: grid.slotCount * SLOT_PX }}
                  >
                    {hours.map((minutes) => (
                      <div
                        key={minutes}
                        className="absolute right-2 -translate-y-1/2 text-2xs font-medium tabular-nums text-muted-foreground"
                        style={{ top: ((minutes - grid.dayStartMin) / grid.slotMinutes) * SLOT_PX }}
                      >
                        {formatMinutes(minutes)}
                      </div>
                    ))}
                  </div>

                  {rooms.map((room) => (
                    <RoomColumn
                      key={room.id}
                      room={room}
                      sessions={gridSessions}
                      conflictedIds={conflictedIds}
                      preview={preview}
                      grid={grid}
                      selectedId={selectedId}
                      selecting={selectedId !== null}
                      onSelect={selectGridCard}
                      onUnschedule={unschedule}
                      onPlaceSlot={onPlaceSlot}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </>
    )
  }

  return (
    <SpeakersContext.Provider value={speakers}>
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
                <h1 className="page-title">Agenda</h1>
                <p className="page-subtitle">
                  Drag a session onto the grid{eventName ? ` for ${eventName}` : ''}, or hit Place
                  and click a slot. Conflicts are flagged live, before you drop.
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
                disabled={!eventId || agendaQuery.isFetching}
                onClick={() => {
                  agendaQuery.refetch()
                  conflictsQuery.refetch()
                  endDrag()
                }}
              >
                <RotateCcw className="h-4 w-4" />
                Refresh
              </Button>
              {/* The one-action fill. Only shown while there is something left
                  to place — an empty tray makes it a button that does nothing. */}
              {unscheduled.length > 0 && (
                <Button
                  size="sm"
                  data-testid="auto-place"
                  disabled={!eventId || autoPlace.isPending}
                  title="Schedule every remaining session into the first conflict-free slot"
                  onClick={() => autoPlace.mutate()}
                >
                  <Wand2 className="h-4 w-4" />
                  {autoPlace.isPending
                    ? 'Placing…'
                    : `Auto-place remaining (${unscheduled.length})`}
                </Button>
              )}
              <Button
                size="sm"
                data-testid="publish-schedule"
                disabled={!eventId || sessions.length === 0 || publish.isPending}
                onClick={() => publish.mutate()}
              >
                <Send className="h-4 w-4" />
                {publish.isPending ? 'Publishing…' : 'Publish schedule'}
              </Button>
            </div>
          </header>

          <ViewTabs value={view} onChange={setView} conflictCount={conflicts.length} />

          {autoPlaceResult && (
            <div
              data-testid="auto-place-summary"
              data-placed={autoPlaceResult.placed.length}
              data-skipped={autoPlaceResult.skipped.length}
              className="mt-4 rounded-lg border border-primary/40 bg-primary-subtle px-3 py-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Wand2 className="h-4 w-4 shrink-0 text-primary" />
                <span className="text-foreground">
                  Placed{' '}
                  <strong className="font-semibold tabular-nums">
                    {autoPlaceResult.placed.length}
                  </strong>{' '}
                  session{autoPlaceResult.placed.length === 1 ? '' : 's'}, skipped{' '}
                  <strong className="font-semibold tabular-nums">
                    {autoPlaceResult.skipped.length}
                  </strong>
                  .
                </span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  data-testid="auto-place-dismiss"
                  onClick={() => setAutoPlaceResult(null)}
                  className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* The skipped list is the point of keeping this on screen: each
                  line is a decision the organizer still has to make by hand. */}
              {autoPlaceResult.skipped.length > 0 && (
                <ul className="mt-1.5 space-y-1 pl-6">
                  {autoPlaceResult.skipped.map((entry) => (
                    <li
                      key={entry.id}
                      data-testid={`auto-place-skipped-${entry.id}`}
                      className="flex flex-wrap items-baseline gap-x-2 text-xs"
                    >
                      <span className="font-medium text-foreground">
                        {entry.title ?? titles.get(entry.id) ?? entry.id}
                      </span>
                      <span className="text-muted-foreground">{entry.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {publishResult && (
            <div
              data-testid="publish-success"
              className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5 text-sm"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success-strong" />
              <span className="text-foreground">
                Schedule published.{' '}
                {publishUrl ? (
                  <>
                    It&apos;s live at{' '}
                    <span className="font-medium tabular-nums">{publishUrl}</span>
                  </>
                ) : (
                  'Your public schedule is live.'
                )}
              </span>
              {publishUrl && (
                <a
                  href={publishUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="view-public-page"
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-strong"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View public page
                </a>
              )}
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setPublishResult(null)}
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground',
                  publishUrl ? '' : 'ml-auto'
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {body}
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
    </SpeakersContext.Provider>
  )
}
