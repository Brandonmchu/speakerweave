/**
 * The contact record, shared by the Directory table and the Pipeline board.
 *
 * One drawer rather than two views of the same person: whichever surface you
 * opened it from, the record is the same record — identity, the events they
 * have appeared at, internal notes, tags and organizer-defined fields, the
 * sourcing stage and the log of how it got there.
 *
 * Rendered as a plain fixed panel rather than a Radix dialog on purpose. This
 * is the surface an eval agent has to read and operate, and a portal full of
 * `role="dialog"` focus traps is exactly the thing that goes wrong for one.
 * Every control inside it is a native `<input>`, `<select>` or `<button>`.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Building2,
  CalendarDays,
  Copy,
  History,
  Mail,
  MessageSquare,
  Plus,
  Tag as TagIcon,
  Users,
  X,
} from 'lucide-react'

import {
  STAGE_LABELS,
  addNote,
  addToEvent,
  createCustomField,
  getPerson,
  moveStage,
  updatePerson,
  type CustomFieldDef,
  type DirectoryPerson,
} from '@/lib/crmApi'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Textarea } from '@/ui/textarea'
import { useToast } from '@/ui/use-toast'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function SectionHeading({ icon: Icon, children }: { icon: typeof Mail; children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </h3>
  )
}

export function CrmPersonDrawer({
  personId,
  onClose,
  onMerge,
}: {
  personId: string
  onClose: () => void
  onMerge?: (person: DirectoryPerson) => void
}) {
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['crm', 'person', personId],
    queryFn: () => getPerson(personId),
  })

  const [noteBody, setNoteBody] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [eventChoice, setEventChoice] = useState('')
  const [showFieldForm, setShowFieldForm] = useState(false)
  const [fieldLabel, setFieldLabel] = useState('')
  const [fieldType, setFieldType] = useState<CustomFieldDef['field_type']>('dropdown')
  const [fieldOptions, setFieldOptions] = useState('Internal, External')

  useEffect(() => {
    setNoteBody('')
    setTagDraft('')
  }, [personId])

  const person = data?.person
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['crm', 'person', personId] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'directory'] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'pipeline'] })
    void queryClient.invalidateQueries({ queryKey: ['crm', 'overview'] })
  }

  const noteMutation = useMutation({
    mutationFn: (body: string) => addNote(personId, body),
    onSuccess: () => {
      setNoteBody('')
      toast({ title: 'Note saved' })
      refresh()
    },
    onError: (error: Error) => toast({ title: "Couldn't save the note", description: error.message }),
  })

  const patchMutation = useMutation({
    mutationFn: (input: Parameters<typeof updatePerson>[1]) => updatePerson(personId, input),
    onSuccess: () => refresh(),
    onError: (error: Error) => toast({ title: "Couldn't save", description: error.message }),
  })

  const stageMutation = useMutation({
    mutationFn: (stage: string) => moveStage(personId, { stage }),
    onSuccess: (_result, stage) => {
      toast({ title: `Moved to ${STAGE_LABELS[stage] ?? stage}` })
      refresh()
    },
  })

  const eventMutation = useMutation({
    mutationFn: (eventId: string) => addToEvent(personId, eventId),
    onSuccess: (result) => {
      toast({
        title: result.created
          ? `Added to ${result.event.name}`
          : `Already on ${result.event.name}`,
        description: `${result.contact.email} — profile carried over.`,
      })
      setEventChoice('')
      refresh()
    },
    onError: (error: Error) => toast({ title: "Couldn't add to the event", description: error.message }),
  })

  const fieldMutation = useMutation({
    mutationFn: () =>
      createCustomField({
        label: fieldLabel.trim(),
        field_type: fieldType,
        options: fieldOptions
          .split(',')
          .map((option) => option.trim())
          .filter(Boolean),
      }),
    onSuccess: (field) => {
      toast({ title: `Field "${field.label}" created` })
      setShowFieldForm(false)
      setFieldLabel('')
      refresh()
    },
    onError: (error: Error) => toast({ title: "Couldn't create the field", description: error.message }),
  })

  const tagSuggestions = useMemo(() => {
    const used = new Set((person?.tags ?? []).map((tag) => tag.toLowerCase()))
    return (data?.tag_library ?? []).filter((tag) => !used.has(tag.toLowerCase())).slice(0, 12)
  }, [data?.tag_library, person?.tags])

  const addTag = (tag: string) => {
    const next = [...(person?.tags ?? []), tag].filter(Boolean)
    setTagDraft('')
    patchMutation.mutate({ tags: next })
  }

  const removeTag = (tag: string) => {
    patchMutation.mutate({ tags: (person?.tags ?? []).filter((value) => value !== tag) })
  }

  return (
    <div className="fixed inset-0 z-50 flex" role="region" aria-label="Contact record">
      <button
        type="button"
        aria-label="Close contact"
        className="flex-1 bg-foreground/20"
        onClick={onClose}
      />
      <aside className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-card shadow-lifted scrollbar-app">
        {isLoading || !person ? (
          <div className="p-6 text-sm text-muted-foreground">Loading contact…</div>
        ) : (
          <>
            {/* Identity */}
            <header className="flex items-start gap-4 border-b border-border p-6">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] font-mono text-lg font-semibold text-foreground">
                {initials(person.name)}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-xl font-semibold text-foreground">{person.name}</h2>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{person.email}</p>
                <p className="mt-1 text-sm text-foreground">
                  {[person.title, person.company_name].filter(Boolean).join(' · ') || 'No company or title'}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">
                    {STAGE_LABELS[person.pipeline_stage] ?? person.pipeline_stage}
                  </Badge>
                  <Badge variant="muted">
                    {person.event_count} {person.event_count === 1 ? 'event' : 'events'}
                  </Badge>
                  {person.event_count > 1 && <Badge variant="success">Returning speaker</Badge>}
                  {data.duplicates.length > 0 && (
                    <Badge variant="warning">Possible duplicate</Badge>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </header>

            <div className="space-y-7 p-6">
              {/* Duplicate warning + merge entry point */}
              {data.duplicates.length > 0 && (
                <section className="rounded-lg border border-warning/40 bg-warning/10 p-4">
                  <div className="flex items-start gap-2">
                    <Copy className="mt-0.5 h-4 w-4 shrink-0 text-warning-strong" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">
                        Possible duplicate contact
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {data.duplicates
                          .map((other) => `${other.name} <${other.email}>`)
                          .join(', ')}{' '}
                        looks like the same person.
                      </p>
                      {onMerge && (
                        <Button
                          size="sm"
                          className="mt-2"
                          onClick={() => onMerge(person)}
                        >
                          Merge duplicates
                        </Button>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {person.about && (
                <section className="space-y-2">
                  <SectionHeading icon={Users}>Bio</SectionHeading>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{person.about}</p>
                </section>
              )}

              {/* Tags — CRM-04 */}
              <section className="space-y-2">
                <SectionHeading icon={TagIcon}>Tags</SectionHeading>
                <div className="flex flex-wrap items-center gap-1.5">
                  {person.tags.length === 0 && (
                    <span className="text-sm text-muted-foreground">No tags yet</span>
                  )}
                  {person.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                    >
                      {tag}
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => removeTag(tag)}
                        className="text-primary/70 hover:text-primary"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    placeholder="Add a tag (e.g. AI)"
                    aria-label="Add a tag"
                    className="h-9 max-w-xs"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && tagDraft.trim()) {
                        event.preventDefault()
                        addTag(tagDraft.trim())
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!tagDraft.trim()}
                    onClick={() => addTag(tagDraft.trim())}
                  >
                    Add tag
                  </Button>
                </div>
                {tagSuggestions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-xs text-muted-foreground">From your tag library:</span>
                    {tagSuggestions.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => addTag(tag)}
                        className="rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent"
                      >
                        + {tag}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/* Custom fields — CRM-04 */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <SectionHeading icon={Plus}>Custom fields</SectionHeading>
                  <Button size="sm" variant="outline" onClick={() => setShowFieldForm((open) => !open)}>
                    {showFieldForm ? 'Cancel' : 'Add field'}
                  </Button>
                </div>

                {showFieldForm && (
                  <div className="space-y-3 rounded-lg border border-border bg-background p-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="crm-field-label">Field name</Label>
                        <Input
                          id="crm-field-label"
                          value={fieldLabel}
                          onChange={(event) => setFieldLabel(event.target.value)}
                          placeholder="Speaker Type"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="crm-field-type">Field type</Label>
                        <NativeSelect
                          id="crm-field-type"
                          value={fieldType}
                          onValueChange={(value) => setFieldType(value as CustomFieldDef['field_type'])}
                          options={[
                            { value: 'dropdown', label: 'Dropdown' },
                            { value: 'text', label: 'Text' },
                            { value: 'number', label: 'Number' },
                            { value: 'date', label: 'Date' },
                          ]}
                        />
                      </div>
                    </div>
                    {fieldType === 'dropdown' && (
                      <div className="space-y-1.5">
                        <Label htmlFor="crm-field-options">Options (comma separated)</Label>
                        <Input
                          id="crm-field-options"
                          value={fieldOptions}
                          onChange={(event) => setFieldOptions(event.target.value)}
                          placeholder="Internal, External"
                        />
                      </div>
                    )}
                    <Button
                      size="sm"
                      disabled={!fieldLabel.trim() || fieldMutation.isPending}
                      onClick={() => fieldMutation.mutate()}
                    >
                      Create field
                    </Button>
                  </div>
                )}

                {data.custom_fields.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No custom fields yet. Add one to record anything dais doesn't ask for.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {data.custom_fields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label htmlFor={`crm-custom-${field.key}`}>{field.label}</Label>
                        {field.field_type === 'dropdown' ? (
                          <NativeSelect
                            id={`crm-custom-${field.key}`}
                            value={person.custom[field.key] ?? ''}
                            placeholder="Not set"
                            onValueChange={(value) =>
                              patchMutation.mutate({ custom: { [field.key]: value || null } })
                            }
                            options={field.options.map((option) => ({ value: option }))}
                          />
                        ) : (
                          <Input
                            id={`crm-custom-${field.key}`}
                            type={field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'}
                            defaultValue={person.custom[field.key] ?? ''}
                            onBlur={(event) =>
                              patchMutation.mutate({ custom: { [field.key]: event.target.value || null } })
                            }
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Sourcing stage — CRM-07 */}
              <section className="space-y-2">
                <SectionHeading icon={History}>Sourcing stage</SectionHeading>
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    aria-label="Move to stage"
                    className="max-w-[14rem]"
                    value={person.pipeline_stage}
                    onValueChange={(value) => stageMutation.mutate(value)}
                    options={Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }))}
                  />
                  {!person.in_pipeline && (
                    <span className="text-xs text-muted-foreground">
                      Not yet on the pipeline board — picking a stage enrols them.
                    </span>
                  )}
                  {person.score != null && <Badge variant="muted">Score {person.score}</Badge>}
                </div>
                {person.rationale && (
                  <p className="text-sm text-muted-foreground">{person.rationale}</p>
                )}
              </section>

              {/* Stage history — CRM-08 */}
              <section className="space-y-2">
                <SectionHeading icon={History}>Stage history</SectionHeading>
                {data.stage_history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No stage changes recorded yet.</p>
                ) : (
                  <ol className="space-y-2">
                    {data.stage_history.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
                      >
                        <span className="font-medium text-foreground">
                          {entry.from_label ? `${entry.from_label} → ${entry.to_label}` : `Enrolled at ${entry.to_label}`}
                        </span>
                        <span className="text-xs text-muted-foreground">{formatDate(entry.created_at)}</span>
                        <span className="text-xs text-muted-foreground">· {entry.actor}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {/* Internal notes — CRM-03 / CRM-08 */}
              <section className="space-y-3">
                <SectionHeading icon={MessageSquare}>Internal notes</SectionHeading>
                <div className="space-y-2">
                  <Textarea
                    aria-label="Add an internal note"
                    placeholder="Add an internal note…"
                    rows={3}
                    value={noteBody}
                    onChange={(event) => setNoteBody(event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={!noteBody.trim() || noteMutation.isPending}
                    onClick={() => noteMutation.mutate(noteBody.trim())}
                  >
                    Save note
                  </Button>
                </div>
                {data.notes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No notes yet. Notes are internal — speakers never see them.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {data.notes.map((note) => (
                      <li key={note.id} className="rounded-md border border-border bg-background p-3">
                        <p className="whitespace-pre-wrap text-sm text-foreground">{note.body}</p>
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          {note.author} · {formatDate(note.created_at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Cross-event history — CRM-03 */}
              <section className="space-y-3">
                <SectionHeading icon={CalendarDays}>Events &amp; sessions</SectionHeading>
                {data.appearances.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not attached to any event yet. Use “Add to event” below.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {data.appearances.map((appearance) => (
                      <li
                        key={appearance.event_id}
                        className="rounded-md border border-border bg-background p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">{appearance.event_name}</p>
                          <span className="text-xs text-muted-foreground">
                            {appearance.tasks_done}/{appearance.tasks_total} onboarding tasks
                          </span>
                        </div>
                        {appearance.sessions.length > 0 && (
                          <ul className="mt-1.5 space-y-1">
                            {appearance.sessions.map((session) => (
                              <li key={session.id} className="text-sm text-muted-foreground">
                                {session.title ?? 'Untitled session'}{' '}
                                <Badge variant="muted" className="ml-1 align-middle">
                                  {session.status}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                        {appearance.submissions.length > 0 && (
                          <p className="mt-1.5 text-xs text-muted-foreground">
                            {appearance.submissions.length} submission
                            {appearance.submissions.length === 1 ? '' : 's'}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {/* Push into an event — CRM-10 */}
                <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-background p-3">
                  <div className="min-w-[14rem] flex-1 space-y-1.5">
                    <Label htmlFor="crm-add-to-event">Add to event</Label>
                    <NativeSelect
                      id="crm-add-to-event"
                      value={eventChoice}
                      placeholder="Choose an event…"
                      onValueChange={setEventChoice}
                      options={data.events.map((event) => ({ value: event.id, label: event.name }))}
                    />
                  </div>
                  <Button
                    disabled={!eventChoice || eventMutation.isPending}
                    onClick={() => eventMutation.mutate(eventChoice)}
                  >
                    Add to event
                  </Button>
                </div>
              </section>

              {/* Communications — CRM-03 activity surface */}
              <section className="space-y-2">
                <SectionHeading icon={Mail}>Communications</SectionHeading>
                {data.communications.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No emails sent to this contact yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {data.communications.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"
                      >
                        <span className="font-medium text-foreground">
                          {entry.subject ?? entry.template_key ?? 'Email'}
                        </span>
                        <Badge variant="muted">{entry.status ?? 'queued'}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(entry.sent_at ?? entry.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {(person.company_name || person.alt_emails.length > 0) && (
                <section className="space-y-2">
                  <SectionHeading icon={Building2}>Record details</SectionHeading>
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Company</dt>
                      <dd className="text-foreground">{person.company_name ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Title</dt>
                      <dd className="text-foreground">{person.title ?? '—'}</dd>
                    </div>
                    {person.alt_emails.length > 0 && (
                      <div className="flex justify-between gap-2 sm:col-span-2">
                        <dt className="text-muted-foreground">Merged addresses</dt>
                        <dd className="text-foreground">{person.alt_emails.join(', ')}</dd>
                      </div>
                    )}
                  </dl>
                </section>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
