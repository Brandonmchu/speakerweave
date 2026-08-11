import {
  Badge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from 'dais-web'

export const Default = () => (
  <div className="max-w-2xl">
    <Tabs defaultValue="assignments">
      <TabsList>
        <TabsTrigger value="setup">Plan setup</TabsTrigger>
        <TabsTrigger value="assignments">Assignments</TabsTrigger>
        <TabsTrigger value="summary">Summary &amp; decisions</TabsTrigger>
      </TabsList>
      <TabsContent value="setup">
        <p className="text-sm text-muted-foreground">
          Review plan opens 12 May and closes 26 May. Each submission needs two scores.
        </p>
      </TabsContent>
      <TabsContent value="assignments">
        <p className="text-sm text-muted-foreground">
          14 of 62 submissions still need a second reviewer. Conflicts of interest are
          excluded automatically when a reviewer shares an employer with the speaker.
        </p>
      </TabsContent>
      <TabsContent value="summary">
        <p className="text-sm text-muted-foreground">
          38 accepted &middot; 11 waitlisted &middot; 13 declined. Nothing is sent until you
          publish.
        </p>
      </TabsContent>
    </Tabs>
  </div>
)

export const Underline = () => (
  <div className="max-w-2xl">
    <Tabs defaultValue="speakers">
      <TabsList variant="underline">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="speakers">Speakers</TabsTrigger>
        <TabsTrigger value="sessions">Sessions</TabsTrigger>
        <TabsTrigger value="schedule">Schedule</TabsTrigger>
      </TabsList>
      <TabsContent value="speakers">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            24 confirmed speakers for DevConf 2024.
          </p>
          <Badge variant="success">All bios received</Badge>
        </div>
      </TabsContent>
      <TabsContent value="overview">
        <p className="text-sm text-muted-foreground">Event summary.</p>
      </TabsContent>
      <TabsContent value="sessions">
        <p className="text-sm text-muted-foreground">62 sessions.</p>
      </TabsContent>
      <TabsContent value="schedule">
        <p className="text-sm text-muted-foreground">4 rooms, 3 days.</p>
      </TabsContent>
    </Tabs>
  </div>
)

export const WithCounts = () => (
  <div className="max-w-2xl">
    <Tabs defaultValue="pending">
      <TabsList>
        <TabsTrigger value="pending">
          Pending
          <Badge variant="muted">18</Badge>
        </TabsTrigger>
        <TabsTrigger value="shortlist">
          Shortlist
          <Badge variant="muted">9</Badge>
        </TabsTrigger>
        <TabsTrigger value="declined">
          Declined
          <Badge variant="muted">13</Badge>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pending">
        <p className="text-sm text-muted-foreground">
          Oldest submission has been waiting 11 days for its first score.
        </p>
      </TabsContent>
      <TabsContent value="shortlist">
        <p className="text-sm text-muted-foreground">
          Shortlisted talks still need room and slot assignments.
        </p>
      </TabsContent>
      <TabsContent value="declined">
        <p className="text-sm text-muted-foreground">
          Declined submissions stay editable until decisions are published.
        </p>
      </TabsContent>
    </Tabs>
  </div>
)
