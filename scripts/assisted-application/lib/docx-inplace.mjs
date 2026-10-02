/**
 * The in-place DOCX in the runner (phase 5 of the CV study, 2026-10-02):
 * behind the Remote Config switch ASSISTED_APPLICATION_DOCX_INPLACE, off by
 * default. For a DOCX CV (a DOC one after LibreOffice converts it) the
 * adapted lines are written into the candidate's own file
 * (functions/src/assistedApplicationDocxInPlace.js) and LibreOffice checks
 * that it takes no more pages than before (fewer is fine: a shorter line can
 * pull a last line back from page 2). Anything else sends the candidate back
 * to the template CV; the reason is kept on the draft, so the share of
 * fallbacks is measured.
 *
 * LibreOffice (about 300 MB) is installed on the runner only when the switch
 * is on and the CV is a Word file, as antiword and tesseract are.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { DOCX_CONTENT_TYPE, buildInPlaceDocx, docxInPlaceMode } from '../../../functions/src/assistedApplicationDocxInPlace.js';
import { ensurePackages } from './cv-text.mjs';

const execFile = promisify(execFileCallback);

/** One file converted by LibreOffice (doc → docx, docx → pdf). */
export async function convertWithLibreOffice(buffer, from, to, run = execFile) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-office-'));
  try {
    const input = path.join(dir, `cv.${from}`);
    await writeFile(input, buffer);
    // Its own profile folder: a second soffice never waits on the lock of the first.
    await run('soffice', [`-env:UserInstallation=file://${path.join(dir, 'profile')}`, '--headless', '--norestore', '--convert-to', to, '--outdir', dir, input], { timeout: 120_000 });
    return await readFile(path.join(dir, `cv.${to}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pagesOf(docx, run) {
  const pdf = await PDFDocument.load(await convertWithLibreOffice(docx, 'docx', 'pdf', run), { updateMetadata: false });
  return pdf.getPageCount();
}

/**
 * @param {object} input
 * @param {string} [input.mode] 'on' | 'off' (default: the switch)
 * @param {Buffer} input.cvBuffer the candidate's CV
 * @param {string} input.cvType 'pdf' | 'docx' | 'doc'
 * @param {string} input.cvKey the CV's Storage key (the base of a DOCX)
 * @param {object} input.cv the tailored CV that passed the fact gate
 * @returns {Promise<object|null>} the draft's `tailoredCv.inplace`, null when the switch is off or the CV is a PDF
 */
export async function inPlaceCvRecord({ mode = docxInPlaceMode(), cvBuffer, cvType, cvKey, cv, profile, identity, bucket, orderId, round, nowMs, log = () => {}, run = execFile }) {
  if (mode !== 'on' || (cvType !== 'docx' && cvType !== 'doc')) return null;
  // LibreOffice (about 300 MB) only when it is needed: a DOC to convert, or a page count to compare.
  let office = null;
  const haveOffice = async () => {
    if (office === null) {
      office = await ensurePackages(['soffice'], ['libreoffice-writer-nogui'], run).then(() => true, () => false);
    }
    return office;
  };
  try {
    let base = cvBuffer;
    if (cvType === 'doc') {
      if (!(await haveOffice())) return { status: 'fallback', reason: 'doc_needs_libreoffice', baseType: cvType };
      base = await convertWithLibreOffice(cvBuffer, 'doc', 'docx', run);
    }
    const built = buildInPlaceDocx(base, cv, { profile, identity });
    if (built.status !== 'ready') return { status: 'fallback', reason: built.reason, baseType: cvType };
    if (!built.patched.length) return { status: 'fallback', reason: 'nothing_patched', baseType: cvType, skipped: built.skipped };
    let pages = null;
    let pagesBefore = null;
    const checked = await haveOffice();
    if (checked) {
      pagesBefore = await pagesOf(base, run);
      pages = await pagesOf(built.docx, run);
      if (pages > pagesBefore) return { status: 'fallback', reason: 'more_pages', baseType: cvType, skipped: built.skipped, pages, pagesBefore };
    }
    // The converted DOC is kept only when it is used: the Cloud Functions rebuild from it.
    let baseKey = cvKey;
    if (cvType === 'doc') {
      baseKey = `assisted-application-uploads/${orderId}/ai-cv-inplace-base-r${round}-${nowMs}.docx`;
      await bucket.file(baseKey).save(base, { contentType: DOCX_CONTENT_TYPE, resumable: false });
    }
    const docxKey = `assisted-application-uploads/${orderId}/ai-cv-inplace-r${round}-${nowMs}.docx`;
    await bucket.file(docxKey).save(built.docx, { contentType: DOCX_CONTENT_TYPE, resumable: false });
    log('in-place docx', `${built.patched.length} lines`, `${built.skipped.length} kept`, checked ? `${pages} pages` : 'budget only');
    return {
      status: 'ready',
      docxKey,
      baseKey,
      baseType: cvType,
      patched: built.patched,
      skipped: built.skipped,
      // How the page count was kept: LibreOffice compared it, or the length budget alone.
      pageCheck: checked ? 'libreoffice' : 'budget',
      pages,
      pagesBefore,
    };
  } catch (error) {
    log('in-place docx failed', error instanceof Error ? error.message.slice(0, 80) : 'error');
    return { status: 'failed', baseType: cvType };
  }
}
