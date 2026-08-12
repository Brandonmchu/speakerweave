/**
 * The speaker's conference picker (`/portal/choose?token=…`).
 *
 * A speaker is a person, not a row on one event — the same human can be on
 * several conferences run by different organizations. The emailed link lands
 * here holding a token that covers all of them; choosing one exchanges it for
 * the portal session cookie and the existing speaker portal takes over.
 *
 * Every failure mode ends at "request a new link" rather than a dead end: an
 * expired token is the single most likely thing to happen to an emailed URL.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight, CalendarDays, Mail } from 'lucide-react'

import { choosePortalConference, getPortalChoices, type PortalChoice } from '@/lib/api'
import { BrandMark } from '@/ui/brand'
import { Button } from '@/ui/button'
import { Skeleton } from '@/ui/skeleton'

/** Where a chosen conference drops the speaker — the cookie-only portal. */
const PORTAL_HOME = '/portal'

function formatEventDates(choice: PortalChoice): string {
  if (!choice.starts_at) return 'Dates to be confirmed'
  const start = new Date(choice.starts_at)
  if (Number.isNaN(start.getTime())) return 'Dates to be confirmed'
  const end = choice.ends_at ? new Date(choice.ends_at) : null
  const full: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  if (!end || Number.isNaN(end.getTime()) || start.toDateString() === end.toDateString()) {
    return start.toLocaleDateString(undefined, full)
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, full)}`
}

/** Conferences in the order they arrived, gathered under their organization. */
function groupByOrganization(choices: PortalChoice[]): Array<{
  orgId: string
  orgName: string
  conferences: PortalChoice[]
}> {
  const groups: Array<{ orgId: string; orgName: string; conferences: PortalChoice[] }> = []
  for (const choice of choices) {
    const existing = groups.find((group) => group.orgId === choice.org_id)
    if (existing) existing.conferences.push(choice)
    else groups.push({ orgId: choice.org_id, orgName: choice.org_name, conferences: [choice] })
  }
  return groups
}

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-lg px-5 py-10 sm:py-16">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground"
        >
          <BrandMark className="h-7 w-7" />
          SpeakerWeave
        </Link>
        <main className="rounded-2xl bg-card p-6 shadow-raised sm:p-8">{children}</main>
      </div>
    </div>
  )
}

/** The one recovery path this page ever offers — a fresh link, same as page one. */
function RequestNewLink({ title, description }: { title: string; description: string }) {
  return (
    <>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-subtle text-primary">
        <Mail className="h-5 w-5" />
      </div>
      <h1 className="page-title mt-5">{title}</h1>
      <p className="page-subtitle">{description}</p>
      <Button asChild className="mt-5">
        <Link to="/speaker-signin">
          Request a new link
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </>
  )
}

export function PortalChoose() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const autoChosen = useRef(false)

  const choicesQuery = useQuery({
    queryKey: ['portal-choices', token],
    queryFn: () => getPortalChoices(token),
    enabled: Boolean(token),
    retry: false,
  })

  const choose = useMutation({
    mutationFn: (contactId: string) => choosePortalConference(token, contactId),
    onSuccess: () => navigate(PORTAL_HOME, { replace: true }),
  })

  const choices = choicesQuery.data?.choices ?? []
  const chooseMutate = choose.mutate
  // A plain string, so the effect below settles instead of re-firing on every
  // render the way a freshly-defaulted `choices` array would.
  const soleContactId = choices.length === 1 ? choices[0].contact_id : null

  // Exactly one conference is not a choice. Redeem it and go — nobody should be
  // asked to pick from a list of one.
  useEffect(() => {
    if (autoChosen.current || !soleContactId) return
    autoChosen.current = true
    chooseMutate(soleContactId)
  }, [soleContactId, chooseMutate])

  if (!token) {
    return (
      <PageFrame>
        <RequestNewLink
          title="This sign-in link is incomplete"
          description="The link is missing its token — email clients sometimes truncate long URLs. Ask for a fresh one and it will work."
        />
      </PageFrame>
    )
  }

  if (choicesQuery.isPending) {
    return (
      <PageFrame>
        <div role="status" aria-label="Loading your conferences">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="mt-3 h-4 w-72 max-w-full" />
          <div className="mt-6 space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
          <span className="sr-only">Loading your conferences…</span>
        </div>
      </PageFrame>
    )
  }

  if (choicesQuery.isError) {
    return (
      <PageFrame>
        <RequestNewLink
          title="This sign-in link has expired"
          description="Sign-in links are single-use and short-lived. Enter your email again and we'll send a new one."
        />
      </PageFrame>
    )
  }

  if (choices.length === 0) {
    return (
      <PageFrame>
        <RequestNewLink
          title="Nothing to open yet"
          description="This link isn't attached to any conference right now. If you expected one, ask the organizer to confirm the email address they have for you."
        />
      </PageFrame>
    )
  }

  // Auto-selecting the only conference — and the moment after any pick.
  if (choices.length === 1 || choose.isPending) {
    return (
      <PageFrame>
        <div role="status" className="py-6 text-center text-sm text-muted-foreground">
          {choose.isError ? 'Something went wrong opening your portal.' : 'Opening your speaker portal…'}
        </div>
        {choose.isError && (
          <div className="text-center">
            <Button variant="secondary" onClick={() => chooseMutate(choices[0].contact_id)}>
              Try again
            </Button>
          </div>
        )}
      </PageFrame>
    )
  }

  const email = choicesQuery.data?.email
  const groups = groupByOrganization(choices)

  return (
    <PageFrame>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-subtle text-primary">
        <CalendarDays className="h-5 w-5" />
      </div>
      <h1 className="page-title mt-5">Choose a conference</h1>
      <p className="page-subtitle">
        {email ? (
          <>
            You&rsquo;re speaking at more than one event as{' '}
            <span className="font-mono text-foreground">{email}</span>. Pick the one you want to
            open.
          </>
        ) : (
          <>You&rsquo;re speaking at more than one event. Pick the one you want to open.</>
        )}
      </p>

      <div className="mt-6 space-y-5">
        {groups.map((group) => (
          <div key={group.orgId}>
            <div className="section-label px-1 pb-1.5">{group.orgName}</div>
            <div>
              {group.conferences.map((choice) => (
                <button
                  key={choice.contact_id}
                  type="button"
                  disabled={choose.isPending}
                  onClick={() => chooseMutate(choice.contact_id)}
                  className="group flex w-full items-center gap-3 border-t border-border px-1 py-3 text-left transition-colors first:border-t-0 hover:bg-foreground/[0.028] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium leading-5 text-foreground">
                      {choice.event_name}
                    </span>
                    <span className="block truncate text-[11.5px] leading-4 text-muted-foreground">
                      {formatEventDates(choice)}
                    </span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-placeholder transition-colors group-hover:text-primary" />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Link
        to="/speaker-signin"
        className="mt-6 inline-block text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        Not you? Sign in with a different email
      </Link>
    </PageFrame>
  )
}
