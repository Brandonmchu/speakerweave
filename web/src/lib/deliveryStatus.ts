/** Keep delivery storage values intact while naming intentional demo suppression clearly. */
export function deliveryStatusLabel(
  status: string | null | undefined,
  error?: string | null
): string {
  if (status === 'cancelled' && /delivery suppressed/i.test(error ?? '')) return 'suppressed'
  return status ?? ''
}
