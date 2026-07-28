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
 *   - "Ufficio federale delle imposte (UFI)" — an institution that does not exist
 *   - Decreto Omnibus dated "1° gennaio 2023" AND "1° gennaio 2024"
 *   - a 25 January 2026 source published as news on 28 July 2026, in future tense
 *   - the 80% reduced rate and the Italian 25% substitute tax — the two figures
 *     that make "100%" legible — dropped entirely
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
 * Formats a number in Italian convention (1.234,5).
 *
 * Not toLocaleString('it-IT'): Node builds with a reduced ICU fall back to the
 * C locale and silently emit "2700" where the article needs "2.700" — and
 * these strings go into remediation text the writer copies from.
 */
export function formatItalianNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  const [int, dec] = Math.abs(value).toString().split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = value < 0 ? '-' : '';
  return dec ? `${sign}${grouped},${dec}` : `${sign}${grouped}`;
}

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

/**
 * @param {string} code      stable identifier for the defect class
 * @param {string} severity  critical | major | minor
 * @param {string} message   what is wrong (diagnosis)
 * @param {string} evidence  the offending text
 * @param {string} fix       what to DO about it (remediation)
 *
 * `fix` is not decoration. Gate issues are reinjected into the regeneration
 * prompt, and a diagnosis alone ("percentage and factor are inconsistent")
 * leaves the writer to guess which of the two numbers to change — it often
 * guessed wrong, or deleted the whole passage. Every fix below therefore
 * carries the concrete corrected values, computed here where they are known.
 */
function issue(code, severity, message, evidence, fix = '') {
  return { code, severity, message, evidence: (evidence || '').slice(0, 200), fix };
}

