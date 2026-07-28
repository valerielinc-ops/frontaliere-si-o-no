/**
 * Deterministic factuality gates for generated articles.
 *
 * Added after the 2026-07-28 incident on `frontalieri-altre-tasse-2026`
 * (run 30350429920, source ilgiorno.it/sondrio/cronaca/caso-frontalieri-altre-tasse).
 *
 * WHAT HAPPENED. The source said Ticino now taxes opt-in-Omnibus frontalieri at
 * 100% OF THE WITHHOLDING TABLES (A/B/C/H) instead of the reduced 80%, on top of
 * the Italian 25% substitute tax. The shipped article read "100%" as "100% of
 * gross salary" and published, in four locales:
 *
 *   - "0,45 x 60.000 = 27.000" presented as "4,5%"     → factor-of-10 error
 *   - income 60.000 CHF → tax 60.000 CHF               → tax == gross income
 *   - the same scenario answered 28.920 / 60.000 / 6.000 in three sections
 *   - "= 27.000 operative**" — a sentence cut mid-word, bold never closed
 *   - "Ufficio federale delle imposte (UFI)" — an institution that does not exist
 *   - Decreto Omnibus dated "1° gennaio 2023" AND "1° gennaio 2024"
 *   - a 25 January 2026 source published as news on 28 July 2026, in future tense
 *
 * WHY THE EXISTING GATE MISSED IT. Verification was delegated entirely to
 * llmFactCheck() — a probabilistic judge that (a) fails open when its models are
 * down, (b) only ever saw the first 8000 chars of the article, and (c) was
 * explicitly instructed to prefer false positives. Because its issues are fed
 * back as rewrite instructions, those false positives pushed the writer AWAY
 * from the source on every retry until the surviving draft no longer discussed
 * the source at all.
 *
 * Every failure listed above is decidable without an LLM: arithmetic is
 * arithmetic, a tax cannot equal gross pay, unbalanced `**` is unbalanced, and
 * a date difference is a subtraction. This module does exactly that — no model
 * calls, no network, fully deterministic, so it cannot fail open.
 *
 * Checks never throw on malformed input; they return issue objects. Callers
 * decide what blocks (see runFactualityGates → `blocking`).
 */

/** Severity ranking used to sort and to decide what blocks publication. */
export const SEVERITY = { critical: 3, major: 2, minor: 1 };

/**
 * Parses a number written in Italian convention.
 *   "60.000"   → 60000     (dot = thousands separator)
 *   "0,45"     → 0.45      (comma = decimal separator)
 *   "1.234,56" → 1234.56
 *   "0.45"     → 0.45      (dot NOT followed by exactly 3 digits = decimal)
 * Returns NaN when the token is not a number.
 */
