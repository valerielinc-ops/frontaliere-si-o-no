import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPoliteFetchStateForTests } from '../scripts/lib/prospector/polite-fetch.mjs';
import {
  buildZefixQuery,
  EMPLOYER_LEGAL_FORMS,
  loadZefixCursors,
  saveZefixCursors,
  sweepZefix,
  zefixExclusion,
} from '../scripts/lib/prospector/sources/zefix-lindas.mjs';

const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
const sleepImpl = async () => {};

function response(url: string, status: number, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    text: async () => body,
  } as any;
}

const row = (id: number, name: string, purpose = 'La gestione di un ristorante a Lugano.') => ({
  company: { value: `https://register.ld.admin.ch/zefix/company/${id}` },
  name: { value: name },
  purpose: { value: purpose },
  zip: { value: '6900' },
  city: { value: 'Lugano' },
});

/** A fake registry that answers each query from `rows` with the filters the query states. */
function registry(rows: ReturnType<typeof row>[], queries: string[] = []) {
  const id = (binding: ReturnType<typeof row>) => Number(binding.company.value.split('/').pop());
  return async (url: unknown, init?: RequestInit) => {
    const query = new URLSearchParams(String(init?.body)).get('query') || '';
    queries.push(query);
    const above = Number(/\?ehra > (\d+)/.exec(query)?.[1] ?? 0);
    const below = Number(/\?ehra < (\d+)/.exec(query)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const limit = Number(/LIMIT (\d+)/.exec(query)?.[1]);
    const ascending = /ORDER BY ASC/.test(query);
    const bindings = rows
      .filter((binding) => id(binding) > above && id(binding) < below)
      .sort((a, b) => (ascending ? id(a) - id(b) : id(b) - id(a)))
      .slice(0, limit);
    return response(String(url), 200, JSON.stringify({ results: { bindings } }));
  };
}

const sweepOptions = { lookupImpl, sleepImpl, pageSize: 2 };

describe('Zefix registry query', () => {
  it('reads a canton by BFS range and only forms that employ staff', () => {
    const query = buildZefixQuery({ canton: 'TI', limit: 10 });
    expect(query).toContain('?bfs >= 5001 && ?bfs <= 5399');
    expect(query).toContain('ORDER BY DESC(?ehra)');
    expect(query).toContain('LIMIT 10');
    expect(EMPLOYER_LEGAL_FORMS).not.toContain('0101');
    expect(EMPLOYER_LEGAL_FORMS).not.toContain('0109');
  });

  it('windows the backlog below the cursor and new entries above it', () => {
    expect(buildZefixQuery({ canton: 'TI', below: 900, limit: 10 })).toContain('FILTER(?ehra < 900)');
    const fresh = buildZefixQuery({ canton: 'TI', above: 900, ascending: true, limit: 10 });
    expect(fresh).toContain('FILTER(?ehra > 900)');
    expect(fresh).toContain('ORDER BY ASC(?ehra)');
  });
});

describe('Zefix employer filter', () => {
  it.each([
    ['Alvea SA', "L'acquisizione e la detenzione di partecipazioni in società", 'passive'],
    ['FRG Promotion SA', "La promozione immobiliare, l'acquisto e la vendita", 'passive'],
    ['Muster Holding AG', 'Halten von Beteiligungen', 'passive'],
    ['Rossi SA in liquidazione', 'La gestione di un ristorante', 'liquidation'],
    ['Cassa pensioni Rossi', 'Previdenza professionale del personale', 'pension'],
    ['Rossi SA', '', 'no-purpose'],
  ])('leaves out %s', (name, purpose, reason) => {
    expect(zefixExclusion({ name, purpose })).toBe(reason);
  });

  it('keeps an operating company even when its boilerplate mentions holdings', () => {
    const purpose = `La gestione di esercizi pubblici. ${'Altro testo. '.repeat(12)}La società può acquisire partecipazioni.`;
    expect(zefixExclusion({ name: 'Arcoch Sagl', purpose })).toBeNull();
  });
});

describe('Zefix sweep', () => {
  beforeEach(() => clearPoliteFetchStateForTests());

  it('stops at the budget and resumes on the next entry', async () => {
    const rows = [row(50, 'E Sagl'), row(40, 'D Sagl'), row(30, 'C Sagl'), row(20, 'B Sagl'), row(10, 'A Sagl')];
    const cursors = { cantons: {} as Record<string, any> };
    const accepted: string[] = [];
    const accept = (employer: { name: string }) => { accepted.push(employer.name); return true; };
    const options = { ...sweepOptions, cantons: ['TI'], cursors, accept, fetchImpl: registry(rows) as never };

    await expect(sweepZefix({ ...options, budget: 3 })).resolves.toMatchObject({ accepted: 3, outcome: 'complete' });
    expect(accepted).toEqual(['E Sagl', 'D Sagl', 'C Sagl']);
    expect(cursors.cantons.TI).toMatchObject({ highest: 50, lowest: 30, exhausted: false });

    await sweepZefix({ ...options, budget: 3 });
    expect(accepted).toEqual(['E Sagl', 'D Sagl', 'C Sagl', 'B Sagl', 'A Sagl']);
    expect(cursors.cantons.TI).toMatchObject({ lowest: 10, exhausted: true });
  });

  it('rereads a canton that answered empty on the first run', async () => {
    const cursors = { cantons: {} as Record<string, any> };
    const options = { ...sweepOptions, cantons: ['TI'], cursors, budget: 5, accept: () => true };

    await sweepZefix({ ...options, fetchImpl: registry([]) as never });
    expect(cursors.cantons.TI).toMatchObject({ highest: null, lowest: null, exhausted: false });

    const later = await sweepZefix({ ...options, fetchImpl: registry([row(7, 'Nuova Sagl')]) as never });
    expect(later.accepted).toBe(1);
    expect(cursors.cantons.TI.highest).toBe(7);
  });

  it('reads Ticino before any other canton, within the requested cantons', async () => {
    const queries: string[] = [];
    await sweepZefix({
      ...sweepOptions,
      cantons: ['ZH', 'TI'],
      budget: 50,
      cursors: { cantons: {} },
      accept: () => true,
      fetchImpl: registry([], queries) as never,
    });
    expect(queries[0]).toContain('?bfs >= 5001');
    expect(queries.at(-1)).toContain('?bfs >= 1 ');
  });

  it('takes a new registration before the backlog', async () => {
    const cursors = { cantons: { TI: { highest: 30, lowest: 20, exhausted: false } } };
    const accepted: string[] = [];
    await sweepZefix({
      ...sweepOptions,
      cantons: ['TI'],
      budget: 1,
      cursors,
      accept: (employer: { name: string }) => { accepted.push(employer.name); return true; },
      fetchImpl: registry([row(40, 'Nuova Sagl'), row(10, 'Vecchia Sagl')]) as never,
    });
    expect(accepted).toEqual(['Nuova Sagl']);
    expect(cursors.cantons.TI).toMatchObject({ highest: 40, lowest: 20 });
  });

  it('hands over identity only, never the purpose text', async () => {
    const seen: Record<string, unknown>[] = [];
    await sweepZefix({
      ...sweepOptions,
      cantons: ['TI'],
      budget: 1,
      cursors: { cantons: {} },
      accept: (employer: Record<string, unknown>) => { seen.push(employer); return true; },
      fetchImpl: registry([row(10, 'Arcoch Sagl')]) as never,
    });
    expect(seen).toEqual([{ zefixId: 10, name: 'Arcoch Sagl', city: 'Lugano', zip: '6900', canton: 'TI' }]);
  });

  it('moves past excluded and refused entries without spending the budget', async () => {
    const result = await sweepZefix({
      ...sweepOptions,
      cantons: ['TI'],
      budget: 1,
      cursors: { cantons: {} },
      accept: (employer: { name: string }) => employer.name !== 'Coperta Sagl',
      fetchImpl: registry([
        row(30, 'Coperta Sagl'),
        row(20, 'Alvea SA', 'La detenzione di partecipazioni'),
        row(10, 'Libera Sagl'),
      ]) as never,
    });
    expect(result).toMatchObject({ accepted: 1, recordsSeen: 3, excluded: { passive: 1 } });
  });

  it('leaves the cursor alone on an outage and reports it', async () => {
    const cursors = { cantons: {} as Record<string, any> };
    const result = await sweepZefix({
      ...sweepOptions,
      cantons: ['TI'],
      budget: 5,
      cursors,
      accept: () => true,
      fetchImpl: (async (url: unknown) => response(String(url), 400, 'nope')) as never,
    });
    expect(result).toMatchObject({ accepted: 0, outcome: 'unavailable', errorCode: 'http_400' });
    expect(cursors.cantons.TI).toMatchObject({ highest: null, lowest: null, exhausted: false });
  });

  it('keeps what it read when a later page fails', async () => {
    let calls = 0;
    const page = registry([row(30, 'C Sagl'), row(20, 'B Sagl'), row(10, 'A Sagl')]);
    const cursors = { cantons: {} as Record<string, any> };
    const result = await sweepZefix({
      ...sweepOptions,
      cantons: ['TI'],
      budget: 5,
      cursors,
      accept: () => true,
      fetchImpl: (async (url: unknown, init?: RequestInit) => (++calls === 1
        ? page(url, init)
        : response(String(url), 400, 'nope'))) as never,
    });
    expect(result).toMatchObject({ accepted: 2, outcome: 'partial', errorCode: 'http_400' });
    expect(cursors.cantons.TI.lowest).toBe(20);
  });

  it('calls a response without bindings malformed', async () => {
    const result = await sweepZefix({
      ...sweepOptions,
      cantons: ['TI'],
      budget: 5,
      cursors: { cantons: {} },
      accept: () => true,
      fetchImpl: (async (url: unknown) => response(String(url), 200, '{"head":{}}')) as never,
    });
    expect(result).toMatchObject({ outcome: 'malformed', errorCode: 'unexpected_payload' });
  });
});

describe('Zefix cursors', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zefix-cursors-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips and starts empty', () => {
    const file = path.join(dir, 'zefix-cursors.json');
    const state = loadZefixCursors(file);
    expect(state.cantons).toEqual({});
    (state.cantons as Record<string, unknown>).TI = { highest: 9, lowest: 3, exhausted: false };
    saveZefixCursors(state, file);
    expect(loadZefixCursors(file).cantons).toEqual({ TI: { highest: 9, lowest: 3, exhausted: false } });
  });

  it('refuses a corrupted file instead of restarting from zero', () => {
    const file = path.join(dir, 'zefix-cursors.json');
    fs.writeFileSync(file, '{"cantons":{"XX":{"highest":1,"lowest":1,"exhausted":false}}}');
    expect(() => loadZefixCursors(file)).toThrow(/Invalid Zefix cursor/);
    fs.writeFileSync(file, 'not json');
    expect(() => loadZefixCursors(file)).toThrow(/Malformed Zefix cursors/);
  });
});
