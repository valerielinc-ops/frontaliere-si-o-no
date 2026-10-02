/**
 * The candidate's own DOCX with the adapted lines written into it (phase 5 of
 * the CV and letter study, 2026-10-02, report-cv-lettera §3): an option for
 * the candidate who wants to keep their own layout, beside the Swiss template
 * CV. Styles, fonts, tables, photo and every paragraph not rewritten stay
 * byte for byte as the candidate wrote them.
 *
 * What the code allows, whatever the model wrote:
 *   - only paragraphs it fully understands are rewritten: plain runs of one
 *     formatting (a paragraph with inline bold, a field, a link or any tab
 *     keeps the CV's line: a tab aligns text the rewrite would move);
 *   - each adapted line goes to the paragraph of the highlight it rewrites
 *     (the anchor of phase 4, matched to the paragraph's text in code), only
 *     when one paragraph matches best: two paragraphs that match alike leave
 *     the line out; a line that rewrites no single highlight is not added;
 *   - dates, employers, role titles, headings and contact lines are locked;
 *   - the summary is rewritten only where the CV has one; the skills line is
 *     only reordered (the posting's skills first), never added to;
 *   - a length budget per line and for the whole page, then LibreOffice in
 *     the runner: a file whose pages were not counted is never sent;
 *   - text boxes, more than one column, tracked changes and SmartArt send the
 *     candidate back to the template CV: the layout cannot be kept safely.
 * Every text written here already passed the fact gate as part of the
 * tailored CV, or is the candidate's own words.
 */

import { normalizeText } from './assistedApplicationAts.js';
import { entryData, readZip, writeZip } from './lib/zipArchive.js';

export const INPLACE_KEY = 'ASSISTED_APPLICATION_DOCX_INPLACE';
export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DOCUMENT = 'word/document.xml';
const MAX_DOCUMENT_XML = 8 * 1024 * 1024;
const MAX_OWN_LINE = 300;
const MATCH = 0.8;
// Per line: 15% longer, or 12 characters, whichever is more; for the whole
// text: 3%, or 60 characters. Beyond, the CV's line is kept.
const LINE_GROWTH = 1.15;
const LINE_SLACK = 12;
const PAGE_GROWTH = 0.03;
const PAGE_SLACK = 60;

/** Whether the draft has the candidate's own Word file ready to send. */
export const inPlaceReady = (draft) => draft?.tailoredCv?.inplace?.status === 'ready' && Boolean(draft.tailoredCv.inplace.docxKey);

/** The CV the candidate chose ('tailored' | 'original' | 'inplace'), as the review page and the submission read it. */
export function cvChoiceOf(draft, flow) {
  if (flow?.cvChoice === 'original') return 'original';
  return flow?.cvChoice === 'inplace' && inPlaceReady(draft) ? 'inplace' : 'tailored';
}

/** The switch (Remote Config through the runner's environment): 'on' or 'off', off by default. */
export function docxInPlaceMode({ env = process.env } = {}) {
  return String(env[INPLACE_KEY] || '').trim().toLowerCase() === 'on' ? 'on' : 'off';
}

const BLOCKERS = [
  ['text_box', /<w:txbxContent\b|<v:textbox\b|<wps:txbx\b/],
  ['tracked_changes', /<w:(?:ins|del|moveFrom|moveTo|pPrChange|rPrChange|sectPrChange|tblPrChange)\b/],
  ['columns', /<w:cols\b[^>]*\bw:num="(?:[2-9]|\d{2,})"/],
];

/** The text of a DOCX's word/document.xml ('' when it cannot be read). */
export function documentXmlOf(docx) {
  try {
    const entry = readZip(docx).find((item) => item.name === DOCUMENT);
    return entry ? entryData(entry, MAX_DOCUMENT_XML).toString('utf8') : '';
  } catch {
    return '';
  }
}

/** Why the layout cannot be kept, or null. */
export function docxBlocker(xml, names = []) {
  for (const [reason, pattern] of BLOCKERS) if (pattern.test(xml)) return reason;
  if (names.some((name) => name.startsWith('word/diagrams/'))) return 'smartart';
  return null;
}

