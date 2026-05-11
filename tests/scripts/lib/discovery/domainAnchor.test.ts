// tests/scripts/lib/discovery/domainAnchor.test.ts
//
// Domain-anchor gate for the discovery suggest source. Born from the
// 2026-05-11 `mobilita-palermo-frontalieri-ticino` incident — bare
// cluster names ("mobilita") expanded into Italian-mainland-city
// completions via Google Suggest and slipped through every downstream
// filter. See scripts/lib/discovery/domainAnchor.mjs for the full
// rationale and token list.

import { describe, expect, it } from 'vitest';

import {
  anchorSeed,
  hasDomainAnchor,
} from '../../../../scripts/lib/discovery/domainAnchor.mjs';

describe('hasDomainAnchor', () => {
  it('rejects null/empty/non-string inputs', () => {
    expect(hasDomainAnchor(null as unknown as string)).toBe(false);
    expect(hasDomainAnchor(undefined as unknown as string)).toBe(false);
    expect(hasDomainAnchor('')).toBe(false);
    expect(hasDomainAnchor('   ')).toBe(false);
    expect(hasDomainAnchor(42 as unknown as string)).toBe(false);
  });

  it('accepts core domain words (frontalieri, ticino, svizzero, …)', () => {
    expect(hasDomainAnchor('Mobilita frontalieri ticino')).toBe(true);
    expect(hasDomainAnchor('busta paga svizzera')).toBe(true);
    expect(hasDomainAnchor('Frontaliere stipendio')).toBe(true);
    expect(hasDomainAnchor('cross-border tax')).toBe(true);
    expect(hasDomainAnchor('Grenzgänger')).toBe(true);
  });

  it('accepts cross-border concepts (permesso G, AVS, LPP, LAMal, …)', () => {
    expect(hasDomainAnchor('Rinnovo permesso G')).toBe(true);
    expect(hasDomainAnchor('AVS contributi')).toBe(true);
    expect(hasDomainAnchor('LPP secondo pilastro')).toBe(true);
    expect(hasDomainAnchor('LAMal premi 2026')).toBe(true);
    expect(hasDomainAnchor('Telelavoro frontalieri')).toBe(true);
    expect(hasDomainAnchor('Ristorni 2026')).toBe(true);
  });

  it('accepts Ticino toponyms', () => {
    expect(hasDomainAnchor('Mobilita lugano')).toBe(true);
    expect(hasDomainAnchor('Trasporti chiasso confine')).toBe(true);
    expect(hasDomainAnchor('Affitti mendrisio')).toBe(true);
    expect(hasDomainAnchor('Salute locarno')).toBe(true);
    expect(hasDomainAnchor('Bellinzona ospedale')).toBe(true);
  });

  it('accepts other CH cantons commonly referenced in cross-border content', () => {
    expect(hasDomainAnchor('Lavoro a Zurigo')).toBe(true);
    expect(hasDomainAnchor('Ginevra stipendi')).toBe(true);
    expect(hasDomainAnchor('Vallese frontalieri stagionali')).toBe(true);
  });

  it('REJECTS off-topic Italian-city completions (Palermo regression)', () => {
    expect(hasDomainAnchor('mobilita palermo')).toBe(false);
    expect(hasDomainAnchor('salute roma')).toBe(false);
    expect(hasDomainAnchor('pensioni napoli centro')).toBe(false);
    expect(hasDomainAnchor('fiscale catania')).toBe(false);
    expect(hasDomainAnchor('lavoro torino')).toBe(false);
    expect(hasDomainAnchor('mobilita sostenibile bologna')).toBe(false);
  });

  it('REJECTS bare cluster words with no anchor', () => {
    expect(hasDomainAnchor('mobilita')).toBe(false);
    expect(hasDomainAnchor('salute')).toBe(false);
    expect(hasDomainAnchor('pensioni')).toBe(false);
    expect(hasDomainAnchor('fiscale')).toBe(false);
  });
});

describe('anchorSeed', () => {
  it('appends " frontalieri" to bare cluster words', () => {
    expect(anchorSeed('mobilita')).toBe('mobilita frontalieri');
    expect(anchorSeed('salute')).toBe('salute frontalieri');
    expect(anchorSeed('pensioni')).toBe('pensioni frontalieri');
  });

  it('is idempotent — already-anchored seeds pass through unchanged', () => {
    expect(anchorSeed('frontaliere')).toBe('frontaliere');
    expect(anchorSeed('permesso G')).toBe('permesso G');
    expect(anchorSeed('mobilita ticino')).toBe('mobilita ticino');
    expect(anchorSeed('LAMal')).toBe('LAMal');
  });

  it('handles empty/non-string input safely', () => {
    expect(anchorSeed('')).toBe('');
    expect(anchorSeed('   ')).toBe('');
    expect(anchorSeed(null as unknown as string)).toBe('');
    expect(anchorSeed(undefined as unknown as string)).toBe('');
  });

  it('trims surrounding whitespace before anchoring', () => {
    expect(anchorSeed('  mobilita  ')).toBe('mobilita frontalieri');
  });
});
