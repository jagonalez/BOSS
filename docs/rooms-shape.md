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

## Settings

Both of these are the user's choice, set once, and both already have a home: the
same screen that sets up the team.

**How a job runs.** Either a shape the user names as their usual — just do it,
build and review, the full run — or BOSS asks each time. This setting already
exists and is read; what changes is that BOSS asking now happens in the
conversation rather than as a row of buttons above the message box. The user
found that row confusing, and it fired before they had said what the job was.

**What happens to a finished room.** Either archive it or delete it. BOSS asks
before doing either, whichever the setting says — so the choice is what BOSS
proposes, never what it does unasked. Deleting is not something to infer from a
setting made weeks earlier.

Archiving a thread already exists in the app. What is missing is a way for BOSS
to propose it — a card with one way forward and one way out, which is exactly
what a card is for.

## Open

Nothing. Both questions above are answered.
