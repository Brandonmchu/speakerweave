import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Sparkles } from 'lucide-react'

import { apiGet, unwrapList, type EventSummary } from '@/lib/api'
import { createEvent } from '@/lib/adminApi'
import { fromDateInput, localTimezone, timezoneOptions } from '@/lib/eventDateTime'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { NativeSelect } from '@/ui/native-select'
import { Skeleton } from '@/ui/skeleton'
import { toast } from '@/ui/use-toast'

/**
 * First run for a brand-new org. Everything else in the app hangs off an event,
 * so /forms and /settings bounce here until one exists — and this page bounces
 * back the moment it does, which keeps the redirect from looping.
 */
export function Onboarding() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [timezone, setTimezone] = useState(() => localTimezone())
  const [location, setLocation] = useState('')

  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<EventSummary[]>('/api/events').then(unwrapList),
  })

  const create = useMutation({
    mutationFn: () =>
      createEvent({
        name: name.trim(),
        timezone: timezone || null,
        starts_at: fromDateInput(startsAt),
        ends_at: fromDateInput(endsAt),
        location: location.trim() || null,
      }),
    onSuccess: async (event) => {
      await queryClient.invalidateQueries({ queryKey: ['events'] })
      toast({ title: 'Event created', description: `${event?.name ?? name} is ready.` })
      navigate('/submissions', { replace: true })
    },
    onError: (error: Error) =>
      toast({ variant: 'destructive', title: "Couldn't create your event", description: error.message }),
  })

  if (eventsQuery.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-3 px-4 py-16">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // Already onboarded (or landed here by hand) — nothing to do.
  if (!create.isPending && !create.isSuccess && (eventsQuery.data?.length ?? 0) > 0) {
    return <Navigate to="/submissions" replace />
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-subtle text-primary">
            <Sparkles className="h-6 w-6" />
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
            Create your event
          </h1>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            Everything in dais — forms, submissions, the agenda — hangs off one event. You can change
            all of this later in Settings.
          </p>
        </div>

        <form
          className="mt-6 space-y-5 rounded-lg bg-card p-6 shadow-raised"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="onboarding-name" required>
              Event name
            </Label>
            <Input
              id="onboarding-name"
              autoFocus
              value={name}
              placeholder="AI Engineer Summit 2026"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="onboarding-start">Starts</Label>
              <Input
                id="onboarding-start"
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="onboarding-end">Ends</Label>
              <Input
                id="onboarding-end"
                type="date"
                value={endsAt}
                min={startsAt || undefined}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="onboarding-timezone">Timezone</Label>
              <NativeSelect
                id="onboarding-timezone"
                value={timezone}
                onValueChange={setTimezone}
                options={timezoneOptions(timezone).map((tz) => ({ value: tz, label: tz }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="onboarding-location">Location</Label>
              <Input
                id="onboarding-location"
                value={location}
                placeholder="San Francisco, CA"
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={!name.trim() || create.isPending}>
            <CalendarDays className="h-4 w-4" />
            {create.isPending ? 'Creating…' : 'Create event'}
          </Button>
        </form>
      </div>
    </div>
  )
}
