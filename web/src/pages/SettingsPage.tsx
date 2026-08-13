import { useEffect, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  PlugZap,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

import { ApiError, apiGet, unwrapList, type EventSummary } from '@/lib/api'
import { agentKeys, getAgentCapabilities } from '@/agent/lib/agentApi'
import {
  createApiToken,
  createTaxonomy,
  deleteEventBrandAsset,
  deleteApiToken,
  deleteTaxonomy,
  listApiTokens,
  listTaxonomy,
  updateEvent,
  updateTaxonomy,
  uploadEventBrandAsset,
  type ApiTokenRow,
  type TaxonomyInput,
  type TaxonomyKind,
  type TaxonomyRow,
} from '@/lib/adminApi'
import {
  DEFAULT_BRANDING,
  FONT_LABELS,
  FONT_TOKENS,
  brandingStyle,
  contrastRatio,
  sanitizeBranding,
  type BrandingConfig,
  type FontToken,
} from '@/lib/branding'
import { useBrandingFonts } from '@/lib/brandFonts'
import {
  embedPageQuery,
  embedIframeSnippet,
  embedScriptSnippet,
  publicCalendarFeedUrl,
  publicProgramFeedUrl,
  publicProgramUrl,
  sanitizeAccent,
  type EmbedOptions,
  type EmbedWidget,
} from '@/lib/programApi'
import {
  fromDateInput,
  localTimezone,
  timezoneOptions,
  toDateInput,
} from '@/lib/eventDateTime'
import {
  connectMCPConnector,
  createMCPConnector,
  deleteMCPConnector,
  getAirtableConfig,
  getSlackStatus,
  listMCPConnectors,
  saveAirtableConfig,
  SLACK_MANIFEST,
  syncAirtable,
  type AirtableConfig,
  type AirtableSyncResult,
  type MCPAuthKind,
  type MCPConnector,
} from '@/lib/integrationsApi'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/ui/copy-button'
import { Button } from '@/ui/button'
import { Badge } from '@/ui/badge'
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
import { toast } from '@/ui/use-toast'

export { fromDateInput, localTimezone, timezoneOptions, toDateInput } from '@/lib/eventDateTime'

interface EventDraft {
  name: string
  slug: string
  timezone: string
  starts_at: string
  ends_at: string
  location: string
}

function toEventDraft(event: EventSummary): EventDraft {
  const timezone = event.timezone || localTimezone()
  return {
    name: event.name ?? '',
    slug: event.slug ?? '',
    timezone,
    starts_at: toDateInput(event.starts_at, timezone),
    ends_at: toDateInput(event.ends_at, timezone),
    location: event.location ?? '',
  }
}

/** The alphabet a public URL may use — mirrors SLUG_PATTERN in admin_routes.py. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** null = fine. A string = the reason the Save button should stay down. */
export function slugError(value: string): string | null {
  const slug = value.trim()
  if (!slug) return 'A public URL slug is required.'
  if (!SLUG_RE.test(slug)) {
    return 'Use lowercase letters, numbers and hyphens only — no spaces, and not at either end.'
  }
  return null
}

const SETTINGS_SECTIONS = [
  { slug: 'event', label: 'Event' },
  { slug: 'branding', label: 'Branding' },
  { slug: 'vocabulary', label: 'Vocabulary' },
  { slug: 'embed', label: 'Embed & share' },
  { slug: 'mcp', label: 'MCP connectors' },
  { slug: 'integrations', label: 'Integrations' },
  { slug: 'api-tokens', label: 'API tokens' },
] as const

type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['slug']

function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.slug === value)
}

