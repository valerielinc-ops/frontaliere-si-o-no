/**
 * Crawlers that build a description from a feed/API and add sections read
 * from the vacancy's detail page face one failure mode: a run where the
 * detail page cannot be read produces only the feed text. Publishing that
 * would flip the job between the long and the short body — and send its
 * translations through the pipeline again — every time one page is flaky.
 *
 * When the stored source text already contains every line of the fresh feed
 * text (it is that text plus the detail-page sections from an earlier run),
 * keep the stored text; otherwise the feed changed and the fresh text wins.
 */
function normalizeLine(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

export function preferEnrichedDescription(previous = '', fresh = '') {
  const lines = (text) => String(text || '')
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean);
  const freshLines = lines(fresh);
  if (!freshLines.length) return String(previous || '');
  const previousLines = new Set(lines(previous));
  return freshLines.every((line) => previousLines.has(line)) ? String(previous) : String(fresh);
}
