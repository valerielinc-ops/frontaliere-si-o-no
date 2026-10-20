#!/usr/bin/env node
/**
 * Re-check downloaded logo bytes before they become a PR candidate.
 *
 * The downloader validates the HTTP response. This second pass validates the
 * exact local asset that will be committed, including its intrinsic quality.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assessLogoQuality,
  detectLogoExtension,
  MAX_LOGO_BODY_BYTES,
  readImageDimensions,
} from './lib/company-logo-audit.mjs';
import { isGreyGlobe } from './lib/google-favicon.mjs';

const ROOT = path.resolve(process.cwd());

function parseArgs(argv) {
  const options = {
    input: process.env.COMPANY_LOGO_ACQUISITION_RESULT
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_ACQUISITION_RESULT)
      : null,
    output: process.env.COMPANY_LOGO_ACQUISITION_VERIFIED_RESULT
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_ACQUISITION_VERIFIED_RESULT)
      : path.join(ROOT, 'data', 'company-logo-acquisition-verified.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input' && argv[index + 1]) options.input = path.resolve(ROOT, argv[++index]);
    else if (argv[index] === '--output' && argv[index + 1]) options.output = path.resolve(ROOT, argv[++index]);
  }
  if (!options.input) throw new Error('Acquisition result required: use --input <file>.');
  return options;
}

async function writeGithubOutput(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await appendFile(output, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

function failureResult(target, reason) {
  return {
    ...target,
    status: 'failed',
    verified: false,
    reason,
  };
}

async function verifyTarget(target) {
  if (target.status !== 'downloaded') return failureResult(target, target.reason || 'acquisition-failed');
  const publicPath = String(target.path || '');
  const relative = publicPath.replace(/^\/+/, '');
  if (!publicPath.startsWith('/images/brands/') || relative.includes('..')) {
    return failureResult(target, 'asset-path-not-allowed');
  }
  const file = path.join(ROOT, 'public', relative);
  if (!existsSync(file)) return failureResult(target, 'asset-not-written');

  let body;
  try {
    body = await readFile(file);
  } catch {
    return failureResult(target, 'asset-not-readable');
  }
  if (body.length === 0) return failureResult(target, 'empty-body');
  if (body.length > MAX_LOGO_BODY_BYTES) return failureResult(target, 'body-too-large');
  if (isGreyGlobe(body)) return failureResult(target, 'grey-globe');

  const format = detectLogoExtension(body, '');
  if (!format) return failureResult(target, 'not-an-image');
  const dimensions = readImageDimensions(body, format);
  const quality = assessLogoQuality({ format, ...(dimensions || {}) });
  if (quality.status !== 'good') {
    return failureResult(
      { ...target, format, width: dimensions?.width || null, height: dimensions?.height || null },
      quality.status === 'unverified' ? 'quality-unverified' : 'quality-insufficient',
    );
  }

  return {
    ...target,
    status: 'verified',
    verified: true,
    size: body.length,
    format,
    width: dimensions?.width || null,
    height: dimensions?.height || null,
    qualityStatus: quality.status,
    qualityReason: quality.reason,
    reason: null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(await readFile(options.input, 'utf8'));
  } catch (error) {
    const missing = {
      generatedAt: new Date().toISOString(),
      targets: [],
      acquired: 0,
      failed: 1,
      qualityRejected: 0,
      eligible: false,
      fatalReason: error.code === 'ENOENT' ? 'acquisition-result-missing' : 'acquisition-result-invalid',
    };
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(missing, null, 2)}\n`);
    await writeGithubOutput({ eligible: false, acquired: 0, failed: 1, quality_rejected: 0 });
    console.error(`[verify-company-logo-acquisition] ${missing.fatalReason}: ${options.input}`);
    process.exitCode = 1;
    return;
  }

  const rawTargets = Array.isArray(input.targets) ? input.targets : [];
  const targets = [];
  let acquired = 0;
  let failed = 0;
  let qualityRejected = 0;
  for (const target of rawTargets) {
    const result = await verifyTarget(target);
    targets.push(result);
    if (result.verified) {
      acquired += 1;
    } else {
      failed += 1;
      if (result.reason === 'quality-insufficient' || result.reason === 'quality-unverified') qualityRejected += 1;
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    input: options.input,
    targets,
    acquired,
    failed,
    qualityRejected,
    eligible: acquired > 0,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  await writeGithubOutput({
    eligible: payload.eligible,
    acquired: payload.acquired,
    failed: payload.failed,
    quality_rejected: payload.qualityRejected,
  });
  console.log(`[verify-company-logo-acquisition] verified=${acquired} failed=${failed} qualityRejected=${qualityRejected}`);
  console.log(`[verify-company-logo-acquisition] Result: ${options.output}`);
  if (failed > 0 || qualityRejected > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[verify-company-logo-acquisition] Fatal:', error);
  process.exit(1);
});
