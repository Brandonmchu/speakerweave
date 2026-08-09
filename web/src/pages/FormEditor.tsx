import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  GitBranch,
  GripVertical,
  Layers,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react'

import {
  FIELD_TYPES,
  createField,
  fieldTypeLabel,
  getForm,
  listFields,
  publicFormPath,
  publicFormUrl,
  putFormFields,
  putFormRules,
  updateForm,
  type FieldOptions,
  type FormFieldInput,
  type FormFieldRow,
  type FormSettings,
  type FormSummary,
  type LibraryField,
  type QuestionRule,
  type RuleAction,
  type RuleCondition,
  type RuleMatch,
  type RuleOp,
} from '@/lib/adminApi'
import {
  isValuelessOp,
  opPhrase,
  ruleSentenceSegments,
  type RuleFieldLookup,
} from '@/lib/ruleText'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Checkbox } from '@/ui/checkbox'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select'
import { Skeleton } from '@/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs'
import { Textarea } from '@/ui/textarea'
import { toast } from '@/ui/use-toast'
import { CopyButton } from '@/pages/Forms'

/* -------------------------------------------------------------------------- */
/* Draft model                                                                */
/*                                                                            */
/* Every tab edits a local draft and saves it with one explicit request. The   */
/* fields and rules endpoints are full replaces, so a half-applied form is     */
/* impossible: either the whole ordering lands or none of it does.            */
/* -------------------------------------------------------------------------- */

/** Pages 3 and 4 are the two the seeded CFP uses; the rest are free-form.
 * Capped at 4 to match the DB (form_fields.page CHECK page between 1 and 4). */
const PAGE_LABELS: Record<number, string> = {
  1: 'Welcome',
  2: 'About you',
  3: 'Your session',
  4: 'Speaker info',
}
const PAGES = [1, 2, 3, 4]
const DEFAULT_PAGE = 3

function pageLabel(page: number): string {
  return PAGE_LABELS[page] ?? `Page ${page}`
}

interface DraftField {
  /** Stable React key that survives reordering; not sent to the backend. */
  key: string
  field_id: string
  page: number
  label_override: string
  help_text: string
  required: boolean
  public_name: string
  field_type: string
  options?: FieldOptions | null
}

interface DraftRule {
  key: string
  id?: string
  target_field_id: string
  action: RuleAction
  match: RuleMatch
  when: RuleCondition[]
}

interface SettingsDraft {
  name: string
  welcome_html: string
  close_at: string
  submission_limit: string
  confirmation_html: string
}

let keySeq = 0
function nextKey(prefix: string): string {
  keySeq += 1
  return `${prefix}-${keySeq}`
}

function toDraftField(row: FormFieldRow): DraftField {
  return {
    key: row.form_field_id ?? nextKey('ff'),
    field_id: row.field_id,
    page: row.page ?? DEFAULT_PAGE,
    label_override: row.label_override ?? '',
    help_text: row.help_text ?? '',
    required: Boolean(row.required),
    public_name: row.public_name,
    field_type: row.field_type,
    options: row.options ?? null,
  }
}

function toDraftRule(rule: QuestionRule): DraftRule {
  return {
    key: rule.id ?? nextKey('rule'),
    id: rule.id,
    target_field_id: rule.target_field_id,
    action: rule.logic?.action ?? 'show',
    match: rule.logic?.match ?? 'all',
    when: (rule.logic?.when ?? []).map((c) => ({ ...c })),
  }
}

function toSettingsDraft(form: FormSummary): SettingsDraft {
  const settings = form.settings ?? {}
  return {
    name: form.name ?? '',
    welcome_html: form.welcome_html ?? '',
    close_at: toLocalInput(settings.close_at),
    submission_limit:
      settings.submission_limit === null || settings.submission_limit === undefined
        ? ''
        : String(settings.submission_limit),
    confirmation_html: settings.confirmation_html ?? '',
  }
}

/** Display order is (page, position). Array order carries position. */
function sortByPage(list: DraftField[]): DraftField[] {
  return [...list].sort((a, b) => a.page - b.page)
}

