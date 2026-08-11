# design-sync NOTES — SpeakerWeave UI kit (dais-web)

Build command (from web/): `npx tailwindcss -c tailwind.design-sync.cjs -i src/index.css -o .ds-css/ds.css --minify`, then from repo root:
`node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules web/node_modules --entry web/src/ui/index.ts --out ./ds-bundle`

## Known render warns / cosmetics
- Every preview cell shows a tall light-gray stage block below the content — harness cell chrome, not a defect.

## Repo gotchas (folded from wave learnings, Aug 11)
- The app's Tailwind scopes ALL utilities under `#root` (`important: '#root'` in web/tailwind.config.js, to beat Radix inline styles). The DS stylesheet builds UNSCOPED via web/tailwind.design-sync.cjs (`important: false`); that file must also unwrap the ESM config (`require(...).default`) or Tailwind silently ignores overrides.
- tailwind.design-sync.cjs includes `.design-sync/previews/**` in content — REGENERATE web/.ds-css/ds.css (buildCmd) after authoring previews with new glue classes, then full package-build.
- `aria-invalid:` variants require `theme.extend.aria.invalid` (added Aug 11 to web/tailwind.config.js) — Tailwind v3's default aria map lacks `invalid`; without it the kit's error styling is silently dead in the app too.
- Overlay previews: give wrappers pb-40 (largest padding compiled) for portal room; Dialog/DropdownMenu/Select/Toaster have cardMode overrides in config (Dialog viewport 680x520 so DialogFooter shows its sm: desktop row).
- `Separator orientation="vertical"` collapses without a definite-height parent (`flex h-5 items-center`).
- `Textarea` doesn't auto-grow without `autoResize`; static content past ~3 lines scroll-clips.
- EmptyState icon: pass inline SVG (lucide-react isn't in extraEntries); keep fixture helpers unexported or they become graded cells.
- Preview harness has no StrictMode: useEffect fires once (Toaster relies on this).
- Barrel entry web/src/ui/index.ts exists for design-sync (--entry) and exports use-toast's toast() for the Toaster preview.
- Static Radix cells: use defaultChecked/defaultValue over checked/value (no onChange in static previews).

## Re-sync risks
- web/.ds-css/ds.css is generated (gitignored): a fresh clone must run the buildCmd before package-build or cssEntry is missing.
- Inter/Geist woff2 vendored under .design-sync/fonts/ from the fontsource CDN (the app itself never ships them — font-stack preference only); refresh if brand fonts change.
- Grades/verdicts live in gitignored .cache; carry-forward comes from the uploaded _ds_sync.json anchor.
- The barrel index.ts and tailwind.design-sync.cjs live in web/ — app builds ignore them, but renames would break the recorded build command.
