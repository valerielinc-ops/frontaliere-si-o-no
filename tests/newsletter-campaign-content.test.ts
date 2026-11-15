/**
 * Contenuto AI della newsletter congelato per campagna (perf-plan email senders, C4).
 * Nessuna rete, nessun LLM: la generazione e' una funzione finta con un contatore.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CAMPAIGN_CONTENT_COLLECTION,
  CAMPAIGN_CONTENT_SCHEMA,
  buildFactsFingerprint,
  buildFrozenDocument,
  contentDocId,
  createCampaignContentProvider,
  evaluateFrozenContent,
  isCompleteContent,
  probeFrozenContent,
  promptVersion,
  resolveFreezeMode,
  resolveRateThresholdPct,
  timeBoundMentions,
  trendBucket,
  weeklyChangePct,
} from '../scripts/lib/newsletter-campaign-content.mjs';
import { runProbe, writeOutput } from '../scripts/newsletter-content-probe.mjs';

const CAMPAIGN = 'weekly_2026-11-09';
const VARIANTS = ['curioso', 'diretto'];
const VERSION = 's1:abc123def456';
const DAY1 = new Date('2026-11-10T03:33:00Z');
const DAY3 = new Date('2026-11-12T03:33:00Z');

const ctxFor = (locale = 'it', overrides: Record<string, unknown> = {}) => ({
  locale,
  exchangeRate: { rate: 0.9400, previousRate: 0.9350 },
  exchangeInsight: { summary: 'Scenario neutro: mantieni strategia a tranche.' },
  weeklyFact: { text: 'Circa 79.000 frontalieri lavorano nel Canton Ticino.', source: 'USTAT' },
  featuredTool: { title: 'Simulatore netto', description: 'Calcola lo stipendio netto', toolUrl: '/calcolo-stipendio/' },
  ...overrides,
});

const GENERATED = {
  briefing: '<p>Il cambio e a <strong>0.9400</strong> questa settimana.</p>',
  subjects: { curioso: 'Cambio e lavoro: la settimana', diretto: 'Il tuo netto 2026' },
};

/** Firestore finto: una collection, un contatore di letture e scritture. */
function fakeDb(initial: Record<string, any> = {}, { failRead = false, failWrite = false } = {}) {
  const docs = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<{ id: string; data: any }> = [];
  return {
    docs, reads, writes,
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (failRead) throw new Error('UNAVAILABLE');
          reads.push(`${name}/${id}`);
          const data = docs.get(`${name}/${id}`);
          return { exists: Boolean(data), data: () => data };
        },
        set: async (data: any) => {
          if (failWrite) throw new Error('write refused');
          writes.push({ id: `${name}/${id}`, data });
          docs.set(`${name}/${id}`, data);
        },
      }),
    }),
  } as any;
}

function frozenDoc(locale = 'it', { content = GENERATED, ctx = ctxFor(locale), now = DAY1, campaignLocales = ['it'] } = {}) {
  return buildFrozenDocument({
    campaignId: CAMPAIGN, locale, variants: VARIANTS, content,
    facts: buildFactsFingerprint({ ...ctx, variants: VARIANTS, now }),
    promptVersion: VERSION, campaignLocales, now,
  });
}

function provider(db: any, extra: Record<string, unknown> = {}) {
  const generate = vi.fn(async () => GENERATED);
  const counts: Record<string, number> = {};
  const fn = createCampaignContentProvider({
    db, mode: 'on', persist: true, campaignId: CAMPAIGN, variants: VARIANTS, campaignLocales: ['it'],
    thresholdPct: 0.5, generate, version: VERSION, now: () => DAY3, log: () => {}, warn: () => {},
    metrics: { count: (name: string, n = 1) => { counts[name] = (counts[name] || 0) + n; } },
    ...extra,
  });
  return { fn, generate, counts };
}

