import { normalizeLocToken, locTokenHit } from '../../services/locToken.mjs';
import { getJobPopularityCount } from '../../services/newsletter-content-core.mjs';
import { isOpenJobAlertJob } from './job-alert-newness.mjs';
import { municipalityToCantons } from '../../services/provinceCantonAffinity.ts';
import { buildAlertProfile } from '../../services/jobAlertMatching.mjs';
import { classifyZeroMatchCause } from './job-alert-zero-match-diagnosis.mjs';
import { normalizeSwissCantonCode } from './target-swiss-locations.mjs';

/** Call on the complete active population, before cadence/partition filters. */
export function findDiscoveryBlockedRecipients(alerts) {
  const blocked = new Set();
  for (const alert of alerts) {
    const email = String(alert.email || '').trim().toLowerCase();
    try {
      if (classifyZeroMatchCause(buildAlertProfile(alert)) !== 'empty-profile') blocked.add(email);
    } catch { blocked.add(email); }
  }
  return blocked;
}

/** Same employer diversity policy for personalized and discovery selections. */
export function diversifyJobEmployers(jobs) {
  const counts = new Map(); const first = []; const rest = [];
  for (const job of jobs) {
    const key = String(job.company || '∅').toLowerCase();
    const count = counts.get(key) || 0;
    if (count < 2) { first.push(job); counts.set(key, count + 1); }
    else rest.push(job);
  }
  return first.concat(rest);
}

/** Registration/IP-derived geography is a ranking hint, never a profession. */
export function discoveryGeography(subscriber, profile, sourceJobGeo = []) {
  const sub = subscriber || {};
  const cantons = new Set(profile?.preferredCantons || []);
  const locations = [...(profile?.preferredLocations || []), ...sourceJobGeo].filter(Boolean);
  const country = normalizeLocToken(sub.geo_country);
  if (cantons.size === 0 && locations.length === 0
    && ['ch', 'switzerland', 'svizzera', 'suisse', 'schweiz'].includes(country)) {
    const canton = normalizeSwissCantonCode(sub.geo_region).toLowerCase();
    if (canton) cantons.add(canton);
    if (sub.geo_city) locations.push(String(sub.geo_city));
  }
  if (cantons.size === 0 && locations.length === 0 && ['it', 'italy', 'italia'].includes(country)) {
    for (const canton of municipalityToCantons(sub.geo_city)) cantons.add(canton.toLowerCase());
  }
  for (const location of locations) {
    const canton = normalizeSwissCantonCode(location).toLowerCase();
    if (canton) cantons.add(canton);
  }
  return { locations, cantons };
}

/** Reuses measured views across canonical/localized/previous slugs. No invented popularity. */
export function createDiscoveryRanker(popularity = new Map()) {
  const viewsByJob = new WeakMap();
  return (jobs, geography, now) => {
    const entries = [];
    for (const job of jobs) {
      if (!isOpenJobAlertJob(job, now)) continue;
      if (!viewsByJob.has(job)) viewsByJob.set(job, Number(getJobPopularityCount(job, popularity)) || 0);
      const views = viewsByJob.get(job);
      if (!Number.isFinite(views) || views <= 0) continue;
      const location = `${job.location || ''} ${job.addressLocality || ''} ${job.canton || ''}`;
      const local = geography.cantons.has(String(job.canton || '').toLowerCase())
        || geography.locations.some((needle) => locTokenHit(location, needle));
      entries.push({ job, views, local });
    }
    entries.sort((a, b) => Number(b.local) - Number(a.local) || b.views - a.views);
    return diversifyJobEmployers(entries.map((entry) => entry.job));
  };
}

export const DISCOVERY_COPY = {
  it: { title: 'Le offerte più consultate', description: 'Partiamo dalle offerte più consultate sul sito. I tuoi clic e le tue ricerche ci aiuteranno a proporti annunci più pertinenti. Puoi anche scegliere professione e zona nelle preferenze.' },
  en: { title: 'The most-viewed jobs', description: 'Start with the most-viewed jobs on the site. Your clicks and searches will help us suggest more relevant roles. You can also choose your profession and area in preferences.' },
  de: { title: 'Die meistgesehenen Stellen', description: 'Zum Einstieg zeigen wir die meistgesehenen Stellen auf der Website. Ihre Klicks und Suchanfragen helfen uns, passendere Stellen vorzuschlagen. Beruf und Region können Sie auch in den Einstellungen wählen.' },
  fr: { title: 'Les offres les plus consultées', description: 'Découvrez les offres les plus consultées du site. Vos clics et recherches nous aideront à proposer des annonces plus pertinentes. Vous pouvez aussi choisir votre métier et votre région dans les préférences.' },
};
