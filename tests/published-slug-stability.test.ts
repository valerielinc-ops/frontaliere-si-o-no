/**
 * A job's published per-locale slug stays canonical when only its title moves.
 *
 * Live case (2026-11-12, build e6a1c674): the cippatrasporti slice kept
 * `slugByLocale.it = servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso`
 * (the URL Google had indexed, 425 impressions in 28 days), while the deploy-time
 * `hardenJobLocaleFields` pass over data/jobs.json re-derived the source-locale
 * slug from the current IT title ("Customer Service Transport Specialist") and
 * published `customer-service-transport-specialist-cippa-trasporti-sa-chiasso`.
 * The indexed URL became a noindex bridge. The rule now lives in
 * scripts/lib/published-slug-stability.mjs and is shared by the three slug
 * writers that re-derive from titles.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hardenJobLocaleFields } from '../scripts/lib/dedicated-crawler-common.mjs';
import { ensureLocaleFields } from '../scripts/lib/shared-jobs-crawler.mjs';
import {
  jobSlugsUnpublished,
  mayReplacePublishedSlug,
  publishedSlugKeepsIdentity,
} from '../scripts/lib/published-slug-stability.mjs';

const INDEXED_IT = 'servizio-clienti-transport-specialista-cippa-trasporti-sa-chiasso';
const TITLE_DERIVED_IT = 'customer-service-transport-specialist-cippa-trasporti-sa-chiasso';
const COMPANY = 'Cippà Trasporti SA';
const DESCRIPTION = [
  'Cippà Trasporti è una società solida e dinamica che da oltre cinquant\'anni supporta aziende',
  'e partner con soluzioni di trasporto, logistica e servizi doganali in Italia e nel mondo.',
  'Per la nostra sede di Chiasso siamo alla ricerca di una persona appassionata, con spirito di',
  'iniziativa e voglia di costruire relazioni durature con clienti e partner, che abbia esperienza',
  'nel settore delle spedizioni internazionali. Entrerai a far parte di un team dinamico e avrai',
  'la possibilità di crescere. Mansioni principali: gestione degli ordini di trasporto, contatto',
  'quotidiano con i clienti, coordinamento con i vettori e con l\'ufficio doganale, monitoraggio',
  'delle spedizioni e risoluzione delle anomalie. Requisiti: esperienza nel servizio clienti,',
  'ottima conoscenza dell\'italiano e dell\'inglese, precisione e capacità organizzative.',
].join(' ');

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function cippaJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cippatrasporti-c38396f76831',
    slug: INDEXED_IT,
    slugByLocale: {
      it: INDEXED_IT,
      en: 'customer-service-transport-specialist-cippa-trasporti-sa-lugano',
      de: 'kundendienst-transport-spezialist-cippa-trasporti-sa-lugano',
      fr: 'service-client-transport-specialiste-cippa-trasporti-sa-chiasso',
    },
    company: COMPANY,
    companyKey: 'cippatrasporti',
    title: 'Customer Service Transport Specialist',
    titleByLocale: {
      it: 'Customer Service Transport Specialist',
      en: 'Customer Service Specialist',
      de: 'Kundendienst Transport Spezialist',
      fr: 'Service Client Transport Spécialiste',
    },
    description: DESCRIPTION,
    descriptionByLocale: { it: DESCRIPTION },
    location: 'Chiasso',
    addressLocality: 'Chiasso',
    canton: 'TI',
    sourceLang: 'it',
    url: 'https://cippatrasporti.altamiraweb.com/annunci-lavoro/Customer-Service-Transport-Specialist-Chiasso-672753984.htm',
    crawledAt: daysAgo(1),
    datePosted: daysAgo(30),
    previousSlugsByLocale: {
      it: [
        'servizio-clienti-transport-specialista-cippa-trasporti-sa-lugano',
        'customer-service-transport-specialist-cippatrasporti-ch',
      ],
    },
    previousSlugs: [
      'servizio-clienti-transport-specialista-cippa-trasporti-sa-lugano',
      'customer-service-transport-specialist-cippatrasporti-ch',
    ],
    ...overrides,
  };
}

const tmpFiles: string[] = [];
let seq = 0;
const previousRegistryOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
const previousLedgerOverride = process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
  if (previousRegistryOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
  else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousRegistryOverride;
  if (previousLedgerOverride === undefined) delete process.env.URL_FIRST_SEEN_PATH_OVERRIDE;
  else process.env.URL_FIRST_SEEN_PATH_OVERRIDE = previousLedgerOverride;
});

/** Served-URL ledger fixture (data/url-first-seen.json shape); null = absent. */
function useLedger(entries: Record<string, string> | null) {
  const ledgerPath = path.join(os.tmpdir(), `published-slug-ledger-${process.pid}-${seq++}.json`);
  if (entries) {
    fs.writeFileSync(ledgerPath, JSON.stringify(entries), 'utf-8');
    tmpFiles.push(ledgerPath);
  }
  process.env.URL_FIRST_SEEN_PATH_OVERRIDE = ledgerPath;
}

