/**
 * PDFs of the assisted application: the tailored CV and the letter, typeset
 * with Typst in process (study 2026-10-02, report-cv-lettera §4-§5).
 *
 * `@myriaddreamin/typst-ts-node-compiler` (Apache-2.0) is a prebuilt native
 * addon: no system binary, it runs in the GitHub Actions runner and in the
 * Cloud Functions (measured locally: compiler 120 ms, first document 120 ms,
 * next ones 1-6 ms, 63 MB). The fonts (Source Sans 3, SIL OFL 1.1) ship in
 * functions/assets/fonts, so every Latin letter prints: "Kovačević", not
 * "Kova?evi?".
 *
 * Never fails a document: a compile error, a missing addon or the Remote
 * Config switch ASSISTED_APPLICATION_PDF_RENDERER = "legacy" fall back to the
 * standard-font writer of assistedApplicationAiDocuments.js. The result says
 * which renderer produced the PDF, so the draft can record it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCoverLetterPdf, renderPdf } from './assistedApplicationAiDocuments.js';
import { cvDocumentBlocks } from './assistedApplicationCvDocument.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.join(HERE, 'templates');
export const FONTS_DIR = path.join(HERE, '..', 'assets', 'fonts');
export const RENDERER_KEY = 'ASSISTED_APPLICATION_PDF_RENDERER';

let compilerPromise = null;

function compiler() {
  compilerPromise ||= import('@myriaddreamin/typst-ts-node-compiler')
    .then(({ NodeCompiler }) => NodeCompiler.create({ workspace: TEMPLATES_DIR, fontArgs: [{ fontPaths: [FONTS_DIR] }] }))
    .catch((error) => {
      compilerPromise = null;
      throw error;
    });
  return compilerPromise;
}

/**
 * "typst" unless the switch says "legacy": the runner gets it as an
 * environment variable (scripts/load-rc-env.mjs), the Cloud Functions read
 * Remote Config. Default: typst (it falls back by itself on any error).
 */
export async function pdfRendererMode({ env = process.env, readConfig = cloudFunctionsConfig(env) } = {}) {
  let value = String(env[RENDERER_KEY] || '').trim().toLowerCase();
  if (!value && readConfig) value = String(await readConfig(RENDERER_KEY).catch(() => '') || '').trim().toLowerCase();
  return value === 'legacy' ? 'legacy' : 'typst';
}

// Remote Config is read only inside the Cloud Functions; elsewhere (runner, tests) the environment says it.
function cloudFunctionsConfig(env) {
  if (!env.K_SERVICE && !env.FUNCTION_TARGET) return null;
  return async (key) => (await import('./remoteConfigSecrets.js')).getRemoteConfigValue(key);
}

/**
 * Compile a template of functions/src/templates with its JSON input.
 * @param {string} template file name in the templates directory
 * @param {object} data the template's `sys.inputs.data`
 * @param {Record<string, Buffer>} [files] extra files the template reads (the photo), by path relative to the templates
 */
export async function compileTemplate(template, data, files = {}) {
  const typst = await compiler();
  const shadows = Object.entries(files).map(([name, content]) => [path.join(TEMPLATES_DIR, name), content]);
  for (const [file, content] of shadows) typst.mapShadow(file, content);
  try {
    return Buffer.from(typst.pdf({ mainFilePath: path.join(TEMPLATES_DIR, template), inputs: { data: JSON.stringify(data) } }));
  } finally {
    for (const [file] of shadows) typst.unmapShadow(file);
  }
}

async function render({ template, data, files, legacy, mode, log }) {
  if (mode !== 'legacy') {
    try {
      return { pdf: await compileTemplate(template, data, files), renderer: 'typst' };
    } catch (error) {
      (log || console.warn)('[assisted-application] typst failed, standard-font PDF instead:', String(error?.message || error).slice(0, 200));
    }
  }
  return { pdf: legacy(), renderer: 'legacy' };
}

/**
 * The tailored CV from its document (assistedApplicationCvDocument.js).
 * @param {object} document buildCvDocument's result; `photo` (a Buffer) is printed when present
 * @returns {Promise<{pdf: Buffer, renderer: 'typst'|'legacy'}>}
 */
export async function renderCvPdf(document, { mode = 'typst', log } = {}) {
  const { photo, photoType = 'jpg', ...rest } = document;
  const files = photo ? { [`photo.${photoType}`]: photo } : {};
  return render({
    template: 'assisted-cv.typ',
    data: { ...rest, ...(photo ? { photo: `photo.${photoType}` } : {}) },
    files,
    legacy: () => renderPdf(cvDocumentBlocks(rest), { title: `CV ${document.name}` }),
    mode,
    log,
  });
}

/**
 * The letter from its blocks (assistedApplicationAiDraftCore.js letterPdfBlocks).
 * @returns {Promise<{pdf: Buffer, renderer: 'typst'|'legacy'}>}
 */
export async function renderLetterPdf(blocks, { mode = 'typst', log } = {}) {
  return render({
    template: 'assisted-letter.typ',
    data: {
      language: 'it', title: '', senderLines: [], recipientLines: [], placeDate: '', subject: '', salutation: '',
      paragraphs: [], closing: '', signature: '', enclosuresLabel: '', enclosures: [], ...blocks,
    },
    legacy: () => buildCoverLetterPdf(blocks),
    mode,
    log,
  });
}
