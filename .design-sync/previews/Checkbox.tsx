import { Checkbox, Label } from 'dais-web'

export const ReviewChecklist = () => (
  <div className="grid max-w-sm gap-3">
    <div className="flex items-center gap-2">
      <Checkbox id="chk-abstract" defaultChecked />
      <Label htmlFor="chk-abstract">Abstract reviewed</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="chk-bio" defaultChecked />
      <Label htmlFor="chk-bio">Speaker bio complete</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="chk-headshot" />
      <Label htmlFor="chk-headshot">Headshot uploaded</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="chk-travel" />
      <Label htmlFor="chk-travel">Travel form signed</Label>
    </div>
  </div>
)

export const States = () => (
  <div className="grid max-w-sm gap-3">
    <div className="flex items-center gap-2">
      <Checkbox id="st-unchecked" />
      <Label htmlFor="st-unchecked">Unchecked · Notify co-speakers</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="st-checked" defaultChecked />
      <Label htmlFor="st-checked">Checked · Send acceptance email</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="st-disabled" disabled />
      <Label htmlFor="st-disabled">Disabled · Schedule locked</Label>
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="st-disabled-checked" defaultChecked disabled />
      <Label htmlFor="st-disabled-checked">Disabled checked · Contract on file</Label>
    </div>
  </div>
)

export const NotificationPreferences = () => (
  <div className="grid max-w-md gap-4">
    <div className="flex items-start gap-2">
      <Checkbox id="pref-new-submission" defaultChecked />
      <div className="grid gap-1">
        <Label htmlFor="pref-new-submission">New submissions</Label>
        <p className="text-sm text-muted-foreground">
          Email me whenever a speaker submits to an open CFP.
        </p>
      </div>
    </div>
    <div className="flex items-start gap-2">
      <Checkbox id="pref-schedule" />
      <div className="grid gap-1">
        <Label htmlFor="pref-schedule">Schedule changes</Label>
        <p className="text-sm text-muted-foreground">
          Notify me when a session moves room or time slot.
        </p>
      </div>
    </div>
  </div>
)