export function parseItalianNumber(raw) {
  if (typeof raw !== 'string') return NaN;
  const token = raw.trim().replace(/\s/g, '');
  if (!token || !/^\d[\d.,]*$/.test(token)) return NaN;

  const [intPartRaw, ...decParts] = token.split(',');
  // More than one comma is not a number we understand.
  if (decParts.length > 1) return NaN;

  // Dots are thousands separators only when every group after the first is
  // exactly 3 digits ("1.234.567"). Otherwise treat the dot as decimal ("0.45").
  let intPart = intPartRaw;
  if (intPart.includes('.')) {
    const groups = intPart.split('.');
    const isThousands = groups.length > 1 && groups.slice(1).every((g) => /^\d{3}$/.test(g));
    if (isThousands) {
      intPart = groups.join('');
    } else if (decParts.length === 0 && groups.length === 2) {
      // "0.45" — dot acts as the decimal separator.
      return Number(`${groups[0]}.${groups[1]}`);
    } else {
      return NaN;
    }
  }

  const decPart = decParts[0];
  const normalized = decPart === undefined ? intPart : `${intPart}.${decPart}`;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function issue(code, severity, message, evidence) {
  return { code, severity, message, evidence: (evidence || '').slice(0, 200) };
}

// ─── 1. Truncated / cut-off text ──────────────────────────────────────
//
// The shipped body1 ended a sentence mid-word inside an unclosed bold and an
// unclosed parenthesis: "(0,45 x 60.000 = 27.000 operative**". Three
// independent, cheap signals catch that class.

const SENTENCE_END = /[.!?:;»"')\]}…]$/;

/**
 * Detects text that was cut off mid-generation.
 * @param {string} text
 * @param {{label?: string}} [opts]
 */
export function detectTruncation(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string' || !text.trim()) return issues;
  const label = opts.label ? `[${opts.label}] ` : '';

  // (a) Unbalanced parentheses / bold, checked PER PARAGRAPH.
  //
  // Document-level counting is not enough: the shipped body1 cut off at
  // "(0,45 x 60.000 = 27.000 operative**" yet balanced out overall because a
  // later paragraph carried the matching "(" and "**". A clause must close
  // inside the paragraph that opened it.
  const paragraphs = text.split(/\n{2,}/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const opens = (para.match(/\(/g) || []).length;
    const closes = (para.match(/\)/g) || []).length;
    if (opens !== closes) {
      issues.push(issue(
        'unbalanced-parentheses',
        opens > closes ? 'critical' : 'major',
        `${label}Parentesi non bilanciate nel paragrafo (${opens} aperte, ${closes} chiuse) — testo troncato`,
        para.trim().slice(-140),
      ));
    }
    const paraBold = (para.match(/\*\*/g) || []).length;
    if (paraBold % 2 !== 0) {
      issues.push(issue(
        'truncated-bold',
        'critical',
        `${label}Marker bold "**" non chiuso nel paragrafo — testo troncato`,
        para.trim().slice(-140),
      ));
    }
  }

  // (c) The text as a whole must end on a sentence boundary. Tables, lists and
  // headings are legitimate endings, so only flag prose endings.
  const trimmed = text.trimEnd();
  const lastLine = trimmed.split('\n').filter((l) => l.trim()).pop() || '';
  const isStructural = /^\s*([|#\-*>]|\d+\.)/.test(lastLine);
  if (!isStructural && !SENTENCE_END.test(trimmed)) {
    issues.push(issue(
      'incomplete-ending',
      'critical',
      `${label}Il testo non termina con punteggiatura di fine frase — troncamento`,
      lastLine.slice(-100),
    ));
  }

  return issues;
}

// ─── 2. Inline arithmetic ─────────────────────────────────────────────
//
// The shipped text wrote: "imposta del 4,5% (0,45 x 60.000 = 27.000)".
// The multiplication itself is right; the FACTOR contradicts the percentage by
// exactly 10×. Both halves are checked separately so a correct line like
// "3,2% (0,032 x 60.000 = 1.920)" stays clean.

const ARITHMETIC_RE = /(\d[\d.,]*)\s*[x×*]\s*(\d[\d.,]*)\s*=\s*(\d[\d.,]*)/gi;
const REL_TOLERANCE = 0.005;

function relDiff(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale;
}

/** Verifies every explicit "A x B = C" and its surrounding percentage claim. */
export function checkInlineArithmetic(text) {
  const issues = [];
  if (typeof text !== 'string') return issues;

  for (const m of text.matchAll(ARITHMETIC_RE)) {
    const [full, aRaw, bRaw, cRaw] = m;
    const a = parseItalianNumber(aRaw);
    const b = parseItalianNumber(bRaw);
    const c = parseItalianNumber(cRaw);
    if (![a, b, c].every(Number.isFinite)) continue;

    // (a) Does the stated product actually hold?
    if (relDiff(a * b, c) > REL_TOLERANCE) {
      issues.push(issue(
        'arithmetic-error',
        'critical',
        `Calcolo errato: ${aRaw} × ${bRaw} = ${(a * b).toLocaleString('it-IT')}, non ${cRaw}`,
        full,
      ));
    }

    // (b) When a percentage introduces the expression, the multiplier must be
    // that percentage as a decimal. "4,5% (0,45 x ...)" is off by 10×.
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const pctMatch = [...before.matchAll(/(\d[\d.,]*)\s*(?:%|per\s*cento)/gi)].pop();
    if (pctMatch) {
      const pct = parseItalianNumber(pctMatch[1]);
      if (Number.isFinite(pct) && pct !== 0 && relDiff(a, pct / 100) > REL_TOLERANCE) {
        const ratio = (a / (pct / 100));
        issues.push(issue(
          'percent-factor-mismatch',
          'critical',
          `Percentuale e fattore incoerenti: dichiarato ${pctMatch[1]}% ma moltiplicato per ${aRaw} `
          + `(${Number.isFinite(ratio) ? `${ratio.toFixed(0)}× il valore corretto ${(pct / 100).toString().replace('.', ',')}` : 'valore incoerente'})`,
          `${pctMatch[0]} ... ${full}`,
        ));
      }
    }
  }

  return issues;
}

// ─── 3. Tax plausibility ──────────────────────────────────────────────
//
// The article's core error — reading "100% of the withholding TABLES" as "100%
// of gross salary" — always surfaces as a tax that swallows the whole income.
// A tax equal to or above gross pay is arithmetically impossible, so this needs
// no domain tuning and cannot false-positive.

const CURRENCY = String.raw`(?:franchi\s+svizzeri|franchi|CHF|euro|EUR|€)`;
const INCOME_CUE = /(?:reddito|guadagn\w*|stipendio|salario|retribuzione|percep\w*)[^.\n]{0,40}?$/i;
const TAX_CUE = /(?:impost\w*|tass\w*|pag\w*|trattenut\w*|prelievo|carico\s+fiscale|quota\s+di\s+imposta)/i;

/** Extracts every "<amount> <currency>" occurrence with its position. */
function extractAmounts(text) {
  const re = new RegExp(String.raw`(\d[\d.,]*)\s*${CURRENCY}`, 'gi');
  const out = [];
  for (const m of text.matchAll(re)) {
    const value = parseItalianNumber(m[1]);
    if (Number.isFinite(value) && value > 0) out.push({ value, raw: m[0], index: m.index });
  }
  return out;
}

/**
 * Flags a stated tax that meets or exceeds the gross income it is computed on.
 * @param {string} text
 * @param {{implausibleRatio?: number}} [opts] ratio above which a tax is "major"
 */
export function checkTaxPlausibility(text, opts = {}) {
  const issues = [];
  if (typeof text !== 'string') return issues;
  const implausibleRatio = opts.implausibleRatio ?? 0.6;

  // Work line by line (and table rows are lines) so an income and a tax are
  // only paired when they genuinely sit in the same statement.
  for (const line of text.split('\n')) {
    const amounts = extractAmounts(line);
    if (amounts.length < 2) continue;

    // The income is the amount introduced by an income cue.
    const income = amounts.find((a) => INCOME_CUE.test(line.slice(0, a.index)));
    if (!income) continue;

    for (const amt of amounts) {
      if (amt === income) continue;
      const between = line.slice(income.index, amt.index);
      const preceding = line.slice(Math.max(0, amt.index - 80), amt.index);
      // Only compare amounts that are actually presented as a tax.
      if (!TAX_CUE.test(between) && !TAX_CUE.test(preceding)) continue;

      const ratio = amt.value / income.value;
      if (ratio >= 1) {
        issues.push(issue(
          'tax-exceeds-income',
          'critical',
          `Imposta ${amt.raw} pari o superiore al reddito lordo ${income.raw} (${Math.round(ratio * 100)}%) — impossibile`,
          line.trim(),
        ));
      } else if (ratio > implausibleRatio) {
        issues.push(issue(
          'tax-implausible',
          'major',
          `Imposta ${amt.raw} = ${Math.round(ratio * 100)}% del reddito ${income.raw} — implausibile per un frontaliere`,
          line.trim(),
        ));
      }
    }
  }

  return issues;
}

// ─── 4. Cross-section numeric conflicts ───────────────────────────────
//
// The shipped article answered the SAME scenario (60.000 CHF, opting in) with
// 28.920 in body1, 60.000 in body2 and "+6.000" in body3. Comparison is
// restricted to DIFFERENT sections so a legitimate two-column table
// ("current | projected") in one section never trips the gate.

/**
 * @param {Record<string,string>} sections e.g. { body1, body2, body3 }
 * @param {{conflictRatio?: number}} [opts]
 */
export function checkCrossSectionNumericConflicts(sections, opts = {}) {
  const issues = [];
  if (!sections || typeof sections !== 'object') return issues;
  const conflictRatio = opts.conflictRatio ?? 3;

  // base income value → [{ section, tax }]
  const byIncome = new Map();

  for (const [section, text] of Object.entries(sections)) {
    if (typeof text !== 'string') continue;
    for (const line of text.split('\n')) {
      const amounts = extractAmounts(line);
      if (amounts.length < 2) continue;
      const income = amounts.find((a) => INCOME_CUE.test(line.slice(0, a.index)));
      if (!income) continue;

      for (const amt of amounts) {
        if (amt === income) continue;
        const between = line.slice(income.index, amt.index);
        const preceding = line.slice(Math.max(0, amt.index - 80), amt.index);
        if (!TAX_CUE.test(between) && !TAX_CUE.test(preceding)) continue;

        const key = income.value;
        if (!byIncome.has(key)) byIncome.set(key, []);
        byIncome.get(key).push({ section, tax: amt.value, raw: amt.raw, line: line.trim() });
      }
    }
  }

  for (const [income, entries] of byIncome) {
    const sectionsSeen = new Set(entries.map((e) => e.section));
    if (sectionsSeen.size < 2) continue; // same section → could be a legit table

    const min = entries.reduce((a, b) => (a.tax <= b.tax ? a : b));
    const max = entries.reduce((a, b) => (a.tax >= b.tax ? a : b));
    if (min.section === max.section) continue;
    if (min.tax > 0 && max.tax / min.tax >= conflictRatio) {
      issues.push(issue(
        'contradictory-figures',
        'critical',
        `Stesso scenario (reddito ${income.toLocaleString('it-IT')}) con esiti incompatibili: `
        + `${min.raw} in ${min.section} vs ${max.raw} in ${max.section} (${(max.tax / min.tax).toFixed(1)}× di scarto)`,
        `${min.line} ⟷ ${max.line}`,
      ));
    }
  }

  return issues;
}

// ─── 5. Fabricated institutions ───────────────────────────────────────
//
// "Ufficio federale delle imposte (UFI)" does not exist — the federal body is
// the AFC/ESTV, and the source actually cited the CANTONAL ufficio imposte alla
// fonte. Only acronyms introduced in parentheses after an institution noun are
// checked: high signal, and a name alone is too noisy to gate on.

export const KNOWN_INSTITUTION_ACRONYMS = new Set([
  // Swiss federal
  'AFC', 'ESTV', 'UST', 'BFS', 'SECO', 'UFSP', 'BAG', 'UFAS', 'BSV', 'SEM', 'UDSC', 'BAZG',
  'USTAT', 'FINMA', 'BNS', 'SNB', 'COMCO', 'WEKO', 'IFD', 'DFF', 'DFAE', 'SUVA',
  // Swiss social insurance / schemes
  'AVS', 'AHV', 'AI', 'IV', 'LPP', 'BVG', 'LAMal', 'KVG', 'LAINF', 'UVG', 'AD', 'ALV', 'CMI',
  // Italian
  'INPS', 'INAIL', 'MEF', 'ADE', 'AE', 'ISTAT', 'CGIL', 'CISL', 'UIL', 'IRPEF', 'IVA', 'IMU',
  // Ticino / cross-border
  'OCST', 'UNIA', 'SYNA', 'VPOD', 'SYNDICOM', 'IUFFP', 'SUPSI', 'USI', 'DSS', 'DFE',
  // EU / international
  'UE', 'EU', 'SEE', 'EEA', 'OCSE', 'OECD', 'AELS', 'EFTA', 'ONU', 'OIL', 'ILO',
]);

const INSTITUTION_NOUN = String.raw`(?:Ufficio|Uffici|Istituto|Agenzia|Commissione|Osservatorio|Autorit[àa]|Dipartimento|Segreteria|Direzione|Ente|Amministrazione)`;

/** Flags institution acronyms that are not in the known-real allowlist. */
export function checkFabricatedInstitutionAcronyms(text) {
  const issues = [];
  if (typeof text !== 'string') return issues;

  const re = new RegExp(String.raw`(${INSTITUTION_NOUN}[^().\n]{0,80}?)\(([A-Z]{2,8})\)`, 'g');
  for (const m of text.matchAll(re)) {
    const [full, name, acronym] = m;
    if (KNOWN_INSTITUTION_ACRONYMS.has(acronym)) continue;
    issues.push(issue(
      'unknown-institution',
      'critical',
      `Ente non riconosciuto: "${name.trim()} (${acronym})" — acronimo assente dalla allowlist di istituzioni reali`,
      full.trim(),
    ));
  }

  return issues;
}

// ─── 6. Contradictory dates for the same named norm ───────────────────
//
// "Il Decreto Omnibus è stato varato il 1° gennaio 2023" coexisted with "Il 1°
// gennaio 2024 entrerà in vigore il Decreto Omnibus" in the same article.

const MONTHS_IT = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};
const DATE_IT_RE = /(\d{1,2})\s*°?\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/gi;
const NORM_RE = /((?:Decreto|Legge|Accordo|Convenzione|Regolamento|Direttiva)\s+[A-ZÀ-Ü][\wÀ-ü'-]*(?:\s+[A-ZÀ-Ü][\wÀ-ü'-]*)?)/g;

/** Flags a named norm associated with more than one distinct date. */
export function checkContradictoryNormDates(text) {
  const issues = [];
  if (typeof text !== 'string') return issues;

  const byNorm = new Map();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const norms = [...sentence.matchAll(NORM_RE)].map((m) => m[1].trim());
    if (!norms.length) continue;
    const dates = [...sentence.matchAll(DATE_IT_RE)].map((m) => {
      const day = Number(m[1]);
      const month = MONTHS_IT[m[2].toLowerCase()];
      const year = Number(m[3]);
      return { key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, raw: m[0] };
    });
    if (!dates.length) continue;

    for (const norm of new Set(norms)) {
      if (!byNorm.has(norm)) byNorm.set(norm, new Map());
      for (const d of dates) byNorm.get(norm).set(d.key, { raw: d.raw, sentence: sentence.trim() });
    }
  }

  for (const [norm, dateMap] of byNorm) {
    if (dateMap.size < 2) continue;
    const entries = [...dateMap.values()];
    issues.push(issue(
      'contradictory-norm-dates',
      'critical',
      `"${norm}" associato a ${dateMap.size} date diverse nello stesso articolo: ${entries.map((e) => e.raw).join(' / ')}`,
      entries.map((e) => e.sentence).join(' ⟷ '),
    ));
  }

  return issues;
}

// ─── 7. Source freshness ──────────────────────────────────────────────
//
// A 25 January 2026 source was published as news on 28 July 2026, still in the
// future tense ("entrerà in vigore"). Both halves are checked.

// No `g` flag: this regex is only ever used with .test(), and a global regex
// carries `lastIndex` across calls — the second .test() on a different string
// then starts mid-way and silently misses. (Cost us a false negative in the
// first draft of this module.)
const FUTURE_TENSE_RE = /\b(entrer[àa]|sar[àa]\s+in\s+vigore|scadr[àa]|verr[àa]\s+(?:introdott|applicat|varat)\w*|opterann?o|dovrann?o\s+presentare)\b/i;

/**
 * @param {{sourceDate?: string|Date, publishedAt?: string|Date, text?: string,
 *          maxAgeDays?: number, now?: Date}} params
 */
export function checkSourceFreshness(params = {}) {
  const issues = [];
  const { sourceDate, publishedAt, text = '', maxAgeDays = 30 } = params;

  const src = sourceDate ? new Date(sourceDate) : null;
  const pub = publishedAt ? new Date(publishedAt) : (params.now || null);

  if (src && !Number.isNaN(src.getTime()) && pub && !Number.isNaN(pub.getTime())) {
    const ageDays = Math.floor((pub.getTime() - src.getTime()) / 86_400_000);
    if (ageDays > maxAgeDays) {
      issues.push(issue(
        'stale-source',
        ageDays > maxAgeDays * 3 ? 'critical' : 'major',
        `Fonte del ${src.toISOString().slice(0, 10)} pubblicata come notizia il ${pub.toISOString().slice(0, 10)} `
        + `— ${ageDays} giorni di ritardo (max ${maxAgeDays})`,
        '',
      ));
    }
  } else if (publishedAt && !sourceDate) {
    issues.push(issue(
      'missing-source-date',
      'minor',
      'Data di pubblicazione della fonte non estratta — freshness non verificabile',
      '',
    ));
  }

  // Future tense pointing at a date that has already passed at publication time.
  if (pub && !Number.isNaN(pub.getTime()) && typeof text === 'string' && FUTURE_TENSE_RE.test(text)) {
    for (const m of text.matchAll(DATE_IT_RE)) {
      const day = Number(m[1]);
      const month = MONTHS_IT[m[2].toLowerCase()];
      const year = Number(m[3]);
      const when = new Date(Date.UTC(year, month - 1, day));
      if (when.getTime() >= pub.getTime()) continue;
      const around = text.slice(Math.max(0, m.index - 120), m.index + 40);
      if (!FUTURE_TENSE_RE.test(around)) continue;
      issues.push(issue(
        'past-date-future-tense',
        'major',
        `Data già passata (${m[0]}) presentata al futuro rispetto alla pubblicazione del ${pub.toISOString().slice(0, 10)}`,
        around.trim(),
      ));
    }
  }

  return issues;
}

// ─── 8. Source fidelity (recall) ──────────────────────────────────────
//
// THE ROOT-CAUSE GATE. llmFactCheck only ever asked "does the article contain a
// claim I cannot verify?" — never "did the article keep what the source
// actually said?". Under a retry loop that feeds issues back as rewrite
// instructions, dropping every specific fact is the winning strategy: the final
// draft lost 80%, 25%, OCST, "vecchio elenco" and "fine 2026" and passed.
//
// Measuring RECALL of the source's anchored facts makes that strategy lose.

const STOP_TOKENS = new Set(['2026', '2025', '2024', '100', '000']);

/** Extracts the source's checkable anchors: percentages, amounts, dates, distances, acronyms. */
export function extractSourceAnchors(sourceText) {
  const anchors = new Set();
  if (typeof sourceText !== 'string') return anchors;

  // Percentages: "80%", "25%", "cento per cento"
  for (const m of sourceText.matchAll(/(\d[\d.,]*)\s*%/g)) anchors.add(`pct:${parseItalianNumber(m[1])}`);
  // Distances: "20 km"
  for (const m of sourceText.matchAll(/(\d[\d.,]*)\s*km\b/gi)) anchors.add(`km:${parseItalianNumber(m[1])}`);
  // Full dates
  for (const m of sourceText.matchAll(DATE_IT_RE)) {
    anchors.add(`date:${m[3]}-${String(MONTHS_IT[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`);
  }
  // Institution / organisation acronyms actually present in the source
  for (const m of sourceText.matchAll(/\b([A-Z]{3,8})\b/g)) {
    if (!STOP_TOKENS.has(m[1])) anchors.add(`org:${m[1].toUpperCase()}`);
  }
  return anchors;
}

/** Returns the subset of `anchors` that the article still mentions. */
export function matchedAnchors(articleText, anchors) {
  const found = new Set();
  if (typeof articleText !== 'string') return found;
  const lower = articleText.toLowerCase();

  for (const anchor of anchors) {
    const [kind, value] = anchor.split(':');
    if (kind === 'pct') {
      const n = Number(value);
      const written = n === 100 ? ['100%', '100 %', 'cento per cento'] : [];
      const it = n.toString().replace('.', ',');
      if (articleText.includes(`${it}%`) || articleText.includes(`${it} %`)
        || written.some((w) => lower.includes(w))) found.add(anchor);
    } else if (kind === 'km') {
      if (new RegExp(String.raw`${Number(value)}\s*km`, 'i').test(articleText)) found.add(anchor);
    } else if (kind === 'date') {
      const [y, mo, d] = value.split('-');
      const monthName = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === Number(mo));
      if (new RegExp(String.raw`${Number(d)}\s*°?\s+${monthName}\s+${y}`, 'i').test(articleText)) found.add(anchor);
    } else if (kind === 'org') {
      if (new RegExp(String.raw`\b${value}\b`, 'i').test(articleText)) found.add(anchor);
    }
  }
  return found;
}

