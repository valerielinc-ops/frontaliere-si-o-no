/**
 * Delivery-safe receipt of every rewarded grant and what happened after it.
 *
 * Live check 30-09: 33 `rewarded_application_access_granted` against 18
 * hand-off events (`_auto` + `_shown`), although the code emits one of the
 * two on every grant. Those events leave at the very moment the employer's
 * tab takes the foreground, so they may be lost with the page going to the
 * background; or a path skips the hand-off. GA4 alone cannot tell which.
 *
 * So each grant writes a record to localStorage (synchronous, survives the
 * tab switch and the next visit), updated as the hand-off goes on, and the
 * record is sent later, while the page is visible: 5 s after the grant, on
 * the return to the tab, or on the next job-board page view. One
 * `rewarded_receipt_<route>_<result>` event per grant, the name carrying the
 * outcome (GA4 reads it with no custom dimension, by browser and OS):
 *   route  auto    = opened at once inside the click's activation,
 *          card    = the "open" card (no activation, or a WebKit browser),
 *          blocked = opened at once but no tab took the foreground → card,
 *          none    = no hand-off at all after the grant (a code path gap);
 *   result opened  = a new tab took the foreground (auto) or the card was clicked,
 *          left    = neither.
 * receipts ≈ grants and few `none` → the immediate events were lost in
 * transit; many `none` → a path skips the hand-off.
 */

import { trackAssistedApplicationEvent } from './assistedApplicationExperiment';

export type HandoffRoute = 'none' | 'auto' | 'card' | 'blocked';

export const HANDOFF_RECEIPT_EVENTS = [
  'rewarded_receipt_auto_opened',
  'rewarded_receipt_auto_left',
  'rewarded_receipt_card_opened',
  'rewarded_receipt_card_left',
  'rewarded_receipt_blocked_opened',
  'rewarded_receipt_blocked_left',
  'rewarded_receipt_none',
] as const;
export type HandoffReceiptEvent = (typeof HANDOFF_RECEIPT_EVENTS)[number];

interface LedgerEntry {
  id: string;
  at: number;
  jobId: string;
  companyId: string;
  path: 'offerwall' | 'gpt';
  route: HandoffRoute;
  opened: 0 | 1;
}

const STORAGE_KEY = 'ft_rewarded_handoff_ledger_v1';
/** A record is sent once the hand-off had time to happen. */
export const HANDOFF_RECEIPT_MIN_AGE_MS = 5000;
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function read(): LedgerEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && typeof e.at === 'number') : [];
  } catch {
    return [];
  }
}

function write(list: LedgerEntry[]): void {
  try {
    const fresh = list.filter((e) => Date.now() - e.at < MAX_AGE_MS).slice(-MAX_ENTRIES);
    if (fresh.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: no receipt, the immediate events still go out.
  }
}

function update(id: string | null, change: (entry: LedgerEntry) => void): void {
  if (!id) return;
  const list = read();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  change(entry);
  write(list);
}

/** Records a grant; returns its id for the later marks (null without storage). */
export function recordHandoffGrant(
  info: { jobId: string; companyId: string; path: 'offerwall' | 'gpt' },
  now: number = Date.now(),
): string | null {
  if (typeof window === 'undefined') return null;
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  const list = read();
  list.push({ id, at: now, jobId: info.jobId, companyId: info.companyId, path: info.path, route: 'none', opened: 0 });
  write(list);
  return read().some((e) => e.id === id) ? id : null;
}

/** The hand-off took this route; `blocked` wins over the `auto` it follows. */
export function markHandoffRoute(id: string | null, route: Exclude<HandoffRoute, 'none'>): void {
  update(id, (entry) => {
    if (entry.route === 'blocked' && route === 'card') return;
    entry.route = route;
  });
}

/** A new tab took the foreground, or the card was clicked. */
export function markHandoffOpened(id: string | null): void {
  update(id, (entry) => {
    entry.opened = 1;
  });
}

export function receiptEventName(entry: Pick<LedgerEntry, 'route' | 'opened'>): HandoffReceiptEvent {
  if (entry.route === 'none') return 'rewarded_receipt_none';
  return `rewarded_receipt_${entry.route}_${entry.opened ? 'opened' : 'left'}` as HandoffReceiptEvent;
}

/**
 * Sends and removes every record old enough, while the page is visible (a
 * send from a hidden page is the loss this ledger works around).
 */
export function flushHandoffReceipts(now: number = Date.now()): number {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return 0;
  const list = read();
  const due = list.filter((e) => now - e.at >= HANDOFF_RECEIPT_MIN_AGE_MS);
  if (!due.length) return 0;
  write(list.filter((e) => now - e.at < HANDOFF_RECEIPT_MIN_AGE_MS));
  for (const entry of due) {
    trackAssistedApplicationEvent(receiptEventName(entry), {
      variant: 'rewarded_ad',
      jobId: entry.jobId,
      companyId: entry.companyId,
      surface: 'job_detail_rewarded_inline',
      grant_path: entry.path,
      ms_since_grant: Math.max(0, Math.round(now - entry.at)),
    });
  }
  return due.length;
}

/**
 * After a grant: flush once the record is due while the page is still
 * visible (card, blocked tab), or on the first return to the tab.
 */
export function scheduleHandoffReceiptFlush(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (flushHandoffReceipts() > 0 || read().length === 0) document.removeEventListener('visibilitychange', onVisible);
  };
  window.setTimeout(() => {
    flushHandoffReceipts();
    if (read().length) document.addEventListener('visibilitychange', onVisible);
  }, HANDOFF_RECEIPT_MIN_AGE_MS + 500);
}
