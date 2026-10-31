import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import {
  upsertCandidate,
  hasUntriedEmailDomainHint,
  isTraceRetryDue,
  reviveStaleNoCareersCandidates,
  reviveUnresolvedDomainCandidates,
} from '../scripts/lib/prospector/candidate-store.mjs';
import { emailDomainHintsByEmployer, employerEmailDomain } from '../scripts/lib/prospector/sources/seco-jobroom.mjs';
import { extractLinks, hasHomepageHiringSignal, isCareerLink } from '../scripts/lib/prospector/careers-trail.mjs';
import { resolveDomain } from '../scripts/lib/prospector/domain-resolve.mjs';
import { traceCandidate } from '../scripts/lib/prospector/trace-candidate.mjs';

const body = (text: string) => `<html><body><p>${text}</p></body></html>`;

describe('SECO application addresses as employer evidence', () => {
  it('keeps only the employer domain', () => {
    expect(employerEmailDomain('Mario.Rossi@info.salumeria-rossi.ch')).toBe('salumeria-rossi.ch');
  });

  it.each(['mario@bluewin.ch', 'mario@gmail.com', 'cv@jobs.ch', 'non-una-email', '', null])(
    'gives no identity for %s',
    (email) => expect(employerEmailDomain(email)).toBeNull(),
  );

  it('drops a domain shared by two employers as an agency', () => {
    const hints = emailDomainHintsByEmployer([
      { name: 'Alfa SA', emailDomains: ['agenzia.ch', 'alfa.ch'] },
      { name: 'Beta SA', emailDomains: ['agenzia.ch'] },
    ] as never);
    expect(hints.get('Alfa SA')).toEqual(['alfa.ch']);
    expect(hints.get('Beta SA')).toEqual([]);
  });

  it('wakes an exhausted name-only candidate exactly once per new hint', () => {
    const exhausted = {
      status: 'new', reason: 'dominio non risolto', traceAttempts: 9,
      traceRetryAt: '2099-01-01T00:00:00.000Z', emailDomainHints: ['alfa.ch'],
    };
    expect(hasUntriedEmailDomainHint(exhausted)).toBe(true);
    expect(isTraceRetryDue(exhausted)).toBe(true);
    const tried = { ...exhausted, emailDomainHintsTried: ['alfa.ch'] };
    expect(hasUntriedEmailDomainHint(tried)).toBe(false);
    expect(isTraceRetryDue(tried)).toBe(false);
  });
});

describe('email-domain hints across runs', () => {
  it('keeps earlier hints and prefers the newest when the cap is reached', () => {
    const store = { candidates: {}, rejectedTombstones: {}, candidateAliases: {} };
    const observe = (hints: string[]) => upsertCandidate(store as never, {
      name: 'Alfa SA', city: 'Lugano', canton: 'TI', country: 'CH', emailDomainHints: hints,
    }, 'seco');
    const { key } = observe(['a.ch', 'b.ch']);
    observe([]);
    observe(['c.ch', 'd.ch']);
    expect((store.candidates as never)[key as never]).toMatchObject({ emailDomainHints: ['b.ch', 'c.ch', 'd.ch'] });
  });
});

describe('email-domain hints in domain resolution', () => {
  beforeEach(() => politeFetch.mockReset());
  const page = (text: string) => ({
    ok: true, status: 200, url: 'https://www.sirio-care.ch/',
    body: `<html><title>Home</title><body>${text} ${'x '.repeat(300)}</body></html>`,
  });

  it('accepts a hinted domain whose page names the employer, without guessing', async () => {
    politeFetch.mockResolvedValue(page('Fondazione Sirio, Lugano, +41 91 000 00 00'));
    const result = await resolveDomain({ name: 'Fondazione Sirio', city: 'Lugano', domainHints: ['sirio-care.ch'] });
    expect(result.domain).toBe('sirio-care.ch');
    expect(result.evidence).toContain('email-domain');
    expect(politeFetch).toHaveBeenCalledTimes(1);
  });

  it('reports only the hints it actually tried', async () => {
    politeFetch.mockResolvedValue(page('Fondazione Sirio, Lugano, +41 91 000 00 00'));
    const result = await resolveDomain({
      name: 'Fondazione Sirio', city: 'Lugano', domainHints: ['first.ch', 'second.ch'],
    });
    expect(result.triedHints).toEqual(['first.ch']);
  });

  it('offers untried hints first on the next attempt', async () => {
    const resolveDomainStub = vi.fn(async () => ({ domain: null, retryable: false }));
    await traceCandidate({
      name: 'Fondazione Sirio', emailDomainHints: ['first.ch', 'second.ch'], emailDomainHintsTried: ['first.ch'],
    }, { resolveDomain: resolveDomainStub as never });
    expect(resolveDomainStub.mock.calls[0][0]).toMatchObject({ domainHints: ['second.ch', 'first.ch'] });
  });

  it('refuses a hinted agency site that matches only town and country', async () => {
    politeFetch.mockImplementation(async (url: string) => (String(url).includes('agenzia')
      ? page('Agenzia di collocamento a Lugano, Svizzera, +41')
      : { ok: false, status: 404, body: '' }));
    const result = await resolveDomain({ name: 'Polverini Spazzacamino', city: 'Lugano', domainHints: ['agenzia.ch'] });
    expect(result.domain).toBeNull();
  });
});

