import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'dais-web'

export const Closed = () => (
  <div className="grid max-w-xs gap-2">
    <Label htmlFor="track">Track</Label>
    <Select defaultValue="engineering">
      <SelectTrigger id="track">
        <SelectValue placeholder="Pick a track" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="engineering">Engineering</SelectItem>
        <SelectItem value="product">Product</SelectItem>
        <SelectItem value="research">Research</SelectItem>
      </SelectContent>
    </Select>
  </div>
)

export const Placeholder = () => (
  <div className="grid max-w-xs gap-2">
    <Label htmlFor="format">Session format</Label>
    <Select>
      <SelectTrigger id="format">
        <SelectValue placeholder="Choose a format" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="keynote">Keynote · 45 min</SelectItem>
        <SelectItem value="talk">Talk · 30 min</SelectItem>
        <SelectItem value="workshop">Workshop · 90 min</SelectItem>
      </SelectContent>
    </Select>
  </div>
)

export const Open = () => (
  <div className="grid max-w-xs gap-2 pb-40">
    <Label htmlFor="room">Room</Label>
    <Select defaultValue="main-stage" open>
      <SelectTrigger id="room">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="main-stage">Main Stage · cap 400</SelectItem>
        <SelectItem value="workshop-a">Workshop A · cap 60</SelectItem>
        <SelectItem value="workshop-b">Workshop B · cap 60</SelectItem>
      </SelectContent>
    </Select>
  </div>
)
