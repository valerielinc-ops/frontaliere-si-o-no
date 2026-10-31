import { beforeEach, describe, expect, it, vi } from 'vitest';

const { politeFetch } = vi.hoisted(() => ({ politeFetch: vi.fn() }));

vi.mock('../scripts/lib/prospector/polite-fetch.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/prospector/polite-fetch.mjs')>()),
  politeFetch,
}));

import {
  domainGuesses,
  embeddedDomains,
  nameTokens,
  resolveDomain,
  verifyOwnership,
} from '../scripts/lib/prospector/domain-resolve.mjs';

const everyHostExists = async () => [{ address: '203.0.113.10', family: 4 }];
const dnsMissing = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });

/** Only these hosts exist on the fake network. */
const onlyHosts = (...hosts: string[]) => async (host: string) => {
  if (hosts.includes(host)) return [{ address: '203.0.113.10', family: 4 }];
  throw dnsMissing();
};

const page = (url: string, text: string) => ({
  ok: true,
  status: 200,
  url,
  body: `<html><head><title>${text}</title></head><body>${`${text}. `.repeat(30)}</body></html>`,
});

describe('Prospector domain resolution outcomes', () => {
  beforeEach(() => politeFetch.mockReset());

  it('distinguishes transient network failures from a complete unsuccessful guess set', async () => {
    let calls = 0;
    politeFetch.mockImplementation(async () => {
      calls++;
      return calls === 1
        ? { ok: false, status: 503, body: '' }
        : { ok: false, status: 404, body: '' };
    });

    await expect(resolveDomain({ name: 'Alpha Swiss Consulting' }, { lookupImpl: everyHostExists as never })).resolves.toMatchObject({
      domain: null,
      retryable: true,
      failureStatuses: expect.arrayContaining([503, 404]),
    });

    politeFetch.mockResolvedValue({ ok: false, status: 404, body: '' });
    await expect(resolveDomain({ name: 'Alpha Swiss Consulting' }, { lookupImpl: everyHostExists as never })).resolves.toMatchObject({
      domain: null,
      retryable: false,
      failureStatuses: expect.arrayContaining([404]),
    });
  });

  it('keeps failure metadata when an early guess has partial ownership evidence', async () => {
    let calls = 0;
    politeFetch.mockImplementation(async (url: string) => {
      calls++;
      return calls === 1
        ? {
          ok: true,
          status: 200,
          url: String(url),
          body: `<title>Careers</title><body>${'Alpha Swiss AG offers employment and services at 8001 Zürich, Switzerland. '.repeat(8)}</body>`,
        }
        : { ok: false, status: 503, body: '' };
    });

    await expect(resolveDomain({ name: 'Alpha Swiss AG', zip: '8001' }, { lookupImpl: everyHostExists as never })).resolves.toMatchObject({
      domain: expect.any(String),
      retryable: true,
      failureStatuses: expect.arrayContaining([503]),
    });
  });
});

describe('Prospector domain guesses', () => {
  it('reads the domain a legal name spells out', () => {
    expect(nameTokens('Iride.ch SA')).toEqual(['iride']);
    expect(domainGuesses('Iride.ch SA')[0]).toBe('iride.ch');
    expect(domainGuesses('Iride.ch SA')).not.toContain('iridech.ch');
    expect(embeddedDomains('BM Emplois Bonvin-Messerli SA (bm-emplois.ch)')).toEqual(['bm-emplois.ch']);
    expect(embeddedDomains('GETEC PARK.SWISS AG')).toEqual(['park.swiss']);
    expect(embeddedDomains('www.jugendhilfe-fokus.de')).toEqual(['jugendhilfe-fokus.de']);
  });

  it('does not take an abbreviation or a job board for a domain', () => {
    expect(embeddedDomains('St.Gallen Immobilien AG')).toEqual([]);
    expect(embeddedDomains('info@rossi.ch Sagl')).toEqual([]);
    expect(embeddedDomains('jobs.ch AG')).toEqual([]);
    expect(domainGuesses('jobs.ch AG')).not.toContain('jobs.ch');
  });

  it('spells an ampersand both ways', () => {
    const guesses = domainGuesses('Work & Work SA');
    expect(guesses).toEqual(expect.arrayContaining([
      'workwork.ch', 'work-work.ch', 'workandwork.ch', 'work-and-work.ch', 'workework.ch', 'work-e-work.ch',
    ]));
    expect(domainGuesses('Pane e Pomodoro')).toEqual(expect.arrayContaining(['pane-e-pomodoro.ch', 'panepomodoro.ch']));
  });

  it('keeps an article when it opens the name and never a preposition', () => {
    const guesses = domainGuesses('Fondazione La Motta, Istituto Socioterapeutico La Motta');
    expect(guesses).toEqual(expect.arrayContaining(['la-motta.ch', 'lamotta.ch', 'motta.ch']));
    expect(domainGuesses('Flexsis SA, succursale di Locarno')).not.toContain('di-locarno.ch');
  });

  it('builds n-grams of the trading name before the branch suffix', () => {
    expect(domainGuesses('Flexsis SA, succursale di Locarno')[0]).toBe('flexsis.ch');
    expect(domainGuesses('STUDIO RESPINI ARCHITETTI SAGL')).toEqual(expect.arrayContaining([
      'studiorespini.ch', 'respini-architetti.ch',
    ]));
    expect(domainGuesses('STUDIO RESPINI ARCHITETTI SAGL')).not.toContain('respini.ch');
  });

  it('offers every .ch guess before any .com guess', () => {
    const guesses = domainGuesses('Ristorante Ciani Lugano');
    expect(guesses.findLastIndex((domain) => domain.endsWith('.ch')))
      .toBeLessThan(guesses.findIndex((domain) => domain.endsWith('.com')));
  });
});

