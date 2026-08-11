import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeft, Mail } from 'lucide-react'

import { requestManageLink } from '@/lib/api'
import { CFP_FORM_SLUG } from '@/lib/featuredEvent'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Passwordless entry to the token-scoped speaker account. */
export function SpeakerSignin() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (value: string) => requestManageLink(CFP_FORM_SLUG, value),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = email.trim()
    if (!EMAIL_RE.test(trimmed)) {
      setError('Enter a valid email address')
      return
    }
    setError(null)
    mutation.mutate(trimmed)
  }

  return (
    <div className="min-h-screen bg-[#FBFBFB]">
      <div className="mx-auto w-full max-w-md px-5 py-10 sm:py-16">
        <Link
          to="/"
          className="mb-6 inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm text-primary-foreground">S</span>
          dais
        </Link>

        <main className="rounded-2xl border border-border bg-card p-6 shadow-[0_10px_30px_rgba(15,23,42,0.08)] sm:p-9">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-subtle text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
            Speaker sign in
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            No password needed — we email you a secure sign-in link.
          </p>

          {mutation.isSuccess ? (
            <div
              role="status"
              className="mt-6 rounded-lg border border-success/30 bg-success/5 px-4 py-3"
            >
              <p className="text-sm font-medium text-foreground">
                Check your email — we sent you a sign-in link
              </p>
            </div>
          ) : (
            <form onSubmit={submit} noValidate className="mt-6 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="speaker-signin-email">Email address</Label>
                <Input
                  id="speaker-signin-email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  placeholder="you@example.com"
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    if (error) setError(null)
                  }}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              {mutation.error && (
                <p className="text-sm text-destructive">{mutation.error.message}</p>
              )}
              <Button type="submit" className="w-full" disabled={mutation.isPending}>
                {mutation.isPending ? 'Sending sign-in link…' : 'Email me a sign-in link'}
              </Button>
            </form>
          )}

          <Link
            to="/"
            className="mt-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to dais
          </Link>
        </main>
      </div>
    </div>
  )
}
