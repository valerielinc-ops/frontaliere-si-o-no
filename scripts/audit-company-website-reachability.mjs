#!/usr/bin/env node
/**
 * Audit the public company websites published by the crawler registry.
 *
 * The crawler deliberately publishes a bare HTTPS origin when the resolver
 * has no single verified apex/www winner. This audit probes exactly that
 * published origin, with the verified resolver target substituted when one is
 * available, and fails when the measured unreachable-host count exceeds the
 * committed baseline.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpecUrlPolicy } from './lib/prospector/public-fetch-policy.mjs';
import { mapPool, politeFetch } from './lib/prospector/polite-fetch.mjs';

export const COMPANY_WEBSITE_REACHABILITY_SCHEMA_VERSION = 1;
export const DEFAULT_COMPANY_WEBSITE_REACHABILITY_CONCURRENCY = 6;
export const DEFAULT_COMPANY_WEBSITE_REACHABILITY_TIMEOUT_MS = 15_000;
export const HEAD_FALLBACK_STATUSES = Object.freeze(new Set([403, 405, 501]));

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_COMPANIES_PATH = join(ROOT, 'data/crawler-companies-auto.json');
const DEFAULT_RESOLVED_PATH = join(ROOT, 'data/company-website-resolved.json');
const DEFAULT_BASELINE_PATH = join(ROOT, 'data/company-website-reachability-baseline.json');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function companyLabel(company, index) {
  return String(company?.key || company?.name || `company-${index + 1}`).trim();
}

function parseHttpsUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol !== 'https:') return { error: 'published website is not HTTPS' };
    if (url.username || url.password) return { error: 'published website contains credentials' };
    if (!url.hostname) return { error: 'published website has no hostname' };
    return { url };
  } catch {
    return { error: 'published website is not a valid URL' };
  }
}

export function normalizeCompanyWebsiteDomain(rawUrl) {
  const parsed = parseHttpsUrl(rawUrl);
  if (!parsed.url) return null;
  const hostname = parsed.url.hostname.toLowerCase().replace(/\.$/, '');
  return hostname.replace(/^www\./, '') || null;
}

function originForPublishedWebsite(rawUrl) {
  const parsed = parseHttpsUrl(rawUrl);
  if (!parsed.url) return { error: parsed.error };
  const domain = normalizeCompanyWebsiteDomain(parsed.url.href);
  if (!domain) return { error: 'published website has no normalizable domain' };
  return { domain, targetUrl: `https://${domain}/` };
}

function resolverTarget(domain, rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
    return { targetUrl: `https://${domain}/` };
  }
  const parsed = parseHttpsUrl(rawTarget);
  if (!parsed.url) return { error: `resolver target: ${parsed.error}` };
  const targetDomain = normalizeCompanyWebsiteDomain(parsed.url.href);
  if (targetDomain !== domain) {
    return { error: `resolver target leaves published domain ${domain}` };
  }
  return { targetUrl: `${parsed.url.origin}/` };
}

/**
 * Build one probe target per published host. Apex/www records are one host
 * identity for this gate because the generator publishes the resolver winner
 * or the bare apex fallback for both forms.
 *
 * @param {Array<Record<string, unknown>>} companies
 * @param {Record<string, string|null>} [resolvedDomains]
 */
