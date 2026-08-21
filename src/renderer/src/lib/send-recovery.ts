/** Deciding what happens to a message the composer could not send.
 *
 *  This lives apart from actions.ts so it can be tested directly: actions.ts
 *  reaches into the store, the preload bridge, and extension-less module paths
 *  that the node test runner cannot resolve. The rules below are the part worth
 *  protecting — losing the user's text is the bug this file exists to prevent.
 */

export interface RecoverableSend {
  text: string
  attachments: Attachmentish[]
  error: string
}

/** Structural, so a test does not need the renderer's Attachment type. */
export interface Attachmentish {
  id: string
  name: string
  mime: string
  dataUrl: string
}

/** What the composer should do once a send has settled.
 *
 *  `restore` is false on success and on a send that was queued as a follow-up:
 *  a queued message is not lost, so putting it back would show it twice. */
export function composerRecovery(
  sent: boolean,
  pending: string,
  pendingAttachments: Attachmentish[],
  currentText: string,
  currentAttachments: Attachmentish[]
): { text: string; attachments: Attachmentish[]; restored: boolean } {
  if (sent) return { text: currentText, attachments: currentAttachments, restored: false }
  // Never overwrite something the user typed while the send was failing. The
  // failed-send record still holds the text, so the retry affordance can
  // recover it even when the composer has moved on.
  const text = currentText ? currentText : pending
  const attachments = currentAttachments.length ? currentAttachments : pendingAttachments
  return { text, attachments, restored: text === pending && !currentText }
}

/** The text and attachments a retry must resend.
 *
 *  Taken from the failed record rather than the composer so attachments
 *  survive: re-typing the text by hand would drop the images the user pasted,
 *  which is exactly the "I copy & paste it again" complaint. */
export function retryPayload(failed: RecoverableSend | undefined): { text: string; attachments: Attachmentish[] } | null {
  if (!failed) return null
  if (!failed.text.trim() && failed.attachments.length === 0) return null
  return { text: failed.text, attachments: failed.attachments }
}
