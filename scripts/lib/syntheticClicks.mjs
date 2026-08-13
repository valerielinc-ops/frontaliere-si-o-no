/**
 * syntheticClicks.mjs — the single definition of "this click is not a person".
 *
 * WHY IT IS ITS OWN FILE (issues #5674, #5767)
 * ────────────────────────────────────────────
 * This started life inside scripts/lib/dailyBriefCadence.mjs, where its own
 * docblock already claimed to be "the single definition … what lets the sender,
 * the seeder and a future backfill share one rule set instead of three". It was
 * not: `grep -rln "isOptOutLink\|classifyClickEvents" scripts/` returned four
 * files and all four were the daily brief. The job-alert channel — a second
 * engagement-driven cadence, in production since 2026-07-16 — promoted people to
 * its fastest tier off a raw `last_click_at`, which is #5674 unfixed on the
 * channel that produced the LPD letter in the first place.
 *
 * So the rule moved here and dailyBriefCadence.mjs re-exports it, exactly the
 * way that file already re-exports EMAIL_SCANNER_IP_RANGES. Not copied:
 * the thresholds below are CALIBRATED on a measurement written into the comment,
 * and a second copy loses the calibration the day one side is tuned.
 *
 * The two callers, and what each can see:
 *   - daily brief  — `newsletter_subscribers/{email}`: events carry ip and
 *     user-agent, so all four rules fire.
 *   - job alerts   — `job_alert_subscribers/{email}`: the job-alert branches of
 *     the five webhook handlers write a POORER metadata than their newsletter
 *     twins in the same file. Measured 2026-08-13 on 393 click events of 40
 *     click-tier recipients: 0 with `metadata.ip`, 0 with `metadata.user_agent`.
 *     109 of them (the Resend ones) do carry the address — nested under
 *     `metadata.data.click.*`, where the extractors below now look. The rest of
 *     that gap is a webhook-side fix, tracked on #5705 §3.3.4; until then this
 *     channel runs on the URL rules and the burst rule, which is a MEASURED
 *     limitation, not an oversight — and it is why the job-alert classifier is
 *     fail-closed about clicks it cannot read.
 *
 * PURE. No I/O, no `Date.now()`.
 */

import { EMAIL_SCANNER_IP_RANGES } from './emailScannerRanges.mjs';

export { EMAIL_SCANNER_IP_RANGES };

/** Firestore Timestamp | Date | ISO string | millis → millis, or null. */
export function toMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// ── which clicks are a human? (#5674) ──────────────────────────────────────

/**
 * How dense a run of clicks has to be before it stops being a person.
 *
 * CALIBRATED, NOT GUESSED. Across the 3.099 click events of the 433 recipients
 * on the daily tier on 2026-08-12, "most distinct link targets inside a sliding
 * window" is sharply bimodal: 381 of 433 never exceed ONE target per second,
 * and the tail jumps straight to 7-20. Sweeping the pair:
 *
 *     window   >=4    >=5    >=6    >=7
 *      1s       17     17     15     14
 *      3s       18     17     16     16
 *      10s      18     18     17     17
 *
 * 3s/5 and 10s/5 differ by exactly one recipient, and that recipient is the
 * interesting one: 7 targets over 7,5 seconds, one stable IP, one stable
 * user-agent, 131 opens — a person opening job links in tabs at about one a
 * second. The scanners in the same table do 9 or 10 targets inside a single
 * second from one datacentre address. So the threshold is a RATE, set to sit in
 * the gap: five distinct targets in three seconds is 1,7 links a second
 * sustained, which the fast reader above does not reach and no scanner in this
 * data misses. Widening the window to 10s buys nothing but that reader.
 *
 * Erring here is asymmetric on purpose: a false positive slows a real reader
 * down one tier and any later genuine click promotes them straight back, while
 * a false negative keeps mailing daily someone who never opened anything —
 * which is what produced the LPD complaint.
 */
export const SCAN_BURST_WINDOW_MS = 3000;
export const SCAN_BURST_MIN_TARGETS = 5;

/**
 * Clients that are not a mail reader. `client_info.bot` and
 * `client_info['client-type'] === 'library'` are the providers' own verdicts
 * (Mailgun and Mailjet ship them); this pattern is for the rest.
 */
const AUTOMATION_AGENT_RE = /python-requests|curl\/|wget|Go-http-client|HeadlessChrome|PhantomJS|libwww|Java\/[\d.]|okhttp|node-fetch|axios\/|Apache-HttpClient|\bbot\b|spider|crawler|scanner/i;