export function buildCompanyWebsiteTargets(companies, resolvedDomains = {}) {
  const targetsByDomain = new Map();
  for (const [index, company] of (Array.isArray(companies) ? companies : []).entries()) {
    const rawWebsite = typeof company?.website === 'string' ? company.website.trim() : '';
    if (!rawWebsite) continue;
    const label = companyLabel(company, index);
    const published = originForPublishedWebsite(rawWebsite);
    if (published.error) {
      const invalidKey = `invalid:${index}:${rawWebsite}`;
      targetsByDomain.set(invalidKey, {
        domain: invalidKey,
        targetUrl: null,
        companies: [label],
        sourceUrls: [rawWebsite],
        invalidReason: published.error,
      });
      continue;
    }

    const domain = published.domain;
    const resolvedTarget = hasOwn(resolvedDomains, domain)
      ? resolverTarget(domain, resolvedDomains[domain])
      : { targetUrl: published.targetUrl };
    const existing = targetsByDomain.get(domain);
    if (existing) {
      existing.companies.push(label);
      existing.sourceUrls.push(rawWebsite);
      continue;
    }
    targetsByDomain.set(domain, {
      domain,
      targetUrl: resolvedTarget.targetUrl || null,
      ...(resolvedTarget.error ? { invalidReason: resolvedTarget.error } : {}),
      companies: [label],
      sourceUrls: [rawWebsite],
    });
  }
  return [...targetsByDomain.values()];
}

function responseResult(response, targetUrl, method) {
  const status = Number(response?.status || 0);
  const result = {
    reachable: Boolean(response?.ok),
    status,
    method,
    url: String(response?.url || targetUrl),
  };
  if (response?.ok) result.verified = true;
  if (response?.blockedByRobots) {
    result.reachable = true;
    result.verified = false;
    result.reason = 'robots-blocked';
  } else if (response?.policyBlocked) {
    const policyError = String(response.error || '');
    result.policyBlocked = true;
    result.error = policyError || undefined;
    // The public-fetch policy rejects a redirect outside the exact seed
    // origin. That rejection proves the seed answered, but not that the
    // final destination is a valid company website; report it as unverified,
    // not as a dead host. DNS/private-target policy failures remain scan
    // errors and never inflate the unreachable baseline.
    if (/prospector (?:robots origin|URL origin) not allowed:/i.test(policyError)) {
      result.reachable = true;
      result.verified = false;
      result.reason = 'unverified-policy-redirect';
    } else {
      result.reason = 'policy-blocked';
      result.scanError = true;
    }
  } else if (status === 429) {
    result.reachable = true;
    result.verified = false;
    result.reason = 'rate-limited';
  } else if (response?.error) {
    result.error = String(response.error);
  } else if (response?.transportError) {
    result.error = String(response.transportError);
  }
  if (response?.error && !result.error) result.error = String(response.error);
  return result;
}

function failureReason(result) {
  if (result.reason) return result.reason;
  if (result.status > 0) return `http-${result.status}`;
  return result.error || 'connection-failure';
}

function shouldTryGetAfterHead(result) {
  return !result.reachable
    && !result.reason
    && (result.status === 0 || HEAD_FALLBACK_STATUSES.has(result.status));
}

function createWebsiteFetch(targetUrl) {
  const parsed = new URL(targetUrl);
  const aliases = [targetUrl];
  const aliasHost = parsed.hostname.startsWith('www.')
    ? parsed.hostname.slice(4)
    : `www.${parsed.hostname}`;
  if (aliasHost && aliasHost !== parsed.hostname) {
    aliases.push(new URL(targetUrl).toString().replace(parsed.hostname, aliasHost));
  }
  const policy = createSpecUrlPolicy({ seedUrls: aliases });
  const request = (url, options) => politeFetch(url, {
    ...options,
    urlPolicy: policy,
    dispatcher: policy.dispatcher,
  });
  return { policy, request };
}

/**
 * Probe one published origin. HEAD is preferred; GET is used for servers that
 * reject or cannot transport HEAD, so a harmless method restriction is not
 * recorded as a dead website. Robots denial is reported as unverified rather
 * than as a dead host because the source explicitly answered the crawler.
 */
