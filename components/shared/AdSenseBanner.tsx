/**
 * AdSenseBanner — Google AdSense display ad unit with width-aware lifecycle.
 *
 * Renders an <ins class="adsbygoogle"> element and pushes to the ad queue
 * ONLY after the container has measurable width (> 0px).
 *
 * State machine: idle → waiting_width → loading → filled | collapsed
 *
 * In development mode the component renders nothing (collapsed).
 */

import { useEffect, useRef, useState, useCallback } from 'react';

declare global {
  interface Window {
    adsbygoogle?: Array<Record<string, unknown>>;
  }
}

interface AdSenseBannerProps {
  adSlot?: string;
  adFormat?: string;
  fullWidthResponsive?: boolean;
  className?: string;
  adLayoutKey?: string;
  adLayout?: string;
  label?: string;
  enabled?: boolean;
  /** When true, always render the placeholder wrapper (even when disabled) to prevent CLS.
   *  Use on pages where ads appear after an async action (e.g., calculator results). */
  reserveSpace?: boolean;
}

const CLIENT_ID = 'ca-pub-8628054934855353';
const ADSENSE_PRODUCTION_HOSTNAMES = new Set([
  'frontaliereticino.ch',
  'frontaliereticino.ch',
]);

export function isAdSenseProductionHost(hostname: string) {
  return ADSENSE_PRODUCTION_HOSTNAMES.has(hostname);
}

const IS_PROD =
  typeof window !== 'undefined' && isAdSenseProductionHost(window.location.hostname);

type AdState = 'idle' | 'waiting_width' | 'loading' | 'filled' | 'collapsed';
const initializedAdElements = new WeakSet<Element>();

function getPlaceholderMinHeight(adFormat: string, adLayout?: string): number {
  // Heights match AD_SLOTS.placeholderMinHeight values in adsenseSlots.ts (FRO-385).
  // Sized to cover the majority of real ad renders and prevent CLS when ads expand.
  if (adFormat === 'autorelaxed') return 400;
  if (adLayout === 'in-article') return 220;
  if (adFormat === 'fluid') return 220;
  return 280;
}

