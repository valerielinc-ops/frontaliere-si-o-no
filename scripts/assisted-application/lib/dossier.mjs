/**
 * How an e-mail application's files leave (decisions of 2026-10-03 on the verified sources:
 * docs/assisted-application/decisioni.md §5).
 *   default    the CV and the letter as two separate, named PDFs: the official adult texts that
 *              say how to send them keep them apart (SECO leaflet, Basel-Stadt, St. Gallen, Zürich). The federal
 *              brochure's «one document» sentence is about the certificates kept ready for a later
 *              request, not about merging letter and CV;
 *   documents  never one file each: two files or more of the requested documents leave as one PDF
 *              after the CV and the letter (Beilagen_/Annexes_/Allegati_/Enclosures_ + name), within
 *              3 MB; one file leaves as it is;
 *   the ad     the posting's own instruction wins (adPackaging): one PDF → letter, CV and documents
 *              merged whatever the switch and the candidate type, within 3 MB; separate files →
 *              nothing merged, the documents included;
 *   the switch ASSISTED_APPLICATION_DOSSIER_MODE = "single" (Remote Config, default "separate") merges
 *              letter, CV and documents for the candidate types qualified and first_job, never an
 *              apprentice nor a draft without a type, within 5 pages and 2 MB. The sources do not
 *              support one PDF as the default: it stays off.
 * A merged PDF carries a title and the candidate as author (no producer of the library), shows a
 * photographed page upright, and is checked before it leaves: it reopens, it has the pages of its
 * parts, a merged letter keeps its text. Whatever cannot be merged, passes a limit or fails the check
 * leaves as separate files, and the reason goes into the record of the send (lib/submit.mjs `sent`).
 * A digitally signed PDF is never merged (its signature would no longer verify): it leaves as it is,
 * after the merged file.
 * MB as the rest of the code counts them: 1024 × 1024 bytes.
 */

import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import { jpegIsWhole } from '../../../functions/src/assistedApplicationTailoredCvPdf.js';

export const DOSSIER_KEY = 'ASSISTED_APPLICATION_DOSSIER_MODE';
export const DOSSIER_LIMITS = Object.freeze({ pages: 5, bytes: 2 * 1024 * 1024 });
const DOSSIER_LABEL = { de: 'Bewerbungsdossier', fr: 'Dossier_de_candidature', it: 'Dossier_di_candidatura', en: 'Application' };
const A4 = [595.28, 841.89];

/** "single" only when the switch says so: the default keeps the separate files. */
export function dossierMode(env = process.env) {
  return String(env[DOSSIER_KEY] || '').trim().toLowerCase() === 'single' ? 'single' : 'separate';
}

// The draft's type of application as a string, read in one place with the letter's rebuild.
export { draftCandidateType } from '../../../functions/src/assistedApplicationCandidateType.js';

/** Never for an apprentice, nor for a draft whose type is unknown. */
export function wantsDossier({ mode, channelType, candidateType }) {
  return mode === 'single' && channelType === 'email' && Boolean(candidateType) && candidateType !== 'apprentice';
}