export async function probePublishedWebsite(
  targetUrl,
  { fetchImpl = politeFetch, timeoutMs = DEFAULT_COMPANY_WEBSITE_REACHABILITY_TIMEOUT_MS } = {},
) {
  const parsed = parseHttpsUrl(targetUrl);
  if (!parsed.url) {
    return {
      reachable: false,
      status: 0,
      method: null,
      url: targetUrl,
      reason: parsed.error,
    };
  }

  let request = fetchImpl;
  let policy = null;
  if (fetchImpl === politeFetch) {
    ({ policy, request } = createWebsiteFetch(parsed.url.href));
  }
  const options = {
    timeoutMs,
    retries: 0,
    accept: 'text/html,application/xhtml+xml,*/*',
  };
  try {
    let head;
    try {
      head = responseResult(await request(parsed.url.href, { ...options, method: 'HEAD' }), parsed.url.href, 'HEAD');
    } catch (error) {
      head = { reachable: false, status: 0, method: 'HEAD', url: parsed.url.href, error: String(error?.message || error) };
    }
    if (head.reachable || head.reason === 'robots-blocked') return head;
    if (!shouldTryGetAfterHead(head)) return { ...head, reason: failureReason(head) };

    let get;
    try {
      get = responseResult(await request(parsed.url.href, { ...options, method: 'GET' }), parsed.url.href, 'GET');
    } catch (error) {
      get = { reachable: false, status: 0, method: 'GET', url: parsed.url.href, error: String(error?.message || error) };
    }
    if (get.reachable || get.reason === 'robots-blocked') return get;
    return { ...get, reason: failureReason(get), headStatus: head.status };
  } finally {
    await policy?.dispatcher?.close?.();
  }
}

export function parseReachabilityBaseline(value) {
  const maxUnreachable = Number(value?.maxUnreachable);
  if (!Number.isInteger(maxUnreachable) || maxUnreachable < 0) {
    throw new Error('company website reachability baseline must define a non-negative integer maxUnreachable');
  }
  return {
    schemaVersion: Number(value?.schemaVersion || COMPANY_WEBSITE_REACHABILITY_SCHEMA_VERSION),
    maxUnreachable,
    ...(Number.isInteger(Number(value?.baselineWebsites)) ? { baselineWebsites: Number(value.baselineWebsites) } : {}),
    ...(value?.basis ? { basis: String(value.basis) } : {}),
  };
}

/**
 * @param {Array<Record<string, unknown>>} companies
 * @param {{ resolvedDomains?: Record<string, string|null>, baseline?: Record<string, unknown>, probeImpl?: typeof probePublishedWebsite, concurrency?: number, timeoutMs?: number }} [options]
 */
export async function auditCompanyWebsiteReachability(companies, {
  resolvedDomains = {},
  baseline = { maxUnreachable: 22 },
  probeImpl = probePublishedWebsite,
  concurrency = DEFAULT_COMPANY_WEBSITE_REACHABILITY_CONCURRENCY,
  timeoutMs = DEFAULT_COMPANY_WEBSITE_REACHABILITY_TIMEOUT_MS,
} = {}) {
  const list = Array.isArray(companies) ? companies : [];
  const targets = buildCompanyWebsiteTargets(list, resolvedDomains);
  const safeConcurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = await mapPool(targets, safeConcurrency, async (target) => {
    if (!target.targetUrl || target.invalidReason) {
      return {
        ...target,
        reachable: false,
        verified: false,
        status: 0,
        method: null,
        reason: target.invalidReason || 'invalid-published-website',
      };
    }
    try {
      const observation = await probeImpl(target.targetUrl, { timeoutMs });
      if (!observation || typeof observation.reachable !== 'boolean') {
        throw new Error('probe returned no reachability verdict');
      }
      return {
        ...target,
        ...observation,
        ...(observation.reachable && !observation.reason ? { reason: 'ok' } : {}),
        ...(!observation.reachable && !observation.reason
          ? { reason: failureReason(observation) }
          : {}),
      };
    } catch (error) {
      return {
        ...target,
        reachable: false,
        verified: false,
        status: 0,
        method: null,
        reason: 'probe-error',
        error: String(error?.message || error),
      };
    }
  });
  const parsedBaseline = parseReachabilityBaseline(baseline);
  const unreachable = results.filter((result) => !result?.reachable && !result?.scanError);
  const unverified = results.filter((result) => result?.reachable && result?.verified === false);
  const scanErrors = results.filter((result) => result?.scanError || result?.reason === 'probe-error');
  const report = {
    schemaVersion: COMPANY_WEBSITE_REACHABILITY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: 'data/crawler-companies-auto.json',
    publishedCompanies: list.length,
    publishedWebsites: list.filter((company) => typeof company?.website === 'string' && company.website.trim()).length,
    auditedHosts: results.length,
    reachableHosts: results.filter((result) => result?.reachable).length,
    verifiedHosts: results.filter((result) => result?.reachable && result?.verified !== false).length,
    unverifiedHosts: unverified.length,
    scanErrors: scanErrors.length,
    unreachableHosts: unreachable.length,
    baseline: parsedBaseline,
    exceeded: unreachable.length > parsedBaseline.maxUnreachable,
    reliable: scanErrors.length === 0,
    results,
  };
  return report;
}

