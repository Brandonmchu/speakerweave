import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/ui/button'
import { toast } from '@/ui/use-toast'

/** Copy-to-clipboard that degrades quietly where the API is missing (http, jsdom). */
export function CopyButton({ value, label = 'Copy link' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
          toast({ title: 'Link copied' })
        } catch {
          toast({ variant: 'destructive', title: "Couldn't copy", description: value })
        }
      }}
    >
      {copied ? <Check className="h-4 w-4 text-success-strong" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}
