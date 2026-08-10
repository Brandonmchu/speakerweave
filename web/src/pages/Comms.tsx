import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow, parseISO } from 'date-fns'
import {
  AlertCircle,
  Eye,
  FileText,
  History,
  Mail,
  Pencil,
  Plus,
  Send,
  Trash2,
  Users,
} from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import {
  communicationLog,
  deleteEmailTemplate,
  listEmailTemplates,
  recipientsPreview,
  saveEmailTemplate,
  sendCommunication,
  updateEmailTemplate,
  type CommsAudience,
  type CommsDeliveryStatus,
  type CommsLogEntry,
  type CommsRole,
  type CommsSessionStatus,
  type EmailTemplate,
  type EmailTemplateInput,
} from '@/lib/commsApi'
import { deliveryStatusLabel } from '@/lib/deliveryStatus'
import { stripUnsafeHtml } from '@/lib/sanitize'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card'
import { Checkbox } from '@/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
import { Skeleton } from '@/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'

type CommsTab = 'templates' | 'compose' | 'log'
type TemplateDraft = EmailTemplateInput & { id?: string }

const ROLE_OPTIONS: Array<{ value: CommsRole; label: string }> = [
  { value: 'speaker', label: 'Speakers' },
  { value: 'submitter', label: 'Submitters' },
  { value: 'chairperson', label: 'Chairpersons' },
  { value: 'moderator', label: 'Moderators' },
]

