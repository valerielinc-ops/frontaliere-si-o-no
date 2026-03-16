import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

let mounted = false;

/** Paths where i18n must be preloaded before render (avoid flash of untranslated text) */
const HOME_CRITICAL_PATHS = new Set([
  '/',
  '/en/',
  '/de/',
  '/fr/',
  '/calcola-stipendio/',
  '/calculate-salary/',
  '/gehalt-berechnen/',
  '/calculer-salaire/',
]);

const isHomeCriticalPath = (pathname: string): boolean => HOME_CRITICAL_PATHS.has(pathname);

const waitForFirstPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const waitForAsyncStylesheet = async () => {
  const cssLink = document.querySelector<HTMLLinkElement>('link[media="print"][href*="/assets/"]');
  if (!cssLink) return;

  await new Promise<void>((resolve) => {
    if (cssLink.media === 'all') {
      resolve();
      return;
    }
    cssLink.addEventListener('load', () => resolve(), { once: true });
    setTimeout(resolve, 3000);
  });
};

const mountApp = async () => {
  if (mounted) return;
  mounted = true;
  const homeCritical = isHomeCriticalPath(window.location.pathname);
  const [{ default: App }] = await Promise.all([
    import('./App'),
    // Kick off i18n loading in parallel but do NOT await it —
    // App.tsx renders SkeletonPageShell until translations are ready,
    // so React can paint immediately instead of blocking on ~200KB of i18n.
    homeCritical ? import('./services/i18n') : Promise.resolve(null),
  ]);

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  if (!homeCritical) {
    await waitForAsyncStylesheet();
  }

  await waitForFirstPaint();
  document.getElementById('loading-shell')?.remove();
};

// Mount React immediately on all paths for better LCP.
// The loading shell provides instant visual feedback while JS loads.
void mountApp();
