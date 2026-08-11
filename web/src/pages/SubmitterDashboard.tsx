import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CalendarClock, CheckCircle2, Pencil, Inbox as InboxIcon, UserPlus, Users } from 'lucide-react'

import {
  addSubmitterParticipant,
  editSubmitterSubmission,
  getSubmitterSubmissions,
  withdrawSubmitterSubmission,
  type SubmissionStatus,
  type SubmitterEditInput,
  type SubmitterSubmission,
  type SubmitterTaxonomyItem,
} from '@/lib/api'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'

/**
 * Submitter self-service dashboard (public, no Clerk).
 *
 * Reached from the magic link a submitter requests on the CFP form
 * (`/submit/:slug/manage?token=…`). The token in the query is the bearer
 * credential every call carries — it stays in the URL so a refresh keeps
 * working (there is no cookie). It lists this submitter's own submissions and,
 * while the CFP is open and a submission is still pending, lets them edit or
 * withdraw it inline.
 */
export function SubmitterDashboard() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const token = params.get('token') ?? ''

  const query = useQuery({
    queryKey: ['submitter-submissions', token],
    queryFn: () => getSubmitterSubmissions(token),
    enabled: Boolean(token),
    retry: false,
  })

  if (!token) {
    return (
      <SubmitterShell>
        <StateCard
          icon={<AlertCircle className="h-6 w-6 text-destructive" />}
          title="This manage link is missing its token"
          description="Open the link from your email, or request a new one from the submission form."
        />
      </SubmitterShell>
    )
  }

  if (query.isPending) {
    return (
      <SubmitterShell>
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </SubmitterShell>
    )
  }

  if (query.error) {
    return (
      <SubmitterShell>
        <StateCard
          icon={<AlertCircle className="h-6 w-6 text-destructive" />}
          title="This manage link isn't available"
          description={query.error.message}
          action={<Button onClick={() => query.refetch()}>Try again</Button>}
        />
      </SubmitterShell>
    )
  }

  const data = query.data
  const submissions = data.submissions
  const eventName = data.event?.name ?? undefined
  const closeAt = data.event?.close_at ? new Date(data.event.close_at) : null
  const signedInEmail =
    data.email ??
    submissions.flatMap((submission) => submission.participants ?? []).find((p) => p.is_primary)
      ?.email ??
    null

  function signOut() {
    queryClient.removeQueries({ queryKey: ['submitter-submissions', token], exact: true })
    navigate('/speaker-signin', { replace: true })
  }

  return (
    <SubmitterShell eyebrow={eventName}>
      <header className="border-b border-border pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Your speaker account
            </h1>
            {signedInEmail && (
              <p className="mt-1 text-sm text-muted-foreground">
                Signed in as <span className="font-medium text-foreground">{signedInEmail}</span>
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          {submissions.length === 0
            ? 'You have no submissions yet.'
            : `${submissions.length} submission${submissions.length === 1 ? '' : 's'}${
                eventName ? ` for ${eventName}` : ''
              }.`}
        </p>
        {closeAt && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-primary/20 bg-primary-subtle/50 px-3 py-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            <span className="text-sm text-foreground">
              {data.event?.closed ? 'Editing closed on ' : 'Editing open until '}
              <span className="font-semibold">{formatDate(closeAt)}</span>
            </span>
          </div>
        )}
      </header>

      {submissions.length === 0 ? (
        <StateCard
          icon={<InboxIcon className="h-6 w-6 text-muted-foreground" />}
          title="Nothing here yet"
          description="Once you submit a proposal it will appear here to view, edit, or withdraw."
        />
      ) : (
        <div className="space-y-5 py-6">
          {submissions.map((submission) => (
            <SubmissionCard
              key={submission.id}
              token={token}
              submission={submission}
              tracks={data.tracks}
              formats={data.formats}
            />
          ))}
        </div>
      )}
    </SubmitterShell>
  )
}

// ── one submission ──────────────────────────────────────────────────────────

