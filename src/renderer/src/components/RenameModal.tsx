import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { renameSessionById } from '../lib/actions'

export function RenameModal(): React.JSX.Element | null {
  const target = useStore(appStore, (s) => s.renameTarget)
  const sessions = useStore(appStore, (s) => s.sessions)
  const [name, setName] = useState('')

  useEffect(() => {
    const s = sessions.find((x) => x.id === target)
    setName(s?.title ?? '')
  }, [target, sessions])

  if (!target) return null

  const save = async (): Promise<void> => {
    if (name.trim()) await renameSessionById(target, name.trim())
    appStore.setState({ renameTarget: null })
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Rename chat</h3>
        <input
          className="commit-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          autoFocus
          spellCheck={false}
        />
        <div className="actions">
          <button className="btn-deny" onClick={() => appStore.setState({ renameTarget: null })}>
            Cancel
          </button>
          <button className="btn-allow" onClick={() => void save()}>
            Rename
          </button>
        </div>
      </div>
    </div>
  )
}
