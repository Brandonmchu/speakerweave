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
    expect(screen.getByRole('heading', { name: 'dais API', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/speaks Sessionboard/i)).toBeInTheDocument()
  })

  it('documents auth via the x-access-token header and the /v1 base path', () => {
    renderDocs()
    // Header name appears in prose and in the curl example.
    expect(screen.getAllByText(/x-access-token/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\/v1/).length).toBeGreaterThan(0)
  })

  it('lists the events, sessions and contacts endpoints with both list and search', () => {
    renderDocs()
    expect(screen.getByRole('heading', { name: 'List events' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'List sessions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Search sessions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'List contacts' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Search contacts' })).toBeInTheDocument()
    // GET/POST method tags are present.
    expect(screen.getAllByText('GET').length).toBeGreaterThan(0)
    expect(screen.getAllByText('POST').length).toBeGreaterThan(0)
  })

  it('documents pagination and friendly IDs', () => {
    renderDocs()
    expect(screen.getByText('Pagination')).toBeInTheDocument()
    expect(screen.getByText('Friendly IDs')).toBeInTheDocument()
    expect(screen.getAllByText(/SESS-8/).length).toBeGreaterThan(0)
  })

  it('exposes copy buttons on code blocks', () => {
    renderDocs()
    expect(screen.getAllByRole('button', { name: /copy code/i }).length).toBeGreaterThan(0)
  })
})
