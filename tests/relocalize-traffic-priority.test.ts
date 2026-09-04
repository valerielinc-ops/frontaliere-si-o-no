import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESERVE_FOR_OLDEST,
  QUEUE_AGE_ALERT_DAYS,
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

  it('il preflight v2 accetta le fasce nuove — il suo controllo di chiavi e ESATTO', () => {
    // `validTrafficStats` in translation-shadow-preflight-v2.mjs confronta le
    // chiavi di `age.buckets` una per una. Una fascia aggiunta qui e non la'
    // non rompe niente di rumoroso: invalida OGNI osservazione del preflight,
    // in silenzio e a ogni run. Questo caso rende quel disallineamento rosso.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/translation-shadow-preflight-v2.mjs'), 'utf-8');
    const { stats } = buildTrafficPriority([job('x', daysAgo(1))], { x: 1 }, { now: NOW });
    for (const key of Object.keys(stats.age.buckets)) {
      expect(src, `il preflight v2 non conosce la fascia ${key}`).toContain(`'${key}'`);
    }
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
