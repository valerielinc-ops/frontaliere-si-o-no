#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { jobpostingAddressCacheKey } from './lib/jobposting-address-cache.mjs';

function countMatched(entries) {
  return Object.values(entries).filter((entry) => entry?.status === 'matched').length;
}

function isCompleteMatchedEntry(key, entry) {
  return entry?.status === 'matched'
    && entry.source === 'zefix-lindas'
    && String(entry.companyName ?? '').trim().length > 0
    && String(entry.streetAddress ?? '').trim().length > 0
    && /^\d{4}$/.test(String(entry.postalCode ?? '').trim())
    && String(entry.addressLocality ?? '').trim().length > 0
    && /^[A-Z]{2}$/.test(String(entry.addressRegion ?? '').trim())
    && jobpostingAddressCacheKey(entry.companyName, entry.addressLocality, entry.addressRegion) === key;
}

/** Compare every previous match and reject malformed matched entries in the resulting cache. */
function inspectMatchedAddressCoverage(beforeEntries, afterEntries) {
  const previousMatches = Object.entries(beforeEntries)
    .filter(([, entry]) => entry?.status === 'matched');
  const regressions = [];

  for (const [key, entry] of Object.entries(afterEntries)) {
    if (entry?.status === 'matched' && !isCompleteMatchedEntry(key, entry)) {
      regressions.push({ key, reason: 'matched address is incomplete or does not match its cache key' });
    }
  }

  for (const [key] of previousMatches) {
    const current = afterEntries[key];
    if (!current) {
      regressions.push({ key, reason: 'missing' });
    } else if (current.status !== 'matched') {
      regressions.push({ key, reason: `status is ${String(current.status || 'missing')}` });
    }
  }

  const beforeMatched = previousMatches.length;
  const afterMatched = countMatched(afterEntries);
  if (afterMatched < beforeMatched && regressions.length === 0) {
    regressions.push({ key: '', reason: `matched count fell from ${beforeMatched} to ${afterMatched}` });
  }

  return { beforeMatched, afterMatched, regressions };
}

function assertNoMatchedAddressRegression(beforeEntries, afterEntries) {
  const result = inspectMatchedAddressCoverage(beforeEntries, afterEntries);
  if (result.regressions.length) {
    const details = result.regressions
      .map(({ key, reason }) => `${key ? `${key}: ` : ''}${reason}`)
      .join('; ');
    throw new Error(`JobPosting matched-address coverage regressed (${result.beforeMatched} → ${result.afterMatched}): ${details}`);
  }
  return result;
}

function readEntries(filePath) {
  const absolutePath = path.resolve(filePath);
  const cache = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (cache?.version !== 1 || !cache.entries || typeof cache.entries !== 'object' || Array.isArray(cache.entries)) {
    throw new Error(`Invalid JobPosting address cache: ${absolutePath}`);
  }
  return cache.entries;
}

function option(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args = process.argv.slice(2)) {
  const beforePath = option(args, '--before');
  const afterPath = option(args, '--after');
  if (!beforePath || !afterPath) {
    throw new Error('Usage: node scripts/check-jobposting-address-cache-regression.mjs --before <file> --after <file>');
  }

  const result = assertNoMatchedAddressRegression(readEntries(beforePath), readEntries(afterPath));
  console.log(JSON.stringify(result, null, 2));
}

export { assertNoMatchedAddressRegression, inspectMatchedAddressCoverage, isCompleteMatchedEntry };

if ((() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
