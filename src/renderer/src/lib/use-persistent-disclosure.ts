import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

// Virtual transcript rows unmount when they leave the viewport. Keep only the
// disclosure choices the user actually changed so an expanded tool/reasoning
// block is still expanded when that row returns.
const disclosureState = new Map<string, boolean>()
const MAX_DISCLOSURES = 1_000

export function usePersistentDisclosure(
  key: string,
  initial = false
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setLocalOpen] = useState(() => disclosureState.get(key) ?? initial)
  const setOpen = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setLocalOpen((current) => {
      const next = typeof value === 'function' ? value(current) : value
      disclosureState.delete(key)
      disclosureState.set(key, next)
      if (disclosureState.size > MAX_DISCLOSURES) {
        disclosureState.delete(disclosureState.keys().next().value as string)
      }
      return next
    })
  }, [key])
  return [open, setOpen]
}
