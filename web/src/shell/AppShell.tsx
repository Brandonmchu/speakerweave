import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark } from '@/ui/brand'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  LogOut,
  Plus,
  Sparkles,
} from 'lucide-react'

import { agentKeys, getAgentCapabilities } from '@/agent/lib/agentApi'
import { CLERK_ENABLED, ClerkUserIdentity, type AuthUserIdentity } from '@/auth/clerk'
import {
  apiGet,
  clearToken,
  listMyOrganizations,
  organizationKeys,
  peekToken,
  setToken,
  switchOrganization,
  unwrapList,
  type EventSummary,
} from '@/lib/api'
import { createEvent } from '@/lib/adminApi'
import { fromDateInput, localTimezone, timezoneOptions } from '@/lib/eventDateTime'
import { FEATURED_EVENT_SLUG } from '@/lib/featuredEvent'
import { preloadOrganizerRoute } from '@/lib/routeLoaders'
import { cn } from '@/lib/utils'
import { GradientAvatar } from '@/ui/avatar'
import { Button } from '@/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
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
import { NativeSelect } from '@/ui/native-select'
import { toast } from '@/ui/use-toast'

const loadAgentFeature = () =>
  import('@/agent').then(({ AgentFeature }) => ({ default: AgentFeature }))
const LazyAgentFeature = lazy(loadAgentFeature)

interface NavItem {
  label: string
  to: string
}

interface NavSection {
  label?: string
  items: NavItem[]
}

const NAV: NavSection[] = [
  { items: [{ label: 'Today', to: '/dashboard' }] },
  {
    label: 'Program',
    items: [
      { label: 'Submissions', to: '/submissions' },
      { label: 'Forms', to: '/forms' },
      { label: 'Evaluation', to: '/evaluation' },
      { label: 'Agenda', to: '/agenda' },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Speakers', to: '/speakers' },
      { label: 'Content', to: '/content' },
      { label: 'Comms', to: '/comms' },
    ],
  },
  // Above the event switcher's scope on purpose: the CRM spans every event the
  // org has run, which is exactly what the per-event Speakers page cannot show.
  {
    label: 'CRM',
    items: [
      { label: 'Directory', to: '/directory' },
      { label: 'Pipeline', to: '/pipeline' },
    ],
  },
  { label: 'Configure', items: [{ label: 'Settings', to: '/settings' }] },
]

const ACTIVE_EVENT_KEY = 'dais.active-event-id'

function formatEventDates(event?: EventSummary): string {
  if (!event?.starts_at) return 'No dates set'
  const start = new Date(event.starts_at)
  const end = event.ends_at ? new Date(event.ends_at) : null
  const timeZone = event.timezone || undefined
  const dayKey = (value: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(value)
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => part.value)
      .join('-')
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }
  if (!end || dayKey(start) === dayKey(end)) {
    return start.toLocaleDateString(undefined, opts)
  }
  return `${start.toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, opts)}`
}

function initialOf(name?: string | null): string {
  return (name?.trim().charAt(0) || 'd').toUpperCase()
}

function eventCountdown(event?: EventSummary): string | null {
  if (!event?.starts_at) return null
  const start = Date.parse(event.starts_at)
  if (!Number.isFinite(start)) return null
  const days = Math.ceil((start - Date.now()) / 86_400_000)
  if (days > 1) return `${days} days out`
  if (days === 1) return '1 day out'
  if (days === 0) return 'starts today'
  return 'event underway'
}

interface SessionClaims {
  sub?: string
  org_id?: string
  name?: string
  email?: string
  org_name?: string
}

function readSessionClaims(): SessionClaims {
  try {
    const token = window.localStorage.getItem('dais.token')
    const payload = token?.split('.')[1]
    if (!payload) return {}
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return JSON.parse(atob(padded)) as SessionClaims
  } catch {
    return {}
  }
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^(org|user)_/, '')
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function sessionIdentity(claims: SessionClaims): AuthUserIdentity {
  const id = claims.sub || 'organizer'
  const name = claims.name || (claims.email ? claims.email.split('@')[0] : null) || humanizeIdentifier(id) || 'Organizer'
  const workspace =
    claims.org_name ||
    (claims.org_id === 'org_dev'
      ? 'Demo workspace'
      : claims.org_id
        ? humanizeIdentifier(claims.org_id)
        : 'Workspace')
  return { id, name, workspace }
}

