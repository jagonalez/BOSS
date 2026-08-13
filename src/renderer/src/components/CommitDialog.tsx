import React, { useEffect, useState } from 'react'
import { useStore, appStore } from '../state/AppState'

async function git(path: string, args: string[]): Promise<string> {
  const res = await window.boss.gitRun(path, args)
  if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `git ${args[0]} failed`)
  return res.stdout
}

export function CommitDialog(): React.JSX.Element | null {
  const path = useStore(appStore, (s) => s.commitPath)
  const [files, setFiles] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState('')

  useEffect(() => {
    if (!path) return
    setMsg('')
    setOutput('')
    void (async () => {
      try {
        const out = await git(path, ['status', '--porcelain=v1'])
        setFiles(out.split('\n').map((l) => l.trim()).filter(Boolean))
      } catch {
        setFiles([])
      }
    })()
  }, [path])

  if (!path) return null

  const run = async (push: boolean): Promise<void> => {
    if (!msg.trim() || busy) return
    setBusy(true)
    setOutput('')
    try {
      await git(path, ['add', '-A'])
      await git(path, ['commit', '-m', msg.trim()])
      let text = 'Committed ✓'
      if (push) {
        const out = await git(path, ['push'])
        text = out.trim() ? `Committed + pushed ✓\n${out.trim()}` : 'Committed + pushed ✓'
      }
      setOutput(text)
      setTimeout(() => appStore.setState({ commitPath: null }), 1400)
    } catch (err) {
      setOutput(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Commit & push</h3>
        <div className="body">
          {files.length === 0
            ? 'No changes to commit.'
            : `${files.length} changed file${files.length === 1 ? '' : 's'}:`}
          {files.length > 0 && (
            <div className="commit-files">
              {files.slice(0, 12).map((f) => (
                <div key={f} className="commit-file">
                  {f}
                </div>
              ))}
              {files.length > 12 ? <div className="commit-file">… +{files.length - 12} more</div> : null}
            </div>
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
          <button className="btn-ghost" disabled={!msg.trim() || busy} onClick={() => void run(false)}>
            Commit
          </button>
          <button className="btn-allow" disabled={!msg.trim() || busy} onClick={() => void run(true)}>
            {busy ? 'Working…' : 'Commit & push'}
          </button>
        </div>
      </div>
    </div>
  )
}
