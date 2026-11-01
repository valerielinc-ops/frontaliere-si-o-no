/** Application stages are proved by the page's controls and instructions, never its URL alone. */
import { avaturePortalDirectory, avaturePostingJobKey, sameAvaturePortal } from './protocol.mjs';
import { CONFIRM_RE, REFUSED_RE, SUBMIT_RE } from './fill.mjs';

// Match the complete route relative to the proved source directory, never a
// suffix under an unknown parent such as ApplicationSave/ApplicationReview.
const REVIEW_PATH_RE = /^(?:application\/|application)?(?:review|preview|summary)\/?$/i;
const PROFILE_CONTINUATION_RE = /(?:already submitted your personal information|(?:account|profile|personal information) (?:has been |was |is )?(?:created|saved|updated)).{0,300}(?:application|apply|review|continue)/i;
const NOT_SUBMITTED_APPLICATION_RE = new RegExp([
  String.raw`\bapplication\b.{0,120}\b(?:(?:has|was|is)(?:\s+(?:not|n['’]t)|n['’]t)\s+(?:been\s+)?(?:submitted|sent|received|completed)|not\s+(?:yet\s+)?(?:submitted|sent|received|completed))\b`,
  String.raw`\bbewerbung\b.{0,120}\b(?:nicht|noch nicht)\b.{0,60}\b(?:eingereicht|gesendet|übermittelt|abgeschickt|abgeschlossen)\b`,
  String.raw`\bcandidatura\b.{0,120}\bnon\b.{0,60}\b(?:inviata|presentata|trasmessa|completata)\b`,
  String.raw`\bcandidature\b.{0,120}\bn['’](?:a pas été|est pas)(?=$|[^\p{L}\p{N}]).{0,60}\b(?:envoyée|soumise|transmise|terminée)(?=$|[^\p{L}\p{N}])`,
].join('|'), 'iu');
const INCOMPLETE_APPLICATION_RE = new RegExp([
  String.raw`\b(?:continue|resume|proceed|complete|finish)(?:\s+(?:your|the|this|my|a|an|with|to|and|filling|out|online|job|current|next|rest|application|process)){0,8}\s+\b(?:application|candidature|bewerbung)\b`,
  String.raw`\b(?:incomplete|unfinished)\s+(?:job\s+)?application\b`,
  String.raw`\bapplication\b.{0,120}\b(?:incomplete|unfinished|not (?:yet )?(?:complete|finished|submitted|sent)|has not been (?:completed|submitted|sent)|still (?:needs|requires) completion|to be completed|to complete)\b`,
  String.raw`\bbewerbung\b.{0,120}\b(?:unvollständig(?:e|en)?|nicht (?:vollständig|abgeschlossen|eingereicht|gesendet|fertig)|noch nicht (?:abgeschlossen|eingereicht|vollständig|fertig)|fortsetzen|vervollständigen)\b`,
  String.raw`\bcandidature\b.{0,120}\b(?:incomplète|inachevée|pas encore (?:terminée|envoyée|complète|soumise)|n['’]est pas (?:encore )?(?:complète|terminée|envoyée|soumise)|(?:à|a) compléter|poursuivre|compléter)(?=$|[^\p{L}\p{N}])`,
  String.raw`\bcandidatura\b.{0,120}\b(?:incomplet[ao]|non (?:è|e')\s+(?:ancora\s+)?(?:stata\s+)?(?:completat[ao]|inviat[ao]|complet[ao])|non (?:ancora\s+)?(?:completat[ao]|inviat[ao]|complet[ao])|da completare|continua|completa|prosegui)\b`,
].join('|'), 'iu');
const DOCUMENT_ROLE_LABEL_RE = /\b(?:resume|cv|curriculum\s+vitae|lebenslauf)\s*\/\s*(?:resume|cv|curriculum\s+vitae|lebenslauf)\b|\bresume\s*(?:[*:])(?=\s|$)/gi;
const REVIEW_INSTRUCTIONS_RE = /(?:please )?review (?:the |your )?information.{0,600}(?:select|click|press).{0,50}(?:submit|apply).{0,80}(?:finali[sz]e|send|submit|complete).{0,40}(?:application|candidature)/i;
const BEFORE_SEND_RE = /(?:review|check).{0,160}(?:before (?:you )?(?:submit|send|apply)|next (?:step|page))/i;
const GENERIC_APPLY_RE = /^(?:apply(?: now)?|bewerben|jetzt bewerben|candidati(?: ora)?|applica|postuler)\W*$/i;

