import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  CalendarDays,
  Check,
  ChevronsUpDown,
  ClipboardList,
  Contact,
  ExternalLink,
  FileArchive,
  FileText,
  HelpCircle,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  Mail,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Users,
} from 'lucide-react'

import { AssistantPanel } from '@/components/AssistantPanel'
import { apiGet, clearToken, unwrapList, type EventSummary } from '@/lib/api'
import { createEvent } from '@/lib/adminApi'
import { fromDateInput, localTimezone, timezoneOptions } from '@/lib/eventDateTime'
import { FEATURED_EVENT_SLUG } from '@/lib/featuredEvent'
import { cn } from '@/lib/utils'
import { Badge } from '@/ui/badge'
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

interface NavItem {
  label: string
  to: string
  icon: typeof LayoutDashboard
}

interface NavSection {
  label?: string
  items: NavItem[]
}

const NAV: NavSection[] = [
  { items: [{ label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard }] },
  {
    label: 'Program',
    items: [
      { label: 'Submissions', to: '/submissions', icon: ClipboardList },
      { label: 'Forms', to: '/forms', icon: FileText },
      { label: 'Evaluation', to: '/evaluation', icon: Star },
      { label: 'Agenda', to: '/agenda', icon: CalendarDays },
    ],
  },
  {
    label: 'People',
    items: [
      { label: 'Speakers', to: '/speakers', icon: Users },
      { label: 'Content', to: '/content', icon: FileArchive },
      { label: 'Comms', to: '/comms', icon: Mail },
    ],
  },
  // Above the event switcher's scope on purpose: the CRM spans every event the
  // org has run, which is exactly what the per-event Speakers page cannot show.
  {
    label: 'CRM',
    items: [
      { label: 'Directory', to: '/directory', icon: Contact },
      { label: 'Pipeline', to: '/pipeline', icon: KanbanSquare },
    ],
  },
  { label: 'Configure', items: [{ label: 'Settings', to: '/settings', icon: Settings }] },
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

/**
 * True when the current session is the shared demo token (org_id === 'org_dev').
 * Decodes the JWT payload segment inline — no dependency, best-effort: any
 * malformed token simply reads as "not a demo session".
 */
function isDemoSession(): boolean {
  try {
    const token = window.localStorage.getItem('dais.token')
    const payload = token?.split('.')[1]
    if (!payload) return false
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    return (JSON.parse(atob(padded)) as { org_id?: string }).org_id === 'org_dev'
  } catch {
    return false
  }
}

export function AppShell() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeEventId, setActiveEventId] = useState(() => {
    try {
      return window.localStorage.getItem(ACTIVE_EVENT_KEY)
    } catch {
      return null
    }
  })
  const [newEventOpen, setNewEventOpen] = useState(false)
  const [newEventName, setNewEventName] = useState('')
  const [newEventStart, setNewEventStart] = useState('')
  const [newEventEnd, setNewEventEnd] = useState('')
  const [newEventTimezone, setNewEventTimezone] = useState(() => localTimezone())
  const [newEventLocation, setNewEventLocation] = useState('')
  const [assistantOpen, setAssistantOpen] = useState(false)

  // Shared with Inbox via the same query key — one fetch, both consumers.
  const { data } = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const events = data ?? []
  const event = events.find((candidate) => candidate.id === activeEventId) ?? events[0]
  const eventInitial = initialOf(event?.name)
  const isDemo = isDemoSession()

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

  const resetNewEvent = () => {
    setNewEventName('')
    setNewEventStart('')
    setNewEventEnd('')
    setNewEventTimezone(localTimezone())
    setNewEventLocation('')
  }

  const create = useMutation({
    mutationFn: () =>
      createEvent({
        name: newEventName.trim(),
        timezone: newEventTimezone || null,
        starts_at: fromDateInput(newEventStart, newEventTimezone),
        ends_at: fromDateInput(newEventEnd, newEventTimezone, true),
        location: newEventLocation.trim() || null,
      }),
    onSuccess: (created) => {
      queryClient.setQueryData<EventSummary[]>(['events'], (current = []) => [
        created,
        ...current.filter((candidate) => candidate.id !== created.id),
      ])
      switchEvent(created.id)
      setNewEventOpen(false)
      resetNewEvent()
      toast({ title: 'Event created', description: `${created.name} is now selected.` })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create event", description: error.message }),
  })

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
    // Demo visitors came in through /demo; send them back there, not /dev-login.
    navigate(isDemo ? '/demo' : '/dev-login')
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-navigation-border bg-navigation md:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            d
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">dais</span>
        </div>

        {/* Event switcher — a static single-event dropdown today, but the chevron
            + colored square read as the Sessionboard multi-event switcher. */}
        <div className="px-3 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                  {eventInitial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {event?.name ?? 'No event yet'}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{formatEventDates(event)}</div>
                </div>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
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

        <nav className="mt-3 flex-1 space-y-5 overflow-y-auto px-3 pb-6 scrollbar-app">
          {NAV.map((section, i) => (
            <div key={section.label ?? `section-${i}`}>
              {section.label && (
                <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map(({ label, to, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary-subtle text-primary'
                          : 'text-navigation-foreground hover:bg-navigation-accent hover:text-navigation-accent-foreground'
                      )
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:px-6">
          <div className="relative flex max-w-2xl flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
            <input
              disabled
              placeholder="Find or ask…"
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-16 text-sm text-foreground placeholder:text-placeholder disabled:cursor-not-allowed"
            />
            <kbd className="pointer-events-none absolute right-2.5 hidden select-none items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground sm:flex">
              ⌘K
            </kbd>
          </div>

          <button
            type="button"
            data-testid="ask-assistant"
            title="Ask SpeakerWeave"
            aria-label="Ask SpeakerWeave"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-primary/25 bg-primary-subtle px-2.5 text-sm font-semibold text-primary transition-colors hover:border-primary/40 hover:bg-primary/10 active:scale-[0.98] sm:px-3"
            onClick={() => setAssistantOpen(true)}
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Ask</span>
          </button>

          <div className="ml-auto flex items-center gap-1.5 md:gap-2">
            {isDemo && (
              <Badge
                variant="default"
                title="You're exploring the shared demo workspace"
                className="hidden sm:inline-flex"
              >
                Demo workspace
              </Badge>
            )}

            <Button
              variant="outline"
              size="sm"
              title="Open the public schedule in a new tab"
              className="hidden md:inline-flex"
              onClick={() =>
                window.open(
                  `/e/${event?.slug ?? FEATURED_EVENT_SLUG}/schedule`,
                  '_blank',
                  'noopener,noreferrer'
                )
              }
            >
              <ExternalLink className="h-4 w-4" />
              View public page
            </Button>

            <button
              type="button"
              title="Notifications"
              aria-label="Notifications"
              className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border border-card bg-destructive" />
            </button>

            <button
              type="button"
              title="Help"
              aria-label="Help"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <HelpCircle className="h-[18px] w-[18px]" />
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Account menu"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  {eventInitial}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8} className="w-52">
                <DropdownMenuLabel className="text-foreground">{event?.name ?? 'dais'}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={signOut} className="gap-2">
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-app">
          <Outlet />
        </main>
      </div>

      <Dialog open={newEventOpen} onOpenChange={(open) => !create.isPending && setNewEventOpen(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a new event</DialogTitle>
            <DialogDescription>Add the event basics now. You can configure the program after.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault()
              if (newEventName.trim()) create.mutate()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="new-event-name" required>Name</Label>
              <Input
                id="new-event-name"
                value={newEventName}
                maxLength={200}
                autoFocus
                onChange={(inputEvent) => setNewEventName(inputEvent.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="new-event-start">Start date</Label>
                <Input id="new-event-start" type="date" value={newEventStart} onChange={(inputEvent) => setNewEventStart(inputEvent.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-event-end">End date</Label>
                <Input id="new-event-end" type="date" value={newEventEnd} min={newEventStart || undefined} onChange={(inputEvent) => setNewEventEnd(inputEvent.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-event-timezone">Timezone</Label>
              <NativeSelect
                id="new-event-timezone"
                value={newEventTimezone}
                onValueChange={setNewEventTimezone}
                options={timezoneOptions(newEventTimezone).map((timezone) => ({ value: timezone, label: timezone }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-event-location">Location</Label>
              <Input
                id="new-event-location"
                value={newEventLocation}
                maxLength={300}
                placeholder="Venue or online"
                onChange={(inputEvent) => setNewEventLocation(inputEvent.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" disabled={create.isPending} onClick={() => setNewEventOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newEventName.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create event'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AssistantPanel open={assistantOpen} onOpenChange={setAssistantOpen} />
    </div>
  )
}
