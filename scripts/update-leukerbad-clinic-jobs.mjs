#!/usr/bin/env node
/**
 * Dedicated Leukerbad Clinic (RZL Rehabilitationszentrum Leukerbad AG) crawler runner.
 *
 * Source: https://leukerbadclinic.ch/de/page/jobs/ (Nuxt SSG over Prismic CMS).
 * Backed by the public Prismic REST API — no auth, no browser automation needed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllLeukerbadClinicJobs,
  isLeukerbadClinicJob,
  isTrustedDomain,
  LEUKERBAD_CLINIC_KEY,
  LEUKERBAD_CLINIC_COMPANY_NAME,
} from './lib/leukerbad-clinic-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

runStandardCrawlerPipeline({
  companyKey: LEUKERBAD_CLINIC_KEY,
  companyLabel: LEUKERBAD_CLINIC_COMPANY_NAME,
  root: ROOT,
  fetchJobs: fetchAllLeukerbadClinicJobs,
  isCompanyJob: isLeukerbadClinicJob,
  isTrustedDomain,
  defaultSourceLang: 'fr',
}).catch((err) => {
  console.error(`❌ Leukerbad Clinic crawler failed: ${err?.message || err}`);
  process.exit(1);
});
