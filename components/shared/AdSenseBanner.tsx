/**
 * AdSenseBanner — Google AdSense display ad unit.
 *
 * Renders an <ins class="adsbygoogle"> element and pushes to the ad queue.
 * In development mode the component renders a visible placeholder instead.
 *
 * Usage:
 *   <AdSenseBanner adSlot="1234567890" adFormat="auto" />
 *
 * The `adSlot` is the numeric slot ID from your AdSense dashboard.
 * If omitted the banner shows a placeholder reminding you to create one.
 */

import { useEffect, useRef, useState } from 'react';

/* global adsbygoogle declaration for TypeScript */
declare global {
  interface Window {
    adsbygoogle?: Array<Record<string, unknown>>;
  }
}

interface AdSenseBannerProps {
  /** Ad slot ID from the AdSense dashboard (numeric string) */
  adSlot?: string;
  /** Ad format — defaults to 'auto' (responsive) */
  adFormat?: string;
  /** Responsive behaviour — defaults to true */
  fullWidthResponsive?: boolean;
  /** Additional CSS class for the wrapper div */
  className?: string;
  /** Layout key for in-feed formats */
  adLayoutKey?: string;
  /** Layout type for in-article format */
  adLayout?: string;
  /** Label text above the ad (e.g. "Pubblicità") */
  label?: string;
  /** Explicit eligibility gate from parent (editorial content ready/quality checks) */
  enabled?: boolean;
}

const CLIENT_ID = 'ca-pub-8628054934855353';
const IS_PROD = typeof window !== 'undefined' && window.location.hostname === 'www.frontaliereticino.ch';

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
  const [filled, setFilled] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [scriptFailed, setScriptFailed] = useState(false);

  const loadAdSenseScript = () => {
    if (typeof document === 'undefined') return;
    const existing = document.querySelector<HTMLScriptElement>('script[data-adsense-client]');
    if (existing) {
      if (existing.getAttribute('data-loaded') === '1') setScriptReady(true);
      else if (existing.getAttribute('data-failed') === '1') setScriptFailed(true);
      else {
        existing.addEventListener('load', () => setScriptReady(true), { once: true });
        existing.addEventListener('error', () => { setScriptFailed(true); }, { once: true });
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
      console.warn('[AdSense] script load failed for slot=' + adSlot);
      setScriptFailed(true);
    }, { once: true });
    document.head.appendChild(script);
  };

  useEffect(() => {
    if (!IS_PROD || !enabled || !adSlot) return;
    loadAdSenseScript();
  }, [enabled, adSlot]);

  useEffect(() => {
    if (!IS_PROD || !enabled || !scriptReady || !adSlot || pushed.current) return;

    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch (err) {
      console.warn(`[AdSense] push() failed for slot=${adSlot}`, err);
    }

    /* Poll for ad fill status — reveal only when filled, stay collapsed otherwise */
    const el = adRef.current;
    if (!el) return;

    let checks = 0;
    const maxChecks = 5;
    const timer = setInterval(() => {
      checks++;
      const status = el.getAttribute('data-ad-status');

      if (status === 'filled') {
        clearInterval(timer);
        setFilled(true);
        return;
      }

      if (status === 'unfilled') {
        console.info('[AdSense] unfilled slot=' + adSlot + ', collapsing banner');
        clearInterval(timer);
        return;
      }

      if (checks >= maxChecks) {
        console.info('[AdSense] fill timeout for slot=' + adSlot + ', collapsing banner');
        clearInterval(timer);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [enabled, scriptReady, adSlot]);

  /* ── Development / missing-slot — render nothing (collapse) ── */
  if (!IS_PROD || !enabled || !adSlot || scriptFailed) {
    return null;
  }

  /* ── Production ad unit — hidden when unfilled ── */
  return (
    <div ref={wrapperRef} className={`${className} ${filled ? '' : 'hidden'}`}>
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
