#!/usr/bin/env node
/**
 * Dedicated Ritter Schumacher AG crawler runner.
 *
 * Uses the standard crawler template with the Ritter Schumacher AG parser.
 * All fetch/parse logic lives in ./lib/ritterschumacher-com-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRitterschumacherComJobs,
  isRitterschumacherComJob,
  isTrustedDomain,
  RITTERSCHUMACHER_COM_KEY,
  RITTERSCHUMACHER_COM_COMPANY_NAME,
} from './lib/ritterschumacher-com-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: RITTERSCHUMACHER_COM_KEY,
  companyLabel: RITTERSCHUMACHER_COM_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRitterschumacherComJobs,
  isCompanyJob: isRitterschumacherComJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Ritter Schumacher AG crawler failed: ${err?.message || err}`);
  process.exit(1);
});
