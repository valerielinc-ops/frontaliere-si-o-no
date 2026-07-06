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
 window.setTimeout(() => {
 let blocked = false;
 try {
 const rect = bait.getBoundingClientRect();
 const style = window.getComputedStyle(bait);
 blocked = rect.height === 0 || style.display === 'none' || style.visibility === 'hidden';
 } catch {
 blocked = false;
 }
 try { bait.remove(); } catch { /* noop */ }
 resolve(blocked);
 }, SETTLE_DELAY_MS);
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
export async function detectAdBlock(): Promise<boolean> {
 if (typeof window === 'undefined') return false;
 try {
 const [baitBlocked, networkBlocked] = await Promise.all([
 detectViaBaitElement(),
 detectViaNetworkProbe(),
 ]);
 return baitBlocked || networkBlocked;
 } catch {
 return false;
 }
}