function parseArgs(argv) {
  const args = new Map();
  for (const [index, raw] of argv.entries()) {
    if (!raw.startsWith('--')) continue;
    const equal = raw.indexOf('=');
    if (equal >= 0) {
      args.set(raw.slice(2, equal), raw.slice(equal + 1));
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args.set(raw.slice(2), argv[index + 1]);
    } else {
      args.set(raw.slice(2), true);
    }
  }
  return args;
}

function pathArg(value, fallback) {
  if (!value || value === true) return fallback;
  return isAbsolute(String(value)) ? String(value) : resolve(ROOT, String(value));
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, 'utf8'));
}

async function readOptionalJson(pathname, fallback) {
  try {
    return await readJson(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function runCompanyWebsiteReachabilityAudit(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const companiesData = await readJson(pathArg(args.get('input'), DEFAULT_COMPANIES_PATH));
  const companies = Array.isArray(companiesData) ? companiesData : companiesData?.companies;
  if (!Array.isArray(companies)) throw new Error('crawler company registry is not an array');
  const resolvedData = await readOptionalJson(pathArg(args.get('resolved'), DEFAULT_RESOLVED_PATH), {});
  const resolvedDomains = resolvedData?.domains && typeof resolvedData.domains === 'object'
    ? resolvedData.domains
    : resolvedData;
  const baseline = parseReachabilityBaseline(await readJson(
    pathArg(args.get('baseline'), DEFAULT_BASELINE_PATH),
  ));
  const report = await auditCompanyWebsiteReachability(companies, {
    resolvedDomains: resolvedDomains && typeof resolvedDomains === 'object' ? resolvedDomains : {},
    baseline,
    concurrency: Number(args.get('concurrency') ?? DEFAULT_COMPANY_WEBSITE_REACHABILITY_CONCURRENCY),
    timeoutMs: Number(args.get('timeout-ms') ?? DEFAULT_COMPANY_WEBSITE_REACHABILITY_TIMEOUT_MS),
  });
  const outputPath = args.get('json');
  if (outputPath && outputPath !== true) {
    const pathname = pathArg(outputPath, null);
    await mkdir(dirname(pathname), { recursive: true });
    await writeFile(pathname, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`Company websites: ${report.publishedWebsites} published · ${report.auditedHosts} hosts audited`);
  console.log(`Reachable: ${report.reachableHosts} · verified: ${report.verifiedHosts} · unverified: ${report.unverifiedHosts} · unreachable: ${report.unreachableHosts} · scan-errors: ${report.scanErrors} · baseline: ${report.baseline.maxUnreachable}`);
  if (!report.reliable) {
    console.error(`Company website reachability audit could not verify ${report.scanErrors} host(s) because the public-fetch policy rejected the probe`);
    process.exitCode = 2;
  } else if (report.exceeded) {
    console.error(`Company website reachability baseline exceeded: ${report.unreachableHosts} > ${report.baseline.maxUnreachable}`);
    process.exitCode = 1;
  }
  return report;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  runCompanyWebsiteReachabilityAudit().catch((error) => {
    console.error(`Company website reachability audit failed: ${error?.message || error}`);
    process.exitCode = 2;
  });
}
