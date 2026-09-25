/**
 * returnVisit.js — the single definition of "a person actually came back to the
 * site", and of the ways a page load can look like a return without being one.
 *
 * WHY IT EXISTS (issue #5705, owner's decision of 2026-08-14)
 * ──────────────────────────────────────────────────────────
 * A job alert that reached the terminal `cadence_state: 'decayed'` comes back to
 * life on its own when the person returns to the site. The owner chose the
 * automatic behaviour after the objection was put to him in as many words: it is
 * an INFERENCE — we deduce a wish to receive email from a behaviour that is not
 * about email at all. He accepted the inference and asked, in the same breath,
 * that it not be drawn in the cases where it is obviously wrong. This file is
 * that list, and it is the reason the rule is one function instead of an `if`
 * inside a React component.
 *
 * NOTHING HERE IS A NEW DETECTOR. Every verdict is delegated:
 *   - a machine client            → `isAutomationAgent` (./syntheticClicks.js)
 *   - a corporate scanner address → `isScannerIp` (same file, same CIDR list)
 *   - a crawler                   → CRAWLER_UA_RE below, which is the pattern
 *     components/community/JobBoard.tsx and NewsletterPopup.tsx have both been
 *     running inline since long before this issue; they now import it from here.
 *     It was duplicated verbatim in two components, which is how the daily
 *     brief's click rule came to have three bodies (#5674, #5767).
 *   - the way out                 → `isOptOutLink` / `isPreferencesLink`, the
 *     same two predicates the click classifier uses to refuse promoting a
 *     person who clicked to leave.
 *
 * The one thing this file adds is the SHAPE of the recorded visit and the order
 * the predicates are asked in — plus `redactVisitEntryUrl`, which is what makes
 * recording the landing URL safe at all (see below).
 *
 * FAIL-CLOSED, ON EVERY AXIS. A stamp that is missing, unreadable, undated,
 * unattributed, or that says nothing about whether the page was ever shown, is
 * NOT a return. The cost of the two errors is not symmetric: refusing a real
 * return leaves an alert decayed until the person does something explicit in the
 * preference centre, which is the exit the design already has; accepting a false
 * one resumes email to somebody who never asked for it on the channel that
 * produced the LPD complaint.
 *
 * WHY THE LANDING URL IS REDACTED BEFORE IT IS EVER STORED.
 * The two link classes that matter here — the unsubscribe route and the
 * preference centre — are recognised from the PATH and from a single query
 * parameter (`action`). Everything else in the query string of those URLs is a
 * signed token and an address. `redactVisitEntryUrl` keeps exactly what the
 * predicates read and drops the rest, so the stored evidence cannot become a
 * second copy of a working unsubscribe link sitting in Firestore.
 *
 * PURE. No I/O, no `Date.now()`, no `document`. The browser fills the shape in
 * services/jobAlertReturnVisit.ts; the sender re-runs this function on what was
 * stored, because `job_alert_subscribers/{email}` is `allow write: if true` in
 * firestore.rules and a client-attested field is a claim, not a fact.
 */

import {
  EMAIL_SCANNER_IP_RANGES,
  isAutomationAgent,
  isOptOutLink,
  isPreferencesLink,
  isScannerIp,
  toMillis,
} from './syntheticClicks.js';

export { isAutomationAgent, isOptOutLink, isPreferencesLink, isScannerIp };

/**
 * The crawler pattern, moved verbatim out of components/community/JobBoard.tsx
 * and components/community/NewsletterPopup.tsx, which carried two byte-identical
 * copies of it and now import this one.
 *
 * It overlaps `AUTOMATION_AGENT_RE` in ./syntheticClicks.js without being
 * contained by it, and both are asked: this one knows the search engines by name
 * (`googlebot`, `bingbot`, `applebot`, `slurp`, the social unfurlers), which the
 * click classifier deliberately does not, because a search engine never clicks a
 * link in an email but does load pages. Keeping both is the union, and the union
 * is the direction it is safe to be wrong in.
 */
