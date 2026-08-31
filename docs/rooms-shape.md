# Where a conversation lives

**Status:** Agreed in conversation, not yet built.
**Follows:** docs/rooms.md, which says how a room behaves. This says what kinds
of conversation exist, and where BOSS sits in each.

## What I built wrong

The design says BOSS joins each room as its own agent, one per room, reading
that room. That part is built. But a separate standing conversation was built
beside it, with its own history and no project — and that is the thing that
grows without limit, cannot see what the user is working on, and appears in the
chat list as though it were an ordinary chat.

The user's words: "The whole idea was rooms right? Not a single one."

## Three kinds of thread

**A room.** Where a job happens. It belongs to a project. It opens with the user
and BOSS, and nobody else. The user says what they want; BOSS brings in the
agents to do it, and those agents join that same room. A project has as many
rooms as the user has jobs.

**An ordinary chat.** One agent, no team, no BOSS. For anything that is not a
job. These stay exactly as they are.

**One general chat with BOSS.** For asking and pointing, not for working.

## Why the general chat does not grow

It never carries the work. A question is asked, BOSS looks the answer up, quotes
it, and links to the room where it happened:

    You:  What is the status on the saved searches?
    BOSS: [quotes the reviewer, word for word]
          → Saved searches

The detail lives in the room. Nothing accumulates here, because nothing is
solved here.

This is the same rule as "BOSS quotes rather than summarises", from the same
reason: it holds a map of what exists, not transcripts.

## What a room knows

A room belongs to a project, so BOSS in that room knows which project it is in,
which checkout it is working from, and what has changed there. No separate
mechanism is needed — the room already has all of it, and the agents in it are
already told.

That is what the standing conversation could not do, and why it was the wrong
shape.

## What this changes

- The standing conversation, as a place with its own history, goes.
- The sidebar entry becomes a way in: what needs you, and a way to start a room
  or ask a question. Not a conversation of its own.
- BOSS stops appearing in the chat list. It is not an ordinary chat.
- Starting a job means starting a room in a project, with BOSS already in it.

## Open

**Does a room still choose its shape up front?** Today the user picks — just do
it, build and review, the full run — before saying what the job is. If a room
opens with BOSS in it, the natural thing is to say what you want and let BOSS
ask which shape. The user has not said which they prefer, and the row of buttons
was already something they found confusing.

**What happens to a project's rooms over time?** A project will accumulate them.
Nothing yet says when a room is done, or where finished ones go.
