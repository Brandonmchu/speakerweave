/**
 * The organizer workspace picker (`/choose-workspace`).
 *
 * Shown only to someone who genuinely has a choice to make. An organizer with a
 * single membership never sees this screen: the route resolves their one org
 * and redirects, so the number of clicks between signing in and working is
 * unchanged for them — which is exactly what the /demo one-click path depends
 * on. A backend that can't answer redirects too, for the same reason.
 */

import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate, useNavigate } from 'react-router-dom'
import { ArrowRight, Building2 } from 'lucide-react'

import {
  listMyOrganizations,
  organizationKeys,
  setToken,
  switchOrganization,
  type OrganizationMembership,
} from '@/lib/api'
import { BrandMark } from '@/ui/brand'
import { Skeleton } from '@/ui/skeleton'
import { toast } from '@/ui/use-toast'

/** Where an organizer lands once a workspace is settled — the same door as always. */
const WORKSPACE_HOME = '/submissions'

function roleLabel(role: string): string {
  if (!role) return 'Member'
  return role.charAt(0).toUpperCase() + role.slice(1).replace(/[_-]+/g, ' ')
}

function eventsLabel(count: number): string {
  return `${count} ${count === 1 ? 'event' : 'events'}`
}

function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-lg px-5 py-10 sm:py-16">
        <div className="mb-6 inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
          <BrandMark className="h-7 w-7" />
          SpeakerWeave
        </div>
        <main className="rounded-2xl bg-card p-6 shadow-raised sm:p-8">{children}</main>
      </div>
    </div>
  )
}

function WorkspaceRow({
  organization,
  pending,
  disabled,
  onSelect,
}: {
  organization: OrganizationMembership
  pending: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="group flex w-full items-center gap-3 border-t border-border px-1 py-3 text-left transition-colors first:border-t-0 hover:bg-foreground/[0.028] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground/[0.055] font-mono text-[11px] font-semibold text-foreground">
        {(organization.name.trim().charAt(0) || '?').toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium leading-5 text-foreground">
          {organization.name}
        </span>
        <span className="block truncate text-[11.5px] leading-4 text-muted-foreground">
          {roleLabel(organization.role)}
          {' · '}
          <span className="font-mono">{eventsLabel(organization.events)}</span>
        </span>
      </span>
      {organization.is_current && (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden="true"
            className="inline-block h-[5px] w-[5px] rounded-full bg-primary"
          />
          Current
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {pending ? (
          'Opening…'
        ) : (
          <ArrowRight className="h-3.5 w-3.5 text-placeholder transition-colors group-hover:text-primary" />
        )}
      </span>
    </button>
  )
}

export function ChooseWorkspace() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null)

  const organizationsQuery = useQuery({
    queryKey: organizationKeys.mine,
    queryFn: listMyOrganizations,
    retry: false,
    staleTime: 30_000,
  })

  const choose = useMutation({
    mutationFn: (orgId: string) => switchOrganization(orgId),
    onMutate: (orgId: string) => {
      setPendingOrgId(orgId)
    },
    onSuccess: (token: string) => {
      setToken(token)
      // Everything cached belongs to the org we just left. Drop it rather than
      // let a stale event list flash under the new workspace's name.
      queryClient.removeQueries()
      navigate(WORKSPACE_HOME, { replace: true })
    },
    onError: (error: Error) => {
      setPendingOrgId(null)
      toast({
        variant: 'destructive',
        title: "Couldn't open that workspace",
        description: error.message,
      })
    },
  })

  if (organizationsQuery.isPending) {
    return (
      <PageFrame>
        <div role="status" aria-label="Loading workspaces">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="mt-3 h-4 w-64 max-w-full" />
          <div className="mt-6 space-y-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
          <span className="sr-only">Loading your workspaces…</span>
        </div>
      </PageFrame>
    )
  }

  const organizations = organizationsQuery.data ?? []

  // One membership is not a choice, and neither is a list we couldn't load.
  // Both go straight through to the app — this screen must never stand between
  // a single-org organizer and their work.
  if (organizations.length <= 1) return <Navigate to={WORKSPACE_HOME} replace />

  return (
    <PageFrame>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-subtle text-primary">
        <Building2 className="h-5 w-5" />
      </div>
      <h1 className="page-title mt-5">Choose a workspace</h1>
      <p className="page-subtitle">
        You organize for more than one company. Pick the one you want to work in — you can switch
        any time from your account menu.
      </p>

      <div className="mt-6">
        {organizations.map((organization) => (
          <WorkspaceRow
            key={organization.org_id}
            organization={organization}
            pending={pendingOrgId === organization.org_id}
            disabled={choose.isPending}
            onSelect={() => choose.mutate(organization.org_id)}
          />
        ))}
      </div>
    </PageFrame>
  )
}