// Any other merged file (the one PDF an ad asks for, the grouped documents): the ceiling of one attachment
// in the cantonal guides (3 MB); an ad's one PDF has no page cap.
export const MERGED_MAX_BYTES = 3 * 1024 * 1024;
const MERGED_LIMITS = Object.freeze({ pages: Infinity, bytes: MERGED_MAX_BYTES });
const DOSSIER_TITLE = { de: 'Bewerbungsdossier', fr: 'Dossier de candidature', it: 'Dossier di candidatura', en: 'Application' };
// The grouped documents' file name and title. Not the letter's ENCLOSURES_LABEL
// (assistedApplicationAiDraftCore.js): that one follows the number of enclosures.
const DOCUMENTS_LABEL = { de: 'Beilagen', fr: 'Annexes', it: 'Allegati', en: 'Enclosures' };
const MERGEABLE = new Set(['pdf', 'jpg', 'png']);
const MARGIN = 28;
const typeOf = (name = '') => (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase().replace('jpeg', 'jpg');

// ── The posting's own instruction on the files (decision 2) ────────────────────────
/** Case-insensitive, bounded by letters or digits of any script (JS \b treats "é" as a non-word character). */
const bounded = (source, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, flags);
const anyOf = (sources) => bounded(sources.join('|'), 'giu');

// One file for everything: ein PDF, in einem (einzigen) PDF, eine einzige Datei; un seul (fichier) PDF,
// un seul document; un unico (file) PDF, un solo PDF, un unico documento; one PDF, a single PDF/file.
const SINGLE_CUE = anyOf([
  String.raw`(?:ein|eine|einem|einer)\s+(?:(?:einzige[nmrs]?|einzelne[nmrs]?|zusammenh[äa]ngende[nmrs]?|zusammengefasste[nmrs]?|gesamte[nmrs]?)\s+)?pdf(?:-(?:datei|dokument|dossier))?`,
  String.raw`(?:eine|einer)\s+(?:einzige[nmrs]?|einzelne[nmrs]?)\s+(?:pdf-)?datei`,
  String.raw`(?:in\s+einem\s+(?:einzigen\s+)?|ein\s+einziges\s+)dokument`,
  String.raw`un\s+seul\s+(?:et\s+m[êe]me\s+)?(?:fichier(?:\s+pdf)?|pdf|document(?:\s+pdf)?)`,
  String.raw`un\s+(?:fichier|document|pdf)\s+unique`,
  String.raw`un\s+(?:unico|solo|singolo)\s+(?:file(?:\s+pdf)?|pdf|documento(?:\s+pdf)?)`,
  String.raw`un\s+(?:file|documento|pdf)\s+unico`,
  String.raw`(?:one(?:\s+single)?|a\s+single)\s+(?:(?:combined|merged)\s+)?(?:pdf(?:\s+(?:file|document))?|file|document)`,
]);
// Separate files: separat, einzeln, getrennt; séparé(s), distinct(s); separati, singoli; separate, individual files.
// An adjective counts with the files it qualifies; a number of files says the same.
const SEPARATE_CUE = anyOf([
  String.raw`(?:separate[nmrs]?|einzelne[nmrs]?|getrennte[nmrs]?)\s+(?:pdf-dateien|pdf-dokumente|pdfs|dateien|dokumente|anh[äa]nge|anlagen|beilagen)`,
  String.raw`(?:fichiers|documents|pi[èe]ces(?:\s+jointes)?|pdfs?|annexes)\s+(?:s[ée]par[ée]e?s|distincte?s|individuel(?:le)?s)`,
  String.raw`(?:file|documenti|allegati|pdf)\s+(?:separati|distinti|singoli)`,
  String.raw`(?:singoli|separati|distinti)\s+(?:file|documenti|allegati|pdf)`,
  String.raw`(?:separate|individual|distinct)\s+(?:pdfs?|files?|documents?|attachments?)`,
  String.raw`(?:zwei|drei|mehrere|deux|trois|plusieurs|due|tre|pi[uù]|two|three|several|multiple)\s+(?:(?:separate[nmrs]?|getrennte[nmrs]?|separate)\s+)?(?:pdf(?:-dateien|s)?|dateien|dokumente|fichiers|file|documenti|files|documents)`,
]);
// An adverb counts in a sentence that names files (not "individually": «an individually tailored CV»).
const SEPARATE_ADVERB = anyOf([String.raw`separat|einzeln|getrennt|s[ée]par[ée]ment|separatamente|singolarmente|separately`]);
const FILES = bounded(String.raw`(?:unterlage|dokument|datei|zeugnis|beilage|anh[äa]ng|document|fichier|pi[èe]ce|annexe|certificat|allegat|attachment|certificate)\p{L}*|lebenslauf|files?|pdfs?|cv`);
// The application as a whole.
const WHOLE = bounded(String.raw`bewerbung(?:en)?|bewerbungsunterlagen|bewerbungsdossier|unterlagen|dossier|s[äa]mtliche[nmrs]?|alle[nmrs]?|vollst[äa]ndige[nmrs]?|komplette[nmrs]?|candidature|tous|toutes|l['’]ensemble|candidatura|documentazione|tutti|tutte|tutto|tutta|applications?|all|everything|complete|entire|whole`);
const CV = bounded(String.raw`lebenslauf|cv|curriculum|r[ée]sum[ée]|resume`);
const LETTER = bounded(String.raw`motivationsschreiben|anschreiben|bewerbungsschreiben|begleitschreiben|begleitbrief|lettre|lettera|letter`);
// A file of the enclosures only («ein PDF mit Ihren Zeugnissen», «one PDF with your certificates»).
const ENCLOSURES_AFTER = new RegExp(String.raw`^\s*(?:mit|with|avec|con|containing|contenant|contenente)\s+(?:\p{L}+\s+){0,3}?(?:zeugnis|diplom|beilage|nachweis|certificat|dipl[ôo]m|attestat|certificate|diploma|reference|transcript|pagell|bulletin)`, 'iu');
const NEGATION = bounded(String.raw`nicht|kein(?:e[nmrs]?)?|ohne|nie|niemals|pas|jamais|sans|non|senza|nessun[aoe]?|no|not|never|without|\p{L}+n['’]t`);
// «Sie können … auch», «possono essere inviati»: a permission, not an instruction.
const PERMISSION = bounded(String.raw`k[öo]nnen|kann|d[üu]rfen|darf|possono|pu[oò]|puoi|potete|peuvent|peut|pouvez|can|may`);
const DISTRIBUTIVE_BEFORE = bounded(String.raw`jeweils|je|jede[nmrs]?|chaque|chacun(?:e)?|ciascun[aoe]?|ogni|each|every`);
const DOCUMENT_NOUN = String.raw`(?:dokument|unterlage|datei|zeugnis|diplom|beilage|document|fichier|pi[èe]ce|annexe|certificat|documento|allegato|certificato|file|attachment|certificate|diploma)\p{L}*`;
// «ein PDF pro Dokument», «un PDF per ogni documento», «one PDF each»; never «per e-mail», «par e-mail».
const DISTRIBUTIVE_AFTER = new RegExp(String.raw`^\s*(?:each\b|(?:pro|per|par|je|f[üu]r|pour|for)\s+(?:(?:jede[nmrs]?|chaque|ogni|ciascun[oa]?|each|every)\s+)?${DOCUMENT_NOUN})`, 'iu');
// «separately for each position», «für jede Stelle separat»: one application per post, not the files.
const EACH_AFTER = /^\s*(?:for|f[üu]r|pour|per)\s+(?:each|every|jede[nmrs]?|chaque|ogni|ciascun[oa]?)(?![\p{L}])/iu;
// «einzeln oder gesammelt»: a choice, not an instruction.
const CHOICE_AFTER = /^\s*(?:oder|or|ou|o|oppure|bzw\.?)\s/iu;
const CHOICE_BEFORE = /(?<![\p{L}])(?:oder|or|ou|o|oppure|bzw\.?)\s*$/iu;
// «maximal zwei Dateien»: a limit, not an instruction to split.
const LIMIT_BEFORE = bounded(String.raw`max(?:imal|imum)?\.?|h[öo]chstens|bis\s+zu|au\s+plus|jusqu['’][àa]|al\s+massimo|fino\s+a|at\s+most|up\s+to`);
// A sentence ends after a word of two letters or more that is no abbreviation (never "z. B.", "max.", "etc."), at a semicolon, at a line break.
const SENTENCE_END = /(?<=(?<![\p{L}])(?!(?:etc|bzw|inkl|usw|evtl|ggf|max|min|ca|vgl|resp|ecc|env|nr|no|réf|rif|dipl|lic)[.])\p{L}{2,}[.!?])\s+|;\s*|\n+/iu;
// A clause ends at a comma, a colon, a bracket or a "but".
const CLAUSE_END = /[,:()]|(?<![\p{L}])(?:sondern|aber|jedoch|mais|ma|bens[iì]|but|instead)(?![\p{L}])/iu;
const normalized = (text) => String(text || '').normalize('NFC').replace(/[’‘`´]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
const clauseBefore = (sentence, index) => sentence.slice(0, index).split(CLAUSE_END).pop() || '';
const lastWords = (text, count) => text.trim().split(/\s+/).filter(Boolean).slice(-count).join(' ');

/**
 * What the posting says about the files: one PDF, separate files, or nothing clear (the default applies).
 * Only a sentence the posting holds counts (the model copies the instructions and verifyQuotes does not
 * check them); a negated cue, a permission, one per document, a choice, or both kinds at once say nothing clear.
 * @returns {{instruction:'single'|'separate'|'', cue:string}}
 */
export function classifyAdPackaging(instructions, postingText) {
  const posting = normalized(postingText);
  let single = '';
  let separate = '';
  for (const raw of String(instructions || '').split(SENTENCE_END)) {
    const sentence = raw.trim();
    // As verifyQuotes checks a quote: whitespace and case aside, the posting holds it (end punctuation aside).
    const quoted = normalized(sentence).replace(/[\s.!?;:,]+$/u, '');
    if (!quoted || !posting.includes(quoted)) continue;
    for (const match of sentence.matchAll(SINGLE_CUE)) {
      const clause = clauseBefore(sentence, match.index);
      const after = sentence.slice(match.index + match[0].length);
      const before = lastWords(clause, 6);
      if (NEGATION.test(before) || PERMISSION.test(before) || DISTRIBUTIVE_BEFORE.test(lastWords(clause, 3)) || DISTRIBUTIVE_AFTER.test(after)) continue;
      const whole = WHOLE.test(sentence) || (CV.test(sentence) && LETTER.test(sentence) && !ENCLOSURES_AFTER.test(after));
      if (whole) single ||= match[0];
    }
    const cues = [...sentence.matchAll(SEPARATE_CUE)];
    for (const match of sentence.matchAll(SEPARATE_ADVERB)) {
      if (FILES.test(sentence)) cues.push(match);
    }
    for (const match of cues) {
      const clause = clauseBefore(sentence, match.index);
      const after = sentence.slice(match.index + match[0].length);
      const before = lastWords(clause, 6);
      if (NEGATION.test(before) || PERMISSION.test(before) || LIMIT_BEFORE.test(lastWords(clause, 2)) || DISTRIBUTIVE_BEFORE.test(lastWords(clause, 3))
        || CHOICE_AFTER.test(after) || CHOICE_BEFORE.test(clause) || EACH_AFTER.test(after)) continue;
      separate ||= match[0];
    }
  }
  if (single && !separate) return { instruction: 'single', cue: single.slice(0, 80) };
  if (separate && !single) return { instruction: 'separate', cue: separate.slice(0, 80) };
  return { instruction: '', cue: '' };
}

/** The posting's instruction on the files, from the words the draft kept, checked against the posting text. */
export function adPackaging(draft) {
  return classifyAdPackaging(draft?.applicationInstructions || draft?.requirementsRaw?.applicationInstructions || '', draft?.factSources?.posting || '');
}

/**
 * How the files should leave, before anything is merged: the ad first (whatever the switch and the
 * type), then the switch for qualified and first_job candidates, else the separate files.
 * @param {{mode:string, candidateType:string, ad:''|'single'|'separate'}} input
 * @returns {{want:'single'|'separate', reason:string, limits?:{pages:number, bytes:number}}}
 */
export function packagingDecision({ mode, candidateType, ad }) {
  if (ad === 'single') return { want: 'single', reason: 'ad_single', limits: MERGED_LIMITS };
  if (ad === 'separate') return { want: 'separate', reason: 'ad_separate' };
  if (wantsDossier({ mode, channelType: 'email', candidateType })) return { want: 'single', reason: 'switch', limits: DOSSIER_LIMITS };
  return { want: 'separate', reason: mode === 'single' && candidateType === 'apprentice' ? 'apprentice' : 'default' };
}

/**
 * A digitally signed PDF: a signature dictionary (/ByteRange with its /Contents hex string) or the
 * AcroForm's /SigFlags. A signature covers the file's own bytes, so inside another PDF it no longer
 * verifies. The dictionary is never compressed (/ByteRange leaves out the bytes of /Contents in the
 * file as stored), so the bytes as stored tell.
 */
export function isSignedPdf(buffer) {
  const text = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)).toString('latin1');
  return /\/SigFlags\b/.test(text) || (/\/ByteRange\s*\[/.test(text) && /\/Contents\s*</.test(text));
}

/** EXIF orientation (1-8) of a JPEG as a phone writes it (APP1 «Exif», IFD0 tag 0x0112); 1 when absent or unreadable. */
export function jpegOrientation(buffer) {
  try {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return 1;
    let offset = 2;
    while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1];
      if (marker === 0xda || marker === 0xd9) break; // start of scan, end of image
      const length = buffer.readUInt16BE(offset + 2);
      if (marker === 0xe1 && buffer.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
        const tiff = offset + 10;
        const little = buffer.toString('latin1', tiff, tiff + 2) === 'II';
        const u16 = (at) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
        const u32 = (at) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
        const ifd = tiff + u32(tiff + 4);
        for (let index = 0, count = u16(ifd); index < count; index += 1) {
          const entry = ifd + 2 + index * 12;
          if (u16(entry) === 0x0112) { const value = u16(entry + 8); return value >= 1 && value <= 8 ? value : 1; }
        }
        return 1;
      }
      offset += 2 + length;
    }
  } catch { /* a malformed header: drawn as stored */ }
  return 1;
}
// The image's unit square onto the box (x, y, w, h), shown as the EXIF orientation says.
function orientationMatrix(orientation, x, y, w, h) {
  switch (orientation) {
    case 2: return [-w, 0, 0, h, x + w, y];
    case 3: return [-w, 0, 0, -h, x + w, y + h];
    case 4: return [w, 0, 0, -h, x, y + h];
    case 5: return [0, -h, -w, 0, x + w, y + h];
    case 6: return [0, -h, w, 0, x, y + h];
    case 7: return [0, h, w, 0, x, y];
    case 8: return [0, h, -w, 0, x + w, y];
    default: return [w, 0, 0, h, x, y];
  }
}

// A JPG or PNG on a page of its own: upright, a landscape image on a landscape A4, scaled down to the
// margins, never enlarged. The image bytes go in as they are; a JPG cut on the way would embed without
// an error and print half grey, so it is refused (jpegIsWhole, the photo's check).
async function addImagePage(merged, part) {
  if (part.type === 'jpg' && !jpegIsWhole(part.buffer)) throw new Error('jpeg_cut');
  const image = part.type === 'jpg' ? await merged.embedJpg(part.buffer) : await merged.embedPng(part.buffer);
  const orientation = part.type === 'jpg' ? jpegOrientation(part.buffer) : 1;
  const [width, height] = orientation >= 5 ? [image.height, image.width] : [image.width, image.height];
  const size = width > height ? [A4[1], A4[0]] : A4;
  const scale = Math.min((size[0] - 2 * MARGIN) / width, (size[1] - 2 * MARGIN) / height, 1);
  const w = width * scale;
  const h = height * scale;
  const page = merged.addPage(size);
  const name = page.node.newXObject('Image', image.ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...orientationMatrix(orientation, (size[0] - w) / 2, (size[1] - h) / 2, w, h)), drawObject(name), popGraphicsState());
}

/**
 * The parts in order as one PDF, with a title and an author and no producer of the library.
 * @param {Array<{buffer:Buffer, type:string}>} parts
 * @returns {Promise<{pdf:Buffer, pages:number, expectedPages:number}|null>} null when a part is not a PDF,
 *   a JPG or a PNG; throws on an encrypted, broken or cut part
 */
export async function mergeParts(parts, { title = '', author = '', nowMs = Date.now() } = {}) {
  if (parts.some((part) => !MERGEABLE.has(part.type))) return null;
  const merged = await PDFDocument.create({ updateMetadata: false });
  let expectedPages = 0;
  for (const part of parts) {
    if (part.type === 'pdf') {
      const source = await PDFDocument.load(part.buffer, { ignoreEncryption: false });
      expectedPages += source.getPageCount();
      for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
    } else {
      await addImagePage(merged, part);
      expectedPages += 1;
    }
  }
  if (title) merged.setTitle(title);
  if (author) merged.setAuthor(author);
  merged.setCreationDate(new Date(nowMs));
  merged.setModificationDate(new Date(nowMs));
  return { pdf: Buffer.from(await merged.save()), pages: merged.getPageCount(), expectedPages };
}

// The first page's text as pdf.js reads it (unpdf, as the runner reads CVs), whitespace collapsed;
// verbosity 0: no parser warning reaches the public run log.
async function firstPageText(bytes) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const content = await (await pdf.getPage(1)).getTextContent();
  return content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The merged file as it will leave: it reopens, it has the pages of its parts, and a letter merged first
 * still has its own text on page 1 (equal, not just present). Never throws.
 * @param {Buffer} pdf
 * @param {{expectedPages?:number, letter?:Buffer|null}} [options]
 */
export async function checkMergedPdf(pdf, { expectedPages, letter = null } = {}) {
  try {
    if ((await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount() !== expectedPages) return false;
    if (!letter) return true;
    const own = await firstPageText(letter);
    return Boolean(own) && (await firstPageText(pdf)) === own;
  } catch {
    return false;
  }
}

const partsOf = (files) => files.map((file) => ({ buffer: file.buffer, type: file.type || typeOf(file.fileName) }));
// PDFs and JPGs go in as they are: together over the limit, the merged file would be too, so nothing is
// merged (8 documents × 5 files × 10 MB may be uploaded). A PNG is re-encoded: counted after the merge.
const copiedBytes = (parts) => parts.reduce((sum, part) => sum + (part.type === 'png' ? 0 : part.buffer.length), 0);
const titled = (labels, language, name) => `${labels[language] || labels.it}${name ? ` – ${name}` : ''}`;

/** One checked PDF of the parts, or why not. */
async function mergeChecked(parts, { limits, title, author, nowMs, letter = null, check = checkMergedPdf }) {
  if (parts.some((part) => !MERGEABLE.has(part.type))) return { ok: false, reason: 'document_not_mergeable' };
  if (copiedBytes(parts) > limits.bytes) return { ok: false, reason: 'bytes' };
  let merged;
  try {
    merged = await mergeParts(parts, { title, author, nowMs });
  } catch {
    return { ok: false, reason: 'encrypted_or_broken' };
  }
  if (merged.pages > limits.pages) return { ok: false, reason: 'pages' };
  if (merged.pdf.length > limits.bytes) return { ok: false, reason: 'bytes' };
  if (!await check(merged.pdf, { expectedPages: merged.expectedPages, letter })) return { ok: false, reason: 'check_failed' };
  return { ok: true, pdf: merged.pdf, pages: merged.pages, bytes: merged.pdf.length };
}

/**
 * Letter, CV and documents as one PDF, or why not.
 * @returns {Promise<{ok:true, filename:string, pdf:Buffer, pages:number, bytes:number}|{ok:false, reason:string}>}
 */
export async function dossierAttachment({ language, stem, name = '', letter, cv, extras = [], limits = DOSSIER_LIMITS, nowMs = Date.now(), check = checkMergedPdf }) {
  if (cv.type !== 'pdf') return { ok: false, reason: 'cv_not_pdf' };
  const parts = [{ buffer: letter, type: 'pdf' }, { buffer: cv.buffer, type: 'pdf' }, ...partsOf(extras.flatMap((document) => document.files))];
  const merged = await mergeChecked(parts, { limits, title: titled(DOSSIER_TITLE, language, name), author: name, nowMs, letter, check });
  return merged.ok ? { ...merged, filename: `${DOSSIER_LABEL[language] || DOSSIER_LABEL.it}_${stem}.pdf` } : merged;
}

/** Two or more files of the requested documents as one PDF (no text check: scans have none), or why not. */
export async function groupDocuments({ language, stem, name = '', files, nowMs = Date.now(), check = checkMergedPdf }) {
  const merged = await mergeChecked(partsOf(files), { limits: MERGED_LIMITS, title: titled(DOCUMENTS_LABEL, language, name), author: name, nowMs, check });
  return merged.ok ? { ...merged, filename: `${DOCUMENTS_LABEL[language] || DOCUMENTS_LABEL.it}_${stem}.pdf` } : merged;
}

/**
 * An e-mail application's attachments in the order they leave, and why so: the CV, the letter, then the
 * requested documents (one PDF when two files or more), or one PDF of all when the ad or the switch asks
 * and it can be built. A signed PDF is set apart first and leaves as it is, after the merged file
 * (`documentsReason: 'document_signed'`). Never throws. `key: null` marks a file submit.mjs keeps next to the order.
 * @param {{language:string, name:string, stem:string, cv:{buffer:Buffer, type:string, name:string, key?:string|null},
 *   letter:{buffer:Buffer, name:string, key?:string|null}, extras?:Array<{files:Array<{fileName:string, buffer:Buffer, type?:string, key?:string}>}>,
 *   mode:string, candidateType:string, ad?:{instruction:string, cue:string}, nowMs?:number, check?:Function}} input
 */
export async function packageAttachments({ language, name, stem, cv, letter, extras = [], mode, candidateType, ad = { instruction: '', cue: '' }, nowMs = Date.now(), check = checkMergedPdf }) {
  const decision = packagingDecision({ mode, candidateType, ad: ad.instruction });
  const files = extras.flatMap((document) => document.files);
  const signed = files.filter((file) => (file.type || typeOf(file.fileName)) === 'pdf' && isSignedPdf(file.buffer));
  const mergeable = files.filter((file) => !signed.includes(file));
  const asDocument = (file) => ({ kind: 'document', name: file.fileName, buffer: file.buffer, key: file.key || null });
  const common = { ad: ad.instruction, adCue: ad.cue };
  let reason = decision.reason;
  if (decision.want === 'single') {
    const dossier = await dossierAttachment({ language, stem, name, letter: letter.buffer, cv, extras: [{ files: mergeable }], limits: decision.limits, nowMs, check });
    if (dossier.ok) {
      return { ...common, packaging: 'single', reason, documentsGrouped: mergeable.length > 0, documentsReason: signed.length ? 'document_signed' : null, pages: dossier.pages, bytes: dossier.bytes,
        attachments: [{ kind: 'dossier', name: dossier.filename, buffer: dossier.pdf, key: null }, ...signed.map(asDocument)] };
    }
    reason = dossier.reason;
  }
  const attachments = [
    { kind: 'cv', name: cv.name, buffer: cv.buffer, key: cv.key || null },
    { kind: 'letter', name: letter.name, buffer: letter.buffer, key: letter.key || null },
  ];
  let grouped = null;
  let documentsReason = null;
  if (files.length > 1 && decision.reason === 'ad_separate') documentsReason = 'ad_separate';
  else if (files.length > 1) {
    // The other files are still grouped when two or more remain.
    if (mergeable.length > 1) {
      const result = await groupDocuments({ language, stem, name, files: mergeable, nowMs, check });
      if (result.ok) grouped = result;
      else documentsReason = result.reason;
    }
    if (signed.length) documentsReason ||= 'document_signed';
  }
  if (grouped) attachments.push({ kind: 'documents', name: grouped.filename, buffer: grouped.pdf, key: null }, ...signed.map(asDocument));
  else attachments.push(...files.map(asDocument));
  return { ...common, packaging: 'separate', reason, documentsGrouped: Boolean(grouped), documentsReason, pages: grouped?.pages ?? null, bytes: grouped?.bytes ?? null, attachments };
}