export const CRAWLER_UA_RE = /bot|crawler|spider|crawling|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|semrushbot|ahrefsbot|applebot|slurp|facebookexternalhit|linkedinbot|twitterbot|whatsapp/i;

/** True when this user-agent is a crawler or a social unfurler, not a reader. */
export function isCrawlerVisitorAgent(userAgent) {
  return typeof userAgent === 'string' && userAgent !== '' && CRAWLER_UA_RE.test(userAgent);
}

/**
 * Why a page load was NOT accepted as a return. Every value is a string a log
 * line and a test can name; `OK` is the only one that reactivates anything.
 *
 * The seven the owner approved map onto these as follows — the first four are
 * decided here, from the visit itself; the last three need the stored documents
 * and live in scripts/lib/jobAlertCadence.mjs, because they are statements about
 * the alert and the address rather than about the page load:
 *
 *   1. scanners and bots      → CRAWLER_AGENT / AUTOMATION_AGENT / SCANNER_IP
 *   2. somebody on their way out → OPT_OUT_ENTRY
 *   6. an anonymous visit     → ANONYMOUS
 *   7. an email client prefetching → PREFETCH
 *
 *   3. an active opt-out      → jobAlertCadence.mjs
 *   4. a suppressed address   → jobAlertCadence.mjs
 *   5. an alert the person switched off → jobAlertCadence.mjs
 */
export const RETURN_VISIT_VERDICTS = Object.freeze({
  OK: 'ok',
  NO_VISIT: 'no-visit',
  UNREADABLE: 'unreadable-visit',
  CRAWLER_AGENT: 'crawler-agent',
  AUTOMATION_AGENT: 'automation-agent',
  SCANNER_IP: 'scanner-ip',
  OPT_OUT_ENTRY: 'opt-out-entry',
  PREFETCH: 'prefetch',
  ANONYMOUS: 'anonymous-visit',
});

/**
 * Keep the origin, the path and the single query parameter the link predicates
 * read (`action`); drop everything else.
 *
 * `action` survives because `makeAllAlertsUnsubscribeUrl` encodes the strongest
 * opt-out we send as `?action=unsubscribe_all` with no distinguishing path, so
 * dropping the query would silently turn the most important case of filter 2
 * into an unrecognised content URL — the exact shape of the defect #5767 fixed
 * in the click classifier. Everything else in those URLs (`email`, `token`,
 * `alertId`, `ac`) is either a person's address or a working credential.
 *
 * Returns `''` for anything unparseable, which the classifier then treats as
 * "no evidence about the landing page" — not as "a safe landing page".
 */
export function redactVisitEntryUrl(url) {
  if (typeof url !== 'string' || url === '') return '';
  let parsed;
  try {
    parsed = new URL(url, 'https://frontaliereticino.ch');
  } catch {
    return '';
  }
  const action = parsed.searchParams.get('action');
  return `${parsed.origin}${parsed.pathname}${action ? `?action=${encodeURIComponent(action)}` : ''}`;
}

/** The field spellings the stamp is read under, snake_case and camelCase both. */
const VISIT_FIELDS = Object.freeze({
  at: ['last_site_visit_at', 'lastSiteVisitAt'],
  uid: ['last_site_visit_uid', 'lastSiteVisitUid'],
  userAgent: ['last_site_visit_ua', 'lastSiteVisitUa'],
  entryUrl: ['last_site_visit_entry', 'lastSiteVisitEntry'],
  visible: ['last_site_visit_visible', 'lastSiteVisitVisible'],
  prerender: ['last_site_visit_prerender', 'lastSiteVisitPrerender'],
  ip: ['last_site_visit_ip', 'lastSiteVisitIp'],
});

