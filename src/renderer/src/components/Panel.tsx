import React, { useState } from 'react'
import { useStore, appStore, type PanelGroup, type PanelKind, type PanelTab } from '../state/AppState'
import { ReviewTab } from './ReviewTab'
import { FilesTab } from './FilesTab'
import { BrowseTab } from './BrowseTab'
import { TerminalTab } from './TerminalTab'
import { ChatView } from './ChatView'
import { addPanelGroup, closePanelTab, openPanelTab, setPanelWidth } from '../lib/actions'
import { ChatIcon, FilesIcon, GlobeIcon, PlusIcon, ReviewIcon, TerminalIcon } from './icons'

const MIN_GROUP = 300

function clampWidth(w: number): number {
  return Math.min(Math.max(Math.round(w), MIN_GROUP), 1400)
}

const PANEL_KINDS: Array<{ kind: PanelKind; label: string; icon: (p: { size?: number }) => React.JSX.Element }> = [
  { kind: 'review', label: 'Review', icon: ReviewIcon },
  { kind: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { kind: 'browse', label: 'Browser', icon: GlobeIcon },
  { kind: 'files', label: 'Files', icon: FilesIcon },
  { kind: 'chat', label: 'Side chat', icon: ChatIcon }
]

const SINGLE_KINDS: PanelKind[] = ['review', 'files']

function useExistingKinds(): Set<PanelKind> {
  return useStore(appStore, (s) => new Set(s.panelGroups.flatMap((g) => g.tabs.map((t) => t.kind))))
}

function addableKinds(existing: Set<PanelKind>): Array<(typeof PANEL_KINDS)[number]> {
  return PANEL_KINDS.filter((k) => !SINGLE_KINDS.includes(k.kind) || !existing.has(k.kind))
}

function TabContent({ tab }: { tab: PanelTab }): React.JSX.Element {
  switch (tab.kind) {
    case 'review':
      return <ReviewTab />
    case 'files':
      return <FilesTab />
    case 'browse':
      return <BrowseTab id={tab.id} />
    case 'terminal':
      return <TerminalTab />
    case 'chat':
      return <ChatView sessionId={tab.sessionId} />
  }
}

function Splitter({ left, right }: { left: PanelGroup; right: PanelGroup }): React.JSX.Element {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const leftW = left.width
    const rightW = right.width
    const move = (ev: MouseEvent): void => {
      const delta = ev.clientX - startX
      setPanelWidth(left.id, clampWidth(leftW + delta))
      setPanelWidth(right.id, clampWidth(rightW - delta))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className="panel-splitter" onMouseDown={onMouseDown} />
}

function LeftResizer({ group }: { group: PanelGroup }): React.JSX.Element {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = group.width
    const move = (ev: MouseEvent): void => {
      setPanelWidth(group.id, clampWidth(startW + (startX - ev.clientX)))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className="panel-splitter panel-left-resizer" onMouseDown={onMouseDown} />
}

function AddPanelView({ group }: { group: PanelGroup }): React.JSX.Element {
  const existing = useExistingKinds()
  return (
    <div className="panel-add">
      <div className="panel-add-title">Add to panel</div>
      <div className="panel-add-grid">
        {addableKinds(existing).map((k) => {
          const Icon = k.icon
          return (
            <button key={k.kind} className="panel-add-btn" onClick={() => void openPanelTab(k.kind, group.id)}>
              <span className="icon">
                <Icon size={18} />
              </span>
              <span>{k.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function GroupPanel({ group }: { group: PanelGroup }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const existing = useExistingKinds()
  const active = group.tabs.find((t) => t.id === group.activeTabId) ?? group.tabs[group.tabs.length - 1]

  const reorder = (from: number, to: number): void => {
    if (from === to) return
    appStore.setState((s) => ({
      panelGroups: s.panelGroups.map((g) => {
        if (g.id !== group.id) return g
        const tabs = [...g.tabs]
        const [moved] = tabs.splice(from, 1)
        tabs.splice(to, 0, moved)
        return { ...g, tabs }
      })
    }))
  }

  const toggleAdd = (e: React.MouseEvent): void => {
    const next = !adding
    setAdding(next)
    if (next) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setMenuPos({ x: r.left, y: r.bottom + 4 })
    }
  }

  return (
    <div className="panel-group" style={{ width: group.width }}>
      {group.tabs.length > 0 ? (
        <>
          <div className="panel-tabs">
            {group.tabs.map((tab, i) => {
              const def = PANEL_KINDS.find((k) => k.kind === tab.kind)!
              const Icon = def.icon
              return (
                <div
                  key={tab.id}
                  className={`panel-tab ${tab.id === active.id ? 'active' : ''} ${dragIndex != null && overIndex === i ? 'drag-over' : ''} ${dragIndex === i ? 'dragging' : ''}`}
                  onClick={() =>
                    appStore.setState((s) => ({
                      panelGroups: s.panelGroups.map((g) => (g.id === group.id ? { ...g, activeTabId: tab.id } : g))
                    }))
                  }
                  title={def.label}
                  draggable
                  onDragStart={() => {
                    setDragIndex(i)
                    setOverIndex(null)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (dragIndex != null && i !== dragIndex) setOverIndex(i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIndex != null) reorder(dragIndex, i)
                    setDragIndex(null)
                    setOverIndex(null)
                  }}
                  onDragEnd={() => {
                    setDragIndex(null)
                    setOverIndex(null)
                  }}
                >
                  <span className="icon">
                    <Icon size={13} />
                  </span>
                  <span className="panel-tab-label">{def.label}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      closePanelTab(group.id, tab.id)
                    }}
                    title="Close"
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <button className="tab-add" onClick={toggleAdd} title="Add tab">
              <PlusIcon size={13} />
            </button>
          </div>
          {adding && menuPos && (
            <div className="tab-add-menu" style={{ position: 'fixed', left: menuPos.x, top: menuPos.y }}>
              {addableKinds(existing).map((k) => {
                const Icon = k.icon
                return (
                  <button
                    key={k.kind}
                    className="tab-add-item"
                    onClick={() => {
                      void openPanelTab(k.kind, group.id)
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
            {active.kind === 'browse' && adding ? null : <TabContent tab={active} />}
          </div>
        </>
      ) : (
        <AddPanelView group={group} />
      )}
    </div>
  )
}

export function AddBar(): React.JSX.Element {
  const existing = useExistingKinds()
  return (
    <div className="add-bar">
      {addableKinds(existing).map((k) => {
        const Icon = k.icon
        return (
          <button key={k.kind} className="add-bar-btn" onClick={() => void openPanelTab(k.kind)} title={k.label}>
            <Icon size={18} />
          </button>
        )
      })}
      <div className="add-bar-sep" />
      <button className="add-bar-btn" onClick={addPanelGroup} title="New panel">
        <PlusIcon size={18} />
      </button>
    </div>
  )
}

export function Panel(): React.JSX.Element {
  const panelGroups = useStore(appStore, (s) => s.panelGroups)

  if (panelGroups.length === 0) {
    return (
      <div className="panel-groups">
        <AddPanelView group={{ id: 'empty', tabs: [], activeTabId: null, width: 460 }} />
      </div>
    )
  }

  return (
    <div className="panel-groups">
      {panelGroups.length > 0 ? <LeftResizer group={panelGroups[0]} /> : null}
      {panelGroups.map((group, i) => (
        <React.Fragment key={group.id}>
          <GroupPanel group={group} />
          {i < panelGroups.length - 1 ? <Splitter left={group} right={panelGroups[i + 1]} /> : null}
        </React.Fragment>
      ))}
      <div className="panel-split" title="Add panel">
        <button className="tab-add" onClick={addPanelGroup}>
          <PlusIcon size={14} />
        </button>
      </div>
    </div>
  )
}