/**
 * Blocks an article that dropped too much of what the source actually said.
 * @param {string} articleText
 * @param {string} sourceText
 * @param {{minRecall?: number, minAnchors?: number}} [opts]
 */
export function checkSourceFidelity(articleText, sourceText, opts = {}) {
  const issues = [];
  const minRecall = opts.minRecall ?? 0.5;
  const minAnchors = opts.minAnchors ?? 3;

  const anchors = extractSourceAnchors(sourceText);
  // Too few anchors to judge (thin or narrative source) → not a gate.
  if (anchors.size < minAnchors) return issues;

  const found = matchedAnchors(articleText, anchors);

  // Percentages carry the meaning of a tax story, so they get their own gate.
  // The shipped article kept 4/6 anchors overall (recall 67%, above threshold)
  // while dropping exactly the two that mattered — the 80% reduced rate and the
  // Italian 25% substitute tax. Without those the "100%" is unreadable, which
  // is precisely how "100% of the tables" became "100% of your salary".
  const srcPct = [...anchors].filter((a) => a.startsWith('pct:'));
  const missingPct = srcPct.filter((a) => !found.has(a));
  if (srcPct.length >= 2 && missingPct.length >= 2) {
    issues.push(issue(
      'source-key-rates-dropped',
      'critical',
      `L'articolo ha perso ${missingPct.length}/${srcPct.length} delle percentuali della fonte `
      + `(${missingPct.map((p) => `${p.slice(4)}%`).join(', ')}) — senza queste il dato resta incomprensibile`,
      `percentuali fonte: ${srcPct.map((p) => `${p.slice(4)}%`).join(', ')}`,
    ));
  }

  const recall = found.size / anchors.size;
  if (recall < minRecall) {
    const missing = [...anchors].filter((a) => !found.has(a));
    issues.push(issue(
      'source-fidelity-low',
      'critical',
      `L'articolo conserva solo ${found.size}/${anchors.size} dei fatti verificabili della fonte `
      + `(recall ${(recall * 100).toFixed(0)}% < ${(minRecall * 100).toFixed(0)}%) — omissioni critiche`,
      `mancanti: ${missing.slice(0, 12).join(', ')}`,
    ));
  }

  return issues;
}