function SubmissionCard({
  token,
  submission,
  tracks,
  formats,
}: {
  token: string
  submission: SubmitterSubmission
  tracks: SubmitterTaxonomyItem[]
  formats: SubmitterTaxonomyItem[]
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false)

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['submitter-submissions', token] })

  const withdraw = useMutation({
    mutationFn: () => withdrawSubmitterSubmission(submission.id, token),
    onSuccess: async () => {
      setConfirmingWithdraw(false)
      await invalidate()
    },
  })

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
      <div className="px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {submission.friendly_id && <span className="font-mono">{submission.friendly_id}</span>}
              <StatusBadge status={submission.status} />
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
              {submission.title}
            </h2>
          </div>
          {submission.editable && !editing && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
            </div>
          )}
        </div>

        {!editing && (
          <>
            {(submission.track || submission.format) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {submission.track && <Badge variant="outline">{submission.track}</Badge>}
                {submission.format && <Badge variant="outline">{submission.format}</Badge>}
              </div>
            )}
            {submission.abstract && (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {submission.abstract}
              </p>
            )}
            {submission.submitted_at && (
              <p className="mt-3 text-xs text-muted-foreground">
                Submitted {formatDate(new Date(submission.submitted_at))}
              </p>
            )}

            {submission.decided && submission.feedback && (
              <div className="mt-4 rounded-lg border-l-2 border-primary bg-primary-subtle/45 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Feedback from the event team
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{submission.feedback}</p>
              </div>
            )}

            {submission.editable && (
              <div className="mt-4 border-t border-border pt-4">
                {confirmingWithdraw ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-foreground">
                      Withdraw this submission? This can&rsquo;t be undone.
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={withdraw.isPending}
                      onClick={() => withdraw.mutate()}
                    >
                      {withdraw.isPending ? 'Withdrawing…' : 'Confirm withdraw'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={withdraw.isPending}
                      onClick={() => setConfirmingWithdraw(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmingWithdraw(true)}
                  >
                    Withdraw submission
                  </Button>
                )}
                {withdraw.error && (
                  <p className="mt-2 text-sm text-destructive">{(withdraw.error as Error).message}</p>
                )}
              </div>
            )}
          </>
        )}

        {editing && (
          <EditForm
            token={token}
            submission={submission}
            tracks={tracks}
            formats={formats}
            onCancel={() => setEditing(false)}
            onSaved={async () => {
              setEditing(false)
              await invalidate()
            }}
          />
        )}

        <ParticipantsSection token={token} submission={submission} />
      </div>
    </article>
  )
}

