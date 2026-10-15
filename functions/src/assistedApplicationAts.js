/**
 * ATS check of a CV against a posting (extra "Punteggio ATS", owner decision
 * 2026-09-30), ported from career-ops (MIT): modes/ats.md + verify-ats.mjs
 * (structural parseability) and modes/pdf.md step 22 (keyword coverage).
 * Deterministic, no model. As in career-ops the two measures are never
 * blended, and neither is a gate ("advisory, not a gate"):
 *
 *   structural   0-100 + grade (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F) over
 *                what the CV text lets us measure: selectable text (15),
 *                standard headings (20), e-mail in the body (15), no text
 *                baked into images (10). career-ops also weighs single
 *                column (20), fonts (10), UTF-8 (5) and hidden text (5):
 *                they need the file's layout, so they are reported as "not
 *                checked" and the score is rescaled over the measured 60.
 *                Pass = score ≥ 70 and no critical issue.
 *   keywords     15-20 terms of the posting (most important requirements
 *                first) plus the role title as a phrase ("split only on
 *                commas, slashes, and the word 'and'"): present (twice or
 *                more), thin (once), missing.
 */

const IMPORTANCE_ORDER = { critical: 0, high: 1, meaningful: 2, medium: 2, preferred: 3, low: 4, low_signal: 5 };

// Words that carry no requirement on their own, in the four posting languages.
const STOPWORDS = new Set(`
a ad al alla alle anche avere buona buone buoni che come con conoscenza conoscenze da dei del della delle di e ed esperienza
gli il in la le lo nel nella o ottima ottime ottimo per più preferibilmente requisito su tra un una uno
aber als am an auch auf aus bei bzw das dem den der des die ein eine einem einen einer eines erfahrung für gute guten
im in ist kenntnisse mit nach oder sehr sowie und von vorteil wünschenswert zu zum zur
à au aux avec bonne bonnes bons ce dans de des du en est et expérience la le les ou par pour sur un une
an and as at be experience for good in is knowledge of on or strong the to with years year ans jahre anni
`.split(/\s+/).filter(Boolean));

// Section headings an ATS looks for, in it/de/fr/en.
const HEADINGS = {
  experience: /(esperienz[ae] (professional|lavorativ)|esperienze|berufserfahrung|beruflicher werdegang|werdegang|expérience(s)? professionnelle(s)?|parcours professionnel|work experience|professional experience|employment history|experience)/i,
  education: /(formazione|istruzione|studi|ausbildung|bildung|formation|études|education|qualifications)/i,
  skills: /(competenze|capacità|kenntnisse|fähigkeiten|kompetenzen|compétences|skills|sprachen|lingue|langues|languages)/i,
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+|00)\d{2}[\s\d/.-]{7,}|\b0\d{2}[\s/.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/;

export function normalizeText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+#./ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function gradeFor(score) {
  if (score === null) return null;
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

/**
 * @param {{cvText: string, cvMethod?: string}} input cvMethod as readCvText reports it ('ocr' = text read from images)
 */
export function structuralCheck({ cvText = '', cvMethod = '' }) {
  const text = String(cvText || '');
  const issues = [];
  let earned = 0;
  const fromImages = /ocr/i.test(cvMethod);

  if (text.replace(/\s+/g, ' ').trim().length >= 300 && !fromImages) earned += 15;
  else issues.push({ code: 'no_selectable_text', severity: 'critical' });

  const found = Object.fromEntries(Object.entries(HEADINGS).map(([key, pattern]) => [key, pattern.test(text)]));
  earned += Math.round((20 * Object.values(found).filter(Boolean).length) / 3);
  for (const [key, ok] of Object.entries(found)) {
    if (!ok) issues.push({ code: `missing_heading_${key}`, severity: key === 'experience' ? 'critical' : 'warning' });
  }

  if (EMAIL_RE.test(text)) earned += 15;
  else issues.push({ code: 'email_not_in_body', severity: 'warning' });
  if (!PHONE_RE.test(text)) issues.push({ code: 'phone_missing', severity: 'info' });

  if (!fromImages) earned += 10;
  else issues.push({ code: 'text_in_images', severity: 'critical' });

  const score = Math.round((100 * earned) / 60);
  return {
    score,
    grade: gradeFor(score),
    pass: score >= 70 && !issues.some((issue) => issue.severity === 'critical'),
    issues,
    notChecked: ['single_column', 'fonts', 'utf8', 'hidden_text'],
  };
}

/** The role title as phrases: split only on commas, slashes and "and" (und/e/et). */
export function titlePhrases(title) {
  return String(title || '').split(/,|\/|\s+(?:and|und|e|et)\s+/i)
    .map((part) => normalizeText(part.replace(/\([^)]*\)/g, '').replace(/\b\d{1,3}\s*[-–]?\s*\d{0,3}\s*%/g, '')))
    .filter((part) => part.length >= 3);
}

