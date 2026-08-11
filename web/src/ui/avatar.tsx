import { cn } from '@/lib/utils'

const AVATAR_GRADIENTS = [
  ['#DFAB92', '#A97FA8'],
  ['#A8C0D8', '#7E8AA8'],
  ['#E0BE8C', '#C08E6A'],
  ['#9FC4A8', '#6E9E86'],
  ['#DCA8B4', '#A87F8E'],
  ['#BFB4D8', '#8E86B4'],
  ['#E6C79A', '#B49A6A'],
  ['#A8C8C4', '#759F9F'],
] as const

/** Stable unsigned hash used anywhere a person needs a deterministic gradient. */
export function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function avatarGradient(id: string): (typeof AVATAR_GRADIENTS)[number] {
  return AVATAR_GRADIENTS[stableHash(id) % AVATAR_GRADIENTS.length]
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words.at(-1)?.[0] ?? ''}`.toUpperCase()
}

export function GradientAvatar({
  id,
  name,
  size,
  className,
}: {
  id: string
  name: string
  size: number
  className?: string
}) {
  const [start, end] = avatarGradient(id)
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white', className)}
      style={{
        width: size,
        height: size,
        backgroundImage: `linear-gradient(145deg, ${start}, ${end})`,
        fontSize: Math.max(9, Math.round(size * 0.34)),
      }}
    >
      {initials(name)}
    </span>
  )
}

export { AVATAR_GRADIENTS }
