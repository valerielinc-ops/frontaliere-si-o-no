import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESERVE_FOR_OLDEST,
  FRESH_WINDOW_MS,
  freshHeadCeiling,
  strideForReserve,
  QUEUE_AGE_ALERT_DAYS,
  QUEUE_AGE_BUCKET_KEYS,
  QUEUE_AGE_DISJOINT_BUCKET_KEYS,
  TRAFFIC_STATS_KEYS,
  TRAFFIC_SOURCE_PATH,
  assertTrafficPriorityUsable,
  buildTrafficPriority,
  formatPriorityReport,
  jobQueuedAtMs,
  jobTrafficScore,
  summarizeQueueAge,
} from '../scripts/lib/job-traffic-priority.mjs';

/**
 * L'OSSERVATORE del drenaggio della coda di ritraduzione (issue #5650,
 * piu' #5653 item 2 per l'eta').
 *
 * ─── Perche' un test e non una nota nel workflow ──────────────────────────
 *
 * Le tre cose che questa PR cambia sono tutte reversibili con una riga, e due
 * di esse tornerebbero indietro IN SILENZIO:
 *
 *   1. il tetto della cascata (100 → 900): abbassarlo e' una modifica di un
 *      carattere in un `||` dentro uno `env:`, e nessun gate lo guarda;
 *   2. la priorita' per traffico: se `data/job-popularity.json` si svuota — il
 *      workflow che lo scrive e' un cron giornaliero che puo' fallire — un
 *      ordinamento che degrada da solo continuerebbe a girare, verde, servendo
 *      la coda in ordine arbitrario. E' esattamente la forma del difetto che ha
 *      tenuto nascosto PostHog fermo per tre settimane in questo workspace;
 *   3. la riserva per i piu' vecchi: toglierla non rompe niente e non si vede,
 *      finche' fra sei mesi la coda ha una coda che non si smaltisce mai.
 *
 * Quindi il test non verifica «il codice compila»: verifica che il tetto sia
 * ancora almeno quello dichiarato, che l'ordinamento sia davvero funzione del
 * traffico, che una sorgente vuota LANCI invece di degradare, e che la metrica
 * di eta' diventi rumorosa quando la coda invecchia.
 *
 * ─── Cosa NON prova ───────────────────────────────────────────────────────
 *
 * Non prova che in produzione il drenaggio sia effettivamente salito: quello lo
 * dice `queueAge` nella history committata da log-translation-stats.mjs, run
 * dopo run. Un test non ha accesso a una run.
 *
 * ─── Nota sul worktree sparse ─────────────────────────────────────────────
 *
 * Nessun import qui tocca `data/` o `public/`, che in un worktree sparse non
 * esistono: `job-traffic-priority.mjs` e' puro per costruzione e i due file
 * letti da disco stanno sotto `.github/` e `scripts/`. Se un giorno questo test
 * diventasse rosso in locale e verde in CI, la causa e' quella.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Il pavimento del tetto della cascata.
 *
 * 900 = 90 min di finestra (JOBS_CASCADE_DEADLINE_MS) x 11,1 job/min misurati
 * sulla run 31766645401 del 2026-08-14, dove Phase 2b ha esaurito il suo tetto
 * di 100 job in 9,0 minuti. Il vincolo che ferma la cascata da qui in avanti e'
 * l'orologio, non questo numero.
 */
const CASCADE_CAP_FLOOR = 900;

/** Il cap di chiamate Haiku dichiarato nel workflow. Vedi il commento li'. */
const HAIKU_CALL_CAP_FLOOR = 300;

const workflowText = fs.readFileSync(
  path.join(ROOT, '.github/workflows/translate-pending.yml'), 'utf-8');

