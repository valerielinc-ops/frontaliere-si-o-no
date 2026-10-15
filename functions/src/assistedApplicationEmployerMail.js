/**
 * What every e-mail we send to an employer in the candidate's name shares:
 * the application (scripts/assisted-application/lib/submit.mjs) and its
 * follow-ups (assistedApplicationFollowupSweep.js). From the owner's mailbox,
 * with the candidate's name, replies going to the order's alias.
 */

export const EMPLOYER_MAIL_FROM = 'valerie@frontaliereticino.ch';

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
