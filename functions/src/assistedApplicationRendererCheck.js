/**
 * Self-check of the PDF renderer inside the Cloud Functions.
 *
 * The letter and the tailored CV are typeset with Typst
 * (assistedApplicationPdfRenderer.js), which falls back to the standard-font
 * writer on any error instead of failing the document. The fallback cannot
 * print č or ć and drops the Swiss layout, and it left only a log line. Here
 * one invented letter and one invented CV are rendered with Typst forced and
 * read back, and the result is kept in one Firestore document that the owner
 * queue shows (assistedApplicationAdminCore.js).
 *
 * What was rendered is checked, not only that nothing threw: without its font
 * directory Typst compiles all the same, in its built-in serif font (tried on
 * 2026-10-03: a warning, no error), so the fonts are read from the PDF too.
 *
 * The document is not personal: the candidate is invented and the error is
 * the synthetic render's own (the error of a real document may quote it). It
 * lives in `meta`, which no firestore.rules entry opens to clients.
 */

import { extractPdfText } from './assistedApplicationAiDocuments.js';
import { compileTemplate, pdfRendererMode } from './assistedApplicationPdfRenderer.js';
import { pageTextFonts } from './lib/pdfFonts.js';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR_CHARS = 200;
// The PostScript name of the bundled fonts (functions/assets/fonts), after the subset prefix.
const FONT_RE = /(?:^|\+)SourceSans3-/;

// Invented, as in the tests. The name has č and ć: the letters the standard-font writer cannot print.
const NAME = 'Luka Kovačević';
const DOCUMENTS = [
  ['assisted-letter.typ', {
    language: 'de',
    title: 'Bewerbung',
    senderLines: [NAME, 'Musterweg 12', '8400 Winterthur'],
    recipientLines: ['Muster Informatik AG', 'Technikumstrasse 9', '8400 Winterthur'],
    placeDate: 'Winterthur',
    subject: 'Bewerbung als Informatiker',
    salutation: 'Sehr geehrte Damen und Herren',
    paragraphs: ['Dieser Brief prüft den PDF-Generator.'],
    closing: 'Freundliche Grüsse',
    signature: NAME,
    enclosuresLabel: 'Beilagen',
    enclosures: ['Lebenslauf'],
  }],
  ['assisted-cv.typ', {
    language: 'de',
    name: NAME,
    headline: 'Informatiker',
    contact: ['Musterweg 12, 8400 Winterthur', '+41 79 555 01 23'],
    personalTitle: 'Persönliche Angaben',
    personal: [['Nationalität', 'Schweiz']],
    sections: [{
      kind: 'experience',
      title: 'Berufserfahrung',
      items: [{ date: '2021 – heute', title: 'Informatiker', org: 'Muster Informatik AG', place: 'Winterthur', bullets: ['Dieser Lebenslauf prüft den PDF-Generator.'] }],
    }],
  }],
];

const rendererCheckRef = (db) => db.collection('meta').doc('assistedApplicationPdfRenderer');

/**
 * Once a day, and at once on another revision (a deploy is checked by the
 * next run of the function that hosts the check) or when the switch moved.
 * A result that is not ok is checked again at every run: the owner's line is
 * never a day behind the switch, nor red for a day after a failure that went away.
 * @param {object|null} stored the last result
 * @param {{nowMs:number, revision:string|null, mode:'typst'|'legacy'}} current
 *   mode: what the switch says now (pdfRendererMode)
 */
export function rendererCheckDue(stored, { nowMs, revision, mode }) {
  if (!stored || stored.status !== 'ok' || stored.switch !== mode) return true;
  return !(nowMs - Number(stored.checkedAt) < CHECK_EVERY_MS) || (stored.revision || null) !== (revision || null);
}

async function pdfFonts(pdf) {
  const { getDocumentProxy } = await import('unpdf');
  const document = await getDocumentProxy(new Uint8Array(pdf));
  const fonts = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const { items } = await page.getTextContent();
    await page.getOperatorList();
    fonts.push(...pageTextFonts(page, items.filter((item) => 'str' in item && item.str.trim())));
  }
  return fonts;
}

async function checkDocument(compile, template, data) {
  const pdf = await compile(template, data);
  if (!(await extractPdfText(pdf)).normalize('NFC').includes(NAME)) throw new Error('the name with č and ć is not in the text of the PDF');
  const fonts = await pdfFonts(pdf);
  const others = fonts.filter((font) => !font.resolved || !font.embedded || !FONT_RE.test(font.name));
  if (!fonts.length || others.length) {
    throw new Error(`the text is not in the embedded Source Sans 3 (${others.map((font) => font.name || 'unresolved font').join(', ') || 'no font'})`);
  }
}

/** Null when Typst rendered both documents as it should, otherwise the first line of what went wrong. */
async function rendererError(compile) {
  for (const [template, data] of DOCUMENTS) {
    try {
      await checkDocument(compile, template, data);
    } catch (error) {
      // The addon throws an Error with an empty message: its diagnostic is in `code`.
      const line = String(error?.message || error?.code || error).split('\n')[0].trim();
      return `${template}: ${line}`.slice(0, MAX_ERROR_CHARS);
    }
  }
  return null;
}

/**
 * Runs the check when it is due and stores the result.
 * @param {{db:object, nowMs?:number, compile?:Function, env?:object}} deps
 *   compile: (template, data) => Promise<Buffer>, Typst without the fallback
 * @returns {Promise<object|null>} the stored result, null when the check was not due
 */
export async function runRendererCheck({ db, nowMs = Date.now(), compile = compileTemplate, env = process.env }) {
  const ref = rendererCheckRef(db);
  const snapshot = await ref.get();
  const previous = snapshot.exists ? snapshot.data() || {} : null;
  const revision = env.K_REVISION || null;
  // Read at every run, due or not, so that a flip is due at the next run (the
  // Remote Config template is cached for 5 minutes and the sweep has just read it).
  const mode = await pdfRendererMode({ env });
  if (!rendererCheckDue(previous, { nowMs, revision, mode })) return null;
  const error = await rendererError(compile);
  const result = {
    status: error ? 'failed' : 'ok',
    // What the switch says, apart from what Typst can do: on `legacy` every
    // document comes from the standard-font writer, even while this check is ok.
    switch: mode,
    error,
    node: process.version,
    service: env.K_SERVICE || null,
    revision,
    rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    checkedAt: nowMs,
    failingSince: error ? (previous?.status === 'failed' && Number(previous.failingSince)) || nowMs : null,
  };
  await ref.set(result);
  return result;
}

const RESULT_FIELDS = ['status', 'switch', 'error', 'node', 'service', 'revision', 'rssMb', 'checkedAt', 'failingSince'];

/** The stored result for the owner queue, null before the first check. Reads only: nothing is rendered here. */
export async function readRendererCheck(db) {
  const snapshot = await rendererCheckRef(db).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  return Object.fromEntries(RESULT_FIELDS.map((field) => [field, data[field] ?? null]));
}