// ─── Orchestrator ─────────────────────────────────────────────────────

/**
 * Runs every deterministic gate.
 *
 * @param {{sections: Record<string,string>, sourceText?: string,
 *          sourceDate?: string|Date, publishedAt?: string|Date,
 *          options?: object}} params
 * @returns {{passed: boolean, issues: object[], blocking: object[]}}
 */
export function runFactualityGates(params = {}) {
  const { sections = {}, sourceText = '', sourceDate, publishedAt, options = {} } = params;
  const fullText = Object.values(sections).filter((v) => typeof v === 'string').join('\n\n');

  const issues = [];
  for (const [label, text] of Object.entries(sections)) {
    if (typeof text !== 'string' || !text.trim()) continue;
    issues.push(...detectTruncation(text, { label }));
  }
  issues.push(...checkInlineArithmetic(fullText));
  issues.push(...checkTaxPlausibility(fullText, options));
  issues.push(...checkCrossSectionNumericConflicts(sections, options));
  issues.push(...checkFabricatedInstitutionAcronyms(fullText));
  issues.push(...checkContradictoryNormDates(fullText));
  issues.push(...checkSourceFreshness({ sourceDate, publishedAt, text: fullText, ...options }));
  if (sourceText && sourceText.length >= 100) {
    issues.push(...checkSourceFidelity(fullText, sourceText, options));
  }

  issues.sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0));
  const blocking = issues.filter((i) => i.severity === 'critical');
  return { passed: blocking.length === 0, issues, blocking };
}

/** Human-readable one-line-per-issue rendering for CI logs. */
export function formatIssues(issues) {
  const icon = { critical: '🚨', major: '⚠️', minor: 'ℹ️' };
  return (issues || [])
    .map((i) => `  ${icon[i.severity] || '•'} [${i.code}] ${i.message}${i.evidence ? `\n       ↳ ${i.evidence}` : ''}`)
    .join('\n');
}
