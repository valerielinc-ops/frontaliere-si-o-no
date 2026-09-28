/**
 * Event URL retention helpers.
 *
 * This module is site-only: the corpus has an adapted, inert copy of
 * events-utils.mjs and does not run the crawler/build pipeline. Keeping the
 * archive metadata here avoids changing that adapted mirror for a behavior
 * that belongs to the site's published event routes.
 */

import {
  isoDay,
  slugifyEvent,
  reserveLadderShape,
  disambiguateEventSlug,
  resolveCantonUrlKey,
  upcomingEvents,
  OTHER_EVENTS_COMUNE_KEY,
  UNRESOLVED_CANTON_KEY,
} from './events-utils.mjs';

function routeBucketForEvent(event) {
  const rawCanton = typeof event?.canton === 'string' ? event.canton.trim() : '';
  const rawComune = typeof event?.comune === 'string' ? event.comune.trim() : '';
  return {
    canton: rawCanton ? resolveCantonUrlKey(rawCanton) : UNRESOLVED_CANTON_KEY,
    comune: rawComune || OTHER_EVENTS_COMUNE_KEY,
  };
}

/** The resolved route currently derived for an event. */
export function eventRouteForHistory(event, overrides = {}) {
  const slug = overrides.slug || event?.__historySlug || slugifyEvent(event);
  if (!slug) return null;
  const bucket = routeBucketForEvent(event);
  return {
    canton: overrides.canton || event?.__historyCanton || bucket.canton,
    comune: overrides.comune || event?.__historyComune || bucket.comune,
    slug,
  };
}

function normalizeEventHistoryRoute(route, fallbackRoute) {
  if (!route || typeof route !== 'object') return null;
  const slug = typeof route.slug === 'string' ? route.slug.trim() : '';
  if (!slug) return null;
  return {
    canton: resolveCantonUrlKey(
      typeof route.canton === 'string' && route.canton.trim()
        ? route.canton.trim()
        : fallbackRoute?.canton || UNRESOLVED_CANTON_KEY,
    ),
    comune:
      typeof route.comune === 'string' && route.comune.trim()
        ? route.comune.trim()
        : fallbackRoute?.comune || OTHER_EVENTS_COMUNE_KEY,
    slug,
  };
}

function eventHistoryRouteKey(route) {
  return `${route?.canton || ''}|${route?.comune || ''}|${route?.slug || ''}`;
}

/** Carry route history from older records into a newer event record. */
export function preserveEventHistory(event, priorEvents = []) {
  const current = eventRouteForHistory(event);
  const candidates = [];
  const priorFallbacks = priorEvents.map((record) => eventRouteForHistory(record));
  for (let index = 0; index < priorEvents.length; index += 1) {
    const record = priorEvents[index];
    const fallback = priorFallbacks[index];
    candidates.push(fallback);
    for (const route of Array.isArray(record?.previousRoutes) ? record.previousRoutes : []) {
      candidates.push(normalizeEventHistoryRoute(route, fallback));
    }
  }
  const incomingFallback = priorFallbacks[0] || current;
  for (const route of Array.isArray(event?.previousRoutes) ? event.previousRoutes : []) {
    candidates.push(normalizeEventHistoryRoute(route, incomingFallback));
  }
  const seen = new Set();
  const previousRoutes = [];
  for (const candidate of candidates) {
    const route = candidate?.slug ? candidate : normalizeEventHistoryRoute(candidate, incomingFallback);
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

/** Match the build plugin's collision-resolved slug assignment in data code. */
export function assignEventSlugsForHistory(list, reservedBaseSlugs = new Set()) {
  const used = new Set([...reservedBaseSlugs].map((slug) => reserveLadderShape(slug, 'evento')));
  const slugFor = new Map();
  for (const event of list) {
    const base = slugifyEvent(event);
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = disambiguateEventSlug(base, n++);
    used.add(slug);
    slugFor.set(event.id, slug);
  }
  return slugFor;
}

function routeGroups(events) {
  const groups = new Map();
  for (const event of events) {
    const route = eventRouteForHistory(event);
    const key = `${route.canton}|${route.comune}`;
    const group = groups.get(key) || { canton: route.canton, comune: route.comune, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  return groups;
}

/** Derive the route slug that the last static build assigned to each event. */
export function publishedEventRoutes(events, todayIso) {
  const liveRoutes = new Map();
  const routes = new Map();
  for (const group of routeGroups(upcomingEvents(events, todayIso)).values()) {
    const assigned = assignEventSlugsForHistory(group.events);
    const reserved = new Set();
    for (const event of group.events) {
      const route = eventRouteForHistory(event, {
        canton: group.canton,
        comune: group.comune,
        slug: assigned.get(event.id),
      });
      routes.set(event.id, route);
      reserved.add(route.slug);
    }
    liveRoutes.set(`${group.canton}|${group.comune}`, reserved);
  }
  for (const group of routeGroups(allEndedEvents(events, todayIso)).values()) {
    const assigned = assignEventSlugsForHistory(
      group.events,
      liveRoutes.get(`${group.canton}|${group.comune}`) || new Set(),
    );
    for (const event of group.events) {
      routes.set(
        event.id,
        eventRouteForHistory(event, {
          canton: group.canton,
          comune: group.comune,
          slug: assigned.get(event.id),
        }),
      );
    }
  }
  return routes;
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
