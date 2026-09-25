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
 const remaining = BAIT_DEADLINE_MS - (Date.now() - startedAt);
 if (blocked || remaining <= 0) {
 try { bait.remove(); } catch { /* noop */ }
 resolve(blocked);
 return;
 }
 // Schedule the remainder, not another full tick: chaining a fixed cadence
 // overshoots the deadline by up to one tick, and the constant is named as a
 // cutoff.
 window.setTimeout(check, Math.min(SETTLE_DELAY_MS, remaining));
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
// Must outlast the worst case of the idle-callback scheduling that the
// static shell and the SPA entry both use to start loading Funding Choices
// on a visitor without stored consent (a 4-second ceiling before that load
// even begins, see the loader construct in build-plugins/constants.ts and
// the matching inline script in index.html), plus headroom for that script's
// own fetch+exec before it can report a verdict. 3000ms used to sit under
// that 4-second floor, so Funding Choices could still not have started when
// this gave up and fell back to the weaker local probe (issue #6064).
// Deliberately NOT touching that 4-second ceiling itself: it gates a script
// fetch inline in the initial HTML and is LCP-sensitive, whereas this wait
// only delays when the (lazy-loaded, client-only) ad-block gate resolves its
// verdict — off the LCP path.
const FC_WAIT_MS = 6000;

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

/** Options for {@link detectAdBlockDetailed}. */
export type AdBlockDetectOptions = {
 /**
  * Re-reading after the visitor says they acted on the gate.
  *
  * The Funding Choices answer is captured ONCE, when AD_BLOCK_DATA_READY
  * fires, and nothing refreshes it — FC does not re-run its detection inside
  * a live document, and the bridge in index.html guards itself against
  * registering twice. So on any second read its `blocked` is load-time truth,
  * and letting it win makes the recheck button structurally unable to
  * succeed: it would keep reporting the blocker the visitor just switched
  * off, for the whole lifetime of the page. With this flag `blocked` comes
  * from the live probe instead.
  *
  * `adsAllowed` is honoured either way, because it can only open the gate and
  * never close it on someone: a stale `true` costs nothing, and a stale
  * `false` is precisely what the live probe is here to overrule.
  */
 live?: boolean;
};

export async function detectAdBlockDetailed(opts: AdBlockDetectOptions = {}): Promise<AdBlockSignal> {
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
 // An allowlisted visitor is settled whichever read this is: Funding Choices
 // saw the allowlisting itself, not a side effect of it that goes stale.
 if (fc && (fc.adsAllowed || !opts.live)) return fc;

 // Either Funding Choices never reported, or this is a live re-read and its
 // verdict is too old to decide. Silence is weak evidence of a network-level
 // blocker, its own script being a common target, but it is equally
 // consistent with a slow network — so read the probe rather than convict on
 // silence.
 return {
 ...none,
 adsAllowed: fc?.adsAllowed ?? false,
 status: fc?.status ?? null,
 blocked: await heuristic,
 };
 } catch {
 return none;
 }
}

export async function detectAdBlock(): Promise<boolean> {
 return (await detectAdBlockDetailed()).blocked;
}