function fieldsPayload(list: DraftField[]): FormFieldInput[] {
  const orderByPage = new Map<number, number>()
  return sortByPage(list).map((f) => {
    const order = (orderByPage.get(f.page) ?? 0) + 1
    orderByPage.set(f.page, order)
    return {
      field_id: f.field_id,
      page: f.page,
      order,
      label_override: f.label_override.trim() || null,
      help_text: f.help_text.trim() || null,
      required: f.required,
    }
  })
}

function rulesPayload(list: DraftRule[]) {
  return list
    .filter((r) => r.target_field_id)
    .map((r) => ({
      target_field_id: r.target_field_id,
      logic: {
        when: r.when.filter((c) => c.field),
        match: r.match,
        action: r.action,
      },
    }))
}

function settingsPayload(draft: SettingsDraft, existing?: FormSettings | null) {
  const limit = draft.submission_limit.trim()
  const settings: FormSettings = {
    ...(existing ?? {}),
    close_at: fromLocalInput(draft.close_at),
    submission_limit: limit === '' ? null : Number(limit),
    confirmation_html: draft.confirmation_html.trim() || null,
  }
  return { name: draft.name.trim(), welcome_html: draft.welcome_html.trim() || null, settings }
}

// `datetime-local` speaks wall-clock strings; the API speaks ISO instants.
function toLocalInput(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

type TabKey = 'fields' | 'rules' | 'settings'

export function FormEditor() {
  const { formId = '' } = useParams<{ formId: string }>()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<TabKey>('fields')

  const formQuery = useQuery({
    queryKey: ['form', formId],
    queryFn: () => getForm(formId),
    enabled: Boolean(formId),
    // Drafts live in component state — a background refetch would silently
    // discard unsaved work. Refresh happens on save, which is when we want it.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
  // The field library is this FORM's event, not events[0]: a form built on one
  // event must never offer (or accept) another event's fields.
  const eventId = formQuery.data?.form.event_id ?? undefined

  const [fields, setFields] = useState<DraftField[]>([])
  const [rules, setRules] = useState<DraftRule[]>([])
  const [settings, setSettings] = useState<SettingsDraft>({
    name: '',
    welcome_html: '',
    close_at: '',
    submission_limit: '',
    confirmation_html: '',
  })
  const [baseline, setBaseline] = useState({ fields: '[]', rules: '[]', settings: '{}' })

  const data = formQuery.data
  useEffect(() => {
    if (!data) return
    const nextFields = sortByPage(data.fields.map(toDraftField))
    const nextRules = data.question_rules.map(toDraftRule)
    const nextSettings = toSettingsDraft(data.form)
    setFields(nextFields)
    setRules(nextRules)
    setSettings(nextSettings)
    setBaseline({
      fields: JSON.stringify(fieldsPayload(nextFields)),
      rules: JSON.stringify(rulesPayload(nextRules)),
      settings: JSON.stringify(settingsPayload(nextSettings, data.form.settings)),
    })
  }, [data])

  const fieldsDirty = JSON.stringify(fieldsPayload(fields)) !== baseline.fields
  const rulesDirty = JSON.stringify(rulesPayload(rules)) !== baseline.rules
  const settingsDirty = JSON.stringify(settingsPayload(settings, data?.form.settings)) !== baseline.settings

  const saveFields = useMutation({
    mutationFn: () => putFormFields(formId, fieldsPayload(fields)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form', formId] })
      queryClient.invalidateQueries({ queryKey: ['forms', eventId] })
      toast({ title: 'Questions saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save questions", description: error.message }),
  })

  const saveRules = useMutation({
    mutationFn: () => putFormRules(formId, rulesPayload(rules)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form', formId] })
      toast({ title: 'Logic saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save logic", description: error.message }),
  })

  const saveSettings = useMutation({
    mutationFn: () => updateForm(formId, settingsPayload(settings, data?.form.settings)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form', formId] })
      queryClient.invalidateQueries({ queryKey: ['forms', eventId] })
      toast({ title: 'Settings saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save settings", description: error.message }),
  })

  /** Rule sentences and condition inputs both need field label + type by id. */
  const lookup: RuleFieldLookup = useMemo(() => {
    const map: RuleFieldLookup = {}
    for (const f of fields) {
      map[f.field_id] = { label: f.label_override.trim() || f.public_name, field_type: f.field_type }
    }
    return map
  }, [fields])

  if (formQuery.isPending) return <EditorSkeleton />

  if (formQuery.error || !data) {
    return (
      <div className="px-4 py-6 md:px-8">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border bg-card shadow-soft">
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load this form"
            description={formQuery.error?.message ?? 'The form may have been deleted.'}
            action={
              <Button size="sm" variant="secondary" onClick={() => formQuery.refetch()}>
                Try again
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  const form = data.form

  return (
    <div className="px-4 py-6 md:px-8">
      <BackLink />

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {form.name || 'Untitled form'}
          </h1>
          <div className="mt-1 flex items-center gap-1">
            <a
              href={publicFormPath(form.slug)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-xs text-primary hover:underline"
            >
              {publicFormPath(form.slug)}
              <ExternalLink className="h-3 w-3" />
            </a>
            <CopyButton value={publicFormUrl(form.slug)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="muted">{form.submission_count ?? 0} submissions</Badge>
          <Button variant="secondary" size="sm" asChild>
            <a href={publicFormPath(form.slug)} target="_blank" rel="noreferrer">
              Preview
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="mt-6">
        <TabsList variant="underline">
          <TabsTrigger value="fields">
            <Layers />
            Questions
            {fieldsDirty && <DirtyDot />}
          </TabsTrigger>
          <TabsTrigger value="rules">
            <GitBranch />
            Logic
            {rulesDirty && <DirtyDot />}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 />
            Settings
            {settingsDirty && <DirtyDot />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="fields">
          <FieldsTab
            eventId={eventId}
            fields={fields}
            setFields={setFields}
            dirty={fieldsDirty}
            saving={saveFields.isPending}
            onSave={() => saveFields.mutate()}
            onReset={() => setFields(sortByPage(data.fields.map(toDraftField)))}
          />
        </TabsContent>

        <TabsContent value="rules">
          <RulesTab
            fields={fields}
            lookup={lookup}
            rules={rules}
            setRules={setRules}
            dirty={rulesDirty}
            saving={saveRules.isPending}
            onSave={() => saveRules.mutate()}
            onReset={() => setRules(data.question_rules.map(toDraftRule))}
          />
        </TabsContent>

        <TabsContent value="settings">
          <SettingsTab
            settings={settings}
            setSettings={setSettings}
            dirty={settingsDirty}
            saving={saveSettings.isPending}
            onSave={() => saveSettings.mutate()}
            onReset={() => setSettings(toSettingsDraft(data.form))}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/forms"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      All forms
    </Link>
  )
}

function DirtyDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="Unsaved changes" />
}

/** Shared save row: state on the left, actions on the right. */
function SaveBar({
  dirty,
  saving,
  onSave,
  onReset,
  savedLabel,
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
  savedLabel: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-soft">
      <p className="text-sm text-muted-foreground">
        {dirty ? (
          <span className="inline-flex items-center gap-2 font-medium text-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Unsaved changes
          </span>
        ) : (
          savedLabel
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={onReset}>
          Discard
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Questions tab                                                              */
/* -------------------------------------------------------------------------- */

function FieldsTab({
  eventId,
  fields,
  setFields,
  dirty,
  saving,
  onSave,
  onReset,
}: {
  eventId?: string
  fields: DraftField[]
  setFields: (next: DraftField[]) => void
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
}) {
  const [addOpen, setAddOpen] = useState(false)

  const update = (key: string, patch: Partial<DraftField>) =>
    setFields(sortByPage(fields.map((f) => (f.key === key ? { ...f, ...patch } : f))))

  const remove = (key: string) => setFields(fields.filter((f) => f.key !== key))

  /** Reorder within a page group; page boundaries are the natural stops. */
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= fields.length) return
    if (fields[target].page !== fields[index].page) return
    const next = [...fields]
    const tmp = next[index]
    next[index] = next[target]
    next[target] = tmp
    setFields(next)
  }

  return (
    <div className="space-y-4">
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onReset={onReset}
        savedLabel={`${fields.length} question${fields.length === 1 ? '' : 's'} · all changes saved`}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Questions appear on the public form in this order, grouped by page.
        </p>
        <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)} disabled={!eventId}>
          <Plus className="h-4 w-4" />
          Add question
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card">
          <EmptyState
            icon={<Layers className="h-6 w-6 text-muted-foreground" />}
            title="No questions yet"
            description="Add questions from your field library, or create a brand new one. Name, email and title are always collected."
            action={
              <Button size="sm" onClick={() => setAddOpen(true)} disabled={!eventId}>
                <Plus className="h-4 w-4" />
                Add question
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map((field, index) => {
            const showPageHeader = index === 0 || fields[index - 1].page !== field.page
            const firstOfPage = showPageHeader
            const lastOfPage = index === fields.length - 1 || fields[index + 1].page !== field.page
            return (
              <div key={field.key} className="space-y-4">
                {showPageHeader && (
                  <div className="flex items-center gap-3 pt-2 first:pt-0">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Page {field.page} · {pageLabel(field.page)}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <FieldRow
                  field={field}
                  canMoveUp={!firstOfPage}
                  canMoveDown={!lastOfPage}
                  onMove={(dir) => move(index, dir)}
                  onChange={(patch) => update(field.key, patch)}
                  onRemove={() => remove(field.key)}
                />
              </div>
            )
          })}
        </div>
      )}

      {eventId && (
        <AddFieldDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          eventId={eventId}
          usedFieldIds={fields.map((f) => f.field_id)}
          onAdd={(libraryField) => {
            const lastPage = fields.length ? fields[fields.length - 1].page : DEFAULT_PAGE
            setFields(
              sortByPage([
                ...fields,
                {
                  key: nextKey('new'),
                  field_id: libraryField.id,
                  page: lastPage,
                  label_override: '',
                  help_text: '',
                  required: Boolean(libraryField.required),
                  public_name: libraryField.public_name,
                  field_type: libraryField.field_type,
                  options: libraryField.options ?? null,
                },
              ])
            )
            setAddOpen(false)
            toast({ title: 'Question added', description: 'Save to publish it on the form.' })
          }}
        />
      )}
    </div>
  )
}

function FieldRow({
  field,
  canMoveUp,
  canMoveDown,
  onMove,
  onChange,
  onRemove,
}: {
  field: DraftField
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (direction: -1 | 1) => void
  onChange: (patch: Partial<DraftField>) => void
  onRemove: () => void
}) {
  const choices = field.options?.choices ?? []

  return (
    <div className="group rounded-lg border border-border bg-card p-4 shadow-soft transition-colors hover:border-primary/40">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-0.5 pt-1">
          <GripVertical className="h-4 w-4 text-muted-foreground/60" />
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6"
            disabled={!canMoveUp}
            aria-label="Move up"
            onClick={() => onMove(-1)}
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6"
            disabled={!canMoveDown}
            aria-label="Move down"
            onClick={() => onMove(1)}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{field.public_name}</span>
            <Badge variant="outline">{fieldTypeLabel(field.field_type)}</Badge>
            {field.required && <Badge variant="warning">Required</Badge>}
          </div>
          {choices.length > 0 && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              Choices: {choices.join(', ')}
            </p>
          )}

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`label-${field.key}`} className="text-xs text-muted-foreground">
                Label on this form
              </Label>
              <Input
                id={`label-${field.key}`}
                value={field.label_override}
                placeholder={field.public_name}
                onChange={(e) => onChange({ label_override: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`help-${field.key}`} className="text-xs text-muted-foreground">
                Help text
              </Label>
              <Input
                id={`help-${field.key}`}
                value={field.help_text}
                placeholder="Shown under the question"
                onChange={(e) => onChange({ help_text: e.target.value })}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={field.required}
                onCheckedChange={(checked) => onChange({ required: checked === true })}
              />
              Required
            </label>

            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Page</span>
              <Select
                value={String(field.page)}
                onValueChange={(value) => onChange({ page: Number(value) })}
              >
                <SelectTrigger className="h-8 w-[190px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGES.map((page) => (
                    <SelectItem key={page} value={String(page)}>
                      {page} · {pageLabel(page)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="h-4 w-4" />
              Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Add-field dialog                                                           */
/* -------------------------------------------------------------------------- */

const SCOPES = [
  { value: 'session', label: 'Session' },
  { value: 'speaker', label: 'Speaker' },
]

function AddFieldDialog({
  open,
  onOpenChange,
  eventId,
  usedFieldIds,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  eventId: string
  usedFieldIds: string[]
  onAdd: (field: LibraryField) => void
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'library' | 'create'>('library')
  const [search, setSearch] = useState('')

  const [scope, setScope] = useState('session')
  const [publicName, setPublicName] = useState('')
  const [fieldType, setFieldType] = useState('text')
  const [choicesText, setChoicesText] = useState('')
  const [required, setRequired] = useState(false)

  const fieldsQuery = useQuery({
    queryKey: ['fields', eventId],
    queryFn: () => listFields(eventId),
    enabled: open,
  })

  useEffect(() => {
    if (!open) {
      setMode('library')
      setSearch('')
      setPublicName('')
      setFieldType('text')
      setChoicesText('')
      setRequired(false)
    }
  }, [open])

  const create = useMutation({
    mutationFn: () => {
      const choices = choicesText
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean)
      return createField(eventId, {
        scope,
        public_name: publicName.trim(),
        field_type: fieldType,
        options: fieldType === 'dropdown' ? { choices } : null,
        required,
      })
    },
    onSuccess: (field) => {
      queryClient.invalidateQueries({ queryKey: ['fields', eventId] })
      onAdd(field)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create field", description: error.message }),
  })

  const all = fieldsQuery.data ?? []
  const needle = search.trim().toLowerCase()
  const results = needle
    ? all.filter(
        (f) =>
          f.public_name.toLowerCase().includes(needle) ||
          String(f.field_type).toLowerCase().includes(needle)
      )
    : all

  const canCreate = publicName.trim().length > 0 && (fieldType !== 'dropdown' || choicesText.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'library' ? 'Add a question' : 'Create a new field'}</DialogTitle>
          <DialogDescription>
            {mode === 'library'
              ? 'Reuse a field from your library so answers stay comparable across forms.'
              : 'New fields join the library and can be reused on any form.'}
          </DialogDescription>
        </DialogHeader>

        {mode === 'library' ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields…"
                className="pl-9"
              />
            </div>

            <div className="max-h-[46vh] space-y-1 overflow-y-auto scrollbar-app">
              {fieldsQuery.isPending ? (
                <div className="space-y-2 py-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : results.length === 0 ? (
                <p className="px-1 py-8 text-center text-sm text-muted-foreground">
                  {all.length === 0
                    ? 'Your field library is empty. Create the first field below.'
                    : `No fields match “${search}”.`}
                </p>
              ) : (
                results.map((field) => {
                  const used = usedFieldIds.indexOf(field.id) !== -1
                  return (
                    <button
                      key={field.id}
                      type="button"
                      disabled={used}
                      onClick={() => onAdd(field)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-3 py-2 text-left transition-colors',
                        used ? 'cursor-not-allowed opacity-55' : 'hover:border-border hover:bg-hover'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {field.public_name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {fieldTypeLabel(field.field_type)}
                          {field.scope ? ` · ${field.scope}` : ''}
                        </span>
                      </span>
                      {used ? (
                        <Badge variant="muted">On form</Badge>
                      ) : (
                        <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  )
                })
              )}
            </div>

            <DialogFooter className="sm:justify-between">
              <Button variant="secondary" size="sm" onClick={() => setMode('create')}>
                <Plus className="h-4 w-4" />
                Create new field
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (canCreate) create.mutate()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="new-field-name" required>
                Question
              </Label>
              <Input
                id="new-field-name"
                autoFocus
                value={publicName}
                placeholder="Have you spoken at this event before?"
                onChange={(e) => setPublicName(e.target.value)}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Answer type</Label>
                <Select value={fieldType} onValueChange={setFieldType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Applies to</Label>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCOPES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {fieldType === 'dropdown' && (
              <div className="space-y-1.5">
                <Label htmlFor="new-field-choices" required>
                  Choices
                </Label>
                <Textarea
                  id="new-field-choices"
                  value={choicesText}
                  onChange={(e) => setChoicesText(e.target.value)}
                  placeholder={'Yes\nNo\nNot sure'}
                  className="min-h-[104px] font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">One choice per line.</p>
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <Checkbox checked={required} onCheckedChange={(c) => setRequired(c === true)} />
              Required by default
            </label>

            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="ghost" size="sm" onClick={() => setMode('library')}>
                <ArrowLeft className="h-4 w-4" />
                Back to library
              </Button>
              <Button type="submit" size="sm" disabled={!canCreate || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create & add'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Logic tab                                                                  */
/* -------------------------------------------------------------------------- */

const RULE_OPS: RuleOp[] = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty']

const ACTIONS: Array<{ value: RuleAction; label: string }> = [
  { value: 'show', label: 'Show' },
  { value: 'hide', label: 'Hide' },
  { value: 'require', label: 'Require' },
]

function RulesTab({
  fields,
  lookup,
  rules,
  setRules,
  dirty,
  saving,
  onSave,
  onReset,
}: {
  fields: DraftField[]
  lookup: RuleFieldLookup
  rules: DraftRule[]
  setRules: (next: DraftRule[]) => void
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
}) {
  const [editing, setEditing] = useState<DraftRule | null>(null)

  const upsert = (rule: DraftRule) => {
    const exists = rules.some((r) => r.key === rule.key)
    setRules(exists ? rules.map((r) => (r.key === rule.key ? rule : r)) : [...rules, rule])
    setEditing(null)
  }

  const newRule = (): DraftRule => ({
    key: nextKey('rule'),
    target_field_id: fields[0]?.field_id ?? '',
    action: 'show',
    match: 'all',
    when: fields[0] ? [{ field: fields[0].field_id, op: 'eq', value: '' }] : [],
  })

  return (
    <div className="space-y-4">
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onReset={onReset}
        savedLabel={`${rules.length} rule${rules.length === 1 ? '' : 's'} · all changes saved`}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Conditional logic runs live on the public form as people type.
        </p>
        <Button size="sm" variant="secondary" disabled={fields.length === 0} onClick={() => setEditing(newRule())}>
          <Plus className="h-4 w-4" />
          Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card">
          <EmptyState
            icon={<GitBranch className="h-6 w-6 text-muted-foreground" />}
            title="No conditional logic yet"
            description={
              fields.length === 0
                ? 'Add questions first — rules reference the questions on this form.'
                : 'Hide the follow-up questions that only some submitters need to answer.'
            }
            action={
              fields.length > 0 ? (
                <Button size="sm" onClick={() => setEditing(newRule())}>
                  <Plus className="h-4 w-4" />
                  Add rule
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.key}
              className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 shadow-soft transition-colors hover:border-primary/40"
            >
              <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">
                {ruleSentenceSegments(
                  { id: rule.id, target_field_id: rule.target_field_id, logic: { when: rule.when, match: rule.match, action: rule.action } },
                  lookup
                ).map((segment, i) => (
                  <span key={i} className={segment.emphasis ? 'font-medium text-foreground' : undefined}>
                    {segment.text}
                  </span>
                ))}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon-sm" aria-label="Edit rule" onClick={() => setEditing(rule)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete rule"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setRules(rules.filter((r) => r.key !== rule.key))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <RuleDialog
          key={editing.key}
          rule={editing}
          fields={fields}
          lookup={lookup}
          onCancel={() => setEditing(null)}
          onSave={upsert}
        />
      )}
    </div>
  )
}

function RuleDialog({
  rule,
  fields,
  lookup,
  onCancel,
  onSave,
}: {
  rule: DraftRule
  fields: DraftField[]
  lookup: RuleFieldLookup
  onCancel: () => void
  onSave: (rule: DraftRule) => void
}) {
  const [draft, setDraft] = useState<DraftRule>(() => ({ ...rule, when: rule.when.map((c) => ({ ...c })) }))

  const setCondition = (index: number, patch: Partial<RuleCondition>) =>
    setDraft({ ...draft, when: draft.when.map((c, i) => (i === index ? { ...c, ...patch } : c)) })

  const preview = ruleSentenceSegments(
    {
      target_field_id: draft.target_field_id,
      logic: { when: draft.when, match: draft.match, action: draft.action },
    },
    lookup
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule.id ? 'Edit rule' : 'New rule'}</DialogTitle>
          <DialogDescription>
            Pick what happens, then the conditions that trigger it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[130px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="rule-action">Action</Label>
              <NativeSelect
                id="rule-action"
                data-testid="rule-action"
                value={draft.action}
                onValueChange={(value) => setDraft({ ...draft, action: value as RuleAction })}
                options={ACTIONS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-target">Question</Label>
              <NativeSelect
                id="rule-target"
                data-testid="rule-target"
                value={draft.target_field_id}
                onValueChange={(value) => setDraft({ ...draft, target_field_id: value })}
                placeholder="Choose a question"
                options={fields.map((f) => ({
                  value: f.field_id,
                  label: f.label_override.trim() || f.public_name,
                }))}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center gap-2">
              <Label
                htmlFor="rule-match"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                When
              </Label>
              <div className="w-[150px]">
                <NativeSelect
                  id="rule-match"
                  data-testid="rule-match"
                  className="h-7"
                  value={draft.match}
                  onValueChange={(value) => setDraft({ ...draft, match: value as RuleMatch })}
                  options={[
                    { value: 'all', label: 'all conditions' },
                    { value: 'any', label: 'any condition' },
                  ]}
                />
              </div>
              <span className="text-xs text-muted-foreground">match</span>
            </div>

            <div className="mt-3 space-y-2">
              {draft.when.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  No conditions — add at least one so the rule can fire.
                </p>
              )}
              {draft.when.map((condition, index) => (
                <ConditionRow
                  key={index}
                  index={index}
                  condition={condition}
                  fields={fields}
                  onChange={(patch) => setCondition(index, patch)}
                  onRemove={() => setDraft({ ...draft, when: draft.when.filter((_, i) => i !== index) })}
                />
              ))}
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={fields.length === 0}
              onClick={() =>
                setDraft({
                  ...draft,
                  when: [...draft.when, { field: fields[0]?.field_id ?? '', op: 'eq', value: '' }],
                })
              }
            >
              <Plus className="h-4 w-4" />
              Add condition
            </Button>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-primary-subtle px-3 py-2.5">
            <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              {preview.map((segment, i) => (
                <span key={i} className={segment.emphasis ? 'font-medium text-foreground' : undefined}>
                  {segment.text}
                </span>
              ))}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!draft.target_field_id || draft.when.length === 0}
            onClick={() => onSave(draft)}
          >
            {rule.id ? 'Update rule' : 'Add rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConditionRow({
  index,
  condition,
  fields,
  onChange,
  onRemove,
}: {
  /** Row position — only used to give each control a stable, addressable testid. */
  index: number
  condition: RuleCondition
  fields: DraftField[]
  onChange: (patch: Partial<RuleCondition>) => void
  onRemove: () => void
}) {
  const compared = fields.find((f) => f.field_id === condition.field)
  const type = compared?.field_type
  const choices = compared?.options?.choices ?? []

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="w-[200px]">
        <NativeSelect
          data-testid={`rule-condition-field-${index}`}
          aria-label="Condition question"
          className="h-8"
          value={condition.field}
          onValueChange={(value) => onChange({ field: value, value: '' })}
          placeholder="Question"
          options={fields.map((f) => ({
            value: f.field_id,
            label: f.label_override.trim() || f.public_name,
          }))}
        />
      </div>

      <div className="w-[160px]">
        <NativeSelect
          data-testid={`rule-condition-op-${index}`}
          aria-label="Condition operator"
          className="h-8"
          value={condition.op}
          onValueChange={(value) => onChange({ op: value as RuleOp })}
          options={RULE_OPS.map((op) => ({ value: op, label: opPhrase(op) }))}
        />
      </div>

      {!isValuelessOp(condition.op) && (
        <ValueInput
          index={index}
          type={type}
          choices={choices}
          value={condition.value}
          onChange={(value) => onChange({ value })}
        />
      )}

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Remove condition"
        className="text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

/** The compared field's type decides the control — never a raw JSON box. */
function ValueInput({
  index,
  type,
  choices,
  value,
  onChange,
}: {
  index: number
  type?: string
  choices: string[]
  value: RuleCondition['value']
  onChange: (value: RuleCondition['value']) => void
}) {
  const testId = `rule-condition-value-${index}`

  if (type === 'checkbox') {
    return (
      <div className="w-[140px]">
        <NativeSelect
          data-testid={testId}
          aria-label="Condition value"
          className="h-8"
          value={value === true || value === 'true' ? 'true' : 'false'}
          onValueChange={(v) => onChange(v === 'true')}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      </div>
    )
  }

  if (type === 'dropdown' && choices.length > 0) {
    return (
      <div className="w-[200px]">
        <NativeSelect
          data-testid={testId}
          aria-label="Condition value"
          className="h-8"
          value={value == null ? '' : String(value)}
          onValueChange={(v) => onChange(v)}
          placeholder="Choose…"
          options={choices.map((choice) => ({ value: choice, label: choice }))}
        />
      </div>
    )
  }

  if (type === 'number') {
    return (
      <Input
        data-testid={testId}
        aria-label="Condition value"
        type="number"
        className="h-8 w-[140px]"
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    )
  }

  return (
    <Input
      data-testid={testId}
      aria-label="Condition value"
      className="h-8 w-[200px]"
      placeholder="Value"
      value={value == null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Settings tab                                                               */
/* -------------------------------------------------------------------------- */

function SettingsTab({
  settings,
  setSettings,
  dirty,
  saving,
  onSave,
  onReset,
}: {
  settings: SettingsDraft
  setSettings: (next: SettingsDraft) => void
  dirty: boolean
  saving: boolean
  onSave: () => void
  onReset: () => void
}) {
  const set = (patch: Partial<SettingsDraft>) => setSettings({ ...settings, ...patch })

  return (
    <div className="space-y-4">
      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onReset={onReset}
        savedLabel="All changes saved"
      />

      <div className="max-w-2xl space-y-5 rounded-lg border border-border bg-card p-5 shadow-soft">
        <div className="space-y-1.5">
          <Label htmlFor="settings-name" required>
            Form name
          </Label>
          <Input
            id="settings-name"
            value={settings.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-welcome">Welcome message</Label>
          <Textarea
            id="settings-welcome"
            value={settings.welcome_html}
            placeholder="<p>We're looking for talks on…</p>"
            onChange={(e) => set({ welcome_html: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Shown above the first question. Basic HTML is allowed.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="settings-close">Close submissions at</Label>
            <Input
              id="settings-close"
              type="datetime-local"
              value={settings.close_at}
              onChange={(e) => set({ close_at: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Leave empty to keep the form open.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-limit">Submission limit</Label>
            <Input
              id="settings-limit"
              type="number"
              min={1}
              value={settings.submission_limit}
              placeholder="Unlimited"
              onChange={(e) => set({ submission_limit: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Total submissions accepted by this form.</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-confirmation">Confirmation message</Label>
          <Textarea
            id="settings-confirmation"
            value={settings.confirmation_html}
            placeholder="<p>Thanks! We'll be in touch by March 1.</p>"
            onChange={(e) => set({ confirmation_html: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">Shown after a successful submission.</p>
        </div>
      </div>
    </div>
  )
}

function EditorSkeleton() {
  return (
    <div className="px-4 py-6 md:px-8">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-8 w-64" />
      <Skeleton className="mt-2 h-4 w-40" />
      <Skeleton className="mt-6 h-10 w-full max-w-md" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  )
}
