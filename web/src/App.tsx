import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { peekToken, subscribeToken } from '@/lib/api'
import { CLERK_ENABLED, ClerkRequireAuth, SignInPage, SignUpPage } from '@/auth/clerk'
import { AppShell } from '@/shell/AppShell'
import { Agenda } from '@/pages/Agenda'
import { ComingSoon } from '@/pages/ComingSoon'
import { DevLogin } from '@/pages/DevLogin'
import { Inbox } from '@/pages/Inbox'
import { PublicForm } from '@/pages/PublicForm'
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
          <Route path="/dashboard" element={<ComingSoon title="Dashboard" />} />
          <Route path="/forms" element={<ComingSoon title="Forms" />} />
          <Route path="/evaluation" element={<ComingSoon title="Evaluation" />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/speakers" element={<ComingSoon title="Speakers" />} />
          <Route path="/comms" element={<ComingSoon title="Comms" />} />
          <Route path="/settings" element={<ComingSoon title="Settings" />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
