/**
 * Shared chrome for the public site — the landing, the developers reference,
 * and the competition page.
 *
 * The site is the inverse of the admin app: ink ground, paper only in inserted
 * bands. All of the visual language lives in `styles/site.css` under `.sw-site`;
 * these components own the structure, the routes, and the motion.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import {
  CFP_FORM_URL,
  DEVELOPERS_URL,
  featuredScheduleUrl,
  featuredSpeakersUrl,
} from '@/lib/featuredEvent'
import { BrandMark } from '@/ui/brand'

export const REPO_URL = 'https://github.com/Brandonmchu/speakerweave'
export const DOCS_URL = 'https://speaker-weave.mintlify.site'
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

/** Crawlable links to the public conference surfaces. Plain in-app routes so a
 *  browser agent reading `href`s can discover every public page. */
export const EXPLORE = [
  { label: 'Schedule', to: featuredScheduleUrl },
  { label: 'Speakers', to: featuredSpeakersUrl },
  { label: 'Call for Speakers', to: CFP_FORM_URL },
  { label: 'Developers', to: DEVELOPERS_URL },
]

/**
 * The site owns the viewport ground while it is mounted, so an overscroll
 * bounce shows ink rather than the app's paper behind it.
 */
export function useSiteGround(): void {
  useEffect(() => {
    document.documentElement.classList.add('sw-site-active')
    document.body.classList.add('sw-site-active')
    return () => {
      document.documentElement.classList.remove('sw-site-active')
      document.body.classList.remove('sw-site-active')
    }
  }, [])
}

/**
 * One observer per page: `.in` lands once, at 18% visibility, on every `.rv`
 * and `.rule`. The feature demos key their own internal transitions off the
 * same class arriving on an ancestor, which is why this is a single sweep
 * rather than per-component state.
 *
 * Under `prefers-reduced-motion` everything is revealed synchronously — the
 * stylesheet has already dropped the transitions, so this just lands the final
 * state without asking the observer for permission.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const targets = root.querySelectorAll<HTMLElement>('.rv, .rule')

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduced || typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.classList.add('in'))
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
    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return ref
}

/** Sticky site nav. `badge` labels a sub-surface (e.g. the API reference). */
export function SiteNav({ badge }: { badge?: string }) {
  return (
    <nav className="nav" aria-label="Site">
      <Link to="/" className="brand" aria-label="SpeakerWeave home">
        <BrandMark tone="gradient" className="mark" />
        <span className="wordmark">SpeakerWeave</span>
      </Link>
      {badge && <span className="eyebrow">{badge}</span>}
      <div className="navlinks">
        {EXPLORE.map(({ label, to }) => (
          <Link key={label} to={to}>
            {label}
          </Link>
        ))}
        <a href={DOCS_URL}>Docs</a>
        <Link to="/speaker-signin" className="accent">
          Speaker sign in
        </Link>
      </div>
    </nav>
  )
}

export function SiteFooter() {
  return (
    <div className="wrap">
      <footer className="footer">
        <BrandMark tone="gradient" className="mark" />
        <span className="wordmark">SpeakerWeave</span>
        <nav className="footlinks" aria-label="Footer">
          {EXPLORE.map(({ label, to }) => (
            <Link key={label} to={to}>
              {label}
            </Link>
          ))}
          <Link to="/speaker-signin">Speaker sign in</Link>
          <a href={LICENSE_URL}>License</a>
          <a href={DOCS_URL}>Docs</a>
          <Link to="/killmysaas">Kill My SaaS</Link>
          <a href={REPO_URL}>GitHub</a>
        </nav>
      </footer>
    </div>
  )
}

/** The whole site frame: ink ground, sticky nav, skip link, footer. */
export function SiteShell({
  children,
  badge,
  footer = true,
}: {
  children: ReactNode
  badge?: string
  footer?: boolean
}) {
  useSiteGround()
  const ref = useReveal<HTMLDivElement>()

  return (
    <div className="sw-site" ref={ref}>
      <a href="#main-content" className="skip">
        Skip to content
      </a>
      <SiteNav badge={badge} />
      <main id="main-content">{children}</main>
      {footer && <SiteFooter />}
    </div>
  )
}
