/**
 * Regression tests for the structure-flattening class behind issue #3836
 * (Audit Parser Quality — no-structure ratchet criticals).
 *
 * Root cause: `mergeLocaleTextMap` normalized every locale value with
 * `normalizeSpace`, which collapses `\n` into a plain space. The merge runs on
 * EVERY crawl, so the freshly parsed source-locale description (with real
 * line-start bullets) was re-flattened into inline `… • item• item` prose each
 * run, and structured translations were flattened the moment they were carried
 * over. One-shot data repairs (#3721) were silently undone by the next crawl.
 *
 * The fix has two halves:
 *  1. mergeLocaleTextMap preserves newlines (root cause — stops NEW flattening).
 *  2. hardenJobLocaleFields restores a structure-flattened source-locale copy
 *     from the authoritative `description` and flags needsRetranslation, so
 *     the EXISTING fossils self-heal on the next crawl / repair run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  mergeLocaleTextMap,
  hardenJobLocaleFields,
  resetHardenCache,
} from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  isStructureFlattenedCopy,
  countBullets,
} from '../scripts/lib/translation-quality.mjs';

const STRUCTURED_DE = [
  'Wir von Interdiscount bieten unseren Kundinnen und Kunden das beste Einkaufserlebnis der Schweiz.',
  '',
  '## Aufgaben',
  '• Als Teil unseres System-Teams bist du eine zentrale Drehscheibe im agilen Release Train',
  '• Du bist zuständig für den Aufbau und die Pflege unserer Cloud-Infrastruktur',
  '• Du automatisierst klassische Betriebsaufgaben und beobachtest die Marktentwicklungen',
].join('\n');

const FLATTENED_DE = STRUCTURED_DE.replace(/\s*\n\s*/g, ' ');

const STRUCTURED_IT = [
  'A Interdiscount offriamo ai nostri clienti la migliore esperienza di acquisto in Svizzera.',
  '',
  '## Compiti',
  '• Come parte del nostro team di sistemi sei un punto di riferimento nel Release Train agile',
  '• Sei responsabile della creazione e della manutenzione della nostra infrastruttura cloud',
  '• Automatizzi i classici compiti operativi e osservi gli sviluppi del mercato',
].join('\n');