function incompleteApplication(text) {
  // ATS labels such as "Resume / CV" name a document role. Treating that
  // noun as the verb "resume" can join it to a nearby "Submit application"
  // button and freeze an otherwise complete form.
  return INCOMPLETE_APPLICATION_RE.test(String(text || '').replace(DOCUMENT_ROLE_LABEL_RE, 'CV document'));
}

function parsed(value) {
  try { return new URL(value); } catch { return null; }
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
  return Boolean(octets && octets[0] === 127 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255));
}

function trustedPortalTransport(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
}

/** Only explicit posting keys bind a route. Account IDs/application IDs are not job IDs. */
export function portalJobKey(value, protocol = null) {
  const url = parsed(value);
  if (!url) return null;
  const entries = [...url.searchParams.entries()].filter(([key]) => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key));
  if (entries.length > 1 || (entries.length === 1 && !/^[a-z0-9_-]{1,100}$/i.test(entries[0][1]))) return null;
  const quotedPathKey = avaturePostingJobKey(value, protocol);
  if (quotedPathKey && entries.length === 1 && entries[0][1] !== quotedPathKey) return null;
  return entries[0]?.[1] || quotedPathKey || null;
}

function invalidPostingKey(value, protocol = null) {
  const url = parsed(value);
  return url && [...url.searchParams.keys()].some(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))
    && !portalJobKey(value, protocol);
}

function boundRoute(value, applyUrl, sourceProtocol = null) {
  const url = parsed(value);
  const expected = parsed(applyUrl);
  const key = portalJobKey(applyUrl, sourceProtocol);
  const namespace = avaturePortalDirectory(applyUrl, sourceProtocol);
  return Boolean(url && expected && url.protocol === 'https:' && url.origin === expected.origin
    && (!namespace || url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) === namespace) && key && portalJobKey(value) === key);
}

