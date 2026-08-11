import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from 'dais-web'

export const Open = () => (
  <div className="pb-40">
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Row actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>SESS-118</DropdownMenuLabel>
        <DropdownMenuItem>
          Rename
          <DropdownMenuShortcut>R</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>Copy link</DropdownMenuItem>
        <DropdownMenuItem>Assign reviewer</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
)

export const WithCheckboxItems = () => (
  <div className="pb-40">
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked>Speaker</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked>Track</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={false}>Submitted</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={false}>Avg. score</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
)

export const WithDisabledItem = () => (
  <div className="pb-40">
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Bulk actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>3 submissions selected</DropdownMenuLabel>
        <DropdownMenuItem>Move to Shortlist</DropdownMenuItem>
        <DropdownMenuItem>Request revisions</DropdownMenuItem>
        <DropdownMenuItem disabled>Publish decisions</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Export as CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
)
