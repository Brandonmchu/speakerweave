import { useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  CalendarDays,
  Check,
  ChevronsUpDown,
  ClipboardList,
  ExternalLink,
  FileText,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Mail,
  Search,
  Settings,
  Star,
  Users,
} from 'lucide-react'

import { apiGet, clearToken, unwrapList, type EventSummary } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'

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
      { label: 'Comms', to: '/comms', icon: Mail },
    ],
  },
  { label: 'Configure', items: [{ label: 'Settings', to: '/settings', icon: Settings }] },
]

function formatEventDates(event?: EventSummary): string {
  if (!event?.starts_at) return 'No dates set'
  const start = new Date(event.starts_at)
  const end = event.ends_at ? new Date(event.ends_at) : null
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  if (!end || start.toDateString() === end.toDateString()) {
    return start.toLocaleDateString(undefined, opts)
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, opts)}`
}

function initialOf(name?: string | null): string {
  return (name?.trim().charAt(0) || 'd').toUpperCase()
}

export function AppShell() {
  const navigate = useNavigate()

  // Shared with Inbox via the same query key — one fetch, both consumers.
  const { data } = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = data?.[0]
  const eventInitial = initialOf(event?.name)

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
    navigate('/dev-login')
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
              <DropdownMenuItem className="gap-2.5">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
                  {eventInitial}
                </div>
                <span className="min-w-0 flex-1 truncate">{event?.name ?? 'No event yet'}</span>
                <Check className="h-4 w-4 shrink-0 text-primary" />
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

          <div className="ml-auto flex items-center gap-1.5 md:gap-2">
            <Button
              variant="outline"
              size="sm"
              title="Open the public speaker portal"
              className="hidden md:inline-flex"
            >
              <ExternalLink className="h-4 w-4" />
              View Portal
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
    </div>
  )
}
