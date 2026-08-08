import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, KeyRound } from 'lucide-react'

import { peekToken, setToken } from '@/lib/api'
import { fetchDemoToken } from '@/lib/demoApi'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'

/**
 * Temporary sign-in: one-click into the seeded demo workspace, or paste a
 * locally minted dev JWT for a specific org.
 *
 * This whole page goes away when Clerk lands — the app only ever reads the
 * token through `getToken()` in lib/api.ts.
 */
export function DevLogin() {
  const navigate = useNavigate()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [demoLoading, setDemoLoading] = useState(false)
  const hasExistingToken = Boolean(peekToken())

  async function enterDemo() {
    setError(null)
    setDemoLoading(true)
    try {
      const token = await fetchDemoToken()
      setToken(token)
      navigate('/dashboard', { replace: true })
    } catch {
      setError("Couldn't start the demo. Give it a moment and try again.")
      setDemoLoading(false)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const token = value.trim()
    if (!token) {
      setError('Paste a token first.')
      return
    }
    setToken(token)
    navigate('/submissions', { replace: true })
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            d
          </div>
          <span className="text-lg font-semibold tracking-tight text-foreground">dais</span>
        </div>

        <div className="rounded-lg border border-border bg-card p-6 shadow-soft">
          <div className="mb-5">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Enter the demo workspace
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Jump straight into the fully seeded demo org — no token needed.
            </p>
            <Button type="button" onClick={enterDemo} disabled={demoLoading} className="mt-3 w-full">
              {demoLoading ? 'Starting the demo…' : 'Enter the demo workspace'}
              {!demoLoading && <ArrowRight className="h-4 w-4" />}
            </Button>
          </div>

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-card px-2 text-xs uppercase tracking-wider text-muted-foreground">
                or
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Developer sign-in</h1>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Paste an access token to work against the local API. Real organizer auth ships later.
          </p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dev-token" required>
                Access token
              </Label>
              <Input
                id="dev-token"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="eyJhbGciOiJIUzI1NiIs…"
                value={value}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setValue(e.target.value)
                  if (error) setError(null)
                }}
                className="font-mono text-sm"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <Button type="submit" className="w-full">
              Save token &amp; continue
            </Button>
          </form>

          <div className="mt-5 rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              Need one? Run{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                python api/scripts/mint_dev_token.py
              </code>{' '}
              in the repo root and paste the output here. It&rsquo;s stored in{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                localStorage["dais.token"]
              </code>
              .
            </p>
          </div>

          {hasExistingToken && (
            <button
              type="button"
              onClick={() => navigate('/submissions')}
              className="mt-4 text-sm text-primary underline underline-offset-4 hover:text-primary-strong"
            >
              Keep the token I already have
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
