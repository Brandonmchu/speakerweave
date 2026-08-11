import { Button, EmptyState } from 'dais-web'

const InboxIcon = () => (
  <svg
    className="h-5 w-5 text-muted-foreground"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
)

const SearchIcon = () => (
  <svg
    className="h-5 w-5 text-muted-foreground"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

const CalendarIcon = () => (
  <svg
    className="h-5 w-5 text-muted-foreground"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M8 3v4M16 3v4M3 11h18" />
  </svg>
)

export const NoSubmissions = () => (
  <div className="w-full max-w-lg border border-border rounded-lg bg-card">
    <EmptyState
      icon={<InboxIcon />}
      title="No submissions yet"
      description="Your call for papers opens 12 May. Share the CFP link and submissions will land here as speakers apply."
      action={<Button size="sm">Copy CFP link</Button>}
    />
  </div>
)

export const NoResults = () => (
  <div className="w-full max-w-lg border border-border rounded-lg bg-card">
    <EmptyState
      icon={<SearchIcon />}
      title="No sessions match these filters"
      description="Nothing in the Product track is still awaiting a second review score."
      action={
        <Button variant="outline" size="sm">
          Clear filters
        </Button>
      }
    />
  </div>
)

export const NoAction = () => (
  <div className="w-full max-w-lg border border-border rounded-lg bg-card">
    <EmptyState
      icon={<CalendarIcon />}
      title="Nothing scheduled for Wednesday"
      description="Accepted sessions appear here once you assign them a room and a time slot."
    />
  </div>
)
