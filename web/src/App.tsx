import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { peekToken, subscribeToken } from '@/lib/api'
import { CLERK_ENABLED, ClerkRequireAuth, SignInPage, SignUpPage } from '@/auth/clerk'
import { AppShell } from '@/shell/AppShell'
import { Agenda } from '@/pages/Agenda'
import { Comms } from '@/pages/Comms'
import { Dashboard } from '@/pages/Dashboard'
import { DevLogin } from '@/pages/DevLogin'
import { Evaluation } from '@/pages/Evaluation'
import { FormEditor } from '@/pages/FormEditor'
import { Forms } from '@/pages/Forms'
import { Inbox } from '@/pages/Inbox'
import { Onboarding } from '@/pages/Onboarding'
import { Portal } from '@/pages/Portal'
import { PublicForm } from '@/pages/PublicForm'
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
function RequireToken({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [hasToken, setHasToken] = useState(() => Boolean(peekToken()))

  useEffect(() => subscribeToken(() => setHasToken(Boolean(peekToken()))), [])

  if (!hasToken) return <Navigate to="/dev-login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

/** Clerk when configured, dev-token flow otherwise. */
function RequireAuth({ children }: { children: ReactNode }) {
  if (CLERK_ENABLED) return <ClerkRequireAuth>{children}</ClerkRequireAuth>
  return <RequireToken>{children}</RequireToken>
}

export default function App() {
  return (
    <>
      <Routes>
        {/* Public, unauthenticated surfaces. */}
        <Route path="/dev-login" element={<DevLogin />} />
        <Route path="/submit/:slug" element={<PublicForm />} />
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
          <Route index element={<Navigate to="/submissions" replace />} />
          <Route path="/submissions" element={<Inbox />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/forms" element={<Forms />} />
          <Route path="/forms/:formId" element={<FormEditor />} />
          <Route path="/evaluation" element={<Evaluation />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/speakers" element={<Speakers />} />
          <Route path="/comms" element={<Comms />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* First run: no event yet. Forms/Settings redirect here. */}
          <Route path="/onboarding" element={<Onboarding />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
