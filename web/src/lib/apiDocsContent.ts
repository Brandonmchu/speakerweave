/**
 * Content for the public API docs page (route: /developers).
 *
 * Kept as data (not JSX) so the page is a thin renderer and the examples stay
 * copy-pasteable and easy to keep in sync with the backend's `/v1` serializers
 * in api/routes/v1_routes.py. This is the "dais speaks Sessionboard's protocol"
 * reference: base path, the x-access-token header, the list + /search variants,
 * the {data, page, pageSize, total} envelope, friendly IDs and pagination.
 */

export const API_BASE_PATH = '/v1'
export const AUTH_HEADER = 'x-access-token'

export interface DocParam {
  name: string
  type: string
  description: string
}

export interface DocEndpoint {
  /** Anchor id + nav label. */
  id: string
  method: 'GET' | 'POST'
  path: string
  title: string
  description: string
  params?: DocParam[]
  /** A ready-to-run curl example. */
  request: string
  /** The JSON body a successful call returns. */
  response: string
}

export interface DocSection {
  id: string
  title: string
  endpoints: DocEndpoint[]
}

const PAGINATION_PARAMS: DocParam[] = [
  { name: 'page', type: 'integer', description: '1-based page number (1–999). Defaults to 1.' },
  {
    name: 'pageSize',
    type: 'integer',
    description: 'Items per page. Defaults to 25, maximum 100.',
  },
]

const STATUS_PARAM: DocParam = {
  name: 'status',
  type: 'string',
  description:
    'Optional. One of draft, pending, accept_queue, accepted, decline_queue, declined, withdrawn.',
}

const SESSIONS_RESPONSE = `{
  "data": [
    {
      "id": "b1e5c2a0-6d3f-4e9a-9f21-0a2b3c4d5e6f",
      "friendly_id": "SESS-8",
      "title": "Scaling Vector Search to a Billion Embeddings",
      "description": "<p>A deep dive into ANN indexes…</p>",
      "status": "accepted",
      "starts_at": "2026-09-14T17:00:00+00:00",
      "ends_at": "2026-09-14T17:45:00+00:00",
      "is_abstract": false,
      "room": { "id": "9c1…", "name": "Main Hall", "capacity": 300 },
      "track": { "id": "3af…", "name": "AI Infrastructure", "color": "#4962E2" },
      "speakers": [
        { "id": "7d2…", "full_name": "Grace Hopper", "email": "grace@example.com" }
      ]
    }
  ],
  "page": 1,
  "pageSize": 25,
  "total": 1
}`

const CONTACTS_RESPONSE = `{
  "data": [
    {
      "id": "7d2f9b10-2c44-4a1e-8b3d-9e0f1a2b3c4d",
      "full_name": "Ada Lovelace",
      "email": "ada@example.com",
      "company_name": "Analytical Engines",
      "title": "Principal Engineer",
      "about": "Works on compilers and program synthesis."
    }
  ],
  "page": 1,
  "pageSize": 25,
  "total": 1
}`

export const AUTH_EXAMPLE = `curl https://your-dais-host${API_BASE_PATH}/events \\
  -H "${AUTH_HEADER}: dais_9f8c7b6a5d4e3f2a1b0c9d8e7f6a5b4c"`

export const DOC_SECTIONS: DocSection[] = [
  {
    id: 'events',
    title: 'Events',
    endpoints: [
      {
        id: 'list-events',
        method: 'GET',
        path: `${API_BASE_PATH}/events`,
        title: 'List events',
        description: "Every event in the token's organization, newest first.",
        request: `curl https://your-dais-host${API_BASE_PATH}/events \\
  -H "${AUTH_HEADER}: $DAIS_API_KEY"`,
        response: `{
  "data": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "AI Builders Summit",
      "slug": "ai-builders-summit",
      "starts_at": "2026-09-14T16:00:00+00:00",
      "ends_at": "2026-09-16T02:00:00+00:00",
      "timezone": "America/Los_Angeles"
    }
  ]
}`,
      },
    ],
  },
  {
    id: 'sessions',
    title: 'Sessions',
    endpoints: [
      {
        id: 'list-sessions',
        method: 'GET',
        path: `${API_BASE_PATH}/events/{event_id}/sessions`,
        title: 'List sessions',
        description:
          "Sessions for an event, with their room, track and speakers nested inline. Unscheduled sessions sort last.",
        params: [STATUS_PARAM, ...PAGINATION_PARAMS],
        request: `curl "https://your-dais-host${API_BASE_PATH}/events/{event_id}/sessions?status=accepted&pageSize=25" \\
  -H "${AUTH_HEADER}: $DAIS_API_KEY"`,
        response: SESSIONS_RESPONSE,
      },
      {
        id: 'search-sessions',
        method: 'POST',
        path: `${API_BASE_PATH}/events/{event_id}/sessions/search`,
        title: 'Search sessions',
        description:
          "The POST twin of the list endpoint — same result envelope, filters in a JSON body (Sessionboard's POST /resource = search convention).",
        params: [STATUS_PARAM, ...PAGINATION_PARAMS],
        request: `curl -X POST https://your-dais-host${API_BASE_PATH}/events/{event_id}/sessions/search \\
  -H "${AUTH_HEADER}: $DAIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "status": "accepted", "page": 1, "pageSize": 25 }'`,
        response: SESSIONS_RESPONSE,
      },
    ],
  },
  {
    id: 'contacts',
    title: 'Contacts',
    endpoints: [
      {
        id: 'list-contacts',
        method: 'GET',
        path: `${API_BASE_PATH}/events/{event_id}/contacts`,
        title: 'List contacts',
        description: 'Speakers and people attached to an event, sorted by name.',
        params: PAGINATION_PARAMS,
        request: `curl "https://your-dais-host${API_BASE_PATH}/events/{event_id}/contacts?pageSize=25" \\
  -H "${AUTH_HEADER}: $DAIS_API_KEY"`,
        response: CONTACTS_RESPONSE,
      },
      {
        id: 'search-contacts',
        method: 'POST',
        path: `${API_BASE_PATH}/events/{event_id}/contacts/search`,
        title: 'Search contacts',
        description: 'The POST twin of the contacts list — same envelope, paging in a JSON body.',
        params: PAGINATION_PARAMS,
        request: `curl -X POST https://your-dais-host${API_BASE_PATH}/events/{event_id}/contacts/search \\
  -H "${AUTH_HEADER}: $DAIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "page": 1, "pageSize": 25 }'`,
        response: CONTACTS_RESPONSE,
      },
    ],
  },
]
