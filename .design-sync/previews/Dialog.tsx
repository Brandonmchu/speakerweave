import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from 'dais-web'

export const Open = () => (
  <div className="pb-40">
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Decline submission?</DialogTitle>
          <DialogDescription>
            SESS-118 &middot; &ldquo;Designing for Trust in AI Interfaces&rdquo; by Maya
            Okonkwo moves to Declined. Reviewers keep their scores, and the speaker is
            only notified once you publish decisions for the Product track.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Keep in review</Button>
          <Button variant="destructive">Decline submission</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
)

export const WithForm = () => (
  <div className="pb-40">
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm speaker slot</DialogTitle>
          <DialogDescription>
            Priya Raman &middot; Main Stage &middot; Tue 09:30&ndash;10:00
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="dialog-note">Note to speaker</Label>
          <Textarea
            id="dialog-note"
            rows={3}
            defaultValue="Your keynote is locked for Tuesday morning. AV check runs 08:15 in the green room — slides are due Friday."
          />
        </div>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Send confirmation</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
)

export const Narrow = () => (
  <div className="pb-40">
    <Dialog open>
      <DialogContent className="w-full max-w-sm">
        <DialogHeader>
          <DialogTitle>Publish the schedule?</DialogTitle>
          <DialogDescription>
            62 sessions across 4 rooms become visible on the public agenda.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm">
            Not yet
          </Button>
          <Button size="sm">Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
)
