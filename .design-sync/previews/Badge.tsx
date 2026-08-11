import { Badge } from 'dais-web'

export const SubmissionStatuses = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge>Pending review</Badge>
    <Badge variant="success">Accepted</Badge>
    <Badge variant="warning">Waitlisted</Badge>
    <Badge variant="destructive">Declined</Badge>
    <Badge variant="muted">Withdrawn</Badge>
    <Badge variant="outline">Draft</Badge>
    <Badge variant="solid">Open</Badge>
  </div>
)

export const SubmissionRow = () => (
  <div className="grid max-w-lg gap-3">
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium text-foreground">
        RAG in Production: 10 Billion Queries
      </span>
      <Badge variant="success">Accepted</Badge>
    </div>
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium text-foreground">
        Designing CFP Rubrics That Reviewers Trust
      </span>
      <Badge>Pending review</Badge>
    </div>
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-medium text-foreground">
        Zero-Downtime Postgres Migrations
      </span>
      <Badge variant="destructive">Declined</Badge>
    </div>
  </div>
)

export const SpeakerTags = () => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="muted">Returning speaker</Badge>
    <Badge variant="muted">Travel requested</Badge>
    <Badge variant="outline">Engineering track</Badge>
    <Badge variant="outline">30 min talk</Badge>
    <Badge variant="warning">Bio missing</Badge>
  </div>
)