const decode = (text) => text
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// Characters XML 1.0 forbids are dropped, the rest escaped.
const escape = (text) => String(text)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PARAGRAPH = /<w:p\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:p>)/g;
const PARAGRAPH_PROPERTIES = /^\s*(<w:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:pPr>))/;
const PARAGRAPH_CHILD = /\s+|<w:r\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:r>)|<w:proofErr\b[^>]*\/>|(<w:bookmarkStart\b[^>]*\/>)|(<w:bookmarkEnd\b[^>]*\/>)/y;
const RUN_CHILD = /\s+|(<w:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:rPr>))|<w:t\b[^>]*?(?:\/>|>([^<]*)<\/w:t>)|(<w:tab\/>)|<w:lastRenderedPageBreak\/>/y;
const TEXT_PIECE = /<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g;
const STYLE = /<w:pStyle\b[^>]*\bw:val="([^"]*)"/;
const HEADING_STYLE = /heading|title|titolo|titre|berschrift|titel/i;
// A leading bullet or number written by hand, kept as it is.
const PREFIX = /^\s*(?:[•·▪●○■◦►✓\-–—*](?:\s|\t)*|\d{1,2}[.)](?:\s|\t)+)/;

function textOf(content) {
  let text = '';
  for (const match of content.matchAll(TEXT_PIECE)) {
    if (match[1] !== undefined) text += decode(match[1]);
    else text += match[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return text;
}

// Formatting that does not show: spelling language and proofing marks.
const shownFormatting = (rPr) => String(rPr || '').replace(/<w:lang\b[^>]*\/>|<w:noProof(?:\s[^>]*)?\/>/g, '').replace(/\s+/g, '')
  .replace(/^(?:<w:rPr\/>|<w:rPr><\/w:rPr>)$/, '');

/**
 * The runs of a paragraph made of plain text, else the reason it is not. `label`:
 * a label in its own formatting before text in one other formatting ("Tecniche:"
 * in bold before the list), whose runs a skills line keeps as they are.
 */
function plainRuns(body) {
  const runs = [];
  const bookmarks = { start: [], end: [] };
  PARAGRAPH_CHILD.lastIndex = 0;
  while (PARAGRAPH_CHILD.lastIndex < body.length) {
    const at = PARAGRAPH_CHILD.lastIndex;
    const match = PARAGRAPH_CHILD.exec(body);
    if (!match || match.index !== at) return { reason: 'structure' };
    if (match[3]) bookmarks.start.push(match[3]);
    else if (match[4]) bookmarks.end.push(match[4]);
    else if (match[0].startsWith('<w:r')) {
      const run = { xml: match[0], attributes: match[1] || '', rPr: '', text: '' };
      const content = match[2] || '';
      RUN_CHILD.lastIndex = 0;
      while (RUN_CHILD.lastIndex < content.length) {
        const start = RUN_CHILD.lastIndex;
        const part = RUN_CHILD.exec(content);
        if (!part || part.index !== start) return { reason: 'structure' };
        if (part[1]) run.rPr = part[1];
        else if (part[2] !== undefined) run.text += decode(part[2]);
        // A tab aligns the text after it (a date column, a hand-made bullet): never rewritten.
        else if (part[3]) return { reason: 'tab' };
      }
      runs.push(run);
    }
  }
  if (!runs.length) return { reason: 'empty' };
  const formats = runs.map((run) => shownFormatting(run.rPr));
  if (new Set(formats).size === 1) return { runs, bookmarks };
  const split = formats.findIndex((format) => format !== formats[0]);
  const label = runs.slice(0, split).map((run) => run.text).join('');
  const labelled = /\S:\s*$/.test(label) && label.length <= 42 && new Set(formats.slice(split)).size === 1;
  return { reason: 'mixed_formatting', ...(labelled ? { label: { runs, bookmarks, count: split, text: label } } : {}) };
}

/**
 * Every paragraph of document.xml with its text and whether it can be rewritten.
 * @returns {Array<{start:number, end:number, attributes:string, pPr:string, text:string, style:string, plain:object|null, reason:string|null}>}
 */
export function paragraphInventory(xml) {
  const out = [];
  for (const match of xml.matchAll(PARAGRAPH)) {
    const content = match[2] || '';
    const pPr = PARAGRAPH_PROPERTIES.exec(content)?.[1] || '';
    const body = content.slice(content.indexOf(pPr) + pPr.length);
    const plain = plainRuns(body);
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      attributes: match[1] || '',
      pPr,
      text: textOf(body),
      style: STYLE.exec(pPr)?.[1] || '',
      plain: plain.runs ? plain : null,
      label: plain.label || null,
      reason: plain.runs ? null : plain.reason,
    });
  }
  return out;
}

const words = (text) => new Set(normalizeText(text).split(' ').filter((word) => word.length >= 2));

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

const DATE = /\b(?:19|20)\d{2}\b|\b\d{1,2}[./-]\d{2,4}\b/;

