#!/usr/bin/env node
/**
 * verify-company-logos.mjs
 *
 * Verifies the effective logo references produced by resolveCompanyLogoUrl()
 * for the canonical assembled job dataset. This covers explicit publisher
 * URLs, local manifest assets and direct external URLs; it does not inspect
 * raw logo fields alone, because those fields omit the resolver map used by
 * the renderer.
 *
 * Run with `npx tsx` because the real resolver lives in a TypeScript module.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompanyLogoUrl } from '../services/jobDataNormalization.ts';
import {
  auditCompanyLogos,
  DEFAULT_ASSET_BASE_URL,
  loadCanonicalJobs,
} from './lib/company-logo-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = process.env.COMPANY_LOGO_VERIFY_OUTPUT
  ? path.resolve(ROOT, process.env.COMPANY_LOGO_VERIFY_OUTPUT)
  : path.join(ROOT, 'data', 'company-logos-broken.json');

function relativeRepoPath(file) {
  const relative = path.relative(ROOT, file);
  return relative && !relative.startsWith('..') ? relative : path.basename(file);
}

async function main() {
  const loaded = await loadCanonicalJobs({
    root: ROOT,
    file: process.env.COMPANY_LOGO_AUDIT_JOBS_FILE || undefined,
    minJobs: Number(process.env.COMPANY_LOGO_AUDIT_MIN_JOBS || 1),
  });
  const audit = await auditCompanyLogos(loaded.jobs, {
    resolveLogo: resolveCompanyLogoUrl,
    assetBaseUrl: process.env.COMPANY_LOGO_AUDIT_ASSET_BASE_URL || DEFAULT_ASSET_BASE_URL,
    timeoutMs: Number(process.env.COMPANY_LOGO_AUDIT_TIMEOUT_MS || 8_000),
  });
  const brokenReferences = audit.references
    .filter((reference) => reference.status === 'broken')
    .map(({ reference, kind, jobs, companyKeys, url, reason, statusCode, contentType }) => ({
      reference,
      kind,
      jobs,
      companyKeys,
      url,
      reason,
      status: statusCode || 0,
      contentType,
    }));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      path: relativeRepoPath(loaded.sourcePath),
      jobCount: loaded.jobs.length,
    },
    checked: audit.referenceCount,
    ok: audit.validReferenceCount,
    broken: brokenReferences.length,
    brokenJobCount: audit.brokenJobCount,
    missing: audit.missing,
    missingJobCount: audit.missingJobCount,
    partial: audit.partial,
    partialJobCount: audit.partialJobCount,
    unverified: audit.unverified,
    urls: brokenReferences,
  };

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `[verify-company-logos] ${payload.source.jobCount} annunci — riferimenti verificati: ${payload.checked}, `
    + `ok: ${payload.ok}, broken: ${payload.broken} (${payload.brokenJobCount} annunci), `
    + `missing: ${payload.missing} (${payload.missingJobCount} annunci). Scritto ${OUTPUT}`,
  );
}

main().catch((error) => {
  console.error('[verify-company-logos] Fatal:', error);
  process.exit(1);
});