function ParticipantsSection({
  token,
  submission,
}: {
  token: string
  submission: SubmitterSubmission
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const participants = submission.participants ?? []
  const atLimit = participants.length >= 3

  const add = useMutation({
    mutationFn: () =>
      addSubmitterParticipant(submission.id, token, {
        name: name.trim(),
        email: email.trim(),
      }),
    onSuccess: async () => {
      setName('')
      setEmail('')
      await queryClient.invalidateQueries({ queryKey: ['submitter-submissions', token] })
    },
  })

  return (
    <section className="mt-5 border-t border-border pt-4" data-testid={`submitter-participants-${submission.id}`}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Users className="h-4 w-4 text-muted-foreground" />
        Participants ({participants.length})
      </h3>
      {participants.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No participants are linked yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {participants.map((participant) => (
            <li
              key={participant.contact_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{participant.name}</p>
                {participant.email && (
                  <p className="truncate text-xs text-muted-foreground">{participant.email}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {participant.is_primary && <Badge variant="default">Primary</Badge>}
                <Badge variant="outline" className="capitalize">
                  {(participant.roles?.length ? participant.roles : [participant.role])
                    .filter(Boolean)
                    .join(' · ')}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}

      {submission.editable && (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.2fr_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim() || !email.trim() || atLimit) return
            add.mutate()
          }}
        >
          <div>
            <Label htmlFor={`co-speaker-name-${submission.id}`} className="sr-only">
              Co-speaker name
            </Label>
            <Input
              id={`co-speaker-name-${submission.id}`}
              aria-label="Co-speaker name"
              value={name}
              maxLength={240}
              placeholder="Co-speaker name"
              disabled={add.isPending || atLimit}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`co-speaker-email-${submission.id}`} className="sr-only">
              Co-speaker email
            </Label>
            <Input
              id={`co-speaker-email-${submission.id}`}
              aria-label="Co-speaker email"
              type="email"
              value={email}
              placeholder="co-speaker@example.com"
              disabled={add.isPending || atLimit}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={!name.trim() || !email.trim() || add.isPending || atLimit}
          >
            <UserPlus className="h-4 w-4" />
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
          {atLimit && (
            <p className="text-xs text-muted-foreground sm:col-span-3">
              This submission already has the maximum of 3 participants.
            </p>
          )}
          {add.error && (
            <p className="text-sm text-destructive sm:col-span-3">{(add.error as Error).message}</p>
          )}
        </form>
      )}
    </section>
  )
}

function EditForm({
  token,
  submission,
  tracks,
  formats,
  onCancel,
  onSaved,
}: {
  token: string
  submission: SubmitterSubmission
  tracks: SubmitterTaxonomyItem[]
  formats: SubmitterTaxonomyItem[]
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  // Every input starts from the stored value — an edit form that opens blank
  // does not just look wrong, it SAVES that blank over what the speaker wrote.
  const [title, setTitle] = useState(submission.title ?? '')
  const [abstract, setAbstract] = useState(submission.abstract ?? '')
  const [trackId, setTrackId] = useState(submission.track_id ?? '')
  const [formatId, setFormatId] = useState(submission.format_id ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      // PATCH only what actually changed. A field the speaker never touched is
      // left out of the body entirely, so the server keeps its stored value
      // instead of being handed this form's idea of it.
      const patch: SubmitterEditInput = {}
      if (title.trim() !== (submission.title ?? '').trim()) patch.title = title.trim()
      if (abstract.trim() !== (submission.abstract ?? '').trim()) patch.abstract = abstract.trim()
      if ((trackId || null) !== (submission.track_id ?? null)) patch.track_id = trackId || null
      if ((formatId || null) !== (submission.format_id ?? null)) patch.format_id = formatId || null
      return editSubmitterSubmission(submission.id, token, patch)
    },
    onSuccess: () => onSaved(),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    setError(null)
    save.mutate()
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-4 border-t border-border pt-4">
      <div className="space-y-1.5">
        <Label htmlFor={`title-${submission.id}`} required>
          Session title
        </Label>
        <Input
          id={`title-${submission.id}`}
          value={title}
          maxLength={300}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setTitle(e.target.value)
            if (error) setError(null)
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`abstract-${submission.id}`}>Abstract</Label>
        <Textarea
          id={`abstract-${submission.id}`}
          value={abstract}
          onChange={(e) => setAbstract(e.target.value)}
        />
      </div>
      {tracks.length > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor={`track-${submission.id}`}>Track</Label>
          <NativeSelect
            id={`track-${submission.id}`}
            value={trackId}
            onValueChange={setTrackId}
            options={tracks.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="No track"
          />
        </div>
      )}
      {formats.length > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor={`format-${submission.id}`}>Session format</Label>
          <NativeSelect
            id={`format-${submission.id}`}
            value={formatId}
            onValueChange={setFormatId}
            options={formats.map((f) => ({ value: f.id, label: f.name }))}
            placeholder="No format"
          />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {save.error && <p className="text-sm text-destructive">{(save.error as Error).message}</p>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
          {!save.isPending && <CheckCircle2 className="h-4 w-4" />}
        </Button>
      </div>
    </form>
  )
}

// ── status badges ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SubmissionStatus }) {
  switch (status) {
    case 'accepted':
      return <Badge variant="success">Accepted</Badge>
    case 'accept_queue':
      return <Badge variant="warning">In consideration</Badge>
    case 'declined':
      return <Badge variant="destructive">Declined</Badge>
    case 'decline_queue':
      return <Badge variant="muted">In consideration</Badge>
    case 'withdrawn':
      return <Badge variant="muted">Withdrawn</Badge>
    case 'draft':
      return <Badge variant="muted">Draft</Badge>
    default:
      return <Badge variant="warning">Pending review</Badge>
  }
}

// ── shell + helpers ─────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function SubmitterShell({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  return (
    <div className="min-h-screen bg-[#FBFBFB]">
      <div className="mx-auto w-full max-w-[820px] px-5 py-10 sm:py-16">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            S
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">SpeakerWeave</span>
          {eyebrow && (
            <>
              <span className="text-border">/</span>
              <span className="truncate text-sm text-muted-foreground">{eyebrow}</span>
            </>
          )}
        </div>
        <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_10px_30px_rgba(15,23,42,0.08)] sm:p-9">
          {children}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">Powered by dais</p>
      </div>
    </div>
  )
}

function StateCard({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="px-2 py-12 text-center">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-muted">{icon}</div>
      <h1 className="mt-4 text-lg font-semibold text-foreground">{title}</h1>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}
