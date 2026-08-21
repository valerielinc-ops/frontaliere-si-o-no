/**
 * The promotion gate — the only thing standing between a synthesised crawler
 * and production, now that no human looks at it.
 *
 * The validation stage answers "did this extraction match the employer's page
 * today". That is necessary and nowhere near sufficient for an unattended
 * promotion, because the ways a synthesised crawler goes wrong are mostly
 * ways it goes wrong LATER:
 *
 *   - a listing that renders differently between visits (A/B markup, a cookie
 *     wall on the second hit, a week with no vacancies) grades well once;
 *   - a template cluster that happened to catch a news archive grades well on
 *     titles and produces nonsense inventory;
 *   - an employer whose whole listing vanishes the day after we grade it.
 *
 * So the gate is not "score above threshold". It is a conjunction of
 * independent conditions, each of which has to hold, and one of them —
 * stability — cannot be satisfied by a single run at all: it needs two
 * gradings on two different days. A candidate that has only ever been graded
 * once is not rejected, it is simply not ready, and says so.
 *
 * Every rejection carries a reason, because with no human in the loop the
 * reasons ARE the audit trail.
 */

/** @typedef {{ passed: boolean, reasons: string[], checks: Record<string, boolean> }} GateResult */

export const GATE_DEFAULTS = {
  minScore: 0.9,
  minSampled: 3,
  minReachable: 1,
  minTitleMatch: 0.8,
  minContentful: 0.75,
  minDistinct: 0.8,
  minVacancies: 1,
  /** Two gradings, on two distinct days. */
  minRuns: 2,
  minDistinctDays: 2,
  /** A listing may shrink between runs, but not collapse. */
  minVacancyRetention: 0.5,
  /** How many may enter production in one run. */
  maxPerRun: 10,
};

/**
 * @param {any[]} history
 * @returns {number} distinct calendar days present
 */
function distinctDays(history) {
  return new Set(history.map((h) => String(h.at || '').slice(0, 10)).filter(Boolean)).size;
}

/**
 * Decide whether one candidate may enter production unattended.
 *
 * @param {Record<string, any>} candidate
 * @param {{ existingKeys?: Set<string> }} [ctx]
 * @param {Partial<typeof GATE_DEFAULTS>} [opts]
 * @returns {GateResult}
 */
