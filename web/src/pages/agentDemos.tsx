/**
 * Faked, animated product demos for the landing page's agentic section — one
 * per surface the agent runs on (in-app Ask, MCP connector, Slack, `sw` CLI).
 *
 * These are illustrations, not live product: every string is hard-coded, and
 * the content is the seeded demo workspace (SESS-110…114, the real speaker
 * roster) so the section agrees with what a visitor sees after "Enter the demo".
 *
 * Motion is CSS-only. Each demo's root carries `rv`, so the site-wide reveal
 * observer in `siteShared` lands `.in` on it at 18% visibility; every internal
 * stage is a keyframe keyed off `.in` on that ancestor, delayed by an inline
 * `--t`. That means nothing animates off-screen, nothing runs on a timer, and
 * `prefers-reduced-motion` can drop the whole sequence to its final frame in
 * one stylesheet block (see `styles/site-agentdemos.css`).
 *
 * The one piece of JS is a local IntersectionObserver: the demos may be mounted
 * later than the page sweep (a tab switch, a lazy section), and a `.rv` that the
 * shared observer never picked up would sit at `opacity: 0` forever. It adds the
 * same class the shared sweep does, so the two are idempotent.
 *
 * Slack chrome is deliberately light (white surface, #1D1C1D ink) even inside a
 * paper band — it is a screenshot of someone else's product, not our palette.
 */
import { useEffect, useRef, type CSSProperties, type JSX, type ReactNode } from 'react'

import slackLogo from '../assets/logos/slack.svg'
import '../styles/site-agentdemos.css'

export type AgentSurfaceId = 'in-app' | 'mcp' | 'slack' | 'cli'

/** Stage delay. Every animated element carries its own so none inherits one. */
function at(seconds: number): CSSProperties {
  return { '--t': `${seconds}s` } as CSSProperties
}

/**
 * Lands `.in` on the demo root once it is on screen, mirroring `useReveal`.
 * Reduced motion (or a browser without the observer) lands it immediately.
 */
function useDemoReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduced || typeof IntersectionObserver === 'undefined') {
      node.classList.add('in')
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add('in')
          observer.unobserve(entry.target)
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return ref
}

/* ── slack ──────────────────────────────────────────────────────────────── */

/** The five pending submissions in the seeded workspace, in friendly-id order. */
const PENDING: Array<{ id: string; title: string; speaker: string; track: string }> = [
  {
    id: 'SESS-110',
    title: 'Small Models, Big Wins: The Case for 3B Parameters',
    speaker: 'Sarah Whitman',
    track: 'Engineering',
  },
  {
    id: 'SESS-111',
    title: 'Observability for LLM Applications',
    speaker: 'Raj Patel',
    track: 'Product',
  },
  {
    id: 'SESS-112',
    title: 'Synthetic Data Pipelines That Don’t Lie',
    speaker: 'Nina Sorensen',
    track: 'Research',
  },
  {
    id: 'SESS-113',
    title: 'From Notebook to Nginx: Serving Models in Rust',
    speaker: 'Lucas Meyer',
    track: 'Engineering',
  },
  {
    id: 'SESS-114',
    title: 'Designing Trustworthy AI Product Experiences',
    speaker: 'Hannah Cole',
    track: 'Product',
  },
]

