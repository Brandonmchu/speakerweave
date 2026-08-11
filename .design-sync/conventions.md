# SpeakerWeave UI — build conventions

React + Tailwind utility system (shadcn-style). Components are context-free — **no provider or theme wrapper is required**; import from the bundle and render. The only mount-once component is `Toaster`: render one `<Toaster />` at your app root, then fire notifications imperatively with `toast({ title, description, variant })` from anywhere.

## Styling idiom: Tailwind utilities over semantic tokens

Style your own layout glue with Tailwind utility classes; color always goes through the kit's semantic names (they resolve to `hsl(var(--token))` and keep everything on-palette):

| Family | Real names |
|---|---|
| Surfaces | `bg-background` `bg-card` `bg-popover` `bg-muted` `bg-hover` `bg-primary-subtle` |
| Text | `text-foreground` `text-muted-foreground` `text-primary` `text-destructive` `text-placeholder` |
| Actions | `bg-primary text-primary-foreground` (primary), `bg-destructive text-destructive-foreground` (danger), `bg-success` / `bg-warning` for status |
| Borders | `border-border` (hairlines), `border-input` (controls), `ring-primary/20` (focus) |
| Shape/elevation | `rounded-md` (controls) `rounded-xl` (cards), `shadow-soft` `shadow-raised` `shadow-lifted` |

Layout glue is plain Tailwind: `flex items-center gap-3`, `grid gap-4`, `p-4`, `max-w-md`, `text-sm`. Typography is Inter (ships with the bundle); body text is `text-sm`, secondary text `text-xs text-muted-foreground`.

Never hand-roll hex colors or generic `gray-*` classes — every neutral has a semantic name above.

## Component API shape

- Variants ride props via CVA: `<Button variant="destructive" size="sm">`, `<Badge variant="…">`. Check each component's `.d.ts` for its exact variant axis.
- Compounds compose Radix-style from subcomponents: `Card`+`CardHeader`+`CardTitle`+`CardDescription`+`CardContent`+`CardFooter`; `Dialog`+`DialogContent`+`DialogHeader`+`DialogFooter`; `Table`+`TableHeader`+`TableRow`+`TableHead`+`TableBody`+`TableCell`; `Tabs`+`TabsList`+`TabsTrigger`+`TabsContent`; `Select`+`SelectTrigger`+`SelectValue`+`SelectContent`+`SelectItem`; `DropdownMenu`+`DropdownMenuTrigger`+`DropdownMenuContent`+`DropdownMenuItem`.
- Forms: pair `Label` (htmlFor) with `Input`/`Textarea`/`Checkbox`/`NativeSelect`. Error state = set `aria-invalid` on the control (styling is built in) and add a `text-xs text-destructive` helper line. `NativeSelect` takes `options={[{value,label}]}` + `placeholder` and renders a real `<select>` — prefer it when the control must be machine-drivable.
- Zero-data views use `EmptyState` (title/description/icon/action props); loading views compose `Skeleton` blocks in the shape of the real content.

## Where the truth lives

Read `styles.css` (and its `_ds_bundle.css` import) for the full token set, and each component's `.prompt.md` + `.d.ts` before using it — the props interface is the contract.

## Idiomatic example

```tsx
<Card className="max-w-md">
  <CardHeader>
    <div className="flex items-center justify-between gap-3">
      <CardTitle>RAG in Production</CardTitle>
      <Badge>Pending</Badge>
    </div>
    <CardDescription>SESS-102 · Priya Raman · 30 min talk</CardDescription>
  </CardHeader>
  <CardContent>
    <p className="text-sm text-muted-foreground">Session abstract…</p>
  </CardContent>
  <CardFooter className="flex justify-end gap-2">
    <Button variant="outline" size="sm">Open review</Button>
    <Button size="sm">Accept</Button>
  </CardFooter>
</Card>
```
