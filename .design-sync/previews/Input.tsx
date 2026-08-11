import { Input, Label } from 'dais-web'

export const SessionTitleField = () => (
  <div className="grid max-w-md gap-2">
    <Label htmlFor="session-title" required>
      Session title
    </Label>
    <Input
      id="session-title"
      defaultValue="RAG in Production: Lessons From 10 Billion Queries"
    />
    <p className="text-sm text-muted-foreground">
      Shown on the public schedule. 80 characters max.
    </p>
  </div>
)

export const SpeakerIntakeForm = () => (
  <div className="grid max-w-lg grid-cols-2 gap-4">
    <div className="grid gap-2">
      <Label htmlFor="intake-name" required>
        Full name
      </Label>
      <Input id="intake-name" defaultValue="Priya Raman" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="intake-email" required>
        Email
      </Label>
      <Input id="intake-email" type="email" defaultValue="priya@northwind.dev" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="intake-company">Company</Label>
      <Input id="intake-company" defaultValue="Northwind Data" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="intake-site">Website</Label>
      <Input id="intake-site" type="url" placeholder="https://example.com" />
    </div>
  </div>
)

export const States = () => (
  <div className="grid max-w-md gap-4">
    <div className="grid gap-2">
      <Label htmlFor="state-filled">Filled</Label>
      <Input id="state-filled" defaultValue="Main Stage · Track A" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="state-placeholder">Placeholder</Label>
      <Input id="state-placeholder" placeholder="Search speakers by name or email" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="state-disabled">Disabled</Label>
      <Input id="state-disabled" disabled defaultValue="SESS-102 (locked)" />
    </div>
  </div>
)

export const Invalid = () => (
  <div className="grid max-w-md gap-2">
    <Label htmlFor="state-invalid" required>
      Speaker email
    </Label>
    <Input
      id="state-invalid"
      type="email"
      aria-invalid
      aria-describedby="state-invalid-error"
      defaultValue="priya@"
    />
    <p id="state-invalid-error" className="text-sm text-destructive">
      Enter a valid email address.
    </p>
  </div>
)
