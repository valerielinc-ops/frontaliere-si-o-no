/**
 * How the PDFs of the assisted application are rendered, as the owner queue
 * says it (components/pages/AssistedApplicationAdmin.tsx and its automation
 * panel): the line of the renderer's daily self-check
 * (functions/src/assistedApplicationRendererCheck.js) and the note on a draft
 * whose PDF came from the fallback. Italian, like the rest of the queue.
 *
 * Pure, so the page and the tests share it.
 */

import type { AssistedApplicationPdfRendererCheck } from './assistedApplicationAdminService';

export type PdfRendererTone = 'ok' | 'failed' | 'legacy' | 'unknown';

// The standard-font writer, named by what the owner can see: the letters it cannot print.
export const LEGACY_RENDERER_LABEL = 'generatore di riserva (senza č, ć…)';

/** On a draft whose PDF the fallback made. */
export const LEGACY_RENDERER_NOTE = `PDF dal ${LEGACY_RENDERER_LABEL}`;

// The check runs once a day: after two days without a new result it is not running.
const STALE_MS = 48 * 60 * 60 * 1000;

/**
 * @param check the stored result (null before the first check)
 * @param when how the page prints a time
 */
export function pdfRendererLine(
  check: AssistedApplicationPdfRendererCheck | null,
  nowMs: number,
  when: (ms: number) => string,
): { tone: PdfRendererTone; text: string } {
  const checkedAt = Number(check?.checkedAt) || 0;
  if (!check || !checkedAt) return { tone: 'unknown', text: 'PDF: non ancora verificato' };
  // A stale result never reads as ok.
  if (!(nowMs - checkedAt < STALE_MS)) return { tone: 'unknown', text: `PDF: non ancora verificato (ultima verifica ${when(checkedAt)})` };
  const typst = check.status === 'ok'
    ? `Typst funziona (verificato ${when(checkedAt)})`
    : `Typst NON funziona dal ${when(Number(check.failingSince) || checkedAt)}`;
  const fallback = `i documenti escono con il ${LEGACY_RENDERER_LABEL}`;
  // The switch decides for every document, whatever Typst can do.
  if (check.switch === 'legacy') return { tone: 'legacy', text: `PDF: interruttore su legacy — ${fallback}; ${typst}` };
  return check.status === 'ok' ? { tone: 'ok', text: `PDF: ${typst}` } : { tone: 'failed', text: `PDF: ${typst} — ${fallback}` };
}
