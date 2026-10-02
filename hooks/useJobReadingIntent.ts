import { useEffect, useState } from 'react';

/** Prompt only after time to read AND a deliberate scroll, reset on navigation. */
export function useJobReadingIntent(routeKey: string): boolean {
 const [readyFor, setReadyFor] = useState<string | null>(null);
 useEffect(() => {
  setReadyFor(null);
  let elapsed = false;
  let scrolled = false;
  const startY = window.scrollY;
  const reveal = () => {
   if (elapsed && scrolled && document.visibilityState === 'visible') setReadyFor(routeKey);
  };
  const onScroll = () => {
   if (Math.abs(window.scrollY - startY) >= 160) scrolled = true;
   reveal();
  };
  const timer = window.setTimeout(() => { elapsed = true; reveal(); }, 20_000);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', reveal);
  return () => {
   window.clearTimeout(timer);
   window.removeEventListener('scroll', onScroll);
   document.removeEventListener('visibilitychange', reveal);
  };
 }, [routeKey]);
 return readyFor === routeKey;
}
