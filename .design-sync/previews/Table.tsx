import {
  Badge,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from 'dais-web'

const submissions = [
  {
    code: 'SESS-102',
    title: 'RAG in Production: Lessons From 10 Billion Queries',
    speaker: 'Priya Raman',
    track: 'Engineering',
    status: 'Accepted',
    variant: 'success' as const,
    selected: true,
  },
  {
    code: 'SESS-108',
    title: 'Designing for Trust in AI Interfaces',
    speaker: 'Maya Okonkwo',
    track: 'Product',
    status: 'In review',
    variant: 'default' as const,
    selected: false,
  },
  {
    code: 'SESS-115',
    title: 'Postgres at 40 TB Without a DBA Team',
    speaker: 'Tomás Herrera',
    track: 'Infrastructure',
    status: 'Shortlist',
    variant: 'warning' as const,
    selected: false,
  },
  {
    code: 'SESS-121',
    title: 'Running a CFP That Speakers Actually Finish',
    speaker: 'Dana Whitfield',
    track: 'Community',
    status: 'Accepted',
    variant: 'success' as const,
    selected: false,
  },
  {
    code: 'SESS-129',
    title: 'Observability for Event Streams',
    speaker: 'Lukas Berg',
    track: 'Engineering',
    status: 'Declined',
    variant: 'destructive' as const,
    selected: false,
  },
]

export const Submissions = () => (
  <div className="w-full max-w-3xl border border-border rounded-lg bg-card overflow-hidden">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox aria-label="Select all submissions" />
          </TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Session</TableHead>
          <TableHead>Speaker</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {submissions.map((s) => (
          <TableRow key={s.code} data-state={s.selected ? 'selected' : undefined}>
            <TableCell>
              <Checkbox defaultChecked={s.selected} aria-label={`Select ${s.code}`} />
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{s.code}</TableCell>
            <TableCell className="font-medium text-foreground">{s.title}</TableCell>
            <TableCell className="text-muted-foreground">{s.speaker}</TableCell>
            <TableCell>
              <Badge variant={s.variant}>{s.status}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
)

export const WithFooter = () => (
  <div className="w-full max-w-2xl border border-border rounded-lg bg-card overflow-hidden">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Reviewer</TableHead>
          <TableHead>Track</TableHead>
          <TableHead className="text-right">Assigned</TableHead>
          <TableHead className="text-right">Scored</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium text-foreground">Priya Raman</TableCell>
          <TableCell className="text-muted-foreground">Engineering</TableCell>
          <TableCell className="text-right tabular-nums">18</TableCell>
          <TableCell className="text-right tabular-nums">18</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium text-foreground">Maya Okonkwo</TableCell>
          <TableCell className="text-muted-foreground">Product</TableCell>
          <TableCell className="text-right tabular-nums">16</TableCell>
          <TableCell className="text-right tabular-nums">11</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium text-foreground">Tomás Herrera</TableCell>
          <TableCell className="text-muted-foreground">Infrastructure</TableCell>
          <TableCell className="text-right tabular-nums">14</TableCell>
          <TableCell className="text-right tabular-nums">9</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="font-medium text-foreground">Dana Whitfield</TableCell>
          <TableCell className="text-muted-foreground">Community</TableCell>
          <TableCell className="text-right tabular-nums">14</TableCell>
          <TableCell className="text-right tabular-nums">14</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="text-muted-foreground">4 reviewers</TableCell>
          <TableCell className="text-right tabular-nums">62</TableCell>
          <TableCell className="text-right tabular-nums">52</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  </div>
)

export const Schedule = () => (
  <div className="w-full max-w-2xl border border-border rounded-lg bg-card overflow-hidden">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Main Stage</TableHead>
          <TableHead>Workshop A</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="text-muted-foreground tabular-nums">09:00</TableCell>
          <TableCell className="font-medium text-foreground">Opening keynote</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="text-muted-foreground tabular-nums">10:15</TableCell>
          <TableCell className="font-medium text-foreground">RAG in Production</TableCell>
          <TableCell className="text-muted-foreground">Prompt eval lab</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="text-muted-foreground tabular-nums">11:30</TableCell>
          <TableCell className="font-medium text-foreground">Designing for Trust</TableCell>
          <TableCell className="text-muted-foreground">Postgres clinic</TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="text-muted-foreground tabular-nums">13:00</TableCell>
          <TableCell className="font-medium text-foreground">Lunch &amp; sponsor hall</TableCell>
          <TableCell className="text-muted-foreground">&mdash;</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
)
