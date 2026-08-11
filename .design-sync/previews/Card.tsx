import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from 'dais-web'

export const SubmissionCard = () => (
  <Card className="max-w-md">
    <CardHeader>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>RAG in Production: Lessons From 10 Billion Queries</CardTitle>
        <Badge>Pending</Badge>
      </div>
      <CardDescription>
        SESS-102 · Priya Raman · Engineering track · 30 min talk
      </CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        Retrieval quality drifts silently at scale. This session covers the observability
        stack we built to catch it: shadow evaluations, drift alarms, and the three
        metrics that actually predicted user-visible failures.
      </p>
    </CardContent>
    <CardFooter className="flex justify-end gap-2">
      <Button variant="outline" size="sm">Open review</Button>
      <Button size="sm">Accept</Button>
    </CardFooter>
  </Card>
)

export const StatCard = () => (
  <div className="grid max-w-lg grid-cols-2 gap-4">
    <Card>
      <CardHeader>
        <CardDescription>Total speakers</CardDescription>
        <CardTitle className="text-3xl">24</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Outstanding tasks</CardDescription>
        <CardTitle className="text-3xl">50</CardTitle>
      </CardHeader>
    </Card>
  </div>
)