/**
 * Key terms of the posting: the words of each requirement that are not
 * stopwords (length ≥ 3, or a short token with a digit/symbol such as "C1",
 * "C#"), most important requirements first, deduplicated, 20 at most.
 */
export function postingKeywords(requirements, max = 20) {
  const ordered = [...(requirements || [])]
    .map((requirement, index) => ({ requirement, index }))
    .sort((left, right) => (IMPORTANCE_ORDER[left.requirement.importance] ?? 2) - (IMPORTANCE_ORDER[right.requirement.importance] ?? 2) || left.index - right.index);
  const seen = new Set();
  const out = [];
  for (const { requirement } of ordered) {
    for (const word of normalizeText(requirement.requirement).split(' ')) {
      const token = word.replace(/^[./]+|[./]+$/g, '');
      if (!token || STOPWORDS.has(token) || seen.has(token)) continue;
      if (token.length < 3 && !/[0-9+#]/.test(token)) continue;
      if (/^\d+$/.test(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Occurrences of a term: from a word start, so a German compound in the CV
 * ("Pflegefachfrau") contains the posting's shorter term ("pflege"); a short
 * term ("sap", "b2") only as a whole word, or "sap" would be found in
 * "sapere". "a/b" counts either form.
 */
export function countTerm(normalizedCv, term) {
  let count = 0;
  for (const part of term.split('/').filter((item) => item.length >= 2)) {
    const end = part.length <= 4 ? '(?![a-z0-9])' : '';
    count += (normalizedCv.match(new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(part)}${end}`, 'g')) || []).length;
  }
  return count;
}

/**
 * @param {{requirements: Array<{requirement:string, importance:string}>, roleTitle?: string, cvText: string, baselineText?: string}} input
 *   baselineText: the candidate's own CV, for a tailored text. Coverage alone rewards invention (study
 *   2026-10-02: 78% → 100% with Kubernetes and AWS made up), so a tailored CV is measured against its
 *   honest ceiling (idea of Resume-Matcher): `ceiling` is the coverage the original CV backs, `overCeiling`
 *   the posting's terms found only in the tailored text. The aim is coverage near the ceiling, nothing over it.
 */
export function keywordCoverage({ requirements = [], roleTitle = '', cvText = '', baselineText }) {
  const cv = ` ${normalizeText(cvText)} `;
  const keywords = postingKeywords(requirements);
  const present = [];
  const thin = [];
  const missing = [];
  for (const term of keywords) {
    const count = countTerm(cv, term);
    (count >= 2 ? present : count === 1 ? thin : missing).push(term);
  }
  const phrases = titlePhrases(roleTitle);
  const titleFound = phrases.length ? phrases.some((phrase) => cv.includes(` ${phrase} `) || cv.includes(` ${phrase}`)) : null;
  const percent = (count) => (keywords.length ? Math.round((100 * count) / keywords.length) : null);
  const honest = {};
  if (typeof baselineText === 'string') {
    const baseline = ` ${normalizeText(baselineText)} `;
    honest.ceiling = percent(keywords.filter((term) => countTerm(baseline, term) > 0).length);
    honest.overCeiling = [...present, ...thin].filter((term) => countTerm(baseline, term) === 0);
  }
  return {
    coverage: percent(present.length + thin.length),
    present,
    thin,
    missing,
    roleTitle: phrases.join(' / '),
    roleTitleFound: titleFound,
    ...honest,
  };
}

/** Both measures for one CV text, as the draft and the owner queue store them. */
export function atsReport({ requirements, roleTitle, cvText, cvMethod, baselineText }) {
  return {
    structural: structuralCheck({ cvText, cvMethod }),
    keywords: keywordCoverage({ requirements, roleTitle, cvText, baselineText }),
  };
}
