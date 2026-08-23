import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import type { StatusFile } from '../lib/diff'
import { gitStage, gitStatusFiles, gitUnstage } from '../lib/git'

async function git(path: string, args: string[]): Promise<string> {
  const res = await window.boss.gitRun(path, args)
  if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `git ${args[0]} failed`)
  return res.stdout
}

function fileLabel(file: StatusFile): string {
  return file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path
}

export function CommitDialog(): React.JSX.Element | null {
  const path = useStore(appStore, (s) => s.commitPath)
  const [files, setFiles] = useState<StatusFile[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [stagingBusy, setStagingBusy] = useState(false)
  const [output, setOutput] = useState('')
  const statusRequest = useRef(0)
  const stagingBusyRef = useRef(false)
  const pathRef = useRef(path)
  pathRef.current = path

  useEffect(() => {
    const request = ++statusRequest.current
    setMsg('')
    setOutput('')
    setFiles([])
    if (!path) return
    void (async () => {
      try {
        const next = await gitStatusFiles(path)
        if (request === statusRequest.current && pathRef.current === path) setFiles(next)
      } catch {
        if (request === statusRequest.current && pathRef.current === path) setFiles([])
      }
    })()
  }, [path])

  if (!path) return null

  // Only what the index holds is committed, so this list is exactly the
  // commit's contents. Untracked files sit in the unstaged section until they
  // are added by name.
  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)

  const reload = async (): Promise<void> => {
    const expectedPath = path
    if (pathRef.current !== expectedPath) return
    const request = ++statusRequest.current
    try {
      const next = await gitStatusFiles(expectedPath)
      if (request === statusRequest.current && pathRef.current === expectedPath) setFiles(next)
    } catch {
      if (request === statusRequest.current && pathRef.current === expectedPath) setFiles([])
    }
  }

  const toggle = async (file: StatusFile): Promise<void> => {
    if (busy || stagingBusyRef.current) return
    stagingBusyRef.current = true
    setStagingBusy(true)
    // Moved immediately so the click feels instant; a failed git call snaps
    // the list back to what the index actually says.
    setFiles((prev) => prev.map((f) => (f === file ? { ...f, staged: !f.staged, unstaged: f.staged } : f)))
    try {
      if (file.staged) await gitUnstage(path, [file])
      else await gitStage(path, [file])
    } catch {
      /* fall through to the authoritative list below */
    }
    try {
      await reload()
    } finally {
      stagingBusyRef.current = false
      setStagingBusy(false)
    }
  }

  const run = async (push: boolean): Promise<void> => {
    if (!msg.trim() || busy || stagingBusyRef.current || staged.length === 0) return
    setBusy(true)
    setOutput('')
    try {
      await git(path, ['commit', '-m', msg.trim()])
      let text = 'Committed ✓'
      if (push) {
        const out = await git(path, ['push'])
        text = out.trim() ? `Committed + pushed ✓\n${out.trim()}` : 'Committed + pushed ✓'
      }
      setOutput(text)
      await reload()
      setTimeout(() => appStore.setState({ commitPath: null }), 1400)
    } catch (err) {
      setOutput(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  const row = (file: StatusFile): React.JSX.Element => (
    <div key={file.oldPath ? `${file.oldPath}->${file.path}` : file.path} className={`commit-file ${file.staged ? 'staged' : ''}`}>
      <button
        className="commit-stage-toggle"
        title={file.staged ? `Unstage ${fileLabel(file)}` : `Stage ${fileLabel(file)}`}
        aria-label={file.staged ? `Unstage ${fileLabel(file)}` : `Stage ${fileLabel(file)}`}
        disabled={busy || stagingBusy}
        onClick={() => void toggle(file)}
      >
        {file.staged ? '−' : '+'}
      </button>
      <span className="commit-file-path">{fileLabel(file)}</span>
      {file.untracked ? <small className="commit-file-kind">new</small> : null}
      {file.oldPath ? <small className="commit-file-kind">renamed</small> : null}
    </div>
  )

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Commit & push</h3>
        <div className="body">
          {files.length === 0
            ? 'No changes to commit.'
            : null}
          {files.length > 0 && (
            <>
              <div className="commit-section staged">
                <div className="commit-section-title">Staged<small>{staged.length}</small></div>
                <div className="commit-files">
                  {staged.length === 0 ? <div className="commit-empty">Nothing staged — commit does nothing yet.</div> : staged.map(row)}
                </div>
              </div>
              <div className="commit-section unstaged">
                <div className="commit-section-title">Unstaged<small>{unstaged.length}</small></div>
                <div className="commit-files">
                  {unstaged.length === 0 ? <div className="commit-empty">Everything is staged.</div> : unstaged.map(row)}
                </div>
              </div>
            </>
          )}
        </div>
        <input
          className="commit-input"
          placeholder="Commit message"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(false)
          }}
          autoFocus
          spellCheck={false}
        />
        {output ? <pre className="commit-output">{output}</pre> : null}
        <div className="actions">
          <button className="btn-deny" onClick={() => appStore.setState({ commitPath: null })}>
            Cancel
          </button>
          <button className="btn-ghost" disabled={!msg.trim() || busy || stagingBusy || staged.length === 0} onClick={() => void run(false)}>
            Commit{staged.length > 0 ? ` (${staged.length})` : ''}
          </button>
          <button className="btn-allow" disabled={!msg.trim() || busy || stagingBusy || staged.length === 0} onClick={() => void run(true)}>
            {busy ? 'Working…' : `Commit & push${staged.length > 0 ? ` (${staged.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
