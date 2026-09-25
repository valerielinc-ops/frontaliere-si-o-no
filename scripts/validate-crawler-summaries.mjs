import {
  ensureLegacyPublicCrawlerSummaryCopyAbsent,
  readCrawlerSummaryStore,
  resolveCrawlerSummaryStorePath,
} from './lib/crawler-summary-store.mjs';

const canonicalPath = resolveCrawlerSummaryStorePath();
const store = readCrawlerSummaryStore(canonicalPath);
ensureLegacyPublicCrawlerSummaryCopyAbsent();

console.log(
  `✅ Crawler summary store valid: ${store.summaries.length} summaries in ${canonicalPath}`
);
