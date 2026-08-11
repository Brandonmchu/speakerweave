import { Badge, Separator } from 'dais-web'

export const SectionDivider = () => (
  <div className="grid max-w-md gap-4">
    <div className="grid gap-1">
      <span className="text-sm font-semibold text-foreground">Priya Raman</span>
      <span className="text-sm text-muted-foreground">
        Staff Engineer · Northwind Data
      </span>
    </div>
    <Separator />
    <div className="grid gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Accepted sessions
      </span>
      <span className="text-sm text-foreground">
        RAG in Production: Lessons From 10 Billion Queries
      </span>
    </div>
    <Separator />
    <div className="grid gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Travel
      </span>
      <span className="text-sm text-foreground">Flight booked · Hotel pending</span>
    </div>
  </div>
)

export const VerticalMeta = () => (
  <div className="flex h-5 items-center gap-3">
    <span className="text-sm text-muted-foreground">SESS-102</span>
    <Separator orientation="vertical" />
    <span className="text-sm text-muted-foreground">Engineering</span>
    <Separator orientation="vertical" />
    <span className="text-sm text-muted-foreground">30 min talk</span>
    <Separator orientation="vertical" />
    <span className="text-sm text-muted-foreground">Main Stage</span>
  </div>
)

export const SubmissionList = () => (
  <div className="grid max-w-lg gap-3">
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-foreground">Zero-Downtime Postgres Migrations</span>
      <Badge variant="success">Accepted</Badge>
    </div>
    <Separator />
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-foreground">Designing CFP Rubrics</span>
      <Badge>Pending review</Badge>
    </div>
    <Separator />
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-foreground">Observability for LLM Apps</span>
      <Badge variant="warning">Waitlisted</Badge>
    </div>
  </div>
)
