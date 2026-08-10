import { useEffect, useMemo, useRef } from 'react'

const BASE_HORIZON_S = 0.35
const FINISH_HORIZON_S = 0.15
const MIN_RATE_CPS = 250
const MAX_RATE_CPS = 5000
const MAX_TICK_S = 0.1
const FINISH_FLUSH_FALLBACK_MS = 2500
const JSON_TAIL_WINDOW = 200

export interface StreamPacer {
  push: (target: string) => void
  finish: (finalText: string | undefined, onDrained: () => void) => void
  flush: () => void
  reset: () => void
  isActive: () => boolean
  dispose: () => void
}

export function createStreamPacer(onCommit: (text: string) => void): StreamPacer {
  let target = ''
  let cursor = 0
  let committedLength = 0
  let frame: number | null = null
  let lastTimestamp: number | null = null
  let finishing = false
  let onDrained: (() => void) | null = null
  let fallback: ReturnType<typeof setTimeout> | null = null
  let reducedMotion: MediaQueryList | null | undefined

  const prefersReducedMotion = () => {
    if (reducedMotion === undefined) {
      reducedMotion =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-reduced-motion: reduce)')
          : null
    }
    return reducedMotion?.matches ?? false
  }
  const isHidden = () => typeof document !== 'undefined' && document.hidden
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    lastTimestamp = null
  }
  const clearFallback = () => {
    if (fallback !== null) clearTimeout(fallback)
    fallback = null
  }
  const commit = (length: number) => {
    if (length === committedLength) return
    committedLength = length
    onCommit(target.slice(0, length))
  }
  const snapToWordBoundary = (position: number) => {
    if (position >= target.length) return target.length
    let index = Math.floor(position)
    while (index > 0 && !/\s/.test(target[index - 1])) index -= 1
    return index
  }
  const holdBackJsonTail = (length: number) => {
    const windowStart = Math.max(0, length - JSON_TAIL_WINDOW)
    const tail = target.slice(windowStart, length)
    const braceIndex = tail.lastIndexOf('{')
    if (braceIndex === -1) return length
    const fragment = tail.slice(braceIndex)
    return !fragment.includes('}') && /^\{\s*["']/.test(fragment)
      ? snapToWordBoundary(windowStart + braceIndex)
      : length
  }
  const drained = () => {
    stop()
    clearFallback()
    finishing = false
    const callback = onDrained
    onDrained = null
    callback?.()
  }
  const flushAll = () => {
    cursor = target.length
    commit(target.length)
    if (finishing) drained()
    else stop()
  }
  const tick = (timestamp: number) => {
    frame = null
    const delta =
      lastTimestamp === null ? 1 / 60 : Math.min((timestamp - lastTimestamp) / 1000, MAX_TICK_S)
    lastTimestamp = timestamp
    const horizon = finishing ? FINISH_HORIZON_S : BASE_HORIZON_S
    const remaining = target.length - cursor
    const rate = Math.min(MAX_RATE_CPS, Math.max(MIN_RATE_CPS, remaining / horizon))
    cursor = Math.min(target.length, cursor + rate * delta)
    let snapped = cursor >= target.length ? target.length : snapToWordBoundary(cursor)
    if (!finishing) snapped = holdBackJsonTail(snapped)
    if (snapped > committedLength) commit(snapped)
    if (cursor >= target.length) {
      if (finishing) drained()
      else stop()
      return
    }
    frame = requestAnimationFrame(tick)
  }
  const ensureLoop = () => {
    if (frame !== null) return
    lastTimestamp = null
    frame = requestAnimationFrame(tick)
  }
  const reconcile = (next: string) => {
    const safeCommitted = Math.max(0, committedLength)
    if (next.length >= safeCommitted && next.startsWith(target.slice(0, safeCommitted))) {
      target = next
      return
    }
    let common = 0
    const bound = Math.min(safeCommitted, next.length)
    while (common < bound && next[common] === target[common]) common += 1
    target = next
    cursor = Math.min(cursor, common)
    committedLength = -1
    commit(common)
  }

  return {
    push(next) {
      reconcile(next)
      if (prefersReducedMotion() || isHidden()) {
        cursor = target.length
        commit(target.length)
        return
      }
      if (cursor < target.length) ensureLoop()
    },
    finish(finalText, callback) {
      clearFallback()
      onDrained = callback
      finishing = true
      if (typeof finalText === 'string') {
        const safeCommitted = Math.max(0, committedLength)
        if (!finalText.startsWith(target.slice(0, safeCommitted))) {
          target = finalText
          cursor = finalText.length
          committedLength = -1
          commit(finalText.length)
          drained()
          return
        }
        target = finalText
      }
      if (cursor >= target.length && committedLength >= target.length) {
        drained()
        return
      }
      if (prefersReducedMotion() || isHidden()) {
        flushAll()
        return
      }
      fallback = setTimeout(flushAll, FINISH_FLUSH_FALLBACK_MS)
      ensureLoop()
    },
    flush: flushAll,
    reset() {
      stop()
      clearFallback()
      target = ''
      cursor = 0
      committedLength = 0
      finishing = false
      onDrained = null
    },
    isActive: () => finishing || frame !== null || Math.max(0, committedLength) < target.length,
    dispose() {
      stop()
      clearFallback()
      onDrained = null
    },
  }
}

export function useStreamPacer(onCommit: (text: string) => void): StreamPacer {
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const pacer = useMemo(() => createStreamPacer((text) => commitRef.current(text)), [])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) pacer.flush()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      pacer.dispose()
    }
  }, [pacer])

  return pacer
}

