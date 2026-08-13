/**
 * `/judge` — one URL to hand somebody who has to evaluate this thing.
 *
 * Everything a judge needs is already public elsewhere on the site; what they
 * do not have is a single page that says, in order: here are the three doors,
 * here is what is behind each one, here is what happens to what you change,
 * here is the machine-readable surface, and here is the scorecard somebody else
 * produced. No access code — gating a demo behind a code you then have to paste
 * into the submission is a step that only exists to protect the demo from its
 * own audience, and this one is seeded and reseedable instead.
 */
import { Link } from 'react-router-dom'

import { DEVELOPERS_URL, featuredScheduleUrl } from '@/lib/featuredEvent'
import { DemoDoors, useDemoEntry } from '@/pages/demoDoors'
import { DOCS_URL, REPO_URL, SiteShell } from '@/pages/siteShared'

/** The non-UI surfaces, which a judge can exercise without clicking anything. */
const MACHINE_SURFACES: Array<{ label: string; body: string; href?: string; to?: string }> = [
  {
    label: 'MCP server',
    body: 'Add https://speakerweave.com/mcp to Claude or ChatGPT as a connector — OAuth, 16 organization-scoped tools, 4 resources.',
    href: `${DOCS_URL}/ai/mcp`,
  },
  {
    label: 'REST API',
    body: 'A stable /v1 surface with organization-scoped tokens, an in-app reference with copyable curl, and a generated OpenAPI explorer.',
    to: DEVELOPERS_URL,
  },
  {
    label: 'Public program data',
    body: 'The published schedule, speaker gallery, embeds, iCal feed and read-only JSON — no key required.',
    to: featuredScheduleUrl,
  },
  {
    label: 'Source',
    body: 'MIT licensed end to end, including the seeder that builds the workspace these doors open.',
    href: REPO_URL,
  },
]

export function Judge() {
  const { loading, error, enterAs } = useDemoEntry()

  return (
    <SiteShell badge="Judge access">
      <section className="wrap sect">
        <div className="rv in" style={{ maxWidth: '64ch' }}>
          <p className="eyebrow">Shared demo · no code, no sign-up</p>
          <h1 className="h1 serif">Open it as whoever you need to be.</h1>
          <p className="lede">
            One seeded conference — AI Builders Summit 2026, twenty submissions, a scored review
            round, a partly built agenda — and three ways into it. Each door lands in the surface
            that audience actually uses, with that audience&rsquo;s permissions.
          </p>
        </div>

        <div className="rv" style={{ marginTop: 26 }}>
          <DemoDoors enterAs={enterAs} loading={loading} detail />
          {error && <p className="err">{error}</p>}
        </div>

        <p className="note rv" style={{ maxWidth: '74ch', marginTop: 20 }}>
          The workspace is shared and the changes you make are real — accept a submission, drag a
          session, send a reminder, and the next visitor sees it. Nothing is destroyed: every
          decision is reversible in the UI, content keeps its versions, and the whole workspace can
          be rebuilt from the seeder in one command.
        </p>
      </section>

      <section className="light">
        <div className="wrap">
          <div className="rv" style={{ maxWidth: '58ch' }}>
            <p className="eyebrow">Without clicking anything</p>
            <h2 className="h2 serif">The same program, machine-readable.</h2>
            <p className="lede">
              Every surface below reads and writes the same organization-scoped data as the screens
              above, under the same permissions and the same approval gates.
            </p>
          </div>
          <div className="surfacecards rv" style={{ marginTop: 30 }}>
            {MACHINE_SURFACES.map(({ label, body, href, to }) => (
              <div key={label}>
                <b>{label}</b>
                <p>{body}</p>
                {to ? (
                  <Link to={to} className="arrowlink">
                    Open →
                  </Link>
                ) : (
                  <a href={href} className="arrowlink">
                    Open →
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="wrap sect">
        <div className="proof rv">
          <b>100 / 100</b>
          <p>
            on the independent Other Conference/CFP Software evaluation — all seven areas, 96 rubric items, 197
            weighted points, graded by a browser agent driving this same deployment.
          </p>
          <Link to="/killmysaas" className="arrowlink">
            Read the scorecard →
          </Link>
        </div>
      </section>
    </SiteShell>
  )
}

export default Judge
