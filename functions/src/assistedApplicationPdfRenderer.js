/**
 * PDFs of the assisted application: the tailored CV and the letter, typeset
 * with Typst in process (study 2026-10-02, report-cv-lettera §4-§5).
 *
 * `@myriaddreamin/typst-ts-node-compiler` (Apache-2.0) is a prebuilt native
 * addon: no system binary, it runs in the GitHub Actions runner and in the
 * Cloud Functions. The fonts (Source Sans 3, SIL OFL 1.1) ship in
 * functions/assets/fonts, so every Latin letter prints: "Kovačević", not
 * "Kova?evi?".
 *
 * Cost, measured on 2026-10-02 with
 *   node scripts/assisted-application/bench-pdf-renderer.mjs 100
 * (the synthetic developer CV of tests/assisted-application-pdf-ats.test.ts and
 * a letter, one line changed at each run, median of 100 runs after a warm-up;
 * Node 26.10 on a MacBook Pro 2017; baseline = the standard-font writer used
 * before Typst):
 *   CV      baseline 0.3 ms   typst 4.3 ms
 *   letter  baseline 0.2 ms   typst 10.0 ms
 *   first Typst CV of a process (compiler and fonts loaded): 117 ms
 * Over three runs of the command the medians ranged 4.0-6.3 ms (CV) and
 * 3.0-10.0 ms (letter), the first CV 96-317 ms: milliseconds per document,
 * once per draft or per candidate edit.
 *
 * Never fails a document: a compile error, a missing addon or the Remote
 * Config switch ASSISTED_APPLICATION_PDF_RENDERER = "legacy" fall back to the
 * standard-font writer of assistedApplicationAiDocuments.js. The result says
 * which renderer produced the PDF, so the draft can record it.
 */

import { randomUUID } from 'node:crypto';
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

// Typst memoizes every compile in a cache of the whole process and never
// empties it by itself. Measured on 2026-10-03 (Node 26.10 on macOS, one
// process, 2000 different documents, letters and CVs alternated): 583 MB of
// resident memory without eviction, 112 MB with it, 2.8 ms per document either
// way. After each compile, what the last ten did not use is dropped (the age
// the addon suggests for a tool that does not watch files): the templates and
// the fonts stay warm.
const CACHE_MAX_AGE = 10;

function evictCache(typst) {
  try {
    typst.evictCache?.(CACHE_MAX_AGE);
  } catch {
    // An eviction that fails costs memory, never a document.
  }
}

/**
 * Compile a template of functions/src/templates with its JSON input.
 * @param {string} template file name in the templates directory
 * @param {object} data the template's `sys.inputs.data`
 * @param {Record<string, Buffer>} [files] extra files the template reads (the photo), by path relative to the templates
 */
export async function compileTemplate(template, data, files = {}) {
  const typst = await compiler();
  // Mapped and unmapped around one synchronous compile, inside the try: a mapping
  // that fails half way still unmaps what it mapped.
  const mapped = [];
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(TEMPLATES_DIR, name);
      typst.mapShadow(file, content);
      mapped.push(file);
    }
    return Buffer.from(typst.pdf({ mainFilePath: path.join(TEMPLATES_DIR, template), inputs: { data: JSON.stringify(data) } }));
  } finally {
    for (const file of mapped) typst.unmapShadow(file);
    evictCache(typst);
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
  // A name of its own per compile: one candidate's photo can never be read for another's CV.
  const photoFile = photo ? `photo-${randomUUID()}.${photoType}` : null;
  const files = photo ? { [photoFile]: photo } : {};
  return render({
    template: 'assisted-cv.typ',
    data: { ...rest, ...(photo ? { photo: photoFile } : {}) },
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
