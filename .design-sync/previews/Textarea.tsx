import { Label, Textarea } from 'dais-web'

export const AbstractField = () => (
  <div className="grid max-w-lg gap-2">
    <Label htmlFor="ta-abstract" required>
      Session abstract
    </Label>
    <Textarea
      id="ta-abstract"
      defaultValue={
        'Retrieval quality drifts silently at scale. This session covers the observability stack we built to catch it: shadow evals, drift alarms, and the metrics that mattered.'
      }
    />
    <p className="text-sm text-muted-foreground">
      168 / 1200 characters · Reviewers see this before the full outline.
    </p>
  </div>
)

export const States = () => (
  <div className="grid max-w-lg gap-4">
    <div className="grid gap-2">
      <Label htmlFor="ta-empty">Speaker notes</Label>
      <Textarea id="ta-empty" placeholder="Add private notes for the review committee…" />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="ta-disabled">Reviewer feedback (published)</Label>
      <Textarea
        id="ta-disabled"
        disabled
        defaultValue="Strong technical depth. Accepted for the Engineering track."
      />
    </div>
  </div>
)

export const Invalid = () => (
  <div className="grid max-w-lg gap-2">
    <Label htmlFor="ta-invalid" required>
      Speaker bio
    </Label>
    <Textarea
      id="ta-invalid"
      aria-invalid
      aria-describedby="ta-invalid-error"
      defaultValue="Priya is an engineer."
    />
    <p id="ta-invalid-error" className="text-sm text-destructive">
      Bios must be at least 200 characters for the printed program.
    </p>
  </div>
)
