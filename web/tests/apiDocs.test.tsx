import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { ApiDocs } from '@/pages/ApiDocs'

function renderDocs() {
  return render(
    <MemoryRouter initialEntries={['/developers']}>
      <ApiDocs />
    </MemoryRouter>
  )
}

describe('ApiDocs page', () => {
  it('renders the title and the "speaks Sessionboard\'s protocol" story', () => {
    renderDocs()
    expect(screen.getByRole('heading', { name: 'SpeakerWeave API', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/speaks Sessionboard/i)).toBeInTheDocument()
    expect(screen.getByText(/The Slack bot is the same agent as in-app Ask/i)).toBeInTheDocument()
  })

  it('documents auth via the x-access-token header and the /v1 base path', () => {
    renderDocs()
    // Header name appears in prose and in the curl example.
    expect(screen.getAllByText(/x-access-token/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\/v1/).length).toBeGreaterThan(0)
  })

  it('lists the broadened REST surface in an endpoint table', () => {
    renderDocs()
    expect(screen.getByRole('heading', { name: 'REST endpoints' })).toBeInTheDocument()
    expect(screen.getAllByText('/v1/events/{event_id}/submissions').length).toBeGreaterThan(0)
    expect(screen.getAllByText('/v1/speakers/{speaker_id}').length).toBeGreaterThan(0)
    expect(screen.getByText('/v1/events/{event_id}/schedule')).toBeInTheDocument()
    expect(screen.getByText('/v1/events/{event_id}/content-items')).toBeInTheDocument()
    expect(screen.getByText('/v1/events/{event_id}/content-status')).toBeInTheDocument()
    expect(screen.getByText('/v1/evaluation-plans/{plan_id}/summary')).toBeInTheDocument()
    expect(screen.getAllByText('GET').length).toBeGreaterThan(0)
    expect(screen.getAllByText('POST').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PATCH').length).toBeGreaterThan(0)
    expect(screen.getAllByText('PUT').length).toBeGreaterThan(0)
    expect(screen.getAllByText('DELETE').length).toBeGreaterThan(0)
  })

  it('documents pagination, filters, and errors', () => {
    renderDocs()
    expect(screen.getByText('Pagination')).toBeInTheDocument()
    expect(screen.getByText('Filtering')).toBeInTheDocument()
    expect(screen.getByText('Errors & fields')).toBeInTheDocument()
  })

  it('documents the hosted MCP endpoint, auth, resources, and tools', () => {
    renderDocs()
    expect(screen.getByRole('heading', { name: 'MCP server' })).toBeInTheDocument()
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument()
    expect(screen.getByText(/Connector UI \(recommended\)/i)).toBeInTheDocument()
    expect(screen.getByText(/claude\.ai, Claude for Work, or ChatGPT/i)).toBeInTheDocument()
    expect(screen.getByText(/No custom headers are needed/i)).toBeInTheDocument()
    expect(screen.getByText(/Power-user path/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Bearer dais_your_api_token/).length).toBeGreaterThan(0)
    expect(screen.getByText('list_submissions')).toBeInTheDocument()
    expect(screen.getByText('remind_outstanding_content')).toBeInTheDocument()
    expect(screen.getByText('ai_triage')).toBeInTheDocument()
  })

  it('exposes copy buttons on code blocks', () => {
    renderDocs()
    expect(screen.getAllByRole('button', { name: /copy code/i }).length).toBeGreaterThan(0)
  })
})