/** Why a paragraph is locked (dates, employers, role titles, headings, contacts), or null. */
function lockOf(paragraph, locks) {
  if (HEADING_STYLE.test(paragraph.style)) return 'heading';
  if (DATE.test(paragraph.text)) return 'date';
  const text = ` ${normalizeText(paragraph.text)} `;
  if (locks.contacts.some((value) => text.includes(` ${value} `)) || /@/.test(paragraph.text)) return 'contact';
  if (locks.employers.some((value) => text.includes(` ${value} `))) return 'employer';
  // A role title locks the paragraph it heads, not a sentence that names the trade.
  if (locks.titles.some((value) => text.includes(` ${value} `) && text.length <= value.length + 32)) return 'title';
  return null;
}

function locksOf(profile = {}, identity = {}) {
  const usable = (values, min) => [...new Set(values.map((value) => normalizeText(value)).filter((value) => value.length >= min))];
  return {
    contacts: usable([profile.fullName, profile.email, profile.phone, identity.name, identity.email, identity.phone], 3),
    employers: usable((profile.experience || []).map((role) => role.employer), 3),
    titles: usable((profile.experience || []).map((role) => role.role), 4),
  };
}

/**
 * The paragraph that holds `original`: the one unused paragraph that matches
 * best, above the threshold. Two that match alike are ambiguous: neither.
 * @returns {{index:number, reason?:'no_paragraph'|'ambiguous'}}
 */
function anchorParagraph(paragraphs, used, original) {
  const target = words(String(original || '').replace(PREFIX, ''));
  if (target.size < 3) return { index: -1, reason: 'no_paragraph' };
  let best = -1;
  let bestScore = 0;
  let tied = false;
  paragraphs.forEach((paragraph, index) => {
    if (used.has(index)) return;
    const score = similarity(target, paragraph.words);
    if (score > bestScore) {
      best = index;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && best >= 0) {
      tied = true;
    }
  });
  if (best < 0 || bestScore < MATCH) return { index: -1, reason: 'no_paragraph' };
  return tied ? { index: -1, reason: 'ambiguous' } : { index: best };
}

const fits = (before, after) => after.length <= Math.max(Math.round(before.length * LINE_GROWTH), before.length + LINE_SLACK);

const DELIMITERS = [' · ', ' | ', ' • ', '; ', ', '];
const LABEL = /^([^:,;|•·]{1,40}:\s*)/;

