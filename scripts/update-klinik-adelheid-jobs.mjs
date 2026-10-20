#!/usr/bin/env node
/**
 * Dedicated Klinik Adelheid crawler runner.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKlinikAdelheidJobs,
  isKlinikAdelheidJob,
  isTrustedDomain,
  KLINIK_ADELHEID_KEY,
  KLINIK_ADELHEID_COMPANY_NAME,
  KLINIK_ADELHEID_FABRICATED_DESCRIPTION_RE,
  stripKlinikAdelheidFabricatedDescription,
} from './lib/klinik-adelheid-job-parser.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KLINIK_ADELHEID_KEY,
  companyLabel: KLINIK_ADELHEID_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKlinikAdelheidJobs,
  isCompanyJob: isKlinikAdelheidJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
  prepareExistingJobs: (jobs) => dropFabricatedDescriptions(
    jobs,
    KLINIK_ADELHEID_FABRICATED_DESCRIPTION_RE,
    KLINIK_ADELHEID_COMPANY_NAME,
    { strip: stripKlinikAdelheidFabricatedDescription },
  ),
}).catch((err) => {
  console.error(`❌ Klinik Adelheid crawler failed: ${err?.message || err}`);
  process.exit(1);
});
