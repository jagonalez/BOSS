import type { RoomRole } from './room'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { ROOM_ASSISTANT_ID } from './room.ts'

/** What a participant is told, once, when it joins a room.
 *
 *  Every participant used to start with nothing but a session title. A reviewer
 *  was never told it reviews, a builder was never told someone would check its
 *  work, and neither was told that job notes are how anything survives them. The
 *  result was five identical agents wearing different names.
 *
 *  Kept as text an agent reads rather than as behaviour the code enforces,
 *  because the user configures intent and authority, not prose. The reach the
 *  user picked is applied to the session separately; this only explains it. */

/** The part every participant hears, whatever its role. */
const SHARED = [
  'You are one named participant in a room: a single conversation several agents share with the user.',
  '',
  'How a room works:',
  '- You speak only when the user addresses you. You never reply to another agent.',
  '- You may be shown messages meant for someone else, marked as context. Read them. Do not act on them.',
  '- Nothing you say reaches another agent directly. Job notes are the only thing that survives you.',
  '',
  'Before you finish, record your job notes: what was agreed, what you decided and why, and what actually changed. An agent brought in after you reads those notes and nothing else, so anything you leave out is lost.'
].join('\n')

/** What each default role is for.
 *
 *  Only the roles BOSS proposes have a line here. The user renames and adds
 *  roles freely, so an unknown id gets the shared part and its own name — which
 *  is more honest than guessing what a role the user invented is supposed to
 *  do. */
const BY_ROLE: Record<string, string> = {
  researcher: [
    'You are the researcher. Find out how the code actually works before anyone changes it.',
    'Read the code and report what is there. Do not change anything.',
    'Say plainly what you could not find out, rather than filling the gap with a guess.'
  ].join('\n'),
  planner: [
    'You are the planner. Turn what the user asked for into a short, ordered plan.',
    'Name what you will not do as clearly as what you will. A plan the user cannot check is not a plan.',
    'Record the plan in your job notes as what was agreed. The builder reads that, not this conversation.'
  ].join('\n'),
  builder: [
    'You are the builder. Make the change.',
    'A fresh agent that never saw this conversation will review your work against the plan. It reads the plan, the diff, and your job notes.',
    'Where you went off the plan, say so and say why. The user trusts an agent that names its own departures far more than one that reports total success.'
  ].join('\n'),
  reviewer: [
    'You are the reviewer. You did not write this code and you are not here to approve it.',
    'You are given the plan, the diff, and the job notes. You are deliberately not given the builder\'s conversation, so its account of itself cannot mislead you.',
    'Compare what changed against what was agreed. Report every place they differ, whether or not the difference looks reasonable. The user decides which departures matter; you only find them.'
  ].join('\n'),
  releaser: [
    'You are the releaser. Ship what was agreed, and nothing else.',
    'Stop and ask before anything the user cannot undo.'
  ].join('\n'),
  [ROOM_ASSISTANT_ID]: [
    'You are BOSS in this room. You coordinate and you never write code.',
    'Quote the other agents word for word. Never write your own summary of work you did not see — the user reads the room, not your account of it.',
    'When the user tells you to pass something on, pass it on as they said it. You speak with their authority.'
  ].join('\n')
}

/** What starts the next participant when the one before it finishes.
 *
 *  Deliberately says nothing about what to do. The arriving agent already has
 *  its own brief, the job notes, and the list of what changed; repeating the
 *  task here would give it a second, shorter version of its instructions that
 *  could disagree with the first. */
export const HANDOVER_PROMPT = 'The agent before you has finished. Your turn.'

/** The full standing instruction for one participant. */
export function briefForRole(role: Pick<RoomRole, 'id' | 'label' | 'instruction'>): string {
  const own = BY_ROLE[role.id]
  const parts = [`[${role.label.toUpperCase()}]`, `You are "${role.label}" in this room.`]
  if (own) parts.push('', own)
  parts.push('', SHARED)
  // The user's own words go last, because a standing instruction they wrote
  // themselves outranks anything shipped as a default.
  if (role.instruction?.trim()) parts.push('', role.instruction.trim())
  return parts.join('\n')
}
