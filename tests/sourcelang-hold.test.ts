/**
 * Guard: hardenJobLocaleFields must not let a WEAK re-detection flip a job's
 * already-stored sourceLang.
 *
 * detectTextLocale re-runs on every crawler pass. Before the hold guard its
 * verdict was written back unconditionally, so a job whose text sits near the
 * it/en boundary oscillated from pass to pass (measured on origin/main:
 * 68 transitions in 3 days, 62 of them below 0.65 confidence, median 0.436).
 * Each flip stamps the source title/description into the newly elected locale
 * slot, and from there the completeness gate is unsatisfiable by any output.
 *
 * The guard protects against the FLIP, not against the first assignment: a job
 * with no stored sourceLang still takes whatever the detection says.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { hardenJobLocaleFields } from '../scripts/lib/dedicated-crawler-common.mjs';

const tmpFiles: string[] = [];

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
});

// Confidence 0.251 (en) — below the 0.65 hold bar. Mixed IT/EN academic
// wording, the exact shape that made `usi` jobs oscillate.
const WEAK_TEXT =
  'Posizioni di dottorandi PhD student positions at the institute research ' +
  'project supervisor deadline application candidates faculty informatics ' +
  'università della svizzera italiana ricerca dottorato borsa di studio ' +
  'requisiti candidatura scadenza domanda.';

// Confidence 0.716 (en) — above the bar.
const STRONG_EN_TEXT =
  'The successful candidate will be responsible for developing and ' +
  'maintaining the software platform, working closely with the engineering ' +
  'team, and reporting to the head of department. We are looking for a ' +
  'candidate with a strong background in distributed systems and a proven ' +
  'track record of shipping production software. The position is based in ' +
  'our main office and offers a competitive salary.';

function harden(job: Record<string, unknown>): Record<string, unknown> {
  const tmp = path.join(
    os.tmpdir(),
    `sourcelang-hold-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
  tmpFiles.push(tmp);
  fs.writeFileSync(tmp, JSON.stringify([job], null, 2), 'utf-8');
  hardenJobLocaleFields({ dataJobsPath: tmp });
  return JSON.parse(fs.readFileSync(tmp, 'utf-8'))[0];
}

function baseJob(description: string, sourceLang?: string) {
  return {
    id: 'usi-hold-fixture',
    url: 'https://www.usi.ch/en/feeds/hold-fixture',
    title: 'Posizioni di dottorandi',
    company: 'USI',
    location: 'Lugano',
    slug: 'posizioni-di-dottorandi-usi-lugano',
    description,
    ...(sourceLang ? { sourceLang } : {}),
  };
}

describe('sourceLang hold guard', () => {
  it('keeps the stored sourceLang when the re-detection is below 0.65', () => {
    const out = harden(baseJob(WEAK_TEXT, 'it'));
    expect(out.sourceLang).toBe('it');
    // The Italian title must stay in the Italian slot — that is the write the
    // flip corrupted.
    expect((out.titleByLocale as Record<string, string>).it).toBe(
      'Posizioni di dottorandi',
    );
  });

  it('lets a confident re-detection overrule the stored sourceLang', () => {
    const out = harden(baseJob(STRONG_EN_TEXT, 'it'));
    expect(out.sourceLang).toBe('en');
  });

  it('accepts a weak detection when no sourceLang is stored yet', () => {
    const out = harden(baseJob(WEAK_TEXT));
    expect(out.sourceLang).toBe('en');
  });
});