/** Event is the landing section, so it owns the bare /settings URL. */
function sectionPath(slug: SettingsSection): string {
  return slug === 'event' ? '/settings' : `/settings/${slug}`
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const { section } = useParams<{ section?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const capabilitiesQuery = useQuery({
    queryKey: agentKeys.capabilities,
    queryFn: getAgentCapabilities,
    staleTime: Infinity,
    retry: false,
  })
  const event = eventsQuery.data?.[0]

  useEffect(() => {
    const result = searchParams.get('mcp')
    if (!result?.startsWith('connected:')) return
    const key = result.slice('connected:'.length)
    toast({ title: 'MCP connector connected', description: key ? `${key} is ready to use.` : undefined })
    void queryClient.invalidateQueries({ queryKey: ['integrations', 'mcp'] })
    void queryClient.invalidateQueries({ queryKey: agentKeys.capabilities })
    const next = new URLSearchParams(searchParams)
    next.delete('mcp')
    setSearchParams(next, { replace: true })
  }, [queryClient, searchParams, setSearchParams])

  // Settings used to be one long page with #settings-* scroll anchors. Old
  // bookmarks and shared links still say #settings-embed — land them on the
  // subpage that replaced the anchor.
  useEffect(() => {
    const slug = location.hash.replace(/^#settings-/, '')
    if (location.hash && isSettingsSection(slug)) {
      navigate(sectionPath(slug), { replace: true })
    }
  }, [location.hash, navigate])

  const assistantEnabled = capabilitiesQuery.data?.assistant === true
  const active: SettingsSection = section && isSettingsSection(section) ? section : 'event'
  const tabs = SETTINGS_SECTIONS.filter((tab) => tab.slug !== 'mcp' || assistantEnabled)

  if (!eventsQuery.isPending && !eventsQuery.error && !event) {
    return <Navigate to="/onboarding" replace />
  }
  if (section && !isSettingsSection(section)) {
    return <Navigate to="/settings" replace />
  }
  // The MCP section only exists when the assistant is available.
  if (active === 'mcp' && !capabilitiesQuery.isPending && !assistantEnabled) {
    return <Navigate to="/settings" replace />
  }

  return (
    <div className="px-4 py-6 md:px-8">
      <header>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">
          Event details and the vocabulary your program is built from.
        </p>
      </header>

      <nav
        aria-label="Settings sections"
        className="sticky top-0 z-30 mt-5 flex max-w-full items-center overflow-x-auto border-b border-border bg-card/95 backdrop-blur-sm scrollbar-hide"
      >
        {tabs.map((tab) => {
          const isActive = active === tab.slug
          return (
            <Link
              key={tab.slug}
              to={sectionPath(tab.slug)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                '-mb-px shrink-0 border-b px-3 py-2 text-[13px] transition-colors',
                isActive
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      {eventsQuery.error ? (
        <div className="mt-6 rounded-lg border border-border bg-card">
          <EmptyState
            icon={<AlertCircle className="h-6 w-6 text-destructive" />}
            title="Couldn't load your event"
            description={eventsQuery.error.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => eventsQuery.refetch()}>
                Try again
              </Button>
            }
          />
        </div>
      ) : !event ? (
        <div className="mt-6 space-y-3">
          <Skeleton className="h-64 w-full max-w-2xl" />
          <Skeleton className="h-48 w-full max-w-2xl" />
        </div>
      ) : (
        <div className={cn('mt-6', active === 'branding' ? 'max-w-4xl' : 'max-w-3xl')}>
          {active === 'event' && <EventCard event={event} />}
          {active === 'branding' && <BrandingSection event={event} />}
          {active === 'vocabulary' && (
            <div className="space-y-6">
              <TaxonomySection
                eventId={event.id}
                kind="tracks"
                title="Tracks"
                description="Themes submissions are routed into. Colors carry through to the agenda."
                extra="color"
              />
              <TaxonomySection
                eventId={event.id}
                kind="rooms"
                title="Rooms"
                description="Where sessions happen. Capacity powers over-capacity conflict checks."
                extra="capacity"
              />
              <TaxonomySection
                eventId={event.id}
                kind="formats"
                title="Formats"
                description="Talk, workshop, panel — each with a default length."
                extra="duration"
              />
              <TaxonomySection
                eventId={event.id}
                kind="levels"
                title="Levels"
                description="Audience experience level, shown on the public agenda."
              />
              <TaxonomySection
                eventId={event.id}
                kind="tags"
                title="Tags"
                description="Free-form labels for filtering and reporting."
              />
            </div>
          )}
          {active === 'embed' && <EmbedSection event={event} />}
          {active === 'mcp' && assistantEnabled && <MCPConnectorsCard />}
          {active === 'integrations' && (
            <div className="space-y-6">
              <AirtableSyncCard />
              <SlackBotCard />
            </div>
          )}
          {active === 'api-tokens' && <ApiTokensSection />}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Integrations                                                               */
/* -------------------------------------------------------------------------- */

interface MCPDraft {
  name: string
  url: string
  auth_kind: MCPAuthKind
  bearer_token: string
}

const EMPTY_MCP_DRAFT: MCPDraft = {
  name: '',
  url: '',
  auth_kind: 'oauth',
  bearer_token: '',
}

export function mcpDraftError(draft: MCPDraft): string | null {
  const name = draft.name.trim()
  if (!name || name.length > 50) return 'Name must be between 1 and 50 characters.'
  let parsed: URL
  try {
    parsed = new URL(draft.url.trim())
  } catch {
    return 'Enter a valid MCP server URL.'
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return 'Use HTTPS. HTTP is allowed only for localhost.'
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return 'The server URL cannot include credentials, a query, or a fragment.'
  }
  if (draft.auth_kind === 'bearer' && !draft.bearer_token.trim()) {
    return 'Enter the bearer token for this server.'
  }
  return null
}

function connectorStatus(connector: MCPConnector) {
  if (connector.connected) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-strong">
        Connected <Check className="h-3.5 w-3.5" />
      </span>
    )
  }
  if (connector.last_error) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-destructive-strong"
        title={connector.last_error}
      >
        <AlertCircle className="h-3.5 w-3.5" /> Error
      </span>
    )
  }
  return <span className="text-xs text-muted-foreground">Not connected</span>
}

function MCPConnectorsCard() {
  const queryClient = useQueryClient()
  const queryKey = ['integrations', 'mcp'] as const
  const query = useQuery({ queryKey, queryFn: listMCPConnectors })
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<MCPDraft>(EMPTY_MCP_DRAFT)
  const [inlineError, setInlineError] = useState<string | null>(null)

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: agentKeys.capabilities }),
    ])
  }
  const connect = useMutation({
    mutationFn: connectMCPConnector,
    onSuccess: ({ authorize_url }) => {
      window.open(authorize_url, '_blank', 'noopener,noreferrer')
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't connect MCP server", description: error.message }),
  })
  const remove = useMutation({
    mutationFn: deleteMCPConnector,
    onSuccess: async () => {
      await refresh()
      toast({ title: 'MCP connector disconnected' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't disconnect MCP server", description: error.message }),
  })
  const create = useMutation({
    mutationFn: createMCPConnector,
    onSuccess: async (result) => {
      await refresh()
      setDialogOpen(false)
      setDraft(EMPTY_MCP_DRAFT)
      setInlineError(null)
      if ('authorize_url' in result) {
        window.open(result.authorize_url, '_blank', 'noopener,noreferrer')
      } else {
        toast({ title: `${result.name} connected` })
      }
    },
    onError: (error: Error) => setInlineError(error.message),
  })

  return (
    <>
      <section
        id="settings-mcp"
        className="overflow-hidden rounded-lg border border-border bg-card"
        data-testid="mcp-connectors-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-medium text-foreground">MCP connectors</h2>
              <Badge variant="muted">
                {(query.data ?? []).filter((connector) => connector.connected).length} connected
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Give the assistant tools from business systems and internal MCP servers.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" /> Add custom server
          </Button>
        </div>

        <div className="divide-y divide-border">
          {query.isPending ? (
            <div className="space-y-2 px-5 py-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-4/5" />
            </div>
          ) : query.error ? (
            <div className="flex items-center justify-between gap-3 px-5 py-4">
              <p className="text-sm text-destructive-strong">{query.error.message}</p>
              <Button size="sm" variant="secondary" onClick={() => query.refetch()}>Try again</Button>
            </div>
          ) : query.data?.length ? (
            query.data.map((connector) => (
              <div key={connector.key} className="flex flex-wrap items-center gap-3 px-5 py-4" data-testid={`mcp-connector-${connector.key}`}>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                  <PlugZap className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">{connector.name}</p>
                    {connector.preset && <Badge variant="outline">Preset</Badge>}
                    <Badge variant="muted">{connector.auth_kind === 'bearer' ? 'Bearer token' : connector.auth_kind === 'oauth' ? 'OAuth' : 'No auth'}</Badge>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={connector.url}>{connector.url}</p>
                  {connector.description && <p className="mt-1 text-xs text-muted-foreground">{connector.description}</p>}
                </div>
                <div className="flex min-w-32 flex-col items-end gap-2">
                  {connectorStatus(connector)}
                  <div className="flex items-center gap-1.5">
                    {!connector.connected && connector.auth_kind === 'oauth' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={connect.isPending}
                        onClick={() => connect.mutate(connector.key)}
                      >
                        {connect.isPending && connect.variables === connector.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        Connect
                      </Button>
                    )}
                    {(connector.connected || connector.status === 'error') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(connector.key)}
                      >
                        Disconnect
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No connector presets are configured. Add your organization's MCP server to begin.
            </p>
          )}
        </div>
      </section>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) {
            setDraft(EMPTY_MCP_DRAFT)
            setInlineError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add custom MCP server</DialogTitle>
            <DialogDescription>
              SpeakerWeave validates the connection before making its tools available to the assistant.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              const error = mcpDraftError(draft)
              setInlineError(error)
              if (error) return
              create.mutate({
                name: draft.name.trim(),
                url: draft.url.trim(),
                auth_kind: draft.auth_kind,
                ...(draft.auth_kind === 'bearer' ? { bearer_token: draft.bearer_token } : {}),
              })
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={draft.name}
                maxLength={50}
                placeholder="Sales CRM"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                value={draft.url}
                placeholder="https://crm.example.com/mcp"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-auth-kind">Authentication</Label>
              <NativeSelect
                id="mcp-auth-kind"
                value={draft.auth_kind}
                onValueChange={(auth_kind) => setDraft({ ...draft, auth_kind: auth_kind as MCPAuthKind })}
                options={[
                  { value: 'oauth', label: 'OAuth' },
                  { value: 'bearer', label: 'Bearer token' },
                  { value: 'none', label: 'None' },
                ]}
              />
            </div>
            {draft.auth_kind === 'bearer' && (
              <div className="space-y-1.5">
                <Label htmlFor="mcp-bearer-token">Bearer token</Label>
                <Input
                  id="mcp-bearer-token"
                  type="password"
                  autoComplete="new-password"
                  value={draft.bearer_token}
                  onChange={(event) => setDraft({ ...draft, bearer_token: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">Write-only. The token is never returned to the browser.</p>
              </div>
            )}
            {inlineError && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-strong">
                {inlineError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={create.isPending} onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {create.isPending ? 'Validating…' : 'Add server'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface AirtableDraft {
  token: string
  base_id: string
  enabled: boolean
}

function airtableDraft(config?: AirtableConfig): AirtableDraft {
  return {
    token: '',
    base_id: config?.base_id ?? '',
    enabled: Boolean(config?.enabled),
  }
}

function readableSyncTime(value: string | null | undefined): string {
  if (!value) return 'Never synced'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function AirtableSyncCard() {
  const queryClient = useQueryClient()
  const queryKey = ['integrations', 'airtable'] as const
  const query = useQuery({ queryKey, queryFn: getAirtableConfig })
  const [draft, setDraft] = useState<AirtableDraft>(() => airtableDraft())
  const [baseline, setBaseline] = useState(() => JSON.stringify(airtableDraft()))
  const [result, setResult] = useState<AirtableSyncResult | null>(null)

  useEffect(() => {
    if (!query.data) return
    const next = airtableDraft(query.data)
    setDraft(next)
    setBaseline(JSON.stringify(next))
  }, [query.data])

  const dirty = JSON.stringify(draft) !== baseline
  const save = useMutation({
    mutationFn: () =>
      saveAirtableConfig({
        ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
        base_id: draft.base_id.trim(),
        enabled: draft.enabled,
      }),
    onSuccess: (config) => {
      queryClient.setQueryData(queryKey, config)
      const next = airtableDraft(config)
      setDraft(next)
      setBaseline(JSON.stringify(next))
      toast({ title: 'Airtable settings saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save Airtable settings", description: error.message }),
  })
  const sync = useMutation({
    mutationFn: syncAirtable,
    onSuccess: (next) => {
      setResult(next)
      queryClient.setQueryData<AirtableConfig | undefined>(queryKey, (current) =>
        current ? { ...current, last_synced_at: next.last_synced_at } : current
      )
    },
  })

  const configured = Boolean(query.data?.configured)
  const canSync = configured && Boolean(query.data?.enabled) && !dirty && !save.isPending
  const syncError = sync.error instanceof Error ? sync.error.message : null

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" data-testid="airtable-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-medium text-foreground">Airtable sync</h2>
            {query.isPending ? (
              <Badge variant="muted">Checking</Badge>
            ) : configured ? (
              <Badge variant="success">Configured</Badge>
            ) : (
              <Badge variant="muted">Not configured</Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Mirror speakers and submissions into an Airtable base owned by your organization.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!dirty || save.isPending || query.isPending}
          onClick={() => save.mutate()}
          data-testid="save-airtable"
        >
          {save.isPending ? 'Saving…' : 'Save connection'}
        </Button>
      </div>

      <div className="space-y-5 px-5 py-5">
        {query.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-strong">
            {query.error.message}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="airtable-token">Personal access token</Label>
                <Input
                  id="airtable-token"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={draft.token}
                  placeholder={query.data?.token_hint ? `Configured (${query.data.token_hint})` : 'pat…'}
                  onChange={(event) => setDraft({ ...draft, token: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">Write-only. Leave blank to keep the current token.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="airtable-base">Base ID</Label>
                <Input
                  id="airtable-base"
                  value={draft.base_id}
                  placeholder="app…"
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, base_id: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">Found in the base URL or Airtable API documentation.</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-border bg-background/50 px-4 py-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-label="Enable Airtable sync"
                  aria-checked={draft.enabled}
                  onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                  className={cn(
                    'relative h-6 w-11 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 active:scale-[0.98]',
                    draft.enabled ? 'border-primary bg-primary' : 'border-input bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-4.5 w-4.5 rounded-full bg-card shadow-sm transition-transform',
                      draft.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    )}
                  />
                </button>
                <div>
                  <p className="text-sm font-medium text-foreground">Sync enabled</p>
                  <p className="text-xs text-muted-foreground">No automatic writes run while this is off.</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground" data-testid="airtable-last-synced">
                  {readableSyncTime(query.data?.last_synced_at)}
                </span>
                <Button
                  disabled={!canSync || sync.isPending}
                  onClick={() => sync.mutate()}
                  data-testid="sync-airtable"
                >
                  {sync.isPending ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
            </div>

            {result && (
              <div className="grid gap-3 sm:grid-cols-2" data-testid="airtable-sync-result">
                {(['Speakers', 'Submissions'] as const).map((table) => (
                  <div key={table} className="border-l-2 border-success px-3 py-1">
                    <p className="text-sm font-medium text-foreground">{table}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {result.tables[table].created} created · {result.tables[table].updated} updated
                    </p>
                  </div>
                ))}
              </div>
            )}

            {syncError && (
              <pre
                data-testid="airtable-sync-error"
                className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 font-sans text-sm leading-relaxed text-destructive-strong"
              >
                {syncError}
              </pre>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function SlackBotCard() {
  const status = useQuery({
    queryKey: ['integrations', 'slack', 'status'],
    queryFn: getSlackStatus,
  })
  const configured = Boolean(status.data?.configured)
  const providerName =
    status.data?.provider === 'openai'
      ? 'OpenAI'
      : status.data?.provider === 'anthropic'
        ? 'Anthropic'
        : 'Anthropic'
  const providerKey =
    status.data?.provider === 'openai'
      ? 'OPENAI_API_KEY'
      : status.data?.provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY'
        : 'OPENAI_API_KEY or ANTHROPIC_API_KEY'
  const modelKeyConfigured =
    status.data?.model_key_configured ?? status.data?.anthropic_configured

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" data-testid="slack-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-medium text-foreground">Slack bot</h2>
            {status.isPending ? (
              <Badge variant="muted">Checking environment</Badge>
            ) : configured ? (
              <Badge variant="success">Environment configured</Badge>
            ) : (
              <Badge variant="warning">Environment incomplete</Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The Slack bot is the same agent as in-app Ask, with the same tools and connected MCP
            servers. Slack is simply another place to talk to it.
          </p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div className="border-b border-border pb-5 text-sm leading-relaxed text-muted-foreground">
          Sensitive actions arrive as <span className="font-medium text-foreground">Approve</span>{' '}
          and <span className="font-medium text-foreground">Deny</span> buttons in Slack. Messages
          stay in the same persisted threads, so Slack conversations also appear in in-app Ask
          history.
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">Setup</p>
          <ol className="space-y-2 pl-5 text-sm leading-relaxed text-foreground marker:font-mono marker:text-muted-foreground">
            <li className="list-decimal">
              Create a Slack app from the manifest below — it preconfigures scopes, events,
              Interactivity, the agent surface, and the messages tab.
            </li>
            <li className="list-decimal">
              In Event Subscriptions, confirm the request URL{' '}
              <code className="font-mono text-xs">https://speakerweave.com/api/slack/events</code>{' '}
              shows as Verified.
            </li>
            <li className="list-decimal">
              Install the app to your workspace, invite it to any shared channels, and copy its bot
              token.
            </li>
            <li className="list-decimal">
              Set <code className="font-mono text-xs">SLACK_BOT_TOKEN</code>,{' '}
              <code className="font-mono text-xs">SLACK_SIGNING_SECRET</code>,{' '}
              <code className="font-mono text-xs">SLACK_DEFAULT_ORG</code>, and{' '}
              <code className="font-mono text-xs">{providerKey}</code> in the API environment.
            </li>
          </ol>
        </div>

        <div className="flex flex-wrap gap-2" aria-label="Slack environment status">
          <Badge variant={status.data?.signing_secret_configured ? 'success' : 'muted'}>
            Signing secret {status.data?.signing_secret_configured ? 'set' : 'missing'}
          </Badge>
          <Badge variant={status.data?.bot_token_configured ? 'success' : 'muted'}>
            Bot token {status.data?.bot_token_configured ? 'set' : 'missing'}
          </Badge>
          <Badge variant={modelKeyConfigured ? 'success' : 'muted'}>
            {providerName} key {modelKeyConfigured ? 'set' : 'missing'}
          </Badge>
          {typeof status.data?.agent_backed === 'boolean' && (
            <Badge variant={status.data.agent_backed ? 'success' : 'warning'}>
              {status.data.agent_backed ? 'Agent bridge active' : 'Agent bridge unavailable'}
            </Badge>
          )}
        </div>

        {status.error && (
          <p className="text-sm text-destructive-strong">{status.error.message}</p>
        )}

        <SnippetBlock
          title="Slack app manifest"
          hint="Paste this JSON into Slack's Create an app from a manifest flow."
          snippet={SLACK_MANIFEST}
          testId="slack-manifest"
        />
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Embed & share                                                              */
/* -------------------------------------------------------------------------- */

/** One shareable public URL: the link itself, a copy button, and an open-in-tab. */
function PublicLinkRow({
  label,
  url,
  testId,
}: {
  label: string
  url: string
  testId: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
      <code
        data-testid={testId}
        className="min-w-0 flex-1 truncate rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-xs text-foreground"
      >
        {url}
      </code>
      <CopyButton value={url} label={`Copy ${label.toLowerCase()} link`} />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label.toLowerCase()}`}
        title={`Open ${label.toLowerCase()}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  )
}

/** A copyable code block: the snippet plus a Copy → "Copied" button. */
function SnippetBlock({
  title,
  hint,
  snippet,
  testId,
}: {
  title: string
  hint: string
  snippet: string
  testId: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      // jsdom and plain-http origins have no clipboard API — fall through to
      // the toast so the organizer can still select the snippet by hand.
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast({
        variant: 'destructive',
        title: "Couldn't copy",
        description: 'Select the snippet and copy it manually.',
      })
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="min-w-[92px] shrink-0"
          data-testid={`copy-${testId}`}
          onClick={copy}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="overflow-x-auto rounded-md border border-border bg-background/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground"
      >
        {snippet}
      </pre>
    </div>
  )
}

/**
 * The organizer's window onto the public, embeddable programme (EMB-15): the
 * two shareable page links, plus paste-ready snippets for putting either widget
 * on the event's own site. The /e/ pages are served with `frame-ancestors *`
 * precisely so these embeds work cross-origin.
 */
function EmbedSection({ event }: { event: EventSummary }) {
  const [widget, setWidget] = useState<EmbedWidget>('schedule')
  const [track, setTrack] = useState('')
  const [accent, setAccent] = useState('')
  const [compact, setCompact] = useState(false)
  const tracksQuery = useQuery({
    queryKey: ['taxonomy', 'tracks', event.id],
    queryFn: () => listTaxonomy(event.id, 'tracks'),
  })

  if (!event.slug) return null

  const accentError = accent && !sanitizeAccent(accent) ? 'Enter exactly 6 hex digits.' : null
  const options: EmbedOptions = {
    track: track || undefined,
    accent: sanitizeAccent(accent) ?? undefined,
    compact,
  }
  const scriptSnippet = embedScriptSnippet(event.slug, widget, options)
  const iframeSnippet = embedIframeSnippet(event.slug, widget, options)

  return (
    <section id="settings-embed" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">Embed &amp; share</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Your live schedule and speaker pages — share the links, or drop either one
            straight into your event website.
          </p>
        </div>
      </div>

      <div className="space-y-5 px-5 py-5">
        <div className="space-y-2">
          <PublicLinkRow
            label="Schedule"
            url={publicProgramUrl(event.slug, 'schedule')}
            testId="public-url-schedule"
          />
          <PublicLinkRow
            label="Speakers"
            url={publicProgramUrl(event.slug, 'speakers')}
            testId="public-url-speakers"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="embed-widget">Widget to embed</Label>
          <div className="sm:w-56">
            <NativeSelect
              id="embed-widget"
              aria-label="Widget to embed"
              className="h-9"
              value={widget}
              onValueChange={(value) => setWidget(value as EmbedWidget)}
              options={[
                { value: 'schedule', label: 'Schedule' },
                { value: 'speakers', label: 'Speakers' },
              ]}
            />
          </div>
        </div>

        <div className="grid gap-4 rounded-lg border border-border bg-background/50 p-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="embed-track">Track filter</Label>
            <NativeSelect
              id="embed-track"
              aria-label="Track filter"
              className="h-9"
              value={track}
              onValueChange={setTrack}
              options={[
                { value: '', label: 'All tracks' },
                ...(tracksQuery.data ?? []).map((item) => ({
                  value: item.name,
                  label: `${item.name} track`,
                })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="embed-accent">Accent color</Label>
            <Input
              id="embed-accent"
              aria-label="Accent color"
              className="h-9 font-mono"
              value={accent}
              maxLength={6}
              placeholder="A85E3E"
              aria-invalid={accentError ? true : undefined}
              onChange={(event) => setAccent(event.target.value)}
            />
            {accentError && <p className="text-xs text-destructive">{accentError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="embed-compact">Layout</Label>
            <div className="flex h-9 items-center gap-2">
              <Checkbox
                id="embed-compact"
                checked={compact}
                onCheckedChange={(checked) => setCompact(checked === true)}
              />
              <Label htmlFor="embed-compact" className="font-normal">
                Compact
              </Label>
            </div>
          </div>
        </div>

        <SnippetBlock
          title="Script embed (recommended)"
          hint="Auto-resizes to fit the programme — no scrollbars, no fixed height to maintain."
          snippet={scriptSnippet}
          testId="embed-snippet-script"
        />
        <SnippetBlock
          title="Plain iframe"
          hint="No JavaScript needed. Fixed height — change 600px to suit your page."
          snippet={iframeSnippet}
          testId="embed-snippet-iframe"
        />

        <EmbedPreview slug={event.slug} widget={widget} options={options} />

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">JSON feed</p>
          <p className="text-xs text-muted-foreground">
            The same data behind the widgets, as public read-only JSON — for a custom
            rendering on your own site.
          </p>
          <PublicLinkRow
            label="JSON"
            url={publicProgramFeedUrl(event.slug, widget)}
            testId="embed-json-feed"
          />
        </div>

        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Calendar feed (iCal)</p>
          <p className="text-xs text-muted-foreground">
            Subscribe to the complete published schedule from any calendar app.
          </p>
          <PublicLinkRow
            label="iCal"
            url={publicCalendarFeedUrl(event.slug)}
            testId="embed-ical-feed"
          />
        </div>
      </div>
    </section>
  )
}

/**
 * A live rendering of the widget, in a real cross-origin-shaped iframe, right
 * under the snippet that produces it. The point is proof rather than
 * decoration: the organizer sees the embed working before pasting it anywhere,
 * and a broken widget is visible here instead of on their marketing site.
 */
function EmbedPreview({
  slug,
  widget,
  options,
}: {
  slug: string
  widget: EmbedWidget
  options: EmbedOptions
}) {
  const src = `${publicProgramUrl(slug, widget)}?${embedPageQuery(options)}`
  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Live preview</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Exactly what the snippet above renders on your site — live event data, fully
          interactive.
        </p>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background/60">
        <iframe
          key={src}
          src={src}
          title={`Preview of the ${widget} widget`}
          data-testid="embed-preview"
          loading="lazy"
          className="block h-[420px] w-full border-0"
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* API tokens                                                                 */
/* -------------------------------------------------------------------------- */

function formatUsed(value?: string | null): string {
  if (!value) return 'Never used'
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return 'Never used'
  return `Last used ${new Date(t).toLocaleDateString()}`
}

/** Keys for the org-scoped public /v1 and MCP APIs. The raw key is shown once, right
 *  after creation; the list only ever holds metadata. */
function ApiTokensSection() {
  const queryClient = useQueryClient()
  const queryKey = ['api-tokens']
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const query = useQuery({ queryKey, queryFn: listApiTokens })

  const create = useMutation({
    mutationFn: (tokenName: string) => createApiToken(tokenName),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      setDialogOpen(false)
      setName('')
      setFreshKey(result.token)
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create token", description: error.message }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteApiToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast({ title: 'Token revoked' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't revoke token", description: error.message }),
  })

  const tokens = query.data ?? []

  return (
    <section id="settings-api-tokens" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">API tokens</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Keys for the public REST and MCP integration APIs.{' '}
            <Link to="/developers" className="text-primary hover:underline">
              Read the API docs
            </Link>
            .
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          New token
        </Button>
      </div>

      {freshKey && (
        <div className="border-b border-border bg-primary-subtle/50 px-5 py-4">
          <p className="text-sm font-medium text-foreground">
            Copy your key now — it won&rsquo;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground">
              {freshKey}
            </code>
            <CopyButton value={freshKey} label="Copy API key" />
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setFreshKey(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="divide-y divide-border">
        {query.isPending ? (
          <div className="space-y-2 px-5 py-4">
            <Skeleton className="h-6 w-1/3" />
          </div>
        ) : query.error ? (
          <p className="px-5 py-4 text-sm text-destructive">{query.error.message}</p>
        ) : tokens.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No tokens yet — create one to call the API.
          </p>
        ) : (
          tokens.map((token: ApiTokenRow) => (
            <div
              key={token.id}
              className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{token.name}</p>
                <p className="text-xs text-muted-foreground">{formatUsed(token.last_used_at)}</p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Revoke ${token.name}`}
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-within:opacity-100"
                disabled={remove.isPending}
                onClick={() => remove.mutate(token.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New API token</DialogTitle>
            <DialogDescription>
              Name it so you remember what it&rsquo;s for. The key is shown once after you create it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = name.trim()
              if (trimmed) create.mutate(trimmed)
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="token-name" required>
                Token name
              </Label>
              <Input
                id="token-name"
                autoFocus
                value={name}
                placeholder="Zapier integration"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create token'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function EventCard({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<EventDraft>(() => toEventDraft(event))
  const [baseline, setBaseline] = useState(() => JSON.stringify(toEventDraft(event)))

  useEffect(() => {
    const next = toEventDraft(event)
    setDraft(next)
    setBaseline(JSON.stringify(next))
  }, [event])

  const dirty = JSON.stringify(draft) !== baseline
  const slugProblem = slugError(draft.slug)
  const slugChanged = draft.slug.trim() !== (event.slug ?? '')

  const save = useMutation({
    mutationFn: () =>
      updateEvent(event.id, {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        timezone: draft.timezone || null,
        starts_at: fromDateInput(draft.starts_at, draft.timezone),
        ends_at: fromDateInput(draft.ends_at, draft.timezone, true),
        location: draft.location.trim() || null,
      }),
    onSuccess: () => {
      // Every public link on this page — the /e/{slug} URLs, the embed snippets,
      // and the schedule's publish confirmation — reads the event row, so one
      // invalidation is what makes them all agree with the new slug.
      queryClient.invalidateQueries({ queryKey: ['events'] })
      toast({ title: 'Event updated' })
    },
    onError: (error: Error) =>
      toast({
        variant: 'destructive',
        // A 409 is a specific, fixable answer ("someone has that URL"), not a
        // generic failure — say so rather than echoing a status code.
        title:
          error instanceof ApiError && error.status === 409
            ? 'That public URL is taken'
            : "Couldn't save event",
        description:
          error instanceof ApiError && error.status === 409
            ? 'Another event already uses that slug. Try a different one.'
            : error.message,
      }),
  })

  const set = (patch: Partial<EventDraft>) => setDraft({ ...draft, ...patch })

  return (
    <section id="settings-event" className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">Event</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Used on public pages, calendar invites and every email you send.
          </p>
        </div>
        {/* Default variant = solid Sessionboard blue. Prominent while there are
            unsaved changes; the disabled state (clean form) reads as muted. */}
        <Button
          className="min-w-[104px]"
          data-testid="save-event"
          disabled={!dirty || Boolean(slugProblem) || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div className="space-y-4 px-5 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="event-name" required>
              Event name
            </Label>
            <Input id="event-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-location">Location</Label>
            <Input
              id="event-location"
              value={draft.location}
              placeholder="San Francisco, CA"
              onChange={(e) => set({ location: e.target.value })}
            />
          </div>
        </div>

        {/* The public URL. Renaming the event does NOT move it — which is how a
            published schedule ends up announcing a slug nobody recognises — so
            it is a field the organizer owns, with the consequence spelled out. */}
        <div className="space-y-1.5">
          <Label htmlFor="event-slug" required>
            Public URL slug
          </Label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-sm text-muted-foreground">/e/</span>
            <Input
              id="event-slug"
              data-testid="event-slug"
              value={draft.slug}
              placeholder="ai-builders-summit"
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={slugProblem ? true : undefined}
              aria-describedby="event-slug-help"
              onChange={(e) => set({ slug: e.target.value.trim().toLowerCase() })}
            />
            <span className="shrink-0 font-mono text-sm text-muted-foreground">/</span>
          </div>
          <p
            id="event-slug-help"
            data-testid="event-slug-help"
            className={cn(
              'text-xs',
              slugProblem
                ? 'font-medium text-destructive'
                : slugChanged
                  ? 'font-medium text-warning-strong'
                  : 'text-muted-foreground'
            )}
          >
            {slugProblem ??
              (slugChanged
                ? `Heads up: changing this changes every public link. /e/${event.slug}/ will stop working and become /e/${draft.slug.trim()}/.`
                : 'Lowercase letters, numbers and hyphens. Used in every public and embedded link.')}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="event-start">Starts</Label>
            <Input
              id="event-start"
              type="date"
              value={draft.starts_at}
              onChange={(e) => set({ starts_at: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="event-end">Ends</Label>
            <Input
              id="event-end"
              type="date"
              value={draft.ends_at}
              onChange={(e) => set({ ends_at: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Timezone</Label>
            <Select value={draft.timezone} onValueChange={(value) => set({ timezone: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timezoneOptions(event.timezone).map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Event branding                                                             */
/* -------------------------------------------------------------------------- */

const BRAND_HEX_RE = /^[0-9a-fA-F]{6}$/
const BRAND_COLOR_DEFAULTS = {
  accent: 'a85e3e',
  background: 'f7f5f1',
  surface: 'fffdfb',
  ink: '1c1a17',
} as const
type BrandingColorKey = keyof typeof BRAND_COLOR_DEFAULTS

const BRAND_COLOR_FIELDS: Array<{ key: BrandingColorKey; label: string }> = [
  { key: 'accent', label: 'Accent' },
  { key: 'background', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'ink', label: 'Ink' },
]

function brandingClientPatch(branding: BrandingConfig): Partial<BrandingConfig> {
  return {
    accent: branding.accent,
    background: branding.background,
    surface: branding.surface,
    ink: branding.ink,
    heading_font: branding.heading_font,
    body_font: branding.body_font,
    radius: branding.radius,
    schedule_layout: branding.schedule_layout,
    speaker_layout: branding.speaker_layout,
    density: branding.density,
    header_style: branding.header_style,
    show_powered_by: branding.show_powered_by,
  }
}

function useFilePreview(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url
}

function BrandingSection({ event }: { event: EventSummary }) {
  const queryClient = useQueryClient()
  const initial = sanitizeBranding(event.branding)
  const [draft, setDraft] = useState<BrandingConfig>(initial)
  const [baseline, setBaseline] = useState(() => JSON.stringify(brandingClientPatch(initial)))
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [faviconFile, setFaviconFile] = useState<File | null>(null)
  const [removeLogo, setRemoveLogo] = useState(false)
  const [removeFavicon, setRemoveFavicon] = useState(false)

  useEffect(() => {
    const next = sanitizeBranding(event.branding)
    setDraft(next)
    setBaseline(JSON.stringify(brandingClientPatch(next)))
    setLogoFile(null)
    setFaviconFile(null)
    setRemoveLogo(false)
    setRemoveFavicon(false)
  }, [event.id, event.branding])

  const localLogo = useFilePreview(logoFile)
  const localFavicon = useFilePreview(faviconFile)
  const logoPreview = localLogo ?? (!removeLogo ? draft.logo_url : null)
  const faviconPreview = localFavicon ?? (!removeFavicon ? draft.favicon_url : null)
  const previewBranding = sanitizeBranding({
    ...draft,
    logo_url: logoPreview,
    favicon_url: faviconPreview,
  })
  useBrandingFonts(previewBranding)
  const invalidColors = BRAND_COLOR_FIELDS.filter(({ key }) => {
    const value = draft[key]
    return Boolean(value && !BRAND_HEX_RE.test(value))
  })
  const currentColors = {
    accent: BRAND_HEX_RE.test(draft.accent ?? '') ? (draft.accent as string) : BRAND_COLOR_DEFAULTS.accent,
    background: BRAND_HEX_RE.test(draft.background ?? '')
      ? (draft.background as string)
      : BRAND_COLOR_DEFAULTS.background,
    surface: BRAND_HEX_RE.test(draft.surface ?? '') ? (draft.surface as string) : BRAND_COLOR_DEFAULTS.surface,
    ink: BRAND_HEX_RE.test(draft.ink ?? '') ? (draft.ink as string) : BRAND_COLOR_DEFAULTS.ink,
  }
  const inkContrast = contrastRatio(currentColors.ink, currentColors.background)
  const accentContrast = contrastRatio(currentColors.accent, currentColors.surface)
  const dirty =
    JSON.stringify(brandingClientPatch(draft)) !== baseline ||
    Boolean(logoFile || faviconFile || removeLogo || removeFavicon)

  const save = useMutation({
    mutationFn: async () => {
      await updateEvent(event.id, { branding: brandingClientPatch(draft) })
      if (logoFile) await uploadEventBrandAsset(event.id, 'logo', logoFile)
      else if (removeLogo) await deleteEventBrandAsset(event.id, 'logo')
      if (faviconFile) await uploadEventBrandAsset(event.id, 'favicon', faviconFile)
      else if (removeFavicon) await deleteEventBrandAsset(event.id, 'favicon')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['events'] })
      toast({ title: 'Branding updated' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save branding", description: error.message }),
  })

  const set = (patch: Partial<BrandingConfig>) => setDraft((current) => ({ ...current, ...patch }))
  const reset = () => {
    setDraft({ ...DEFAULT_BRANDING })
    setLogoFile(null)
    setFaviconFile(null)
    setRemoveLogo(Boolean(draft.logo_url))
    setRemoveFavicon(Boolean(draft.favicon_url))
  }

  return (
    // No overflow-hidden on this card: it would break the sticky live preview.
    <section id="settings-branding" className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">Branding</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The colors, type and layout attendees see for this event only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={reset} disabled={save.isPending}>
            Reset to defaults
          </Button>
          <Button
            type="button"
            data-testid="save-branding"
            disabled={!dirty || invalidColors.length > 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save branding'}
          </Button>
        </div>
      </div>

      <div className="grid gap-8 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-7">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-foreground">Colors</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {BRAND_COLOR_FIELDS.map(({ key, label }) => {
                const invalid = Boolean(draft[key] && !BRAND_HEX_RE.test(draft[key] as string))
                return (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`branding-${key}`}>{label}</Label>
                    <div className="grid grid-cols-[minmax(0,1fr)_42px] gap-2">
                      <Input
                        id={`branding-${key}`}
                        value={draft[key] ?? ''}
                        placeholder={BRAND_COLOR_DEFAULTS[key].toUpperCase()}
                        maxLength={7}
                        aria-invalid={invalid || undefined}
                        onChange={(e) => {
                          const value = e.target.value.trim().replace(/^#/, '')
                          set({ [key]: value || null })
                        }}
                      />
                      <input
                        type="color"
                        aria-label={`${label} color picker`}
                        value={`#${currentColors[key]}`}
                        onChange={(e) => set({ [key]: e.target.value.slice(1).toLowerCase() })}
                        className="h-9 w-[42px] cursor-pointer rounded-md border border-input bg-card p-1"
                      />
                    </div>
                    {invalid && <p className="text-xs text-destructive">Use exactly six hex digits.</p>}
                  </div>
                )
              })}
            </div>
            {(inkContrast < 4.5 || accentContrast < 3) && (
              <div className="space-y-1 rounded-md border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning-strong">
                {inkContrast < 4.5 && <p>Ink on background is {inkContrast.toFixed(2)}:1; aim for 4.5:1.</p>}
                {accentContrast < 3 && <p>Accent on surface is {accentContrast.toFixed(2)}:1; aim for 3:1.</p>}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-foreground">Type</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="branding-heading-font">Heading font</Label>
                <NativeSelect
                  id="branding-heading-font"
                  value={draft.heading_font}
                  onValueChange={(value) => set({ heading_font: value as FontToken })}
                  options={FONT_TOKENS.map((value) => ({ value, label: FONT_LABELS[value] }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="branding-body-font">Body font</Label>
                <NativeSelect
                  id="branding-body-font"
                  value={draft.body_font}
                  onValueChange={(value) => set({ body_font: value as FontToken })}
                  options={FONT_TOKENS.map((value) => ({ value, label: FONT_LABELS[value] }))}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-foreground">Layout</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <BrandingSelect label="Schedule" value={draft.schedule_layout} options={['list', 'tracks', 'grid']} onChange={(value) => set({ schedule_layout: value as BrandingConfig['schedule_layout'] })} />
              <BrandingSelect label="Speakers" value={draft.speaker_layout} options={['grid', 'list']} onChange={(value) => set({ speaker_layout: value as BrandingConfig['speaker_layout'] })} />
              <BrandingSelect label="Density" value={draft.density} options={['comfortable', 'compact']} onChange={(value) => set({ density: value as BrandingConfig['density'] })} />
              <BrandingSelect label="Header" value={draft.header_style} options={['minimal', 'banner']} onChange={(value) => set({ header_style: value as BrandingConfig['header_style'] })} />
              <BrandingSelect label="Corner radius" value={draft.radius} options={['none', 'small', 'medium', 'large']} onChange={(value) => set({ radius: value as BrandingConfig['radius'] })} />
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-foreground">Assets</legend>
            <BrandAssetInput
              kind="logo"
              label="Event logo"
              preview={logoPreview}
              onFile={(file) => {
                setLogoFile(file)
                setRemoveLogo(false)
              }}
              onRemove={() => {
                setLogoFile(null)
                setRemoveLogo(Boolean(draft.logo_url))
              }}
            />
            <BrandAssetInput
              kind="favicon"
              label="Favicon"
              preview={faviconPreview}
              onFile={(file) => {
                setFaviconFile(file)
                setRemoveFavicon(false)
              }}
              onRemove={() => {
                setFaviconFile(null)
                setRemoveFavicon(Boolean(draft.favicon_url))
              }}
            />
          </fieldset>

          <label className="flex cursor-pointer items-center gap-3 text-sm text-foreground">
            <Checkbox
              checked={draft.show_powered_by}
              onCheckedChange={(value) => set({ show_powered_by: value === true })}
            />
            Powered by SpeakerWeave
          </label>
        </div>

        <div className="lg:sticky lg:top-16 lg:self-start">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">Live preview</p>
            <a
              href={publicProgramUrl(event.slug, 'schedule')}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Open live page <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <div
            data-testid="branding-preview"
            data-branding-root
            className="mt-3 overflow-hidden rounded-[var(--radius)] border border-border bg-background text-foreground shadow-soft"
            style={brandingStyle(previewBranding)}
          >
            <div className={cn('border-b border-border bg-card p-4', previewBranding.header_style === 'banner' && 'py-7')}>
              {logoPreview ? (
                <img src={logoPreview} alt={event.name} className="h-8 max-w-[160px] object-contain object-left" />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-primary" />
                  <span className="text-[10px] text-muted-foreground">SpeakerWeave</span>
                </div>
              )}
              <h3 className="mt-3 text-xl font-normal leading-tight">{event.name}</h3>
            </div>
            <div className="p-4">
              <div className="rounded-[var(--radius)] border border-border bg-card p-3">
                <p className="font-mono text-[9px] text-muted-foreground">10:30–11:15</p>
                <h4 className="mt-1 text-sm font-medium">Designing systems people trust</h4>
                <p className="mt-1 text-[10px] text-muted-foreground">Main stage · Product</p>
              </div>
            </div>
            {previewBranding.show_powered_by && (
              <p className="px-4 pb-4 text-[9px] text-muted-foreground">Powered by SpeakerWeave</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function BrandingSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  const id = `branding-${label.toLowerCase().replace(/\s+/g, '-')}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        onValueChange={onChange}
        options={options.map((option) => ({
          value: option,
          label: option.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase()),
        }))}
      />
    </div>
  )
}

function BrandAssetInput({
  kind,
  label,
  preview,
  onFile,
  onRemove,
}: {
  kind: 'logo' | 'favicon'
  label: string
  preview: string | null
  onFile: (file: File) => void
  onRemove: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-4">
      <div className="flex h-14 w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background/60 p-2">
        {preview ? (
          <img src={preview} alt={`${label} preview`} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-[10px] text-placeholder">No {kind}</span>
        )}
      </div>
      <div className="min-w-0">
        <Label htmlFor={`branding-${kind}`}>{label}</Label>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            ref={inputRef}
            id={`branding-${kind}`}
            type="file"
            className="sr-only"
            accept=".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onFile(file)
              // Reset so picking the same file again still fires a change.
              event.target.value = ''
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            {preview ? 'Replace' : 'Upload image'}
          </Button>
          {preview && (
            <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          PNG, JPG, GIF or WebP{kind === 'favicon' ? ' — square images look best' : ''}.
        </p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Taxonomy                                                                   */
/* -------------------------------------------------------------------------- */

type ExtraKind = 'color' | 'capacity' | 'duration'

const DEFAULT_COLOR = '#A85E3E'

interface RowDraft {
  name: string
  color: string
  capacity: string
  default_duration_min: string
}

function emptyDraft(): RowDraft {
  return { name: '', color: DEFAULT_COLOR, capacity: '', default_duration_min: '' }
}

function rowToDraft(row: TaxonomyRow): RowDraft {
  return {
    name: row.name ?? '',
    color: row.color || DEFAULT_COLOR,
    capacity: row.capacity == null ? '' : String(row.capacity),
    default_duration_min: row.default_duration_min == null ? '' : String(row.default_duration_min),
  }
}

function draftToInput(draft: RowDraft, extra?: ExtraKind): TaxonomyInput {
  const input: TaxonomyInput = { name: draft.name.trim() }
  if (extra === 'color') input.color = draft.color || null
  if (extra === 'capacity') input.capacity = draft.capacity === '' ? null : Number(draft.capacity)
  if (extra === 'duration') {
    input.default_duration_min =
      draft.default_duration_min === '' ? null : Number(draft.default_duration_min)
  }
  return input
}

function TaxonomySection({
  eventId,
  kind,
  title,
  description,
  extra,
}: {
  eventId: string
  kind: TaxonomyKind
  title: string
  description: string
  extra?: ExtraKind
}) {
  const queryClient = useQueryClient()
  const queryKey = ['taxonomy', kind, eventId]
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<RowDraft>(emptyDraft)
  const [addDraft, setAddDraft] = useState<RowDraft>(emptyDraft)

  const query = useQuery({ queryKey, queryFn: () => listTaxonomy(eventId, kind) })

  const invalidate = () => queryClient.invalidateQueries({ queryKey })

  const create = useMutation({
    mutationFn: () => createTaxonomy(eventId, kind, draftToInput(addDraft, extra)),
    onSuccess: () => {
      invalidate()
      setAddDraft(emptyDraft())
      toast({ title: `${singular(title)} added` })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't add", description: error.message }),
  })

  const update = useMutation({
    mutationFn: (id: string) => updateTaxonomy(kind, id, draftToInput(editDraft, extra)),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      toast({ title: 'Saved' })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't save", description: error.message }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteTaxonomy(kind, id),
    onSuccess: () => {
      invalidate()
      toast({ title: 'Deleted' })
    },
    onError: (error: Error) => {
      // 409 is the backend saying "something still points at this row".
      const inUse = error instanceof ApiError && error.status === 409
      toast({
        variant: 'destructive',
        title: inUse ? 'In use by sessions' : "Couldn't delete",
        description: inUse
          ? `Reassign the sessions using this ${singular(title).toLowerCase()} first.`
          : error.message,
      })
    },
  })

  const rows = query.data ?? []

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-medium text-foreground">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>

      <div className="divide-y divide-border">
        {query.isPending ? (
          <div className="space-y-2 px-5 py-4">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-6 w-1/4" />
          </div>
        ) : query.error ? (
          <p className="px-5 py-4 text-sm text-destructive">{query.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No {title.toLowerCase()} yet — add the first one below.
          </p>
        ) : (
          rows.map((row) =>
            editingId === row.id ? (
              <div key={row.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
                <RowFields draft={editDraft} setDraft={setEditDraft} extra={extra} />
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    aria-label="Save"
                    disabled={!editDraft.name.trim() || update.isPending}
                    onClick={() => update.mutate(row.id)}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Cancel"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div
                key={row.id}
                className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover"
              >
                {extra === 'color' && (
                  <span
                    className="h-4 w-4 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: row.color || DEFAULT_COLOR }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {row.name}
                </span>
                {extra === 'capacity' && (
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {row.capacity == null ? '—' : `${row.capacity} seats`}
                  </span>
                )}
                {extra === 'duration' && (
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {row.default_duration_min == null ? '—' : `${row.default_duration_min} min`}
                  </span>
                )}
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(row.id)
                      setEditDraft(rowToDraft(row))
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${row.name}`}
                    className="text-muted-foreground hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(row.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )
          )
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2 border-t border-border bg-background/60 px-5 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (addDraft.name.trim()) create.mutate()
        }}
      >
        <RowFields draft={addDraft} setDraft={setAddDraft} extra={extra} placeholder={`New ${singular(title).toLowerCase()}`} />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={!addDraft.name.trim() || create.isPending}
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </form>
    </section>
  )
}

function RowFields({
  draft,
  setDraft,
  extra,
  placeholder = 'Name',
}: {
  draft: RowDraft
  setDraft: (next: RowDraft) => void
  extra?: ExtraKind
  placeholder?: string
}) {
  return (
    <>
      {extra === 'color' && (
        <input
          type="color"
          aria-label="Color"
          value={draft.color}
          onChange={(e) => setDraft({ ...draft, color: e.target.value })}
          className={cn(
            'h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1',
            'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20'
          )}
        />
      )}
      <Input
        className="h-8 w-[220px]"
        value={draft.name}
        placeholder={placeholder}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      {extra === 'capacity' && (
        <Input
          type="number"
          min={0}
          className="h-8 w-[120px]"
          value={draft.capacity}
          placeholder="Seats"
          onChange={(e) => setDraft({ ...draft, capacity: e.target.value })}
        />
      )}
      {extra === 'duration' && (
        <Input
          type="number"
          min={5}
          step={5}
          className="h-8 w-[130px]"
          value={draft.default_duration_min}
          placeholder="Minutes"
          onChange={(e) => setDraft({ ...draft, default_duration_min: e.target.value })}
        />
      )}
    </>
  )
}

/** "Tracks" → "Track". Only ever fed the five section titles above. */
function singular(title: string): string {
  return title.endsWith('s') ? title.slice(0, -1) : title
}
