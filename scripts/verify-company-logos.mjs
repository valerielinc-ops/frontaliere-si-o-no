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
import { positiveIntFromEnv } from './lib/int-from-env.mjs';
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
    minJobs: positiveIntFromEnv('COMPANY_LOGO_AUDIT_MIN_JOBS', 1),
  });
  const audit = await auditCompanyLogos(loaded.jobs, {
    resolveLogo: resolveCompanyLogoUrl,
    assetBaseUrl: process.env.COMPANY_LOGO_AUDIT_ASSET_BASE_URL || DEFAULT_ASSET_BASE_URL,
    timeoutMs: positiveIntFromEnv('COMPANY_LOGO_AUDIT_TIMEOUT_MS', 8_000),
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
  const qualityReferences = audit.references
    .filter((reference) => reference.qualityStatus === 'low-quality'
      || reference.qualityStatus === 'unverified')
    .map((entry) => ({
      reference: entry.reference,
      kind: entry.kind,
      jobs: entry.jobs,
      companyKeys: entry.companyKeys,
      url: entry.url,
      qualityStatus: entry.qualityStatus,
      qualityReason: entry.qualityReason,
      width: entry.width,
      height: entry.height,
    }));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: {
      path: relativeRepoPath(loaded.sourcePath),
      jobCount: loaded.jobs.length,
    },
    checked: audit.referenceCount,
    ok: audit.validReferenceCount,
    qualityOk: audit.qualityOkReferenceCount,
    broken: brokenReferences.length,
    brokenJobCount: audit.brokenJobCount,
    missing: audit.missing,
    missingJobCount: audit.missingJobCount,
    partial: audit.partial,
    partialJobCount: audit.partialJobCount,
    unverified: audit.unverified,
    unverifiedJobCount: audit.unverifiedJobCount,
    lowQuality: audit.lowQuality,
    lowQualityJobCount: audit.lowQualityJobCount,
    qualityUnverified: audit.qualityUnverified,
    qualityUnverifiedJobCount: audit.qualityUnverifiedJobCount,
    urls: brokenReferences,
    quality: qualityReferences,
  };

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `[verify-company-logos] ${payload.source.jobCount} annunci — riferimenti verificati: ${payload.checked}, `
    + `ok: ${payload.ok}, quality-ok: ${payload.qualityOk}, `
    + `broken: ${payload.broken} (${payload.brokenJobCount} annunci), `
    + `missing: ${payload.missing} (${payload.missingJobCount} annunci), `
    + `low-quality: ${payload.lowQuality} (${payload.lowQualityJobCount} annunci). Scritto ${OUTPUT}`,
  );
}

main().catch((error) => {
  console.error('[verify-company-logos] Fatal:', error);
  process.exit(1);
});
