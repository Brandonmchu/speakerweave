import { Label, NativeSelect } from 'dais-web'

const TRACKS = [
  { value: 'engineering', label: 'Engineering' },
  { value: 'product', label: 'Product & Design' },
  { value: 'research', label: 'Applied Research' },
  { value: 'leadership', label: 'Engineering Leadership' },
]

const ROOMS = [
  { value: 'main-stage', label: 'Main Stage · cap 400' },
  { value: 'workshop-a', label: 'Workshop A · cap 60' },
  { value: 'workshop-b', label: 'Workshop B · cap 60' },
  { value: 'expo-theater', label: 'Expo Theater · cap 120 (booked)', disabled: true },
]

export const TrackAndRoom = () => (
  <div className="grid max-w-sm gap-4">
    <div className="grid gap-2">
      <Label htmlFor="ns-track" required>
        Track
      </Label>
      <NativeSelect id="ns-track" value="engineering" options={TRACKS} />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="ns-room">Room</Label>
      <NativeSelect id="ns-room" value="workshop-a" options={ROOMS} />
    </div>
  </div>
)

export const Placeholder = () => (
  <div className="grid max-w-sm gap-2">
    <Label htmlFor="ns-format" required>
      Session format
    </Label>
    <NativeSelect
      id="ns-format"
      placeholder="Choose a format"
      options={[
        { value: 'keynote', label: 'Keynote · 45 min' },
        { value: 'talk', label: 'Talk · 30 min' },
        { value: 'workshop', label: 'Workshop · 90 min' },
        { value: 'lightning', label: 'Lightning · 10 min' },
      ]}
    />
    <p className="text-sm text-muted-foreground">
      Determines the length shown to reviewers.
    </p>
  </div>
)

export const States = () => (
  <div className="grid max-w-sm gap-4">
    <div className="grid gap-2">
      <Label htmlFor="ns-selected">Selected</Label>
      <NativeSelect id="ns-selected" value="research" options={TRACKS} />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="ns-disabled">Disabled</Label>
      <NativeSelect id="ns-disabled" disabled value="main-stage" options={ROOMS} />
    </div>
    <div className="grid gap-2">
      <Label htmlFor="ns-slot">Time slot (option children)</Label>
      <NativeSelect id="ns-slot" value="tue-1400">
        <option value="tue-1100">Tue · 11:00–11:30</option>
        <option value="tue-1400">Tue · 14:00–14:30</option>
        <option value="wed-0930">Wed · 09:30–10:00</option>
      </NativeSelect>
    </div>
  </div>
)

export const Invalid = () => (
  <div className="grid max-w-sm gap-2">
    <Label htmlFor="ns-invalid" required>
      Track
    </Label>
    <NativeSelect
      id="ns-invalid"
      aria-invalid
      aria-describedby="ns-invalid-error"
      placeholder="Select a track"
      options={TRACKS}
    />
    <p id="ns-invalid-error" className="text-sm text-destructive">
      Pick a track before submitting.
    </p>
  </div>
)