/** Un job sintetico. Solo i campi che l'ordinamento legge. */
function job(slug: string, firstSeenAt: string, extra: Record<string, unknown> = {}) {
  return { slug, firstSeenAt, needsRetranslation: true, ...extra };
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

describe('cascade cap (#5650) — il tetto non puo tornare giu in silenzio', () => {
  it('il default dello workflow_dispatch input e >= il pavimento dichiarato', () => {
    const block = workflowText.match(/max_jobs:\s*\n(?:\s+#.*\n)*\s+description:.*\n\s+default:\s*'(\d+)'/);
    expect(block, 'input max_jobs non trovato in translate-pending.yml').not.toBeNull();
    expect(Number(block![1])).toBeGreaterThanOrEqual(CASCADE_CAP_FLOOR);
  });

  it('il fallback usato dalle run SCHEDULATE e >= il pavimento dichiarato', () => {
    // Le run a cron non hanno `inputs`, quindi e' QUESTO numero — non il default
    // dell'input sopra — che decide il drenaggio ~7 volte al giorno. Sono due
    // valori distinti e uno solo dei due conta per il grosso del traffico: il
    // gate li guarda entrambi apposta.
    const m = workflowText.match(/INPUT_MAX_JOBS:\s*\$\{\{\s*inputs\.max_jobs\s*\|\|\s*'(\d+)'\s*\}\}/);
    expect(m, 'fallback INPUT_MAX_JOBS non trovato').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(CASCADE_CAP_FLOOR);
  });
});

describe('piu Haiku (#5650) — la preferenza e il suo cap restano dichiarati', () => {
  it('Phase 2b mette claude-cli/haiku in testa alla catena', () => {
    const m = workflowText.match(/AI_MODELS_PREFER:\s*(\S+)/);
    expect(m, 'AI_MODELS_PREFER assente: la catena torna al puro ordine per score, '
      + 'dove il tier a pagamento non viene MAI raggiunto (run 31690534255)').not.toBeNull();
    expect(m![1]).toContain('claude-cli/haiku');
  });

  it('il cap di chiamate Haiku e >= quello dimensionato sul tetto nuovo', () => {
    const m = workflowText.match(/CLAUDE_CLI_MAX_CALLS_PER_RUN:\s*'(\d+)'/);
    expect(m, 'CLAUDE_CLI_MAX_CALLS_PER_RUN assente: torna al default 25/run, '
      + 'che copre ~13% delle chiamate a tetto 900').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(HAIKU_CALL_CAP_FLOOR);
  });
});

describe('priorita per traffico — e davvero funzione del traffico', () => {
  const popularity = { 'hot': 500, 'warm': 50, 'cold': 0 };

  it('un job molto visto e vecchio batte un job nuovo e mai visto', () => {
    const pending = [
      job('cold', daysAgo(1)),   // nuovissimo, zero traffico
      job('hot', daysAgo(100)),  // vecchio, tantissimo traffico
    ];
    const { order } = buildTrafficPriority(pending, popularity, { now: NOW });
    expect(order[0].slug).toBe('hot');
  });

  it('l ordine e monotono nel traffico a parita di tutto il resto', () => {
    const pending = [job('cold', daysAgo(10)), job('warm', daysAgo(10)), job('hot', daysAgo(10))];
    const { order } = buildTrafficPriority(pending, popularity, { now: NOW });
    expect(order.map((j: any) => j.slug)).toEqual(['hot', 'warm', 'cold']);
  });

  it('il traffico si legge anche dagli slug localizzati, e si prende il MAX', () => {
    const j = { slug: 'nope', slugByLocale: { it: 'nope', de: 'hot' } };
    expect(jobTrafficScore(j, popularity)).toBe(500);
    // MAX, non somma: sommare gonfierebbe i job i cui slug localizzati sono
    // identici al sorgente (caso comune) rispetto a job davvero piu popolari.
    expect(jobTrafficScore({ slug: 'hot', slugByLocale: { de: 'hot' } }, popularity)).toBe(500);
  });

  it('l eta si legge da firstSeenAt, non da datePosted (2,2% di copertura)', () => {
    // Il campo che l ordinamento precedente usava e presente su 223 dei 10.192
    // job in coda. Se qualcuno rimettesse datePosted davanti, questo diventa rosso.
    const withBoth = { firstSeenAt: daysAgo(100), datePosted: daysAgo(1) };
    expect(jobQueuedAtMs(withBoth)).toBe(Date.parse(withBoth.firstSeenAt));
    expect(jobQueuedAtMs({ datePosted: daysAgo(1) })).toBe(Date.parse(daysAgo(1)));
    expect(Number.isNaN(jobQueuedAtMs({}))).toBe(true);
  });
});

describe('corsia freschezza (#18) — il vincolo delle 24 ore ha una corsia', () => {
  const popularity = { hot: 500, warm: 50 };

  it('e SPENTA per default: il cascade non deve cambiare ordinamento', () => {
    // Il modulo e' condiviso. Se il default fosse acceso, la corsia morderebbe
    // anche su relocalize-pending-jobs.mjs, che processa 53 job in 90 minuti:
    // 1.308 job freschi gli mangerebbero ogni slot di ogni run.
    const pending = [job('fresh', daysAgo(0.1)), job('hot', daysAgo(300), {})];
    const plain = buildTrafficPriority(pending, popularity, { now: NOW });
    expect(plain.order[0].slug).toBe('hot');
    expect(plain.stats.freshFirst).toBe(false);
    expect(plain.stats.freshHead).toBe(0);
  });

  it('accesa, ogni job sotto le 24 ore passa davanti — anche a uno molto visto', () => {
    const pending = [job('hot', daysAgo(300)), job('fresh', daysAgo(0.1))];
    const { order, stats } = buildTrafficPriority(pending, popularity, { now: NOW, freshFirst: true });
    expect(order[0].slug).toBe('fresh');
    expect(stats.freshHead).toBe(1);
  });

  it('la finestra e 24 ore esatte: a 25 ore il job non e piu fresco', () => {
    expect(FRESH_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    const pending = [job('hot', daysAgo(300)), job('old', daysAgo(25 / 24))];
    const { order, stats } = buildTrafficPriority(pending, popularity, { now: NOW, freshFirst: true });
    expect(stats.freshHead).toBe(0);
    expect(order[0].slug).toBe('hot');
  });

  it('un firstSeenAt nel FUTURO non e fresco: niente testa, ma resta in coda (#7363)', () => {
    // La corsia aveva il solo limite inferiore, quindi una data futura — skew
    // dell'orologio di un crawler, o un `postedDate` mal parsato — la
    // soddisfaceva a OGNI run, per sempre, e teneva quel job in testa finche'
    // restava pending. Non e' un job fresco: e' un job non databile.
    const pending = [
      job('futuro', new Date(NOW + 7 * DAY).toISOString()),
      ...Array.from({ length: 5 }, (_, i) => job(`v${i}`, daysAgo(100))),
    ];
    const { order, stats } = buildTrafficPriority(pending, {}, { now: NOW, freshFirst: true });
    expect(stats.freshHead).toBe(0);
    expect(stats.freshFuture).toBe(1);
    expect(order[0].slug).not.toBe('futuro');
    // Escluso dalla TESTA, non dalla CODA: nessun job va perso.
    expect(order).toHaveLength(6);
    expect(order.map((j: any) => j.slug).sort()).toEqual(['futuro', 'v0', 'v1', 'v2', 'v3', 'v4']);
    // E il report lo dice, altrimenti il difetto a monte resta muto.
    expect(formatPriorityReport(stats).join('\n')).toMatch(/1 skipped, dated in the FUTURE/);
  });

  it('il confine e ADESSO: un job di un secondo fa e fresco, uno fra un secondo no (#7363)', () => {
    const inside = buildTrafficPriority([job('ora', new Date(NOW - 1000).toISOString())], {},
      { now: NOW, freshFirst: true }).stats;
    expect(inside.freshHead).toBe(1);
    expect(inside.freshFuture).toBe(0);
    const outside = buildTrafficPriority([job('domani', new Date(NOW + 1000).toISOString())], {},
      { now: NOW, freshFirst: true }).stats;
    expect(outside.freshHead).toBe(0);
    expect(outside.freshFuture).toBe(1);
  });

  it('a corsia SPENTA il contatore dei futuri resta a zero (contratto validTrafficStats)', () => {
    // `validTrafficStats()` rifiuta uno stats con la corsia spenta e un
    // qualunque campo della corsia diverso da zero: il nuovo contatore deve
    // rispettare la stessa regola degli altri tre.
    const off = buildTrafficPriority([job('futuro', new Date(NOW + 7 * DAY).toISOString())], {},
      { now: NOW }).stats;
    expect(off.freshFirst).toBe(false);
    expect(off.freshFuture).toBe(0);
  });

  it('dentro la testa comanda il traffico', () => {
    const pending = [job('warm', daysAgo(0.1)), job('hot', daysAgo(0.9))];
    const { order } = buildTrafficPriority(pending, popularity, { now: NOW, freshFirst: true });
    expect(order.map((j: any) => j.slug)).toEqual(['hot', 'warm']);
  });

  it('la testa NON e una quota: consuma se stessa e restituisce tutto il resto', () => {
    // E' l'argomento per cui la corsia non ha un secondo numero da regolare.
    // La coorte fresca e' auto-limitata (~1.421 job/giorno contro un cap di
    // 6.000 per esecuzione), quindi finisce da sola e la coda resta intera.
    const fresh = Array.from({ length: 7 }, (_, i) => job(`f${i}`, daysAgo(0.5)));
    const rest = Array.from({ length: 20 }, (_, i) => job(`r${i}`, daysAgo(40)));
    const { order, stats } = buildTrafficPriority([...rest, ...fresh], {}, { now: NOW, freshFirst: true });
    expect(order).toHaveLength(27);
    expect(stats.freshHead).toBe(7);
    expect(order.slice(0, 7).every((j: any) => j.slug.startsWith('f'))).toBe(true);
    expect(new Set(order.map((j: any) => j.slug)).size).toBe(27);
  });

  it('la riserva oldest-first del resto NON viene spostata dalla testa', () => {
    // Lo stride contava gli slot su TUTTA la coda: contando anche la testa,
    // ogni slot di riserva slittava della sua dimensione e l'ordinamento del
    // resto cambiava in silenzio. Il resto deve uscire identico a com'era.
    const rest = [
      ...Array.from({ length: 12 }, (_, i) => job(`t${i}`, daysAgo(5), {})),
      job('ancient', daysAgo(400)),
    ];
    const pop = Object.fromEntries(rest.map((j, i) => [j.slug, j.slug === 'ancient' ? 0 : 100 - i]));
    const senza = buildTrafficPriority(rest, pop, { now: NOW });
    const con = buildTrafficPriority([job('fresh', daysAgo(0.2)), ...rest], pop, { now: NOW, freshFirst: true });
    expect(con.order[0].slug).toBe('fresh');
    expect(con.order.slice(1).map((j: any) => j.slug)).toEqual(senza.order.map((j: any) => j.slug));
  });

  it('un reset di massa di firstSeenAt NON azzera la riserva oldest-first', () => {
    // Il caso che il tetto esiste per coprire: re-crawl completo / rigenerazione
    // del dataset / backfill → l'INTERA coda diventa fresca e supera il cap del
    // chiamante. Senza tetto la testa e' il batch, lo stride non gira mai e la
    // riserva prende zero slot per tutto il passaggio.
    const cap = 20;
    const pending = [
      ...Array.from({ length: 60 }, (_, i) => job(`f${i}`, daysAgo(0.1))),
      job('ancient', daysAgo(400)),
    ];
    const { order, stats } = buildTrafficPriority(pending, {}, { now: NOW, cap, freshFirst: true });
    expect(stats.freshHead).toBe(freshHeadCeiling(cap, RESERVE_FOR_OLDEST));
    expect(stats.freshDeferred).toBe(60 - stats.freshHead);
    // Il job piu' vecchio della coda entra nel batch che il chiamante prende
    // davvero: e' la riserva oldest-first, che senza tetto sarebbe rimasta fuori.
    expect(order.slice(0, cap).some((j: any) => j.slug === 'ancient')).toBe(true);
    // Nessun job perso: i freschi tagliati tornano nello stride, non nel vuoto.
    expect(new Set(order.map((j: any) => j.slug)).size).toBe(61);
  });

  it('nel regime MISURATO il tetto non morde: coorte 1.308 contro il cap vero di 2.000', () => {
    // Il caso che ha bocciato la prima forma di questo tetto (review di #7358):
    // un tetto a meta' batch valeva 1.000 contro i 1.308 job freschi misurati
    // il 2026-09-04, quindi ne rimandava ~308 a OGNI run ordinaria — una
    // perdita netta sul vincolo delle 24 ore, pagata per evitare una starvation
    // che in quel regime non esisteva. Il tetto deve mordere SOLO nel caso
    // degenere per cui e' nato.
    const cap = 2000;                       // LOCAL_MT_MAX_JOBS di local-mt-mopup.mjs
    expect(freshHeadCeiling(cap, RESERVE_FOR_OLDEST)).toBe(1600);
    expect(freshHeadCeiling(cap, RESERVE_FOR_OLDEST)).toBeGreaterThan(1308);
  });

  it('il tetto lascia allo stride abbastanza slot perche la riserva peschi davvero', () => {
    // Non basta che il tetto sia < cap: gli slot che avanzano devono bastare per
    // almeno un periodo intero di stride, altrimenti la quota della riserva
    // arrotonda a zero pescate e il tetto garantisce solo a parole.
    for (const cap of [10, 20, 53, 100, 900, 2000, 6000]) {
      const left = cap - freshHeadCeiling(cap, RESERVE_FOR_OLDEST);
      expect(Math.floor(left / strideForReserve(RESERVE_FOR_OLDEST)),
        `cap ${cap}: la riserva non pesca nessuno slot`).toBeGreaterThanOrEqual(1);
    }
  });

  it('il tetto non morde quando la coorte sta dentro il tetto', () => {
    // La corsia resta identica a prima nel regime ordinario: il tetto e' una
    // rete per il caso degenere, non una quota che si paga tutti i giorni.
    const fresh = Array.from({ length: 7 }, (_, i) => job(`f${i}`, daysAgo(0.5)));
    const rest = Array.from({ length: 20 }, (_, i) => job(`r${i}`, daysAgo(40)));
    const { stats } = buildTrafficPriority([...rest, ...fresh], {}, { now: NOW, cap: 20, freshFirst: true });
    expect(stats.freshHead).toBe(7);
    expect(stats.freshDeferred).toBe(0);
  });

  it('senza cap dichiarato il chiamante prende tutta la coda, quindi nessuno muore di fame', () => {
    // `cap` di default = null → il tetto si misura sulla coda intera, che e' la
    // verita' per un chiamante che non affetta: tutti sono serviti comunque.
    const pending = Array.from({ length: 10 }, (_, i) => job(`f${i}`, daysAgo(0.1)));
    const { stats } = buildTrafficPriority(pending, {}, { now: NOW, freshFirst: true });
    expect(stats.freshHead).toBe(freshHeadCeiling(10, RESERVE_FOR_OLDEST));
    expect(stats.freshDeferred).toBe(10 - stats.freshHead);
  });

  it('un cap non dichiarabile e un errore, non un silenzioso ritorno a nessun tetto', () => {
    // NaN / 0 / negativo cadevano su `jobs.length` e portavano via il tetto con
    // se': la corsia sarebbe SEMBRATA limitata senza esserlo.
    for (const bad of [Number.NaN, 0, -5, 12.5, '2000', Infinity]) {
      expect(() => buildTrafficPriority([job('a', daysAgo(0.1))], {}, { now: NOW, freshFirst: true, cap: bad as any }),
        `cap ${String(bad)} accettato`).toThrow(/cap must be a positive integer/);
    }
  });

  it('il mop-up dichiara a buildTrafficPriority lo stesso cap con cui affetta', () => {
    // Un tetto calcolato su un cap che non e' quello vero non garantisce
    // niente: e' il numero passato che deve essere lo stesso dello slice.
    const mopup = fs.readFileSync(path.join(ROOT, 'scripts/local-mt-mopup.mjs'), 'utf-8');
    expect(mopup).toMatch(/buildTrafficPriority\([^;]*cap:\s*MAX_JOBS/s);
    expect(mopup).toMatch(/order\.slice\(0,\s*MAX_JOBS\)/);
  });

  it('il report dice sempre in che stato e la corsia', () => {
    const off = formatPriorityReport(buildTrafficPriority([job('a', daysAgo(3))], {}, { now: NOW }).stats).join('\n');
    expect(off).toContain('Freshness lane');
    expect(off).toContain('off');
    const on = formatPriorityReport(buildTrafficPriority([job('a', daysAgo(0.1))], {}, { now: NOW, freshFirst: true }).stats).join('\n');
    expect(on).toMatch(/Freshness lane:\s+1 job\(s\) ahead of the stride \(< 24h old\)/);
  });

  it('il mop-up gratuito la accende, il cascade a pagamento no', () => {
    // SCANSIONE DEL SORGENTE: i due call site sono in `main()`, non esportati.
    // E' l'asimmetria che il ticket decide, e senza questo caso tornerebbe
    // simmetrica con una riga.
    const mopup = fs.readFileSync(path.join(ROOT, 'scripts/local-mt-mopup.mjs'), 'utf-8');
    const cascade = fs.readFileSync(path.join(ROOT, 'scripts/relocalize-pending-jobs.mjs'), 'utf-8');
    expect(mopup).toMatch(/buildTrafficPriority\([^;]*freshFirst:\s*true/s);
    expect(cascade).not.toContain('freshFirst');
  });
});

describe('riserva per i piu vecchi — la coda non puo avere una coda immortale', () => {
  it('un job vecchissimo senza traffico entra comunque nel batch', () => {
    // 40 job giovani con traffico + 1 vecchio senza. Con l ordine per solo
    // traffico il vecchio sarebbe 41esimo su 41 per sempre.
    const pending = [
      ...Array.from({ length: 40 }, (_, i) => job(`t${i}`, daysAgo(1))),
      job('ancient', daysAgo(400)),
    ];
    const pop: Record<string, number> = {};
    for (let i = 0; i < 40; i++) pop[`t${i}`] = 100 - i;

    const { order } = buildTrafficPriority(pending, pop, { now: NOW });
    const rank = order.findIndex((j: any) => j.slug === 'ancient');
    expect(rank).toBeGreaterThanOrEqual(0);
    // Limite ASSOLUTO, non derivato da RESERVE_FOR_OLDEST: se la costante venisse
    // messa a 0 il limite derivato diventerebbe Infinity e questo caso passerebbe
    // proprio nella configurazione che deve bocciare. Con la riserva al 20% la
    // prima slot riservata e' l'indice 4; senza riserva il job finirebbe 41esimo.
    expect(rank).toBeLessThan(10);
  });

  it('la riserva e attiva nella configurazione spedita', () => {
    expect(RESERVE_FOR_OLDEST).toBeGreaterThan(0);
  });

  it('restituisce ogni job una volta sola — il cap non perde ne duplica lavoro', () => {
    const pending = Array.from({ length: 37 }, (_, i) => job(`s${i}`, daysAgo(i)));
    const pop = { s3: 10, s9: 99 };
    const { order } = buildTrafficPriority(pending, pop, { now: NOW });
    expect(order).toHaveLength(pending.length);
    expect(new Set(order.map((j: any) => j.slug)).size).toBe(pending.length);
  });
});

describe('sorgente di traffico vuota — LANCIA, non degrada in silenzio', () => {
  it('zero entry nella sorgente e un errore, non un ordinamento diverso', () => {
    const pending = [job('a', daysAgo(1)), job('b', daysAgo(2))];
    const { stats } = buildTrafficPriority(pending, {}, { now: NOW });
    expect(stats.trafficEntries).toBe(0);
    expect(() => assertTrafficPriorityUsable(stats)).toThrow(/traffic priority unusable/);
    expect(() => assertTrafficPriorityUsable(stats)).toThrow(new RegExp(TRAFFIC_SOURCE_PATH));
  });

  it('sorgente piena ma zero corrispondenze (drift degli slug) e un errore', () => {
    const pending = [job('a', daysAgo(1))];
    const { stats } = buildTrafficPriority(pending, { 'altro-schema': 10 }, { now: NOW });
    expect(stats.trafficEntries).toBe(1);
    expect(stats.matched).toBe(0);
    expect(() => assertTrafficPriorityUsable(stats)).toThrow(/NONE of the/);
  });

  it('la via di fuga esplicita esiste e ha un nome', () => {
    const { stats } = buildTrafficPriority([job('a', daysAgo(1))], {}, { now: NOW });
    expect(() => assertTrafficPriorityUsable(stats, { allowEmpty: true })).not.toThrow();
    // Se la via di fuga non e piu leggibile dallo script, il gate qui sopra
    // diventa una guardia che nessuno puo disattivare deliberatamente.
    const script = fs.readFileSync(path.join(ROOT, 'scripts/relocalize-pending-jobs.mjs'), 'utf-8');
    expect(script).toContain('RELOCALIZE_ALLOW_NO_TRAFFIC');
    expect(script).toContain('assertTrafficPriorityUsable');
  });

  it('coda vuota non e un guasto della sorgente', () => {
    const { stats } = buildTrafficPriority([], {}, { now: NOW });
    expect(() => assertTrafficPriorityUsable(stats)).not.toThrow();
  });
});

describe('eta della coda (#5653 item 2) — il conteggio da solo non basta', () => {
  it('misura il piu vecchio, i percentili e le fasce', () => {
    const jobs = [daysAgo(1), daysAgo(5), daysAgo(40), daysAgo(100), daysAgo(200)]
      .map((d, i) => job(`j${i}`, d));
    const a = summarizeQueueAge(jobs, { now: NOW });
    expect(a.count).toBe(5);
    expect(a.withTimestamp).toBe(5);
    expect(a.oldestAgeDays).toBe(200);
    expect(a.buckets).toEqual({
      '0-1d': 0, '1-2d': 1, '2-7d': 1,
      '0-7d': 2, '7-30d': 0, '30-90d': 1, '90-180d': 1, '180d+': 1,
    });
    expect(a.p90AgeDays).toBeGreaterThanOrEqual(a.p50AgeDays!);
  });

  it('le fasce fini suddividono 0-7d, non si aggiungono a essa', () => {
    // Il vincolo delle 24 ore della mappa e' invisibile a risoluzione di sette
    // giorni: il 2026-09-04 `0-7d` valeva 4.360 job, di cui 1.308 sotto le 24
    // ore. Ma `0-7d` RESTA, e resta la somma delle tre: le 200 righe gia'
    // committate in data/translation-stats-history.json si leggono su quella
    // chiave, e toglierla romperebbe la serie in silenzio.
    const jobs = [daysAgo(0.2), daysAgo(0.9), daysAgo(1.5), daysAgo(3), daysAgo(6.9), daysAgo(50)]
      .map((d, i) => job(`j${i}`, d));
    const a = summarizeQueueAge(jobs, { now: NOW });
    expect(a.buckets['0-1d']).toBe(2);
    expect(a.buckets['1-2d']).toBe(1);
    expect(a.buckets['2-7d']).toBe(2);
    expect(a.buckets['0-7d']).toBe(5);
    expect(a.buckets['0-1d'] + a.buckets['1-2d'] + a.buckets['2-7d']).toBe(a.buckets['0-7d']);
    // La somma di TUTTE le fasce non sovrapposte resta il totale datato.
    const disjoint = ['0-7d', '7-30d', '30-90d', '90-180d', '180d+'] as const;
    expect(disjoint.reduce((s, k) => s + a.buckets[k], 0)).toBe(a.withTimestamp);
  });

  it('i consumatori sommano le fasce DISGIUNTE, mai Object.values(buckets)', () => {
    // La rottura vera trovata in review: `validTrafficStats` e il ramo di
    // coerenza a ~L1668 di translation-shadow-preflight-v2.mjs pretendevano
    // che la somma di TUTTE le fasce facesse `withTimestamp`. Da quando
    // `0-1d`/`1-2d`/`2-7d` suddividono `0-7d` invece di affiancarla, quella
    // somma vale `withTimestamp + buckets['0-7d']`: bastava UN job fresco in
    // coda per invalidare ogni osservazione del preflight, in silenzio.
    const jobs = [daysAgo(0.5), daysAgo(3), daysAgo(20)].map((d, i) => job(`j${i}`, d));
    const a = summarizeQueueAge(jobs, { now: NOW });
    const all = Object.values(a.buckets).reduce((s, n) => s + n, 0);
    const disjoint = QUEUE_AGE_DISJOINT_BUCKET_KEYS.reduce((s, k) => s + a.buckets[k], 0);
    expect(disjoint).toBe(a.withTimestamp);
    // La differenza NON e' zero: e' esattamente il doppio conteggio di 0-7d.
    expect(all - disjoint).toBe(a.buckets['0-7d']);
    expect(all).not.toBe(a.withTimestamp);
  });

  it('le due liste di chiavi sono la sola fonte, e il produttore le rispetta', () => {
    // Ritipare le chiavi in un consumatore e' come il preflight si e' rotto in
    // due punti a 1.130 righe di distanza. Ora vengono da qui.
    const a = summarizeQueueAge([job('x', daysAgo(1))], { now: NOW });
    expect(Object.keys(a.buckets)).toEqual([...QUEUE_AGE_BUCKET_KEYS]);
    for (const k of QUEUE_AGE_DISJOINT_BUCKET_KEYS) expect(QUEUE_AGE_BUCKET_KEYS).toContain(k);
  });

  it('le chiavi di stats sono dichiarate dal produttore e il preflight le importa', () => {
    // Stesso difetto delle fasce, un livello piu' su: `validTrafficStats` fa un
    // controllo ESATTO anche sull'oggetto `stats`. I tre campi della corsia
    // freschezza (#18) l'avrebbero invalidato in silenzio se fossero stati
    // aggiunti solo qui.
    const { stats } = buildTrafficPriority([job('x', daysAgo(1))], { x: 1 }, { now: NOW });
    expect(Object.keys(stats).sort()).toEqual([...TRAFFIC_STATS_KEYS].sort());
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/translation-shadow-preflight-v2.mjs'), 'utf-8');
    expect(src).toContain('exactKeys(stats, TRAFFIC_STATS_KEYS)');
  });

  it('il preflight v2 IMPORTA le chiavi invece di ritiparle', () => {
    // Il controllo di chiavi del preflight e' ESATTO e il suo ramo di coerenza
    // somma le fasce: entrambi si erano rotti perche' le chiavi erano scritte
    // a mano, in due punti a 1.130 righe di distanza. La difesa non e' un
    // elenco duplicato qui, e' che il consumatore non abbia piu' un elenco.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/translation-shadow-preflight-v2.mjs'), 'utf-8');
    expect(src).toMatch(/import \{[^}]*QUEUE_AGE_BUCKET_KEYS[^}]*\} from '\.\/job-traffic-priority\.mjs'/s);
    expect(src).toContain('QUEUE_AGE_DISJOINT_BUCKET_KEYS.reduce');
    // Nessuna fascia ritipata come letterale nel CODICE del consumatore. I
    // commenti possono nominarle: e' proprio li' che si spiega perche' la
    // somma di tutte le fasce sia sbagliata.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const key of QUEUE_AGE_BUCKET_KEYS) expect(code).not.toContain(`'${key}'`);
    // E soprattutto: mai piu' la somma di TUTTE le fasce contro withTimestamp.
    expect(src).not.toMatch(/Object\.values\([^)]*buckets\)\.reduce/);
  });

  it('un job oltre la soglia alza l ALLARME, e il report lo dice a parole', () => {
    // La mutazione naturale della metrica di eta: un job piu vecchio della
    // soglia DEVE produrre un rosso, non una riga in piu in un log.
    const jobs = [job('fresh', daysAgo(2)), job('stale', daysAgo(QUEUE_AGE_ALERT_DAYS + 1))];
    const a = summarizeQueueAge(jobs, { now: NOW });
    expect(a.alert).toBe(true);

    const { stats } = buildTrafficPriority(jobs, { fresh: 1 }, { now: NOW });
    expect(stats.age.alert).toBe(true);
    expect(formatPriorityReport(stats).join('\n')).toContain('QUEUE AGE ALERT');
  });

  it('sotto soglia non allarma — la soglia e un ratchet, non un rumore di fondo', () => {
    // 123,2 giorni era il massimo misurato sulla coda viva il 2026-08-14: la
    // soglia sta sopra apposta, cosi l allarme significa «la coda e piu vecchia
    // di quanto sia mai stata», non «la coda esiste».
    const a = summarizeQueueAge([job('x', daysAgo(123.2))], { now: NOW });
    expect(a.alert).toBe(false);
    expect(QUEUE_AGE_ALERT_DAYS).toBeGreaterThan(123.2);
  });

  it('un job senza alcun timestamp e contato ma non datato — mai stimato', () => {
    const a = summarizeQueueAge([{ slug: 'nodate' }, job('ok', daysAgo(10))], { now: NOW });
    expect(a.count).toBe(2);
    expect(a.withTimestamp).toBe(1);
  });

  it('la history committata e il log trasportano queueAge, non solo il conteggio', () => {
    // SCANSIONE DEL SORGENTE, non import — e non e' pigrizia.
    // `log-translation-stats.mjs` importa `isIncomplete` da
    // relocalize-pending-jobs.mjs, che a module-scope tira dentro
    // dedicated-crawler-common → structured-salary → swiss-canton-salary, che
    // legge un file sotto `data/`. In un worktree sparse `data/` non esiste:
    // importarlo qui renderebbe questo test rosso in locale e verde in CI —
    // la trappola descritta in CLAUDE.md, che vale la pena non ricreare
    // proprio dentro l'osservatore. Il COMPORTAMENTO di summarizeQueueAge e'
    // gia' coperto funzionalmente dai casi qui sopra; questo caso copre solo
    // il CABLAGGIO, che e' l'unica cosa che l'import avrebbe aggiunto.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/log-translation-stats.mjs'), 'utf-8');
    expect(src, 'log-translation-stats non importa piu la metrica di eta')
      .toMatch(/import\s*\{[^}]*summarizeQueueAge[^}]*\}\s*from\s*'\.\/lib\/job-traffic-priority\.mjs'/);
    // La entry committata in data/translation-stats-history.json deve portarla.
    expect(src).toMatch(/const queueAge = summarizeQueueAge\(/);
    expect(src).toMatch(/^\s*queueAge,\s*$/m);
    // E il log della run deve dirlo a parole quando scatta.
    expect(src).toContain('QUEUE AGE ALERT');
    // I campioni devono essere raccolti sui job FLAGGATI, non su tutti.
    expect(src).toMatch(/if \(flagged\) \{[\s\S]{0,400}?queuedSamples\.push\(/);
  });
});