/**
 * The rail foot: who you are, which workspace you're in, and — for someone who
 * organizes for more than one company — the switch between them.
 *
 * The org list is strictly additive. One membership (or a backend that can't
 * answer) leaves this menu exactly as it has always been: identity, then sign
 * out. There is no empty "Workspaces" heading to explain away.
 */
function RailAccount({
  identity,
  onSignOut,
}: {
  identity: AuthUserIdentity
  onSignOut: () => void
}) {
  const queryClient = useQueryClient()
  const organizationsQuery = useQuery({
    queryKey: organizationKeys.mine,
    queryFn: listMyOrganizations,
    retry: false,
    staleTime: 5 * 60_000,
  })
  const organizations = organizationsQuery.data ?? []
  const canSwitch = organizations.length > 1

  const switchWorkspace = useMutation({
    mutationFn: (orgId: string) => switchOrganization(orgId),
    onSuccess: (token, orgId) => {
      setToken(token)
      // The whole cache — events, submissions, speakers — belongs to the org we
      // just left. Drop it so every panel refetches under the new token instead
      // of reloading the page out from under the operator.
      queryClient.removeQueries()
      const target = organizations.find((candidate) => candidate.org_id === orgId)
      toast({
        title: 'Workspace switched',
        description: target ? `You're now in ${target.name}.` : undefined,
      })
    },
    onError: (error: Error) =>
      toast({
        variant: 'destructive',
        title: "Couldn't switch workspace",
        description: error.message,
      }),
  })

  return (
    <div className="shrink-0 px-3 pb-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-navigation-accent"
          >
            <GradientAvatar id={identity.id} name={identity.name} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium leading-4 text-foreground">{identity.name}</span>
              <span className="block truncate text-[11px] leading-4 text-placeholder">{identity.workspace}</span>
            </span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-placeholder" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className={canSwitch ? 'w-56' : 'w-48'}
        >
          <DropdownMenuLabel>
            <span className="block truncate text-foreground">{identity.name}</span>
            <span className="block truncate text-[10px] font-normal text-muted-foreground">{identity.workspace}</span>
          </DropdownMenuLabel>
          {canSwitch && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="section-label">Workspaces</DropdownMenuLabel>
              {organizations.map((organization) => (
                <DropdownMenuItem
                  key={organization.org_id}
                  className="gap-2.5"
                  disabled={switchWorkspace.isPending}
                  onSelect={() => {
                    if (!organization.is_current) switchWorkspace.mutate(organization.org_id)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{organization.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-placeholder">
                    {organization.events}
                  </span>
                  {organization.is_current && (
                    <>
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                      <span className="sr-only">Current workspace</span>
                    </>
                  )}
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onSignOut} className="gap-2">
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function CreateEventDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (event: EventSummary) => void
}) {
  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [timezone, setTimezone] = useState(() => localTimezone())
  const [location, setLocation] = useState('')

  const reset = () => {
    setName('')
    setStartsAt('')
    setEndsAt('')
    setTimezone(localTimezone())
    setLocation('')
  }

  const create = useMutation({
    mutationFn: () =>
      createEvent({
        name: name.trim(),
        timezone: timezone || null,
        starts_at: fromDateInput(startsAt, timezone),
        ends_at: fromDateInput(endsAt, timezone, true),
        location: location.trim() || null,
      }),
    onSuccess: (created) => {
      onCreated(created)
      onOpenChange(false)
      reset()
      toast({ title: 'Event created', description: `${created.name} is now selected.` })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create event", description: error.message }),
  })

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a new event</DialogTitle>
          <DialogDescription>Add the event basics now. You can configure the program after.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-event-name" required>Name</Label>
            <Input
              id="new-event-name"
              value={name}
              maxLength={200}
              autoFocus
              onChange={(inputEvent) => setName(inputEvent.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-event-start">Start date</Label>
              <Input id="new-event-start" type="date" value={startsAt} onChange={(inputEvent) => setStartsAt(inputEvent.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-event-end">End date</Label>
              <Input id="new-event-end" type="date" value={endsAt} min={startsAt || undefined} onChange={(inputEvent) => setEndsAt(inputEvent.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-event-timezone">Timezone</Label>
            <NativeSelect
              id="new-event-timezone"
              value={timezone}
              onValueChange={setTimezone}
              options={timezoneOptions(timezone).map((option) => ({ value: option, label: option }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-event-location">Location</Label>
            <Input
              id="new-event-location"
              value={location}
              maxLength={300}
              placeholder="Venue or online"
              onChange={(inputEvent) => setLocation(inputEvent.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={create.isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create event'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [activeEventId, setActiveEventId] = useState(() => {
    try {
      return window.localStorage.getItem(ACTIVE_EVENT_KEY)
    } catch {
      return null
    }
  })
  const [newEventOpen, setNewEventOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try {
      return window.localStorage.getItem('sw.chat.open') === 'true'
    } catch {
      return false
    }
  })

  const capabilitiesQuery = useQuery({
    queryKey: agentKeys.capabilities,
    queryFn: getAgentCapabilities,
    staleTime: Infinity,
    retry: false,
  })
  const agentEnabled = capabilitiesQuery.data?.assistant === true

  const setAgentOpen = useCallback((open: boolean) => {
    setAssistantOpen(open)
    try {
      window.localStorage.setItem('sw.chat.open', String(open))
    } catch {
      // The panel still opens for this session when storage is unavailable.
    }
  }, [])

  // The chat code (including Markdown parsing) is not in the shell bundle. Once
  // capabilities opt in, warm it during idle time so the first deliberate open
  // is instant without competing with the shell's own first paint.
  useEffect(() => {
    if (!agentEnabled) return
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(() => void loadAgentFeature(), { timeout: 3000 })
      return () => idleWindow.cancelIdleCallback?.(handle)
    }
    const handle = window.setTimeout(() => void loadAgentFeature(), 1500)
    return () => window.clearTimeout(handle)
  }, [agentEnabled])

  useEffect(() => {
    if (!agentEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !['j', 'k'].includes(event.key.toLowerCase())) return
      event.preventDefault()
      setAgentOpen(!assistantOpen)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [agentEnabled, assistantOpen, setAgentOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Shared with Inbox via the same query key — one fetch, both consumers.
  const { data } = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const events = data ?? []
  const event = events.find((candidate) => candidate.id === activeEventId) ?? events[0]
  const claims = readSessionClaims()
  const currentUser = sessionIdentity(claims)
  const countdown = eventCountdown(event)

  const switchEvent = (eventId: string) => {
    setActiveEventId(eventId)
    try {
      window.localStorage.setItem(ACTIVE_EVENT_KEY, eventId)
    } catch {
      // Selection remains active for this browser session even if storage fails.
    }
    queryClient.setQueryData<EventSummary[]>(['events'], (current = []) => {
      const selected = current.find((candidate) => candidate.id === eventId)
      return selected
        ? [selected, ...current.filter((candidate) => candidate.id !== eventId)]
        : current
    })
  }

  // Every event-scoped page reads the first row from the shared cache. Honor a
  // persisted selection by moving it to the front once the list arrives.
  useEffect(() => {
    if (event && events[0]?.id !== event.id) switchEvent(event.id)
  }, [event?.id, events[0]?.id])

  // The shell owns the viewport; public pages keep natural document flow.
  useEffect(() => {
    document.documentElement.classList.add('app-shell-active')
    document.body.classList.add('app-shell-active')
    return () => {
      document.documentElement.classList.remove('app-shell-active')
      document.body.classList.remove('app-shell-active')
    }
  }, [])

  const signOut = () => {
    clearToken()
    // The public site, for everyone — and by leaving the SPA rather than
    // routing inside it. `/demo` mints a token and walks straight back in, so
    // it made "sign out" a no-op for demo visitors; `/dev-login` is a
    // token-paste form that means nothing to an organizer. A client-side
    // navigate is not enough either: the auth guard re-runs the instant the
    // token clears and wins the race, sending them to the token form or, under
    // Clerk, to a hosted sign-in they never asked for. A full load of `/` lands
    // on the landing page with no guard in the way, and drops every cache and
    // in-memory scrap of the session on the way out.
    window.location.assign('/')
  }

  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileNavOpen])

  // Shared between the desktop rail and the mobile drawer — same nav, same
  // event switcher, same account foot, so the two can never drift apart.
  const railContent = (
    <>
      <div className="flex h-[50px] shrink-0 items-center gap-2.5 px-5">
        <BrandMark className="h-5 w-5 rounded-md" />
        <span className="text-[14px] font-semibold tracking-[-0.02em] text-foreground">SpeakerWeave</span>
      </div>

        {/* Event switcher — a static single-event dropdown today, but the chevron
            + colored square read as the Sessionboard multi-event switcher. */}
        <div className="px-3 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-[10px] bg-foreground/[0.045] px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium leading-5 text-foreground">
                    {event?.name ?? 'No event yet'}
                  </div>
                  <div className="truncate text-[11px] leading-4 text-placeholder">
                    <span>{formatEventDates(event)}</span>
                    {countdown && <span> · {countdown}</span>}
                  </div>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-placeholder" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className="w-[13.5rem]">
              <DropdownMenuLabel>Events</DropdownMenuLabel>
              {events.map((candidate) => (
                <DropdownMenuItem
                  key={candidate.id}
                  className="gap-2.5"
                  onSelect={() => switchEvent(candidate.id)}
                >
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-foreground/[0.07] font-mono text-[10px] font-semibold text-foreground">
                    {initialOf(candidate.name)}
                  </div>
                  <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                  {candidate.id === event?.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="gap-2.5" onSelect={() => setNewEventOpen(true)}>
                <Plus className="h-4 w-4" />
                New event
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <nav className="mt-3 flex-1 space-y-4 overflow-y-auto px-3 pb-5 scrollbar-app">
          {NAV.map((section, i) => (
            <div key={section.label ?? `section-${i}`}>
              {section.label && (
                <div className="section-label px-2 pb-1.5">
                  {section.label}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map(({ label, to }) => (
                  <NavLink
                    key={to}
                    to={to}
                    onPointerEnter={() => preloadOrganizerRoute(to)}
                    onFocus={() => preloadOrganizerRoute(to)}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-[30px] items-center rounded-lg px-2.5 py-1.5 text-[13px] font-normal transition-[background-color,color,box-shadow]',
                        isActive
                          ? 'bg-card text-foreground shadow-soft'
                          : 'text-navigation-foreground hover:bg-navigation-accent hover:text-navigation-accent-foreground'
                      )
                    }
                  >
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {CLERK_ENABLED && !peekToken() ? (
          <ClerkUserIdentity>
            {(identity) => <RailAccount identity={identity} onSignOut={signOut} />}
          </ClerkUserIdentity>
        ) : (
          <RailAccount identity={currentUser} onSignOut={signOut} />
        )}
    </>
  )

  return (
    <div
      className={cn(
        'grid h-[100dvh] w-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background',
        agentEnabled && assistantOpen
          ? 'md:grid-cols-[220px_minmax(0,1fr)_420px]'
          : 'md:grid-cols-[220px_minmax(0,1fr)]',
      )}
    >
      <aside className="hidden h-full min-h-0 flex-col overflow-hidden bg-navigation md:flex">
        {railContent}
      </aside>

      {/* Phones have no rail — the topbar Menu button opens this drawer. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="absolute inset-0 bg-foreground/30"
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            className="absolute inset-y-0 left-0 flex w-[264px] flex-col overflow-hidden bg-navigation shadow-lifted"
            onClickCapture={(clickEvent) => {
              const target = clickEvent.target
              if (target instanceof HTMLElement && target.closest('a')) setMobileNavOpen(false)
            }}
          >
            {railContent}
          </div>
        </div>
      )}

      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card">
        <header className="flex h-[50px] shrink-0 items-center gap-3 bg-transparent px-4 md:px-7">
          <button
            type="button"
            aria-label="Open navigation"
            className="inline-flex h-[30px] shrink-0 items-center rounded-lg px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground md:hidden"
            onClick={() => setMobileNavOpen(true)}
          >
            Menu
          </button>
          <div className="relative flex w-full max-w-[300px] items-center">
            {/* This field IS the Ask entrance — typing here would be a dead
                end (there is no separate search index), so any focus or
                keypress hands off to the Ask pane instead of eating input. */}
            <input
              ref={searchInputRef}
              aria-label="Find or ask"
              readOnly
              placeholder="Find or ask"
              className="h-[30px] w-full cursor-pointer rounded-lg border-0 bg-foreground/[0.04] pl-3 pr-12 text-[12.5px] text-foreground outline-none placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-primary/15"
              onClick={() => {
                if (agentEnabled) {
                  setAgentOpen(true)
                  searchInputRef.current?.blur()
                }
              }}
              onKeyDown={(keyEvent) => {
                if (!agentEnabled) return
                if (keyEvent.key === 'Enter' || keyEvent.key.length === 1) {
                  keyEvent.preventDefault()
                  setAgentOpen(true)
                  searchInputRef.current?.blur()
                }
              }}
            />
            <kbd className="pointer-events-none absolute right-2.5 hidden select-none font-mono text-[10px] text-placeholder sm:block">
              /
            </kbd>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              title="Open the public schedule in a new tab"
              className="hidden h-[30px] items-center rounded-lg px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-foreground md:inline-flex"
              onClick={() =>
                window.open(
                  `/e/${event?.slug ?? FEATURED_EVENT_SLUG}/schedule`,
                  '_blank',
                  'noopener,noreferrer'
                )
              }
            >
              View public page
            </button>

            <span id="speakerweave-agent-toggle" className="contents">
              {agentEnabled && (
                <button
                  type="button"
                  data-testid="ask-agent"
                  data-chat-toggle="true"
                  title="Ask SpeakerWeave (⌘K)"
                  aria-label="Ask SpeakerWeave"
                  aria-pressed={assistantOpen}
                  onClick={() => setAgentOpen(!assistantOpen)}
                  className={cn(
                    'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg bg-card px-2.5 text-[12.5px] font-medium text-foreground shadow-soft transition-[background-color,transform] active:translate-y-px',
                    assistantOpen ? 'bg-foreground/[0.07]' : 'hover:bg-foreground/[0.028]',
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <span>Ask</span>
                  <kbd className="ml-0.5 hidden font-mono text-[9.5px] font-normal text-placeholder sm:inline">⌘K</kbd>
                </button>
              )}
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto bg-card scrollbar-app">
          <Outlet />
        </main>
      </div>

      {agentEnabled && assistantOpen && <div className="hidden bg-card md:block" aria-hidden="true" />}

      <CreateEventDialog
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        onCreated={(created) => {
          queryClient.setQueryData<EventSummary[]>(['events'], (current = []) => [
            created,
            ...current.filter((candidate) => candidate.id !== created.id),
          ])
          switchEvent(created.id)
        }}
      />

      {agentEnabled && capabilitiesQuery.data && assistantOpen && (
        <Suspense
          fallback={
            <aside
              role="status"
              aria-label="Loading Ask SpeakerWeave"
              className="fixed bottom-0 right-0 top-0 z-40 w-full animate-pulse border-l border-border bg-card sm:w-[420px]"
            />
          }
        >
          <LazyAgentFeature
            capabilities={capabilitiesQuery.data}
            open={assistantOpen}
            onOpenChange={setAgentOpen}
          />
        </Suspense>
      )}
    </div>
  )
}
