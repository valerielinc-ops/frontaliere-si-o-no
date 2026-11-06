#!/usr/bin/env node
/**
 * Dedicated Kantonsspital Glarus (KSGL) crawler runner.
 *
 * Uses the standard crawler template with the KSGL parser
 * (Prospective.ch careercenter tenant 1000665, SSR HTML — the v1 medium
 * JSON endpoint returns 400 for this tenant, so the parser scrapes the
 * careercenter HTML + per-detail JSON-LD JobPosting).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllKsglJobs,
  isKsglJob,
  isTrustedDomain,
  KSGL_KEY,
  KSGL_COMPANY_NAME,
} from './lib/ksgl-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: KSGL_KEY,
  companyLabel: KSGL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllKsglJobs,
  isCompanyJob: isKsglJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Kantonsspital Glarus (KSGL) crawler failed: ${err?.message || err}`);
  process.exit(1);
});