function SlackDemo() {
  return (
    <div className="swd-slack">
      <div className="swd-sk-bar" aria-hidden="true">
        <img src={slackLogo} alt="" className="swd-sk-logo" />
        <b>Thread</b>
        <span>#program-team</span>
      </div>

      <div className="swd-sk-body">
        <div className="swd-sk-msg swd-st" style={at(0.1)}>
          <span className="swd-sk-av swd-sk-human" aria-hidden="true">
            BC
          </span>
          <div className="swd-sk-col">
            <div className="swd-sk-head">
              <b>Brandon Chu</b>
              <span className="swd-sk-ts">9:41 AM</span>
            </div>
            <p className="swd-sk-text">
              <span className="swd-sk-mention">@SpeakerWeave</span> what’s pending review?
            </p>
          </div>
        </div>

        {/* Held ~1.6s, then collapsed out of flow by the reply. */}
        <div className="swd-sk-thinkwrap" aria-hidden="true">
          <div className="swd-sk-think">
            <b>SpeakerWeave</b>
            <span>Finding answers…</span>
          </div>
        </div>

        <div className="swd-sk-div swd-st" style={at(2.55)} aria-hidden="true">
          <span>1 reply</span>
          <i />
        </div>

        <div className="swd-sk-msg">
          <span className="swd-sk-av swd-sk-app swd-st" style={at(2.65)} aria-hidden="true">
            S
          </span>
          <div className="swd-sk-col">
            <div className="swd-sk-head swd-st" style={at(2.65)}>
              <b>SpeakerWeave</b>
              <em className="swd-sk-badge">App</em>
              <span className="swd-sk-ts">9:41 AM</span>
            </div>
            <p className="swd-sk-text swd-st" style={at(2.8)}>
              There are <b>5 submissions pending review</b>:
            </p>
            <ul className="swd-sk-list">
              {PENDING.map((item, index) => (
                <li key={item.id} className="swd-st" style={at(2.95 + index * 0.1)}>
                  <b>
                    <span className="swd-id">{item.id}</span> — {item.title}
                  </b>{' '}
                  <span className="swd-sk-meta">
                    — {item.speaker} · {item.track}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="swd-sk-reply swd-st" style={at(3.6)} aria-hidden="true">
          Reply…
        </div>
      </div>
    </div>
  )
}

/* ── in-app Ask ─────────────────────────────────────────────────────────── */

/** Who still owes content before the Aug 27 deadline, and what. */
const OUTSTANDING: Array<{ name: string; owes: string; tone: string }> = [
  { name: 'Raj Patel', owes: 'headshot', tone: 'd-pend' },
  { name: 'Marco Bianchi', owes: 'headshot', tone: 'd-pend' },
  { name: 'Aisha Bello', owes: 'headshot', tone: 'd-pend' },
  { name: 'Omar Haddad', owes: 'headshot', tone: 'd-pend' },
  { name: 'Priya Raman', owes: 'slides', tone: 'd-pend' },
  { name: 'Yuki Tanaka', owes: 'bio · slides', tone: 'd-warn' },
]

function InAppDemo() {
  return (
    <div className="swd-app">
      <div className="swd-ap-bar">
        <b>Ask</b>
        <em className="swd-pill" aria-hidden="true">
          Chat
        </em>
        <span aria-hidden="true">AI Builders Summit</span>
      </div>

      <div className="swd-ap-body">
        <div className="swd-ap-you swd-st" style={at(0.3)}>
          who still owes content before Aug 27?
        </div>

        <div className="swd-ap-trace swd-st" style={at(0.95)} aria-hidden="true">
          read 11 speakers · 3 requirements
        </div>

        <p className="swd-ap-say swd-st" style={at(1.7)}>
          Six speakers are still outstanding. Four are missing only a headshot, so a single reminder
          clears most of it.
        </p>

        <ul className="swd-ap-list">
          {OUTSTANDING.map((person, index) => (
            <li key={person.name} className="swd-st" style={at(1.85 + index * 0.1)}>
              <span className={`swd-ap-who dotted ${person.tone}`}>{person.name}</span>
              <span className="swd-ap-owes">{person.owes}</span>
            </li>
          ))}
        </ul>

        <div className="swd-ap-acts swd-st" style={at(2.55)}>
          <span className="swd-act swd-act-p">Send to 6</span>
          <span className="swd-act">Review each</span>
          <span className="swd-act">Filter the table</span>
        </div>

        <div className="swd-ap-gate swd-st" style={at(2.85)}>
          <div className="swd-ap-gtop">
            <b>Approval needed</b>
            <span className="swd-ap-exp" aria-hidden="true">
              expires in 42s
            </span>
          </div>
          <p>
            Queue 6 reminder emails · deadline <span className="swd-id">2026-08-27</span>
          </p>
          <div className="swd-ap-gacts" aria-hidden="true">
            <span className="swd-act">Deny</span>
            <span className="swd-act swd-act-p">Approve</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── MCP connector ──────────────────────────────────────────────────────── */

function McpDemo() {
  return (
    <div className="swd-mcp">
      <div className="swd-mc-bar" aria-hidden="true">
        <i className="swd-mc-dots" />
        <span>New chat</span>
        <em>MCP</em>
      </div>

      <div className="swd-mc-body">
        <div className="swd-mc-you swd-st" style={at(0.3)}>
          What’s still pending review for the AI Builders Summit?
        </div>

        <div className="swd-mc-tool swd-st" style={at(0.95)}>
          <div className="swd-mc-trow">
            <span className="swd-mc-chip" aria-hidden="true">
              <i />
              SpeakerWeave
            </span>
            <span className="swd-id swd-mc-name">list_submissions</span>
            <span className="swd-mc-state" aria-hidden="true">
              <span className="swd-mc-run">
                <i />
                Running
              </span>
              <span className="swd-mc-ran">Ran · 1.2s</span>
            </span>
          </div>
          <div className="swd-mc-args" aria-hidden="true">
            {'{ "status": "pending", "event": "ai-builders-summit" }'}
          </div>
        </div>

        <p className="swd-mc-say swd-st" style={at(2.3)}>
          Five submissions are waiting on review — two in Engineering, two in Product, one in
          Research. The oldest, <span className="swd-id">SESS-110</span> (Sarah Whitman), has been
          sitting for nine days.
        </p>
        <p className="swd-mc-say swd-st" style={at(2.45)}>
          I can open a review round, or assign all five to Committee A. Deciding a submission needs
          your approval first.
        </p>

        <div className="swd-mc-input swd-st" style={at(3.3)} aria-hidden="true">
          Send a message…
        </div>

        <div className="swd-mc-foot swd-st" style={at(3.05)}>
          <span className="swd-mc-conn dotted d-acc">SpeakerWeave connector</span>
          <span aria-hidden="true">
            OAuth · org-scoped · <span className="swd-id">14 tools</span>
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

function CliDemo() {
  return (
    <div className="swd-cli">
      <div className="swd-cl-bar" aria-hidden="true">
        <i className="swd-mc-dots" />
        <span className="swd-id">sw — zsh</span>
      </div>

      <div className="swd-cl-body">
        <div className="swd-cl-line">
          <span className="swd-cl-p" aria-hidden="true">
            $
          </span>{' '}
          <span className="swd-cl-cmd">{'sw ask "who still owes content before Aug 27?"'}</span>
          <span className="swd-cl-cur" aria-hidden="true" />
        </div>
        <div className="swd-cl-out swd-st" style={at(2.55)}>
          → 6 speakers outstanding · 4 missing headshot only
        </div>
        <div className="swd-cl-dim swd-st" style={at(2.9)}>
          → raj.patel · marco.bianchi · aisha.bello · omar.haddad
        </div>
        <div className="swd-cl-dim swd-st" style={at(3.25)}>
          → run <span className="swd-cl-lit">sw remind --deadline 2026-08-27</span> to queue emails
        </div>
        <div className="swd-cl-line swd-cl-end swd-st" style={at(3.6)} aria-hidden="true">
          <span className="swd-cl-p">$</span> <span className="swd-cl-cur2" />
        </div>
      </div>
    </div>
  )
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const DEMOS: Record<AgentSurfaceId, () => ReactNode> = {
  slack: SlackDemo,
  'in-app': InAppDemo,
  mcp: McpDemo,
  cli: CliDemo,
}

/**
 * One faked demo for one agent surface, sized for a ~480–560px square slot.
 * The root is a `.rv` so it joins the page's reveal rhythm; everything inside
 * animates off `.in` landing on it.
 */
export function AgentSurfaceDemo({ surface }: { surface: AgentSurfaceId }): JSX.Element {
  const ref = useDemoReveal<HTMLDivElement>()
  const Demo = DEMOS[surface]

  return (
    <div ref={ref} className={`swd rv swd-${surface}-slot`} data-surface={surface}>
      <Demo />
    </div>
  )
}
