import type { createHouseAdCreative, HouseAdFormat, HouseAdLocale, HouseAdVariant } from './houseAdCreative';

/** Dependency-injected so the static shell and React use exactly one controller.
 * Only publisher-owned display frames participate; Google nodes stay in place.
 */
export function installHouseAds(
  render: typeof createHouseAdCreative,
  css: string,
  emit: (event: string, properties: Record<string, string | number>) => void,
  allowed: () => boolean,
  config: { assignmentUrl: string; consentKey: string; consentEvent: string; variants: readonly HouseAdVariant[] },
) {
  type Entry = { creative: HTMLAnchorElement; timer?: ReturnType<typeof setTimeout>; seen: boolean; data: Record<string, string | number> };
  type HouseWindow = Window & {
    __ftHouseAds?: { refresh: () => void };
    __ftAdsConsentDecision?: string;
    __ftAdBlock?: { blocked?: boolean; adsAllowed?: boolean };
    __ftAdBlockProbe?: string;
  };
  const w = window as HouseWindow;
  if (w.__ftHouseAds) { w.__ftHouseAds.refresh(); return w.__ftHouseAds; }
  // Without DOM observation we cannot guarantee yielding to a late Google
  // fill. Skip this optional layer and let the independent recovery continue.
  if (typeof MutationObserver !== 'function') return undefined;
  const variants = config.variants;
  const entries = new Map<HTMLElement, Entry>();
  const eligibleFrames = new Set<HTMLElement>();
  const observedFrames = new Set<HTMLElement>();
  const eligibleSince = new WeakMap<HTMLElement, number>();
  const observedWidths = new WeakMap<HTMLElement, number>();
  const counted = new WeakMap<HTMLElement, Set<string>>();
  let assignment: { variant: HouseAdVariant; enrolled: boolean; experimentId: string; assignmentSource: string } = {
    variant: 'control', enrolled: false, experimentId: 'house_creatives_v2', assignmentSource: 'local_default',
  };
  let ready = false;
  let assignmentRequested = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let path = location.pathname;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((records) => {
    let changed = false;
    for (const record of records) {
      const frame = record.target as HTMLElement;
      const width = record.contentRect.width;
      const previous = observedWidths.get(frame);
      observedWidths.set(frame, width);
      if (previous === undefined || Math.abs(previous - width) >= 1) changed = true;
    }
    if (changed) schedule();
  }) : null;
  const read = (key: string, local = false) => { try { return (local ? localStorage : sessionStorage).getItem(key); } catch { return null; } };
  const analyticsAllowed = () => { try { return JSON.parse(read('frontaliere_consent', true) || '{}').analytics !== false; } catch { return false; } };
  const visible = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || parseFloat(style.opacity) === 0) return false;
    }
    return true;
  };
  const modalVisible = () => Array.from(document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.fc-consent-root,.fc-ab-root,.fc-monetization-dialog-container')).some(visible);
  const permitted = () => {
    try { return allowed() && !/\/(automatizza-ricerca-lavoro-svizzera|automate-job-search-switzerland|arbeitssuche-schweiz-automatisieren|automatiser-recherche-emploi-suisse)(\/|$)/.test(location.pathname); }
    catch { return false; }
  };
  const blockerConfirmed = () => (w.__ftAdBlock?.blocked === true || w.__ftAdBlockProbe === 'blocked') && w.__ftAdBlock?.adsAllowed !== true;
  const report = (name: string, data: Record<string, string | number>) => { if (permitted() && analyticsAllowed()) emit(name, data); };
  function requestAssignment() {
    if (assignmentRequested) return;
    assignmentRequested = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 3000);
    void (async () => {
      if (!analyticsAllowed()) return;
      let id = read('ft_house_creative_id_v1', true);
      if (!id) {
        id = crypto.randomUUID();
        try {
          localStorage.setItem('ft_house_creative_id_v1', id);
        } catch {
          // Keep a stable assignment for this tab when persistent storage is unavailable.
          id = read('ft_house_creative_session_id_v1') || crypto.randomUUID();
          sessionStorage.setItem('ft_house_creative_session_id_v1', id);
        }
      }
      const response = await fetch(config.assignmentUrl, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ randomizationId: id }),
        signal: abort.signal,
      });
      if (!response.ok) return;
      const value = await response.json();
      const arm = value?.variant;
      if (variants.includes(arm)) {
        const assignmentSource = value.assignmentSource === 'firebase_remote_config' ? value.assignmentSource : 'local_default';
        assignment = {
          variant: arm,
          enrolled: value.enrolled === true && assignmentSource === 'firebase_remote_config',
          experimentId: 'house_creatives_v2',
          assignmentSource,
        };
      }
    })().catch(() => {}).finally(() => {
      clearTimeout(timeout);
      ready = true;
      schedule();
    });
  }
  const remove = (frame: HTMLElement, keepEligible = false) => {
    const entry = entries.get(frame);
    if (entry) { clearTimeout(entry.timer); entry.creative.remove(); entries.delete(frame); }
    eligibleSince.delete(frame);
    if (frame.hasAttribute('data-ft-house-active')) {
      frame.removeAttribute('data-ft-house-active');
      frame.style.removeProperty('--ft-house-height');
    }
    if (!keepEligible) { frame.removeAttribute('data-ft-house-eligible'); eligibleFrames.delete(frame); }
  };
  const viewable = (entry: Entry) => {
    if (!permitted() || !entry.creative.isConnected || document.visibilityState === 'hidden' || modalVisible() || !visible(entry.creative)) return false;
    const r = entry.creative.getBoundingClientRect();
    const area = r.width * r.height;
    const shown = Math.max(0, Math.min(r.right, document.documentElement.clientWidth) - Math.max(0, r.left)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(0, r.top));
    return area > 0 && shown / area >= .5;
  };
  const measure = () => {
    for (const entry of entries.values()) {
      if (entry.seen) continue;
      if (!viewable(entry)) { clearTimeout(entry.timer); entry.timer = undefined; continue; }
      if (entry.timer) continue;
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (!viewable(entry) || entry.seen) return;
        entry.seen = true;
        const frame = entry.creative.closest<HTMLElement>('[data-house]');
        if (frame) {
          const keys = counted.get(frame) || new Set<string>();
          keys.add(`${path}:${entry.data.creative_id}:${entry.data.format}`); counted.set(frame, keys);
        }
        report('house_ad_impression', { ...entry.data, action: 'viewable_1s' });
      }, 1000);
    }
  };
  const chooseSize = (width: number, height: number): { format: HouseAdFormat; height: number } => {
    const actualHeight = Number.isFinite(height) && height > 0 ? height : 0;
    if (actualHeight >= 500 && width <= 360) return { format: 'skyscraper', height: actualHeight };
    if (width >= 700) return actualHeight >= 200
      ? { format: 'billboard', height: actualHeight }
      : { format: 'leaderboard', height: actualHeight || 90 };
    if (actualHeight < 80) return { format: 'mobile_banner', height: Math.max(50, actualHeight || 50) };
    if (actualHeight < 200) return { format: 'mobile_large', height: actualHeight };
    return { format: 'rectangle', height: actualHeight };
  };
  function refresh() {
    if (!document.body) return;
    for (const frame of observedFrames) if (!frame.isConnected) {
      resizeObserver?.unobserve(frame);
      observedFrames.delete(frame);
      observedWidths.delete(frame);
      remove(frame);
    }
    if (path !== location.pathname) { for (const frame of eligibleFrames) remove(frame); path = location.pathname; }
    for (const frame of eligibleFrames) if (!frame.isConnected || !permitted()) remove(frame);
    if (!permitted()) return;
    for (const frame of document.querySelectorAll<HTMLElement>('[data-house]')) {
      if (!observedFrames.has(frame)) {
        observedFrames.add(frame);
        resizeObserver?.observe(frame);
      }
      const google = frame.querySelector<HTMLElement>('[data-ft-house-google],ins[data-ad-slot]');
      const blockerOnly = frame.hasAttribute('data-ft-house-blocker-only');
      if (!google && !blockerOnly) continue;
      let host = frame.querySelector<HTMLElement>('[data-ft-house-host]');
      if (!host) { host = document.createElement('span'); host.setAttribute('data-ft-house-host', ''); frame.append(host); }
      const state = google?.getAttribute('data-ft-ad-state') || google?.getAttribute('data-ad-state') || google?.getAttribute('data-ft-static-ad-state') || '';
      const isFilled = state === 'filled' || state === 'optimized'
        || !!google?.matches('ins[data-ad-status="filled"],ins[data-ad-status="unfill-optimized"]')
        || !!google?.querySelector('ins[data-ad-status="filled"],ins[data-ad-status="unfill-optimized"],[data-ad-state="filled"],[data-ad-state="optimized"]');
      if (isFilled) { remove(frame); continue; }
      const gpt = frame.dataset.ftHouseLibrary === 'gpt';
      const requested = !!google && (google.hasAttribute('data-google-query-id') || !!google.querySelector('[data-google-query-id]'));
      const pending = !!google && (google.hasAttribute('data-ft-ad-request-pending') || !!google.querySelector('[data-ft-ad-request-pending]') || state === 'waiting_response' || (state === 'loading' && (!gpt || requested)));
      const scriptSelector = frame.dataset.ftHouseLibrary === 'gpt' ? 'gpt.js' : 'adsbygoogle.js';
      const failed = Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-failed="1"]')).some(s => s.src.includes(scriptSelector) && !['retry_wait','loading','loaded','waiting_response'].includes(s.dataset.ftScriptState || ''));
      const cmpFailed = !!document.querySelector('script[src*="fundingchoicesmessages.google.com"][data-ft-script-state="failed"]');
      const googleUnfilled = !!google && (google.matches('ins[data-ad-status="unfilled"]') || !!google.querySelector('ins[data-ad-status="unfilled"]'));
      const terminal = ['unfilled', 'unavailable', 'collapsed'].includes(state) || googleUnfilled;
      const stalled = !!google && (google.hasAttribute('data-ft-ad-stalled') || !!google.querySelector('[data-ft-ad-stalled]'));
      const blocked = blockerConfirmed();
      const decision = w.__ftAdsConsentDecision || read(config.consentKey, true);
      const eligible = blockerOnly ? blocked : blocked || stalled || (!pending && (terminal || failed || (cmpFailed && !decision)));
      if (!eligible) { eligibleSince.delete(frame); remove(frame); continue; }
      // Resolve the experiment arm while the no-fill grace is running so a
      // slow assignment request does not add its full latency afterwards.
      if (!ready && frame.getBoundingClientRect().width >= 160 && visible(frame)) requestAssignment();
      // A blocker or a confirmed 45s request stall should reach the inline
      // creative immediately. Definitive no-fill/failure gets only a short
      // grace for a fill event already queued by Google.
      if (!blocked && !stalled && !entries.has(frame)) {
        const since = eligibleSince.get(frame);
        if (since === undefined) { eligibleSince.set(frame, Date.now()); setTimeout(schedule, 1000); continue; }
        if (Date.now() - since < 1000) continue;
      }
      eligibleSince.delete(frame);
      // A rail may currently have a zero-width track after Google's empty
      // callback. Announce eligibility before measuring; its React adapter
      // restores the track, then the next layout mutation supplies real width.
      if (!frame.hasAttribute('data-ft-house-eligible')) frame.setAttribute('data-ft-house-eligible', '');
      eligibleFrames.add(frame);
      const width = frame.getBoundingClientRect().width;
      if (width < 160 || !visible(frame)) continue;
      if (!ready) { requestAssignment(); continue; }
      const { format, height } = chooseSize(width, Number(frame.dataset.ftHouseHeight) || (google ? parseFloat(google.style.minHeight) || google.getBoundingClientRect().height : 0));
      const portraitArtwork = format === 'billboard' && height >= 500;
      const locale = (['it', 'en', 'de', 'fr'].includes(document.documentElement.lang.slice(0, 2)) ? document.documentElement.lang.slice(0, 2) : 'it') as HouseAdLocale;
      const existing = entries.get(frame);
      if (existing?.creative.dataset.houseFormat === format && existing.creative.lang === locale && (format !== 'billboard' || existing.creative.dataset.houseArtwork === (portraitArtwork ? 'portrait' : 'wide'))) {
        if (frame.style.getPropertyValue('--ft-house-height') !== `${height}px`) frame.style.setProperty('--ft-house-height', `${height}px`);
        continue;
      }
      remove(frame, true);
      const placement = (frame.dataset.house || google?.dataset.adPlacement || google?.dataset.adSlot || 'display').replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 80);
      const fallbackReason = blocked ? 'adblock_detected'
        : stalled ? 'response_stalled'
        : failed ? 'script_failed'
        : googleUnfilled ? 'google_no_fill'
        : cmpFailed && !decision ? 'consent_loader_failed'
        : state === 'collapsed' ? 'ad_collapsed'
        : 'ad_unavailable';
      const data = { campaign: 'job_search_automation', experiment_id: assignment.experimentId, experiment_variant: assignment.variant, enrolled: Number(assignment.enrolled), assignment_source: assignment.assignmentSource, creative_id: `${assignment.variant}_v1`, component: `${assignment.experimentId}.${assignment.variant}_v1.${assignment.enrolled ? 'test' : 'fixed'}.${locale}`, fallback_reason: fallbackReason, format, locale, placement, surface: `${format}.${placement}`, device: matchMedia('(max-width:767px)').matches ? 'mobile' : 'desktop' };
      const creative = render({ variant: assignment.variant, format, locale, placement, portraitArtwork, onClick: () => {
        if (!permitted()) return;
        report('house_ad_click', { ...data, action: 'click' });
        if (analyticsAllowed()) try { sessionStorage.setItem('ft_house_ad_click_v1', JSON.stringify({ campaign: 'job_search_automation', experimentId: assignment.experimentId, assignmentSource: assignment.assignmentSource, variant: assignment.variant, creativeId: `${assignment.variant}_v1`, format, locale, placement, device: data.device, enrolled: assignment.enrolled, clickedAt: Date.now() })); } catch { /* navigation still works */ }
      } });
      creative.lang = locale;
      host.replaceChildren(creative);
      frame.style.setProperty('--ft-house-height', `${height}px`);
      frame.setAttribute('data-ft-house-active', '');
      entries.set(frame, { creative, seen: counted.get(frame)?.has(`${path}:${data.creative_id}:${format}`) || false, data });
      report('house_ad_rendered', { ...data, action: 'render' });
    }
    measure();
  }
  function schedule() { if (scheduled) return; scheduled = setTimeout(() => { scheduled = undefined; refresh(); }, 100); }
  const style = document.createElement('style'); style.id = 'ft-house-creative-style';
  style.textContent = css + '\n[data-house]{position:relative;min-width:0}[data-ft-house-host]{display:none}:where([data-house][data-ft-house-active]){min-height:var(--ft-house-height)}:where([data-ft-house-blocker-only]:not([data-ft-house-active])){height:0!important;min-height:0!important;margin-block:0!important;padding-block:0!important;overflow:hidden!important}[data-ft-house-active]>[data-ft-house-host]{display:block;position:absolute;inset:0;height:100%;container-type:size;z-index:1}:where([data-house]):has(>ins[data-ft-static-ad-collapsed]):not([data-ft-house-active]),:where(div,li,section):has(>[data-house]:only-child>ins[data-ft-static-ad-collapsed]):not(:has(>[data-ft-house-active])){height:0!important;min-height:0!important;margin-block:0!important;padding-block:0!important;overflow:hidden!important}';
  document.head.append(style);
  // Assignment is requested only after a genuinely eligible, visible fallback
  // slot appears. Firebase evaluates percentage conditions with the stable ID;
  // failures use the fixed control without a browser-side hash.
  const observer = new MutationObserver(records => {
    if (records.every(r => (r.target as Element).closest?.('[data-ft-house-host]'))) return;
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ad-status','data-ft-ad-state','data-ad-state','data-ft-static-ad-state','data-ft-ad-request-pending','data-ft-ad-stalled','data-ft-script-state','data-failed','data-ft-house-height','lang','class','style','open','hidden','aria-modal'] });
  for (const name of [config.consentEvent, 'frontaliere:adblock-data', 'storage', 'popstate', 'seo-tracking:pushstate', 'seo-tracking:replacestate', 'resize']) window.addEventListener(name, schedule);
  window.addEventListener('scroll', measure, { passive: true });
  document.addEventListener('visibilitychange', measure);
  const api = { refresh }; w.__ftHouseAds = api; schedule(); return api;
}
