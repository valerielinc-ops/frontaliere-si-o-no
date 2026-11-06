/**
 * What every e-mail we send to an employer in the candidate's name shares:
 * the application (scripts/assisted-application/lib/submit.mjs) and its
 * follow-ups (assistedApplicationFollowupSweep.js). From the owner's mailbox,
 * with the candidate's name, replies going to the order's alias.
 */

export const EMPLOYER_MAIL_FROM = 'valerie@frontaliereticino.ch';
// These adapters preserve both Reply-To and dossier attachments. Maileroo
// remains first; a definite rejection can fall back without losing CV files.
// The shared cascade stops on an ambiguous outcome, rather than sending twice.
export const ASSISTED_EMAIL_PROVIDERS = Object.freeze(['maileroo', 'resend']);

/** Provider tracking references are not RFC Message-IDs used for reply threading. */
export function replyThreadMessageId(send, requestedMessageId) {
  if (typeof send?.rfcMessageId === 'string' && /^<[^<>@\s]+@[^<>@\s]+>$/.test(send.rfcMessageId)) return send.rfcMessageId;
  // Maileroo generates its own Message-ID; its API reference_id is not it.
  // Keep subject threading, rather than referencing an ID the employer never received.
  if (send?.provider === 'maileroo') return null;
  return requestedMessageId || null;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text) {
  return String(text || '').trim().split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** `"Maria Rossi via Frontaliere Ticino"`: the name is the candidate's, the mailbox ours. */
export function senderName(name) {
  const safe = String(name || '').replace(/["<>\\\r\n]/g, '').trim().slice(0, 80);
  return safe ? `"${safe} via Frontaliere Ticino"` : 'Frontaliere Ticino';
}

/** "Re: <subject>" once, whatever the language the original used. */
export function replySubject(subject) {
  const text = String(subject || '').trim();
  return /^(re|aw|r|rif)\s*:/i.test(text) ? text : `Re: ${text}`.trim();
}
