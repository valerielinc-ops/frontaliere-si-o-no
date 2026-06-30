/**
 * collect-followup-batch — il collector zero-Claude che converte post-merge-followup
 * da trigger per-PR a batch schedulato. Sicurezza > velocità: il watermark si ancora
 * all'ultima run di SUCCESSO (una run fallita NON avanza il watermark → la finestra
 * è ri-coperta dalla run successiva), il filtro autore normalizza le forme login
 * `app/<name>` (gh GraphQL) / `<name>[bot]` (REST), e l'idempotenza salta le PR già
 * commentate. Qui si testano i puri (gh non viene invocato): watermark-fallback,
 * filtro autore, idempotenza, normalizzazione login, max-turns floor.
 */
import { describe, it, expect } from 'vitest';
import {
  computeWatermarkISO,
  parseMergedPRs,
  hasTriageComment,
  canonicalLogin,
  maxTurnsFor,
} from '../scripts/ci/collect-followup-batch.mjs';

describe('canonicalLogin', () => {
  it('strips the gh GraphQL `app/` prefix', () => {
    expect(canonicalLogin('app/frontaliere-automation')).toBe('frontaliere-automation');
  });
  it('strips the REST `[bot]` suffix', () => {
    expect(canonicalLogin('frontaliere-automation[bot]')).toBe('frontaliere-automation');
  });
  it('leaves a plain human login untouched', () => {
    expect(canonicalLogin('valerielinc-ops')).toBe('valerielinc-ops');
  });
  it('is safe on empty / non-string', () => {
    expect(canonicalLogin('')).toBe('');
    expect(canonicalLogin(null as unknown as string)).toBe('');
  });
});

describe('computeWatermarkISO', () => {
  const NOW = Date.parse('2026-06-30T12:00:00Z');

  it('uses startedAt of the last successful run', () => {
    const json = JSON.stringify([{ createdAt: '2026-06-30T09:00:00Z', startedAt: '2026-06-30T09:01:00Z' }]);
    expect(computeWatermarkISO(json, NOW)).toBe('2026-06-30T09:01:00.000Z');
  });

  it('falls back to createdAt when startedAt is missing', () => {
    const json = JSON.stringify([{ createdAt: '2026-06-30T08:00:00Z' }]);
    expect(computeWatermarkISO(json, NOW)).toBe('2026-06-30T08:00:00.000Z');
  });

  it('falls back to now-6h when no successful run exists (empty array)', () => {
    expect(computeWatermarkISO('[]', NOW)).toBe(new Date(NOW - 6 * 3600_000).toISOString());
  });

  it('falls back to now-6h on invalid JSON (proceed-safe, never misses a window)', () => {
    expect(computeWatermarkISO('not json', NOW)).toBe(new Date(NOW - 6 * 3600_000).toISOString());
  });

  it('respects a custom fallback window', () => {
    expect(computeWatermarkISO('[]', NOW, 3)).toBe(new Date(NOW - 3 * 3600_000).toISOString());
  });
});

describe('parseMergedPRs (author filter)', () => {
  const list = JSON.stringify([
    { number: 1, author: { login: 'valerielinc-ops' } },
    { number: 2, author: { login: 'app/frontaliere-automation' } },
    { number: 3, author: { login: 'frontaliere-automation[bot]' } },
    { number: 4, author: { login: 'app/claude' } }, // not in allowlist
    { number: 5, author: { login: 'dependabot[bot]' } }, // not in allowlist
    { number: 6 }, // no author → dropped
  ]);

  it('keeps only eligible authors (both gh `app/` and REST `[bot]` forms)', () => {
    expect(parseMergedPRs(list).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it('returns [] on unparseable input (proceed-safe: window re-covered next run)', () => {
    expect(parseMergedPRs('garbage')).toEqual([]);
    expect(parseMergedPRs('')).toEqual([]);
  });

  it('returns [] when the list is not an array', () => {
    expect(parseMergedPRs(JSON.stringify({ nope: true }))).toEqual([]);
  });
});

describe('hasTriageComment (idempotency)', () => {
  const withTriage = JSON.stringify({
    comments: [
      { body: 'random chatter' },
      { body: '## Post-merge follow-up triage: zero outstanding items.' },
    ],
  });
  const withoutTriage = JSON.stringify({
    comments: [{ body: 'LGTM' }, { body: 'nice work' }],
  });

  it('detects an existing triage comment (any variant)', () => {
    expect(hasTriageComment(withTriage)).toBe(true);
  });

  it('detects the leading-whitespace variant', () => {
    expect(hasTriageComment(JSON.stringify({ comments: [{ body: '\n## Post-merge follow-up triage\n...' }] }))).toBe(true);
  });

  it('returns false when no triage comment is present (PR stays a candidate)', () => {
    expect(hasTriageComment(withoutTriage)).toBe(false);
  });

  it('accepts a bare comments array as well as the {comments:[...]} shape', () => {
    expect(hasTriageComment(JSON.stringify([{ body: '## Post-merge follow-up triage' }]))).toBe(true);
  });

  it('returns false on parse error (proceed-safe: NOT deduped → triage runs)', () => {
    expect(hasTriageComment('not json')).toBe(false);
    expect(hasTriageComment('')).toBe(false);
  });
});

describe('maxTurnsFor', () => {
  it('never drops below the original floor of 20 (AGENTS.md: mai abbassare)', () => {
    expect(maxTurnsFor(0)).toBeGreaterThanOrEqual(20);
    expect(maxTurnsFor(1)).toBe(26);
  });
  it('scales with batch size', () => {
    expect(maxTurnsFor(5)).toBe(50);
  });
  it('caps at 60', () => {
    expect(maxTurnsFor(20)).toBe(60);
  });
});
