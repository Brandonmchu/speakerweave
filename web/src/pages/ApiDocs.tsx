/**
 * Public REST and hosted MCP reference (route: /developers).
 *
 * Same site language as the landing — dark nav and footer — but the document
 * body is a full-bleed paper band, which is the site's rule for a surface that
 * shows the product rather than sells it, and the right ground for long-form
 * reading. Narrative guides live on the hosted docs site; this page is the
 * one-screen reference an integrator or an agent can read end to end.
 */
import { Link } from 'react-router-dom'

import {
  API_BASE_PATH,
  AUTH_EXAMPLE,
  AUTH_HEADER,
  CURL_EXAMPLES,
  MCP_TOOLS,
  REST_ENDPOINTS,
  type HttpMethod,
} from '@/lib/apiDocsContent'
import { CodeBlock, DOCS_URL, SiteShell } from '@/pages/siteShared'

const NAV_ITEMS = [
  { id: 'base-url', label: 'Base URL' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'conventions', label: 'Conventions' },
  { id: 'endpoints', label: 'REST endpoints' },
  { id: 'examples', label: 'curl examples' },
  { id: 'mcp-server', label: 'MCP server' },
  { id: 'mcp-tools', label: 'MCP tools' },
]

const METHOD_CLASS: Record<HttpMethod, string> = {
  GET: 'm-get',
  POST: 'm-post',
  PATCH: 'm-patch',
  PUT: 'm-put',
  DELETE: 'm-delete',
}

