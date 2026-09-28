/**
 * Pure detector for ad-revenue incidents, evaluated hourly on GA4 data
 * restricted to Italy + Switzerland (bot fleets from elsewhere inflate
 * sessions without ever requesting an ad: 2,000 sessions in 30 minutes from
 * Singapore on 2026-09-28, zero ads).
 *
 * Every signal is a RATIO of the same window, compared with the median of
 * the same hours on the same weekday 1, 2 and 3 weeks earlier: ratios survive
 * GA4's intraday lag (numerator and denominator arrive together) and weekday
 * matching absorbs the weekend and night shape.
 *
 * Backtest on 2026-09-07..28 (521 hourly runs, real GA4 data): three
 * episodes and no alarm on ordinary days. 2026-09-27 CMP suppression (#9974)
 * fires on consent at the 14h run (onset 12h), then fill and revenue;
 * 2026-09-09 18-22h (zero consent decisions, revenue -40%) fires at 21h;
 * 2026-09-12 23h a two-hour fill dip.
 *
 * The CLI is scripts/monitor-revenue-signals.mjs, the workflow
 * .github/workflows/revenue-signal-monitor.yml.
 */

/** @typedef {{ sessions?: number, pageViews?: number, impressions?: number, revenue?: number, ad_filled?: number, ad_consent_granted?: number, ad_consent_denied?: number }} HourCounts */

export const DEFAULT_CONFIG = Object.freeze({
  // Site events (page_view, ad_*) land in GA4 within ~1 h; the current hour and
  // the previous one are still partial, so the events window ends 2 h back.
  eventsWindow: { from: 3, to: 2 },
  // publisherAdImpressions / totalAdRevenue come from the AdSense link and keep
  // growing for ~3 h: read them only on settled hours.
  revenueWindow: { from: 6, to: 4 },
  baselineWeeks: [1, 2, 3],
  minBaselineWeeks: 2,
  minPageViews: 200,
  minRevenuePageViews: 300,
  thresholds: { consent: 0.4, fill: 0.35, revenue: 0.5, traffic: 0.5 },
  // Consecutive hourly runs a signal must stay below its threshold. Consent
  // fires at once (the 2026-09-27 CMP suppression: 0.02-0.22 of baseline, no
  // false alarm in three weeks); fill and revenue need two runs because the
  // slots per page change with layout and single hours dip.
  persistence: { consent: 1, fill: 2, revenue: 2, traffic: 2 },
  // The monitor closes its issue only after this many consecutive hourly runs
  // without an alarm: the backlog gets a day to verify the cause first.
  recoveryRuns: 24,
});

/** Fixed title: the dedup in scripts/lib/github-issue-creator.mjs keys on its first 60 characters. */
export const ISSUE_TITLE = 'Revenue ads: segnali orari sotto la baseline IT+CH';

export const SIGNALS = Object.freeze({
  consent: {
    label: 'Decisioni sul consenso CMP per sessione',
    window: 'eventsWindow',
    digits: 3,
    num: (c) => (c.ad_consent_granted || 0) + (c.ad_consent_denied || 0),
    den: (c) => c.sessions || 0,
  },
  fill: {
    label: 'Annunci riempiti (ad_filled) per page view',
    window: 'eventsWindow',
    digits: 3,
    num: (c) => c.ad_filled || 0,
    den: (c) => c.pageViews || 0,
  },
  revenue: {
    label: 'Revenue AdSense per 1.000 page view (€)',
    window: 'revenueWindow',
    digits: 2,
    num: (c) => (c.revenue || 0) * 1000,
    den: (c) => c.pageViews || 0,
  },
  traffic: {
    label: 'Page view IT+CH per ora',
    window: 'eventsWindow',
    digits: 0,
    num: (c) => c.pageViews || 0,
    den: () => 1,
  },
});

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYYMMDDHH' (GA4 dateHour, property time zone) → Date at that wall-clock hour, UTC-based. */
export function parseDateHour(key) {
  return new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(8, 10)));
}

export function formatDateHour(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}`;
}

/** The GA4 dateHour of `date` in the property time zone (Europe/Zurich). */
export function dateHourInZone(date, timeZone = 'Europe/Zurich') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}`;
}

export function shiftDateHour(key, hours) {
  return formatDateHour(new Date(parseDateHour(key).getTime() + hours * 3_600_000));
}

/** The dateHour keys of a window that ends `to` hours and starts `from` hours before `currentHour`. */
export function windowKeys(currentHour, { from, to }, weeksBack = 0) {
  const keys = [];
  for (let back = from; back >= to; back--) keys.push(shiftDateHour(currentHour, -back - weeksBack * 168));
  return keys;
}

