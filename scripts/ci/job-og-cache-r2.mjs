#!/usr/bin/env node
/**
 * Second tier of the per-job OG card cache, on the project's R2 bucket.
 *
 * actions/cache stays the primary tier. It is shared with much larger caches
 * under the repository's 10 GB limit, so LRU eviction can drop every
 * `og-jobs-*` entry between two deploys. A miss then spends the whole
 * JOB_OG_RENDER_BUDGET_S on a cold render, and does so again on the following
 * builds until the set is refilled.
 *
 *   save     after a COMPLETE render (no deferred card, no error): stream the live cache
 *            files into one object per raster version, overwritten in place.
 *   restore  only on an actions/cache miss: stream that object back.
 *
 * Cached bytes are copied verbatim under the same content-addressed filenames
 * (`<slug>.<photoKey>.<logoFingerprint>.<version>.webp`), so a hydrated card is
 * the card an actions/cache hit would have served.
 *
 * Both commands are fail-open: any problem leaves the cache as it was and the
 * build renders what is missing. Credentials are the R2_* variables already
 * loaded from Remote Config.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JOB_OG_IMAGE_VERSION } from '../../build-plugins/shared/jobOgImageVersion.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const CACHE_DIR = '.cache/og-jobs';
const COMPLETION_MARKER = '.complete';
export const ARCHIVE_MANIFEST = '.r2-manifest.json';
const REQUIRED_ENV = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_S3_ENDPOINT', 'R2_BUCKET'];

// Outside every prefix the CDN publisher syncs or the janitor prunes.
export function archiveKey(version = JOB_OG_IMAGE_VERSION) {
  return `build-cache/og-jobs/${version}/cards.tar`;
}

// A plain card filename: no directory part, no leading dot or dash (tar option
// injection), no line break (the tar member list is newline separated).
function isCardName(name) {
  return typeof name === 'string' && /^[^-./\\\r\n][^/\\\r\n]*\.webp$/.test(name);
}

function fileSize(filePath) {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

function waitFor(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`${label}: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${signal ?? code}`));
    });
  });
}

/** `producer | consumer`, failing when either side fails. */
async function pipeline(producer, consumer) {
  const source = spawn(producer.command, producer.args, { env: producer.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const sink = spawn(consumer.command, consumer.args, { env: consumer.env, stdio: ['pipe', 'inherit', 'inherit'] });
  // A sink that dies early closes the pipe; its exit status carries the error.
  sink.stdin.on('error', () => {});
  source.stdout.pipe(sink.stdin);
  sink.once('close', () => source.stdout.destroy());
  const results = await Promise.allSettled([waitFor(source, producer.command), waitFor(sink, consumer.command)]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new Error(failures.map((failure) => failure.reason.message).join('; '));
}

function awsCopy(env, from, to, extraArgs = []) {
  return {
    command: 'aws',
    args: [
      '--no-cli-pager', '--endpoint-url', env.R2_S3_ENDPOINT, '--region', 'auto',
      's3', 'cp', from, to, '--only-show-errors', ...extraArgs,
    ],
    env: {
      ...env,
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      AWS_EC2_METADATA_DISABLED: 'true',
      // R2 does not implement the default CRC trailers of recent CLI releases.
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
    },
  };
}

export async function restoreFromR2({ rootDir = process.cwd(), env = process.env, version = JOB_OG_IMAGE_VERSION } = {}) {
  const cacheDir = path.join(rootDir, CACHE_DIR);
  mkdirSync(cacheDir, { recursive: true });
  // Sibling of the cache directory: same filesystem for the rename, and never
  // picked up by the actions/cache save.
  const staging = mkdtempSync(`${cacheDir}-r2-`);
  try {
    await pipeline(
      awsCopy(env, `s3://${env.R2_BUCKET}/${archiveKey(version)}`, '-'),
      { command: 'tar', args: ['-xf', '-', '-C', staging], env },
    );
    const manifest = JSON.parse(readFileSync(path.join(staging, ARCHIVE_MANIFEST), 'utf-8'));
    if (manifest?.version !== version || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error('archive manifest is missing, empty or for another raster version');
    }
    // Check everything before publishing anything: a truncated card must never
    // reach the cache, where its filename alone would make it a hit.
    for (const file of manifest.files) {
      if (!isCardName(file?.name) || fileSize(path.join(staging, file.name)) !== file.size) {
        throw new Error(`archive does not match its manifest at ${JSON.stringify(file?.name)}`);
      }
    }
    let restored = 0;
    for (const file of manifest.files) {
      const target = path.join(cacheDir, file.name);
      if (existsSync(target)) continue;
      renameSync(path.join(staging, file.name), target);
      restored += 1;
    }
    return { restored };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function saveToR2({ rootDir = process.cwd(), env = process.env, version = JOB_OG_IMAGE_VERSION } = {}) {
  const cacheDir = path.join(rootDir, CACHE_DIR);
  const marker = JSON.parse(readFileSync(path.join(cacheDir, COMPLETION_MARKER), 'utf-8'));
  // A partial pass must not replace the last complete set.
  if (marker.deferred !== 0 || marker.errors !== 0) {
    return { saved: 0, reason: `render pass is partial (deferred=${marker.deferred} errors=${marker.errors})` };
  }
  if (!Array.isArray(marker.liveEntries)) return { saved: 0, reason: 'completion marker has no liveEntries list' };
  // Only the cards of the current jobs: the directory also keeps orphans of
  // closed jobs, which would grow a persistent archive without bound.
  const files = [...new Set(marker.liveEntries)]
    .filter(isCardName)
    .map((name) => ({ name, size: fileSize(path.join(cacheDir, name)) }))
    .filter((file) => file.size !== null && file.size > 0);
  if (files.length === 0) return { saved: 0, reason: 'no live card on disk' };

  const staging = mkdtempSync(`${cacheDir}-r2-`);
  // Written next to the cards so a single `-C` serves every member (bsdtar and
  // GNU tar disagree on options placed between member names).
  const manifestPath = path.join(cacheDir, ARCHIVE_MANIFEST);
  try {
    writeFileSync(manifestPath, JSON.stringify({ version, files }));
    const memberList = path.join(staging, 'members.txt');
    writeFileSync(memberList, `${[ARCHIVE_MANIFEST, ...files.map((file) => file.name)].join('\n')}\n`);
    // Needed by the CLI to size multipart chunks for a stream; tar adds headers.
    const expectedSize = files.reduce((total, file) => total + file.size + 2048, 1_048_576);
    await pipeline(
      { command: 'tar', args: ['-cf', '-', '-C', cacheDir, '-T', memberList], env },
      awsCopy(env, '-', `s3://${env.R2_BUCKET}/${archiveKey(version)}`, ['--expected-size', String(expectedSize)]),
    );
    return { saved: files.length };
  } finally {
    rmSync(manifestPath, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(command) {
  if (command !== 'restore' && command !== 'save') {
    console.error('Usage: job-og-cache-r2.mjs <restore|save>');
    process.exitCode = 2;
    return;
  }
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.log(`::warning::[job-og-cache-r2] ${command} skipped, missing ${missing.join(', ')}`);
    return;
  }
  const startedAt = Date.now();
  try {
    const result = command === 'restore' ? await restoreFromR2() : await saveToR2();
    console.log(`[job-og-cache-r2] ${command} ${JSON.stringify(result)} seconds=${Math.round((Date.now() - startedAt) / 1000)}`);
  } catch (error) {
    console.log(`::warning::[job-og-cache-r2] ${command} failed after ${Math.round((Date.now() - startedAt) / 1000)}s: ${error.message}`);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  await main(process.argv[2]);
}
