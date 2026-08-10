import React from 'react'
import { useStore, appStore } from '../state/AppState'
import type { OptionalComponentId } from '@shared/ipc'
import { toggleComputerUse } from '../lib/actions'

function fmtMb(sizeMb?: number): string {
  if (!sizeMb) return ''
  return `${sizeMb} MB`
}

const LABELS: Record<OptionalComponentId, string> = {
  opencode: 'opencode engine',
  'browser-core': 'Browser core',
  'computer-use': 'Computer use'
}

export function Footer(): React.JSX.Element {
  const optional = useStore(appStore, (s) => s.optional)
  const progress = useStore(appStore, (s) => s.optionalProgress)
  const computerUse = useStore(appStore, (s) => s.computerUse)
  const streaming = useStore(appStore, (s) => s.streaming)

  const download = async (id: OptionalComponentId): Promise<void> => {
    const res = await window.ralf.optionalDownload(id)
    if (!res.ok && res.error) console.error(`download ${id}: ${res.error}`)
  }

  return (
    <div className="footer">
      <span>Ralf</span>
      {optional.map((comp) => {
        const p = progress[comp.id]
        const busy = p && (p.phase === 'downloading' || p.phase === 'extracting')
        const label = LABELS[comp.id] ?? comp.id
        return (
          <button
            key={comp.id}
            className="btn-ghost"
            disabled={comp.installed || Boolean(busy)}
            onClick={() => void download(comp.id)}
            title={`${label} ${fmtMb(comp.sizeMb)}`}
          >
            {comp.installed
              ? `${label} ✓`
              : busy && p?.phase === 'downloading' && p.total
                ? `${label} ${Math.round(((p.received ?? 0) / p.total) * 100)}%`
                : busy
                  ? `${label}…`
                  : `Install ${label}`}
          </button>
        )
      })}
      <div className="right">
        {streaming && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="spinner" />
            working
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={computerUse.enabled}
            onChange={(e) => void toggleComputerUse(e.target.checked)}
          />
          Computer use
        </label>
      </div>
    </div>
  )
}
