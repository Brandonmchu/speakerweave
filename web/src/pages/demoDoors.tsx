/**
 * The three ways into the seeded demo workspace, and the state behind them.
 *
 * Shared by the landing page and `/judge` because they are the same doors: an
 * organizer session, and the real magic links a reviewer and a speaker would
 * have been emailed. Nothing here is a costume — each persona lands in the
 * surface that audience actually uses, with the permissions that come with it.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { setToken } from '@/lib/api'
import { fetchDemoEntry, fetchDemoToken, type DemoPersona } from '@/lib/demoApi'

/** What each door opens, named by the surfaces a judge can go and check. */
export const DEMO_ROLES: Array<{
  persona: DemoPersona
  label: string
  short: string
  detail: string
}> = [
  {
    persona: 'organizer',
    label: 'Organizer',
    short: 'Run the whole program',
    detail:
      'Forms and conditional logic, the submission queue, review rounds, decisions and emails, the agenda builder with live conflicts, the content matrix, comms, and the cross-event speaker CRM.',
  },
  {
    persona: 'reviewer',
    label: 'Reviewer',
    short: 'Score an open round',
    detail:
      'An assigned queue with six of ten reviews already done, the weighted rubric (relevance, originality, speaker, clarity), comments, and abstentions with reasons.',
  },
  {
    persona: 'speaker',
    label: 'Speaker',
    short: 'Your talk and content',
    detail:
      'Priya Raman’s portal: profile and headshot, two accepted sessions, a six-item onboarding checklist with due dates, versioned uploads and approval threads.',
  },
]

/**
 * Opening the demo, from anywhere on the site.
 *
 * The organizer stores a short-lived token and lands in the app; the other two
 * follow a minted magic link, because those surfaces genuinely authenticate by
 * link rather than by session.
 */
export function useDemoEntry() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function enterDemo() {
    if (loading) return
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

  async function enterAs(persona: DemoPersona) {
    if (persona === 'organizer') return enterDemo()
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const entry = await fetchDemoEntry(persona)
      if (entry.kind !== 'path') throw new Error('Unexpected demo entry')
      navigate(entry.path, { replace: true })
    } catch {
      setError("Couldn't open that view of the demo. Give it a moment and try again.")
      setLoading(false)
    }
  }

  return { loading, error, enterDemo, enterAs }
}

/**
 * The doors themselves. `detail` swaps the one-line labels for the full list of
 * surfaces behind each role — what `/judge` needs and a hero does not.
 */
export function DemoDoors({
  enterAs,
  loading,
  detail = false,
}: {
  enterAs: (persona: DemoPersona) => void
  loading: boolean
  detail?: boolean
}) {
  return (
    <div className={detail ? 'doors wide' : 'doors'} aria-label="Open the demo as">
      {DEMO_ROLES.map((role) => (
        <button
          key={role.persona}
          type="button"
          onClick={() => enterAs(role.persona)}
          disabled={loading}
        >
          <b>{role.label}</b>
          <span>{detail ? role.detail : role.short}</span>
        </button>
      ))}
    </div>
  )
}