const STATUS_OPTIONS: Array<{ value: CommsSessionStatus; label: string }> = [
  { value: 'draft', label: 'Draft' },
  { value: 'pending', label: 'Pending' },
  { value: 'accept_queue', label: 'Accept queue' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'decline_queue', label: 'Decline queue' },
  { value: 'declined', label: 'Declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
]

const MERGE_TAGS = [
  '{{first_name}}',
  '{{last_name}}',
  '{{full_name}}',
  '{{email}}',
  '{{event_name}}',
  '{{session_title}}',
]

const SAMPLE_SESSION = 'Building dependable agent workflows'

function renderPreview(text: string, context: Record<string, string>): string {
  return text.replace(
    /{{\s*(first_name|last_name|full_name|email|event_name|session_title)\s*}}/g,
    (_match, key: string) => context[key] ?? ''
  )
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function relativeTime(value?: string | null): string {
  if (!value) return '—'
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return '—'
  }
}

function statusVariant(status: CommsDeliveryStatus): 'success' | 'warning' | 'destructive' | 'muted' {
  if (status === 'sent') return 'success'
  if (status === 'queued') return 'warning'
  if (status === 'failed') return 'destructive'
  return 'muted'
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

function MergeTagLegend() {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Available merge tags">
      <span className="mr-1 text-xs font-medium text-muted-foreground">Merge tags</span>
      {MERGE_TAGS.map((tag) => (
        <code
          key={tag}
          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        >
          {tag}
        </code>
      ))}
    </div>
  )
}

function EmptyState({ icon, title, description, action }: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">{icon}</div>
      <p className="mt-4 text-base font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Comms() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<CommsTab>('templates')
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft | null>(null)
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('__custom__')
  const [customSubject, setCustomSubject] = useState('')
  const [customBody, setCustomBody] = useState('')
  const [roles, setRoles] = useState<CommsRole[]>(['speaker'])
  const [statuses, setStatuses] = useState<CommsSessionStatus[]>(['accepted'])
  const [allRoster, setAllRoster] = useState(false)
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = eventsQuery.data?.[0]

  const templatesQuery = useQuery({
    queryKey: ['email-templates', event?.id],
    queryFn: () => listEmailTemplates(event!.id),
    enabled: Boolean(event?.id),
  })
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data])

  const audience: CommsAudience = useMemo(
    () => ({ roles, statuses, all_roster: allRoster }),
    [roles, statuses, allRoster]
  )
  const previewQuery = useQuery({
    queryKey: ['comms-recipients-preview', event?.id, roles, statuses, allRoster],
    queryFn: () => recipientsPreview(event!.id, audience),
    enabled: Boolean(event?.id),
  })

  const pickerAvailable = Array.isArray(previewQuery.data?.recipients)
  const availableRecipients = previewQuery.data?.available_recipients ?? []
  useEffect(() => {
    if (!previewQuery.data?.recipients) return
    setSelectedContactIds(previewQuery.data.recipients.map((recipient) => recipient.contact_id))
  }, [previewQuery.data])

  const sendAudience: CommsAudience = useMemo(
    () => ({
      ...audience,
      ...(pickerAvailable ? { contact_ids: selectedContactIds } : {}),
    }),
    [audience, pickerAvailable, selectedContactIds]
  )

  const logQuery = useQuery({
    queryKey: ['comms-log', event?.id],
    queryFn: () => communicationLog(event!.id),
    enabled: Boolean(event?.id),
  })

  const selectedTemplate = templates.find((template) => template.key === selectedTemplateKey)
  const subjectSource = selectedTemplate?.subject ?? customSubject
  const bodySource = selectedTemplate?.body_html ?? customBody
  const recipientSample = pickerAvailable
    ? availableRecipients
        .filter((recipient) => selectedContactIds.includes(recipient.contact_id))
        .slice(0, 5)
        .map((recipient) => recipient.name)
    : (previewQuery.data?.sample ?? [])
  const sampleName = recipientSample[0] || 'Maya Okafor'
  const sampleParts = sampleName.trim().split(/\s+/)
  const previewContext = {
    first_name: sampleParts[0] || 'Maya',
    last_name: sampleParts.slice(1).join(' ') || 'Okafor',
    full_name: sampleName,
    email: 'maya@example.com',
    event_name: event?.name || 'Your event',
    session_title: SAMPLE_SESSION,
  }
  const renderedSubject = renderPreview(subjectSource, previewContext)
  const renderedBody = renderPreview(bodySource, previewContext)

  const saveTemplateMutation = useMutation({
    mutationFn: (draft: TemplateDraft) => {
      const input = { key: draft.key.trim(), subject: draft.subject.trim(), body_html: draft.body_html }
      return draft.id
        ? updateEmailTemplate(draft.id, input)
        : saveEmailTemplate(event!.id, input)
    },
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: ['email-templates', event?.id] })
      setTemplateDraft(null)
      toast({ title: 'Template saved', description: `${template.key} is ready to use.` })
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: 'Could not save template', description: error.message })
    },
  })

  const deleteTemplateMutation = useMutation({
    mutationFn: (template: EmailTemplate) => deleteEmailTemplate(template.id),
    onSuccess: (_result, template) => {
      if (selectedTemplateKey === template.key) setSelectedTemplateKey('__custom__')
      queryClient.invalidateQueries({ queryKey: ['email-templates', event?.id] })
      toast({ title: 'Template deleted' })
    },
    onError: (error: Error) => {
      toast({ variant: 'destructive', title: 'Could not delete template', description: error.message })
    },
  })

  const sendMutation = useMutation({
    mutationFn: () => {
      if (!event) throw new Error('Choose an event before sending')
      return selectedTemplate
        ? sendCommunication(event.id, { template_key: selectedTemplate.key, audience: sendAudience })
        : sendCommunication(event.id, {
            subject: customSubject.trim(),
            body_html: customBody,
            audience: sendAudience,
          })
    },
    onSuccess: (result) => {
      setConfirmOpen(false)
      queryClient.invalidateQueries({ queryKey: ['comms-log', event?.id] })
      toast({
        title: `Sent to ${result.sent}`,
        description: result.failed
          ? `${result.failed} of ${result.total} messages failed. Check the log for details.`
          : `${result.total} messages were recorded in the send log.`,
      })
      setTab('log')
    },
    onError: (error: Error) => {
      setConfirmOpen(false)
      toast({ variant: 'destructive', title: 'Send failed', description: error.message })
    },
  })

  const eventLoading = eventsQuery.isPending
  const eventError = eventsQuery.error
  const recipientCount = pickerAvailable
    ? selectedContactIds.length
    : (previewQuery.data?.count ?? 0)
  const recipientLabel =
    allRoster
      ? 'speakers'
      : roles.length === 1
      ? ROLE_OPTIONS.find((option) => option.value === roles[0])?.label.toLowerCase() || 'recipients'
      : 'recipients'
  const customReady = Boolean(customSubject.trim() && customBody.trim())
  const canSend = Boolean(
    event &&
      recipientCount > 0 &&
      !previewQuery.isPending &&
      (selectedTemplate || customReady) &&
      !sendMutation.isPending
  )

  const openNewTemplate = () => setTemplateDraft({ key: '', subject: '', body_html: '' })
  const openTemplate = (template: EmailTemplate) => setTemplateDraft({
    id: template.id,
    key: template.key,
    subject: template.subject,
    body_html: template.body_html,
  })

  return (
    <div className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-subtle text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Communications</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Manage speaker email and track every send{event ? ` for ${event.name}` : ''}.
            </p>
          </div>
        </div>
        <Button onClick={() => setTab('compose')} disabled={!event}>
          <Send />
          Compose message
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(value) => setTab(value as CommsTab)} className="mt-6">
        <TabsList variant="underline">
          <TabsTrigger value="templates"><FileText />Templates</TabsTrigger>
          <TabsTrigger value="compose"><Send />Compose</TabsTrigger>
          <TabsTrigger value="log"><History />Log</TabsTrigger>
        </TabsList>

        {eventError ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            <EmptyState
              icon={<AlertCircle className="h-6 w-6 text-destructive" />}
              title="Couldn't load communications"
              description={eventError.message}
              action={<Button variant="secondary" size="sm" onClick={() => eventsQuery.refetch()}>Try again</Button>}
            />
          </div>
        ) : eventLoading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !event ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card shadow-soft">
            <EmptyState
              icon={<Mail className="h-6 w-6 text-muted-foreground" />}
              title="No event to message"
              description="Create an event first, then its templates and recipients will appear here."
            />
          </div>
        ) : (
          <>
            <TabsContent value="templates">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Email templates</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">Reusable copy with recipient-specific merge tags.</p>
                </div>
                <Button size="sm" onClick={openNewTemplate}><Plus />New template</Button>
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
                {templatesQuery.error ? (
                  <EmptyState
                    icon={<AlertCircle className="h-6 w-6 text-destructive" />}
                    title="Couldn't load templates"
                    description={templatesQuery.error.message}
                    action={<Button size="sm" variant="secondary" onClick={() => templatesQuery.refetch()}>Try again</Button>}
                  />
                ) : templatesQuery.isPending ? (
                  <div className="divide-y divide-border">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="flex items-center gap-4 px-4 py-4">
                        <Skeleton className="h-5 w-24" />
                        <Skeleton className="h-4 flex-1" />
                        <Skeleton className="h-8 w-20" />
                      </div>
                    ))}
                  </div>
                ) : templates.length === 0 ? (
                  <EmptyState
                    icon={<FileText className="h-6 w-6 text-muted-foreground" />}
                    title="No templates yet"
                    description="Create a template for the messages your team sends repeatedly."
                    action={<Button size="sm" onClick={openNewTemplate}><Plus />New template</Button>}
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[160px]">Key</TableHead>
                        <TableHead className="w-[36%]">Subject</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead className="w-[170px] text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {templates.map((template) => (
                        <TableRow key={template.id}>
                          <TableCell><Badge variant="outline" className="font-mono">{template.key}</Badge></TableCell>
                          <TableCell className="font-medium text-foreground">{template.subject}</TableCell>
                          <TableCell className="max-w-[360px] truncate text-muted-foreground">
                            {plainText(template.body_html)}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" onClick={() => openTemplate(template)}>
                                <Pencil />Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${template.key}`}
                                disabled={deleteTemplateMutation.isPending}
                                onClick={() => {
                                  if (window.confirm(`Delete the “${template.key}” template?`)) {
                                    deleteTemplateMutation.mutate(template)
                                  }
                                }}
                              >
                                <Trash2 className="text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>

            <TabsContent value="compose">
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.12fr)_minmax(320px,0.88fr)]">
                <div className="space-y-5">
                  <Card>
                    <CardHeader>
                      <CardTitle>Audience</CardTitle>
                      <CardDescription>Choose a group, then fine-tune the individual recipients.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/25 p-3">
                        <Checkbox
                          checked={allRoster}
                          onCheckedChange={(checked) => setAllRoster(checked === true)}
                          aria-label="All speakers (roster)"
                        />
                        <span>
                          <span className="block text-sm font-medium text-foreground">All speakers (roster)</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            Every event contact, including speakers who are not attached to a session yet.
                          </span>
                        </span>
                      </label>
                      <fieldset disabled={allRoster} className={allRoster ? 'opacity-50' : undefined}>
                        <legend className="text-sm font-medium text-foreground">Roles</legend>
                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          {ROLE_OPTIONS.map((option) => (
                            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                              <Checkbox
                                checked={roles.includes(option.value)}
                                onCheckedChange={() => setRoles(toggleValue(roles, option.value))}
                                aria-label={option.label}
                              />
                              {option.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <fieldset disabled={allRoster} className={allRoster ? 'opacity-50' : undefined}>
                        <legend className="text-sm font-medium text-foreground">Session status</legend>
                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          {STATUS_OPTIONS.map((option) => (
                            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                              <Checkbox
                                checked={statuses.includes(option.value)}
                                onCheckedChange={() => setStatuses(toggleValue(statuses, option.value))}
                                aria-label={option.label}
                              />
                              {option.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary-subtle px-4 py-3">
                        <Users className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {previewQuery.isPending
                              ? 'Counting recipients…'
                              : previewQuery.error
                                ? 'Recipient count unavailable'
                                : `This will send to ${recipientCount} ${recipientLabel}`}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {previewQuery.error
                              ? previewQuery.error.message
                              : recipientSample.length
                                ? `Sample: ${recipientSample.join(', ')}`
                                : 'Leave a group unchecked to include every value in that group.'}
                          </p>
                        </div>
                      </div>
                      {availableRecipients.length > 0 && (
                        <div className="rounded-lg border border-border">
                          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                            <div>
                              <p className="text-sm font-medium text-foreground">Recipients</p>
                              <p className="text-xs text-muted-foreground">
                                {recipientCount} of {availableRecipients.length} selected
                              </p>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setSelectedContactIds(availableRecipients.map((recipient) => recipient.contact_id))
                                }
                              >
                                Select all
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setSelectedContactIds([])}
                              >
                                Clear
                              </Button>
                            </div>
                          </div>
                          <ul className="max-h-52 divide-y divide-border overflow-y-auto scrollbar-app">
                            {availableRecipients.map((recipient) => (
                              <li key={recipient.contact_id}>
                                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/30">
                                  <Checkbox
                                    checked={selectedContactIds.includes(recipient.contact_id)}
                                    onCheckedChange={(checked) =>
                                      setSelectedContactIds((current) =>
                                        checked === true
                                          ? current.includes(recipient.contact_id)
                                            ? current
                                            : [...current, recipient.contact_id]
                                          : current.filter((id) => id !== recipient.contact_id)
                                      )
                                    }
                                    aria-label={`Send to ${recipient.name}`}
                                  />
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm text-foreground">{recipient.name}</span>
                                    {recipient.email && (
                                      <span className="block truncate text-xs text-muted-foreground">{recipient.email}</span>
                                    )}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Message</CardTitle>
                      <CardDescription>Use a saved template or write a one-time email.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <div className="grid gap-2">
                        <Label htmlFor="comms-template">Template</Label>
                        <Select value={selectedTemplateKey} onValueChange={setSelectedTemplateKey}>
                          <SelectTrigger id="comms-template"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__custom__">Custom message</SelectItem>
                            {templates.map((template) => (
                              <SelectItem key={template.id} value={template.key}>{template.key}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedTemplate ? (
                        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
                          <p className="text-sm font-medium text-foreground">{selectedTemplate.subject}</p>
                          <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                            {plainText(selectedTemplate.body_html)}
                          </p>
                          <Button variant="link" size="sm" className="mt-2 h-auto px-0" onClick={() => openTemplate(selectedTemplate)}>
                            Edit template
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="grid gap-2">
                            <Label htmlFor="comms-subject" required>Subject</Label>
                            <Input
                              id="comms-subject"
                              value={customSubject}
                              onChange={(event) => setCustomSubject(event.target.value)}
                              placeholder="A clear, specific subject"
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="comms-body" required>Body HTML</Label>
                            <Textarea
                              id="comms-body"
                              value={customBody}
                              onChange={(event) => setCustomBody(event.target.value)}
                              placeholder="<p>Hi {{first_name}},</p>"
                              className="min-h-[220px] font-mono text-sm"
                            />
                          </div>
                        </>
                      )}
                      <MergeTagLegend />
                      <div className="flex justify-end">
                        <Button disabled={!canSend} onClick={() => setConfirmOpen(true)}>
                          <Send />Send message
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <aside>
                  <Card className="lg:sticky lg:top-6">
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <Eye className="h-4 w-4 text-primary" />
                        <CardTitle>Recipient preview</CardTitle>
                      </div>
                      <CardDescription>Rendered as {sampleName} will receive it.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {subjectSource ? (
                        <div className="overflow-hidden rounded-lg border border-border bg-card">
                          <div className="border-b border-border bg-muted/40 px-4 py-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
                            <p className="mt-1 text-sm font-semibold text-foreground">{renderedSubject}</p>
                          </div>
                          <div
                            className="min-h-[260px] px-5 py-5 text-sm leading-relaxed text-foreground [&_a]:text-primary [&_p]:mb-3 [&_strong]:font-semibold"
                            dangerouslySetInnerHTML={{ __html: stripUnsafeHtml(renderedBody) }}
                          />
                        </div>
                      ) : (
                        <div className="flex min-h-[340px] flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center">
                          <Mail className="h-6 w-6 text-muted-foreground" />
                          <p className="mt-3 text-sm font-medium text-foreground">Your preview will appear here</p>
                          <p className="mt-1 text-xs text-muted-foreground">Choose a template or start writing a custom message.</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </aside>
              </div>
            </TabsContent>

            <TabsContent value="log">
              <div className="mb-3">
                <h2 className="text-base font-semibold text-foreground">Send log</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">One row per recipient, newest first.</p>
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-card shadow-soft">
                {logQuery.error ? (
                  <EmptyState
                    icon={<AlertCircle className="h-6 w-6 text-destructive" />}
                    title="Couldn't load the send log"
                    description={logQuery.error.message}
                    action={<Button size="sm" variant="secondary" onClick={() => logQuery.refetch()}>Try again</Button>}
                  />
                ) : logQuery.isPending ? (
                  <div className="divide-y divide-border">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div key={index} className="flex items-center gap-4 px-4 py-4">
                        <Skeleton className="h-4 w-[24%]" />
                        <Skeleton className="h-4 w-[36%]" />
                        <Skeleton className="h-5 w-16" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    ))}
                  </div>
                ) : !logQuery.data?.length ? (
                  <EmptyState
                    icon={<History className="h-6 w-6 text-muted-foreground" />}
                    title="No messages sent yet"
                    description="Completed and failed deliveries will appear here after your first send."
                    action={<Button size="sm" onClick={() => setTab('compose')}><Send />Compose message</Button>}
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Recipient</TableHead>
                        <TableHead className="w-[36%]">Subject</TableHead>
                        <TableHead>Template</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Sent</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logQuery.data.map((entry: CommsLogEntry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            <p className="font-medium text-foreground">{entry.recipient_name || entry.recipient_email}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{entry.recipient_email}</p>
                          </TableCell>
                          <TableCell className="font-medium text-foreground">{entry.subject || '—'}</TableCell>
                          <TableCell><Badge variant="outline" className="font-mono">{entry.template_key}</Badge></TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(entry.status)} className="capitalize">
                              {deliveryStatusLabel(entry.status, entry.last_error)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground" title={entry.last_error || undefined}>
                            {relativeTime(entry.sent_at ?? entry.created_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </TabsContent>
          </>
        )}
      </Tabs>

      <Dialog open={Boolean(templateDraft)} onOpenChange={(open) => !open && setTemplateDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{templateDraft?.id ? 'Edit template' : 'New template'}</DialogTitle>
            <DialogDescription>Templates are scoped to {event?.name || 'this event'}.</DialogDescription>
          </DialogHeader>
          {templateDraft && (
            <div className="space-y-5">
              <div className="grid gap-2">
                <Label htmlFor="template-key" required>Key</Label>
                <Input
                  id="template-key"
                  value={templateDraft.key}
                  onChange={(event) => setTemplateDraft({ ...templateDraft, key: event.target.value })}
                  placeholder="speaker_followup"
                />
                <p className="text-xs text-muted-foreground">Letters, numbers, periods, underscores, and hyphens.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="template-subject" required>Subject</Label>
                <Input
                  id="template-subject"
                  value={templateDraft.subject}
                  onChange={(event) => setTemplateDraft({ ...templateDraft, subject: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="template-body" required>Body HTML</Label>
                <Textarea
                  id="template-body"
                  value={templateDraft.body_html}
                  onChange={(event) => setTemplateDraft({ ...templateDraft, body_html: event.target.value })}
                  className="min-h-[260px] font-mono text-sm"
                />
              </div>
              <MergeTagLegend />
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setTemplateDraft(null)}>Cancel</Button>
            <Button
              disabled={
                !templateDraft?.key.trim() ||
                !templateDraft.subject.trim() ||
                !templateDraft.body_html.trim() ||
                saveTemplateMutation.isPending
              }
              onClick={() => templateDraft && saveTemplateMutation.mutate(templateDraft)}
            >
              {saveTemplateMutation.isPending ? 'Saving…' : 'Save template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send this message?</DialogTitle>
            <DialogDescription>
              This will send {recipientCount} rendered {recipientCount === 1 ? 'email' : 'emails'} now and record each result in the log.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
            <p className="mt-1 text-sm font-medium text-foreground">{renderedSubject}</p>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button disabled={sendMutation.isPending} onClick={() => sendMutation.mutate()}>
              <Send />{sendMutation.isPending ? 'Sending…' : `Send to ${recipientCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
