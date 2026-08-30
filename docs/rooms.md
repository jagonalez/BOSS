# Rooms

**Status:** Agreed design. Implementation in progress.
**Supersedes:** the visible Assistant page, the Workflows page, and the Lab page.

## What changes

A thread stops being one conversation with one agent. It becomes a room that
several named agents share, plus BOSS, plus the user. One message list. One
composer. Every message names who it is for.

The user talks to BOSS anywhere. BOSS coordinates, quotes, and carries the
user's authority. It never writes code.

## Why

The old surfaces exposed machinery as navigation: Workflows, Automations, Lab,
Assistant, Product, Reports, and Sites all sat at the same level. Four of them
were implementation detail. Starting one bug fix meant a dialog with a task
field, a backend choice, a placement radio, and a model picker.

The user's real pattern is different:

- At the desk, watch two threads and read the streaming words to catch drift.
- Away, get one push and answer from the phone.
- Trust comes from an agent naming where it went off plan, not from a clean
  report of total success.
- A fresh agent that never touched the code is believed. The builder's own
  account of itself is not.

## Vocabulary

- **Room** — a thread. The word "thread" stays in the UI; "room" describes the
  behaviour: several participants, one list.
- **Participant** — a named role (researcher, planner, builder, reviewer), BOSS,
  or the user. Role names come from the user's setup and are not fixed.
- **Recipient** — every user message names one participant, or everyone.
- **Branch** — a reply thread under any message, for taking review points one at
  a time. Same room, same participants, same rules.
- **Job notes** — what survives a role's session: what was agreed, what was
  decided, what changed. Scoped to one job. Never crosses to the next job.

## Rules

### Addressing

1. Every user message has exactly one recipient. The composer never allows an
   unaddressed message.
2. The recipient chip stays where the user left it. It does not reset on send.
3. Typing `@name` changes the chip.
4. `@Everyone` broadcasts. Each participant replies once. Participants never
   reply to each other.

### Reading

5. Every participant may read the whole room.
6. A participant reads **only when addressed**, and catches up on what it missed
   at that moment. It does not receive messages as they arrive.
7. This is what keeps the room affordable. N participants must not mean N copies
   of every message.

### Speaking

8. A participant speaks only when addressed. There is no ambient chatter.
9. An agent may read a criticism it was not addressed in, and must not act on it
   until it is addressed. This is deliberate: the user thinks out loud with BOSS
   before deciding what to tell the builder.

### Joining

10. Participants join when the work reaches them. The reviewer joins when the
    builder finishes. It is not listed before it exists.
11. A joining participant receives the plan, the diff, and the job notes — not
    the previous participant's transcript. A reviewer that only has the diff
    cannot be misled by the builder's account of itself.

### Leaving and returning

12. A participant idle beyond a threshold is **replaced, not resumed**. Its old
    context is never resent.
13. Before it goes, it writes job notes. A fresh participant addressed later
    reads those notes and nothing else.
14. Job notes live inside one job and follow it as long as it runs. They are not
    memory across jobs, and they never carry user preferences.

### BOSS

15. BOSS is a participant, not a page. It appears in the sidebar as a standing
    conversation, and joins each room as a participant of its own — one session
    per room, reading that room. A single shared session raced: two rooms
    addressing it at once crossed their replies and left one permanently unable
    to accept a message. It holds a map of what exists rather than transcripts,
    so a copy per room loses nothing.
16. BOSS **quotes** other agents verbatim and links to the room. It does not
    write its own summary of work it did not see. There is nothing for it to get
    wrong, and its context stays small.
17. BOSS holds a map: which jobs exist, their state, which room each lives in,
    what the user asked for, what was decided. Not transcripts, not diffs.
18. BOSS speaks with the user's authority. When the user says "tell it to stop",
    BOSS tells it, and the instruction carries the same weight as the user's own.
19. BOSS never writes code. Every job becomes its own room, even a one-line fix.
20. BOSS's own lookups render as collapsed tool lines, the same weight as any
    other tool call. Expandable, never a message.

### Interruption

21. Three presence modes set the bar for interrupting:
    - at the desk — interactive, the desktop is the front door;
    - away — push to the phone, decisions and reviews only;
    - do not disturb — silence, no exceptions.
22. Do not disturb is set by telling BOSS, from anywhere, and applies to every
    room.
23. BOSS never pages. Real alerting stays with the user's monitoring.

### Shape of a job

24. The user chooses the shape: just do it, build and review, or the full run. A
    setting decides whether BOSS asks first or reuses the last answer.
25. BOSS never chooses the shape.

## What stays hidden

No navigation entry, no card, no setting. Reachable through a collapsed line, or
not at all.

- Workflow scripts, approval mode, triggers, overlap policy, retry state.
- Run journals, step operations, step status values.
- The Product Graph and all its node and relation kinds.
- Permission modes. Setup asks when to stop and ask; it never names a mode.
- Budgets and token counts, unless the user asks about cost.

## What stays visible

The user works in these and asked for them by name:

- Separate copies of the code, named. The user changes directory into them.
- Files and the diff.
- Automations, Reports, and Sites, unchanged.

## Prior art

Slack shipped long agent work in a plain channel thread, called it "cramped and
noisy", and moved to a dedicated space per job with a summary and approval
buttons in the origin thread. Linear, Cursor, Devin, and Amp all converge on the
same skeleton: a durable work object with its own lifecycle, an explicit
waiting-on-human state, steering as a message into the live session, and cheap
acknowledgement within seconds.

Not one of them stores authoritative state in the chat. The room renders the
work; it does not hold it. Incident tooling documents why: a chat log has no
concept of the current state, only whatever was typed last.

The counter-argument worth respecting: agents coordinate poorly by reading each
other's messages, because messages are not traces. That is why participants here
never reply to each other, and why a joining participant gets artifacts rather
than another agent's chat.

## Implementation notes

Three rules were learned by getting them wrong first, and are easy to undo by
accident.

**One field cannot say both "this belongs here" and "this thread owns this".**
Recording one message may redirect it into the room. Reconciling a whole native
history must not, because a participant's backend reports only its own half of
the room — pointed at the room, pruning deletes everything the other
participants and the user wrote. Run bookkeeping must not either: a run belongs
to the thread that ran it.

**The room is what looks busy, and it is claimed before anything is awaited.**
A message routed to a participant runs elsewhere, so without this the room's
composer stayed open and a second message started a competing run. Routing has
to read the room from disk, so checking after that await let two quick messages
both find the room idle — the same race, walked around by a path that checked
afterwards.

**Nothing shares a session across rooms.** An earlier version gave BOSS one
session for every room and redirected where its output was recorded. Every race
that followed came from that: two rooms crossing replies, a room stranded busy,
a stale destination outliving its run. Removing the sharing removed all of them
at once. If something must appear in two rooms, give it two sessions.

**Catch-up cuts by position, not by reading each timestamp.** Stored order is
not time order: a part that arrives before its message is appended at the end
with no timestamp at all. Deciding message by message dropped exactly those, and
a dropped message means a participant acting on stale context with no sign
anything was withheld.

## Open questions

1. Does a settled branch leave one collapsed line in the main stream? Current
   default: yes.
2. Are job notes readable by the user? Current default: yes, as an expandable
   line.
3. Is one hour the right idle threshold before a participant is replaced?
4. Does presence set itself from window focus, or does the user set it by hand?
5. Who writes the job notes, and when? Nothing writes them yet.