export function ApiDocs() {
  const mcpEndpoint = `${window.location.origin}/mcp`
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        speakerweave: {
          type: 'http',
          url: mcpEndpoint,
          headers: { Authorization: 'Bearer dais_your_api_token' },
        },
      },
    },
    null,
    2
  )

  return (
    <SiteShell badge="API reference">
      <div className="doc">
        <div className="wrap doclayout">
          <nav className="docnav" aria-label="On this page">
            {NAV_ITEMS.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </nav>

          <div>
            <section className="docsect">
              <p className="eyebrow">Developers</p>
              <h1>SpeakerWeave API</h1>
              <p className="lede">
                A complete integration surface for events, submissions, speakers, schedules,
                content, and evaluations — available as REST for software and MCP for AI agents.
              </p>
              <p>
                The Slack bot is the same agent as in-app Ask: the same organization-scoped tools,
                connected MCP servers, persisted threads, and permission gate. Approve or deny
                sensitive actions directly from Slack. The hosted MCP server exposes the same
                conference operations to external clients. Full guides and an interactive API
                reference live at <a href={DOCS_URL}>the documentation site</a>.
              </p>

              <div className="callout">
                <b>SpeakerWeave speaks Other Conference/CFP Software&rsquo;s protocol.</b>
                <p>
                  Existing integrations can keep the <code className="m">{API_BASE_PATH}</code> base
                  path and <code className="m">{AUTH_HEADER}</code> authentication convention, while
                  new agent workflows connect directly to the hosted MCP server.
                </p>
              </div>
            </section>

            <section id="base-url" className="docsect">
              <h2>Base URL</h2>
              <p>
                REST endpoints are relative to your SpeakerWeave host and live under{' '}
                <code className="m">{API_BASE_PATH}</code>.
              </p>
              <CodeBlock code={`https://your-dais-host${API_BASE_PATH}`} />
            </section>

            <section id="authentication" className="docsect">
              <h2>Authentication</h2>
              <p>
                Send every REST request with{' '}
                <code className="m">{AUTH_HEADER}: dais_your_api_token</code>. Generate tokens from{' '}
                <span className="kbd">Settings → API tokens</span>; the raw value is shown once.
                Each token resolves to one organization, and resources outside that organization
                return <code className="m">404</code>.
              </p>
              <p>
                Prefer a terminal? From a checkout, run <code className="m">pipx install ./cli</code>
                , then <code className="m">sw auth login</code> with the same organization API
                token.
              </p>
              <CodeBlock code={AUTH_EXAMPLE} />
            </section>

            <section id="conventions" className="docsect">
              <h2>Conventions</h2>
              <div className="grid3">
                <div>
                  <h3>Pagination</h3>
                  <p>
                    Lists accept <code className="m">page</code> (1-based) and{' '}
                    <code className="m">pageSize</code> (default 25, max 100), and return{' '}
                    <code className="m">{'{ data, page, pageSize, total }'}</code>.
                  </p>
                </div>
                <div>
                  <h3>Filtering</h3>
                  <p>
                    Use <code className="m">status</code>, <code className="m">track</code>,{' '}
                    <code className="m">filter</code>, or <code className="m">type</code> where
                    shown. Session and submission paths are aliases.
                  </p>
                </div>
                <div>
                  <h3>Errors &amp; fields</h3>
                  <p>
                    Fields are <code className="m">snake_case</code>, times are ISO-8601, invalid
                    input is <code className="m">400</code>, and missing or cross-org resources are{' '}
                    <code className="m">404</code>.
                  </p>
                </div>
              </div>
            </section>

            <section id="endpoints" className="docsect">
              <h2>REST endpoints</h2>
              <div className="tablewrap">
                <table className="doctable">
                  <thead>
                    <tr>
                      <th style={{ width: 88 }}>Method</th>
                      <th>Path</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {REST_ENDPOINTS.map((endpoint) => (
                      <tr key={`${endpoint.method}-${endpoint.path}`}>
                        <td>
                          <span className={`method ${METHOD_CLASS[endpoint.method]}`}>
                            {endpoint.method}
                          </span>
                        </td>
                        <td>
                          <code>
                            {API_BASE_PATH}
                            {endpoint.path}
                          </code>
                        </td>
                        <td>{endpoint.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section id="examples" className="docsect">
              <h2>curl examples</h2>
              {CURL_EXAMPLES.map((example) => (
                <div key={example.title} style={{ marginTop: 28 }}>
                  <h3>{example.title}</h3>
                  <p>{example.description}</p>
                  <CodeBlock code={example.code} />
                </div>
              ))}
            </section>

            <section id="mcp-server" className="docsect">
              <h2>MCP server</h2>
              <div className="callout">
                <b>Connector UI (recommended)</b>
                <p>
                  In claude.ai, Claude for Work, or ChatGPT, add a custom connector with URL{' '}
                  <code className="m">{mcpEndpoint}</code>. You&rsquo;ll be asked to authorize with
                  an API token from <span className="kbd">Settings → API tokens</span>. No custom
                  headers are needed.
                </p>
              </div>
              <p>
                Power-user path: Streamable-HTTP clients that support custom headers can use the
                same organization API token as REST, supplied as{' '}
                <code className="m">Authorization: Bearer …</code>. Add this entry to your
                client&rsquo;s MCP JSON configuration:
              </p>
              <CodeBlock code={mcpConfig} />

              <div className="docrule" style={{ marginTop: 32 }}>
                <h3>Resources</h3>
                <p>
                  Event-scoped JSON resources are available at{' '}
                  <code className="m">dais://events/{'{event}'}/schedule</code>,{' '}
                  <code className="m">dais://events/{'{event}'}/speakers</code>, and{' '}
                  <code className="m">dais://events/{'{event}'}/content-status</code>.
                </p>
              </div>
            </section>

            <section id="mcp-tools" className="docsect">
              <h2>Available tools</h2>
              <p>All tools are scoped to the token&rsquo;s organization.</p>
              <dl style={{ marginTop: 20 }}>
                {MCP_TOOLS.map((tool) => (
                  <div key={tool.name} className="toolrow">
                    <dt>
                      <code>{tool.name}</code>
                    </dt>
                    <dd>{tool.description}</dd>
                  </div>
                ))}
              </dl>
              <p style={{ marginTop: 28 }}>
                Manage API tokens in <Link to="/settings">Settings</Link>.
              </p>
            </section>
          </div>
        </div>
      </div>
    </SiteShell>
  )
}
