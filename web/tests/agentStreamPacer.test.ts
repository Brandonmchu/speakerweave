import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createStreamPacer } from '@/agent/hooks/useStreamPacer'

describe('agent stream pacer', () => {
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map()
    nextFrame = 1
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function runFrame(timestamp: number) {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback(timestamp))
  }

  it('only commits at a word boundary while streaming', () => {
    const commits: string[] = []
    const pacer = createStreamPacer((text) => commits.push(text))
    pacer.push('hello world')
    runFrame(0)
    runFrame(16)

    expect(commits.at(-1)).toBe('hello ')
    expect(commits.some((value) => value.endsWith('w'))).toBe(false)
    pacer.dispose()
  })

  it('hard-flushes the authoritative final text if animation stalls', () => {
    const commits: string[] = []
    const drained = vi.fn()
    const pacer = createStreamPacer((text) => commits.push(text))
    pacer.push('A complete answer')
    pacer.finish('A complete answer with a final clause.', drained)
    vi.advanceTimersByTime(2500)

    expect(commits.at(-1)).toBe('A complete answer with a final clause.')
    expect(drained).toHaveBeenCalledTimes(1)
    pacer.dispose()
  })
})

