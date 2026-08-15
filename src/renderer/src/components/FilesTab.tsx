import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { FileNode } from '@shared/opencode'
import { OpenCode } from '../lib/opencode'
import { ChevronIcon, FileIcon } from './icons'
import { filesViewState, rememberFilesView } from '../lib/tab-view-state'
import { CodeView } from './CodeView'

function baseName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

function FileNodeRow({
  node,
  depth,
  expanded,
  onToggle,
  onSelect
}: {
  node: FileNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}): React.JSX.Element {
  const isDir = node.type === 'directory'
  const isExpanded = expanded.has(node.path)
  const children = (node.children ?? []).filter((c) => !c.ignored)
  return (
    <>
      <div
        className={`node ${isDir ? 'dir' : ''}`}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => {
          if (isDir) onToggle(node.path)
          else onSelect(node.path)
        }}
      >
        {isDir ? (
          <span className="icon" style={{ transform: isExpanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.1s ease' }}>
            <ChevronIcon size={14} />
          </span>
        ) : (
          <span className="icon">
            <FileIcon size={14} />
          </span>
        )}
        <span>{node.name}</span>
      </div>
      {isDir && isExpanded
        ? children.map((child) => (
            <FileNodeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />
          ))
        : null}
    </>
  )
}

export function FilesTab({ contextPath, tabId }: { contextPath?: string; tabId?: string }): React.JSX.Element {
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const gitRefresh = useStore(appStore, (s) => s.gitRefresh)
  const directory = contextPath || projectPath
  // Moving this tab to another pane remounts it, so what was on screen is read
  // back from a cache that outlives the component rather than from state.
  const remembered = filesViewState(tabId)
  const [files, setFiles] = useState<FileNode[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(remembered?.expanded ?? []))
  const [tabs, setTabs] = useState<Array<{ path: string; text: string }>>([])
  const [activePath, setActivePath] = useState<string | null>(remembered?.activePath ?? null)
  const [treeWidth, setTreeWidth] = useState(remembered?.treeWidth ?? 280)

  const onTreeResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = treeWidth
    const move = (ev: MouseEvent): void => {
      setTreeWidth(Math.min(Math.max(startW + (ev.clientX - startX), 200), 460))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Reads the tree on mount, and again whenever the checkout changes. It only
  // resets what is on screen when the directory actually changed: on a remount
  // after a move, clearing here would undo what was just restored.
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (loadedFor.current !== null && loadedFor.current !== directory) {
      setExpanded(new Set())
      setTabs([])
      setActivePath(null)
    }
    loadedFor.current = directory
    setFiles(null)
    if (!directory) return
    void OpenCode.fileTree('', directory).then(setFiles).catch(() => setFiles([]))
  }, [directory, gitRefresh])

  // Re-open what was open before the move. The paths are remembered, not the
  // text: a file is one read, and holding every open file's contents for every
  // tab that ever existed is a cost worth not paying.
  useEffect(() => {
    const paths = remembered?.openPaths ?? []
    if (!paths.length || !directory) return
    let live = true
    void Promise.all(paths.map((path) =>
      OpenCode.fileContent(path, directory).then((file) => ({ path, text: file.content })).catch(() => null)
    )).then((opened) => {
      if (live) setTabs(opened.filter((item): item is { path: string; text: string } => item !== null))
    })
    return () => { live = false }
    // Once, on mount: after that the user's own opening and closing owns this.
  }, [])

  // Written on the way out, which is the only moment the component knows it is
  // going. Nothing clears it: a tab can move more than once, and each move has
  // to find what the last one left.
  const latest = useRef({ expanded, tabs, activePath, treeWidth })
  latest.current = { expanded, tabs, activePath, treeWidth }
  useEffect(() => () => {
    const { expanded: exp, tabs: open, activePath: active, treeWidth: width } = latest.current
    rememberFilesView(tabId, {
      expanded: [...exp],
      openPaths: open.map((item) => item.path),
      activePath: active,
      treeWidth: width
    })
  }, [tabId])

  const toggle = async (path: string): Promise<void> => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      const tree = await OpenCode.fileTree(path, directory).catch(() => [])
      const update = (nodes: FileNode[]): FileNode[] =>
        nodes.map((node) =>
          node.path === path ? { ...node, children: tree } : { ...node, children: node.children ? update(node.children) : node.children }
        )
      setFiles((current) => current ? update(current) : current)
    }
    setExpanded(next)
  }

  const selectFile = async (path: string): Promise<void> => {
    if (tabs.some((t) => t.path === path)) {
      setActivePath(path)
      return
    }
    try {
      const file = await OpenCode.fileContent(path, directory)
      setTabs((prev) => [...prev, { path, text: file.content }])
      setActivePath(path)
    } catch {
      /* ignore */
    }
  }

  const closeTab = (path: string): void => {
    const idx = tabs.findIndex((t) => t.path === path)
    const next = tabs.filter((t) => t.path !== path)
    setTabs(next)
    if (activePath === path) {
      const neighbor = next[idx] ?? next[idx - 1] ?? next[0]
      setActivePath(neighbor ? neighbor.path : null)
    }
  }

  const active = tabs.find((t) => t.path === activePath) ?? tabs[tabs.length - 1] ?? null

  return (
    <div className="two-pane">
      <div className="pane files-tree" style={{ width: treeWidth }}>
        <div className="tree">
          {(files ?? []).filter((n) => !n.ignored).map((node) => (
            <FileNodeRow
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={(p) => void toggle(p)}
              onSelect={(p) => void selectFile(p)}
            />
          ))}
        </div>
        <div className="diff-files-resizer" onMouseDown={onTreeResize} />
      </div>
      <div className="pane files-view">
        {tabs.length > 0 ? (
          <>
            <div className="file-tabs">
              {tabs.map((t) => (
                <div
                  key={t.path}
                  className={`file-tab ${t.path === active?.path ? 'active' : ''}`}
                  onClick={() => setActivePath(t.path)}
                  title={t.path}
                >
                  <span className="file-tab-name">{baseName(t.path)}</span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(t.path)
                    }}
                    title="Close"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {active ? <CodeView text={active.text} path={active.path} /> : null}
          </>
        ) : (
          <div className="empty">
            <p>Select a file to view its contents.</p>
          </div>
        )}
      </div>
    </div>
  )
}
