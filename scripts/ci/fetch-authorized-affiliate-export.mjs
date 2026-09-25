#!/usr/bin/env node

/**
 * Fetch the owner-configured commercial affiliate export for L8.
 *
 * PostHog only supplies categorical exposure/click telemetry. Approved money
 * must come from a separately authorised network endpoint. The endpoint and
 * its credential are bridged from Firebase Remote Config by
 * `scripts/load-rc-env.mjs`; this helper only performs a read and writes a
 * runner-local, allowlisted JSON envelope. Missing configuration produces a
 * JSON `null` sentinel so the existing L8 fail-closed path remains observable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOOP_ID = 'L8';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isoDate(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeSourceRef(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'configured-authorised-commercial-endpoint';
  }
}

function readField(raw, key) {
  if (!object(raw)) return null;
  const nested = object(raw.data) ? raw.data : null;
  return nested?.[key] ?? raw[key] ?? null;
}

function readRows(raw) {
  if (Array.isArray(raw)) return raw;
  const nested = object(raw?.data) ? raw.data : null;
  return Array.isArray(raw?.transactions)
    ? raw.transactions
    : (Array.isArray(raw?.rows)
      ? raw.rows
      : (Array.isArray(nested?.transactions)
        ? nested.transactions
        : (Array.isArray(nested?.rows) ? nested.rows : null)));
}

function readPeriod(raw) {
  const period = readField(raw, 'period');
  if (!object(period)) return undefined;
  const from = text(period.from);
  const to = text(period.to);
  return from && to ? { from, to } : undefined;
}

function readClicks(raw) {
  const clicks = readField(raw, 'clicks');
  if (!object(clicks)) return undefined;
  const result = {};
  for (const key of ['web', 'email', 'relevant', 'total']) {
    if (clicks[key] === undefined || clicks[key] === null) continue;
    const value = nonNegativeNumber(clicks[key]);
    if (value === null) return undefined;
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Convert a network response into the narrow L8 commercial contract.
 * Unknown response fields are deliberately discarded so an export cannot
 * accidentally persist account, recipient or other identifying data.
 */
export function normalizeAuthorizedAffiliateExport(raw, {
  sourceUrl,
  sourceLabel = null,
  amountFormat = null,
} = {}) {
  const rows = readRows(raw);
  if (!Array.isArray(rows)) {
    throw new Error('authorised commercial export must contain transactions or rows');
  }

  const generatedAt = isoDate(
    readField(raw, 'generatedAt')
      || readField(raw, 'exportedAt')
      || readField(raw, 'updatedAt'),
  );
  if (!generatedAt) {
    throw new Error('authorised commercial export generatedAt is missing or invalid');
  }

  const rawExposures = readField(raw, 'exposures');
  if (!object(rawExposures)) {
    throw new Error('authorised commercial export exposures are missing');
  }
  const exposures = {
    web: nonNegativeNumber(rawExposures.web),
    email: nonNegativeNumber(rawExposures.email),
  };
  if (exposures.web === null && exposures.email === null) {
    throw new Error('authorised commercial export has no valid web/email exposure denominator');
  }

  if (readField(raw, 'independent') === false) {
    throw new Error('authorised commercial export explicitly marks itself independent=false');
  }

  const existingEvidence = readField(raw, 'evidence');
  const sourceRefs = Array.isArray(existingEvidence?.sourceRefs)
    ? existingEvidence.sourceRefs.filter(text)
    : [];
  const source = text(sourceLabel)
    || text(existingEvidence?.source)
    || safeSourceRef(sourceUrl);
  const resolvedAmountFormat = text(readField(raw, 'amountFormat')) || text(amountFormat);
  const period = readPeriod(raw);
  const clicks = readClicks(raw);

  return {
    schemaVersion: 1,
    loopId: LOOP_ID,
    // The endpoint is owner-configured as the independent commercial source;
    // this flag is explicit in the generated envelope, never inferred from
    // PostHog telemetry.
    generatedAt,
    independent: true,
    ...(resolvedAmountFormat ? { amountFormat: resolvedAmountFormat } : {}),
    ...(period ? { period } : {}),
    ...(clicks ? { clicks } : {}),
    exposures,
    transactions: rows,
    evidence: {
      source,
      sourceRefs: [...new Set([
        ...sourceRefs,
        'authorised-affiliate-commercial-export',
        'l8.external-commercial-endpoint',
      ])],
      status: 'commercial-export-present',
      commercialLedger: 'supplied-by-authorised-export',
    },
  };
}

export async function fetchAuthorizedAffiliateExport({
  url = process.env.AFFILIATE_REVENUE_EXPORT_URL,
  token = process.env.AFFILIATE_REVENUE_EXPORT_TOKEN,
  authHeader = process.env.AFFILIATE_REVENUE_EXPORT_AUTH_HEADER,
  sourceLabel = process.env.AFFILIATE_REVENUE_EXPORT_SOURCE,
  amountFormat = process.env.AFFILIATE_REVENUE_AMOUNT_FORMAT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!text(url)) {
    return {
      available: false,
      reason: 'AFFILIATE_REVENUE_EXPORT_URL is not configured',
      export: null,
    };
  }
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');

  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('AFFILIATE_REVENUE_EXPORT_URL is invalid');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('AFFILIATE_REVENUE_EXPORT_URL must use HTTPS');
  }

  const headers = { accept: 'application/json' };
  const configuredAuthHeader = text(authHeader);
  const configuredToken = text(token);
  if (configuredAuthHeader) headers.authorization = configuredAuthHeader;
  else if (configuredToken) headers.authorization = `Bearer ${configuredToken}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(endpoint.href, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`authorised commercial export request failed (${safeSourceRef(endpoint.href)}): ${error.message}`);
    }

    if (!response?.ok) {
      throw new Error(`authorised commercial export returned HTTP ${response?.status ?? 'unknown'} (${safeSourceRef(endpoint.href)})`);
    }
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`authorised commercial export exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error(`authorised commercial export exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new Error('authorised commercial export response is not valid JSON');
    }
    return {
      available: true,
      reason: null,
      export: normalizeAuthorizedAffiliateExport(raw, { sourceUrl: endpoint.href, sourceLabel, amountFormat }),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function writeJson(outputPath, value) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function valueAfter(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1] || fallback;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const outputPath = valueAfter(argv, '--out');
  if (!outputPath) throw new Error('--out is required');
  const result = await fetchAuthorizedAffiliateExport({
    url: env.AFFILIATE_REVENUE_EXPORT_URL,
    token: env.AFFILIATE_REVENUE_EXPORT_TOKEN,
    authHeader: env.AFFILIATE_REVENUE_EXPORT_AUTH_HEADER,
    sourceLabel: env.AFFILIATE_REVENUE_EXPORT_SOURCE,
    amountFormat: env.AFFILIATE_REVENUE_AMOUNT_FORMAT,
    fetchImpl,
  });
  writeJson(outputPath, result.export);
  if (!result.available) logger.log(`[L8] ${result.reason}; commercial ledger remains unmeasurable`);
  else logger.log('[L8] fetched authorised commercial export into runner-local evidence');
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`[L8 commercial export] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
