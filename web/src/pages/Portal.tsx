import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  FileText,
  History,
  ImagePlus,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Upload,
} from 'lucide-react'

import { ApiError } from '@/lib/api'
import {
  postPortalComment,
  type ContentComment,
  type ContentVersion,
} from '@/lib/contentApi'
import { dueLabel, isOverdue } from '@/lib/dueDate'
import {
  completePortalTask,
  fetchPortalMe,
  updatePortalProfile,
  uploadPortalHeadshot,
  uploadPortalTaskFile,
  type PortalMe,
  type PortalSession,
  type PortalTask,
  type ProfileInput,
} from '@/lib/portalApi'
import { redeemToken, scrubTokenFromUrl } from '@/lib/portalAuth'
import { stripUnsafeHtml } from '@/lib/sanitize'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

const DEFAULT_ACCENT = '#A85E3E'

// Upload constraints, mirrored from the backend allowlist + size caps
// (api/security/upload_validation.py). The `accept` attribute filters the OS
// picker; the hint text tells the speaker before they even open it.
const DOC_ACCEPT =
  '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.key,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.md'
const DOC_HINT = 'PDF, PPTX, DOC, XLS or images · up to 30 MB'
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
const IMAGE_HINT = 'PNG, JPG, GIF or WebP · up to 8 MB'

const PROFILE_FIELDS = [
  'first_name',
  'last_name',
  'about',
  'company_name',
  'title',
  'pronouns',
  'linkedin_url',
  'twitter_url',
  'phone',
] as const

type ProfileForm = Record<(typeof PROFILE_FIELDS)[number], string>

const EMPTY_FORM: ProfileForm = {
  first_name: '',
  last_name: '',
  about: '',
  company_name: '',
  title: '',
  pronouns: '',
  linkedin_url: '',
  twitter_url: '',
  phone: '',
}

export function Portal() {
  const { token } = useParams()
  const queryClient = useQueryClient()
  const [booted, setBooted] = useState(false)

  // Redeem the magic-link token (if the URL carried one) into the HttpOnly
  // cookie, then scrub it from the address bar. A redeem failure is not fatal
  // here: an already-consumed token (React strict-mode double effect, a refresh)
  // still leaves a valid cookie, so the /me call below is the real verdict.
  useEffect(() => {
    let active = true
    async function boot() {
      if (token) {
        try {
          await redeemToken(token)
        } catch {
          /* fall through — the cookie may already be set */
        }
        scrubTokenFromUrl()
      }
      if (active) setBooted(true)
    }
    boot()
    return () => {
      active = false
    }
  }, [token])

  const meQuery = useQuery({
    queryKey: ['portal-me'],
    queryFn: fetchPortalMe,
    enabled: booted,
    retry: false,
  })

  const me = meQuery.data
  const accent = me?.portal.accent_color || DEFAULT_ACCENT

  if (!booted || meQuery.isPending) {
    return (
      <PortalShell accent={DEFAULT_ACCENT}>
        <div className="space-y-4">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      </PortalShell>
    )
  }

  if (meQuery.error) {
    const expired = meQuery.error instanceof ApiError && meQuery.error.status === 401
    return (
      <PortalShell accent={DEFAULT_ACCENT}>
        <Notice
          title={expired ? 'Your sign-in link has expired' : "We couldn't open your portal"}
          description={
            expired
              ? 'Ask the event organizer to send you a fresh speaker portal link.'
              : meQuery.error.message
          }
        />
      </PortalShell>
    )
  }

  if (!me) return null

  return (
    <PortalShell accent={accent} logoUrl={me.portal.logo_url}>
      <PortalHeader me={me} accent={accent} />
      <div className="mt-8 space-y-6">
        <ProfileCard
          me={me}
          accent={accent}
          onSaved={(next) =>
            queryClient.setQueryData<PortalMe>(['portal-me'], (old) =>
              old ? { ...old, contact: next } : old
            )
          }
        />
        <SessionsCard sessions={me.sessions} />
        <TasksCard tasks={me.tasks} accent={accent} />
      </div>
    </PortalShell>
  )
}

