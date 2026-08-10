import React, { useEffect, useRef, useState } from 'react'
import { useStore, appStore } from '../state/AppState'
import { providerModels, type ModelOption } from '../lib/opencode'
import { ChevronIcon } from './icons'

function ModelSection({
  title,
  items,
  current,
  onPick
}: {
  title: string
  items: ModelOption[]
  current: string | null
  onPick: (id: string) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="model-section">
      <div className="model-section-title">{title}</div>
      {items.map((m) => (
        <button
          key={m.id}
          className={`model-row ${m.id === current ? 'active' : ''}`}
          onClick={() => onPick(m.id)}
          title={m.id}
        >
          <span className="model-row-name">{m.name || m.id}</span>
          {m.free ? <span className="model-free-tag">FREE</span> : null}
          {m.id === current ? <span className="model-check">✓</span> : null}
        </button>
      ))}
    </div>
  )
}

export function ModelPicker({ onPick }: { onPick: (id: string) => void }): React.JSX.Element {
  const model = useStore(appStore, (s) => s.model)
  const providers = useStore(appStore, (s) => s.providers)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const all = providers.flatMap((p) => providerModels(p))
  const current = all.find((m) => m.id === model)

  const freeMap = new Map<string, ModelOption>()
  const paid: Array<{ provider: string; items: ModelOption[] }> = []
  for (const p of providers) {
    const items = providerModels(p)
    const nonFree: ModelOption[] = []
    for (const m of items) {
      if (m.free) {
        if (!freeMap.has(m.id)) freeMap.set(m.id, m)
      } else {
        nonFree.push(m)
      }
    }
    if (nonFree.length) paid.push({ provider: p.id, items: nonFree })
  }

  const matches = (m: ModelOption): boolean =>
    !query || `${m.name ?? ''} ${m.id}`.toLowerCase().includes(query.toLowerCase())

  const pick = (id: string): void => {
    setOpen(false)
    setQuery('')
    onPick(id)
  }

  return (
    <div className="model-picker" ref={ref}>
      <button className="model-picker-btn" onClick={() => setOpen((o) => !o)} title="Choose model">
        <span className="model-picker-name">{current?.name || model || 'model'}</span>
        {current?.free ? <span className="model-free-tag">FREE</span> : null}
        <span className="model-picker-chevron">
          <ChevronIcon size={12} />
        </span>
      </button>
      {open && (
        <div className="model-picker-pop">
          <input
            className="model-picker-search"
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          <div className="model-picker-list">
            <ModelSection
              title="Free models"
              items={[...freeMap.values()].filter(matches)}
              current={model}
              onPick={pick}
            />
            {paid.map((g) => (
              <ModelSection key={g.provider} title={g.provider} items={g.items.filter(matches)} current={model} onPick={pick} />
            ))}
            {all.filter(matches).length === 0 ? <div className="model-section-empty">No models match</div> : null}
          </div>
        </div>
      )}
    </div>
  )
}
