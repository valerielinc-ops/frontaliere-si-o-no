/**
 * description-artifacts — the write-time clean-up every crawler description
 * goes through before it is stored (`writeJobsCrawlerSlice` in
 * scripts/assemble-jobs-dataset.mjs): artifact removal, then line-start
 * bullet recovery. Both are idempotent.
 *
 * Zero-dependency on purpose: crawler-retranslation-baseline.mjs hashes the
 * source text through these same two steps, and it is imported by
 * dedicated-crawler-common.mjs and the assembler, which crawler-template.mjs
 * itself imports. crawler-template.mjs re-exports both functions, so its
 * importers are unchanged.
 */

/**
 * Restore line-start bullet markers in job descriptions.
 *
 * The audit's `hasStructuredContent` requires bullets to be at line-start
 * (`/^\s*[-•*]\s/m`). HTML→text pipelines often produce inline bullets
 * (`Aufgaben: • Item • Item`) when downstream `normalizeSpace`/`stripHtml`
 * collapses newlines, OR multi-paragraph "list" sections (header followed
 * by ≥3 short consecutive lines) without explicit bullet markers.
 *
 * This helper:
 *   1. Inserts `\n` before every inline `•` (idempotent — already-line-start
 *      bullets are left alone).
 *   2. If still no line-start bullet found, scans for runs of ≥3 consecutive
 *      non-empty lines ≤200 chars (typical "PROFILE / Requirements" lists)
 *      and prepends `• ` to each item. The first short line of a run is
 *      treated as a section heading and left bullet-free.
 *
 * Idempotent: safe to call multiple times. Returns input unchanged when
 * structure is already present or input is empty/non-string.
 *
 * @param {string} text
 * @returns {string}
 */
// Common job-posting section headers across IT/DE/FR/EN. When these appear
// inline inside a flattened description, we insert a paragraph break so the
// text-to-list normalizer below has line boundaries to work with.
const SECTION_HEADER_PATTERNS = [
  // German (Swiss federal job postings — jobs.admin.ch, Prospective.ch JobBooster)
  /\b(Diesen Beitrag kannst du leisten|Das macht dich einzigartig|Das bieten wir|Dein Einsatz für Sicherheit und Freiheit|Ihre Aufgaben|Ihr Profil|Wir bieten|Anforderungen|Aufgaben|Ihre Hauptaufgaben|Ihre Verantwortung|Was Sie erwartet|Was wir bieten|Ihre Qualifikationen|Ihr neues Aufgabengebiet)\b/g,
  // Italian (EOC, AIL, etc.)
  /\b(Le sue mansioni|Le tue mansioni|I suoi compiti|I tuoi compiti|Il profilo richiesto|Profilo richiesto|Profilo ricercato|Requisiti necessari|Requisiti richiesti|Requisiti|Offriamo|Cosa offriamo|Le sue responsabilità|Le tue responsabilità|Cosa farà|Mansioni principali|Competenze richieste|Cerchiamo|Stiamo cercando)\b/g,
  // French
  /\b(Vos tâches|Vos missions|Votre mission|Votre profil|Nous offrons|Nous proposons|Vos responsabilités|Vos compétences|Profil recherché|Exigences|Compétences requises)\b/g,
  // English
  /\b(Your responsibilities|Your tasks|Your profile|We offer|What we offer|Requirements|Qualifications|What you'll do|What you bring|Job description|Profile|Responsibilities)\b/g,
];

export function normalizeDescriptionBullets(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // 1. Inline ' • ' → '\n• ' (only when not already line-start)
  out = out.replace(/([^\n\r])[ \t]+•[ \t]+/g, '$1\n• ');
  if (/^\s*[-•*]\s/m.test(out)) return out;

  // 2. When the text is a single-line/long paragraph blob, try to split at
  // known section-header phrases (DE/IT/FR/EN) so the run-detector below has
  // line boundaries. We insert '\n• ' BEFORE the header so the header itself
  // becomes a line-start bulleted item — that satisfies the audit and keeps
  // the original wording intact.
  for (const pattern of SECTION_HEADER_PATTERNS) {
    out = out.replace(pattern, (match, _g1, offset, src) => {
      // Don't double-insert if already at line start
      const prevChar = offset > 0 ? src[offset - 1] : '\n';
      if (prevChar === '\n') return match;
      return `\n• ${match}`;
    });
  }
  if (/^\s*[-•*]\s/m.test(out)) return out;

  // 2. Detect runs of ≥3 consecutive non-empty short lines (≤200 chars)
  const lines = out.split(/\n/);
  const inRun = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t || t.length > 200) { i++; continue; }
    let j = i;
    while (j < lines.length) {
      const tj = lines[j].trim();
      if (!tj || tj.length > 200) break;
      j++;
    }
    if (j - i >= 3) {
      for (let k = i; k < j; k++) inRun[k] = true;
    }
    i = j;
  }

  // First short line of a run = section heading; leave bullet-free.
  let prevWasInRun = false;
  for (let k = 0; k < lines.length; k++) {
    if (!inRun[k]) { prevWasInRun = false; continue; }
    const t = lines[k].trim();
    if (!prevWasInRun && t.length <= 35 && !/[.!?]$/.test(t)) {
      // section heading — keep as-is
      prevWasInRun = true;
      continue;
    }
    lines[k] = lines[k].replace(t, '• ' + t);
    prevWasInRun = true;
  }
  return lines.join('\n');
}

