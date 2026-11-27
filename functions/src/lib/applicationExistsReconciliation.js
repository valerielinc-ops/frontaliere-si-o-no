/**
 * The portal's own «you already applied to this vacancy» page, read as proof that an earlier send arrived.
 *
 * Pure (no I/O): the runner (scripts/assisted-application/lib/portal/portal.mjs) recognises the route and
 * binds its vacancy to the order's posting; the backend (assistedApplicationAutomation.js handleRunnerEvent)
 * decides, from records of its own, whether that page settles the order. Either half alone proves nothing:
 * the page also appears for an account the candidate used before, or after an application nobody here sent.
 */
import { aliasLocalPart } from '../assistedApplicationAlias.js';

/**
 * One entry per ATS that names this page in its route. A route is recognised only by its exact shape on the
 * ATS's own host; the page text is never read here (it is localised and not a contract).
 */
export const APPLICATION_EXISTS_ROUTES = Object.freeze({
  // recruitingapp-<id>.umantis.com/Vacancies/<vacancy>/FurtherApplication/ApplicationExists/<step>
  umantis_application_exists: Object.freeze({
    hostRe: /(?:^|\.)umantis\.com$/iu,
    pathRe: /^\/vacancies\/(\d+)\/furtherapplication\/applicationexists\/\d+\/?$/iu,
    vacancyOf: (url) => /^\/vacancies\/(\d+)(?:\/|$)/iu.exec(url.pathname)?.[1] || '',
  }),
});

/** The reason of the runner's handoff on this page, and the one the backend reconciles. */
export const APPLICATION_EXISTS_REASON = 'account_application_already_applied';
/** What the receipt of this proof is called (functions/src/lib/submissionReceiptContract.js). */
export const APPLICATION_EXISTS_PROOF_KIND = 'portal_application_exists';

function httpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** Which «application exists» route a page URL is, or null. */
export function applicationExistsRoute(pageUrl) {
  const url = httpsUrl(pageUrl);
  if (!url) return null;
  for (const [routeKind, route] of Object.entries(APPLICATION_EXISTS_ROUTES)) {
    if (!route.hostRe.test(url.hostname)) continue;
    const match = route.pathRe.exec(url.pathname);
    if (match) return { routeKind, host: url.hostname.toLowerCase(), vacancyId: match[1], pagePath: url.pathname };
  }
  return null;
}

/**
 * The page's vacancy is the order's own posting: same host and the same vacancy id as one of the order's
 * posting or application URLs, and no other vacancy named by any of them (a conflicting URL leaves it unproven).
 */
export function vacancyBoundToOrder(route, urls = []) {
  if (!route || !APPLICATION_EXISTS_ROUTES[route.routeKind]) return false;
  const { vacancyOf } = APPLICATION_EXISTS_ROUTES[route.routeKind];
  const ids = new Set();
  for (const value of urls) {
    const url = httpsUrl(value);
    if (!url || url.hostname.toLowerCase() !== route.host) continue;
    const id = vacancyOf(url);
    if (id) ids.add(id);
  }
  return ids.size === 1 && ids.has(route.vacancyId);
}

/** Firestore map key of a portal host in `automation/accounts` (same rule as the runner's account store). */
export function portalAccountHostKey(host) {
  return String(host || '').toLowerCase().replace(/[^a-z0-9-]/g, '_').slice(0, 120);
}

/** The bounded evidence the runner puts on its handoff event; anything else is dropped. */
export function applicationExistsEvidenceOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = applicationExistsRoute(`https://${String(value.host || '')}${String(value.pagePath || '')}`);
  if (!route || route.routeKind !== value.routeKind || route.vacancyId !== String(value.vacancyId || '')) return null;
  return { routeKind: route.routeKind, host: route.host, vacancyId: route.vacancyId, pagePath: route.pagePath, vacancyBound: value.vacancyBound === true };
}

/** An uncertain outcome the flow itself holds: an ambiguous send, or the portal's «already applied» stop. */
const SEND_OUTCOME_HOLDS = new Set([
  'portal_ambiguous', 'portal_antibot_ambiguous', 'email_ambiguous', 'submission_receipt_invalid',
  'portal:account_application_history_uncertain', 'portal:account_application_already_applied',
  'account_application_history_uncertain', 'account_application_already_applied',
]);

/** The flow holds, or once held, a send whose outcome nobody confirmed as «not sent». */
export function sendOutcomeUnconfirmed(flow) {
  if ((Array.isArray(flow?.heldBy) ? flow.heldBy : []).some((held) => SEND_OUTCOME_HOLDS.has(String(held)))) return true;
  const marker = flow?.ambiguousSubmit;
  return Boolean(marker && typeof marker === 'object' && Number(marker.round) === (Number(flow?.round) || 1) && !marker.clearedAt);
}

/** A click on the round's record: the live one, or the one a later claim overwrote (`priorClickedAt`). */
function recordedClick(record) {
  return Number(record?.clickedAt) > 0 || Number(record?.priorClickedAt) > 0;
}

/**
 * Whether the «application exists» page proves the order was sent. Every condition must hold; a missing one
 * leaves the order `unknown` (held for the owner, never retried by itself).
 *
 * @param {{order?:object, flow?:object, draft?:object, submission?:object, accounts?:object,
 *   evidence?:object|null, ambiguousEvents?:number, urls?:string[]}} input
 *   `submission`: the round's record (automation/submission r<N>); `accounts`: automation/accounts;
 *   `ambiguousEvents`: how many runner events of this round ended in an ambiguous send.
 */
export function decideApplicationExistsReconciliation({
  order = {}, flow = {}, submission = null, accounts = {}, evidence = null, ambiguousEvents = 0, urls = [],
} = {}) {
  const route = evidence ? applicationExistsRoute(`https://${evidence.host}${evidence.pagePath}`) : null;
  const entry = route ? accounts?.[portalAccountHostKey(route.host)] : null;
  const alias = String(order?.candidateAlias?.address || '').trim().toLowerCase();
  const round = Number(flow?.round) || 1;
  const marker = flow?.ambiguousSubmit;
  const criteria = {
    routeRecognised: Boolean(route && route.routeKind === evidence.routeKind),
    vacancyBoundByRunner: evidence?.vacancyBound === true,
    vacancyBoundToOrder: vacancyBoundToOrder(route, urls),
    accountOnOrderAlias: Boolean(aliasLocalPart(alias) && String(entry?.email || '').trim().toLowerCase() === alias
      && entry?.status !== 'discarded'),
    ownSendRecorded: recordedClick(submission) || ambiguousEvents > 0
      || Boolean(marker && Number(marker.round) === round),
    notAlreadySent: submission?.state !== 'sent',
    orderOpen: !order?.withdrawnAt && !['submitted', 'withdrawn', 'refunded'].includes(order?.submissionStatus),
  };
  const reconcile = Object.values(criteria).every((value) => value === true);
  return { decision: reconcile ? 'reconcile' : 'unknown', criteria };
}
