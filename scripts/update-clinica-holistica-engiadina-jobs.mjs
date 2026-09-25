#!/usr/bin/env node
/**
 * Dedicated Clinica Holistica Engiadina (Susch, GR) crawler runner.
 *
 * Source: https://www.clinica-holistica.ch/de/karriere (Drupal listing).
 * The `/de/offene-stellen` page returns 403 even via Playwright; we use the
 * Karriere index as the canonical entrypoint.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllClinicaHolisticaJobs,
  isClinicaHolisticaJob,
  isTrustedDomain,
  CLINICA_HOLISTICA_KEY,
  CLINICA_HOLISTICA_COMPANY_NAME,
} from './lib/clinica-holistica-engiadina-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: CLINICA_HOLISTICA_KEY,
  companyLabel: CLINICA_HOLISTICA_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllClinicaHolisticaJobs,
  isCompanyJob: isClinicaHolisticaJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Clinica Holistica Engiadina crawler failed: ${err?.message || err}`);
  process.exit(1);
});
