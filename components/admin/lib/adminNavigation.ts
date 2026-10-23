import { buildPath, parsePath, pushRoute, type AppRoute } from '@/services/router';

export const ADMIN_CANONICAL_ORIGIN = 'https://frontaliereticino.ch';

export function currentAdminRoute(): AppRoute {
  if (typeof window === 'undefined') return { activeTab: 'admin', adminSection: '' };
  return parsePath(window.location.pathname).route;
}

export function adminSectionPath(section: string): string {
  return buildPath({ activeTab: 'admin', adminSection: section });
}

export function canonicalAdminUrl(): string {
  if (typeof window === 'undefined') return `${ADMIN_CANONICAL_ORIGIN}/gestione-contenuti-xk9mp2q/`;
  return `${ADMIN_CANONICAL_ORIGIN}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function navigateAdminSection(section: string): void {
  pushRoute({ activeTab: 'admin', adminSection: section });
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function replaceAdminQuery(updates: Record<string, string | null | undefined>): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

