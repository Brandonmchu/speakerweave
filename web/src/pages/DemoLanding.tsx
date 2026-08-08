import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, ClipboardList, Star } from 'lucide-react'

import { setToken } from '@/lib/api'
import { fetchDemoToken } from '@/lib/demoApi'
import { Button } from '@/ui/button'

const HIGHLIGHTS = [
  {
    icon: ClipboardList,
    title: 'Review submissions',
    body: 'Triage the CFP inbox — accept, decline, and dig into every proposal.',
  },
  {
    icon: CalendarDays,
    title: 'Build the agenda',
    body: 'Schedule sessions across rooms and tracks, conflicts flagged in real time.',
  },
  {
    icon: Star,
    title: 'Score & onboard speakers',
    body: 'Run the evaluation plan, then walk accepted speakers through their tasks.',
  },
]

/**
 * Public one-click demo entrance (route: /demo).
 *
 * "Enter the demo workspace" fetches a short-lived token for the shared, fully
 * seeded demo org, stores it via setToken(), and drops the visitor straight into
 * the app — no Clerk sign-up. Real organizers can head to /sign-in instead.
 */
export function DemoLanding() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function enterDemo() {
    setError(null)
    setLoading(true)
    try {
      const token = await fetchDemoToken()
      setToken(token)
      navigate('/dashboard', { replace: true })
    } catch {
      setError("Couldn't start the demo. Give it a moment and try again.")
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-3xl">
        <div className="flex flex-col items-center text-center">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">
              d
            </div>
            <span className="text-xl font-semibold tracking-tight text-foreground">dais</span>
          </div>

          <h1 className="mt-8 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Conference speaker management, end to end
          </h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">
            Open-source conference speaker management — from call for papers to a scheduled,
            onboarded program.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3">
            <Button size="lg" onClick={enterDemo} disabled={loading}>
              {loading ? 'Starting the demo…' : 'Enter the demo workspace'}
              {!loading && <ArrowRight className="h-4 w-4" />}
            </Button>
            <p className="text-xs text-muted-foreground">
              No sign-up — jump into a fully seeded workspace.
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-lg border border-border bg-card p-5 text-left shadow-soft"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-subtle text-primary">
                <Icon className="h-[18px] w-[18px]" />
              </div>
              <h2 className="mt-3 text-sm font-semibold text-foreground">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 text-center">
          <button
            type="button"
            onClick={() => navigate('/sign-in')}
            className="text-sm text-primary underline underline-offset-4 hover:text-primary-strong"
          >
            Sign in with your own account
          </button>
        </div>
      </div>
    </div>
  )
}
