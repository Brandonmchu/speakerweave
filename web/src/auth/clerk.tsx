import { useEffect, type ReactNode } from 'react'
import {
  ClerkProvider,
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  SignIn,
  SignUp,
  useAuth,
} from '@clerk/clerk-react'

import { registerClerkTokenGetter } from '@/lib/api'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

/** Clerk is opt-in by env — absent key means the dev-token flow stays active. */
export const CLERK_ENABLED = Boolean(PUBLISHABLE_KEY)

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

/** Admin-surface gate for Clerk mode; the dev-token guard covers the fallback. */
export function ClerkRequireAuth({ children }: { children: ReactNode }) {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
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
