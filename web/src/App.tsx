import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'

import { peekToken, subscribeToken } from '@/lib/api'
import { featuredScheduleUrl, featuredSpeakersUrl } from '@/lib/featuredEvent'
import {
  loadAgenda,
  loadApiDocs,
  loadChooseWorkspace,
  loadKillMySaas,
  loadOpenSource,
  loadComms,
  loadContentLibrary,
  loadDashboard,
  loadDevLogin,
  loadDirectory,
  loadEvaluation,
  loadFormEditor,
  loadForms,
  loadInbox,
  loadOnboarding,
  loadPipeline,
  loadPortal,
  loadPortalChoose,
  loadPublicForm,
  loadPublicSchedule,
  loadPublicSpeakers,
  loadReview,
  loadSettings,
  loadSpeakerSignin,
  loadSpeakers,
  loadSubmitterDashboard,
} from '@/lib/routeLoaders'
import {
  CLERK_ENABLED,
  ClerkRequireAuth,
  ClerkSignedInSwitch,
  SignInPage,
  SignUpPage,
} from '@/auth/clerk'
import { AppShell } from '@/shell/AppShell'
import { Home } from '@/pages/Home'
import { Toaster } from '@/ui/toaster'

const LazyAgenda = lazy(() => loadAgenda().then(({ Agenda }) => ({ default: Agenda })))
const LazyApiDocs = lazy(() => loadApiDocs().then(({ ApiDocs }) => ({ default: ApiDocs })))
const LazyChooseWorkspace = lazy(() =>
  loadChooseWorkspace().then(({ ChooseWorkspace }) => ({ default: ChooseWorkspace })),
)
const LazyKillMySaas = lazy(() =>
  loadKillMySaas().then(({ KillMySaas }) => ({ default: KillMySaas })),
)
const LazyOpenSource = lazy(() =>
  loadOpenSource().then(({ OpenSource }) => ({ default: OpenSource })),
)
const LazyComms = lazy(() => loadComms().then(({ Comms }) => ({ default: Comms })))
const LazyContentLibrary = lazy(() =>
  loadContentLibrary().then(({ ContentLibrary }) => ({ default: ContentLibrary })),
)
const LazyDashboard = lazy(() =>
  loadDashboard().then(({ Dashboard }) => ({ default: Dashboard })),
)
const LazyDevLogin = lazy(() =>
  loadDevLogin().then(({ DevLogin }) => ({ default: DevLogin })),
)
const LazyDirectory = lazy(() =>
  loadDirectory().then(({ Directory }) => ({ default: Directory })),
)
const LazyEvaluation = lazy(() =>
  loadEvaluation().then(({ Evaluation }) => ({ default: Evaluation })),
)
const LazyInbox = lazy(() => loadInbox().then(({ Inbox }) => ({ default: Inbox })))
const LazyFormEditor = lazy(() =>
  loadFormEditor().then(({ FormEditor }) => ({ default: FormEditor })),
)
const LazyForms = lazy(() => loadForms().then(({ Forms }) => ({ default: Forms })))
const LazyOnboarding = lazy(() =>
  loadOnboarding().then(({ Onboarding }) => ({ default: Onboarding })),
)
const LazyPipeline = lazy(() =>
  loadPipeline().then(({ Pipeline }) => ({ default: Pipeline })),
)
const LazyPortal = lazy(() => loadPortal().then(({ Portal }) => ({ default: Portal })))
const LazyPortalChoose = lazy(() =>
  loadPortalChoose().then(({ PortalChoose }) => ({ default: PortalChoose })),
)
const LazyPublicForm = lazy(() =>
  loadPublicForm().then(({ PublicForm }) => ({ default: PublicForm })),
)
const LazyPublicSchedule = lazy(() =>
  loadPublicSchedule().then(({ PublicSchedule }) => ({ default: PublicSchedule })),
)
const LazyPublicSpeakers = lazy(() =>
  loadPublicSpeakers().then(({ PublicSpeakers }) => ({ default: PublicSpeakers })),
)
const LazyReview = lazy(() => loadReview().then(({ Review }) => ({ default: Review })))
const LazySettingsPage = lazy(() =>
  loadSettings().then(({ SettingsPage }) => ({ default: SettingsPage })),
)
const LazySpeakerSignin = lazy(() =>
  loadSpeakerSignin().then(({ SpeakerSignin }) => ({ default: SpeakerSignin })),
)
const LazySpeakers = lazy(() =>
  loadSpeakers().then(({ Speakers }) => ({ default: Speakers })),
)
const LazySubmitterDashboard = lazy(() =>
  loadSubmitterDashboard().then(({ SubmitterDashboard }) => ({ default: SubmitterDashboard })),
)