function sumWindow(hours, keys, signal) {
  let num = 0;
  let den = 0;
  let pageViews = 0;
  for (const k of keys) {
    const c = hours[k] || {};
    num += signal.num(c);
    den += signal.den(c);
    pageViews += c.pageViews || 0;
  }
  return { num, den, pageViews, value: den > 0 ? num / den : null };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {{ hours: Record<string, HourCounts>, currentHour: string, config?: typeof DEFAULT_CONFIG }} input
 * `currentHour` is the hour the run happens in (still incomplete).
 * @returns {{ currentHour: string, alarms: object[], checks: object[] }}
 */
function checkSignal(hours, currentHour, name, config) {
  const signal = SIGNALS[name];
  const win = config[signal.window];
  const minPv = signal.window === 'revenueWindow' ? config.minRevenuePageViews : config.minPageViews;
  const keys = windowKeys(currentHour, win);
  const current = sumWindow(hours, keys, signal);
  const weeks = config.baselineWeeks
    .map((w) => sumWindow(hours, windowKeys(currentHour, win, w), signal))
    .filter((b) => b.value !== null && b.pageViews >= minPv);
  const check = { signal: name, label: signal.label, window: [keys[0], keys[keys.length - 1]], current: current.value, pageViews: current.pageViews, baselineWeeks: weeks.length };
  if (current.pageViews < minPv) return { ...check, status: 'low_volume' };
  if (weeks.length < config.minBaselineWeeks) return { ...check, status: 'no_baseline' };
  const baseline = median(weeks.map((b) => b.value));
  const ratio = baseline > 0 ? current.value / baseline : null;
  const threshold = config.thresholds[name];
  return { ...check, baseline, ratio, threshold, status: ratio !== null && ratio < threshold ? 'below' : 'ok' };
}

/**
 * @param {{ hours: Record<string, HourCounts>, currentHour: string, config?: typeof DEFAULT_CONFIG }} input
 * `currentHour` is the hour the run happens in (still incomplete).
 * A signal is an `alarm` when it is below its threshold in this run and in the
 * previous `persistence - 1` hourly runs, re-evaluated on the same data.
 * @returns {{ currentHour: string, alarms: object[], checks: object[] }}
 */
export function evaluateRevenueSignals({ hours, currentHour, config = DEFAULT_CONFIG }) {
  const checks = Object.keys(SIGNALS).map((name) => {
    const check = checkSignal(hours, currentHour, name, config);
    if (check.status !== 'below') return check;
    const runs = config.persistence?.[name] ?? 1;
    for (let back = 1; back < runs; back++) {
      if (checkSignal(hours, shiftDateHour(currentHour, -back), name, config).status !== 'below') return { ...check, status: 'below_once' };
    }
    return { ...check, status: 'alarm' };
  });
  return { currentHour, alarms: checks.filter((c) => c.status === 'alarm'), checks };
}

/**
 * What the hourly run should do with the issue:
 * - `alarm`: open it, or comment on the open one (dedup on ISSUE_TITLE);
 * - `watching`: no alarm now, but one in the last `recoveryRuns` runs: leave it;
 * - `recovered`: no alarm in the last `recoveryRuns` runs and at least one
 *   signal measured with enough volume: close it if open;
 * - `quiet`: nothing measurable (night volumes, missing baseline): do nothing.
 * Past runs are re-evaluated on the same data, so a skipped cron is not a gap.
 */
export function monitorDecision({ hours, currentHour, config = DEFAULT_CONFIG }) {
  const evaluation = evaluateRevenueSignals({ hours, currentHour, config });
  if (evaluation.alarms.length > 0) return { status: 'alarm', evaluation };
  const measured = (e) => e.checks.some((c) => c.status === 'ok' || c.status === 'below_once');
  let anyMeasured = measured(evaluation);
  for (let back = 1; back < config.recoveryRuns; back++) {
    const past = evaluateRevenueSignals({ hours, currentHour: shiftDateHour(currentHour, -back), config });
    if (past.alarms.length > 0) return { status: 'watching', evaluation, lastAlarmHour: past.currentHour };
    anyMeasured ||= measured(past);
  }
  return { status: anyMeasured ? 'recovered' : 'quiet', evaluation };
}

const HYPOTHESES = {
  consent: {
    cause:
      'il messaggio di consenso Funding Choices non raggiunge i nuovi visitatori: gate Offerwall (`index.html`, `FC_JOBBOARD_OFFERWALL_GATE_JS` e `OFFERWALL_FC_SNIPPET` in `build-plugins/constants.ts`), loader CDN o deploy parziale',
    check:
      '`node scripts/probe-live-consent-message.mjs` (un `fail` la conferma; serve Chromium completo, non chrome-headless-shell), poi `curl -s https://frontaliereticino.ch/commit-hash.txt` per sapere quale codice è online',
  },
  fill: {
    cause:
      'gli slot vengono richiesti ma restano vuoti: domanda AdSense, slot o layout cambiati, oppure i loader non chiedono gli annunci dopo il consenso (`BOT_GATE_FN` in `build-plugins/constants.ts`, `services/botPatterns.ts`)',
    check:
      'con i consensi normali, GA4 `ad_collapsed` e `ad_filled` per `pagePath` nelle stesse ore; su una pagina, clic su `.fc-cta-consent` e conteggio delle richieste `pagead/ads` (bloccale: nessuna impression)',
  },
  revenue: {
    cause: 'revenue per pagina crollata con fill normale: domanda o prezzi lato AdSense, oppure impression filtrate come non valide',
    check: '`node scripts/canary-rpm.mjs --json` (RPM e copertura richieste AdSense) e confronto GA4 fra `publisherAdImpressions` e `ad_filled` nelle stesse ore',
  },
  traffic: {
    cause: 'calo delle visite umane IT+CH: clic organici (SEO, indicizzazione) o sito irraggiungibile',
    check: 'Search Console `searchAnalytics` per ora (`dataState: HOURLY_ALL`) sulle stesse ore e `curl -sI https://frontaliereticino.ch/`',
  },
};

const fmtHour = (key) => `${key.slice(6, 8)}-${key.slice(4, 6)} ${key.slice(8, 10)}h`;
const fmtNum = (n, digits = 3) => (n === null || n === undefined ? '—' : Number(n).toFixed(digits));

/** Issue body in the bl-planner card shape (.claude/agents/bl-planner.md): the consumer is the backlog loop. */
export function buildIssueBody({ decision, runUrl = '' }) {
  const { evaluation } = decision;
  const alarms = evaluation.alarms;
  const worst = alarms.reduce((a, b) => (a && a.ratio <= b.ratio ? a : b), null);
  const replay = `node scripts/monitor-revenue-signals.mjs --current-hour=${evaluation.currentHour}`;
  const rows = evaluation.checks.map((c) => {
    const digits = SIGNALS[c.signal].digits;
    return `| ${c.label} | ${fmtHour(c.window[0])}–${fmtHour(c.window[1])} | ${fmtNum(c.current, digits)} | ${fmtNum(c.baseline, digits)} | ${fmtNum(c.ratio, 2)} | ${c.threshold ?? '—'} | ${c.status} |`;
  });
  return [
    '<!-- revenue-signal-monitor -->',
    `Run delle ${fmtHour(evaluation.currentHour)} (Europe/Zurich)${runUrl ? ` · ${runUrl}` : ''}. Dati GA4 solo Italia e Svizzera; baseline = mediana delle stesse ore, stesso giorno della settimana, 1-3 settimane prima.`,
    '',
    '| Segnale | Finestra | Valore | Baseline | Rapporto | Soglia | Stato |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    'SCHEDA: revenue-signal-monitor',
    `1-CAUSA: ipotesi da verificare, non accertata — ${alarms.map((a) => `${a.signal}: ${HYPOTHESES[a.signal].cause}`).join(' / ')}`,
    '2-FIX: da decidere dopo aver confermato la causa col comando della sua ipotesi | REPO: sito | MODE: non-nel-manifest',
    `3-METRICA: prima=${fmtNum(worst?.ratio, 2)} (${worst?.signal}, rapporto sulla baseline) atteso>=${worst?.threshold} | COMANDO: \`${replay}\``,
    // No workflow path here: check-workflows-scope.mjs reads the body to route the fixer.
    '4-OSSERVATORE: il workflow «Revenue signal monitor» (cron orario) — commenta a ogni run in allarme, chiude dopo 24 run consecutive senza allarme',
    `5-FALLIMENTO: "${ISSUE_TITLE}"`,
    '',
    '## Ipotesi e comandi che le confermano o le smentiscono',
    ...alarms.map((a) => `- **${a.signal}** (${fmtNum(a.ratio, 2)} della baseline): ${HYPOTHESES[a.signal].cause}. Verifica: ${HYPOTHESES[a.signal].check}.`),
    '',
    '## Suggested action',
    "- Verifica prima l'ipotesi del segnale peggiore col suo comando; se si conferma, i punti del codice sono `build-plugins/constants.ts` (gate Offerwall, loader AdSense e GPT, `BOT_GATE_FN`), `index.html` (gate inline della homepage), `services/botPatterns.ts`, `scripts/probe-live-consent-message.mjs`.",
    `- Riproduci la valutazione con \`${replay}\` (serve \`GOOGLE_APPLICATION_CREDENTIALS\`).`,
    '- Se GA4 non ha ancora elaborato la giornata, sessioni e canali possono risultare falsati; conteggi di eventi e page view restano affidabili.',
  ].join('\n');
}