/**
 * Drop the empty bold spans of ONE line (`** **`, `** : **`, `** - **`).
 *
 * Markers pair up left to right, so only the text BETWEEN an opening marker and
 * its closing one is judged. The single regex this replaces matched ANY two
 * markers with nothing but blanks or punctuation between them, which is also
 * the gap between the end of one bold span and the start of the next:
 * `**a**, **b**` became `**a b**`, and — `\s` crosses line breaks — a line
 * ending in bold swallowed the bold-labelled line after it (a section title
 * and its first bullet came out as one line in `data/jobs.json`). Same step as
 * `dropEmptyBoldSpans` in `build-plugins/shared/jobDescription/parser.ts` and
 * as `scripts/lib/free-translate.mjs`; this module cannot import TypeScript, so
 * `tests/empty-bold-spans-parity.test.ts` holds the three together.
 */
function dropEmptyBoldSpansInLine(line) {
  const parts = line.split('**');
  if (parts.length < 3) return line;
  let out = parts[0];
  for (let index = 1; index < parts.length; index += 2) {
    const content = parts[index];
    if (index + 1 >= parts.length) {
      // Opening marker with no closing one on this line: step 1a decides.
      out += `**${content}`;
      break;
    }
    out += /^[\s:;,.\-–—]*$/u.test(content) ? ' ' : `**${content}**`;
    out += parts[index + 1];
  }
  return out;
}

/**
 * Idempotent clean-up of crawler artifacts in job descriptions. Runs at
 * assemble-time (`scripts/assemble-jobs-dataset.mjs`) alongside
 * `normalizeDescriptionBullets`. Defensive against malformed input from
 * AI translation: drops empty `**...**` bolds, strips standalone separator
 * lines (`______`, `=====`), strips trailing inline separator runs, and
 * dedupes consecutive identical paragraphs.
 *
 * Mirrors the runtime parser in `build-plugins/shared/jobDescription/parser.ts`
 * but operates on raw text BEFORE the renderer parses. Cleaning here keeps
 * the assembled dataset (`data/jobs.json`) tidy without rewriting every
 * by-crawler source file.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanCrawlerArtifacts(text) {
  if (!text || typeof text !== 'string') return text;
  let s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1. Drop empty / whitespace-only bolds (e.g. "** **", "**  **", "** : **"),
  // one line at a time: see `dropEmptyBoldSpansInLine`.
  s = s.split('\n').map(dropEmptyBoldSpansInLine).join('\n');
  // 1a. Odd `**` count (source truncated the closing marker) survives the
  // pair-matching replace above untouched — same gap guarded in the runtime
  // parser (build-plugins/shared/jobDescription/parser.ts) and
  // free-translate.mjs; mirrored here so a stray marker can't reach
  // data/jobs.json even before any renderer runs (#4553).
  const doubleStars = (s.match(/\*\*/g) || []).length;
  if (doubleStars % 2 !== 0) {
    s = s.replace(/\*\*/g, '');
  }

  // 1b. Convert mid-line separator runs (3+ `_`/`=`/`~`) to paragraph breaks.
  // AI-translation flattening occasionally collapses paragraph boundaries
  // around visual dividers, producing patterns like
  // `Ref.: HFR-M-251801 _______________________________________ Le Département…`
  // on a single line. Step 2 below only catches WHOLE separator-only lines,
  // step 3 only TRAILING runs — neither catches mid-line. Splitting here
  // restores the original paragraph structure so the rest of the pipeline
  // (and audit:no-literal-markdown, CLAUDE.md rule #1, 0-tolerance) stays
  // clean even when the runtime parser is bypassed. Was `{6,}` — stale vs.
  // the `{3,}` threshold `scripts/audit-no-literal-markdown.mjs`
  // (SEPARATOR_RUN_RE) and every other stripper in this codebase
  // (jobDescription/parser.ts, jobDescription/toHtml.ts,
  // jobsSeoPagesPlugin.ts) actually use, so a 3-5 char mid-line run leaked
  // through unconverted (audit regression #4593, sibling-pattern fix per
  // CLAUDE.md non-negotiable #6).
  s = s.replace(/[_=~]{3,}/g, '\n\n');

  // 2. Strip standalone separator-only lines ("______", "===", "----")
  s = s
    .split('\n')
    .filter((line) => !/^[\s_\-=*•·~]{3,}$/.test(line))
    .join('\n');

  // 3. Strip trailing inline separator runs ("Be part of something. ______")
  s = s
    .split('\n')
    .map((line) => line.replace(/\s+[_\-=~*]{3,}\s*$/g, '').trimEnd())
    .join('\n');

  // 4. Truncate at first inline JS widget signature. SAP SF, TYPO3 ke_search,
  // Freeform widgets and similar parsers occasionally leak `<script>` content
  // when callers strip tags without first deleting `<script>...</script>`
  // blocks. The body text starts with the JS source which the
  // validate-jobs-quality gate flags as code_in_description. Cut everything
  // from that boundary onward — defensive mirror of stripHtml() above.
  {
    const fnMatch = s.match(/(?:\n|^|\s)(?:\/\/\s*<!\[CDATA\[|\$\(|jQuery\(|function\s+\w*\s*\(|\(function\s*\()/);
    if (fnMatch && fnMatch.index > 0) s = s.slice(0, fnMatch.index).trimEnd();
    const varMatch = s.match(/(?:\n|^|\s)(?:const|let|var)\s+\w+\s*=\s*(?:window|document|new\s+Object|\{|\[|document\.querySelectorAll|new\s+XMLHttpRequest)/);
    if (varMatch && varMatch.index > 0) s = s.slice(0, varMatch.index).trimEnd();
  }

  // 5. Dedup consecutive identical paragraphs (Panoramica/Descrizione artifact)
  const paragraphs = s.split(/\n{2,}/);
  const out = [];
  const norm = (p) =>
    p
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const seen = new Set();
  for (const p of paragraphs) {
    const t = p.trim();
    if (!t) continue;
    const key = norm(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }

  return out.join('\n\n');
}
