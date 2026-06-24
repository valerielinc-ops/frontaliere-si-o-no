#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpFetchWithRetry } from './lib/transient-fetch.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const SOURCE_URL = 'https://www.arbeit.swiss/secoalv/it/home.html';
const OUT_FILE = path.resolve(process.cwd(), 'public/data/switzerland-unemployment-rate.json');

const MONTHS = new Map([
  ['gennaio', '01'],
  ['febbraio', '02'],
  ['marzo', '03'],
  ['aprile', '04'],
  ['maggio', '05'],
  ['giugno', '06'],
  ['luglio', '07'],
  ['agosto', '08'],
  ['settembre', '09'],
  ['ottobre', '10'],
  ['novembre', '11'],
  ['dicembre', '12'],
  ['january', '01'],
  ['february', '02'],
  ['march', '03'],
  ['april', '04'],
  ['may', '05'],
  ['june', '06'],
  ['july', '07'],
  ['august', '08'],
  ['september', '09'],
  ['october', '10'],
  ['november', '11'],
  ['december', '12'],
  ['januar', '01'],
  ['februar', '02'],
  ['marz', '03'],
  ['april', '04'],
  ['mai', '05'],
  ['juni', '06'],
  ['juli', '07'],
  ['august', '08'],
  ['september', '09'],
  ['oktober', '10'],
  ['november', '11'],
  ['dezember', '12'],
  ['janvier', '01'],
  ['fevrier', '02'],
  ['mars', '03'],
  ['avril', '04'],
  ['mai', '05'],
  ['juin', '06'],
  ['juillet', '07'],
  ['aout', '08'],
  ['septembre', '09'],
  ['octobre', '10'],
  ['novembre', '11'],
  ['decembre', '12'],
]);

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMonth(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractPeriod(text) {
  const normalized = normalizeMonth(text);
  const monthRegex = new RegExp(`\\b(${Array.from(MONTHS.keys()).join('|')})\\s+(20\\d{2})\\b`, 'i');
  const m = normalized.match(monthRegex);
  if (!m) return null;
  const mm = MONTHS.get(m[1].toLowerCase());
  if (!mm) return null;
  return `${m[2]}-${mm}`;
}

// Plausible registered-unemployment band for Switzerland (historic min ~1.7%,
// COVID peak ~3.7%). Anything outside 0–15% is almost certainly a mis-parse
// (a count, a delta, a year) rather than a rate.
function isPlausibleRate(n) {
  return Number.isFinite(n) && n >= 0 && n <= 15;
}

// Shared rate-phrase alternation (IT/EN/DE/FR). Stateless (no `g` flag) so it is
// safe to reuse across extractRate / findReleaseHref without lastIndex carryover.
const RATE_PHRASE_RE = /tasso di disoccupazione|unemployment rate|arbeitslosenquote|taux de ch[oô]mage/i;

function extractRate(text) {
  const pm = RATE_PHRASE_RE.exec(text);
  if (!pm) return null;
  // Anchor on the rate RESULT, not the first figure after the phrase. When the
  // rate MOVES, SECO writes two percentages in one sentence — e.g. "…è salito
  // dal 2,9% al 3,0%" / "…rose from 2.9% to 3.0%" — where the FIRST figure is the
  // PREVIOUS month's rate. Take the LAST plausible "N,N%" in the same sentence;
  // on an unchanged month ("…invariato al 3,0%") there is only one figure.
  const window = text.slice(pm.index + pm[0].length, pm.index + pm[0].length + 180);
  const figRe = /([0-9]+(?:[.,][0-9]+)?)\s*%/g;
  let last = null;
  let fm;
  // eslint-disable-next-line no-cond-assign
  while ((fm = figRe.exec(window)) !== null) {
    const n = Number.parseFloat(fm[1].replace(',', '.'));
    if (isPlausibleRate(n)) last = n;
  }
  return last;
}

function absolutize(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return new URL(url, SOURCE_URL).toString();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolve the canonical SECO labour-market press-release URL for the WINNING rate
// sentence. On the current arbeit.swiss (Nuxt SPA) the release link lives in the
// embedded JSON as the value IMMEDIATELY following the rate sentence, e.g.
//   "…disoccupazione è rimasto invariato al 3,0%.","https://www.admin.ch/it/newnsb/…"
function findReleaseHref(html, rateSentence) {
  const adminRe = /^https?:\/\/www\.admin\.ch\//;
  const localRe = /^https?:\/\/www\.arbeit\.swiss\/[a-zA-Z0-9/_.-]*(?:comunicat|press|medien|communiqu|news)/i;

  // Bind to the SAME occurrence that produced the winning rate/period — NOT the
  // first rate-phrase prefix anywhere in the doc (#1732 review #1: the page
  // carries several rate sentences — multiple teasers each with their OWN
  // admin.ch link, plus an unrelated "alto tasso di disoccupazione" professions
  // block — so a loose "first admin within N chars" scan could cite an unrelated
  // teaser's link; with two teasers the rendered-HTML copy of the winner even
  // picked up the EARLIER teaser's JSON link). We require the link to be the JSON
  // value DIRECTLY after the winning sentence: rate phrase + the RESULT figure
  // (last "N,N%"), then the sentence's closing `."` and the JSON `,"URL"`. The
  // gap class `[^.;"<>]*?` may cross an earlier in-sentence percentage (the
  // previous-month figure of a changed-month "…dal 2,9% al 3,0%") to reach the
  // result, but stops at the sentence terminator before the next teaser. The
  // adjacency requirement makes the rendered-HTML copy (no quoted URL after it)
  // non-matching, so only the JSON copy of the winner can bind.
  const resultFig = [...rateSentence.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*%/g)].pop();
  if (resultFig) {
    const figRx = resultFig[1].replace(/[.,]/g, '[.,]');
    const anchorRe = new RegExp(
      `(?:${RATE_PHRASE_RE.source})[^.;"<>]*?${figRx}\\s*%[.\\s]*"\\s*,\\s*"(https?:\\/\\/[^"]+)"`,
      'gi',
    );
    let m;
    let localHit = '';
    // eslint-disable-next-line no-cond-assign
    while ((m = anchorRe.exec(html)) !== null) {
      const url = m[1];
      if (adminRe.test(url)) return url;
      if (!localHit && localRe.test(url)) localHit = absolutize(url);
      if (anchorRe.lastIndex === m.index) anchorRe.lastIndex += 1;
    }
    if (localHit) return localHit;
  }
  // Last resort: the home page itself (still a valid, stable SECO source).
  return SOURCE_URL;
}

// Robust extractor for the SECO/arbeit.swiss home page.
//
// The page is a Nuxt single-page app. Its labour-market teaser renders the rate
// in a single self-contained sentence that names BOTH the period and the rate,
// e.g. "Nel mese di maggio 2026 il tasso di disoccupazione è rimasto invariato
// al 3,0%." (the same text also appears in the embedded JSON payload, alongside
// the canonical admin.ch press-release URL). Rather than bind to one fragile
// selector/`<div class="slide">` block (the old markup, now gone), we decode the
// whole document to plain text and scan for that sentence — requiring the rate
// AND the month+year period to occur in the SAME sentence so unrelated headings
// (e.g. "Portale lavoro.swiss – nuova veste da giugno 2026") cannot bleed their
// month into the rate. The newest such period wins. This survives markup churn
// as long as the rate sentence itself stays in the page text.
function parseLatestUnemployment(html) {
  const plain = decodeHtml(html);
  const candidates = [];

  // Match a sentence-sized fragment (bounded by . ; or sentence-ish breaks)
  // that contains the unemployment-rate phrase followed by a "N,N%" figure.
  // The trailing `[^.;”"]*` consumes the REST of the sentence past the first `%`
  // so a changed-month sentence ("…dal 2,9% al 3,0%") reaches extractRate intact
  // — stopping at the first `%` here would truncate before the rate result and
  // hand extractRate only the previous month's figure.
  const sentenceRe = /[^.;”"]*?(?:tasso di disoccupazione|unemployment rate|arbeitslosenquote|taux de ch[oô]mage)[^.;”"]{0,180}?[0-9]+(?:[.,][0-9]+)?\s*%[^.;”"]*/gi;
  let sm;
  while ((sm = sentenceRe.exec(plain)) !== null) {
    const frag = sm[0].trim();
    const rate = extractRate(frag);
    // Period MUST come from the same sentence as the rate — no cross-block reuse
    // (prevents an unrelated heading like "…nuova veste da giugno 2026" from
    // donating its month to the rate figure).
    const period = extractPeriod(frag);
    if (rate == null || !period) continue;
    candidates.push({ text: frag, rate, period });
  }

  if (candidates.length === 0) return null;

  // Selection: the rate phrase + a SAME-SENTENCE month+year period is already
  // unemployment-specific — the only other rate-phrase occurrences on the page
  // (an "alto tasso di disoccupazione" professions block) carry no period in
  // their own sentence and are dropped above. A previous "labour-market keyword
  // within 220 chars" corroboration gate was DEAD on the live page (#1732 review
  // #2): the heading "La situazione sul mercato del lavoro…" sits ~329 chars
  // before the rate sentence (the disoccupati paragraph intervenes), so it never
  // matched and the gate silently degraded to newest-period-only while implying
  // a guarantee it didn't provide. It is removed rather than left as dead code.
  // The newest period wins (ISO YYYY-MM compares lexicographically).
  let best = null;
  for (const c of candidates) {
    if (!best || c.period > best.period) best = c;
  }

  return {
    href: findReleaseHref(html, best.text),
    title: best.text.slice(0, 200),
    desc: best.text,
    rate: best.rate,
    period: best.period,
  };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function mergeMonthlyHistory(prev, nextPoint) {
  const raw = Array.isArray(prev?.history) ? prev.history : [];
  const map = new Map();
  for (const row of raw) {
    const period = String(row?.period || '').trim();
    const rate = Number(row?.rate);
    if (!period || !Number.isFinite(rate)) continue;
    map.set(period, { period, rate: Number(rate.toFixed(1)) });
  }
  map.set(nextPoint.period, { period: nextPoint.period, rate: Number(nextPoint.rate.toFixed(1)) });
  return [...map.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-120);
}

/* ---------- SEO text generation (4 locales) ---------- */

function generateSeoText(parsed, history) {
  const curRate = parsed.rate.toFixed(1);
  const [curYear, curMonth] = parsed.period.split('-').map(Number);
  const rates = history.map(h => h.rate);
  const minRate = Math.min(...rates).toFixed(1);
  const maxRate = Math.max(...rates).toFixed(1);
  const avgRate = (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1);
  const minEntry = history.find(h => h.rate === Math.min(...rates));
  const maxEntry = history.find(h => h.rate === Math.max(...rates));
  const firstYear = history[0].period.split('-')[0];
  const lastYear = history[history.length - 1].period.split('-')[0];

  const fmtMonth = (period, locale) => {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(
      { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale] || 'it-CH',
      { month: 'long', year: 'numeric', timeZone: 'UTC' }
    );
  };
  const curLabel = (loc) => fmtMonth(parsed.period, loc);
  const minLabel = (loc) => minEntry ? fmtMonth(minEntry.period, loc) : '';
  const maxLabel = (loc) => maxEntry ? fmtMonth(maxEntry.period, loc) : '';

  // Yearly averages
  const grouped = {};
  for (const h of history) { const y = h.period.split('-')[0]; (grouped[y] ??= []).push(h.rate); }
  const yearlyAvgs = Object.entries(grouped).map(([y, r]) => ({ year: y, avg: +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(1) }));
  const bestYear = yearlyAvgs.reduce((a, b) => (a.avg < b.avg ? a : b));
  const worstYear = yearlyAvgs.reduce((a, b) => (a.avg > b.avg ? a : b));

  // YoY
  const oneYearAgo = history.find(h => h.period === `${curYear - 1}-${String(curMonth).padStart(2, '0')}`);
  const yoyDelta = oneYearAgo ? (parsed.rate - oneYearAgo.rate).toFixed(1) : null;
  const yoyDir = yoyDelta && Number(yoyDelta) > 0 ? 'up' : yoyDelta && Number(yoyDelta) < 0 ? 'down' : 'stable';

  const recentTrend = rates.slice(-6);
  const isRising = recentTrend.length >= 3 && recentTrend[recentTrend.length - 1] > recentTrend[0];

  return {
    it: `A ${curLabel('it')}, il tasso di disoccupazione registrata in Svizzera si attesta al ${curRate}%, secondo gli ultimi dati pubblicati dalla SECO (Segreteria di Stato dell'economia). ` +
      (yoyDelta ? `Rispetto allo stesso mese dell'anno precedente, il tasso è ${yoyDir === 'up' ? `aumentato di ${yoyDelta} punti percentuali` : yoyDir === 'down' ? `diminuito di ${Math.abs(Number(yoyDelta))} punti percentuali` : 'rimasto stabile'}. ` : '') +
      `Nel periodo di osservazione ${firstYear}–${lastYear}, il tasso di disoccupazione medio è stato del ${avgRate}%, raggiungendo un minimo storico del ${minRate}% a ${minLabel('it')} e un picco del ${maxRate}% a ${maxLabel('it')}. ` +
      `La migliore media annuale è stata registrata nel ${bestYear.year} con il ${bestYear.avg}%, mentre la media annuale più alta è stata del ${worstYear.avg}% nel ${worstYear.year}, in gran parte attribuibile all'impatto della pandemia COVID-19 sul mercato del lavoro. ` +
      `${isRising ? "L'andamento recente mostra una leggera tendenza al rialzo negli ultimi sei mesi, riflettendo l'incertezza economica globale e i cambiamenti strutturali nel mercato del lavoro svizzero." : "L'andamento recente rimane relativamente stabile, a testimonianza della resilienza del mercato del lavoro svizzero nonostante il difficile contesto economico globale."} ` +
      `La Svizzera mantiene uno dei tassi di disoccupazione più bassi d'Europa grazie al sistema duale di formazione professionale, a un'economia diversificata e a politiche del mercato del lavoro flessibili. ` +
      `Per i lavoratori frontalieri che fanno il pendolare dall'Italia al Ticino, questi dati sono particolarmente rilevanti: un mercato del lavoro svizzero più forte si traduce in migliori prospettive occupazionali e maggiore potere contrattuale nella negoziazione salariale. ` +
      `Questi dati vengono aggiornati automaticamente ogni mese alla pubblicazione delle statistiche ufficiali della SECO sul mercato del lavoro.`,

    en: `As of ${curLabel('en')}, the registered unemployment rate in Switzerland stands at ${curRate}%, according to the latest data published by SECO (State Secretariat for Economic Affairs). ` +
      (yoyDelta ? `Compared to the same month last year, the rate has ${yoyDir === 'up' ? `increased by ${yoyDelta} percentage points` : yoyDir === 'down' ? `decreased by ${Math.abs(Number(yoyDelta))} percentage points` : 'remained stable'}. ` : '') +
      `Over the ${firstYear}–${lastYear} observation period, the unemployment rate averaged ${avgRate}%, reaching a historic low of ${minRate}% in ${minLabel('en')} and a peak of ${maxRate}% in ${maxLabel('en')}. ` +
      `The best annual average was recorded in ${bestYear.year} at ${bestYear.avg}%, while the highest annual average was ${worstYear.avg}% in ${worstYear.year}, largely attributable to the impact of the COVID-19 pandemic on the labour market. ` +
      `${isRising ? 'The recent trend shows a slight upward tendency over the last six months, reflecting global economic uncertainty and structural shifts in the Swiss job market.' : 'The recent trend remains relatively stable, reflecting the resilience of the Swiss labour market despite the challenging global economic environment.'} ` +
      `Switzerland maintains one of Europe's lowest unemployment rates thanks to its dual vocational training system, a diversified economy, and flexible labour market policies. ` +
      `For cross-border workers (frontaliers) commuting from Italy to Ticino, these figures are particularly relevant: a stronger Swiss job market translates to better employment prospects and negotiating power. ` +
      `This data is automatically updated each month when SECO publishes its official labour market statistics.`,

    de: `Per ${curLabel('de')} liegt die registrierte Arbeitslosenquote in der Schweiz bei ${curRate}%, gemäss den neuesten Daten des SECO (Staatssekretariat für Wirtschaft). ` +
      (yoyDelta ? `Im Vergleich zum gleichen Monat des Vorjahres ist die Quote ${yoyDir === 'up' ? `um ${yoyDelta} Prozentpunkte gestiegen` : yoyDir === 'down' ? `um ${Math.abs(Number(yoyDelta))} Prozentpunkte gesunken` : 'stabil geblieben'}. ` : '') +
      `Im Beobachtungszeitraum ${firstYear}–${lastYear} betrug die durchschnittliche Arbeitslosenquote ${avgRate}%, mit einem historischen Tiefststand von ${minRate}% im ${minLabel('de')} und einem Höchststand von ${maxRate}% im ${maxLabel('de')}. ` +
      `Der beste Jahresdurchschnitt wurde ${bestYear.year} mit ${bestYear.avg}% verzeichnet, während der höchste Jahresdurchschnitt bei ${worstYear.avg}% im Jahr ${worstYear.year} lag, was weitgehend auf die Auswirkungen der COVID-19-Pandemie auf den Arbeitsmarkt zurückzuführen ist. ` +
      `${isRising ? 'Der jüngste Trend zeigt in den letzten sechs Monaten eine leichte Aufwärtstendenz, die die globale wirtschaftliche Unsicherheit und strukturelle Veränderungen auf dem Schweizer Arbeitsmarkt widerspiegelt.' : 'Der jüngste Trend bleibt relativ stabil und spiegelt die Widerstandsfähigkeit des Schweizer Arbeitsmarktes trotz des herausfordernden globalen Umfelds wider.'} ` +
      `Die Schweiz weist dank ihres dualen Berufsbildungssystems, einer diversifizierten Wirtschaft und flexibler Arbeitsmarktpolitik eine der niedrigsten Arbeitslosenquoten Europas auf. ` +
      `Für Grenzgänger, die aus Italien ins Tessin pendeln, sind diese Zahlen besonders relevant: Ein stärkerer Schweizer Arbeitsmarkt bedeutet bessere Beschäftigungsaussichten und Verhandlungsposition. ` +
      `Diese Daten werden automatisch aktualisiert, sobald das SECO seine monatliche Arbeitsmarktstatistik veröffentlicht.`,

    fr: `En ${curLabel('fr')}, le taux de chômage enregistré en Suisse s'établit à ${curRate}%, selon les dernières données publiées par le SECO (Secrétariat d'État à l'économie). ` +
      (yoyDelta ? `Par rapport au même mois de l'année précédente, le taux a ${yoyDir === 'up' ? `augmenté de ${yoyDelta} point${Number(yoyDelta) > 1 ? 's' : ''} de pourcentage` : yoyDir === 'down' ? `diminué de ${Math.abs(Number(yoyDelta))} point${Math.abs(Number(yoyDelta)) > 1 ? 's' : ''} de pourcentage` : 'resté stable'}. ` : '') +
      `Sur la période d'observation ${firstYear}–${lastYear}, le taux de chômage moyen s'est établi à ${avgRate}%, atteignant un minimum historique de ${minRate}% en ${minLabel('fr')} et un pic de ${maxRate}% en ${maxLabel('fr')}. ` +
      `La meilleure moyenne annuelle a été enregistrée en ${bestYear.year} à ${bestYear.avg}%, tandis que la moyenne annuelle la plus élevée était de ${worstYear.avg}% en ${worstYear.year}, en grande partie attribuable à l'impact de la pandémie de COVID-19 sur le marché du travail. ` +
      `${isRising ? "La tendance récente montre une légère hausse sur les six derniers mois, reflétant l'incertitude économique mondiale et les mutations structurelles du marché suisse de l'emploi." : "La tendance récente reste relativement stable, témoignant de la résilience du marché du travail suisse malgré un contexte économique mondial difficile."} ` +
      `La Suisse maintient l'un des taux de chômage les plus bas d'Europe grâce à son système de formation professionnelle duale, une économie diversifiée et des politiques du marché du travail flexibles. ` +
      `Pour les travailleurs frontaliers faisant la navette entre l'Italie et le Tessin, ces chiffres sont particulièrement pertinents : un marché du travail suisse plus solide signifie de meilleures perspectives d'emploi et un pouvoir de négociation accru. ` +
      `Ces données sont automatiquement mises à jour chaque mois lors de la publication des statistiques officielles du SECO.`,
  };
}

/**
 * Fetch the SECO page text through the shared transient-failure retry helper
 * (exponential backoff + jitter, transient-only classification, env-tunable via
 * JOBS_CRAWLER_RETRIES / JOBS_CRAWLER_RETRY_BASE_MS). Each attempt is bounded by
 * a 30s timeout — the connect-timeout blips that opened #1533 were well under
 * the previous 10s ceiling, so a longer per-attempt window plus retry on real
 * transient errors (429/5xx, ECONNRESET/ETIMEDOUT, abort) clears them. Persistent
 * 4xx fail fast. On non-ok HTTP the status + URL are surfaced for diagnosability.
 */
async function fetchSecoHtml(timeoutMs = 30000) {
  const res = await httpFetchWithRetry(SOURCE_URL, {
    headers: {
      'user-agent': 'FrontaliereTicinoBot/1.0 (+https://frontaliereticino.ch)',
      accept: 'text/html,application/xhtml+xml',
    },
  }, { timeout: timeoutMs, label: 'unemployment SECO page' });
  // Transient 429/5xx + network blips were retried inside the helper; a
  // persistent non-ok still fails fast so we never parse an error page.
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${SOURCE_URL}`);
  }
  return await res.text();
}

async function main() {
  const html = await fetchSecoHtml();
  const parsed = parseLatestUnemployment(html);
  if (!parsed) {
    // Fail loud (no silent default): the page is a Nuxt SPA whose labour-market
    // teaser carries the rate in a sentence like "…tasso di disoccupazione …
    // al N,N%". If this throws, the SECO source markup/wording drifted and the
    // extractor in parseLatestUnemployment() needs re-pointing.
    throw new Error(
      `Unable to parse unemployment rate from SECO page (${SOURCE_URL}). ` +
        'Tried: rate sentence ("tasso di disoccupazione/unemployment rate/' +
        'Arbeitslosenquote/taux de chômage … N,N%") with a same-sentence ' +
        'month+year period and a labour-market keyword. Source markup likely ' +
        'changed — update parseLatestUnemployment().',
    );
  }

  const previous = safeReadJson(OUT_FILE);
  const history = mergeMonthlyHistory(previous, { period: parsed.period, rate: parsed.rate });
  const hasNewData =
    !previous ||
    String(previous.period || '') !== parsed.period ||
    Number(previous.rate) !== Number(parsed.rate) ||
    String(previous.releaseUrl || '') !== String(parsed.href || '');

  if (!hasNewData) {
    console.log(
      `[unemployment] No new published data. Current remains ${parsed.period} -> ${parsed.rate}%`,
    );
    return;
  }

  const payload = {
    rate: parsed.rate,
    unit: 'percent',
    period: parsed.period,
    history,
    seoText: generateSeoText(parsed, history),
    sourceName: 'SECO - arbeit.swiss',
    sourceUrl: SOURCE_URL,
    releaseUrl: parsed.href,
    methodology: "Tasso di disoccupazione registrata SECO, estratto dall'ultimo comunicato sul mercato del lavoro.",
    fetchedAt: new Date().toISOString(),
  };

  writeJsonAtomic(OUT_FILE, payload);
  console.log(`[unemployment] Updated ${OUT_FILE}: ${payload.period} -> ${payload.rate}%`);
}

export { parseLatestUnemployment, extractRate, extractPeriod, isPlausibleRate };

// Only fetch + write when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[unemployment] ERROR', err);
    process.exit(1);
  });
}