const tmpFiles: string[] = [];
afterEach(() => {
  resetHardenCache();
  for (const f of tmpFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
});

describe('mergeLocaleTextMap — newline preservation (issue #3836 root cause)', () => {
  it('keeps line-start bullets in the fresh source-locale description (sourceLocale branch)', () => {
    const merged = mergeLocaleTextMap({}, { de: STRUCTURED_DE }, 30, 'de');
    expect(countBullets(merged.de)).toBe(3);
    expect(merged.de).toContain('\n• Als Teil unseres System-Teams');
  });

  it('keeps line-start bullets in preserved non-source translations (sourceLocale branch)', () => {
    const merged = mergeLocaleTextMap(
      { it: STRUCTURED_IT },
      { de: STRUCTURED_DE },
      30,
      'de',
    );
    expect(countBullets(merged.it)).toBe(3);
    expect(merged.it).toContain('\n• Come parte del nostro team');
  });

  it('keeps line-start bullets in the no-sourceLocale fallback branch', () => {
    const merged = mergeLocaleTextMap({ de: STRUCTURED_DE }, {}, 30);
    expect(countBullets(merged.de)).toBe(3);
  });

  it('still collapses runs of spaces/tabs inside lines', () => {
    const merged = mergeLocaleTextMap({}, { de: 'Zeile  eins\t\tmit   Tabs\n• Punkt  eins der Liste' }, 3, 'de');
    expect(merged.de).toBe('Zeile eins mit Tabs\n• Punkt eins der Liste');
  });
});

describe('isStructureFlattenedCopy', () => {
  it('flags a non-empty copy that lost a >=3-bullet source list', () => {
    expect(isStructureFlattenedCopy(STRUCTURED_DE, FLATTENED_DE)).toBe(true);
  });

  it('does not flag when the copy kept at least one bullet', () => {
    const partiallyStructured = 'Intro\n• Solo un punto rimasto della lista originale';
    expect(isStructureFlattenedCopy(STRUCTURED_DE, partiallyStructured)).toBe(false);
  });

  it('does not flag legitimately bullet-free sources (< 3 bullets)', () => {
    const proseSource = 'Testo descrittivo senza alcuna lista puntata, solo prosa.\n\nSecondo paragrafo.';
    expect(isStructureFlattenedCopy(proseSource, 'Descriptive text without any list.')).toBe(false);
  });

  it('does not flag empty/missing copies (handled by the coverage/empty-slot paths)', () => {
    expect(isStructureFlattenedCopy(STRUCTURED_DE, '')).toBe(false);
    expect(isStructureFlattenedCopy(STRUCTURED_DE, undefined as unknown as string)).toBe(false);
  });
});

describe('hardenJobLocaleFields — structure-parity source-slot restore (issue #3836)', () => {
  function writeFixture(job: Record<string, unknown>): string {
    const p = path.join(os.tmpdir(), `harden-structure-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify([job]), 'utf-8');
    tmpFiles.push(p);
    return p;
  }

  it('restores the flattened same-language locale copy from the structured description and flags needsRetranslation', () => {
    const job = {
      id: 'interdiscount-test-1',
      url: 'https://jobs.interdiscount.ch/de/jobs/12345/system-engineer',
      title: 'System Engineer Cloud Infrastruktur',
      company: 'Interdiscount',
      companyKey: 'interdiscount',
      location: 'Jegenstorf',
      sourceLang: 'de',
      description: STRUCTURED_DE,
      descriptionByLocale: {
        de: FLATTENED_DE,
        it: FLATTENED_DE, // fossil "translation" — same-language flattened copy
      },
      titleByLocale: { de: 'System Engineer Cloud Infrastruktur' },
      slugByLocale: { de: 'system-engineer-cloud-infrastruktur-interdiscount-jegenstorf' },
      slug: 'system-engineer-cloud-infrastruktur-interdiscount-jegenstorf',
    };
    const p = writeFixture(job);
    resetHardenCache();

    const result = hardenJobLocaleFields({ dataJobsPath: p });
    expect(result.changed).toBe(true);

    const [hardened] = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Source slot restored to the structured authoritative description…
    expect(countBullets(hardened.descriptionByLocale.de)).toBeGreaterThanOrEqual(3);
    // …and the job is flagged so the pipeline regenerates the derived locales.
    expect(hardened.needsRetranslation).toBe(true);
  });

  it('leaves an already-structured source-locale copy untouched (no churn)', () => {
    const job = {
      id: 'interdiscount-test-2',
      url: 'https://jobs.interdiscount.ch/de/jobs/12346/logistiker',
      title: 'Logistiker Lager',
      company: 'Interdiscount',
      companyKey: 'interdiscount',
      location: 'Jegenstorf',
      sourceLang: 'de',
      description: STRUCTURED_DE,
      descriptionByLocale: {
        de: STRUCTURED_DE,
        it: STRUCTURED_IT,
      },
      titleByLocale: { de: 'Logistiker Lager' },
      slugByLocale: { de: 'logistiker-lager-interdiscount-jegenstorf' },
      slug: 'logistiker-lager-interdiscount-jegenstorf',
    };
    const p = writeFixture(job);
    resetHardenCache();

    hardenJobLocaleFields({ dataJobsPath: p });

    const [hardened] = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // The structured copies survive untouched — the parity restore must not
    // churn healthy slots. (needsRetranslation may still be set by unrelated
    // pre-existing harden logic for the missing en/fr slots, so it is not
    // asserted here.)
    expect(hardened.descriptionByLocale.de).toBe(STRUCTURED_DE);
    expect(hardened.descriptionByLocale.it).toBe(STRUCTURED_IT);
  });
});