// ── header ──────────────────────────────────────────────────────────────────

function PortalHeader({ me, accent }: { me: PortalMe; accent: string }) {
  const name = [me.contact.first_name, me.contact.last_name].filter(Boolean).join(' ').trim()
  return (
    <div className="overflow-hidden rounded-2xl bg-card shadow-raised">
      <div className="h-2 w-full" style={{ backgroundColor: accent }} />
      <div className="p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
          {me.event.name ?? 'Speaker portal'}
        </p>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Welcome{name ? `, ${name}` : ''}
        </h1>
        {me.portal.welcome_html ? (
          <div
            className="rich-text mt-3 text-[15px] leading-relaxed text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: stripUnsafeHtml(me.portal.welcome_html) }}
          />
        ) : (
          <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
            This is your home for everything you need before the event — keep your profile current,
            check your sessions, and work through your onboarding tasks below.
          </p>
        )}
      </div>
    </div>
  )
}

// ── profile ─────────────────────────────────────────────────────────────────

function ProfileCard({
  me,
  accent,
  onSaved,
}: {
  me: PortalMe
  accent: string
  onSaved: (contact: PortalMe['contact']) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM)

  // Seed the form from the server copy whenever it changes (initial load + after
  // a save writes the sanitized values back).
  useEffect(() => {
    setForm({
      first_name: me.contact.first_name ?? '',
      last_name: me.contact.last_name ?? '',
      about: me.contact.about ?? '',
      company_name: me.contact.company_name ?? '',
      title: me.contact.title ?? '',
      pronouns: me.contact.pronouns ?? '',
      linkedin_url: me.contact.linkedin_url ?? '',
      twitter_url: me.contact.twitter_url ?? '',
      phone: me.contact.phone ?? '',
    })
  }, [me.contact])

  const dirty = useMemo(
    () =>
      PROFILE_FIELDS.some(
        (field) => (form[field] ?? '') !== ((me.contact[field] as string | null) ?? '')
      ),
    [form, me.contact]
  )

  const save = useMutation({
    mutationFn: (patch: ProfileInput) => updatePortalProfile(patch),
    onSuccess: (data) => {
      onSaved(data.contact)
      toast({ title: 'Profile saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save", description: error.message }),
  })

  const photo = useMutation({
    mutationFn: (file: File) => uploadPortalHeadshot(file),
    onSuccess: (data) => {
      queryClient.setQueryData<PortalMe>(['portal-me'], (old) =>
        old ? { ...old, contact: { ...old.contact, photo_url: data.photo_url } } : old
      )
      toast({ title: 'Headshot updated' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't upload photo", description: error.message }),
  })

  const set = (field: keyof ProfileForm) => (value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }))

  const handleSave = () => {
    const patch: ProfileInput = {}
    for (const field of PROFILE_FIELDS) {
      if ((form[field] ?? '') !== ((me.contact[field] as string | null) ?? '')) {
        patch[field] = form[field]
      }
    }
    if (Object.keys(patch).length > 0) save.mutate(patch)
  }

  return (
    <Section title="Your profile" description="This is what organizers and attendees see about you.">
      <div className="flex flex-col gap-6 sm:flex-row">
        <Headshot
          photoUrl={me.contact.photo_url}
          name={[form.first_name, form.last_name].filter(Boolean).join(' ')}
          accent={accent}
          pending={photo.isPending}
          onFile={(file) => photo.mutate(file)}
        />
        <div className="min-w-0 flex-1 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldWrap id="first_name" label="First name">
              <Input id="first_name" value={form.first_name} onChange={(e) => set('first_name')(e.target.value)} />
            </FieldWrap>
            <FieldWrap id="last_name" label="Last name">
              <Input id="last_name" value={form.last_name} onChange={(e) => set('last_name')(e.target.value)} />
            </FieldWrap>
            <FieldWrap id="title" label="Job title">
              <Input id="title" value={form.title} placeholder="e.g. Staff Engineer" onChange={(e) => set('title')(e.target.value)} />
            </FieldWrap>
            <FieldWrap id="company_name" label="Company">
              <Input id="company_name" value={form.company_name} onChange={(e) => set('company_name')(e.target.value)} />
            </FieldWrap>
          </div>
          <FieldWrap id="about" label="Bio">
            <Textarea
              id="about"
              value={form.about}
              autoResize
              placeholder="A short speaker bio for the program and website."
              onChange={(e) => set('about')(e.target.value)}
            />
          </FieldWrap>
          <div className="grid gap-4 sm:grid-cols-3">
            <FieldWrap id="pronouns" label="Pronouns">
              <Input id="pronouns" value={form.pronouns} placeholder="she/her" onChange={(e) => set('pronouns')(e.target.value)} />
            </FieldWrap>
            <FieldWrap id="linkedin_url" label="LinkedIn">
              <Input id="linkedin_url" value={form.linkedin_url} placeholder="linkedin.com/in/…" onChange={(e) => set('linkedin_url')(e.target.value)} />
            </FieldWrap>
            <FieldWrap id="twitter_url" label="X / Twitter">
              <Input id="twitter_url" value={form.twitter_url} placeholder="@handle" onChange={(e) => set('twitter_url')(e.target.value)} />
            </FieldWrap>
          </div>
          <FieldWrap id="phone" label="Phone">
            <Input id="phone" value={form.phone} type="tel" onChange={(e) => set('phone')(e.target.value)} />
          </FieldWrap>
          <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
            {save.isError && <span className="mr-auto text-sm text-destructive">Save failed</span>}
            <Button
              onClick={handleSave}
              disabled={!dirty || save.isPending}
              style={{ backgroundColor: accent, borderColor: accent }}
              className="text-white"
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              {save.isPending ? 'Saving…' : 'Save profile'}
            </Button>
          </div>
        </div>
      </div>
    </Section>
  )
}

function Headshot({
  photoUrl,
  name,
  accent,
  pending,
  onFile,
}: {
  photoUrl: string | null
  name: string
  accent: string
  pending: boolean
  onFile: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onFile(file)
    e.target.value = ''
  }
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border border-border bg-muted"
        style={photoUrl ? undefined : { backgroundColor: `${accent}14` }}
      >
        {photoUrl ? (
          <img src={photoUrl} alt={name || 'Headshot'} className="h-full w-full object-cover" />
        ) : (
          <span className="text-2xl font-semibold" style={{ color: accent }}>
            {initials(name)}
          </span>
        )}
        {pending && (
          <div className="absolute inset-0 flex items-center justify-center bg-foreground/40">
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          </div>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={pending}>
        <ImagePlus />
        {photoUrl ? 'Change photo' : 'Add photo'}
      </Button>
      <p className="text-center text-[11px] text-muted-foreground" data-testid="headshot-hint">
        {IMAGE_HINT}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        data-testid="headshot-input"
        className="hidden"
        onChange={onChange}
      />
    </div>
  )
}

// ── sessions ─────────────────────────────────────────────────────────────────

function SessionsCard({ sessions }: { sessions: PortalSession[] }) {
  return (
    <Section title="Your sessions" description="The talks you're on and where they stand.">
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You&rsquo;re not attached to any sessions yet. If that looks wrong, reach out to the
          organizer.
        </p>
      ) : (
        <ul className="space-y-3">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-foreground">{session.title || 'Untitled session'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {session.role && <span className="capitalize">{session.role}</span>}
                  {session.starts_at && (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(session.starts_at)}
                    </span>
                  )}
                  {session.friendly_id && <span className="font-mono">{session.friendly_id}</span>}
                </div>
              </div>
              <SessionStatus status={session.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

const SESSION_STATUS: Record<string, { label: string; className: string }> = {
  accepted: { label: 'Accepted', className: 'bg-success/12 text-success-strong' },
  accept_queue: { label: 'In review', className: 'bg-warning/15 text-warning-strong' },
  pending: { label: 'Under review', className: 'bg-warning/15 text-warning-strong' },
  decline_queue: { label: 'In review', className: 'bg-foreground/5 text-muted-foreground' },
  declined: { label: 'Not selected', className: 'bg-destructive/10 text-destructive-strong' },
  withdrawn: { label: 'Withdrawn', className: 'bg-foreground/5 text-muted-foreground' },
  draft: { label: 'Draft', className: 'bg-foreground/5 text-muted-foreground' },
}

function SessionStatus({ status }: { status: string | null }) {
  const meta = (status && SESSION_STATUS[status]) || {
    label: status ?? 'Submitted',
    className: 'bg-foreground/5 text-muted-foreground',
  }
  return (
    <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-xs font-medium', meta.className)}>
      {meta.label}
    </span>
  )
}

// ── tasks ────────────────────────────────────────────────────────────────────

function TasksCard({ tasks, accent }: { tasks: PortalTask[]; accent: string }) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['portal-me'] })

  const complete = useMutation({
    mutationFn: (assignmentId: string) => completePortalTask(assignmentId),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Task completed' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't complete task", description: error.message }),
  })

  const upload = useMutation({
    mutationFn: ({ assignmentId, file }: { assignmentId: string; file: File }) =>
      uploadPortalTaskFile(assignmentId, file),
    onSuccess: () => {
      invalidate()
      toast({ title: 'File uploaded' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: 'Upload failed', description: error.message }),
  })

  const done = tasks.filter((t) => t.status === 'done' || t.status === 'approved').length

  return (
    <Section
      title="Your tasks"
      description={tasks.length ? `${done} of ${tasks.length} complete` : 'Nothing to do yet.'}
    >
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You&rsquo;re all caught up — the organizer hasn&rsquo;t assigned any onboarding tasks yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => (
            <TaskRow
              key={task.assignment_id}
              task={task}
              accent={accent}
              completePending={complete.isPending && complete.variables === task.assignment_id}
              uploadPending={upload.isPending && upload.variables?.assignmentId === task.assignment_id}
              onComplete={() => complete.mutate(task.assignment_id)}
              onUpload={(file) => upload.mutate({ assignmentId: task.assignment_id, file })}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}

const TASK_STATUS: Record<string, { label: string; className: string }> = {
  todo: { label: 'To do', className: 'bg-foreground/5 text-muted-foreground' },
  submitted: { label: 'Awaiting review', className: 'bg-warning/15 text-warning-strong' },
  approved: { label: 'Approved', className: 'bg-success/12 text-success-strong' },
  done: { label: 'Done', className: 'bg-success/12 text-success-strong' },
  denied: { label: 'Needs changes', className: 'bg-destructive/10 text-destructive-strong' },
}

// The /me payload now carries version history + a comment thread on each task.
// PortalTask (lib/portalApi.ts) predates them, so read the extras through this
// augmentation without widening the shared type.
type PortalTaskContent = Omit<PortalTask, 'file'> & {
  versions?: ContentVersion[]
  comments?: ContentComment[]
  file: { filename: string; url: string | null; version?: number } | null
}

function TaskRow({
  task,
  accent,
  completePending,
  uploadPending,
  onComplete,
  onUpload,
}: {
  task: PortalTaskContent
  accent: string
  completePending: boolean
  uploadPending: boolean
  onComplete: () => void
  onUpload: (file: File) => void
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [reply, setReply] = useState('')
  const versions = task.versions ?? []
  const priorVersions = versions.filter((v) => !v.is_current)
  const comments = task.comments ?? []
  const current = versions.find((v) => v.is_current)
  const currentVersion = current?.version ?? task.file?.version
  const currentUpload = current?.created_at ?? null

  const sendComment = useMutation({
    mutationFn: (body: string) => postPortalComment(task.assignment_id, body),
    onSuccess: () => {
      setReply('')
      queryClient.invalidateQueries({ queryKey: ['portal-me'] })
      toast({ title: 'Reply sent' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't send reply", description: error.message }),
  })

  const status = task.status
  const isDone = status === 'done' || status === 'approved'
  const meta = TASK_STATUS[status] ?? { label: status, className: 'bg-foreground/5 text-muted-foreground' }
  const overdue = isOverdue(task.task.due_at) && !isDone

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) onUpload(file)
    e.target.value = ''
  }

  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          {isDone ? (
            <CheckCircle2 className="h-5 w-5" style={{ color: accent }} />
          ) : status === 'submitted' ? (
            <Clock className="h-5 w-5 text-warning-strong" />
          ) : status === 'denied' ? (
            <AlertCircle className="h-5 w-5 text-destructive" />
          ) : (
            <Circle className="h-5 w-5 text-muted-foreground/50" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{task.task.name}</p>
            {task.task.required && (
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive-strong">
                Required
              </span>
            )}
            <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', meta.className)}>
              {meta.label}
            </span>
          </div>
          {task.task.description && (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {task.task.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {task.task.due_at && (
              <span
                data-testid={`task-due-${task.assignment_id}`}
                className={overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}
              >
                {dueLabel(task.task.due_at)}
                {overdue && ' · overdue'}
              </span>
            )}
            {task.task.link_url && (
              <a
                href={task.task.link_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium"
                style={{ color: accent }}
              >
                <ExternalLink className="h-3 w-3" />
                Open link
              </a>
            )}
          </div>

          {task.file && (
            <div className="mt-3 space-y-1.5">
              <a
                href={task.file.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground hover:bg-accent"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{task.file.filename}</span>
                {currentVersion ? (
                  <span className="shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    v{currentVersion}
                  </span>
                ) : null}
                {currentUpload && (
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    data-testid="current-version-time"
                  >
                    Uploaded {timestamp(currentUpload)}
                  </span>
                )}
              </a>
              {priorVersions.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowHistory((s) => !s)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <History className="h-3 w-3" />
                    {showHistory
                      ? 'Hide previous versions'
                      : `View ${priorVersions.length} previous version${priorVersions.length === 1 ? '' : 's'}`}
                  </button>
                  {showHistory && (
                    <ul
                      className="mt-1.5 space-y-1 border-l border-border pl-3"
                      data-testid="version-history"
                    >
                      {priorVersions.map((version) => (
                        <li key={version.file_id} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded bg-foreground/5 px-1.5 py-0.5 font-medium text-muted-foreground">
                            v{version.version}
                          </span>
                          {version.url ? (
                            <a
                              href={version.url}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate font-medium"
                              style={{ color: accent }}
                            >
                              {version.filename}
                            </a>
                          ) : (
                            <span className="truncate text-muted-foreground">{version.filename}</span>
                          )}
                          {/* A version without a date is just a number — say when
                              it landed so "previous" means something. */}
                          <span className="text-muted-foreground" data-testid="version-time">
                            {version.created_at
                              ? `Uploaded ${timestamp(version.created_at)}`
                              : 'Upload time not recorded'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {/* actions */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {task.task.kind === 'todo' && !isDone && (
              <Button
                size="sm"
                onClick={onComplete}
                disabled={completePending}
                style={{ backgroundColor: accent, borderColor: accent }}
                className="text-white"
              >
                {completePending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                Mark complete
              </Button>
            )}
            {task.task.kind === 'file_request' && status !== 'approved' && (
              <>
                <Button
                  size="sm"
                  variant={task.file ? 'outline' : 'default'}
                  onClick={() => inputRef.current?.click()}
                  disabled={uploadPending}
                  style={task.file ? undefined : { backgroundColor: accent, borderColor: accent }}
                  className={task.file ? undefined : 'text-white'}
                >
                  {uploadPending ? (
                    <Loader2 className="animate-spin" />
                  ) : task.file ? (
                    <RefreshCw />
                  ) : (
                    <Upload />
                  )}
                  {task.file ? 'Replace file' : 'Upload file'}
                </Button>
                <span className="text-xs text-muted-foreground" data-testid="upload-hint">
                  {DOC_HINT}
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  accept={DOC_ACCEPT}
                  data-testid="upload-input"
                  className="hidden"
                  onChange={onChange}
                />
              </>
            )}
          </div>

          {/* organizer feedback + speaker replies */}
          {(comments.length > 0 || task.task.kind === 'file_request') && (
            <div
              className="mt-4 rounded-lg border border-border bg-muted/20 p-3"
              data-testid="feedback-thread"
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                Feedback
              </p>
              {comments.length === 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  No feedback yet. Anything the organizer sends will show up here.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {comments.map((comment) => (
                    <li key={comment.id} className="rounded-md bg-card px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {comment.author_label ??
                            (comment.author_role === 'organizer' ? 'Organizer' : 'You')}
                        </span>
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={
                            comment.author_role === 'organizer'
                              ? { backgroundColor: `${accent}14`, color: accent }
                              : undefined
                          }
                        >
                          {comment.author_role}
                        </span>
                        {/* Feedback with no time is un-actionable: "please
                            re-upload" reads differently a month later. */}
                        <span className="text-[11px] text-muted-foreground" data-testid="comment-time">
                          {comment.created_at ? timestamp(comment.created_at) : 'Time not recorded'}
                        </span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
                        {comment.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Textarea
                  value={reply}
                  autoResize
                  data-testid="reply-input"
                  placeholder="Reply to the organizer…"
                  className="min-h-9 flex-1"
                  onChange={(e) => setReply(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendComment.mutate(reply.trim())}
                  disabled={!reply.trim() || sendComment.isPending}
                  className="self-end"
                >
                  {sendComment.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                  Reply
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

// ── shared pieces ────────────────────────────────────────────────────────────

function PortalShell({
  children,
  accent,
  logoUrl,
}: {
  children: ReactNode
  accent: string
  logoUrl?: string | null
}) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-[860px] px-4 py-8 sm:py-12">
        <div className="mb-6 flex items-center gap-2">
          {logoUrl ? (
            <img src={logoUrl} alt="Event logo" className="h-7 w-auto max-w-[160px] object-contain" />
          ) : (
            <>
              <div
                className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md"
                style={{ backgroundColor: accent }}
              >
                <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true">
                  <path d="M9.9 22.3 L13.7 18.5" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
                  <path d="M19.8 12.4 L21.8 10.4" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
                  <path d="M21.7 9.2c-1.1-1.2-2.8-1.9-4.7-1.9-2.9 0-5 1.6-5 3.9 0 2.1 1.5 3.2 4.3 3.9l1.3.3" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
                  <path d="M20.4 16.8c1.8.6 2.7 1.5 2.7 2.9 0 2.3-2.1 3.9-5 3.9-1.9 0-3.6-.7-4.7-1.9" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none" />
                </svg>
              </div>
              <span className="text-sm font-semibold tracking-tight text-foreground">speakerweave</span>
            </>
          )}
        </div>
        {children}
        <p className="mt-8 text-center text-xs text-muted-foreground">Powered by dais</p>
      </div>
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 sm:p-8">
      <div className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function FieldWrap({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

function Notice({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-2xl bg-card p-8 text-center shadow-raised">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="h-6 w-6 text-destructive" />
      </div>
      <p className="mt-4 text-base font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '★'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

function formatDate(value: string): string {
  try {
    return format(parseISO(value), 'MMM d, yyyy')
  } catch {
    return value
  }
}

/** Date AND time — what an upload or a piece of feedback needs to be placed. */
function timestamp(value: string): string {
  try {
    return format(parseISO(value), 'MMM d, yyyy · HH:mm')
  } catch {
    return value
  }
}
