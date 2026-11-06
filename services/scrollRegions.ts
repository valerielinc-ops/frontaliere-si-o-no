/**
 * Rende raggiungibili da tastiera le aree a scorrimento orizzontale.
 *
 * WCAG 2.1.1: un contenitore che scorre senza contenuto focalizzabile non si
 * sposta senza dito o mouse. Le tabelle vivono in decine di generatori statici e
 * componenti React con classi diverse, quindi la regola sta qui una volta sola e
 * guarda la geometria reale invece di un elenco di classi.
 */
const CANDIDATES = 'main table, main pre, main .overflow-x-auto, main [class*="table-wrap"]';
const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]';
const SCAN_DELAY_MS = 500;

function scrollerOf(el: HTMLElement): HTMLElement | null {
 for (let node: HTMLElement | null = el; node && node.tagName !== 'MAIN'; node = node.parentElement) {
  const overflowX = getComputedStyle(node).overflowX;
  if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) return node;
 }
 return null;
}

export function markScrollRegionsFocusable(root: ParentNode = document): void {
 const seen = new Set<HTMLElement>();
 root.querySelectorAll<HTMLElement>(CANDIDATES).forEach((el) => {
  const scroller = scrollerOf(el);
  if (!scroller || seen.has(scroller)) return;
  seen.add(scroller);
  if (scroller.querySelector(FOCUSABLE) || scroller.hasAttribute('tabindex')) return;
  scroller.tabIndex = 0;
  if (!scroller.hasAttribute('role')) scroller.setAttribute('role', 'region');
  if (!scroller.hasAttribute('aria-label') && !scroller.hasAttribute('aria-labelledby')) {
   const caption = scroller.querySelector('caption')?.textContent?.trim();
   const heading = scroller.closest('section')?.querySelector('h2,h3')?.textContent?.trim();
   scroller.setAttribute('aria-label', caption || heading || document.title);
  }
 });
}

/** Scansione al caricamento e dopo ogni cambio di DOM, raggruppata per non pesare. */
export function startScrollRegionObserver(): void {
 let timer: number | undefined;
 const schedule = () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => markScrollRegionsFocusable(), SCAN_DELAY_MS);
 };
 schedule();
 new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
