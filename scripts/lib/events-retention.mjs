/**
 * Event URL retention helpers.
 *
 * This module is site-only: the corpus has an adapted, inert copy of
 * events-utils.mjs and does not run the crawler/build pipeline. Keeping the
 * archive metadata here avoids changing that adapted mirror for a behavior
 * that belongs to the site's published event routes.
 */

import { isoDay, slugifyEvent } from './events-utils.mjs';

/** The route currently derived for an event. */
export function eventRouteForHistory(event) {
  const slug = slugifyEvent(event);
  if (!slug) return null;
  return {
    ...(typeof event?.canton === 'string' && event.canton.trim() ? { canton: event.canton.trim() } : {}),
    ...(typeof event?.comune === 'string' && event.comune.trim() ? { comune: event.comune.trim() } : {}),
    slug,
  };
}

function normalizeEventHistoryRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const slug = typeof route.slug === 'string' ? route.slug.trim() : '';
  if (!slug) return null;
  return {
    ...(typeof route.canton === 'string' && route.canton.trim() ? { canton: route.canton.trim() } : {}),
    ...(typeof route.comune === 'string' && route.comune.trim() ? { comune: route.comune.trim() } : {}),
    slug,
  };
}

function eventHistoryRouteKey(route) {
  return `${route?.canton || ''}|${route?.comune || ''}|${route?.slug || ''}`;
}

/** Carry route history from older records into a newer event record. */
export function preserveEventHistory(event, priorEvents = []) {
  const current = eventRouteForHistory(event);
  const candidates = [
    ...(Array.isArray(event?.previousRoutes) ? event.previousRoutes : []),
    ...priorEvents.flatMap((record) => [
      ...(Array.isArray(record?.previousRoutes) ? record.previousRoutes : []),
      eventRouteForHistory(record),
    ]),
  ];
  const seen = new Set();
  const previousRoutes = [];
  for (const candidate of candidates) {
    const route = normalizeEventHistoryRoute(candidate);
    if (!route) continue;
    if (current && eventHistoryRouteKey(route) === eventHistoryRouteKey(current)) continue;
    const key = eventHistoryRouteKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    previousRoutes.push(route);
  }
  if (previousRoutes.length === 0) {
    if (!Array.isArray(event?.previousRoutes) || event.previousRoutes.length === 0) return event;
    const clean = { ...event };
    delete clean.previousRoutes;
    return clean;
  }
  return { ...event, previousRoutes };
}

/** Merge a fresh crawl record without losing the old URL(s) for its id. */
export function mergeEventHistory(existing, incoming) {
  return preserveEventHistory(incoming, existing ? [existing] : []);
}

/**
 * All events whose last relevant date is before today, sorted like the
 * short-grace helper. The page builder uses this permanent archive pass so a
 * historical detail URL never becomes a 404 merely because it aged out of a
 * bridge window. These pages remain noindex and outside the sitemap.
 */
export function allEndedEvents(events, todayIso) {
  const today = todayIso || isoDay(new Date());
  return [...events]
    .filter((e) => {
      if (!e || typeof e.startDate !== 'string') return false;
      const end = e.endDate || e.startDate;
      return end < today;
    })
    .sort(
      (a, b) =>
        (b.endDate || b.startDate || '').localeCompare(a.endDate || a.startDate || '') ||
        (a.title || '').localeCompare(b.title || '') ||
        (a.id || '').localeCompare(b.id || ''),
    );
}
