import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Room } from '../../../shared/types'
import { Lobby } from './Lobby'

function playingRoom(characterIds: string[]): Room {
  return {
    id: 'room-id',
    code: '012345',
    sceneId: 'a-small-step',
    hostId: 'host',
    status: 'playing',
    startedAt: 1234,
    players: [
      {
        id: 'host',
        nickname: 'Kurucu',
        connected: true,
        ready: true,
        characterIds: ['nova', 'echo'],
      },
      {
        id: 'extra',
        nickname: 'Fazla Oyuncu',
        connected: true,
        ready: true,
        characterIds,
      },
    ],
    expiresAt: Date.now() + 10_000,
    revision: 5,
  }
}

describe('started game lobby shell', () => {
  it('shows a natural Turkish no-character message without recording controls', () => {
    render(
      <MemoryRouter>
        <Lobby
          room={playingRoom([])}
          playerId="extra"
          connectionStatus="connected"
          error={null}
          pending={false}
          saved
          onReady={vi.fn()}
          onStart={vi.fn()}
          onLeave={vi.fn()}
          onReconnect={vi.fn()}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Oyun başladı.' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bu turda karakterin yok' })).toBeInTheDocument()
    expect(screen.getByText(/bu sahnede sana rol düşmedi/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Oyunu Başlat' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Kaydı başlat/)).not.toBeInTheDocument()
  })
})
