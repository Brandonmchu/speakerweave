/**
 * The speaker sourcing pipeline — a kanban board over the org directory.
 *
 * A directory answers "who have we worked with". This answers the other half of
 * a program chair's job: "who are we trying to land, and where did that
 * conversation get to". Cards are directory people who have been deliberately
 * enrolled — everyone else stays a candidate, because a board that auto-fills
 * with every contact you have ever imported is a board nobody works.
 *
 * Moves are made with a native `<select>` on the card and, on a pointer device,
 * by dragging. Both write the same stage-move request, and both leave a
 * timestamped history row — the column says where someone is, the history says
 * how they got there (see the drawer).
 */

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, GripVertical, KanbanSquare, Plus } from 'lucide-react'

import {
  STAGE_LABELS,
  getPipeline,
  moveStage,
  type DirectoryPerson,
  type PipelineColumn,
} from '@/lib/crmApi'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { EmptyState } from '@/ui/empty-state'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Textarea } from '@/ui/textarea'
import { useToast } from '@/ui/use-toast'
import { CrmPersonDrawer } from '@/pages/CrmPersonDrawer'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function Pipeline() {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [openPerson, setOpenPerson] = useState<string | null>(null)
  const [showEnroll, setShowEnroll] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)

  const boardQuery = useQuery({ queryKey: ['crm', 'pipeline'], queryFn: getPipeline })
  const board = boardQuery.data

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['crm'] })
  }

  const move = useMutation({
    mutationFn: ({ personId, stage }: { personId: string; stage: string }) =>
      moveStage(personId, { stage }),
    onSuccess: (_result, variables) => {
      toast({ title: `Moved to ${STAGE_LABELS[variables.stage] ?? variables.stage}` })
      refresh()
    },
    onError: (error: Error) => toast({ title: "Couldn't move the card", description: error.message }),
  })

  const stageOptions = useMemo(
    () => Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label })),
    []
  )

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <KanbanSquare className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Speaker Pipeline</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Track prospects from research through confirmed or declined.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setShowEnroll(true)}>
          <Plus className="h-4 w-4" />
          Enroll contact
        </Button>
      </header>

      {boardQuery.error ? (
        <div className="mt-6 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load the pipeline"
            description={(boardQuery.error as Error).message}
            action={
              <Button size="sm" variant="secondary" onClick={() => boardQuery.refetch()}>
                Try again
              </Button>
            }
          />
        </div>
      ) : boardQuery.isPending ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading pipeline…</p>
      ) : (
        <>
          <p className="mt-4 text-sm text-muted-foreground">
            {board?.total ?? 0} prospect{(board?.total ?? 0) === 1 ? '' : 's'} on the board ·{' '}
            {board?.candidates.length ?? 0} more in the directory.
          </p>

          <div className="mt-4 flex gap-4 overflow-x-auto pb-4 scrollbar-app">
            {(board?.columns ?? []).map((column) => (
              <Column
                key={column.stage}
                column={column}
                stageOptions={stageOptions}
                dragging={dragging}
                onDragStart={setDragging}
                onDragEnd={() => setDragging(null)}
                onDrop={(personId) => {
                  setDragging(null)
                  move.mutate({ personId, stage: column.stage })
                }}
                onMove={(personId, stage) => move.mutate({ personId, stage })}
                onOpen={setOpenPerson}
              />
            ))}
          </div>
        </>
      )}

      {openPerson && <CrmPersonDrawer personId={openPerson} onClose={() => setOpenPerson(null)} />}

      {showEnroll && (
        <EnrollDialog
          candidates={board?.candidates ?? []}
          onClose={() => setShowEnroll(false)}
          onEnrolled={refresh}
        />
      )}
    </div>
  )
}

