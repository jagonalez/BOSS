import React, { useEffect, useRef, useState } from 'react'
import type { BackendId, BackendModelDescriptor, BackendModelPreference } from '@shared/backend'

export function modelValue(providerID: string, modelID: string): string {
  return JSON.stringify([providerID, modelID])
}

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'llama.cpp', 'llamacpp', 'lmstudio', 'lm-studio', 'vllm', 'sglang'])

export function modelIsLocal(model: BackendModelDescriptor, backendId: BackendId): boolean {
  return model.source === 'local' || LOCAL_PROVIDER_IDS.has((model.provider || backendId).toLowerCase())
}

/** Searchable, provider-grouped model picker shared by Settings and the automations editor. */
export function ModelSelect({
  backendId,
  models,
  selected,
  loading = false,
  disabled = false,
  emptyLabel = 'Automatic',
  onPick
}: {
  backendId: BackendId
  models: BackendModelDescriptor[]
  selected?: BackendModelPreference
  loading?: boolean
  disabled?: boolean
  /** Label of the no-selection option ("Automatic", "Backend default", …). */
  emptyLabel?: string
  onPick: (model: BackendModelDescriptor | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const selectedModel = selected
    ? models.find((model) => model.id === selected.modelID && (model.provider || backendId) === selected.providerID)
    : undefined
  const normalizedQuery = query.trim().toLowerCase()
  const visibleModels = normalizedQuery
    ? models.filter((model) => `${model.name ?? ''} ${model.id} ${model.provider ?? backendId}`.toLowerCase().includes(normalizedQuery))
    : models
  const grouped = new Map<string, BackendModelDescriptor[]>()
  for (const model of visibleModels) {
    const provider = model.provider || backendId
    grouped.set(provider, [...(grouped.get(provider) ?? []), model])
  }

  const pick = (model: BackendModelDescriptor | null): void => {
    onPick(model)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="settings-model-picker" ref={root}>
      <button
        className="settings-model-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <strong>{loading ? 'Loading models…' : selectedModel?.name || selected?.modelID || (models.length ? emptyLabel : 'No models available')}</strong>
          {selected ? <small>{selected.providerID}{selectedModel && modelIsLocal(selectedModel, backendId) ? ' · Local' : ''}</small> : null}
        </span>
        <span className="settings-model-picker-chevron">⌄</span>
      </button>
      {open ? (
        <div className="settings-model-picker-menu">
          <input
            autoFocus
            className="settings-model-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false)
                setQuery('')
              }
            }}
            placeholder="Search models…"
            aria-label={`Search ${backendId} models`}
          />
          <div className="settings-model-results" role="listbox">
            {!normalizedQuery || emptyLabel.toLowerCase().includes(normalizedQuery) ? (
              <button className={!selected ? 'active' : ''} onClick={() => pick(null)}>
                <span>{emptyLabel}</span>
                {!selected ? <em>✓</em> : null}
              </button>
            ) : null}
            {selected && !selectedModel ? (
              <button className="active" onClick={() => pick(null)}>
                <span>{selected.modelID}<small>{selected.providerID} · unavailable</small></span>
                <em>Clear</em>
              </button>
            ) : null}
            {[...grouped].sort(([providerA, itemsA], [providerB, itemsB]) => {
              if (providerA === selected?.providerID) return -1
              if (providerB === selected?.providerID) return 1
              const localA = itemsA.some((model) => modelIsLocal(model, backendId))
              const localB = itemsB.some((model) => modelIsLocal(model, backendId))
              return localA === localB ? providerA.localeCompare(providerB) : localA ? -1 : 1
            }).map(([provider, items]) => (
              <div className="settings-model-provider" key={provider}>
                <div className="settings-model-provider-heading">
                  <span>{provider}</span>
                  {items.some((model) => modelIsLocal(model, backendId)) ? <em>Local</em> : null}
                </div>
                {[...items].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map((model) => {
                  const active = selected?.modelID === model.id && selected.providerID === provider
                  return (
                    <button key={modelValue(provider, model.id)} className={active ? 'active' : ''} onClick={() => pick(model)}>
                      <span>{model.name || model.id}{model.name && model.name !== model.id ? <small>{model.id}</small> : null}</span>
                      {active ? <em>✓</em> : null}
                    </button>
                  )
                })}
              </div>
            ))}
            {visibleModels.length === 0 && normalizedQuery ? <div className="settings-model-empty">No matching models</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
