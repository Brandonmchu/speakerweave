import { Checkbox, Input, Label, Textarea } from 'dais-web'

export const WithInput = () => (
  <div className="grid max-w-md gap-4">
    <div className="grid gap-2">
      <Label htmlFor="lbl-title" required>
        Session title
      </Label>
      <Input id="lbl-title" defaultValue="Designing CFP Rubrics That Reviewers Trust" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="lbl-abstract">Abstract</Label>
      <Textarea
        id="lbl-abstract"
        defaultValue="A practical walkthrough of the scoring rubric we shipped for a 1,200-submission CFP."
      />
    </div>
  </div>
)

export const RequiredAndOptional = () => (
  <div className="grid max-w-sm gap-4">
    <div className="grid gap-2">
      <Label htmlFor="req-email" required>
        Speaker email
      </Label>
      <Input id="req-email" type="email" defaultValue="priya@northwind.dev" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="opt-pronouns">Pronouns</Label>
      <Input id="opt-pronouns" placeholder="she/her" />
    </div>
  </div>
)

export const WithCheckbox = () => (
  <div className="grid max-w-sm gap-3">
    <div className="flex items-center gap-2">
      <Checkbox id="lbl-chk-notify" defaultChecked />
      <Label htmlFor="lbl-chk-notify">Notify me on new submissions</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="lbl-chk-locked" disabled />
      <Label htmlFor="lbl-chk-locked">Publish to public schedule (locked)</Label>
    </div>
  </div>
)
