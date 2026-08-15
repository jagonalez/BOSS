import { useEffect, useRef, useState } from 'react'
import type React from 'react'

/** How long the pointer rests on a row before the card appears.
 *
 *  Long: the card is big enough to cover the rows around it, so it has to be
 *  clearly asked for. Crossing the sidebar to reach something else, or pausing
 *  over a row while reading it, must not raise one. */
const HOVER_DELAY_MS = 900

/** Show a card after the pointer rests on something.
 *
 *  Returns the props to spread on the row and whether the card is due. Keeping
 *  the timer here means the card itself never mounts until it is wanted, so a
 *  pull request is not looked up for every row the pointer crosses. */
export function useHoverCard(): {
  at: { top: number; left: number } | null
  handlers: { onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void; onMouseLeave: () => void }
} {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  // The pointer can leave without a mouseleave: moving off the window edge to
  // another screen does not always fire one, so a card scheduled on the way
  // past would appear after the pointer had gone. Watching the document
  // catches the exit wherever it happens.
  useEffect(() => {
    const gone = (): void => {
      clear()
      setAt(null)
    }
    document.addEventListener('mouseleave', gone)
    window.addEventListener('blur', gone)
    return () => {
      clear()
      document.removeEventListener('mouseleave', gone)
      window.removeEventListener('blur', gone)
    }
  }, [])

  return {
    at,
    handlers: {
      onMouseEnter: (event) => {
        clear()
        // The sidebar clips its children and is narrower than the card, so the
        // card is placed against the viewport instead. Measured on enter: the
        // row cannot move while the pointer rests on it.
        const rect = event.currentTarget.getBoundingClientRect()
        timer.current = setTimeout(() => setAt({ top: rect.top, left: rect.right + 8 }), HOVER_DELAY_MS)
      },
      onMouseLeave: () => {
        clear()
        setAt(null)
      }
    }
  }
}