export function evaluatePromotion(candidate, ctx = {}, opts = {}) {
  const g = { ...GATE_DEFAULTS, ...opts };
  const reasons = [];
  /** @type {Record<string, boolean>} */
  const checks = {};
  const mark = (name, ok, why) => { checks[name] = ok; if (!ok) reasons.push(why); return ok; };

  const history = Array.isArray(candidate.validationHistory) ? candidate.validationHistory : [];
  const good = history.filter((h) => h.verdict === 'good');
  const latest = history[history.length - 1] || {};

  // `promoting` significa che il candidato e' gia' dentro una PR di promozione
  // aperta. Riselezionarlo aprirebbe una SECONDA PR con gli stessi file, perche'
  // il passaggio a `production` vive sul branch della PR e non su main finche'
  // quella non merge — e il loop riparte ogni notte da main fresco.
  mark('status', candidate.status === 'promoted',
    candidate.status === 'promoting'
      ? `gia' in promozione nella PR ${candidate.promotionPr || '(aperta)'}`
      : `stato ${candidate.status}, atteso "promoted"`);

  mark('notAggregator', candidate.aggregator !== true,
    'e\' un aggregatore: porta inventario che hanno gia\' tutti');

  mark('hasCrawlerKey', Boolean(candidate.crawlerKey),
    'nessuna chiave crawler: la spec non e\' stata sintetizzata');

  mark('keyFree', !candidate.crawlerKey || !(ctx.existingKeys || new Set()).has(candidate.crawlerKey),
    `la chiave ${candidate.crawlerKey} esiste gia' in produzione`);

  mark('runs', good.length >= g.minRuns,
    `solo ${good.length} validazione/i buona/e su ${g.minRuns} richieste`);

  mark('days', distinctDays(good) >= g.minDistinctDays,
    `validato su ${distinctDays(good)} giorno/i distinto/i su ${g.minDistinctDays} richiesti`);

  mark('score', Number(latest.score || 0) >= g.minScore,
    `qualita' ${Number(latest.score || 0).toFixed(2)} sotto la soglia ${g.minScore}`);

  // Il campione richiesto non puo' superare gli annunci che il datore ha.
  // Con una soglia fissa a 3, un datore con 2 annunci non e' promuovibile MAI —
  // ed e' esattamente il segmento per cui il loop esiste, la micro-impresa che
  // pubblica una o due posizioni e che nessun altro indicizza. Per lei
  // giudicare 2 pagine su 2 e' copertura totale, piu' forte che campionarne 3
  // su 50: il requisito e' quindi «tutte, fino a minSampled».
  const vacancies = Number(latest.vacancyCount || 0);
  const needSample = Math.max(1, Math.min(g.minSampled, vacancies));
  mark('sampled', Number(latest.sampled || 0) >= needSample,
    `giudicato su ${latest.sampled || 0} pagine di dettaglio su ${vacancies} annunci, ne servono ${needSample}`);

  mark('reachable', Number(latest.reachableRate || 0) >= g.minReachable,
    'non tutti gli URL che pubblicheremmo risolvono');

  mark('titles', Number(latest.titleMatchRate || 0) >= g.minTitleMatch,
    `i titoli combaciano al ${Math.round(Number(latest.titleMatchRate || 0) * 100)}%, serve ${Math.round(g.minTitleMatch * 100)}%`);

  mark('contentful', Number(latest.contentfulRate || 0) >= g.minContentful,
    'troppe pagine di dettaglio senza prosa: probabile render lato client');

  mark('distinct', Number(latest.distinctRate || 0) >= g.minDistinct,
    'troppi titoli ripetuti nel listing');

  mark('vacancies', Number(latest.vacancyCount || 0) >= g.minVacancies,
    'nessun annuncio nell\'ultima validazione');

  // Stability of volume: the listing may shrink, it may not collapse. Compared
  // against the best run rather than the previous one, so a slow bleed over
  // several runs is caught too.
  const peak = Math.max(...good.map((h) => Number(h.vacancyCount || 0)), 0);
  const retention = peak > 0 ? Number(latest.vacancyCount || 0) / peak : 0;
  mark('retention', peak === 0 || retention >= g.minVacancyRetention,
    `gli annunci sono scesi al ${Math.round(retention * 100)}% del massimo osservato (${peak})`);

  return { passed: reasons.length === 0, reasons, checks };
}

/**
 * Rank and cap the promotable set.
 *
 * Ranked by vacancies, because the point of promoting a crawler is the
 * inventory it adds, and capped because an unattended pipeline that can add
 * ten crawlers a day is recoverable while one that can add four hundred is not.
 *
 * @param {Record<string, any>[]} candidates
 * @param {{ existingKeys?: Set<string> }} [ctx]
 * @param {Partial<typeof GATE_DEFAULTS>} [opts]
 * @returns {{ promotable: any[], blocked: { candidate: any, reasons: string[] }[], capped: number }}
 */
export function selectForPromotion(candidates, ctx = {}, opts = {}) {
  const g = { ...GATE_DEFAULTS, ...opts };
  const promotable = [];
  const blocked = [];
  for (const c of candidates) {
    const res = evaluatePromotion(c, ctx, opts);
    if (res.passed) promotable.push(c);
    else blocked.push({ candidate: c, reasons: res.reasons });
  }
  promotable.sort((a, b) => (b.vacancyCount || 0) - (a.vacancyCount || 0));
  const capped = Math.max(0, promotable.length - g.maxPerRun);
  return { promotable: promotable.slice(0, g.maxPerRun), blocked, capped };
}