function reviewNavigationRoute(value, applyUrl, sourceProtocol) {
  if (!boundRoute(value, applyUrl, sourceProtocol)) return false;
  const target = parsed(value);
  const source = parsed(applyUrl);
  if (target.username || target.password || source.username || source.password) return false;
  // An attested namespace stays exact through boundRoute. Without protocol,
  // keep direct source-directory routes and the existing root application/
  // owned-link case; do not infer another tenant's child namespace.
  const directory = avaturePortalDirectory(applyUrl, sourceProtocol)
    || source.pathname.slice(0, source.pathname.lastIndexOf('/') + 1);
  const route = target.pathname.slice(directory.length);
  return target.pathname.startsWith(directory) && (directory === '/' || !/^application\//i.test(route))
    && REVIEW_PATH_RE.test(route);
}

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleBound(text, title) {
  const expected = normalized(title);
  return expected.split(' ').filter(word => word.length > 2).length >= 2
    && ` ${normalized(text)} `.includes(` ${expected} `);
}

function receiptTitleBound(text, title) {
  const match = CONFIRM_RE.exec(text);
  if (!match) return false;
  // Titles elsewhere in navigation, recommendations or footers cannot bind
  // a receipt. It must name this role in the receipt's own sentence.
  const before = text.slice(0, match.index).split(/[.!?\n]/).at(-1);
  const after = text.slice(match.index).split(/[.!?\n]/)[0];
  return titleBound(`${before} ${after}`, title);
}

/** Receipt copy must explicitly describe an application received for this posting. */
export function applicationReceipt(snapshot, { url = snapshot?.url, applyUrl, submissionUrl, sourceProtocol = null, job = {} } = {}) {
  const text = String(snapshot?.text || '');
  if (!snapshot || invalidPostingKey(url) || invalidPostingKey(submissionUrl || applyUrl, sourceProtocol) || NOT_SUBMITTED_APPLICATION_RE.test(text)
    || REFUSED_RE.test(text) || !CONFIRM_RE.test(text)
    || PROFILE_CONTINUATION_RE.test(text) || incompleteApplication(text)
    || REVIEW_INSTRUCTIONS_RE.test(snapshot.text || '') || BEFORE_SEND_RE.test(snapshot.text || '')) return false;
  if ((snapshot.buttons || []).some(button => !button.chrome && SUBMIT_RE.test(button.text || ''))) return false;
  const actualJobKey = portalJobKey(url);
  const expectedJobKey = portalJobKey(submissionUrl || applyUrl, sourceProtocol);
  // A receipt naming a different posting never borrows the title from generic page chrome.
  if (actualJobKey && expectedJobKey && actualJobKey !== expectedJobKey) return false;
  const actual = parsed(url);
  const source = parsed(submissionUrl || applyUrl);
  // Production receipts require HTTPS. The only HTTP exception is the local
  // fake portal used by deterministic browser tests; public HTTP ATS hosts
  // remain unknown even when their page says thank you.
  if (!actual || !source || !trustedPortalTransport(actual) || !trustedPortalTransport(source) || actual.origin !== source.origin) return false;
  const namespace = avaturePortalDirectory(submissionUrl || applyUrl, sourceProtocol);
  if (namespace && actual.pathname.slice(0, actual.pathname.lastIndexOf('/') + 1) !== namespace) return false;
  return Boolean(actualJobKey && expectedJobKey && actualJobKey === expectedJobKey) || receiptTitleBound(snapshot.text, job.title);
}

/**
 * A direct GET link to this posting's review can be followed without arming
 * the send guard. Ambiguous Apply controls on an empty account/summary page
 * stay unknown. A review instruction explicitly announcing the final commit
 * makes its Apply control the real guarded action.
 */
export function applicationStage(snapshot, { url = snapshot?.url, applyUrl, sourceProtocol = null, job = {} } = {}) {
  if (invalidPostingKey(url) || invalidPostingKey(applyUrl, sourceProtocol)) return { kind: 'posting_mismatch' };
  const buttons = (snapshot?.buttons || []).filter(button => !button.chrome && !button.disabled);
  const text = String(snapshot?.text || '').replace(/\s+/g, ' ');
  if (applicationReceipt(snapshot, { url, applyUrl, sourceProtocol, job })) return { kind: 'receipt' };
  const mismatchedJob = parsed(url)?.origin === parsed(applyUrl)?.origin
    && portalJobKey(url) && portalJobKey(applyUrl, sourceProtocol) && portalJobKey(url) !== portalJobKey(applyUrl, sourceProtocol);
  if (mismatchedJob) return { kind: 'posting_mismatch' };
  const quotedSource = avaturePostingJobKey(applyUrl, sourceProtocol);
  if (quotedSource && !sameAvaturePortal(sourceProtocol, snapshot?.protocol, url)
    && buttons.some(button => GENERIC_APPLY_RE.test(button.text || ''))) return { kind: 'unknown_apply', prefinal: true };
  const bound = boundRoute(url, applyUrl, sourceProtocol) || titleBound(text, job.title);
  const finalReview = bound && REVIEW_INSTRUCTIONS_RE.test(text);
  if (finalReview) return { kind: 'final_review' };
  const pending = NOT_SUBMITTED_APPLICATION_RE.test(text) || PROFILE_CONTINUATION_RE.test(text)
    || incompleteApplication(text) || BEFORE_SEND_RE.test(text);
  const links = buttons.filter(button => GENERIC_APPLY_RE.test(button.text || '') && button.href
    && boundRoute(url, applyUrl, sourceProtocol) && reviewNavigationRoute(button.href, applyUrl, sourceProtocol)
    && !parsed(button.href)?.hash
    && [...parsed(button.href).searchParams.keys()].every(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))
    && button.href !== url);
  if (pending && links.length === 1 && !(snapshot?.fields || []).some(field => !field.disabled && !['hidden', 'submit', 'button'].includes(field.inputType))) return { kind: 'review_navigation', control: links[0], destination: links[0].href };
  if (pending) return { kind: 'unknown_apply', prefinal: true };
  // A form's Apply can be a final send. A bare Apply on a profile/summary is
  // insufficient, even if an agent or a learned button calls it a submission.
  const apply = buttons.filter(button => GENERIC_APPLY_RE.test(button.text || ''));
  const applicationForm = apply.length === 1 && !apply[0].href && apply[0].formId
    && (snapshot?.uploadedCv === true || (snapshot?.fields || []).some(field => field.formId === apply[0].formId && (field.frame || 0) === (apply[0].frame || 0) && (field.kind === 'file' || field.inputType === 'file')))
    && (snapshot?.fields || []).some(field => field.formId === apply[0].formId && (field.frame || 0) === (apply[0].frame || 0) && (field.inputType === 'email' || /^(?:e-?mail|first name|last name|nome|cognome|vorname|nachname)\b/i.test(field.label || '')));
  if (apply.length && (!applicationForm || pending)) return { kind: 'unknown_apply', prefinal: pending };
  return { kind: 'form' };
}
