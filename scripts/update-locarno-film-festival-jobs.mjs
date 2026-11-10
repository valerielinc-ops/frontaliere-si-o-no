#!/usr/bin/env node
/**
 * Dedicated Locarno Film Festival crawler runner.
 *
 * Uses the standard crawler template with the Locarno Film Festival parser.
 * All fetch/parse logic lives in ./lib/locarno-film-festival-job-parser.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLocarnoFilmFestivalJobs,
  isLocarnoFilmFestivalJob,
  isTrustedDomain,
  LOCARNO_FILM_FESTIVAL_KEY,
  LOCARNO_FILM_FESTIVAL_COMPANY_NAME,
} from './lib/locarno-film-festival-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LOCARNO_FILM_FESTIVAL_KEY,
  companyLabel: LOCARNO_FILM_FESTIVAL_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLocarnoFilmFestivalJobs,
  isCompanyJob: isLocarnoFilmFestivalJob,
  isTrustedDomain,
  defaultSourceLang: 'it',
}).catch((err) => {
  console.error(`❌ Locarno Film Festival crawler failed: ${err?.message || err}`);
  process.exit(1);
});
