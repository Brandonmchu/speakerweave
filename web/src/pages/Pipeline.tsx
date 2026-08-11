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
import { AlertCircle } from 'lucide-react'

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
import { GradientAvatar } from '@/ui/avatar'

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
        <div>
          <h1 className="page-title">Speaker Pipeline</h1>
          <p className="page-subtitle">
            Track prospects from research through confirmed or declined.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowEnroll(true)}>
          Enroll contact
        </Button>
      </header>

      {boardQuery.error ? (
        <div className="mt-6 bg-card">
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
          <p className="mt-4 text-[12.5px] text-muted-foreground">
            {board?.total ?? 0} prospect{(board?.total ?? 0) === 1 ? '' : 's'} on the board ·{' '}
            {board?.candidates.length ?? 0} more in the directory.
          </p>

          <div className="mt-5 flex gap-4 overflow-x-auto pb-4 scrollbar-app">
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
        'flex w-72 min-w-[236px] shrink flex-col rounded-[11px] transition-colors ' +
        (over && dragging ? 'bg-primary/[0.05]' : 'bg-transparent')
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
      <header className="flex items-center justify-between gap-2 px-1 pb-2">
        <h2 className="section-label text-foreground">{column.label}</h2>
        <div className="flex items-center gap-1.5">
          {column.terminal && <span className="text-[10.5px] text-placeholder">Terminal</span>}
          <span className="font-mono text-[10.5px] tabular-nums text-placeholder">
            {column.count}
          </span>
        </div>
      </header>

      <div className="flex-1 space-y-2">
        {column.cards.map((person) => (
          <article
            key={person.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', person.id)
              onDragStart(person.id)
            }}
            onDragEnd={onDragEnd}
            className="rounded-[11px] bg-card p-3 shadow-raised"
          >
            <div className="flex items-start gap-2">
              <GradientAvatar id={person.id} name={person.name} size={24} />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block w-full truncate text-left text-[13px] font-medium text-foreground hover:text-primary hover:underline"
                  onClick={() => onOpen(person.id)}
                >
                  {person.name}
                </button>
                <p className="truncate text-[11.5px] text-muted-foreground">
                  {[person.title, person.company_name].filter(Boolean).join(' · ') || person.email}
                </p>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {person.score != null && <Badge variant="muted" className="font-mono text-[10.5px]">Score {person.score}</Badge>}
              {person.events.slice(0, 2).map((event) => (
                <Badge key={event.id} variant="muted">
                  {event.name}
                </Badge>
              ))}
            </div>

            <div className="mt-2">
              <NativeSelect
                aria-label={`Move ${person.name} to stage`}
                className="h-7 bg-foreground/[0.045] text-[11px]"
                value={person.pipeline_stage}
                onValueChange={(value) => {
                  if (value !== person.pipeline_stage) onMove(person.id, value)
                }}
                options={stageOptions}
              />
            </div>
          </article>
        ))}
        <div className="flex min-h-[74px] items-center justify-center rounded-[11px] border border-dashed border-input text-[12.5px] text-placeholder">
          {column.cards.length === 0 ? 'Nothing yet' : 'Drop here'}
        </div>
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