function Column({
  column,
  stageOptions,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  onOpen,
}: {
  column: PipelineColumn
  stageOptions: { value: string; label: string }[]
  dragging: string | null
  onDragStart: (personId: string) => void
  onDragEnd: () => void
  onDrop: (personId: string) => void
  onMove: (personId: string, stage: string) => void
  onOpen: (personId: string) => void
}) {
  const [over, setOver] = useState(false)

  return (
    <section
      aria-label={`${column.label} column`}
      className={
        'flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30 ' +
        (over && dragging ? 'border-primary bg-primary-subtle' : 'border-border')
      }
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const personId = event.dataTransfer.getData('text/plain')
        if (personId) onDrop(personId)
      }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">{column.label}</h2>
        <div className="flex items-center gap-1.5">
          {column.terminal && <Badge variant="muted">Terminal</Badge>}
          <span className="rounded-md bg-card px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {column.count}
          </span>
        </div>
      </header>

      <div className="flex-1 space-y-2 p-2">
        {column.cards.length === 0 && (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">No prospects here.</p>
        )}
        {column.cards.map((person) => (
          <article
            key={person.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', person.id)
              onDragStart(person.id)
            }}
            onDragEnd={onDragEnd}
            className="rounded-lg border border-border bg-card p-3 shadow-soft"
          >
            <div className="flex items-start gap-2">
              <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {initials(person.name)}
              </div>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block w-full truncate text-left text-sm font-medium text-foreground hover:text-primary hover:underline"
                  onClick={() => onOpen(person.id)}
                >
                  {person.name}
                </button>
                <p className="truncate text-xs text-muted-foreground">
                  {[person.title, person.company_name].filter(Boolean).join(' · ') || person.email}
                </p>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {person.score != null && <Badge variant="muted">Score {person.score}</Badge>}
              {person.events.slice(0, 2).map((event) => (
                <Badge key={event.id} variant="outline">
                  {event.name}
                </Badge>
              ))}
            </div>

            <div className="mt-2">
              <NativeSelect
                aria-label={`Move ${person.name} to stage`}
                className="h-8 text-xs"
                value={person.pipeline_stage}
                onValueChange={(value) => {
                  if (value !== person.pipeline_stage) onMove(person.id, value)
                }}
                options={stageOptions}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function EnrollDialog({
  candidates,
  onClose,
  onEnrolled,
}: {
  candidates: DirectoryPerson[]
  onClose: () => void
  onEnrolled: () => void
}) {
  const { toast } = useToast()
  const [personId, setPersonId] = useState(candidates[0]?.id ?? '')
  const [stage, setStage] = useState('identified')
  const [score, setScore] = useState('85')
  const [rationale, setRationale] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      moveStage(personId, {
        stage,
        score: score.trim() ? Number(score) : null,
        rationale: rationale.trim() || null,
      }),
    onSuccess: () => {
      toast({ title: 'Enrolled into the pipeline' })
      onEnrolled()
      onClose()
    },
    onError: (error: Error) => toast({ title: "Couldn't enroll", description: error.message }),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Enroll a contact</DialogTitle>
          <DialogDescription>
            Pick someone from the directory and the stage the conversation is at.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Everyone in the directory is already on the board.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="crm-enroll-person">Contact</Label>
              <NativeSelect
                id="crm-enroll-person"
                value={personId}
                onValueChange={setPersonId}
                options={candidates.map((person) => ({
                  value: person.id,
                  label: `${person.name} — ${person.email}`,
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-enroll-stage">Starting stage</Label>
              <NativeSelect
                id="crm-enroll-stage"
                value={stage}
                onValueChange={setStage}
                options={Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-enroll-score">Score (0–100)</Label>
              <Input
                id="crm-enroll-score"
                type="number"
                min={0}
                max={100}
                value={score}
                onChange={(event) => setScore(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crm-enroll-rationale">Rationale</Label>
              <Textarea
                id="crm-enroll-rationale"
                rows={3}
                value={rationale}
                placeholder="Why this speaker, for which track?"
                onChange={(event) => setRationale(event.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!personId || mutation.isPending} onClick={() => mutation.mutate()}>
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