/**
 * The opt-out link, in the four locales the mails go out in plus the raw query
 * forms the unsubscribe routes use. Kept deliberately narrow: it must not match
 * an editorial page that merely talks about unsubscribing.
 *
 * TWO ALTERNATIVES ARE WIDER THAN THEY LOOK, AND BOTH ARE #5767:
 *
 *  - `\/disiscrivi(?:ti|-[a-z]+)\b` instead of `\/disiscriviti\b`. The job-alert
 *    unsubscribe route is `/disiscrivi-alert/` (scripts/lib/job-alert-unsub-urls.mjs
 *    `JOB_ALERT_UNSUB_URL`) — a different string, not a suffix of `disiscriviti`,
 *    so the old branch could never see it. The `(?:ti|-…)` shape still refuses
 *    `/blog/come-disiscriversi-…`, which has its own test.
 *  - `[?&]action=unsubscribe` with NO trailing `\b`. `makeAllAlertsUnsubscribeUrl`
 *    emits `action=unsubscribe_all`, and `_` is a WORD character: there is no
 *    word boundary between `unsubscribe` and `_all`, so `\b` refused to match
 *    the strongest opt-out link we send. This is the insidious half — the rule
 *    reads as correct. Anchoring on "the value STARTS WITH unsubscribe" is the
 *    honest statement of the intent and cannot be broken by the next suffix.
 *
 * Both widen the class, never narrow it: the only effect on a caller is that
 * more clicks are read as synthetic, which slows sending down. That is the safe
 * direction to be wrong in, for the reason the calibration note above states.
 */
const OPT_OUT_LINK_RE = /[?&]action=unsubscribe|[?&]unsubscribe=|\/unsubscribe\b|\/disiscrivi(?:ti|-[a-z]+)\b|\/abmelden\b|\/desabonnement\b|\/se-desabonner\b|list-unsubscribe/i;

/** The preferences centre — the other link somebody clicks to receive LESS. */
const PREFERENCES_LINK_RE = /[?&]action=preferences\b|\/preferenze\b|\/preferences\b|\/einstellungen\b|\/preferences-email\b|manage-?preferences/i;

/** Off-site social profiles: present in the footer of every edition. */
const SOCIAL_LINK_RE = /\/\/(?:[a-z0-9-]+\.)?(?:linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|t\.me|wa\.me|whatsapp\.com|youtube\.com)\//i;

/** True when this URL is the way out of the list, in any of the four locales. */
export function isOptOutLink(url) {
  return typeof url === 'string' && url !== '' && OPT_OUT_LINK_RE.test(url);
}

/** True when the user-agent (or the provider's own bot flag) is not a reader. */
export function isAutomationAgent(userAgent) {
  return typeof userAgent === 'string' && userAgent !== '' && AUTOMATION_AGENT_RE.test(userAgent);
}

/**
 * IPv4 CIDR membership. IPv6 returns false rather than guessing: scanners that
 * reach us over v6 are caught by the burst rule, and a wrong v6 prefix would
 * silently demote whole ISPs.
 */
export function ipInCidr(ip, cidr) {
  if (typeof ip !== 'string' || typeof cidr !== 'string') return false;
  if (ip.includes(':') || !cidr.includes('/')) return false;
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (value) => {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255 || part === '') return null;
      out = (out * 256) + octet;
    }
    return out >>> 0;
  };
  const a = toInt(ip);
  const b = toInt(network);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** True when the address belongs to one of the listed scanner ranges. */
export function isScannerIp(ip, ranges = EMAIL_SCANNER_IP_RANGES) {
  for (const range of ranges || []) {
    if (ipInCidr(ip, typeof range === 'string' ? range : range?.cidr)) return true;
  }
  return false;
}

/** Which kind of link this is — the input to the "contradictory window" rule. */
function linkClassOf(url) {
  if (isOptOutLink(url)) return 'opt-out';
  if (typeof url === 'string' && PREFERENCES_LINK_RE.test(url)) return 'preferences';
  if (typeof url === 'string' && SOCIAL_LINK_RE.test(url)) return 'social';
  return 'content';
}

/**
 * Everything the providers call a URL, in one place.
 *
 * The last branch is Resend, whose handler stores the raw webhook body verbatim
 * (`metadata: rawEvent`, functions/src/newsletterResendWebhookCore.js) so the
 * link sits one level down. Reading the nesting HERE rather than in a
 * caller-side adapter is deliberate: an adapter is a contract with no import
 * shape, and a caller who forgets to apply it gets a green test over a dead
 * rule — the failure mode this whole file exists to stop.
 */
function clickUrlOf(event) {
  return event?.url
    ?? event?.target_url
    ?? event?.link_url
    ?? event?.metadata?.url
    ?? event?.metadata?.original_url
    ?? event?.metadata?.data?.click?.link
    ?? '';
}

/** Everything the providers call a user-agent, in one place. */
function clickAgentOf(event) {
  return event?.userAgent
    ?? event?.user_agent
    ?? event?.metadata?.user_agent
    ?? event?.metadata?.agent
    ?? event?.metadata?.client_info?.['user-agent']
    ?? event?.metadata?.data?.click?.userAgent
    ?? '';
}

/** Everything the providers call a source address, in one place. */
function clickIpOf(event) {
  return event?.ip
    ?? event?.metadata?.ip
    ?? event?.metadata?.data?.click?.ipAddress
    ?? '';
}

