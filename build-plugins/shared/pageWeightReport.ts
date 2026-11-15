/**
 * Page-weight OBSERVATION for emitted static pages. Never enforces: a page
 * over the warn threshold is logged and still emitted whole. Owner decision
 * («togliamo questo tetto per le pagine», run 43712804687): a quality signal
 * must not be able to abort hours of build work.
 *
 * Memory is bounded: only the heaviest `topN` pages and counters are kept.
 */
export const PAGE_WEIGHT_WARN_BYTES = 195 * 1024;
export const PAGE_WEIGHT_TOP_N = 5;
/** Per-page warnings are capped so a systemic overshoot cannot flood the log. */
export const PAGE_WEIGHT_MAX_WARNINGS = 20;

export interface PageWeightEntry {
  readonly kind: string;
  readonly path: string;
  readonly bytes: number;
}

export interface PageWeightSummary {
  readonly total: number;
  readonly overCount: number;
  readonly top: readonly PageWeightEntry[];
}

export interface PageWeightReporter {
  /** Record one emitted page. Warns when over the threshold. Never throws. */
  observe(kind: string, path: string, bytes: number): void;
  summary(): PageWeightSummary;
  /** Human-readable single line for the end-of-plugin log. */
  formatSummary(): string;
  reset(): void;
}

export interface PageWeightReporterOptions {
  readonly warnBytes?: number;
  readonly topN?: number;
  readonly maxWarnings?: number;
  readonly warn?: (message: string) => void;
}

export function createPageWeightReporter(options: PageWeightReporterOptions = {}): PageWeightReporter {
  const warnBytes = options.warnBytes ?? PAGE_WEIGHT_WARN_BYTES;
  const topN = Math.max(0, options.topN ?? PAGE_WEIGHT_TOP_N);
  const maxWarnings = Math.max(0, options.maxWarnings ?? PAGE_WEIGHT_MAX_WARNINGS);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let total = 0;
  let overCount = 0;
  let top: PageWeightEntry[] = [];

  const heavier = (a: PageWeightEntry, b: PageWeightEntry): boolean =>
    a.bytes > b.bytes || (a.bytes === b.bytes && a.path < b.path);

  return {
    observe(kind, path, bytes) {
      total++;
      if (Number.isFinite(bytes) && bytes > warnBytes) {
        overCount++;
        if (overCount <= maxWarnings) {
          warn(
            `[page-weight] ${kind} ${path} is ${(bytes / 1024).toFixed(1)} KB, above the `
            + `${(warnBytes / 1024).toFixed(0)} KB warning threshold (emitted in full; warning only).`
              + (overCount === maxWarnings ? ' Further page-weight warnings are summarised at the end.' : ''),
          );
        }
      }
      if (topN === 0 || !Number.isFinite(bytes)) return;
      const entry: PageWeightEntry = { kind, path, bytes };
      if (top.length < topN) {
        top.push(entry);
        top.sort((a, b) => (heavier(a, b) ? -1 : 1));
      } else if (heavier(entry, top[top.length - 1])) {
        top[top.length - 1] = entry;
        top.sort((a, b) => (heavier(a, b) ? -1 : 1));
      }
    },
    summary() {
      return { total, overCount, top: top.slice() };
    },
    formatSummary() {
      const heaviest = top.map((e) => `${e.kind} ${e.path} ${(e.bytes / 1024).toFixed(1)} KB`).join('; ');
      return `[page-weight] ${overCount}/${total} pages above ${(warnBytes / 1024).toFixed(0)} KB `
        + `(warning only); heaviest ${top.length}: ${heaviest || 'n/a'}`;
    },
    reset() {
      total = 0;
      overCount = 0;
      top = [];
    },
  };
}
