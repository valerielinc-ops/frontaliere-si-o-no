#!/usr/bin/env node
/**
 * Dedicated Rohrer Gartenbau und Hauswartungen GmbH crawler runner.
 *
 * Uses the standard crawler template with the Rohrer Gartenbau und Hauswartungen GmbH parser.
 * All fetch/parse logic lives in ./lib/rohrer-gartenbau-und-hauswartungen-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllRohrerGartenbauUndHauswartungenJobs,
  isRohrerGartenbauUndHauswartungenJob,
  isTrustedDomain,
  ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY,
  ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME,
} from './lib/rohrer-gartenbau-und-hauswartungen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY,
  companyLabel: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllRohrerGartenbauUndHauswartungenJobs,
  isCompanyJob: isRohrerGartenbauUndHauswartungenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Rohrer Gartenbau und Hauswartungen GmbH crawler failed: ${err?.message || err}`);
  process.exit(1);
});