/** The live ledger rows of the cippatrasporti posting (2026-11-13). */
const CIPPA_LEDGER = {
  [`/cerca-lavoro-ticino/${INDEXED_IT}`]: '2026-09-02',
  [`/cerca-lavoro-ticino/${TITLE_DERIVED_IT}`]: '2026-10-30',
  '/en/find-jobs-ticino/customer-service-transport-specialist-cippa-trasporti-sa-lugano': '2026-09-02',
};

/** hardenJobLocaleFields caches per path: every call gets a fresh file. */
function harden(jobs: object[]) {
  const registryPath = path.join(os.tmpdir(), `published-slug-registry-${process.pid}-${seq}.json`);
  fs.writeFileSync(registryPath, '{}', 'utf-8');
  tmpFiles.push(registryPath);
  process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryPath;
  const file = path.join(os.tmpdir(), `published-slug-harden-${process.pid}-${seq++}.json`);
  tmpFiles.push(file);
  fs.writeFileSync(file, JSON.stringify(jobs), 'utf-8');
  hardenJobLocaleFields({ dataJobsPath: file });
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('publishedSlugKeepsIdentity', () => {
  it('a slug carrying the company and the location keeps the identity, whatever its title words', () => {
    useLedger(null);
    const identity = { company: COMPANY, location: 'Chiasso' };
    expect(publishedSlugKeepsIdentity(INDEXED_IT, identity)).toBe(true);
    expect(publishedSlugKeepsIdentity(TITLE_DERIVED_IT, identity)).toBe(true);
    expect(mayReplacePublishedSlug(INDEXED_IT, identity)).toBe(false);
  });

  it('a relocation, a missing company tail or a missing slug may be re-derived', () => {
    const identity = { company: COMPANY, location: 'Chiasso' };
    expect(mayReplacePublishedSlug('customer-service-transport-specialist-cippa-trasporti-sa-lugano', identity)).toBe(true);
    expect(mayReplacePublishedSlug('customer-service-transport-specialist-cippatrasporti-ch', identity)).toBe(true);
    expect(mayReplacePublishedSlug('', identity)).toBe(true);
  });

  it('a brand relabel whose only shared token is the city is an identity change', () => {
    expect(mayReplacePublishedSlug(
      'assistenzarztin-assistenzarzt-zentrum-fur-soziale-psychiatrie-puk-zuerich-dietikon',
      { company: 'Psychiatrische Universitätsklinik Zürich', location: 'Dietikon' },
    )).toBe(true);
  });
});

describe('slugs that were never served are still derived as new ones', () => {
  const sourceTitle = 'Schreiner/in für Werkstattarbeiten';
  const heldJob = {
    id: 'fachkraft-e52cf272d2b3',
    companyKey: 'fachkraft',
    sourceLang: 'de',
    title: sourceTitle,
    titleByLocale: { de: sourceTitle, it: sourceTitle, en: sourceTitle, fr: sourceTitle },
    translationHoldSince: daysAgo(2),
  };
  const identity = { company: 'fachkraft.ch GmbH', location: 'Wil SG' };
  const copiedSlug = 'schreiner-in-fur-werkstattarbeiten-fachkraft-ch-gmbh-wil-sg';

  it('an agency job held for translation has no published slug yet', () => {
    expect(jobSlugsUnpublished(heldJob)).toBe(true);
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: heldJob })).toBe(true);
  });

  it('the release window opens only for the translate-run regeneration', () => {
    const released = { ...heldJob, translationHoldSince: undefined, translationHoldReleasedAt: daysAgo(0.05) };
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: released, justReleased: true })).toBe(true);
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: released })).toBe(false);
    const releasedLongAgo = { ...released, translationHoldReleasedAt: daysAgo(3) };
    expect(mayReplacePublishedSlug(copiedSlug, identity, { job: releasedLongAgo, justReleased: true })).toBe(false);
  });
});

