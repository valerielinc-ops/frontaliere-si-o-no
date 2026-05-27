#!/usr/bin/env node
/**
 * Dedicated Vista Augenpraxen & Kliniken crawler runner.
 *
 * Uses the standard crawler template with the Vista parser
 * (Ostendis JobPublisher API).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllVistaJobs,
  isVistaJob,
  isTrustedDomain,
  VISTA_KEY,
  VISTA_COMPANY_NAME,
} from './lib/vista-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: VISTA_KEY,
  companyLabel: VISTA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllVistaJobs,
  isCompanyJob: isVistaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Vista crawler failed: ${err?.message || err}`);
  process.exit(1);
});
