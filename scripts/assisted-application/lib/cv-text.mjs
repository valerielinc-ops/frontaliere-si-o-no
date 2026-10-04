/**
 * CV text for the runner. Codex (the `function` profile of the CI broker)
 * reads text only, so every CV must become text here:
 *   - PDF with a text layer → unpdf;
 *   - scanned PDF (no text layer) → OCR with tesseract (ita+deu+fra+eng);
 *   - DOCX → document.xml;
 *   - legacy DOC → antiword.
 * The OCR and antiword packages are installed on the runner only when a CV
 * needs them (ubuntu runners have passwordless sudo).
 */

import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractCvText } from '../../../functions/src/assistedApplicationAiDocuments.js';

const execFile = promisify(execFileCallback);
const MIN_TEXT_CHARS = 200;
const MAX_OCR_PAGES = 4;

async function haveCommand(name, run) {
  try {
    await run('bash', ['-lc', `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The apt packages of the commands missing on the runner, installed
 * (passwordless sudo). Runs in the job's own environment: it parses no file of
 * a candidate.
 */
export async function ensurePackages(commands, packages, run) {
  const missing = [];
  for (const command of commands) if (!(await haveCommand(command, run))) missing.push(command);
  if (!missing.length) return;
  await run('sudo', ['apt-get', 'install', '-y', '-qq', '--no-install-recommends', ...packages], { timeout: 240_000 });
}

/**
 * The environment of a program that parses a candidate's file (pdftoppm,
 * tesseract, antiword, LibreOffice): where the programs are, a UTF-8 locale,
 * and a home and a temp directory that are the conversion's own folder,
 * deleted with it. Nothing else: the job's environment holds every Remote
 * Config secret and the path of the production service account, and a parser
 * taken over by a crafted file must not inherit them.
 *
 * Not a sandbox. The program still runs as the job's user: it can read that
 * user's files (the credentials file among them) and reach the network. A
 * container without network, with only this folder mounted, is the next step.
 * @param {string} dir the conversion's temp directory
 */
export function converterEnv(dir) {
  return {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: dir,
    TMPDIR: dir,
  };
}

async function ocrPdf(buffer, run) {
  await ensurePackages(['tesseract', 'pdftoppm'], ['tesseract-ocr', 'tesseract-ocr-ita', 'tesseract-ocr-deu', 'tesseract-ocr-fra', 'poppler-utils'], run);
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-ocr-'));
  try {
    const input = path.join(dir, 'cv.pdf');
    const env = converterEnv(dir);
    await writeFile(input, buffer);
    await run('pdftoppm', ['-r', '200', '-png', '-l', String(MAX_OCR_PAGES), input, path.join(dir, 'page')], { timeout: 120_000, env });
    const pages = (await readdir(dir)).filter((name) => name.startsWith('page') && name.endsWith('.png')).sort();
    const texts = [];
    for (const page of pages) {
      const { stdout } = await run('tesseract', [path.join(dir, page), '-', '-l', 'ita+deu+fra+eng'], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env });
      texts.push(stdout);
    }
    return texts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function docToText(buffer, run) {
  await ensurePackages(['antiword'], ['antiword'], run);
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-doc-'));
  try {
    const input = path.join(dir, 'cv.doc');
    await writeFile(input, buffer);
    const { stdout } = await run('antiword', ['-w', '0', input], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: converterEnv(dir) });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} type 'pdf' | 'docx' | 'doc'
 * @param {{run?: Function}} [options] run: how a program is started (execFile; tests pass a fake)
 * @returns {Promise<{text:string, method:'text_layer'|'ocr'|'docx'|'antiword'|'none'}>}
 */
export async function readCvText(buffer, type, { run = execFile } = {}) {
  if (type === 'doc') {
    const text = await docToText(buffer, run).catch(() => '');
    return { text, method: text ? 'antiword' : 'none' };
  }
  const text = await extractCvText(buffer, type).catch(() => '');
  if (text.length >= MIN_TEXT_CHARS || type !== 'pdf') return { text, method: type === 'docx' ? 'docx' : 'text_layer' };
  const ocr = await ocrPdf(buffer, run).catch((error) => {
    console.warn('[assisted-application] OCR failed:', error instanceof Error ? error.message.slice(0, 120) : String(error));
    return '';
  });
  return ocr.length > text.length ? { text: ocr, method: 'ocr' } : { text, method: text ? 'text_layer' : 'none' };
}
