/**
 * AdBlock detection — client-only, dual-signal probe (#3654).
 *
 * Two independent signals, combined so a false positive on either alone does
 * not trip the gate:
 *   1. Bait element — an offscreen div using classnames that ad-blocker
 *      cookbook filters (EasyList/EasyPrivacy and most commercial blockers)
 *      hide via CSS (`display:none`/`visibility:hidden`/zero box). This is
 *      the same technique documented publicly by the IAB and reproduced by
 *      most "detect adblock" write-ups (including the pattern visible on
 *      ispazio.net via public inspection of their page — a hidden bait node
 *      + computed-style check, no code copied, only the technique).
 *   2. Network probe — a `fetch()` to a known ad-serving script URL
 *      (AdSense's own `adsbygoogle.js`, already loaded elsewhere on this
 *      site for real ads). Network-level blockers (uBlock Origin, Brave
 *      Shields, etc.) reject this at the request level; the promise
 *      rejection/opaque failure is itself the signal, no response body is
 *      read or required.
 *
 * Both checks are best-effort and resolve `false` (no ad blocker detected)
 * on any ambiguity — the gate must never trap a user due to a detection
 * false positive.
 */

const BAIT_CLASSNAMES = [
 'adsbox',
 'ad-banner',
 'adsbygoogle',
 'ad-placement',
 'textads',
 'banner-ads',
 'ad-container',
].join(' ');

const NETWORK_PROBE_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

const SETTLE_DELAY_MS = 120;
/** How long to keep re-checking the bait before giving up on it. */
const BAIT_DEADLINE_MS = 900;
const NETWORK_TIMEOUT_MS = 1500;

function detectViaBaitElement(): Promise<boolean> {
 return new Promise((resolve) => {
 if (typeof document === 'undefined') { resolve(false); return; }
 const bait = document.createElement('div');
 bait.className = BAIT_CLASSNAMES;
 bait.setAttribute('aria-hidden', 'true');
 // Keep it out of the visual flow but still laid out (offscreen, not
 // display:none) so blockers that hide via CSS actually have something
 // to act on.
 bait.style.position = 'absolute';
 bait.style.left = '-9999px';
 bait.style.top = '-9999px';
 bait.style.width = '1px';
 bait.style.height = '1px';
 bait.style.pointerEvents = 'none';
 try {
 document.body.appendChild(bait);
 } catch {
 resolve(false);
 return;
 }
 // Poll rather than look once. A blocker applies its cosmetic rules from a
 // content script, and on a slow device that can land well after a single
 // 120ms check has already concluded "not blocked" — a false negative that
 // costs the whole visitor. Resolving as soon as the bait is hidden keeps the
 // fast path fast; the deadline only bounds the slow one.
 const startedAt = Date.now();
 const check = () => {
 let blocked = false;
 try {
 const rect = bait.getBoundingClientRect();
 const style = window.getComputedStyle(bait);
 blocked = rect.height === 0 || style.display === 'none' || style.visibility === 'hidden';
 } catch {
 blocked = false;
 }
 if (blocked || Date.now() - startedAt >= BAIT_DEADLINE_MS) {
 try { bait.remove(); } catch { /* noop */ }
 resolve(blocked);
 return;
 }
 window.setTimeout(check, SETTLE_DELAY_MS);
 };
 window.setTimeout(check, SETTLE_DELAY_MS);
 });
}

function detectViaNetworkProbe(): Promise<boolean> {
 if (typeof fetch === 'undefined') return Promise.resolve(false);
 return new Promise((resolve) => {
 const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
 const timer = window.setTimeout(() => {
 controller?.abort();
 resolve(false); // Timeout is ambiguous (slow network) — do not count as blocked.
 }, NETWORK_TIMEOUT_MS);
 fetch(NETWORK_PROBE_URL, { method: 'HEAD', mode: 'no-cors', signal: controller?.signal })
 .then(() => {
 window.clearTimeout(timer);
 resolve(false);
 })
 .catch(() => {
 window.clearTimeout(timer);
 // A rejected fetch to a known ad-serving host is the network-level
 // block signal (DNS sinkhole, blocklist rule, extension request
 // interception all surface as a rejected promise here).
 resolve(true);
 });
 });
}

