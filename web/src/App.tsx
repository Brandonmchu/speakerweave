import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'

import { peekToken, subscribeToken } from '@/lib/api'
import { featuredScheduleUrl, featuredSpeakersUrl } from '@/lib/featuredEvent'
import {
  CLERK_ENABLED,
  ClerkRequireAuth,
  ClerkSignedInSwitch,
  SignInPage,
  SignUpPage,
} from '@/auth/clerk'
import { AppShell } from '@/shell/AppShell'
import { Agenda } from '@/pages/Agenda'
import { ApiDocs } from '@/pages/ApiDocs'
import { Comms } from '@/pages/Comms'
import { ContentLibrary } from '@/pages/ContentLibrary'
import { Dashboard } from '@/pages/Dashboard'
import { DevLogin } from '@/pages/DevLogin'
import { Home } from '@/pages/Home'
import { Evaluation } from '@/pages/Evaluation'
import { FormEditor } from '@/pages/FormEditor'
import { Forms } from '@/pages/Forms'
import { Inbox } from '@/pages/Inbox'
import { Onboarding } from '@/pages/Onboarding'
import { Portal } from '@/pages/Portal'
import { PublicForm } from '@/pages/PublicForm'
import { SubmitterDashboard } from '@/pages/SubmitterDashboard'
import { PublicSchedule } from '@/pages/PublicSchedule'
import { PublicSpeakers } from '@/pages/PublicSpeakers'
import { Review } from '@/pages/Review'
import { SettingsPage } from '@/pages/SettingsPage'
import { Speakers } from '@/pages/Speakers'
import { Toaster } from '@/ui/toaster'

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
    return <ClerkSignedInSwitch authed={<Navigate to="/submissions" replace />} unauthed={<Home />} />
  }
  return <Home />
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
        <Route path="/dev-login" element={<DevLogin />} />
        <Route path="/submit/:slug" element={<PublicForm />} />
        {/* Submitter self-service: magic-link, token in the query, no Clerk. */}
        <Route path="/submit/:slug/manage" element={<SubmitterDashboard />} />
        {/* /demo is the one-click demo entrance — always the landing, even when
            already signed in, so re-entering the demo stays possible. */}
        <Route path="/demo" element={<Home />} />
        <Route path="/developers" element={<ApiDocs />} />
        <Route path="/e/:slug/schedule" element={<PublicSchedule />} />
        <Route path="/e/:slug/speakers" element={<PublicSpeakers />} />

        {/* Guessable public aliases → the featured event's program. These give a
            blind agent (or an attendee) crawlable, no-auth entry to the public
            pages whose slug isn't obvious. */}
        <Route path="/schedule" element={<Navigate to={featuredScheduleUrl} replace />} />
        <Route path="/sessions" element={<Navigate to={featuredScheduleUrl} replace />} />
        <Route path="/itinerary" element={<Navigate to={featuredScheduleUrl} replace />} />
        <Route path="/gallery" element={<Navigate to={featuredSpeakersUrl} replace />} />
        <Route path="/e/:slug" element={<EventScheduleRedirect />} />

        {/* Magic-link surfaces: redeem the token, then run cookie-only. */}
        <Route path="/portal/:token" element={<Portal />} />
        <Route path="/portal" element={<Portal />} />
        <Route path="/review/:token" element={<Review />} />
        <Route path="/review" element={<Review />} />
        {CLERK_ENABLED && (
          <>
            <Route path="/sign-in/*" element={<SignInPage />} />
            <Route path="/sign-up/*" element={<SignUpPage />} />
          </>
        )}

        {/* Organizer app. */}
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/submissions" element={<Inbox />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/content" element={<ContentLibrary />} />
          <Route path="/forms" element={<Forms />} />
          <Route path="/forms/:formId" element={<FormEditor />} />
          <Route path="/evaluation" element={<Evaluation />} />
          <Route path="/comms" element={<Comms />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* First run: no event yet. Forms/Settings redirect here. */}
          <Route path="/onboarding" element={<Onboarding />} />
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
          <Route path="/agenda" element={<Agenda />} />
        </Route>
        <Route
          element={
            <RequireAuth unauthedRedirect={featuredSpeakersUrl}>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/speakers" element={<Speakers />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