// ─── 1. Truncated / cut-off text ──────────────────────────────────────
//
// Not a defect of the incident article — but the retro-audit over the 3564
// published bodies found 35 paragraphs with an unclosed parenthesis and 5 with
// an unclosed bold marker, i.e. text a model stopped emitting mid-clause. The
// generation pipeline has fought free-tier truncation before (see the cap
// comments in create-article.mjs), so the class is worth a cheap standing check.

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
        opens > closes
          ? `Chiudi la parentesi rimasta aperta in ${label || 'questo paragrafo'} completando la frase interrotta, oppure rimuovi la parentesi di apertura se la precisazione non serve.`
          : `Rimuovi la parentesi di chiusura in eccesso in ${label || 'questo paragrafo'}.`,
      ));
    }
    const paraBold = (para.match(/\*\*/g) || []).length;
    if (paraBold % 2 !== 0) {
      issues.push(issue(
        'truncated-bold',
        'critical',
        `${label}Marker bold "**" non chiuso nel paragrafo — testo troncato`,
        para.trim().slice(-140),
        'Chiudi il grassetto aggiungendo il "**" mancante alla fine del testo che deve risultare in grassetto, oppure rimuovi il "**" orfano.',
      ));
    }
  }

  // (b) The text should end on a sentence boundary. Several endings are
  // legitimate and must not be flagged (they produced 117 false positives on
  // the first corpus pass): tables, lists, headings, "Fonte: …" attribution
  // lines, footnote markers, and a trailing emoji after real punctuation.
  const trimmed = text.trimEnd();
  const lastLine = trimmed.split('\n').filter((l) => l.trim()).pop() || '';
  const isStructural = /^\s*([|#\-*>]|\d+\.)/.test(lastLine);
  const isAttribution = /^\s*\*?\s*(fonte|source|quelle)\s*:/i.test(lastLine);
  // Strip trailing emoji / footnote glyphs before judging the punctuation.
  const withoutTrailingGlyphs = trimmed
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍↩*_\s]+$/gu, '');
  const endsCleanly = SENTENCE_END.test(withoutTrailingGlyphs);
  // A short tail is usually a heading, not a cut-off sentence.
  const looksLikeHeading = lastLine.trim().length < 60 && !/[,;]$/.test(lastLine.trim());

  if (!isStructural && !isAttribution && !endsCleanly && !looksLikeHeading) {
    issues.push(issue(
      'incomplete-ending',
      'major',
      `${label}Il testo non termina con punteggiatura di fine frase — possibile troncamento`,
      lastLine.slice(-100),
      `Completa la frase finale di ${label || 'questa sezione'} e chiudila con un punto. Non lasciare il periodo sospeso.`,
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
        `Calcolo errato: ${aRaw} × ${bRaw} = ${formatItalianNumber(a * b)}, non ${cRaw}`,
        full,
        `Sostituisci "${full}" con "${aRaw} × ${bRaw} = ${formatItalianNumber(a * b)}". `
        + `Poi aggiorna ogni totale o confronto che usava il valore errato ${cRaw}.`,
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
          `Decidi quale dei due numeri è giusto e allinea l'altro. `
          + `Se la percentuale corretta è ${pctMatch[1]}%, il fattore deve essere `
          + `${(pct / 100).toString().replace('.', ',')} e il risultato ${formatItalianNumber((pct / 100) * b)}. `
          + `Se invece il risultato ${cRaw} è quello giusto, la percentuale da dichiarare è `
          + `${(a * 100).toString().replace('.', ',')}%. Non lasciare i due valori incoerenti e non cancellare l'esempio.`,
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

/**
 * Ranges of the text that restate a base figure rather than assert a new one:
 * a parenthetical containing a percentage, e.g. "24.000 CHF (30% di 80.000)".
 * Without this, the 80.000 inside the parenthesis was read as a tax equal to
 * the 80.000 income — 96 false positives on the first corpus pass.
 */
function calculationSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/\([^)]*%[^)]*\)/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Time base an amount is expressed in, read from the words right after it.
 * Comparing a monthly salary against an annual tax is not a contradiction, and
 * treating it as one produced most of the residual noise ("4.000 CHF al mese"
 * vs a yearly figure). Amounts with different, known periods are never paired.
 */
function periodOf(text, afterIndex) {
  const tail = text.slice(afterIndex, afterIndex + 40).toLowerCase();
  if (/\b(al|a|ogni|per)\s+mese|mensil|\/mese/.test(tail)) return 'month';
  if (/\b(all'anno|annu|ogni\s+anno|\/anno)/.test(tail)) return 'year';
  if (/\b(a|alla|per)\s+settimana|settimanal/.test(tail)) return 'week';
  if (/\b(al|all'|per)\s*ora|orari/.test(tail)) return 'hour';
  return '';
}

/** Extracts every "<amount> <currency>" occurrence with its position. */
function extractAmounts(text) {
  const re = new RegExp(String.raw`(\d[\d.,]*)\s*${CURRENCY}`, 'gi');
  const skip = calculationSpans(text);
  const out = [];
  for (const m of text.matchAll(re)) {
    if (skip.some(([s, e]) => m.index >= s && m.index < e)) continue;
    const value = parseItalianNumber(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      value,
      raw: m[0],
      index: m.index,
      period: periodOf(text, m.index + m[0].length),
    });
  }
  return out;
}

/** True when two amounts are stated over different, known time bases. */
function periodsConflict(a, b) {
  return Boolean(a.period) && Boolean(b.period) && a.period !== b.period;
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
  // One report per (income, tax) pair — the same example restated across
  // paragraphs otherwise emitted the identical issue a dozen times.
  const reported = new Set();

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
      if (periodsConflict(income, amt)) continue;
      const between = line.slice(income.index, amt.index);
      const preceding = line.slice(Math.max(0, amt.index - 80), amt.index);
      // Only compare amounts that are actually presented as a tax.
      if (!TAX_CUE.test(between) && !TAX_CUE.test(preceding)) continue;

      const dedupKey = `${income.value}|${amt.value}`;
      if (reported.has(dedupKey)) continue;
      reported.add(dedupKey);

      const ratio = amt.value / income.value;
      if (ratio >= 1) {
        issues.push(issue(
          'tax-exceeds-income',
          'critical',
          `Imposta ${amt.raw} pari o superiore al reddito lordo ${income.raw} (${Math.round(ratio * 100)}%) — impossibile`,
          line.trim(),
          `Un'imposta non può essere pari o superiore al reddito lordo. Errore tipico: leggere "aliquota al 100%" `
          + `come "il 100% dello stipendio". Il 100% si riferisce all'ALIQUOTA PIENA della tabella d'imposta, non al reddito. `
          + `Correggi indicando l'importo effettivo dell'imposta (per un frontaliere in Ticino, tipicamente il 5-15% del lordo, `
          + `quindi nell'ordine di ${formatItalianNumber(Math.round(income.value * 0.1))} su ${income.raw}) `
          + `oppure esprimi il passaggio in punti di aliquota invece che in franchi.`,
        ));
      } else if (ratio > implausibleRatio) {
        issues.push(issue(
          'tax-implausible',
          'major',
          `Imposta ${amt.raw} = ${Math.round(ratio * 100)}% del reddito ${income.raw} — implausibile per un frontaliere`,
          line.trim(),
          `Verifica l'aliquota: l'imposta alla fonte per un frontaliere in Ticino sta tipicamente tra il 5% e il 15% del lordo. `
          + `Se ${amt.raw} include anche contributi o imposte italiane, dichiaralo esplicitamente e scomponi le voci; `
          + `altrimenti correggi l'importo.`,
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
        if (periodsConflict(income, amt)) continue;
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
        `Stesso scenario (reddito ${formatItalianNumber(income)}) con esiti incompatibili: `
        + `${min.raw} in ${min.section} vs ${max.raw} in ${max.section} (${(max.tax / min.tax).toFixed(1)}× di scarto)`,
        `${min.line} ⟷ ${max.line}`,
        `Scegli UN solo valore corretto per lo scenario "reddito ${formatItalianNumber(income)}" e usalo identico in `
        + `${min.section} e ${max.section}. Se le due cifre rispondono a domande diverse (imposta totale vs solo aumento, `
        + `prima vs dopo), esplicita la differenza nel testo — non lasciare due risposte alla stessa domanda.`,
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

// An allowlist can never be complete, and treating "unknown" as "invented"
// produced 560 false positives across the corpus on the first pass — USTRA,
// EOC, DECS, URC, DEFR, DFI, DFGP, UFAM, UFT, UFE, IPI, OFS are all real. So
// the gate is split in two: a denylist of acronyms observed being hallucinated
// (blocking), and the allowlist below (silences the known-real). Anything in
// neither is reported as `major` — surfaced for a human, never auto-blocking.
export const KNOWN_INSTITUTION_ACRONYMS = new Set([
  // Swiss federal — administration
  'AFC', 'ESTV', 'UST', 'BFS', 'OFS', 'SECO', 'UFSP', 'BAG', 'UFAS', 'BSV', 'SEM', 'UDSC', 'BAZG',
  'USTRA', 'ASTRA', 'UFT', 'BAV', 'UFAM', 'BAFU', 'UFE', 'BFE', 'UFAG', 'BLW', 'UFC', 'BAK',
  'UFCOM', 'BAKOM', 'UFSC', 'UFAB', 'UFPP', 'BABS', 'UFG', 'BJ', 'UFM', 'IPI', 'METAS', 'SEFRI',
  'UFU', 'ARE', 'UFRI', 'SER', 'USTI', 'UFS', 'UFF', 'UFD', 'UFAE', 'UJP', 'UIDP', 'UDI', 'OSF',
  // Swiss federal — departments
  'DFI', 'DFGP', 'DFF', 'DFAE', 'DDPS', 'DATEC', 'DEFR', 'DFE', 'EDI', 'EJPD', 'EFD', 'EDA',
  // Swiss institutions / oversight
  'FINMA', 'BNS', 'SNB', 'COMCO', 'WEKO', 'IFD', 'SUVA', 'CDF', 'EFK', 'PFPDT', 'IFPDT',
  'ETHZ', 'EPFL', 'PSI', 'EMPA', 'WSL', 'AGROSCOPE', 'IUFFP', 'SUPSI', 'USI', 'SUP', 'SUFFP',
  // Swiss social insurance / schemes
  'AVS', 'AHV', 'AI', 'IV', 'LPP', 'BVG', 'LAMal', 'KVG', 'LAINF', 'UVG', 'AD', 'ALV', 'CMI',
  'LADI', 'AVIG', 'APG', 'EO', 'PC', 'EL',
  // Ticino cantonal
  'DECS', 'DSS', 'DT', 'DI', 'DFE', 'EOC', 'ORL', 'CSI', 'URC', 'USTAT', 'SPAAS', 'IOSI',
  'IRB', 'CRS', 'ATT', 'ETL', 'OTR', 'ACR',
  // Italian
  'INPS', 'INAIL', 'MEF', 'ADE', 'AE', 'ISTAT', 'IRPEF', 'IVA', 'IMU', 'ASL', 'ATS', 'ARPA',
  'CGIL', 'CISL', 'UIL', 'UGL', 'ANPAL', 'MIUR', 'MIT',
  // Unions / associations
  'OCST', 'UNIA', 'SYNA', 'VPOD', 'SYNDICOM', 'AITI', 'CC-TI', 'USS', 'SSIC', 'ASTAG',
  // EU / international
  'UE', 'EU', 'SEE', 'EEA', 'OCSE', 'OECD', 'AELS', 'EFTA', 'ONU', 'OIL', 'ILO', 'OMS', 'WHO',
  'FMI', 'IMF', 'BCE', 'ECB', 'NATO', 'CEDU', 'CGUE',
]);

/**
 * Acronyms caught being invented by the generator. These block.
 * `UFI` ("Ufficio federale delle imposte") shipped in 4 articles — the federal
 * body is the AFC/ESTV, and withholding tax is administered CANTONALLY.
 */
export const FABRICATED_INSTITUTION_ACRONYMS = new Set([
  'UFI', 'UFOL', 'UWL', 'UFIS', 'CFL', 'DEMAS', 'LCFL', 'UFLAV', 'CNFL', 'UFIF',
]);

const INSTITUTION_NOUN = String.raw`(?:Ufficio|Uffici|Istituto|Agenzia|Commissione|Osservatorio|Autorit[àa]|Dipartimento|Segreteria|Direzione|Ente|Amministrazione)`;

/** Flags institution acronyms that are not in the known-real allowlist. */
export function checkFabricatedInstitutionAcronyms(text) {
  const issues = [];
  if (typeof text !== 'string') return issues;

  const seen = new Set();
  const re = new RegExp(String.raw`(${INSTITUTION_NOUN}[^().\n]{0,80}?)\(([A-Z]{2,8})\)`, 'g');
  for (const m of text.matchAll(re)) {
    const [full, name, acronym] = m;
    if (KNOWN_INSTITUTION_ACRONYMS.has(acronym)) continue;
    if (seen.has(acronym)) continue;
    seen.add(acronym);

    if (FABRICATED_INSTITUTION_ACRONYMS.has(acronym)) {
      issues.push(issue(
        'fabricated-institution',
        'critical',
        `Ente inesistente: "${name.trim()} (${acronym})" — acronimo noto come inventato dal generatore`,
        full.trim(),
        `Rimuovi "${acronym}": non esiste. In materia fiscale federale svizzera l'ente reale è l'Amministrazione federale `
        + `delle contribuzioni (AFC/ESTV); l'imposta alla fonte è però amministrata a livello CANTONALE `
        + `("ufficio imposte alla fonte" del Cantone). Se il dato non ha una fonte verificabile, elimina l'attribuzione `
        + `e il dato insieme — non sostituire un ente inventato con un altro.`,
      ));
    } else {
      issues.push(issue(
        'unknown-institution',
        'major',
        `Ente non in allowlist: "${name.trim()} (${acronym})" — verificare che esista davvero`,
        full.trim(),
        `Verifica che "${acronym}" sia un ente reale e che il nome per esteso sia quello ufficiale. `
        + `Se non ne hai conferma nella fonte, togli l'acronimo e cita l'ente per esteso, o rimuovi l'attribuzione.`,
      ));
    }
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
// Deliberately excludes Accordo / Convenzione / Trattato. An international
// instrument legitimately carries a signature date, a ratification date and an
// entry-into-force date, all of which read as "promulgation" — that alone
// accounted for 116 of the 116 remaining false positives on the corpus
// ("Accordo Frontalieri" signed 23/12/2020, in force 1/1/2024, Bilaterali
// 1999 and 2001). Domestic decrees and laws have a single enactment date.
const NORM_RE = /((?:Decreto|Legge|Regolamento|Direttiva|Ordinanza)\s+[A-ZÀ-Ü][\wÀ-ü'-]*(?:\s+[A-ZÀ-Ü][\wÀ-ü'-]*)?)/g;

// A norm legitimately carries several dates — signature, entry into force,
// transposition, deadlines. Grouping any date near a norm name flagged the
// "Accordo Frontalieri" in 120 articles for correctly stating that it was
// signed in 2020 and took effect in 2024. So dates are grouped by PREDICATE:
// two different "was enacted on" dates for one norm is a contradiction, an
// enactment date plus an entry-into-force date is not.
const NORM_PREDICATES = [
  { key: 'promulgazione', re: /\b(?:varat\w+|approvat\w+|emanat\w+|promulgat\w+|firmat\w+|siglat\w+|adottat\w+)\b/i },
  { key: 'vigore', re: /\b(?:entrat\w+\s+in\s+vigore|in\s+vigore\s+dal?|vigenza|entrer[àa]\s+in\s+vigore|efficace\s+dal?)\b/i },
  { key: 'abrogazione', re: /\b(?:abrogat\w+|soppress\w+|decadut\w+)\b/i },
];

/** Flags one norm given two different dates for the SAME predicate. */
export function checkContradictoryNormDates(text) {
  const issues = [];
  if (typeof text !== 'string') return issues;

  // norm → predicate → Map(dateKey → context)
  const byNorm = new Map();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const norms = [...sentence.matchAll(NORM_RE)].map((m) => m[1].trim());
    if (!norms.length) continue;
    // A sentence carrying more than one predicate ("varato il X ed entrato in
    // vigore il Y") cannot have its dates attributed without parsing clause
    // structure, and guessing produces false contradictions. Skip it.
    const matching = NORM_PREDICATES.filter((p) => p.re.test(sentence));
    if (matching.length !== 1) continue;
    const predicate = matching[0];

    const dates = [...sentence.matchAll(DATE_IT_RE)].map((m) => ({
      key: `${m[3]}-${String(MONTHS_IT[m[2].toLowerCase()]).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`,
      raw: m[0],
    }));
    if (!dates.length) continue;

    for (const norm of new Set(norms)) {
      if (!byNorm.has(norm)) byNorm.set(norm, new Map());
      const byPredicate = byNorm.get(norm);
      if (!byPredicate.has(predicate.key)) byPredicate.set(predicate.key, new Map());
      for (const d of dates) byPredicate.get(predicate.key).set(d.key, { raw: d.raw, sentence: sentence.trim() });
    }
  }

  for (const [norm, byPredicate] of byNorm) {
    for (const [predicate, dateMap] of byPredicate) {
      if (dateMap.size < 2) continue;
      const entries = [...dateMap.values()];
      issues.push(issue(
        'contradictory-norm-dates',
        'critical',
        `"${norm}" ha ${dateMap.size} date di ${predicate} incompatibili: ${entries.map((e) => e.raw).join(' / ')}`,
        entries.map((e) => e.sentence).join(' ⟷ '),
        `Una norma ha UNA sola data di ${predicate}. Tieni solo quella confermata dalla fonte e correggi le altre. `
        + `Se le date si riferiscono a passaggi diversi (firma, entrata in vigore, scadenza di un adempimento), `
        + `scrivilo esplicitamente accanto a ciascuna invece di presentarle tutte come data della norma.`,
      ));
    }
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
      // The defect is presenting an old fact as breaking news, not covering an
      // old fact at all. An article that explicitly dates the event ("da gennaio
      // 2026 l'ufficio ha comunicato…") does not mislead the reader, so it is
      // reported but does not block. One that never names the period does.
      const srcMonth = Object.keys(MONTHS_IT).find((k) => MONTHS_IT[k] === src.getUTCMonth() + 1);
      const srcYear = src.getUTCFullYear();
      const datesTheFact = typeof text === 'string'
        && new RegExp(String.raw`${srcMonth}\s+${srcYear}`, 'i').test(text);

      issues.push(issue(
        'stale-source',
        datesTheFact ? 'major' : (ageDays > maxAgeDays * 3 ? 'critical' : 'major'),
        `Fonte del ${src.toISOString().slice(0, 10)} pubblicata come notizia il ${pub.toISOString().slice(0, 10)} `
        + `— ${ageDays} giorni di ritardo (max ${maxAgeDays})`
        + `${datesTheFact ? ' — il testo però data esplicitamente il fatto, quindi non fuorvia' : ''}`,
        '',
        `Non presentare la notizia come appena avvenuta. Colloca esplicitamente il fatto nel tempo `
        + `("secondo quanto comunicato nel ${src.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}"), `
        + `usa i tempi al passato per ciò che è già accaduto, e metti in evidenza ciò che è ancora attuale per il lettore `
        + `oggi (scadenze future, adempimenti ancora aperti). Se nulla è più attuale, l'articolo non va pubblicato.`,
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
        `${m[0]} è già passata: riscrivi al passato ("è entrato in vigore", "andava presentata entro"). `
        + `Se stai indicando una scadenza da rispettare, non può essere una data trascorsa — usa la scadenza `
        + `realmente ancora aperta indicata dalla fonte, oppure togli l'indicazione.`,
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

// All-caps tokens that are not institutions. Italian and Swiss news pages carry
// all-caps subheads, bylines and currency codes, and counting those as "source
// anchors" both dilutes genuine recall and can pad it past the threshold with
// noise that happens to survive into the article.
const STOP_TOKENS = new Set([
  '2026', '2025', '2024', '2023', '2022', '100', '000',
  // currencies and units
  'CHF', 'EUR', 'USD', 'GBP', 'IVA', 'KM', 'KG', 'MQ', 'ORE',
  // formats / tech / web furniture
  'PDF', 'HTML', 'URL', 'JPG', 'PNG', 'GIF', 'API', 'RSS', 'WWW', 'HTTP', 'HTTPS', 'CSS', 'XML',
  // company forms
  'SRL', 'SPA', 'SAGL', 'SNC', 'SAS', 'GMBH',
  // common all-caps editorial furniture
  'NEWS', 'VIDEO', 'FOTO', 'LIVE', 'HOME', 'MENU', 'LEGGI', 'ANCHE', 'TUTTI',
  'ANSA', 'ADN', 'REG', 'ART', 'CAP', 'TEL', 'FAX',
]);

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
      `Reintegra nel testo le percentuali ${missingPct.map((p) => `${p.slice(4)}%`).join(' e ')} spiegando a cosa si riferiscono, `
      + `come fa la fonte. NON rimuovere le altre cifre per "mettere a posto" l'articolo: il problema è che ne mancano, `
      + `non che ce ne siano troppe. Un'aliquota citata senza il suo termine di paragone è incomprensibile per il lettore.`,
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
      `Riscrivi ATTENENDOTI alla fonte e reintegra i dati mancanti: `
      + `${missing.slice(0, 10).map((a) => {
        const [kind, v] = a.split(':');
        if (kind === 'pct') return `${v}%`;
        if (kind === 'km') return `${v} km`;
        if (kind === 'date') return v;
        return v;
      }).join(', ')}. `
      + `Ogni dato della fonte è verificato: riportarlo è sempre corretto. Se un fatto ti sembra dubbio, `
      + `attribuiscilo alla fonte invece di ometterlo. Non sostituire i dati della fonte con formulazioni generiche.`,
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
    .map((i) => `  ${icon[i.severity] || '•'} [${i.code}] ${i.message}`
      + `${i.evidence ? `\n       ↳ ${i.evidence}` : ''}`
      + `${i.fix ? `\n       🔧 ${i.fix}` : ''}`)
    .join('\n');
}

/**
 * The fact-check prompt's category vocabulary — the single source of truth.
 *
 * create-article.mjs renders the prompt's "Categorie valide:" line from this
 * list, and REMEDIATION_BY_CATEGORY below is keyed on it. Keeping the two in
 * one place means a new category cannot silently ship without remediation text
 * (which would drop the "CORREZIONE RICHIESTA" line for those issues and give
 * the rewrite loop nothing to act on). A test asserts the two stay in sync.
 */
export const FACT_CHECK_CATEGORIES = [
  'leggi', 'istituzioni', 'aliquote', 'statistiche', 'date', 'coerenza',
  'fatti_inventati', 'persone', 'geografia', 'eu_svizzera', 'rilevanza_topica',
];

// Fallback remediation for LLM-verifier issues, which carry a free-text reason
// but no structured fix. Keyed on the checker's own category vocabulary.
const REMEDIATION_BY_CATEGORY = {
  leggi: 'Verifica estremo per estremo il riferimento normativo (tipo di atto, numero, anno) contro la fonte. '
    + 'Se la fonte non lo riporta, cita la norma solo come la nomina la fonte, senza aggiungere numeri o date che non ci sono.',
  istituzioni: "Usa il nome ufficiale dell'ente così come compare nella fonte. Non introdurre acronimi che la fonte non usa "
    + "e non attribuire un fatto a un ente diverso da quello citato (in particolare: non confondere un ufficio cantonale con uno federale).",
  aliquote: "Riporta l'aliquota esattamente come nella fonte, con il termine di paragone che la rende leggibile "
    + '(rispetto a cosa aumenta o diminuisce). Non arrotondare e non convertire una percentuale in un importo senza base esplicita.',
  statistiche: 'Ogni statistica deve essere attribuita a chi l\'ha prodotta e presente nella fonte. '
    + 'Se non lo è, rimuovi il numero e mantieni l\'affermazione qualitativa, senza inventare una cifra al suo posto.',
  date: 'Allinea le date alla fonte. Se la fonte non dà una data, non dedurla: descrivi il momento come fa la fonte.',
  coerenza: 'Riallinea il passaggio alla fonte. Se la fonte lo dice, riportalo (anche alla lettera); '
    + 'se non lo dice, toglilo. Non sostituirlo con una formulazione più vaga che dice la stessa cosa senza appoggio.',
  fatti_inventati: "Elimina l'episodio, la dichiarazione o il caso concreto: non risulta dalla fonte. "
    + 'Non rimpiazzarlo con un altro esempio inventato — se serve un esempio, presentalo come scenario esplicitamente ipotetico.',
  persone: 'Cita solo persone e ruoli presenti nella fonte, con il ruolo esatto che la fonte attribuisce loro.',
  geografia: 'Correggi il riferimento geografico: verifica da che parte del confine si trova ogni località citata '
    + "e che il ruolo (comune di residenza vs comune di lavoro) sia quello giusto.",
  eu_svizzera: 'La Svizzera non è membro UE né SEE. Riformula in termini di Accordi Bilaterali.',
  rilevanza_topica: 'Il nesso con il frontaliere Ticino-Italia deve essere reale e presente nella fonte. '
    + 'Se non c\'è, non forzarlo con paragrafi di consigli generici: l\'articolo non va scritto.',
  infra: 'La verifica non è stata eseguita: l\'articolo non può essere pubblicato in questo stato.',
};

/**
 * Renders issues as CORRECTIVE INSTRUCTIONS for the regeneration prompt.
 *
 * The regeneration loop used to receive a bare list of complaints. Faced with
 * "questo claim non è nella fonte" and no instruction, the writer's cheapest
 * move is deletion — which is how the 2026-07-28 article lost every real fact
 * it had and kept only the invented ones. Telling it exactly what to change,
 * with the corrected values, makes repair cheaper than removal.
 *
 * @param {object[]} issues
 * @param {{cap?: number}} [opts]
 */
export function formatRemediation(issues, opts = {}) {
  const cap = opts.cap ?? 8;
  const list = (issues || []).slice(0, cap);
  if (!list.length) return '';

  const lines = list.map((i, n) => {
    const what = i.message || i.reason || '';
    const how = i.fix || REMEDIATION_BY_CATEGORY[i.category] || '';
    const where = i.evidence || i.claim || '';
    return [
      `${n + 1}. PROBLEMA: ${what}`,
      where ? `   TESTO: "${String(where).slice(0, 180)}"` : '',
      how ? `   CORREZIONE RICHIESTA: ${how}` : '',
    ].filter(Boolean).join('\n');
  });

  const overflow = (issues || []).length > cap
    ? `\n(+${issues.length - cap} altri problemi dello stesso tipo: applica la stessa correzione a tutto il testo.)`
    : '';

  return `Il testo precedente è stato RESPINTO. Correggi i punti seguenti e restituisci l'articolo completo.

REGOLA GENERALE: correggi, non cancellare. Rimuovere un passaggio problematico invece di sistemarlo
peggiora l'articolo: i fatti della fonte devono restare, con i numeri giusti. Non accorciare il testo
per far passare i controlli, e non sostituire dati precisi con formule generiche.

${lines.join('\n\n')}${overflow}`;
}
