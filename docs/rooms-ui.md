# Finishing the room

**Status:** Plan, not yet built.
**Follows:** docs/rooms.md, which describes the behaviour. This describes what
the user sees, and what is still the old single-agent app wearing new parts.

## What went wrong

Rooms were added beside the single-agent app rather than replacing it. Every
fault below is the same fault: a screen that assumes one conversation has one
agent, standing next to a screen that says it has several.

The clearest example is one row under the message box. It shows, side by side:

- who the message is addressed to;
- which engine runs the thread;
- which model that engine uses;
- how much the agent may do without asking;
- two buttons for handing context to another thread.

The first belongs to a room. The rest belong to a chat with one agent, and in a
room they are answered by the team instead — per role, set once. Beside each
other they read as several names for one thing, and the user cannot tell which
is which.

## What the user should see

### In a room

One thing under the message box: **who you are talking to**. Nothing else.

The engine, the model, and the reach are the team's answers, chosen once in
setup and shown where the team is shown. They are not per-message choices and
they should not look like one.

Sending one message to a different engine stays possible, because a reviewer
doing badly once should not mean editing the team. It lives in the menu on the
recipient chip, where it reads as "ask someone else this time" rather than as a
setting.

### In a plain chat

The old controls stay, unchanged. A conversation with one agent and no team is
still exactly that, and every one of those controls answers a real question
about it.

The test is simple: a control belongs where the thing it changes lives. A room's
agents live in the team.

## Changing which engine a role uses

A dropdown is the wrong shape for this. Changing an engine is not adjusting a
setting — it is replacing an agent. The new one has a different session, a
different history, and different rules. Today the change is silently ignored for
any conversation that already exists, which is worse than either honest answer.

It should be the same event the design already has for an agent that went idle:

1. The agent that is leaving writes what it knows.
2. Its session is dropped.
3. A fresh one joins, and reads what was written.

Nothing else crosses. That is the rule that makes a fresh reviewer worth
believing, and it is the same rule here for the same reason.

**BOSS needs its own kind of summary.** A builder records what was agreed and
what changed. BOSS holds which jobs exist, what state each is in, and what was
decided. Handing it a builder's notes would lose everything it actually knows.

**It has to be visible.** A summary that is thin or wrong should be findable
before it costs anything — but see below for how much of it to show.

## Setup is not conversation

An agent joining a room is handed several things the user never wrote:

- what its role is;
- what it missed while it was not being addressed;
- what has changed in the checkout;
- what the last agent knew, when one is being replaced.

All of it is currently printed into the conversation as though an agent had said
it. It is a wall of text the user cannot change, cannot act on, and did not ask
for.

Every one of these is a **collapsed line**, the same weight as a tool call:

    › Builder joined
    › Switched BOSS to Codex
    › Caught up on 4 messages

Open one and the detail is there. Left alone it is a line to scroll past. This
is the rule already agreed for BOSS's own lookups, applied to everything of the
same kind: machinery, not speech.

The test: if the user cannot change it and cannot answer it, it is not a message.

## Order of work

1. **Setup as collapsed lines.** The most visible problem, and independent of
   the rest.
2. **The composer in a room.** Remove what the team already answers; keep the
   one-off override on the chip.
3. **Replacing an agent.** The summary, the handover, and the line that records
   it. Largest, and it depends on the two above being settled.

## Settled

**A replacement is handed a summary, and can read the rest if it needs to.**
Not the whole conversation up front — that is the cost the summary exists to
avoid, and a fresh agent given everything is no longer fresh. But the room is
stored, so it can go and look. This differs from a joining reviewer, which is
deliberately given the diff and nothing else: a reviewer must not be able to
read the builder's account of itself, while a replacement *is* the same
participant continuing and may read its own past.

One thing has to change for this to be true. An agent inside a room is fenced
off from every other thread, including its own room, and that fence covers
reading as well as sending. Sending has to stay blocked — a message straight to
one agent skips the catch-up and the room's busy tracking. Reading its own room
does neither, and without it a replacement cannot look past its summary at all.

**Replacing an agent mid-run stops the run.** A half-finished run has nothing
worth summarising, and waiting would leave the user watching an agent they have
already replaced. Stopping is also the answer that needs no new machinery.
