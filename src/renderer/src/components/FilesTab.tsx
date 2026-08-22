import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { ProjectTreeNode, ProjectFilePreview } from '@shared/opencode'
import { ChevronIcon, FileIcon } from './icons'
import { FilePreview } from './FilePreview'

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
  node: ProjectTreeNode
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

export function FilesTab({ contextPath }: { contextPath?: string }): React.JSX.Element {
  const projectPath = useStore(appStore, (s) => s.projectPath)
  const gitRefresh = useStore(appStore, (s) => s.gitRefresh)
  const directory = contextPath || projectPath
  const [files, setFiles] = useState<ProjectTreeNode[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tabs, setTabs] = useState<ProjectFilePreview[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = useState(280)

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

  useEffect(() => {
    setFiles(null)
    setExpanded(new Set())
    setTabs([])
    setActivePath(null)
    if (!directory) return
    void window.boss.projectFileTree(directory).then(setFiles).catch(() => setFiles([]))
  }, [directory, gitRefresh])

  const toggle = async (path: string): Promise<void> => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      const tree = await window.boss.projectFileTree(directory, path).catch(() => [])
      const update = (nodes: ProjectTreeNode[]): ProjectTreeNode[] =>
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
      const preview = await window.boss.projectFilePreview(directory, path)
      if (!preview) return
      setTabs((prev) => [...prev, preview])
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
            {active ? <FilePreview key={active.path} preview={active} /> : null}
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
