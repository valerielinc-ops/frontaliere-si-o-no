#!/usr/bin/env node
/** Dedicated Zurich Insurance Switzerland crawler runner. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExistingCrawlerJobs } from './assemble-jobs-dataset.mjs';
import { exitCrawlerOnError, runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  prepareZurichInsuranceCrawler,
  ZURICH_INSURANCE_COMPANY_NAME,
  ZURICH_INSURANCE_KEY,
} from './lib/zurich-insurance-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  // Fetch the authoritative Switzerland listing before the pipeline snapshots
  // the old slice. The returned matcher can therefore preserve identity only
  // for legacy records that are still present on the official board.
  const existingJobs = readExistingCrawlerJobs(ZURICH_INSURANCE_KEY);
  const crawler = await prepareZurichInsuranceCrawler({ existingJobs });

  await runStandardCrawlerPipeline({
    companyKey: ZURICH_INSURANCE_KEY,
    companyLabel: ZURICH_INSURANCE_COMPANY_NAME,
    root: ROOT,
    fetchJobs: crawler.fetchJobs,
    isCompanyJob: crawler.isCompanyJob,
    isTrustedDomain: crawler.isTrustedDomain,
    defaultSourceLang: 'en',
  });
}

main().catch((err) => exitCrawlerOnError(err, 'Zurich Insurance'));
