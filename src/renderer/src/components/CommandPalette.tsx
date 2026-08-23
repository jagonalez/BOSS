import React, { useEffect, useMemo, useRef, useState } from 'react'
import { appStore, useStore } from '../state/AppState'
import { bestFuzzyScore } from '../lib/fuzzy-match'
import { activateWorkspaceView, markAllActivityRead, openProject, runMenuCommand, selectSession, showPage } from '../lib/actions'
import type { Project } from '@shared/opencode'
import { projectName } from './CommandCenter'

interface PaletteItem {
  id: string
  label: string
  /** Group name, shown on the row's right edge. */
  hint?: string
  keywords?: string
  run: () => void
}

const MAX_RESULTS = 40

function commandItems(): PaletteItem[] {
  return [
    { id: 'cmd.thread.new', label: 'New Thread', hint: 'Command', keywords: 'create chat project', run: () => runMenuCommand('thread.new') },
    { id: 'cmd.thread.new-global', label: 'New Chat', hint: 'Command', keywords: 'create thread global no project', run: () => runMenuCommand('thread.new-global') },
    { id: 'cmd.view.new', label: 'New View', hint: 'Command', keywords: 'workspace pane layout', run: () => runMenuCommand('view.new') },
    { id: 'cmd.tab.close', label: 'Close Tab', hint: 'Command', keywords: 'dismiss pane', run: () => runMenuCommand('tab.close') },
    { id: 'cmd.pane.split-horizontal', label: 'Split Left and Right', hint: 'Command', keywords: 'pane split horizontal side', run: () => runMenuCommand('pane.split-horizontal') },
    { id: 'cmd.pane.split-vertical', label: 'Split Top and Bottom', hint: 'Command', keywords: 'pane split vertical stack', run: () => runMenuCommand('pane.split-vertical') },
    { id: 'cmd.inbox.open', label: 'Open Activity Inbox', hint: 'Command', keywords: 'notifications bell unread activity', run: () => appStore.setState({ inboxOpen: true }) },
    { id: 'cmd.inbox.read', label: 'Mark Activity Read', hint: 'Command', keywords: 'notifications clear unread badge', run: markAllActivityRead },
    { id: 'cmd.settings.open', label: 'Open Settings', hint: 'Command', keywords: 'preferences appearance theme font density connections', run: () => runMenuCommand('settings.open') }
  ]
}

function pageItems(): PaletteItem[] {
  return [
    { id: 'go.command-center', label: 'Go to Command Center', hint: 'Go', keywords: 'threads overview home', run: () => showPage('command-center') },
    { id: 'go.automations', label: 'Go to Automations', hint: 'Go', keywords: 'scheduled cron runs', run: () => showPage('automations') },
    { id: 'go.sites', label: 'Go to Sites', hint: 'Go', keywords: 'publish web deploy', run: () => showPage('sites') }
  ]
}

function threadItems(sessions: Array<{ id: string; title?: string; projectPath?: string }>): PaletteItem[] {
  return sessions.map((session) => ({
    id: `thread.${session.id}`,
    label: session.title || 'Untitled thread',
    hint: 'Thread',
    keywords: session.projectPath ? projectName(session.projectPath) : undefined,
    run: () => selectSession(session.id)
  }))
}

function viewItems(views: Array<{ id: string; name: string }>): PaletteItem[] {
  return views.map((view) => ({
    id: `view.${view.id}`,
    label: view.name,
    hint: 'View',
    keywords: 'switch workspace',
    run: () => activateWorkspaceView(view.id)
  }))
}

function projectItems(projects: Project[]): PaletteItem[] {
  return projects
    .filter((project) => project.path && project.path !== appStore.getState().projectPath)
    .map((project) => ({
      id: `project.${project.path}`,
      label: project.title || projectName(project.path!),
      hint: 'Project',
      keywords: 'open switch folder',
      run: () => void openProject(project.path!)
    }))
}

function rank(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items.slice(0, MAX_RESULTS)
  const scored = items
    .map((item, index) => ({ item, index, score: bestFuzzyScore(query, [item.label, item.keywords ?? '', item.hint ?? '']) }))
    .filter((entry): entry is { item: PaletteItem; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, MAX_RESULTS).map((entry) => entry.item)
}

/** The Cmd+K overlay: one searchable list of every command the menu can run,
 *  plus the threads, views and projects it can take you to.
 *
 *  A modal like any other — mounted always, rendering null while closed — so
 *  opening it never unmounts a terminal behind it. */
export function CommandPalette(): React.JSX.Element | null {
  const open = useStore(appStore, (s) => s.paletteOpen)
  const sessions = useStore(appStore, (s) => s.sessions)
  const projects = useStore(appStore, (s) => s.projects)
  const workspace = useStore(appStore, (s) => s.projectWorkspace)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo(
    () => [...commandItems(), ...pageItems(), ...viewItems(workspace?.views ?? []), ...threadItems(sessions), ...projectItems(projects)],
    [sessions, projects, workspace?.views]
  )
  const results = useMemo(() => rank(items, query), [items, query])

  // Fresh query and highlight each time it opens; the last match of the
  // previous search means nothing to the next one.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Capture phase, as Find does: Esc must dismiss the palette before the
  // app-level handler can read it as "abort the running thread".
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        appStore.setState({ paletteOpen: false })
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        appStore.setState({ paletteOpen: false })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  // The shortcut works wherever focus sits — including inside inputs, which
  // is why this lives at the window rather than on a button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLocaleLowerCase() !== 'k') return
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      appStore.setState((state) => ({ paletteOpen: !state.paletteOpen }))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => previous?.focus()
  }, [open])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const execute = (item: PaletteItem): void => {
    appStore.setState({ paletteOpen: false })
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = results[activeIndex]
      if (chosen) execute(chosen)
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) appStore.setState({ paletteOpen: false })
    }}>
      <div className="command-palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Type a command…"
          aria-label="Search commands"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="command-palette-list" role="listbox" aria-label="Commands" ref={listRef}>
          {results.map((item, index) => (
            <li key={item.id} role="option" aria-selected={index === activeIndex}>
              <button
                className={`command-palette-item ${index === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => execute(item)}
              >
                <span className="command-palette-label">{item.label}</span>
                {item.hint ? <span className="command-palette-hint">{item.hint}</span> : null}
              </button>
            </li>
          ))}
          {results.length === 0 ? <li className="command-palette-empty">No matches.</li> : null}
        </ul>
      </div>
    </div>
  )
}