describe('Prospector domain verification', () => {
  beforeEach(() => { politeFetch.mockReset(); });

  it('spends no request on a domain DNS does not know', async () => {
    politeFetch.mockResolvedValue({ ok: false, status: 404, body: '' });
    const result = await resolveDomain({ name: 'Nulla Esiste SA' }, { lookupImpl: onlyHosts() as never });
    expect(politeFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ domain: null, tried: 0, retryable: false });
    expect(result.dnsAbsent).toBeGreaterThan(0);
  });

  it('keeps the probe budget for domains that exist, whatever their rank', async () => {
    const real = 'respini-architetti.ch';
    politeFetch.mockImplementation(async (url: string) => (String(url).includes(real)
      ? page(String(url), 'Respini Architetti, 6900 Lugano, Svizzera')
      : { ok: false, status: 404, body: '' }));
    const result = await resolveDomain(
      { name: 'STUDIO RESPINI ARCHITETTI SAGL', city: 'Lugano', zip: '6900' },
      { lookupImpl: onlyHosts(real) as never },
    );
    expect(result.domain).toBe(real);
    expect(result.tried).toBe(1);
  });

  it('reads a resolver failure as unknown, not as a missing domain', async () => {
    const lookupImpl = async () => { throw Object.assign(new Error('timeout'), { code: 'EAI_AGAIN' }); };
    const result = await resolveDomain({ name: 'Rete Giu SA' }, { lookupImpl: lookupImpl as never });
    expect(politeFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ domain: null, retryable: true });
  });

  it('allows the apex to redirect to www, and only to www', async () => {
    politeFetch.mockImplementation(async (url: string, opts: { urlPolicy: (raw: string) => Promise<string> }) => {
      await opts.urlPolicy('https://www.cianilugano.ch/');
      await expect(opts.urlPolicy('https://altrosito.ch/')).rejects.toThrow(/origin not allowed/);
      return page('https://www.cianilugano.ch/', 'Ristorante Ciani Lugano, 6900 Lugano, Svizzera');
    });
    const result = await resolveDomain(
      { name: 'Ristorante Ciani Lugano', city: 'Lugano', zip: '6900' },
      { lookupImpl: onlyHosts('cianilugano.ch') as never },
    );
    expect(result.domain).toBe('cianilugano.ch');
    expect(result.tried).toBe(1);
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it('reaches a site that only answers on www', async () => {
    politeFetch.mockImplementation(async (url: string) => page(String(url), 'BAUgest SA, 6705 Cresciano, Svizzera'));
    const result = await resolveDomain(
      { name: 'BAUgest SA', city: 'Cresciano', zip: '6705' },
      { lookupImpl: onlyHosts('www.baugest.ch') as never },
    );
    expect(politeFetch).toHaveBeenCalledWith('https://www.baugest.ch/', expect.anything());
    expect(result.domain).toBe('baugest.ch');
  });

  it('tries www when the apex fails and forgets the apex failure if www answers', async () => {
    politeFetch.mockImplementation(async (url: string) => (String(url).startsWith('https://www.')
      ? page(String(url), 'Altra azienda qualunque, Italia')
      : { ok: false, status: 503, body: '' }));
    const result = await resolveDomain(
      { name: 'BAUgest SA', city: 'Cresciano', zip: '6705' },
      { lookupImpl: onlyHosts('baugest.ch', 'www.baugest.ch') as never },
    );
    expect(result).toMatchObject({ domain: null, retryable: false });
  });

  it('shares one request budget across hinted and guessed domains', async () => {
    politeFetch.mockImplementation(async (url: string) => (String(url).startsWith('https://www.')
      ? { ok: true, status: 200, url: String(url), body: 'short' }
      : { ok: false, status: 404, body: '' }));
    const hints = ['a.ch', 'b.ch', 'c.ch', 'd.ch', 'e.ch', 'f.ch'];
    const result = await resolveDomain(
      { name: 'Rossi Costruzioni SA', domainHints: hints },
      { lookupImpl: everyHostExists as never },
    );
    expect(politeFetch.mock.calls.length).toBeLessThanOrEqual(10);
    expect(result.triedHints).toEqual(['a.ch', 'b.ch', 'c.ch', 'd.ch', 'e.ch']);
  });

  it.each([
    ['a guessed domain', { name: 'Ristorante Ciani Lugano', city: 'Lugano', zip: '6900' }],
    ['a hinted domain', { name: 'Ristorante Ciani Lugano', city: 'Lugano', zip: '6900', domainHints: ['cianilugano.ch'] }],
  ])('reads www when the apex of %s answers with a stub', async (_, employer) => {
    politeFetch.mockImplementation(async (url: string) => (String(url).startsWith('https://www.')
      ? page(String(url), 'Ristorante Ciani Lugano, 6900 Lugano, Svizzera')
      : { ok: true, status: 200, url: String(url), body: 'x'.repeat(399) }));
    const result = await resolveDomain(employer, {
      lookupImpl: onlyHosts('cianilugano.ch', 'www.cianilugano.ch') as never,
    });
    expect(result.domain).toBe('cianilugano.ch');
  });

  it('still refuses a page that names the employer without a second signal', async () => {
    politeFetch.mockImplementation(async (url: string) => page(String(url), 'Iride, il blog dei colori'));
    const result = await resolveDomain(
      { name: 'Iride Trasporti SA', city: 'Lugano', zip: '6900' },
      { lookupImpl: onlyHosts('iride.ch', 'iridetrasporti.ch') as never },
    );
    expect(result.domain).toBeNull();
  });

  it('accepts a domain the name spells out once the page names the employer', async () => {
    politeFetch.mockImplementation(async (url: string) => page(String(url), 'Iride, soluzioni digitali'));
    const result = await resolveDomain({ name: 'Iride.ch SA' }, { lookupImpl: onlyHosts() as never });
    expect(result.domain).toBe('iride.ch');
    expect(result.evidence).toContain('name-domain');
  });

  it('refuses a namesake that matches part of the name and no place', async () => {
    politeFetch.mockImplementation(async (url: string) => page(String(url), 'The International School, a Swiss education group'));
    const result = await resolveDomain(
      { name: 'GIS The International School of Lugano SA', city: 'Pazzallo', zip: '6912' },
      { lookupImpl: onlyHosts('international-school.ch') as never },
    );
    expect(result.domain).toBeNull();
  });

  it('refuses a domain that drops a word of the name when the page gives no place', async () => {
    politeFetch.mockImplementation(async (url: string) => page(String(url), 'TEAM Home, Marketing AG, Svizzera'));
    const result = await resolveDomain(
      { name: 'das team ag', city: 'Zürich', zip: '8001' },
      { lookupImpl: onlyHosts('team.ch') as never },
    );
    expect(result.domain).toBeNull();
  });

  it('accepts a one-word company on its own domain without a place', async () => {
    politeFetch.mockImplementation(async (url: string) => page(String(url), 'Orienta consulenza, Svizzera'));
    const result = await resolveDomain(
      { name: 'Orienta SA', city: 'Manno', zip: '6928' },
      { lookupImpl: onlyHosts('orienta.ch') as never },
    );
    expect(result.domain).toBe('orienta.ch');
  });

  it('does not read a short token inside a longer word', () => {
    const text = 'Il nostro servizio di consulenza in Svizzera e il nostro dazio doganale. '.repeat(5);
    expect(verifyOwnership(`<html><title>Servizio</title><body>${text}</body></html>`, { name: 'Zio Berse' }).evidence)
      .not.toContain('tokens:1/2');
  });

  it('no longer counts the TLD of an embedded domain as a name token', () => {
    const text = 'Una pagina qualunque che parla di tutt altro e contiene molte parole in Svizzera. '.repeat(5);
    expect(verifyOwnership(`<html><body>${text}</body></html>`, { name: 'Iride.ch SA' }).evidence)
      .not.toContain('tokens:1/2');
  });
});
