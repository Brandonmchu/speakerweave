import { useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarDays,
  ClipboardList,
  FileText,
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

export function AppShell() {
  const navigate = useNavigate()

  // Shared with Inbox via the same query key — one fetch, both consumers.
  const { data } = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })
  const event = data?.[0]

  // The shell owns the viewport; public pages keep natural document flow.
  useEffect(() => {
    document.documentElement.classList.add('app-shell-active')
    document.body.classList.add('app-shell-active')
    return () => {
      document.documentElement.classList.remove('app-shell-active')
      document.body.classList.remove('app-shell-active')
    }
  }, [])

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-navigation-border bg-navigation md:flex">
        <div className="flex h-14 items-center gap-2 px-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            d
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">dais</span>
        </div>

        <div className="mx-3 rounded-md border border-border bg-background px-3 py-2">
          <div className="truncate text-sm font-medium text-foreground">{event?.name ?? 'No event yet'}</div>
          <div className="truncate text-xs text-muted-foreground">{formatEventDates(event)}</div>
        </div>

        <nav className="mt-4 flex-1 space-y-5 overflow-y-auto px-3 pb-6 scrollbar-app">
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
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-4 md:px-6">
          <div className="relative hidden max-w-md flex-1 items-center sm:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
            <input
              disabled
              placeholder="Find or ask…"
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground placeholder:text-placeholder disabled:cursor-not-allowed"
            />
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground lg:inline">{event?.name ?? 'dais'}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearToken()
                navigate('/dev-login')
              }}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-app">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
