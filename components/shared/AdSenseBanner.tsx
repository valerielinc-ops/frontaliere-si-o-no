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
}

const CLIENT_ID = 'ca-pub-8628054934855353';
const IS_PROD = typeof window !== 'undefined' && window.location.hostname === 'www.frontaliereticino.ch';

type AdState = 'idle' | 'waiting_width' | 'loading' | 'filled' | 'collapsed';

export default function AdSenseBanner({
  adSlot,
  adFormat = 'auto',
  fullWidthResponsive = true,
  className = '',
  adLayoutKey,
  adLayout,
  label,
  enabled = true,
}: AdSenseBannerProps) {
  const adRef = useRef<HTMLModElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pushed = useRef(false);
  const [state, setState] = useState<AdState>('idle');
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);

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

    const tryPush = () => {
      const width = wrapper.getBoundingClientRect().width;
      if (width <= 0) return false;

      console.info(`[AdSense] width ready for slot=${adSlot} (${Math.round(width)}px), initializing`);
      setState('loading');

      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        pushed.current = true;
      } catch (err) {
        console.warn(`[AdSense] push() failed for slot=${adSlot}`, err);
        setState('collapsed');
        return true;
      }

      // Poll for ad fill status
      const el = adRef.current;
      if (!el) { setState('collapsed'); return true; }

      let checks = 0;
      const maxChecks = 5;
      const timer = setInterval(() => {
        checks++;
        const status = el.getAttribute('data-ad-status');

        if (status === 'filled') {
          clearInterval(timer);
          setState('filled');
          return;
        }

        if (status === 'unfilled') {
          console.info(`[AdSense] unfilled slot=${adSlot}, collapsing banner`);
          clearInterval(timer);
          setState('collapsed');
          return;
        }

        if (checks >= maxChecks) {
          console.info(`[AdSense] fill timeout for slot=${adSlot}, collapsing banner`);
          clearInterval(timer);
          setState('collapsed');
        }
      }, 2000);

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
          tryPush();
          break;
        }
      }
    });
    observer.observe(wrapper);

    // Safety timeout — collapse if width never materializes
    const timeout = setTimeout(() => {
      observer.disconnect();
      if (!pushed.current) {
        console.info(`[AdSense] width timeout for slot=${adSlot}, collapsing`);
        setState('collapsed');
      }
    }, 8000);

    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [state, scriptReady, adSlot]);

  // ── Collapse on script failure ───────────────────────────
  useEffect(() => {
    if (scriptFailed && state !== 'collapsed') {
      setState('collapsed');
    }
  }, [scriptFailed, state]);

  // ── Render nothing in dev, disabled, or collapsed ────────
  if (!IS_PROD || !enabled || !adSlot || state === 'collapsed') {
    return null;
  }

  // ── Production ad unit ───────────────────────────────────
  // Before 'filled': use visibility:hidden + opacity:0 so the container
  // stays in layout with real measurable width (never display:none).
  const isVisible = state === 'filled';

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={isVisible ? undefined : { visibility: 'hidden', opacity: 0, pointerEvents: 'none', overflow: 'hidden', maxHeight: 0 }}
      aria-hidden={!isVisible}
    >
      {label && (
        <p className="text-[9px] font-medium text-slate-500 dark:text-slate-600 uppercase tracking-wider mb-1 text-center">
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