describe('hardenJobLocaleFields keeps a published slug when only the title moved', () => {
  it('keeps the indexed IT slug of the cippatrasporti posting and bridges the derived one it served', () => {
    useLedger(CIPPA_LEDGER);
    const [after] = harden([cippaJob()]);
    expect(after.slugByLocale.it).toBe(INDEXED_IT);
    expect(after.slug).toBe(INDEXED_IT);
    // The title-derived URL earlier builds served stays reachable as a bridge,
    // and the canonical slug never lands in its own bridge list (no cycle).
    expect(after.previousSlugsByLocale.it).toContain(TITLE_DERIVED_IT);
    expect(after.previousSlugsByLocale.it).not.toContain(INDEXED_IT);
  });

  it('without the ledger keeps the slice slug and mints no bridge', () => {
    useLedger(null);
    const [after] = harden([cippaJob()]);
    expect(after.slugByLocale.it).toBe(INDEXED_IT);
    expect(after.previousSlugsByLocale?.it ?? []).not.toContain(TITLE_DERIVED_IT);
  });

  it('is idempotent: a second pass over its own output changes nothing', () => {
    useLedger(CIPPA_LEDGER);
    const [first] = harden([cippaJob()]);
    const [second] = harden([first]);
    expect(second.slugByLocale).toEqual(first.slugByLocale);
    expect(second.slug).toBe(first.slug);
    expect(second.previousSlugsByLocale).toEqual(first.previousSlugsByLocale);
  });

  it('a slice slug that never reached a sitemap is not published: the served derivation stays', () => {
    useLedger({ [`/cerca-lavoro-ticino/${TITLE_DERIVED_IT}`]: '2026-10-30' });
    const [after] = harden([cippaJob()]);
    expect(after.slugByLocale.it).toBe(TITLE_DERIVED_IT);
  });

  it('never keeps a served slug that another job shares: the collision is handled as before', () => {
    useLedger(CIPPA_LEDGER);
    const twin = cippaJob({ id: 'cippatrasporti-000000000001', url: 'https://cippatrasporti.altamiraweb.com/annunci-lavoro/twin-1.htm' });
    const [first, second] = harden([cippaJob(), twin]);
    expect(first.slugByLocale.it).toBe(TITLE_DERIVED_IT);
    expect(second.slugByLocale.it).toBe(TITLE_DERIVED_IT);
  });

  it('still re-derives the source-locale slug when the job really moved', () => {
    useLedger(null);
    const moved = cippaJob({
      slug: 'servizio-clienti-transport-specialista-cippa-trasporti-sa-mendrisio',
      slugByLocale: {
        it: 'servizio-clienti-transport-specialista-cippa-trasporti-sa-mendrisio',
        en: 'customer-service-transport-specialist-cippa-trasporti-sa-chiasso',
        de: 'kundendienst-transport-spezialist-cippa-trasporti-sa-chiasso',
        fr: 'service-client-transport-specialiste-cippa-trasporti-sa-chiasso',
      },
    });
    const [after] = harden([moved]);
    expect(after.slugByLocale.it).toBe(TITLE_DERIVED_IT);
    expect(after.previousSlugsByLocale.it).toContain('servizio-clienti-transport-specialista-cippa-trasporti-sa-mendrisio');
  });

  it('fills a missing locale slug as before', () => {
    useLedger(null);
    const job = cippaJob();
    delete (job.slugByLocale as Record<string, string>).fr;
    const [after] = harden([job]);
    expect(String(after.slugByLocale.fr || '')).not.toBe('');
  });
});

describe('ensureLocaleFields keeps a published translated slug', () => {
  it('does not discard a non-IT slug that copies the IT slug once it is published', () => {
    useLedger(null);
    const job = cippaJob({
      slugByLocale: {
        it: INDEXED_IT,
        en: INDEXED_IT,
        de: 'kundendienst-transport-spezialist-cippa-trasporti-sa-chiasso',
        fr: 'service-client-transport-specialiste-cippa-trasporti-sa-chiasso',
      },
      // A translation that keeps every employer word (not a truncation), so
      // the copy-of-IT branch is the one that would re-derive.
      titleByLocale: {
        it: 'Customer Service Transport Specialist',
        en: 'Transport Customer Service Specialist',
        de: 'Kundendienst Transport Spezialist',
        fr: 'Service Client Transport Spécialiste',
      },
    });
    const out = ensureLocaleFields(job);
    expect(out.slugByLocale.en).toBe(INDEXED_IT);
  });
});
