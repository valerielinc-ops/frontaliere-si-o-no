#!/usr/bin/env node
/** Dedicated Kita Summervogel GmbH crawler runner. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKitaSummervogelJobs,
  isKitaSummervogelJob,
  isTrustedDomain,
  KITA_SUMMERVOGEL_KEY,
  KITA_SUMMERVOGEL_COMPANY_NAME,
} from './lib/kita-summervogel-job-parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

runStandardCrawlerPipeline({
  companyKey: KITA_SUMMERVOGEL_KEY,
  companyLabel: KITA_SUMMERVOGEL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKitaSummervogelJobs,
  isCompanyJob: isKitaSummervogelJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((error) => {
  console.error(`❌ ${KITA_SUMMERVOGEL_COMPANY_NAME} crawler failed: ${error?.message || error}`);
  process.exit(1);
});
