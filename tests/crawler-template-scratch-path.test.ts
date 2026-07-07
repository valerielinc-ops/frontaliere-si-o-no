/**
 * Guards the per-crawler-scoped scratch path (crawlerScratchPathFor) that
 * replaced the cross-process advisory lock previously used to serialize
 * read-modify-write access to a shared data/jobs.json.
 *
 * Post-#3701, ~25 dedicated crawlers run concurrently as sibling
 * `background: true` steps in ONE job (one filesystem). Rather than
 * serializing access to one shared file with a lock, each crawler process
 * now gets its own uniquely-named scratch file under os.tmpdir(), keyed by
 * companyKey — so no sibling crawler is ever able to read or write another
 * crawler's file, eliminating the race by construction instead of by mutual
 * exclusion.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { crawlerScratchPathFor } from '../scripts/lib/crawler-scratch-path.mjs';

describe('crawlerScratchPathFor', () => {
  it('is deterministic — the same companyKey always resolves to the same path', () => {
    // Steps 1, 3, 5 and 6 of the pipeline each re-derive this path
    // independently within one crawler run; they must all agree on it.
    const a = crawlerScratchPathFor('ubs');
    const b = crawlerScratchPathFor('ubs');
    expect(a).toBe(b);
  });

  it('scopes every companyKey to a distinct path — no two crawlers can ever collide', () => {
    const companyKeys = [
      'ubs', 'axa', 'afry', 'agie-charmilles', 'agroscope', 'artificialy',
      'berit-klinik', 'clinique-le-noirmont', 'debiopharm', 'groupe-mutuel',
      'hes-so-valais', 'hitachi-energy', 'hoval', 'klinik-wyssholzli',
      'knowledge-lab', 'pwc', 'tarchini-group', 'interroll', 'lafonte',
      'schindler',
    ];

    const paths = companyKeys.map((key) => crawlerScratchPathFor(key));
    expect(new Set(paths).size).toBe(companyKeys.length);
  });

  it('resolves under os.tmpdir(), never inside the repo (never gitignored-but-shared)', () => {
    const p = crawlerScratchPathFor('ubs');
    expect(path.dirname(p)).toBe(os.tmpdir());
  });
});