export default function AdSenseBanner({
  adSlot,
  adFormat = 'auto',
  fullWidthResponsive = true,
  className = '',
  adLayoutKey,
  adLayout,
  label,
  enabled = true,
  reserveSpace = false,
}: AdSenseBannerProps) {
  const adRef = useRef<HTMLModElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pushed = useRef(false);
  const fillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusObserverRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [state, setState] = useState<AdState>('idle');
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);
  const placeholderMinHeight = getPlaceholderMinHeight(adFormat, adLayout);

  const cleanupAsyncWatchers = useCallback(() => {
    if (fillTimeoutRef.current) {
      clearTimeout(fillTimeoutRef.current);
      fillTimeoutRef.current = null;
    }
    if (statusObserverRef.current) {
      statusObserverRef.current.disconnect();
      statusObserverRef.current = null;
    }
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
  }, []);

  // ── Load the AdSense script (singleton) ──────────────────
  const loadAdSenseScript = useCallback(() => {
    if (typeof document === 'undefined') return;
    const existing = document.querySelector<HTMLScriptElement>('script[data-adsense-client]');
    if (existing) {
      if (existing.getAttribute('data-loaded') === '1') setScriptReady(true);
      else if (existing.getAttribute('data-failed') === '1') setScriptFailed(true);
      else {
        existing.addEventListener('load', () => setScriptReady(true), { once: true });
        existing.addEventListener('error', () => setScriptFailed(true), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT_ID}`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-adsense-client', CLIENT_ID);
    // Force anchor/overlay ads to bottom only — prevents covering navbar on mobile
    script.setAttribute('data-overlays', 'bottom');
    script.addEventListener('load', () => {
      script.setAttribute('data-loaded', '1');
      setScriptReady(true);
    }, { once: true });
    script.addEventListener('error', () => {
      script.setAttribute('data-failed', '1');
      console.warn(`[AdSense] script load failed for slot=${adSlot}`);
      setScriptFailed(true);
    }, { once: true });
    document.head.appendChild(script);
  }, [adSlot]);

  // ── Start script loading when enabled ────────────────────
  useEffect(() => {
    if (!IS_PROD || !enabled || !adSlot) return;
    loadAdSenseScript();
    setState('waiting_width');
  }, [enabled, adSlot, loadAdSenseScript]);

  // ── Wait for measurable width, then push ─────────────────
  useEffect(() => {
    if (state !== 'waiting_width' || !scriptReady || !adSlot || pushed.current) return;

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    cleanupAsyncWatchers();

    const tryPush = () => {
      const width = wrapper.getBoundingClientRect().width;
      if (width <= 0) return false;

      console.info(`[AdSense] width ready for slot=${adSlot} (${Math.round(width)}px), initializing`);
      setState('loading');

      const el = adRef.current;
      if (!el) { setState('collapsed'); return true; }

      const currentStatus = el.getAttribute('data-ad-status');
      if (currentStatus === 'filled') {
        pushed.current = true;
        initializedAdElements.add(el);
        setState('filled');
        return true;
      }
      if (currentStatus === 'unfilled') {
        console.info(`[AdSense] unfilled slot=${adSlot}, collapsing banner`);
        pushed.current = true;
        initializedAdElements.add(el);
        setState('collapsed');
        return true;
      }

      const alreadyInitialized =
        initializedAdElements.has(el) ||
        el.getAttribute('data-adsbygoogle-status') !== null;

      try {
        if (!alreadyInitialized) {
          (window.adsbygoogle = window.adsbygoogle || []).push({});
          initializedAdElements.add(el);
        }
        pushed.current = true;
      } catch (err) {
        console.warn(`[AdSense] push() failed for slot=${adSlot}`, err);
        setState('collapsed');
        return true;
      }

      const observer = new MutationObserver(() => {
        const status = el.getAttribute('data-ad-status');
        if (status === 'filled') {
          cleanupAsyncWatchers();
          setState('filled');
        } else if (status === 'unfilled') {
          console.info(`[AdSense] unfilled slot=${adSlot}, collapsing banner`);
          cleanupAsyncWatchers();
          setState('collapsed');
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: ['data-ad-status'] });
      statusObserverRef.current = observer;

      fillTimeoutRef.current = setTimeout(() => {
        const status = el.getAttribute('data-ad-status');
        if (status === 'filled') return;
        console.info(`[AdSense] fill timeout for slot=${adSlot} (status=${status}), collapsing`);
        cleanupAsyncWatchers();
        setState('collapsed');
      }, 90_000);

      return true;
    };

    // Try immediately
    if (tryPush()) return;

    // Otherwise observe for width changes
    console.info(`[AdSense] waiting for measurable width for slot=${adSlot}`);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          observer.disconnect();
          resizeObserverRef.current = null;
          tryPush();
          break;
        }
      }
    });
    observer.observe(wrapper);
    resizeObserverRef.current = observer;

    // Safety timeout — collapse if width never materializes
    const timeout = setTimeout(() => {
      observer.disconnect();
      if (!pushed.current) {
        console.info(`[AdSense] width timeout for slot=${adSlot}, collapsing`);
        setState('collapsed');
      }
    }, 8000);

    return () => {
      cleanupAsyncWatchers();
      clearTimeout(timeout);
    };
  }, [state, scriptReady, adSlot, cleanupAsyncWatchers]);

  // ── Collapse on script failure ───────────────────────────
  useEffect(() => {
    if (scriptFailed && state !== 'collapsed') {
      setState('collapsed');
    }
  }, [scriptFailed, state]);

  useEffect(() => () => {
    cleanupAsyncWatchers();
  }, [cleanupAsyncWatchers]);

  // ── Render nothing in dev or when slot is missing ─────────
  if (!IS_PROD || !adSlot) {
    return null;
  }

  // When disabled but reserveSpace is true, render the placeholder wrapper
  // so the layout doesn't shift when the ad eventually loads (CLS fix).
  if (!enabled && !reserveSpace) {
    return null;
  }

  // ── Production ad unit ───────────────────────────────────
  // CLS-safe ad container:
  // - Loading/idle: reserve space with minHeight so the layout is stable
  //   (maxHeight alone doesn't work when content is 0px tall — it's just a cap)
  // - Filled: natural height, fully visible
  // - Collapsed: smooth transition to 0 height
  const isVisible = state === 'filled';
  const isCollapsed = state === 'collapsed';
  const isReservingSpace = !isVisible && !isCollapsed;

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        contain: 'content',
        transition: 'opacity 0.3s ease',
        // Reserve space via minHeight — keep it even after ad loads to prevent CLS
        // when the actual ad is shorter than the placeholder (FRO-299)
        minHeight: isCollapsed ? 0 : placeholderMinHeight,
        // Cap collapsed state to 0
        maxHeight: isCollapsed ? 0 : undefined,
        opacity: isVisible ? 1 : 0,
        overflow: 'hidden',
        ...(isVisible ? {} : { pointerEvents: 'none' as const }),
      }}
      aria-hidden={!isVisible}
    >
      {label && (
        <p className="text-xs font-medium text-slate-500 dark:text-slate-600 uppercase tracking-wider mb-1 text-center">
          {label}
        </p>
      )}
      <ins
        ref={adRef}
        className="adsbygoogle"
        style={{ display: 'block', textAlign: adLayout === 'in-article' ? 'center' as const : undefined }}
        data-ad-client={CLIENT_ID}
        data-ad-slot={adSlot}
        data-ad-format={adFormat}
        {...(fullWidthResponsive ? { 'data-full-width-responsive': 'true' } : {})}
        {...(adLayoutKey ? { 'data-ad-layout-key': adLayoutKey } : {})}
        {...(adLayout ? { 'data-ad-layout': adLayout } : {})}
      />
    </div>
  );
}