function PageSkeleton({ fullPage = false }: { fullPage?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading page"
      className={fullPage ? 'min-h-screen bg-background px-5 py-16 sm:px-8' : 'px-4 py-6 md:px-8'}
    >
      <div className="mx-auto w-full max-w-7xl animate-pulse" aria-hidden="true">
        <div className="h-7 w-44 rounded-md bg-muted" />
        <div className="mt-3 h-4 w-72 max-w-full rounded bg-muted" />
        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          <div className="h-24 rounded-lg bg-muted" />
          <div className="h-24 rounded-lg bg-muted" />
          <div className="h-24 rounded-lg bg-muted" />
        </div>
        <div className="mt-6 h-64 rounded-lg bg-muted" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  )
}

function DeferredPage({ children, fullPage = false }: { children: ReactNode; fullPage?: boolean }) {
  return (
    <Suspense fallback={<PageSkeleton fullPage={fullPage} />}>
      {children}
    </Suspense>
  )
}

function PublicHome() {
  return <Home />
}

/**
 * /demo is linked from the judge page and the docs as "one click into the
 * seeded workspace" — so it must actually enter, not land on the marketing
 * page and ask for a second click. Mint the demo token on mount and go.
 */
function DemoEntry() {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { fetchDemoToken } = await import('@/lib/demoApi')
        const { setToken } = await import('@/lib/api')
        const token = await fetchDemoToken()
        if (cancelled) return
        setToken(token)
        window.location.replace('/dashboard')
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  if (failed) return <Home />
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Starting the demo workspace…
    </div>
  )
}

/**
 * Gate for the admin surface. Today it only checks that a dev token exists —
 * the backend is the real authority and 401s anything invalid (which clears the
 * token in lib/api.ts, re-running this guard). Swapping in Clerk means
 * replacing the body with `<SignedIn>/<RedirectToSignIn>`.
 */
function RequireToken({
  children,
  redirectTo = '/dev-login',
}: {
  children: ReactNode
  redirectTo?: string
}) {
  const location = useLocation()
  const [hasToken, setHasToken] = useState(() => Boolean(peekToken()))

  useEffect(() => subscribeToken(() => setHasToken(Boolean(peekToken()))), [])

  if (!hasToken) return <Navigate to={redirectTo} replace state={{ from: location.pathname }} />
  return <>{children}</>
}

/**
 * Clerk when configured, dev-token flow otherwise. A dev/demo token in
 * localStorage always wins, so the one-click demo works even under Clerk.
 *
 * `unauthedRedirect` overrides where a signed-out visitor lands (default is the
 * Clerk sign-in / dev-login). The alias routes /agenda and /speakers use it to
 * send guests to the public program instead of the auth wall.
 */
function RequireAuth({
  children,
  unauthedRedirect,
}: {
  children: ReactNode
  unauthedRedirect?: string
}) {
  if (CLERK_ENABLED && !peekToken()) {
    return <ClerkRequireAuth unauthedRedirect={unauthedRedirect}>{children}</ClerkRequireAuth>
  }
  return <RequireToken redirectTo={unauthedRedirect}>{children}</RequireToken>
}

/**
 * The `/` entry point. A demo/dev token (or, under Clerk, a signed-in session)
 * means an organizer — send them to the app. Everyone else gets the public
 * landing. Crucially this never force-redirects to Clerk, so a cold visitor
 * (or a blind eval agent) always sees a real, clickable page.
 */
function HomeEntry() {
  if (peekToken()) return <Navigate to="/submissions" replace />
  if (CLERK_ENABLED) {
    return (
      <ClerkSignedInSwitch
        authed={<Navigate to="/submissions" replace />}
        unauthed={<PublicHome />}
      />
    )
  }
  return <PublicHome />
}

/** Bare /e/:slug → that event's public schedule. */
function EventScheduleRedirect() {
  const { slug = '' } = useParams()
  return <Navigate to={`/e/${slug}/schedule`} replace />
}

