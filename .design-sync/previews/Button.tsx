import { Button } from 'dais-web'

export const Variants = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>Save changes</Button>
    <Button variant="secondary">Preview</Button>
    <Button variant="outline">Export CSV</Button>
    <Button variant="ghost">Dismiss</Button>
    <Button variant="destructive">Decline submission</Button>
    <Button variant="link">View public page</Button>
  </div>
)

export const Sizes = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button size="xs">Add tag</Button>
    <Button size="sm">Assign reviewer</Button>
    <Button size="default">Publish schedule</Button>
    <Button size="lg">Enter the demo workspace</Button>
  </div>
)

export const Disabled = () => (
  <div className="flex flex-wrap items-center gap-3">
    <Button disabled>Publishing…</Button>
    <Button variant="secondary" disabled>Locked</Button>
    <Button variant="destructive" disabled>Decline submission</Button>
  </div>
)
