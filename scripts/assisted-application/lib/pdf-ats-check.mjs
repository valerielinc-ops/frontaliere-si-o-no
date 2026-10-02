/**
 * What an applicant tracking system reads in a CV PDF, checked with pdf.js
 * (unpdf, the extractor the assisted application already uses). Study
 * 2026-10-02 (report-cv-lettera §4, §8): the rules that told the layouts apart
 * on 12 synthetic CVs, written here instead of copying a third-party checker
 * (Reactive Resume's flagged Italian as a blocker and missed a name printed
 * "Kova?evi?"; OpenResume's parser is AGPL).
 *
 *   text          the PDF has selectable text
 *   fonts         every font is embedded (a standard font is not, and lacks č, ł, ș)
 *   icons         no Private Use characters (icon fonts glue a glyph to the e-mail)
 *   replacement   no "?" inside a word, no U+FFFD (a letter the font could not print)
 *   name          the first line is the candidate's name
 *   dateColumn    no date alone on a baseline far left of other text (pdftotext reads a column apart)
 *   headingFirst  a section heading comes before the first date
 *   facts         every expected fact is found in the text
 *   pages         at most `maxPages`
 */

import { getDocumentProxy } from 'unpdf';

const DATE_RE = /(?:\b\d{1,2}[./]\d{4}\b|\b(?:19|20)\d{2}\s*[–-]\s*(?:(?:19|20)\d{2}|\p{L}+))/u;
const PRIVATE_USE = /[-]/u;

/**
 * @param {Uint8Array|Buffer} pdfBytes
 * @param {{name?:string, facts?:string[], headings?:string[], maxPages?:number}} expected
 * @returns {Promise<{ok:boolean, failures:string[], text:string, lines:string[], pages:number}>}
 */
export async function checkPdfForAts(pdfBytes, { name = '', facts = [], headings = [], maxPages = 2 } = {}) {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  const failures = [];
  const lines = [];
  let text = '';
  let missingFont = false;
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    await page.getOperatorList();
    const items = content.items.filter((item) => 'str' in item && item.str.trim());
    for (const item of items) {
      try {
        const font = page.commonObjs.get(item.fontName);
        if (font?.missingFile) missingFont = true;
      } catch { /* font not loaded: judged by the text checks */ }
    }
    // Lines by baseline, then left to right: the reading a layout-aware extractor makes.
    const rows = new Map();
    for (const item of items) {
      const y = Math.round(item.transform[5]);
      const key = [...rows.keys()].find((other) => Math.abs(other - y) <= 2) ?? y;
      rows.set(key, [...(rows.get(key) || []), item]);
    }
    for (const [, row] of [...rows.entries()].sort((left, right) => right[0] - left[0])) {
      row.sort((left, right) => left.transform[4] - right.transform[4]);
      lines.push(row.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim());
      // A date alone, then more text on the same baseline far to its right: a date column.
      const [first, next] = row;
      if (next && DATE_RE.test(first.str) && first.str.trim().length <= 24 && next.transform[4] - (first.transform[4] + first.width) > 40) {
        failures.push(`dateColumn:${first.str.trim()}`);
      }
    }
    text += `${items.map((item) => item.str).join(' ')}\n`;
  }
  const flat = text.replace(/\s+/g, ' ');
  if (flat.trim().length < 200) failures.push('text');
  if (missingFont) failures.push('fonts');
  if (PRIVATE_USE.test(text)) failures.push('icons');
  if (/\p{L}\?\p{L}/u.test(text) || text.includes('�')) failures.push('replacement');
  if (name && !(lines[0] || '').includes(name)) failures.push(`name:${lines[0] || ''}`);
  const firstDate = flat.search(DATE_RE);
  const firstHeading = Math.min(...headings.map((heading) => flat.indexOf(heading)).filter((at) => at >= 0), Infinity);
  if (headings.length && firstDate >= 0 && !(firstHeading < firstDate)) failures.push('headingFirst');
  for (const fact of facts) if (!flat.includes(fact)) failures.push(`facts:${fact}`);
  if (pdf.numPages > maxPages) failures.push(`pages:${pdf.numPages}`);
  return { ok: failures.length === 0, failures, text: flat, lines, pages: pdf.numPages };
}
