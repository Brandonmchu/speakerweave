import { Construction } from 'lucide-react'

/** Placeholder for the nav destinations that aren't built yet. */
export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <div className="mt-6 flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card px-6 py-16 text-center">
        <Construction className="h-8 w-8 text-muted-foreground" />
        <p className="mt-4 text-base font-medium text-foreground">Coming soon</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {title} isn&rsquo;t wired up yet. Submissions is the surface that works today.
        </p>
      </div>
    </div>
  )
}
