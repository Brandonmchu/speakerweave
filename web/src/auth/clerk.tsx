import { useEffect, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import {
  ClerkProvider,
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  useAuth,
  useOrganization,
  useUser,
} from '@clerk/clerk-react'

import { registerClerkTokenGetter } from '@/lib/api'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

/** Clerk is opt-in by env — absent key means the dev-token flow stays active. */
export const CLERK_ENABLED = Boolean(PUBLISHABLE_KEY)

export interface AuthUserIdentity {
  id: string
  name: string
  workspace: string
}

/** Reads the active Clerk user and organization without adding a shell query. */
export function ClerkUserIdentity({
  children,
}: {
  children: (identity: AuthUserIdentity) => ReactNode
}) {
  const { user } = useUser()
  const { organization } = useOrganization()
  const email = user?.primaryEmailAddress?.emailAddress
  return children({
    id: user?.id ?? 'organizer',
    name: user?.fullName || user?.firstName || email?.split('@')[0] || 'Organizer',
    workspace: organization?.name || 'Workspace',
  })
}

/**
 * Registers Clerk's token minting into the API client. The `supabase` JWT
 * template (HS256, signed with the backend's SUPABASE_JWT_SECRET, claims
 * aud=authenticated + org_id) is what the backend verifies — Clerk's default
 * session token will NOT work.
 */
function ClerkTokenBridge() {
  const { getToken } = useAuth()
  useEffect(() => {
    registerClerkTokenGetter(() => getToken({ template: 'supabase' }))
    return () => registerClerkTokenGetter(null)
  }, [getToken])
  return null
}

export function MaybeClerkProvider({ children }: { children: ReactNode }) {
  if (!CLERK_ENABLED) return <>{children}</>
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY!} signInUrl="/sign-in" signUpUrl="/sign-up">
      <ClerkTokenBridge />
      {children}
    </ClerkProvider>
  )
}

/**
 * Admin-surface gate for Clerk mode; the dev-token guard covers the fallback.
 *
 * `unauthedRedirect` lets a route send signed-out visitors to a public page
 * (e.g. the alias paths /agenda, /speakers point guests at the public program)
 * instead of Clerk's sign-in flow.
 */
export function ClerkRequireAuth({
  children,
  unauthedRedirect,
}: {
  children: ReactNode
  unauthedRedirect?: string
}) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        {unauthedRedirect ? <Navigate to={unauthedRedirect} replace /> : <RedirectToSignIn />}
      </SignedOut>
    </>
  )
}

/**
 * Render `authed` for a signed-in Clerk session, `unauthed` otherwise. Used by
 * the Home route to decide app-vs-landing when Clerk is on but there's no local
 * demo token. Only mount this inside a Clerk-enabled tree.
 */
export function ClerkSignedInSwitch({
  authed,
  unauthed,
}: {
  authed: ReactNode
  unauthed: ReactNode
}) {
  return (
    <>
      <SignedIn>{authed}</SignedIn>
      <SignedOut>{unauthed}</SignedOut>
    </>
  )
}

function AuthPageShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">{children}</div>
}

export function SignInPage() {
  return (
    <AuthPageShell>
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </AuthPageShell>
  )
}

export function SignUpPage() {
  return (
    <AuthPageShell>
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
    </AuthPageShell>
  )
}