describe('domain verdicts older than the guesser', () => {
  const unresolved = (extra: Record<string, unknown>) => ({
    status: 'dead',
    reason: 'dominio non risolto',
    name: 'Rossi SA',
    traceLastAttemptAt: new Date(Date.parse('2026-10-31T00:00:00.000Z') - 86_400_000).toISOString(),
    ...extra,
  });

  it('gives them one more attempt, Ticino first, within the batch', () => {
    const store = { candidates: {
      zh: unresolved({ key: 'zh', canton: 'ZH' }),
      ti: unresolved({ key: 'ti', canton: 'TI' }),
    } };
    expect(reviveUnresolvedDomainCandidates(store as never, { limit: 1, ledgerFile: '/dev/null' })).toEqual(['ti']);
    expect(store.candidates.ti).toMatchObject({ status: 'new', traceRetryAt: null });
    expect(store.candidates.ti.reason).not.toBe('dominio non risolto');
    expect(store.candidates.zh.status).toBe('dead');
  });

  it('wakes a candidate parked by exhausted retries', () => {
    const parked = unresolved({ key: 'parked', status: 'new', canton: 'SG', traceAttempts: 4, traceRetryAt: new Date(Date.now() + 86_400_000).toISOString() });
    const store = { candidates: { parked } };
    reviveUnresolvedDomainCandidates(store as never, { ledgerFile: '/dev/null' });
    expect(isTraceRetryDue(parked)).toBe(true);
  });

  it('leaves alone a verdict the new guesser already gave and any found domain', () => {
    const store = { candidates: {
      fresh: unresolved({ key: 'fresh', traceLastAttemptAt: new Date(Date.now() + 1000).toISOString() }),
      found: unresolved({ key: 'found', domain: 'rossi.ch' }),
    } };
    expect(reviveUnresolvedDomainCandidates(store as never, { ledgerFile: '/dev/null' })).toEqual([]);
  });
});

describe('vacancies without a careers page', () => {
  it.each([
    'Cercasi gestore bistrot-bar',
    'Altre posizioni disponibili, inizia inviando la tua candidatura qui',
    'Cerchiamo APPRENDISTI per il prossimo anno',
    'Wir suchen eine Mitarbeiterin im Verkauf',
  ])('sees a vacancy in: %s', (text) => expect(hasHomepageHiringSignal(body(text))).toBe(true));

  it.each([
    'Cerchiamo soluzioni su misura per ogni cliente',
    'Aufladbares Mini-Hörgerät: Wir suchen Testhörer!',
    'Chi siamo, servizi e contatti',
    'Non ci sono posizioni aperte',
    'Cercasi casa in affitto',
  ])('sees no vacancy in: %s', (text) => expect(hasHomepageHiringSignal(body(text))).toBe(false));

  it('treats a link as careers only when it announces a real vacancy', () => {
    expect(isCareerLink({ url: 'https://x.ch/a', text: 'Cerchiamo soluzioni' })).toBe(false);
    expect(isCareerLink({ url: 'https://x.ch/a', text: 'Cercasi gestore bistrot-bar' })).toBe(true);
  });

  it('decodes entities in an href before following it', () => {
    const [link] = extractLinks('<a href="/job?a=1&amp;b=2">Offerte di lavoro</a>', 'https://x.ch/');
    expect(link.url).toBe('https://x.ch/job?a=1&b=2');
  });
});

describe('periodic recheck of "no careers page"', () => {
  it('dates the verdict and not the latest SECO sighting', () => {
    const at = Date.parse('2026-10-31T00:00:00.000Z');
    const daysAgo = (days: number) => new Date(at - days * 86_400_000).toISOString();
    const record = (key: string, days: number) => ({
      key, status: 'dead', reason: 'nessuna pagina carriere', domain: `${key}.ch`,
      noCareersVerdictAt: daysAgo(days), updatedAt: daysAgo(0),
    });
    const store = { candidates: { old: record('old', 61), recent: record('recent', 59) } };
    expect(reviveStaleNoCareersCandidates(store as never, { now: at, ledgerFile: '/dev/null' })).toEqual(['old']);
  });

  const now = Date.parse('2026-10-31T00:00:00.000Z');
  const dead = (canton: string, updatedAt: string, extra = {}) => ({
    status: 'dead', reason: 'nessuna pagina carriere', domain: `${canton.toLowerCase()}.ch`,
    canton, noCareersVerdictAt: updatedAt, ...extra,
  });

  it('returns stale verdicts Ticino first, within the batch, and leaves the rest', () => {
    const store = {
      candidates: {
        zh: { key: 'zh', ...dead('ZH', '2026-07-01T00:00:00.000Z') },
        ti: { key: 'ti', ...dead('TI', '2026-08-01T00:00:00.000Z') },
        fresh: { key: 'fresh', ...dead('BE', '2026-10-20T00:00:00.000Z') },
        other: { key: 'other', ...dead('GE', '2026-07-01T00:00:00.000Z'), reason: 'sito irraggiungibile' },
      },
    };
    expect(reviveStaleNoCareersCandidates(store as never, { now, limit: 1, ledgerFile: '/dev/null' })).toEqual(['ti']);
    expect(store.candidates.ti.status).toBe('new');
    expect(store.candidates.zh.status).toBe('dead');
    expect(store.candidates.fresh.status).toBe('dead');
    expect(store.candidates.other.status).toBe('dead');
  });
});
