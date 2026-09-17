#!/usr/bin/env node
/**
 * Dedicated Nord Anglia Education Switzerland crawler runner.
 *
 * Uses the standard crawler template with the national Nord Anglia parser.
 * All fetch/parse logic lives in ./lib/nord-anglia-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllNordAngliaJobs,
  isNordAngliaJob,
  isTrustedDomain,
  NORD_ANGLIA_KEY,
  NORD_ANGLIA_COMPANY_NAME,
} from './lib/nord-anglia-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runStandardCrawlerPipeline({
    companyKey: NORD_ANGLIA_KEY,
    companyLabel: NORD_ANGLIA_COMPANY_NAME,
    root: ROOT,
    fetchJobs: fetchAllNordAngliaJobs,
    isCompanyJob: isNordAngliaJob,
    isTrustedDomain,
    defaultSourceLang: 'en',
  }).catch((err) => {
    console.error(`❌ Nord Anglia Education Switzerland crawler failed: ${err?.message || err}`);
    process.exit(1);
  });
}
