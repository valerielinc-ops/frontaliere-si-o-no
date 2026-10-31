import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import {
  hasUntriedEmailDomainHint,
  isTraceRetryDue,
  reviveStaleNoCareersCandidates,
} from '../scripts/lib/prospector/candidate-store.mjs';
import { emailDomainHintsByEmployer, employerEmailDomain } from '../scripts/lib/prospector/sources/seco-jobroom.mjs';
import { extractLinks, hasHomepageHiringSignal } from '../scripts/lib/prospector/careers-trail.mjs';
import { resolveDomain } from '../scripts/lib/prospector/domain-resolve.mjs';

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

  it('refuses a hinted agency site that matches only town and country', async () => {
    politeFetch.mockImplementation(async (url: string) => (String(url).includes('agenzia')
      ? page('Agenzia di collocamento a Lugano, Svizzera, +41')
      : { ok: false, status: 404, body: '' }));
    const result = await resolveDomain({ name: 'Polverini Spazzacamino', city: 'Lugano', domainHints: ['agenzia.ch'] });
    expect(result.domain).toBeNull();
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
  ])('sees no vacancy in: %s', (text) => expect(hasHomepageHiringSignal(body(text))).toBe(false));

  it('decodes entities in an href before following it', () => {
    const [link] = extractLinks('<a href="/job?a=1&amp;b=2">Offerte di lavoro</a>', 'https://x.ch/');
    expect(link.url).toBe('https://x.ch/job?a=1&b=2');
  });
});

describe('periodic recheck of "no careers page"', () => {
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  const dead = (canton: string, updatedAt: string, extra = {}) => ({
    status: 'dead', reason: 'nessuna pagina carriere', domain: `${canton.toLowerCase()}.ch`,
    canton, updatedAt, ...extra,
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