/** The skills paragraph reordered with the posting's skills first, or null. */
function reorderedSkills(text, wanted, profileSkills) {
  const label = LABEL.exec(text)?.[1] || '';
  const list = text.slice(label.length);
  const delimiter = DELIMITERS.map((value) => [value, list.split(value).length - 1]).sort((a, b) => b[1] - a[1])[0];
  if (!delimiter || delimiter[1] < 2) return null;
  const items = list.split(delimiter[0]).map((item) => item.trim());
  if (items.some((item) => !item || item.length > 60)) return null;
  const known = new Set(profileSkills.map((skill) => normalizeText(skill)));
  if (items.filter((item) => known.has(normalizeText(item))).length < 3) return null;
  const rank = new Map(wanted.map((skill, index) => [normalizeText(skill), index]));
  const ordered = items.map((item, index) => ({ item, index, rank: rank.get(normalizeText(item)) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
  if (ordered.every((item, index) => item === items[index])) return null;
  return `${label}${ordered.join(delimiter[0])}`;
}

/**
 * The paragraph again with one run holding the new text, in the formatting it
 * had; a label's runs (`keep`) stay as they were, the text follows them.
 */
function rewrittenParagraph(paragraph, text, keep = 0) {
  const { runs, bookmarks } = keep ? paragraph.label : paragraph.plain;
  const first = runs[keep];
  const pieces = text.split('\t').map((piece) => (piece ? `<w:t xml:space="preserve">${escape(piece)}</w:t>` : ''));
  const kept = runs.slice(0, keep).map((run) => run.xml).join('');
  return `<w:p${paragraph.attributes}>${paragraph.pPr}${bookmarks.start.join('')}${kept}<w:r${first.attributes}>${first.rPr}${pieces.join('<w:tab/>')}</w:r>${bookmarks.end.join('')}</w:p>`;
}

function chosen(choice, adapted) {
  if (choice?.use === 'original') return '';
  if (choice?.use === 'own') return String(choice.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_OWN_LINE) || adapted;
  return adapted;
}

/**
 * @param {Buffer} docx the candidate's DOCX (a DOC converted by the runner)
 * @param {object} cv sanitizeTailoredCv's result
 * @param {{profile:object, identity?:object, choices?:object}} context choices: the candidate's line-by-line choices (phase 4)
 * @returns {{status:'ready', docx:Buffer, patched:string[], skipped:Array<{id:string, reason:string}>} | {status:'fallback', reason:string}}
 *   ready with nothing patched gives the candidate's file unchanged.
 */
export function buildInPlaceDocx(docx, cv, { profile = {}, identity = {}, choices = {} } = {}) {
  let entries;
  let xml;
  try {
    entries = readZip(docx);
    const document = entries.find((entry) => entry.name === DOCUMENT);
    if (!document || !entries.some((entry) => entry.name === '[Content_Types].xml')) return { status: 'fallback', reason: 'not_a_docx' };
    xml = entryData(document, MAX_DOCUMENT_XML).toString('utf8');
  } catch {
    // Not a ZIP Word wrote, a corrupt entry or one too large: the template CV.
    return { status: 'fallback', reason: 'unreadable' };
  }
  const blocker = docxBlocker(xml, entries.map((entry) => entry.name));
  if (blocker) return { status: 'fallback', reason: blocker };

  const paragraphs = paragraphInventory(xml).map((paragraph) => ({ ...paragraph, words: words(paragraph.text) }));
  const locks = locksOf(profile, identity);
  const used = new Set();
  const patches = [];
  const skipped = [];
  const place = (id, original, text) => {
    if (!text) return;
    const { index, reason: unplaced } = anchorParagraph(paragraphs, used, original);
    if (index < 0) return skipped.push({ id, reason: unplaced });
    used.add(index);
    const paragraph = paragraphs[index];
    const reason = paragraph.reason || lockOf(paragraph, locks);
    if (reason) return skipped.push({ id, reason });
    const prefix = PREFIX.exec(paragraph.text)?.[0] || '';
    const before = paragraph.text.slice(prefix.length);
    if (normalizeText(before) === normalizeText(text)) return undefined;
    if (!fits(before, text)) return skipped.push({ id, reason: 'too_long' });
    patches.push({ id, index, text: `${prefix}${text}`, growth: text.length - before.length });
  };

  if (cv?.summary) place('summary', profile.summary, chosen(choices.summary, cv.summary));
  for (const role of cv?.experience || []) {
    if (!role.rewritten) continue;
    for (const line of role.lines || []) {
      const text = chosen(choices[line.id], line.text);
      if (!text) continue;
      if (!line.original) skipped.push({ id: line.id, reason: 'no_anchor' });
      else place(line.id, line.original, text);
    }
  }
  if (Array.isArray(cv?.skills) && cv.skills.length) {
    const index = paragraphs.findIndex((paragraph, at) => !used.has(at) && (paragraph.plain || paragraph.label) && !lockOf(paragraph, locks)
      && reorderedSkills(paragraph.text, cv.skills, profile.skills || []));
    if (index >= 0) {
      const paragraph = paragraphs[index];
      const text = reorderedSkills(paragraph.text, cv.skills, profile.skills || []);
      used.add(index);
      if (paragraph.plain) patches.push({ id: 'skills', index, text, growth: 0 });
      // A label in its own formatting: its runs stay, the reordered list follows them.
      else if (text.startsWith(paragraph.label.text)) patches.push({ id: 'skills', index, text, keep: paragraph.label.count, growth: 0 });
    }
  }

  // The whole page: the lines that grow most give way first.
  const total = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  const budget = Math.max(PAGE_SLACK, Math.round(total * PAGE_GROWTH));
  let growth = patches.reduce((sum, patch) => sum + Math.max(0, patch.growth), 0);
  for (const patch of [...patches].sort((a, b) => b.growth - a.growth)) {
    if (growth <= budget || patch.growth <= 0) break;
    patches.splice(patches.indexOf(patch), 1);
    skipped.push({ id: patch.id, reason: 'page_budget' });
    growth -= patch.growth;
  }
  if (!patches.length) return { status: 'ready', docx: Buffer.from(docx), patched: [], skipped };

  let next = '';
  let at = 0;
  for (const patch of [...patches].sort((a, b) => a.index - b.index)) {
    const paragraph = paragraphs[patch.index];
    next += xml.slice(at, paragraph.start)
      + rewrittenParagraph(paragraph, patch.keep ? patch.text.slice(paragraph.label.text.length) : patch.text, patch.keep || 0);
    at = paragraph.end;
  }
  next += xml.slice(at);

  // Read back: same paragraphs, the new lines where they belong, nothing else changed.
  const after = paragraphInventory(next);
  const byIndex = new Map(patches.map((patch) => [patch.index, patch.text]));
  const intact = after.length === paragraphs.length && after.every((paragraph, index) => (byIndex.has(index)
    ? paragraph.text === byIndex.get(index).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    : paragraph.text === paragraphs[index].text));
  if (!intact) return { status: 'fallback', reason: 'verify_failed' };
  return {
    status: 'ready',
    docx: writeZip(entries, new Map([[DOCUMENT, Buffer.from(next, 'utf8')]])),
    patched: patches.map((patch) => patch.id),
    skipped,
  };
}
