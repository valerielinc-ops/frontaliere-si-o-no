import { buildPath, parsePath, type AppRoute } from '@/services/router';

export const ADMIN_CANONICAL_ORIGIN = 'https://frontaliereticino.ch';

export function currentAdminRoute(): AppRoute {
  if (typeof window === 'undefined') return { activeTab: 'admin', adminSection: '' };
  return parsePath(window.location.pathname).route;
}

export function adminSectionPath(section: string): string {
  // Admin is a private, non-localised surface. Keeping its links on the
  // Italian canonical path means every shared deep link has a matching static
  // noindex shell; locale-prefixed public routes do not need duplicate shells.
  return buildPath({ activeTab: 'admin', adminSection: section }, 'it');
}

export function canonicalAdminUrl(): string {
  if (typeof window === 'undefined') return `${ADMIN_CANONICAL_ORIGIN}${adminSectionPath('')}`;
  const route = currentAdminRoute();
  return `${ADMIN_CANONICAL_ORIGIN}${adminSectionPath(route.adminSection)}${window.location.search}${window.location.hash}`;
}

export function navigateAdminSection(section: string): void {
  const path = adminSectionPath(section);
  history.pushState({ route: { activeTab: 'admin', adminSection: section } }, '', path);
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

