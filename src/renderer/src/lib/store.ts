import { useCallback, useRef, useSyncExternalStore } from 'react'

export class Store<T extends object> {
  private state: T
  private listeners = new Set<() => void>()

  constructor(initial: T) {
    this.state = initial
  }

  getState(): T {
    return this.state
  }

  setState(partial: Partial<T> | ((prev: T) => Partial<T>)): void {
    this.state =
      typeof partial === 'function'
        ? { ...this.state, ...(partial as (prev: T) => Partial<T>)(this.state) }
        : { ...this.state, ...partial }
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const cacheRef = useRef<{ state: T; value: S } | null>(null)
  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const cached = cacheRef.current
    if (cached && cached.state === state) return cached.value
    const value = selectorRef.current(state)
    cacheRef.current = { state, value }
    return value
  }, [store])
  return useSyncExternalStore(store.subscribe, getSnapshot)
}