/**
 * The single definition of "this click does not count as engagement".
 *
 * Takes whatever click evidence the caller happens to have — a whole `events`
 * subcollection, or the one click the subscriber document remembers — and
 * returns a verdict per event plus the timestamp of the most recent one that
 * looks like a person. With a single event the two window rules cannot fire,
 * which is correct: one click is not a burst. That is what lets the sender, the
 * seeder and a future backfill share one rule set instead of three.
 *
 * The four reasons, in the order they are checked:
 *
 *  - `opt-out-link` — a click on the way out. Never engagement, whatever else
 *    is true about it. Promoting somebody who is trying to leave is the single
 *    worst thing this engine can do, and it is not a scanner question.
 *  - `automation-agent` — the client is a library, or the provider flagged it.
 *  - `scanner-ip` — the source address is in `EMAIL_SCANNER_IP_RANGES`.
 *  - `scan-burst` — the click sits in a window of `SCAN_BURST_WINDOW_MS` that
 *    holds `SCAN_BURST_MIN_TARGETS` distinct link targets, or one that mixes
 *    the opt-out link with two other link classes. Nobody unsubscribes, follows
 *    us on LinkedIn and opens an article in the same three seconds; a scanner
 *    walking the message top to bottom does exactly that.
 *
 * `lastOptOutClickAtMs` is reported beside `lastHumanClickAtMs` because the two
 * answer different questions. The first is "did a person ask to leave, and when"
 * — a NEGATIVE signal a cadence engine may act on (jobAlertEngagementTier.mjs
 * demotes on it); the second is "did a person show interest". Without it a
 * caller has to re-derive the opt-out from `byReason`, which cannot say *when*.
 *
 * @param {Array<object>} events click events; each may carry
 *        `{ at|occurred_at|timestamp, url|target_url|link_url|metadata.url,
 *           metadata.ip, metadata.user_agent, metadata.client_info,
 *           metadata.data.click.{link,ipAddress,userAgent} }`
 * @param {object} [options]
 * @param {ReadonlyArray<object|string>} [options.scannerRanges]
 * @returns {{ verdicts: Array<{atMs: number|null, url: string, synthetic: boolean, reason: string|null}>,
 *             humanCount: number, syntheticCount: number,
 *             lastHumanClickAtMs: number|null, lastOptOutClickAtMs: number|null,
 *             byReason: Record<string, number> }}
 */
export function classifyClickEvents(events, { scannerRanges = EMAIL_SCANNER_IP_RANGES } = {}) {
  const rows = (Array.isArray(events) ? events : [])
    .map((event) => ({
      atMs: toMillis(event?.at ?? event?.atMs ?? event?.occurred_at ?? event?.timestamp ?? event?.clicked_at),
      url: String(clickUrlOf(event) || ''),
      ip: String(clickIpOf(event) || ''),
      agent: String(clickAgentOf(event) || ''),
      botFlag: Boolean(event?.metadata?.client_info?.bot)
        || event?.metadata?.client_info?.['client-type'] === 'library',
    }))
    .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

  // Two events written at the same instant for the same target are one click:
  // four of the five providers write an event twice (report-send-hour-impact.mjs
  // documents the duplicate-doc-id class), and counting the copy as a second
  // target would manufacture bursts out of our own bookkeeping.
  const targetOf = (row) => row.url.split('?')[0];
  const burst = new Set();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].atMs == null) continue;
    const targets = new Set();
    const classes = new Set();
    const window = [];
    for (let j = i; j < rows.length; j++) {
      if (rows[j].atMs == null || rows[j].atMs - rows[i].atMs > SCAN_BURST_WINDOW_MS) break;
      targets.add(targetOf(rows[j]));
      classes.add(linkClassOf(rows[j].url));
      window.push(j);
    }
    const contradictory = classes.has('opt-out') && classes.size >= 3;
    if (targets.size >= SCAN_BURST_MIN_TARGETS || contradictory) {
      for (const j of window) burst.add(j);
    }
  }

  const byReason = {};
  let lastHumanClickAtMs = null;
  let lastOptOutClickAtMs = null;
  let humanCount = 0;
  const verdicts = rows.map((row, index) => {
    let reason = null;
    if (isOptOutLink(row.url)) reason = 'opt-out-link';
    else if (row.botFlag || isAutomationAgent(row.agent)) reason = 'automation-agent';
    else if (isScannerIp(row.ip, scannerRanges)) reason = 'scanner-ip';
    else if (burst.has(index)) reason = 'scan-burst';

    if (reason) {
      byReason[reason] = (byReason[reason] || 0) + 1;
      if (reason === 'opt-out-link' && row.atMs != null
        && (lastOptOutClickAtMs == null || row.atMs > lastOptOutClickAtMs)) {
        lastOptOutClickAtMs = row.atMs;
      }
    } else {
      humanCount++;
      if (row.atMs != null && (lastHumanClickAtMs == null || row.atMs > lastHumanClickAtMs)) {
        lastHumanClickAtMs = row.atMs;
      }
    }
    return { atMs: row.atMs, url: row.url, synthetic: reason != null, reason };
  });

  return {
    verdicts,
    humanCount,
    syntheticCount: verdicts.length - humanCount,
    lastHumanClickAtMs,
    lastOptOutClickAtMs,
    byReason,
  };
}
