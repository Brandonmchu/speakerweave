import { Card, CardContent, CardHeader, Skeleton } from 'dais-web'

export const SubmissionsLoading = () => (
  <div className="w-full max-w-2xl border border-border rounded-lg bg-card">
    <div className="flex items-center gap-4 border-b border-border px-4 py-3">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-3 w-20" />
    </div>
    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-4">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-5 w-20 rounded-full" />
    </div>
    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-4">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-5 w-20 rounded-full" />
    </div>
    <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-4">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-5 w-20 rounded-full" />
    </div>
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-5 w-20 rounded-full" />
    </div>
  </div>
)

export const SpeakerCardLoading = () => (
  <Card className="max-w-md">
    <CardHeader>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="grid gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </CardHeader>
    <CardContent>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-48" />
      </div>
    </CardContent>
  </Card>
)

export const StatTilesLoading = () => (
  <div className="grid max-w-lg grid-cols-2 gap-4">
    <Card>
      <CardHeader>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-16" />
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-16" />
      </CardHeader>
    </Card>
  </div>
)
