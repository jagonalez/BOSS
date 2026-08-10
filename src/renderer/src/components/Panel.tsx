import React, { useState } from 'react'
import { useStore, appStore, type PanelKind } from '../state/AppState'
import { ReviewTab } from './ReviewTab'
import { FilesTab } from './FilesTab'
import { BrowseTab } from './BrowseTab'
import { TerminalTab } from './TerminalTab'
import { ChatView } from './ChatView'
import { closePanelTab, openPanelTab } from '../lib/actions'
import { ChatIcon, FilesIcon, GlobeIcon, PlusIcon, ReviewIcon, TerminalIcon } from './icons'

export const PANEL_KINDS: Array<{ kind: PanelKind; label: string; icon: (p: { size?: number }) => React.JSX.Element }> = [
  { kind: 'review', label: 'Review', icon: ReviewIcon },
  { kind: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { kind: 'browse', label: 'Browser', icon: GlobeIcon },
  { kind: 'files', label: 'Files', icon: FilesIcon },
  { kind: 'chat', label: 'Side chat', icon: ChatIcon }
]

export function AddPanelView(): React.JSX.Element {
  return (
    <div className="panel">
      <div className="panel-add">
        <div className="panel-add-title">Add to panel</div>
        <div className="panel-add-grid">
          {PANEL_KINDS.map((k) => {
            const Icon = k.icon
            return (
              <button key={k.kind} className="panel-add-btn" onClick={() => void openPanelTab(k.kind)}>
                <span className="icon">
                  <Icon size={18} />
                </span>
                <span>{k.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function AddBar(): React.JSX.Element {
  return (
    <div className="add-bar">
      {PANEL_KINDS.map((k) => {
        const Icon = k.icon
        return (
          <button key={k.kind} className="add-bar-btn" onClick={() => void openPanelTab(k.kind)} title={k.label}>
            <Icon size={18} />
          </button>
        )
      })}
    </div>
  )
}

function PanelResizer(): React.JSX.Element {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const move = (ev: MouseEvent): void => {
      const width = window.innerWidth - ev.clientX
      const max = Math.floor(window.innerWidth * 0.75)
      appStore.setState({ panelWidth: Math.min(Math.max(width, 320), max) })
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className="panel-resizer" onMouseDown={onMouseDown} />
}

export function Panel(): React.JSX.Element {
  const tabs = useStore(appStore, (s) => s.tabs)
  const activeTabId = useStore(appStore, (s) => s.activeTabId)
  const panelWidth = useStore(appStore, (s) => s.panelWidth)
  const [adding, setAdding] = useState(false)

  if (tabs.length === 0) {
    return (
      <div className="panel" style={{ width: panelWidth }}>
        <PanelResizer />
        <div className="panel-add">
          <div className="panel-add-title">Add to panel</div>
          <div className="panel-add-grid">
            {PANEL_KINDS.map((k) => {
              const Icon = k.icon
              return (
                <button key={k.kind} className="panel-add-btn" onClick={() => void openPanelTab(k.kind)}>
                  <span className="icon">
                    <Icon size={18} />
                  </span>
                  <span>{k.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1]

  return (
    <div className="panel" style={{ width: panelWidth }}>
      <PanelResizer />
      <div className="panel-tabs">
        {tabs.map((tab) => {
          const def = PANEL_KINDS.find((k) => k.kind === tab.kind)!
          const Icon = def.icon
          return (
            <div
              key={tab.id}
              className={`panel-tab ${tab.id === active.id ? 'active' : ''}`}
              onClick={() => appStore.setState({ activeTabId: tab.id })}
              title={def.label}
            >
              <span className="icon">
                <Icon size={13} />
              </span>
              <span className="panel-tab-label">{def.label}</span>
              <button className="tab-close" onClick={(e) => { e.stopPropagation(); closePanelTab(tab.id) }} title="Close">
                ×
              </button>
            </div>
          )
        })}
        <button className="tab-add" onClick={() => setAdding((o) => !o)} title="Add tab">
          <PlusIcon size={13} />
        </button>
      </div>
      {adding && (
        <div className="tab-add-menu">
          {PANEL_KINDS.map((k) => {
            const Icon = k.icon
            return (
              <button
                key={k.kind}
                className="tab-add-item"
                onClick={() => {
                  void openPanelTab(k.kind)
                  setAdding(false)
                }}
              >
                <span className="icon">
                  <Icon size={14} />
                </span>
                {k.label}
              </button>
            )
          })}
        </div>
      )}
      <div className="panel-content">
        {active.kind === 'review' && <ReviewTab />}
        {active.kind === 'files' && <FilesTab />}
        {active.kind === 'browse' && <BrowseTab />}
        {active.kind === 'terminal' && <TerminalTab />}
        {active.kind === 'chat' && <ChatView sessionId={active.sessionId} />}
      </div>
    </div>
  )
}