export default function App() {
  return (
    <>
      <Routes>
        {/* Home: public landing for guests, straight into the app for organizers. */}
        <Route path="/" element={<HomeEntry />} />

        {/* Public, unauthenticated surfaces. */}
        <Route path="/dev-login" element={<DeferredPage fullPage><LazyDevLogin /></DeferredPage>} />
        <Route path="/submit/:slug" element={<DeferredPage fullPage><LazyPublicForm /></DeferredPage>} />
        <Route path="/speaker-signin" element={<DeferredPage fullPage><LazySpeakerSignin /></DeferredPage>} />
        {/* Submitter self-service: magic-link, token in the query, no Clerk. */}
        <Route path="/submit/:slug/manage" element={<DeferredPage fullPage><LazySubmitterDashboard /></DeferredPage>} />
        {/* /demo is the one-click demo entrance: mint the demo token and land
            in the workspace directly (falls back to the landing on failure). */}
        <Route path="/demo" element={<DemoEntry />} />
        <Route
          path="/developers"
          element={
            <DeferredPage fullPage>
              <LazyApiDocs />
            </DeferredPage>
          }
        />
        <Route
          path="/open-source"
          element={
            <DeferredPage fullPage>
              <LazyOpenSource />
            </DeferredPage>
          }
        />
        <Route
          path="/killmysaas"
          element={
            <DeferredPage fullPage>
              <LazyKillMySaas />
            </DeferredPage>
          }
        />
        <Route path="/e/:slug/schedule" element={<DeferredPage fullPage><LazyPublicSchedule /></DeferredPage>} />
        <Route path="/e/:slug/speakers" element={<DeferredPage fullPage><LazyPublicSpeakers /></DeferredPage>} />

        {/* Guessable public aliases → the featured event's program. These give a
            blind agent (or an attendee) crawlable, no-auth entry to the public
            pages whose slug isn't obvious. */}
        <Route path="/schedule" element={<Navigate to={featuredScheduleUrl} replace />} />
        <Route path="/sessions" element={<Navigate to={featuredScheduleUrl} replace />} />
        <Route path="/itinerary" element={<Navigate to={featuredScheduleUrl} replace />} />
        <Route path="/gallery" element={<Navigate to={featuredSpeakersUrl} replace />} />
        <Route path="/e/:slug" element={<EventScheduleRedirect />} />

        {/* Guessable CRM aliases. Someone looking for the speaker database will
            type one of these before they find /directory; each lands on the
            real thing rather than bouncing to the submissions inbox. */}
        <Route path="/crm" element={<Navigate to="/directory" replace />} />
        <Route path="/contacts" element={<Navigate to="/directory" replace />} />
        <Route path="/people" element={<Navigate to="/directory" replace />} />
        <Route path="/speaker-database" element={<Navigate to="/directory" replace />} />
        <Route path="/sourcing" element={<Navigate to="/pipeline" replace />} />
        <Route path="/prospects" element={<Navigate to="/pipeline" replace />} />

        {/* Magic-link surfaces: redeem the token, then run cookie-only.
            /portal/choose is declared first so it can never be swallowed by the
            :token pattern — a speaker whose link covers several conferences
            picks one here before the portal session cookie exists. */}
        <Route path="/portal/choose" element={<DeferredPage fullPage><LazyPortalChoose /></DeferredPage>} />
        <Route path="/portal/:token" element={<DeferredPage fullPage><LazyPortal /></DeferredPage>} />
        <Route path="/portal" element={<DeferredPage fullPage><LazyPortal /></DeferredPage>} />
        <Route path="/review/:token" element={<DeferredPage fullPage><LazyReview /></DeferredPage>} />
        <Route path="/review" element={<DeferredPage fullPage><LazyReview /></DeferredPage>} />
        {CLERK_ENABLED && (
          <>
            <Route path="/sign-in/*" element={<SignInPage />} />
            <Route path="/sign-up/*" element={<SignUpPage />} />
          </>
        )}

        {/* Workspace picker: authed, but outside the shell — you can't draw the
            rail before you know which org it belongs to. It redirects straight
            through for anyone with a single membership, so no organizer ever
            pays a click for a choice they don't have. */}
        <Route
          path="/choose-workspace"
          element={
            <RequireAuth>
              <DeferredPage fullPage>
                <LazyChooseWorkspace />
              </DeferredPage>
            </RequireAuth>
          }
        />

        {/* Organizer app. */}
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route
            path="/submissions"
            element={
              <DeferredPage>
                <LazyInbox />
              </DeferredPage>
            }
          />
          <Route path="/dashboard" element={<DeferredPage><LazyDashboard /></DeferredPage>} />
          <Route
            path="/content"
            element={
              <DeferredPage>
                <LazyContentLibrary />
              </DeferredPage>
            }
          />
          <Route path="/forms" element={<DeferredPage><LazyForms /></DeferredPage>} />
          <Route path="/forms/:formId" element={<DeferredPage><LazyFormEditor /></DeferredPage>} />
          <Route
            path="/evaluation"
            element={
              <DeferredPage>
                <LazyEvaluation />
              </DeferredPage>
            }
          />
          <Route path="/comms" element={<DeferredPage><LazyComms /></DeferredPage>} />
          {/* Org-level CRM: above events, not inside one. */}
          <Route
            path="/directory"
            element={
              <DeferredPage>
                <LazyDirectory />
              </DeferredPage>
            }
          />
          <Route
            path="/pipeline"
            element={
              <DeferredPage>
                <LazyPipeline />
              </DeferredPage>
            }
          />
          <Route
            path="/settings"
            element={
              <DeferredPage>
                <LazySettingsPage />
              </DeferredPage>
            }
          />
          {/* First run: no event yet. Forms/Settings redirect here. */}
          <Route path="/onboarding" element={<DeferredPage><LazyOnboarding /></DeferredPage>} />
        </Route>

        {/* /agenda and /speakers double as public aliases: an authed organizer
            gets the builder; a signed-out guesser is sent to the public program
            (not the auth wall). Separate layout routes keep each path unique. */}
        <Route
          element={
            <RequireAuth unauthedRedirect={featuredScheduleUrl}>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route
            path="/agenda"
            element={
              <DeferredPage>
                <LazyAgenda />
              </DeferredPage>
            }
          />
        </Route>
        <Route
          element={
            <RequireAuth unauthedRedirect={featuredSpeakersUrl}>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route
            path="/speakers"
            element={
              <DeferredPage>
                <LazySpeakers />
              </DeferredPage>
            }
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
