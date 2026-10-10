import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../App'

afterEach(() => vi.unstubAllGlobals())

describe('room entry', () => {
  it('asks for nickname on a direct room link without sending a join request', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(
      <MemoryRouter initialEntries={['/room/012345']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Oda kodu')).toHaveValue('012345')
    expect(screen.getByLabelText('Takma adın')).toHaveValue('')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('validates room input before making a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/join']}>
        <App />
      </MemoryRouter>,
    )
    await user.type(screen.getByLabelText('Takma adın'), 'Guest')
    await user.type(screen.getByLabelText('Oda kodu'), '123')
    await user.click(screen.getByRole('button', { name: 'Odaya katıl' }))
    expect(screen.getByRole('alert')).toHaveTextContent('tam 6 rakam')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('shows nickname conflicts from the server without navigating', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'NICKNAME_TAKEN',
            message: 'That takma ad odada zaten in this room. Try another one.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/room/012345']}>
        <App />
      </MemoryRouter>,
    )
    await user.type(screen.getByLabelText('Takma adın'), 'Guest')
    await user.click(screen.getByRole('button', { name: 'Odaya katıl' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('takma ad odada zaten')
    expect(screen.getByRole('button', { name: 'Odaya katıl' })).toBeEnabled()
  })
  it('reuses the same join credentials after a lost response', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('connection reset'))
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/room/012345']}>
        <App />
      </MemoryRouter>,
    )
    await user.type(screen.getByLabelText('Takma adın'), 'Deniz')
    await user.click(screen.getByRole('button', { name: 'Odaya katıl' }))
    await screen.findByText(/Oda servisine ulaşılamadı/)
    await user.click(screen.getByRole('button', { name: 'Odaya katıl' }))
    await screen.findByText(/Oda servisine ulaşılamadı/)
    expect(fetch).toHaveBeenCalledTimes(2)
    const first = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as unknown
    const second = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as unknown
    expect(second).toEqual(first)
  })
  it('provides recovery for a malformed direct room URL', () => {
    render(
      <MemoryRouter initialEntries={['/room/not-a-code']}>
        <App />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Geçersiz oda kodu' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Oda kodunu gir' })).toHaveAttribute('href', '/join')
  })
})