describe('flag e soglia', () => {
  it('on e il default; solo off (o 0/false) e il kill switch', () => {
    expect(resolveFreezeMode(undefined)).toBe('on');
    expect(resolveFreezeMode('')).toBe('on');
    expect(resolveFreezeMode('on')).toBe('on');
    expect(resolveFreezeMode('garbage')).toBe('on');
    expect(resolveFreezeMode('off')).toBe('off');
    expect(resolveFreezeMode(' OFF ')).toBe('off');
    expect(resolveFreezeMode('0')).toBe('off');
  });

  it('la soglia ha default 0,5 e accetta solo numeri non negativi', () => {
    expect(resolveRateThresholdPct(undefined)).toBe(0.5);
    expect(resolveRateThresholdPct('abc')).toBe(0.5);
    expect(resolveRateThresholdPct('-1')).toBe(0.5);
    expect(resolveRateThresholdPct('0.25')).toBe(0.25);
    expect(resolveRateThresholdPct('0')).toBe(0);
  });

  it('la versione del prompt dipende dal modulo del prompt; senza modulo non c e versione', () => {
    const a = promptVersion({ readFile: () => Buffer.from('prompt A') });
    const b = promptVersion({ readFile: () => Buffer.from('prompt B') });
    expect(a).toMatch(/^s1:[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(promptVersion({ readFile: () => { throw new Error('ENOENT'); } })).toBeNull();
    expect(promptVersion()).toMatch(/^s1:[0-9a-f]{12}$/);
  });

  it('il documento sta in una collection senza trigger, con id campagna__lingua', () => {
    expect(CAMPAIGN_CONTENT_COLLECTION).toBe('newsletter_campaign_content');
    expect(CAMPAIGN_CONTENT_COLLECTION).not.toMatch(/^newsletter_subscribers/);
    expect(contentDocId('weekly_2026-11-09', 'de')).toBe('weekly_2026-11-09__de');
  });
});

describe('fatti e riferimenti temporali', () => {
  it('la variazione settimanale e il trend ricalcolano quelli del prompt', () => {
    expect(weeklyChangePct({ rate: 0.94, previousRate: 0.935 })).toBeCloseTo(0.5348, 3);
    expect(weeklyChangePct({ rate: 0.94, previousRate: null })).toBe(0);
    expect(trendBucket(0.3)).toBe('strengthening');
    expect(trendBucket(-0.3)).toBe('weakening');
    expect(trendBucket(0.1)).toBe('stable');
  });

  it('timeBoundMentions riconosce giorni, parole relative e date in quattro lingue', () => {
    expect(timeBoundMentions('Il cambio di <strong>oggi</strong> sale').day).toBe(true);
    expect(timeBoundMentions('Questo lunedì il franco').day).toBe(true);
    expect(timeBoundMentions('Heute steigt der Kurs').day).toBe(true);
    expect(timeBoundMentions("Aujourd'hui le franc monte").day).toBe(true);
    expect(timeBoundMentions('Mercredi le taux').day).toBe(true);
    expect(timeBoundMentions('On Tuesday the rate rose').day).toBe(true);
    expect(timeBoundMentions('Scadenza il 15 novembre').day).toBe(true);
    for (const dated of ['Scade il 15/11', 'Valido dal 15.11.2026', 'Aggiornato 2026-11-15', 'Entro il 15-11', 'Il 15.11 sale', 'Dal 5/11/26']) {
      expect(timeBoundMentions(dated).day, dated).toBe(true);
    }
    // Numbers that are not dates stay time-free: rates, percentages, counts, prices.
    for (const plain of ['Il cambio e a 0.9400', 'Sale del +1.2% in settimana', 'Circa 79.000 frontalieri', 'Fino a 7.258 CHF', 'Il 2.3% di disoccupati', 'Rate 0.94 vs 0.93']) {
      expect(timeBoundMentions(plain).day, plain).toBe(false);
    }
    expect(timeBoundMentions('Il cambio a novembre').month).toBe(true);
    expect(timeBoundMentions('Il cambio a novembre').day).toBe(false);
    expect(timeBoundMentions('Questa settimana il franco e stabile a 0.9400')).toEqual({ day: false, month: false });
    // Una parola dentro un'altra non e un riferimento: «domanda» non e «domani».
    expect(timeBoundMentions('Una domanda frequente sul cambio')).toEqual({ day: false, month: false });
  });

  it('un contenuto e completo solo con briefing e un oggetto per variante', () => {
    expect(isCompleteContent(GENERATED, VARIANTS)).toBe(true);
    expect(isCompleteContent({ ...GENERATED, briefing: null }, VARIANTS)).toBe(false);
    expect(isCompleteContent({ ...GENERATED, subjects: { curioso: 'x', diretto: null } }, VARIANTS)).toBe(false);
    expect(isCompleteContent(null, VARIANTS)).toBe(false);
  });
});

describe('evaluateFrozenContent: quando il congelato e ancora valido', () => {
  const facts = (overrides: Record<string, unknown> = {}, now = DAY3) =>
    buildFactsFingerprint({ ...ctxFor('it', overrides), variants: VARIANTS, now });
  const verdict = (doc: any, f = facts(), extra: Record<string, unknown> = {}) =>
    evaluateFrozenContent(doc, { campaignId: CAMPAIGN, locale: 'it', variants: VARIANTS, facts: f, promptVersion: VERSION, thresholdPct: 0.5, ...extra });

  it('valido: stessa campagna, lingua, versione, fatti e cambio entro soglia', () => {
    expect(verdict(frozenDoc())).toEqual({ usable: true, reason: 'ok' });
    // Un cambio che si e mosso di poco (0.9400 -> 0.9420 = 0,21%) resta entro soglia.
    expect(verdict(frozenDoc(), facts({ exchangeRate: { rate: 0.9420, previousRate: 0.9350 } })).usable).toBe(true);
  });

  it('cambio oltre soglia: rigenera', () => {
    const moved = facts({ exchangeRate: { rate: 0.9460, previousRate: 0.9350 } }); // +0,64%
    expect(verdict(frozenDoc(), moved)).toEqual({ usable: false, reason: 'rate-moved' });
    expect(verdict(frozenDoc(), moved, { thresholdPct: 1 }).usable).toBe(true);
  });

  it('variazione settimanale oltre soglia (stesso cambio): rigenera', () => {
    const shifted = facts({ exchangeRate: { rate: 0.9400, previousRate: 0.9300 } }); // weekly +1,08% vs +0,53%
    expect(verdict(frozenDoc(), shifted)).toEqual({ usable: false, reason: 'weekly-change-moved' });
  });

  it('versione del prompt diversa: rigenera', () => {
    expect(verdict(frozenDoc(), facts(), { promptVersion: 's1:otherversion' })).toEqual({ usable: false, reason: 'prompt-version' });
    expect(verdict(frozenDoc(), facts(), { promptVersion: null })).toEqual({ usable: false, reason: 'prompt-version-unknown' });
  });

  it('un fatto testuale cambiato (tool, fatto della settimana, scenario): rigenera', () => {
    expect(verdict(frozenDoc(), facts({ featuredTool: { title: 'Altro tool', description: 'x', toolUrl: '/x/' } })).reason).toBe('facts-changed');
    expect(verdict(frozenDoc(), facts({ weeklyFact: { text: 'Altro fatto', source: 'SECO' } })).reason).toBe('facts-changed');
    expect(verdict(frozenDoc(), facts({ exchangeInsight: { summary: 'Scenario debole: considera cambio a tranche.' } })).reason).toBe('facts-changed');
  });

  it('identita e forma: campagna, lingua, varianti, contenuto incompleto', () => {
    expect(verdict({ ...frozenDoc(), campaign_id: 'weekly_2026-11-02' }).reason).toBe('identity');
    expect(verdict({ ...frozenDoc(), locale: 'en' }).reason).toBe('identity');
    expect(verdict({ ...frozenDoc(), variant_ids: ['curioso'] }).reason).toBe('variants');
    expect(verdict({ ...frozenDoc(), subjects: { curioso: 'x' } }).reason).toBe('incomplete');
    expect(verdict({ ...frozenDoc(), schema: CAMPAIGN_CONTENT_SCHEMA + 1 }).reason).toBe('schema');
    expect(verdict(null).reason).toBe('missing');
  });

  it('un testo che cita «oggi» vale solo lo stesso giorno; senza riferimenti vale per la campagna', () => {
    const dayBound = frozenDoc('it', { content: { ...GENERATED, briefing: '<p>Oggi il cambio e 0.9400.</p>' } });
    expect(dayBound.time_bound.day).toBe(true);
    expect(verdict(dayBound, facts({}, DAY1)).usable).toBe(true);
    expect(verdict(dayBound, facts({}, DAY3))).toEqual({ usable: false, reason: 'day-bound' });

    const monthBound = frozenDoc('it', { content: { ...GENERATED, briefing: '<p>A novembre il cambio e stabile.</p>' } });
    expect(monthBound.time_bound).toEqual({ day: false, month: true });
    expect(verdict(monthBound, facts({}, DAY3)).usable).toBe(true);
    expect(verdict(monthBound, facts({}, new Date('2026-12-01T03:33:00Z'))).reason).toBe('month-bound');

    const free = frozenDoc();
    expect(free.time_bound).toEqual({ day: false, month: false });
    expect(verdict(free, facts({}, new Date('2026-11-15T03:33:00Z'))).usable).toBe(true);
  });

  it('un oggetto A/B che cita il giorno della settimana lega anche il contenuto al giorno', () => {
    const doc = frozenDoc('it', { content: { ...GENERATED, subjects: { curioso: '📰 mercoledì: cosa cambia', diretto: 'Il tuo netto' } } });
    expect(doc.time_bound.day).toBe(true);
    expect(verdict(doc, facts({}, DAY3)).reason).toBe('day-bound');
  });
});

describe('il fornitore del contenuto di una lingua', () => {
  it('congelato valido: 0 chiamate LLM e nessuna scrittura', async () => {
    const db = fakeDb({ [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc() });
    const { fn, generate, counts } = provider(db);
    const content = await fn(ctxFor('it'));
    expect(generate).not.toHaveBeenCalled();
    expect(content).toEqual(GENERATED);
    expect(db.writes).toEqual([]);
    expect(counts.aiContentFrozenReused).toBe(1);
  });

  it('prima run (nessun congelato): genera e salva come oggi, una sola scrittura per lingua', async () => {
    const db = fakeDb();
    const { fn, generate } = provider(db);
    const content = await fn(ctxFor('it'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(content).toEqual(GENERATED);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].id).toBe(`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`);
    expect(db.writes[0].data).toMatchObject({
      campaign_id: CAMPAIGN, locale: 'it', prompt_version: VERSION, variant_ids: VARIANTS, campaign_locales: ['it'],
      briefing: GENERATED.briefing, subjects: GENERATED.subjects,
    });
  });

  it('cambio oltre soglia: rigenera e aggiorna il congelato', async () => {
    const db = fakeDb({ [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc() });
    const { fn, generate } = provider(db);
    await fn(ctxFor('it', { exchangeRate: { rate: 0.9500, previousRate: 0.9350 } }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].data.facts.rate).toBe(0.95);
  });

  it('versione del prompt diversa: rigenera', async () => {
    const db = fakeDb({ [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc() });
    const { fn, generate, counts } = provider(db, { version: 's1:newprompt0000' });
    await fn(ctxFor('it'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(counts['aiContentGenerated.prompt-version']).toBe(1);
  });

  it('kill switch off: rigenera sempre, non legge e non scrive', async () => {
    const db = fakeDb({ [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc() });
    const { fn, generate } = provider(db, { mode: 'off' });
    await fn(ctxFor('it'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('dry run: legge il congelato ma non scrive nemmeno quando rigenera', async () => {
    const db = fakeDb({ [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc() });
    const reuse = provider(db, { persist: false });
    await reuse.fn(ctxFor('it'));
    expect(reuse.generate).not.toHaveBeenCalled();
    expect(db.reads).toHaveLength(1);

    const regen = provider(db, { persist: false });
    await regen.fn(ctxFor('it', { exchangeRate: { rate: 0.95, previousRate: 0.935 } }));
    expect(regen.generate).toHaveBeenCalledTimes(1);
    expect(db.writes).toEqual([]);
  });

  it('lettura fallita: genera come oggi (e salva se puo)', async () => {
    const db = fakeDb({}, { failRead: true });
    const { fn, generate, counts } = provider(db);
    const content = await fn(ctxFor('it'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(content).toEqual(GENERATED);
    expect(counts['aiContentGenerated.read-failed']).toBe(1);
  });

  it('scrittura fallita: il contenuto generato si usa comunque', async () => {
    const db = fakeDb({}, { failWrite: true });
    const { fn } = provider(db);
    await expect(fn(ctxFor('it'))).resolves.toEqual(GENERATED);
  });

  it('un contenuto incompleto non si congela', async () => {
    const db = fakeDb();
    const partial = { briefing: '<p>x</p>', subjects: { curioso: 'a', diretto: null } };
    const { fn } = provider(db, { generate: vi.fn(async () => partial) });
    await expect(fn(ctxFor('it'))).resolves.toEqual(partial);
    expect(db.writes).toEqual([]);
  });

  it('la rivalidazione con le funzioni di accettazione correnti puo scartare il congelato', async () => {
    const db = fakeDb({ [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc() });
    const { fn, generate, counts } = provider(db, { revalidate: () => null });
    await fn(ctxFor('it'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(counts['aiContentGenerated.revalidation-failed']).toBe(1);
  });

  it('senza db o senza versione del prompt il congelamento e inattivo', async () => {
    const noDb = provider(null);
    await noDb.fn(ctxFor('it'));
    expect(noDb.generate).toHaveBeenCalledTimes(1);
    const noVersion = provider(fakeDb(), { version: null });
    await noVersion.fn(ctxFor('it'));
    expect(noVersion.generate).toHaveBeenCalledTimes(1);
  });
});

describe('sonda del workflow: serve ancora un LLM?', () => {
  const stored = (locales: string[], now = DAY1) => Object.fromEntries(
    locales.map((l) => [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__${l}`, frozenDoc(l, { campaignLocales: locales, now })]),
  );
  // I fatti che il sender ha usato per congelare (ctxFor) e quelli «di oggi» che la sonda ricalcola.
  const factsFor = (over: Record<string, unknown> = {}) => async (locale: string) => {
    const { exchangeRate, exchangeInsight, weeklyFact, featuredTool } = ctxFor(locale, over) as any;
    return { exchangeRate, exchangeInsight, weeklyFact, featuredTool };
  };
  const probe = (db: any, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    probeFrozenContent({ db, campaignId: CAMPAIGN, variants: VARIANTS, thresholdPct: 0.5, promptVersion: VERSION, now: () => DAY3, factsFor: factsFor(over), ...extra });

  it('tutte le lingue necessarie congelate e valide con gli stessi fatti: nessun LLM, solo letture', async () => {
    const db = fakeDb(stored(['it', 'en']));
    await expect(probe(db)).resolves.toMatchObject({ needsLlm: false });
    expect(db.writes).toEqual([]);
    expect(db.reads.length).toBeLessThanOrEqual(4);
  });

  it('cambiando solo il fatto della settimana, la sonda chiede un LLM (stesso verdetto del sender)', async () => {
    const db = fakeDb(stored(['it']));
    await expect(probe(db, { weeklyFact: { text: 'Altro fatto', source: 'SECO' } })).resolves.toMatchObject({ needsLlm: true, reason: 'it:facts-changed' });
  });

  it('cambiando solo il tool in evidenza, la sonda chiede un LLM', async () => {
    const db = fakeDb(stored(['it']));
    await expect(probe(db, { featuredTool: { title: 'Altro tool', description: 'x', toolUrl: '/x/' } })).resolves.toMatchObject({ needsLlm: true, reason: 'it:facts-changed' });
  });

  it('cambiando solo la raccomandazione sul cambio (insight), la sonda chiede un LLM', async () => {
    const db = fakeDb(stored(['it']));
    await expect(probe(db, { exchangeInsight: { summary: 'Scenario debole: considera cambio a tranche.' } })).resolves.toMatchObject({ needsLlm: true });
  });

  it('sonda e sender concordano: stessi fatti e soglia piena, stesso verdetto di evaluateFrozenContent', async () => {
    const db = fakeDb(stored(['it']));
    const moved = { exchangeRate: { rate: 0.9425, previousRate: 0.9350 } }; // +0,27%: entro la soglia piena
    await expect(probe(db, moved)).resolves.toMatchObject({ needsLlm: false });
    await expect(probe(db, { exchangeRate: { rate: 0.9460, previousRate: 0.9350 } })).resolves.toMatchObject({ needsLlm: true, reason: 'it:rate-moved' });
  });

  it('nessun congelato, versione diversa o testo legato al giorno: serve LLM', async () => {
    await expect(probe(fakeDb({}))).resolves.toMatchObject({ needsLlm: true, reason: 'no-frozen-content' });
    await expect(probe(fakeDb(stored(['it'])), {}, { promptVersion: 's1:other' })).resolves.toMatchObject({ needsLlm: true });
    const dayBound = {
      [`${CAMPAIGN_CONTENT_COLLECTION}/${CAMPAIGN}__it`]: frozenDoc('it', { content: { ...GENERATED, briefing: '<p>Oggi il cambio sale.</p>' }, campaignLocales: ['it'] }),
    };
    await expect(probe(fakeDb(dayBound))).resolves.toMatchObject({ needsLlm: true });
  });

  it('un input non riproducibile (fatti assenti, cambio mancante, errore) e fail-closed: serve LLM', async () => {
    const db = fakeDb(stored(['it']));
    await expect(probe(db, {}, { factsFor: async () => null })).resolves.toMatchObject({ needsLlm: true, reason: 'facts-unavailable:it' });
    await expect(probe(db, {}, { factsFor: async () => ({ ...(await factsFor()('it')), exchangeRate: null }) })).resolves.toMatchObject({ needsLlm: true });
    await expect(probe(db, {}, { factsFor: async () => { throw new Error('boom'); } })).resolves.toMatchObject({ needsLlm: true });
    await expect(probe(fakeDb({}, { failRead: true }))).resolves.toMatchObject({ needsLlm: true });
    await expect(probe(null)).resolves.toMatchObject({ needsLlm: true, reason: 'inputs' });
    await expect(probe(fakeDb(), {}, { promptVersion: null })).resolves.toMatchObject({ needsLlm: true });
    await expect(probe(fakeDb(stored(['it'])), {}, { factsFor: undefined })).resolves.toMatchObject({ needsLlm: true, reason: 'inputs' });
  });
});

describe('script della sonda', () => {
  it('fuori da send, con il kill switch o su un errore risponde needs_llm=true', async () => {
    await expect(runProbe({ env: { MODE: 'test' }, getDb: async () => fakeDb() })).resolves.toMatchObject({ needsLlm: true, reason: 'mode:test' });
    await expect(runProbe({ env: {}, getDb: async () => fakeDb() })).resolves.toMatchObject({ needsLlm: true });
    await expect(runProbe({ env: { MODE: 'send', NEWSLETTER_CAMPAIGN_CONTENT_FREEZE: 'off' }, getDb: async () => fakeDb() }))
      .resolves.toMatchObject({ needsLlm: true, reason: 'freeze-off' });
    await expect(runProbe({ env: { MODE: 'send' }, getDb: async () => { throw new Error('no credentials'); } }))
      .resolves.toMatchObject({ needsLlm: true });
  });

  it('scrive needs_llm nel file di output di Actions', () => {
    const lines: string[] = [];
    writeOutput({ needsLlm: false, reason: 'all-frozen' }, { env: { GITHUB_OUTPUT: '/tmp/out' }, append: (_f: string, line: string) => lines.push(line), log: () => {} });
    writeOutput({ needsLlm: true, reason: 'x' }, { env: { GITHUB_OUTPUT: '/tmp/out' }, append: (_f: string, line: string) => lines.push(line), log: () => {} });
    expect(lines).toEqual(['needs_llm=false\n', 'needs_llm=true\n']);
  });
});
