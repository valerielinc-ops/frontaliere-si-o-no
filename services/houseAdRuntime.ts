import type { createHouseAdCreative, HouseAdFormat, HouseAdLocale, HouseAdVariant } from './houseAdCreative';

/** Dependency-injected so the static shell and React use exactly one controller.
 * Only publisher-owned display frames participate; Google nodes stay in place.
 */
export function installHouseAds(
  render: typeof createHouseAdCreative,
  css: string,
  emit: (event: string, properties: Record<string, string | number>) => void,
  allowed: () => boolean,
  config: { publicConfigUrl: string; consentKey: string; consentEvent: string },
) {
  type Entry = { creative: HTMLAnchorElement; timer?: ReturnType<typeof setTimeout>; seen: boolean; data: Record<string, string | number> };
  type HouseWindow = Window & { __ftHouseAds?: { refresh: () => void }; __ftAdsConsentDecision?: string };
  const w = window as HouseWindow;
  if (w.__ftHouseAds) { w.__ftHouseAds.refresh(); return w.__ftHouseAds; }
  // Without DOM observation we cannot guarantee yielding to a late Google
  // fill. Skip this optional layer and let the independent recovery continue.
  if (typeof MutationObserver !== 'function') return undefined;
  const variants = ['control', 'time_saved', 'profile_match', 'in_control', 'swiss_work', 'next_chapter'];
  const entries = new Map<HTMLElement, Entry>();
  const started = new WeakMap<HTMLElement, number>();
  const counted = new WeakMap<HTMLElement, Set<string>>();
  let assignment: { variant: HouseAdVariant; enrolled: boolean } = { variant: 'control', enrolled: false };
  let ready = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let path = location.pathname;
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
  const report = (name: string, data: Record<string, string | number>) => { if (permitted() && analyticsAllowed()) emit(name, data); };
  const remove = (frame: HTMLElement) => {
    const entry = entries.get(frame);
    if (entry) { clearTimeout(entry.timer); entry.creative.remove(); entries.delete(frame); }
    if (frame.hasAttribute('data-ft-house-active')) {
      frame.removeAttribute('data-ft-house-active');
      frame.style.removeProperty('--ft-house-height');
    }
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
        const frame = entry.creative.closest<HTMLElement>('[data-ft-house-slot]');
        if (frame) {
          const keys = counted.get(frame) || new Set<string>();
          keys.add(`${path}:${entry.data.creative_id}:${entry.data.format}`); counted.set(frame, keys);
        }
        report('house_ad_impression', { ...entry.data, action: 'viewable_1s' });
      }, 1000);
    }
  };
  const chooseSize = (width: number, height: number): { format: HouseAdFormat; height: number } => {
    if (height >= 500 && width <= 360) return { format: 'skyscraper', height: 600 };
    if (width >= 700 && height >= 200) return { format: 'billboard', height };
    if (width >= 700) return { format: 'leaderboard', height: 90 };
    if (height < 80) return { format: 'mobile_banner', height: 50 };
    if (height < 180) return { format: 'mobile_large', height: 100 };
    return { format: 'rectangle', height: height >= 200 ? height : 250 };
  };
  function refresh() {
    if (!document.body) return;
    if (path !== location.pathname) { for (const frame of entries.keys()) remove(frame); path = location.pathname; }
    for (const frame of entries.keys()) if (!frame.isConnected || !permitted()) remove(frame);
    if (!ready || !permitted()) return;
    for (const frame of document.querySelectorAll<HTMLElement>('[data-ft-house-slot]')) {
      const google = frame.querySelector<HTMLElement>('[data-ft-house-google],ins[data-ad-slot]');
      if (!google) continue;
      let host = frame.querySelector<HTMLElement>('[data-ft-house-host]');
      if (!host) { host = document.createElement('span'); host.setAttribute('data-ft-house-host', ''); frame.append(host); }
      if (!started.has(frame)) { started.set(frame, Date.now()); setTimeout(schedule, 12050); }
      const state = google.getAttribute('data-ft-ad-state') || google.getAttribute('data-ad-state') || google.getAttribute('data-ft-static-ad-state') || '';
      const isFilled = state === 'filled' || google.matches('ins[data-ad-status="filled"]') || !!google.querySelector('ins[data-ad-status="filled"],[data-ad-state="filled"]');
      if (isFilled) { remove(frame); continue; }
      const pending = google.hasAttribute('data-ft-ad-request-pending') || !!google.querySelector('[data-ft-ad-request-pending]') || ['loading', 'waiting_response'].includes(state);
      const scriptSelector = frame.dataset.ftHouseLibrary === 'gpt' ? 'gpt.js' : 'adsbygoogle.js';
      const failed = Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-failed="1"]')).some(s => s.src.includes(scriptSelector) && !['retry_wait','loading','loaded','waiting_response'].includes(s.dataset.ftScriptState || ''));
      const cmpFailed = !!document.querySelector('script[src*="fundingchoicesmessages.google.com"][data-ft-script-state="failed"]');
      const terminal = ['unfilled', 'unavailable', 'collapsed'].includes(state) || google.matches('ins[data-ad-status="unfilled"]') || !!google.querySelector('ins[data-ad-status="unfilled"]');
      const decision = w.__ftAdsConsentDecision || read(config.consentKey, true);
      const eligible = !pending && (terminal || failed || (cmpFailed && !decision));
      if (!eligible) { remove(frame); continue; }
      if (Date.now() - started.get(frame)! < 12000) continue;
      const width = frame.getBoundingClientRect().width;
      if (width < 160 || !visible(frame)) continue;
      const { format, height } = chooseSize(width, Number(frame.dataset.ftHouseHeight) || parseFloat(google.style.minHeight) || google.getBoundingClientRect().height);
      const portraitArtwork = format === 'billboard' && height >= 500;
      const locale = (['it', 'en', 'de', 'fr'].includes(document.documentElement.lang.slice(0, 2)) ? document.documentElement.lang.slice(0, 2) : 'it') as HouseAdLocale;
      const existing = entries.get(frame);
      if (existing?.creative.dataset.houseFormat === format && existing.creative.lang === locale && (format !== 'billboard' || existing.creative.dataset.houseArtwork === (portraitArtwork ? 'portrait' : 'wide'))) {
        if (frame.style.getPropertyValue('--ft-house-height') !== `${height}px`) frame.style.setProperty('--ft-house-height', `${height}px`);
        continue;
      }
      remove(frame);
      const placement = (frame.dataset.ftHouseSlot || google.dataset.adPlacement || google.dataset.adSlot || 'display').replace(/[^a-zA-Z0-9_.:-]/g, '-').slice(0, 80);
      const data = { campaign: 'job_search_automation', experiment_id: 'house_creatives_v1', experiment_variant: assignment.variant, enrolled: Number(assignment.enrolled), creative_id: `${assignment.variant}_v1`, component: `${assignment.variant}_v1.${assignment.enrolled ? 'test' : 'fixed'}.${locale}`, format, locale, placement, surface: `${format}.${placement}`, device: matchMedia('(max-width:767px)').matches ? 'mobile' : 'desktop' };
      const creative = render({ variant: assignment.variant, format, locale, placement, portraitArtwork, onClick: () => {
        if (!permitted()) return;
        report('house_ad_click', { ...data, action: 'click' });
        if (analyticsAllowed()) try { sessionStorage.setItem('ft_house_ad_click_v1', JSON.stringify({ campaign: 'job_search_automation', variant: assignment.variant, creativeId: `${assignment.variant}_v1`, format, locale, placement, device: data.device, enrolled: assignment.enrolled, clickedAt: Date.now() })); } catch { /* navigation still works */ }
      } });
      creative.lang = locale;
      host.replaceChildren(creative);
      frame.style.setProperty('--ft-house-height', `${height}px`);
      frame.setAttribute('data-ft-house-active', '');
      entries.set(frame, { creative, seen: counted.get(frame)?.has(`${path}:${data.creative_id}:${format}`) || false, data });
    }
    measure();
  }
  function schedule() { if (scheduled) return; scheduled = setTimeout(() => { scheduled = undefined; refresh(); }, 100); }
  const style = document.createElement('style'); style.id = 'ft-house-creative-style';
  style.textContent = css + '\n[data-ft-house-slot]{position:relative;min-width:0}[data-ft-house-host]{display:none}[data-ft-house-slot][data-ft-house-active]{min-height:var(--ft-house-height)}[data-ft-house-active]>[data-ft-house-host]{display:block;position:absolute;inset:0;height:var(--ft-house-height);z-index:1}:where(div,li,section):has(>[data-ft-house-slot]:only-child>ins[data-ft-static-ad-collapsed]):not(:has(>[data-ft-house-active])){height:0!important;min-height:0!important;margin-block:0!important;padding-block:0!important;overflow:hidden!important}';
  document.head.append(style);
  // Public allowlist only. A missing/failed config renders the safe control
  // without enrolling; no late variant switch after the first creative appears.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 3000);
  void fetch(config.publicConfigUrl, { signal: abort.signal }).then(r => r.ok ? r.json() : null).then(value => {
    const arm = value?.HOUSE_AD_CREATIVE_VARIANT ?? value?.config?.HOUSE_AD_CREATIVE_VARIANT;
    if (!analyticsAllowed()) return;
    if (variants.includes(arm)) assignment = { variant: arm, enrolled: false };
    if (arm !== 'auto') return;
    let id = read('ft_house_creative_id_v1', true);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('ft_house_creative_id_v1', id); }
    let hash = 2166136261;
    for (let n = 0; n < id.length; n++) hash = Math.imul(hash ^ id.charCodeAt(n), 16777619);
    assignment = { variant: variants[(hash >>> 0) % variants.length] as HouseAdVariant, enrolled: true };
  }).catch(() => {}).finally(() => { clearTimeout(timeout); ready = true; refresh(); });
  const observer = new MutationObserver(records => {
    if (records.every(r => (r.target as Element).closest?.('[data-ft-house-host]'))) return;
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ad-status','data-ft-ad-state','data-ad-state','data-ft-static-ad-state','data-ft-ad-request-pending','data-ft-script-state','data-failed','data-ft-house-height','lang','class','style','open','hidden','aria-modal'] });
  for (const name of [config.consentEvent, 'storage', 'popstate', 'seo-tracking:pushstate', 'seo-tracking:replacestate', 'resize']) window.addEventListener(name, schedule);
  window.addEventListener('scroll', measure, { passive: true });
  document.addEventListener('visibilitychange', measure);
  const api = { refresh }; w.__ftHouseAds = api; return api;
}
