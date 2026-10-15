#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStandardCrawlerPipeline } from './lib/crawler-template.mjs';
import {
  fetchAllPrivatklinikMeiringenJobs,
  isPrivatklinikMeiringenJob,
  isTrustedDomain,
  PRIVATKLINIK_MEIRINGEN_KEY,
  PRIVATKLINIK_MEIRINGEN_COMPANY_NAME,
} from './lib/privatklinik-meiringen-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
runStandardCrawlerPipeline({
  companyKey: PRIVATKLINIK_MEIRINGEN_KEY,
  companyLabel: PRIVATKLINIK_MEIRINGEN_COMPANY_NAME,
  root: path.resolve(__dirname, '..'),
  fetchJobs: fetchAllPrivatklinikMeiringenJobs,
  isCompanyJob: isPrivatklinikMeiringenJob,
  isTrustedDomain,
  defaultSourceLang: 'de',
}).catch((err) => {
  console.error(`❌ Privatklinik Meiringen crawler failed: ${err?.message || err}`);
  process.exit(1);
});
