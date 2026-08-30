import React from 'react'
import type { RoomCard as Card } from '@shared/room-cards'
import { lineMark } from '@shared/room-cards'
import { selectSession } from '../lib/actions'

/** A card in a room: a plan, a decision, a gate, or a result.
 *
 *  Set apart from the prose because these are the moments the user acts on. At
 *  most two things to do — one way forward and one way out. More than that
 *  turns a decision into a form, and a form is what the old surfaces were.
 *
 *  An action sends its own words back as the user's next message. The agent
 *  asked the question, so it already knows what the answer means; a separate
 *  channel for button presses would be a second way to say the same thing. */
export function RoomCard({
  card,
  onAct
}: {
  card: Card
  onAct?: (answer: string) => void
}): React.JSX.Element {
  return (
    <div className={`room-card ${card.kind}`}>
      <div className="room-card-head">{card.title}</div>
      {card.lines.length > 0 ? (
        <div className="room-card-lines">
          {card.lines.map((line, index) => {
            const { mark, text } = lineMark(line)
            return (
              <div className={`room-card-line ${mark ?? ''}`} key={`${index}-${line}`}>
                {mark ? <span className="mark" aria-hidden="true">{MARKS[mark]}</span> : null}
                <span>{text}</span>
              </div>
            )
          })}
        </div>
      ) : null}
      {card.actions.length > 0 || card.link ? (
        <div className="room-card-actions">
          {card.actions.map((action, index) => (
            <button
              key={action}
              className={index === 0 ? 'primary' : ''}
              onClick={() => onAct?.(action)}
            >
              {action}
            </button>
          ))}
          {/* Opens the thread the card names, rather than describing where to
              look. BOSS quotes another room and this is how the user gets to
              it. */}
          {card.link ? (
            <button className="room-card-link" onClick={() => selectSession(card.link!.threadId)}>
              {card.link.label} →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const MARKS: Record<string, string> = {
  done: '✓',
  gap: '≠',
  waiting: '○'
}