const firstOf = (doc, names) => {
  for (const name of names) {
    const value = doc?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/**
 * The visit a `job_alert_subscribers/{email}` document remembers, or `null`.
 *
 * BOTH SPELLINGS, always. 458 production documents on this channel carry only
 * the camelCase form of their engagement stamps (#5673), and the two defects
 * that family produced (#5733, #5741) both looked exactly like this: a reader
 * that knew one spelling, a suite whose every fixture used the other, and a
 * branch that quietly returned the fail-OPEN answer. Here a missed stamp reads
 * as "never came back", which is the safe direction — but a missed stamp on a
 * projection that camelCases everything would make the whole feature dead code,
 * and dead code with a green suite is what this repo keeps finding.
 */
export function readReturnVisitStamp(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const at = firstOf(sub, VISIT_FIELDS.at);
  const uid = firstOf(sub, VISIT_FIELDS.uid);
  const userAgent = firstOf(sub, VISIT_FIELDS.userAgent);
  const entryUrl = firstOf(sub, VISIT_FIELDS.entryUrl);
  const visible = firstOf(sub, VISIT_FIELDS.visible);
  const prerender = firstOf(sub, VISIT_FIELDS.prerender);
  const ip = firstOf(sub, VISIT_FIELDS.ip);
  if (at == null && uid == null && userAgent == null && entryUrl == null) return null;
  return {
    atMs: toMillis(at),
    uid: uid == null ? '' : String(uid),
    userAgent: userAgent == null ? '' : String(userAgent),
    entryUrl: entryUrl == null ? '' : String(entryUrl),
    visible: visible === true || visible === 'true',
    prerender: prerender === true || prerender === 'true',
    ip: ip == null ? '' : String(ip),
  };
}

/**
 * Did a person come back, as far as the page load alone can tell?
 *
 * @param {object|null} visit the shape `readReturnVisitStamp` returns
 * @param {object} [options]
 * @param {ReadonlyArray<object|string>} [options.scannerRanges]
 * @returns {{ returned: boolean, verdict: string, reason: string }}
 */
export function classifyReturnVisit(visit, { scannerRanges = EMAIL_SCANNER_IP_RANGES } = {}) {
  const no = (verdict, reason) => ({ returned: false, verdict, reason });

  if (!visit || typeof visit !== 'object') {
    return no(RETURN_VISIT_VERDICTS.NO_VISIT, 'no return-visit stamp on the document');
  }
  if (!Number.isFinite(visit.atMs)) {
    return no(RETURN_VISIT_VERDICTS.UNREADABLE, 'the return-visit stamp carries no readable instant');
  }

  // 7. A prefetch. An email client (or the browser's own speculation rules)
  // pulled the page down without anybody looking at it. `visible` is required to
  // be literally true rather than "not false": a stamp that says nothing about
  // whether the page was ever shown is not evidence that it was.
  if (visit.prerender === true) {
    return no(RETURN_VISIT_VERDICTS.PREFETCH, 'the page was prerendered, not opened');
  }
  if (visit.visible !== true) {
    return no(RETURN_VISIT_VERDICTS.PREFETCH, 'the page was never reported visible');
  }

  // 1. Scanners and bots.
  if (isCrawlerVisitorAgent(visit.userAgent)) {
    return no(RETURN_VISIT_VERDICTS.CRAWLER_AGENT, 'the user-agent is a crawler');
  }
  if (isAutomationAgent(visit.userAgent)) {
    return no(RETURN_VISIT_VERDICTS.AUTOMATION_AGENT, 'the user-agent is an automation client');
  }
  if (visit.ip && isScannerIp(visit.ip, scannerRanges)) {
    return no(RETURN_VISIT_VERDICTS.SCANNER_IP, 'the source address is a mail-scanner range');
  }

  // 2. Somebody who was on their way OUT. This is the case the owner named
  // first, and reactivating on it would be the exact opposite of the wish the
  // click expressed: the visit exists because they followed the unsubscribe
  // link or opened the preference centre.
  if (isOptOutLink(visit.entryUrl) || isPreferencesLink(visit.entryUrl)) {
    return no(RETURN_VISIT_VERDICTS.OPT_OUT_ENTRY, 'the session started on the way out (unsubscribe or preference centre)');
  }

  // 6. An anonymous visit. Nobody to reactivate.
  if (!visit.uid) {
    return no(RETURN_VISIT_VERDICTS.ANONYMOUS, 'the session carries no identity');
  }

  return { returned: true, verdict: RETURN_VISIT_VERDICTS.OK, reason: 'a recognised person opened the site' };
}
