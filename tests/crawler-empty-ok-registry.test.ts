/**
 * Registry degli zeri ammessi del monitor crawler-health.
 *
 * Se uno di questi casi fallisce: «Registry degli zeri ammessi cresciuta o
 * rientrata nel monitor: serve una prova nel parser, non una voce».
 *
 * La lista `EMPTY_OK_CRAWLERS` viveva dentro `scripts/check-crawler-health.mjs`
 * e ogni PR per azienda che toglieva il proprio slug toccava il file della
 * logica del monitor: PR chiuse e rifatte per conflitto (11135, 11136, 11147),
 * fixer in `overlap-skip`. Ora sta in `scripts/lib/crawler-empty-ok-registry.mjs`
 * ed è chiusa: un nuovo zero legittimo si prova nel parser
 * (`markAuthoritativeEmptySnapshot`), non si dichiara con una voce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_OK_CRAWLERS,
  LEGACY_SOURCE_PROVEN_EMPTY_CRAWLERS,
} from '../scripts/lib/crawler-empty-ok-registry.mjs';
import { nextCrawlerState } from '../scripts/check-crawler-health.mjs';
import { CRAWLER_ABORT_KINDS } from '../scripts/lib/crawler-fetch-outcome.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// Ratchet: misurato allo spostamento della registry fuori dal monitor. Può solo
// scendere: quando una prova nel parser rende una voce superflua, togli la voce
// e abbassa questo numero nella stessa PR. Non alzarlo mai.
const EMPTY_OK_CRAWLERS_MAX = 54; // cron-count-ok: ratchet della registry chiusa, scende soltanto

/**
 * Le chiavi che il monitor può osservare secondo il manifest dei crawler: lo
 * slug di ogni workflow più ogni slice `data/jobs/by-crawler/<chiave>.json`
 * che un workflow scrive (i runner multi-slice, per esempio Swatch Group o
 * i runner a scope di housekeeping, pubblicano chiavi diverse dal proprio slug).
 */
function knownCrawlerKeys(): Set<string> {
  const raw = readRepoFile('data/crawler-manifest.json');
  const manifest = JSON.parse(raw) as { manifest: Array<{ slug: string }> };
  const keys = new Set(manifest.manifest.map((entry) => entry.slug));
  for (const match of raw.matchAll(/data\/jobs\/by-crawler\/([a-z0-9][a-z0-9-]*)\.json/g)) {
    keys.add(match[1]);
  }
  return keys;
}

describe('crawler-empty-ok-registry — la registry è chiusa', () => {
  it('non cresce: la dimensione può solo scendere', () => {
    expect(EMPTY_OK_CRAWLERS.size).toBeGreaterThan(0);
    expect(
      EMPTY_OK_CRAWLERS.size,
      'Registry degli zeri ammessi cresciuta: serve una prova nel parser, non una voce',
    ).toBeLessThanOrEqual(EMPTY_OK_CRAWLERS_MAX);
  });

  it('elenca solo crawler noti al manifest', () => {
    const known = knownCrawlerKeys();
    expect(known.size).toBeGreaterThan(0);
    const unknown = [...EMPTY_OK_CRAWLERS, ...LEGACY_SOURCE_PROVEN_EMPTY_CRAWLERS]
      .filter((slug) => !known.has(slug));
    expect(unknown, 'voci della registry senza crawler nel manifest: toglile').toEqual([]);
  });

  it('non è più dichiarata dentro il monitor', () => {
    const monitor = readRepoFile('scripts/check-crawler-health.mjs');
    expect(monitor).toContain("from './lib/crawler-empty-ok-registry.mjs'");
    expect(monitor).not.toMatch(/const\s+(?:EMPTY_OK_CRAWLERS|LEGACY_SOURCE_PROVEN_EMPTY_CRAWLERS)\s*=/);
    // Nessun Set letterale di slug: la lista non può rientrare con un altro nome.
    const slugSetLiteral = /new Set\(\[\s*(?:\/\/[^\n]*\n\s*)*'[a-z0-9][a-z0-9-]*'/;
    expect(
      monitor,
      'Registry degli zeri ammessi rientrata nel monitor: serve una prova nel parser, non una voce',
    ).not.toMatch(slugSetLiteral);
  });
});

describe('nextCrawlerState — un abortKind riportato ma non descritto resta nominato', () => {
  const NOW_MS = Date.now();
  const NOW_ISO = new Date(NOW_MS).toISOString();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const prev = {
    lastSuccessfulRunAt: null,
    lastNonZeroJobs: 7,
    consecutiveEmptyRuns: 2,
    lastFailureReason: null,
    status: 'healthy',
    _lastObservedAt: new Date(NOW_MS - DAY_MS).toISOString(),
    _lastObservedJobs: 0,
    _lastObservedFreshnessAt: new Date(NOW_MS - DAY_MS).toISOString(),
  };
  function abortedObs(abortKind: string | null) {
    return {
      slug: 'not-on-any-allowlist',
      jobCount: 0,
      freshnessAt: NOW_ISO,
      freshnessSource: 'summary' as const,
      generatedAt: NOW_ISO,
      assembledAt: NOW_ISO,
      discovered: null,
      written: 0,
      earlyExit: true,
      exitCode: 0,
      abortKind,
    };
  }

  // Le cause che il monitor descrive con una frase propria; ogni altra voce
  // del vocabolario condiviso deve arrivare nell'issue col suo nome.
  const DESCRIBED = new Set(['no-jobs-parsed', 'connection-level-fetch', 'crash']);
  const undescribed = [...CRAWLER_ABORT_KINDS].filter((kind) => !DESCRIBED.has(kind));

  it('il vocabolario condiviso ha cause che la mappa non descrive', () => {
    expect(undescribed.length).toBeGreaterThan(0);
  });

  it.each(undescribed)('abortKind=%s non diventa «cause not reported»', (kind) => {
    const { status, reason } = nextCrawlerState(prev, abortedObs(kind), NOW_ISO, NOW_MS);
    expect(status).toBe('broken');
    expect(reason).toContain(`reported its early exit as abortKind=${kind}`);
    expect(reason).not.toContain('the early-exit cause was not reported');
  });

  it('senza abortKind dice ancora che la causa non è stata riportata', () => {
    const { status, reason } = nextCrawlerState(prev, abortedObs(null), NOW_ISO, NOW_MS);
    expect(status).toBe('broken');
    expect(reason).toContain('the early-exit cause was not reported');
  });
});
