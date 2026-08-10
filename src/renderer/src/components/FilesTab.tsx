import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { FileNode } from '@shared/opencode'
import { OpenCode } from '../lib/opencode'
import { ChevronIcon, FileIcon } from './icons'

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
      {isDir && isExpanded && node.children
        ? node.children.map((child) => (
            <FileNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  )
}

export function FilesTab(): React.JSX.Element {
  const files = useStore(appStore, (s) => s.files)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [content, setContent] = useState<{ path: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!files) {
      void OpenCode.fileTree()
        .then((tree) => appStore.setState({ files: tree }))
        .catch(() => {})
    }
  }, [files])

  const toggle = async (path: string): Promise<void> => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      const tree = await OpenCode.fileTree(path).catch(() => [])
      const update = (nodes: FileNode[]): FileNode[] =>
        nodes.map((node) => (node.path === path ? { ...node, children: tree } : { ...node, children: node.children ? update(node.children) : node.children }))
      appStore.setState({ files: files ? update(files) : files })
    }
    setExpanded(next)
  }

  const selectFile = async (path: string): Promise<void> => {
    setLoading(true)
    try {
      const file = await OpenCode.fileContent(path)
      setContent({ path, text: file.content })
      appStore.setState({ fileContent: { path, content: file.content } })
    } catch {
      setContent(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="two-pane">
      <div className="pane" style={{ width: 280, borderRight: '1px solid var(--border-subtle)' }}>
        <div className="tree">
          {files?.map((node) => (
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
      </div>
      <div className="pane">
        {loading && <div className="empty"><p>Loading…</p></div>}
        {!loading && content ? (
          <pre className="code-view">{content.text}</pre>
        ) : (
          !loading && <div className="empty"><p>Select a file to view its contents.</p></div>
        )}
      </div>
    </div>
  )
}