/**
 * Resolve whether an ad blocker is active. Runs both signals in parallel;
 * either one alone is sufficient to report `true` (OR combination) since
 * both are independently indicative and neither has known false-positive
 * modes beyond "ambiguous" (which resolves to `false` internally already).
 */
/**
 * What the page already knows about this visitor's ad blocker.
 *
 * `source` matters when reading the numbers. 'funding_choices' is Google's own
 * detection, which this site already runs: the ad blocking recovery tag is in
 * index.html and Ad Manager reports on it. Measured 2026-06-16..08-17, Google
 * saw a ~5% extension rate while the heuristic below fired on 2.5% of the same
 * population — the local probe finds roughly half of what Google does, which is
 * why it is now the fallback rather than the answer.
 */
export type AdBlockSignal = {
 blocked: boolean;
 /** The visitor already allowlisted this site — never gate them again. */
 adsAllowed: boolean;
 source: 'funding_choices' | 'heuristic';
 status: string | number | null;
};

/** Shape index.html's AD_BLOCK_DATA_READY bridge stashes on window. */
type FcBridgePayload = { blocked?: boolean; adsAllowed?: boolean; status?: string | number | null };

const FC_SIGNAL_EVENT = 'frontaliere:adblock-data';
const FC_WAIT_MS = 3000;

function readFcSignal(): AdBlockSignal | null {
 const raw = (window as unknown as { __ftAdBlock?: FcBridgePayload }).__ftAdBlock;
 if (!raw || typeof raw.blocked !== 'boolean') return null;
 return {
 blocked: raw.blocked,
 adsAllowed: raw.adsAllowed === true,
 source: 'funding_choices',
 status: raw.status ?? null,
 };
}

function waitForFcSignal(timeoutMs: number): Promise<AdBlockSignal | null> {
 const immediate = readFcSignal();
 if (immediate) return Promise.resolve(immediate);
 // Only wait when there is something to wait FOR. index.html's bridge sets
 // this flag synchronously, before the Funding Choices tag, so its absence
 // means no answer is coming — a server render, a test, a page that never
 // shipped the bridge. Waiting the full timeout on those would delay the gate
 // for everyone to no purpose.
 if (!(window as unknown as { __ftFcAdBlockBridge?: unknown }).__ftFcAdBlockBridge) {
 return Promise.resolve(null);
 }
 return new Promise((resolve) => {
 let settled = false;
 const finish = (value: AdBlockSignal | null) => {
 if (settled) return;
 settled = true;
 window.removeEventListener(FC_SIGNAL_EVENT, onData);
 window.clearTimeout(timer);
 resolve(value);
 };
 const onData = () => finish(readFcSignal());
 window.addEventListener(FC_SIGNAL_EVENT, onData);
 const timer = window.setTimeout(() => finish(null), timeoutMs);
 });
}

export async function detectAdBlockDetailed(): Promise<AdBlockSignal> {
 const none: AdBlockSignal = { blocked: false, adsAllowed: false, source: 'heuristic', status: null };
 if (typeof window === 'undefined') return none;
 try {
 // Both start now. Google's answer wins when it arrives — it is maintained
 // against the filter lists, it separates extension-level from network-level
 // blocking, and it reports whether the visitor already allowlisted the site,
 // which no bait element can ever know. Running the local probe concurrently
 // rather than after means a silent Funding Choices costs the wait once, not
 // the wait plus a probe.
 const heuristic = Promise.all([detectViaBaitElement(), detectViaNetworkProbe()])
 .then(([baitBlocked, networkBlocked]) => baitBlocked || networkBlocked)
 .catch(() => false);

 const fc = await waitForFcSignal(FC_WAIT_MS);
 if (fc) return fc;

 // Funding Choices never reported. Silence is weak evidence of a
 // network-level blocker, its own script being a common target, but it is
 // equally consistent with a slow network — so read the probe rather than
 // convict on silence.
 return { ...none, blocked: await heuristic };
 } catch {
 return none;
 }
}

export async function detectAdBlock(): Promise<boolean> {
 return (await detectAdBlockDetailed()).blocked;
}
