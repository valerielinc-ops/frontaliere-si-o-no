import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 6_000;

export function normalizeDomain(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return hostname || null;
  } catch {
    return null;
  }
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase();
    if (!hostname) return null;
    return `https://${hostname}${url.pathname === '/' ? '/' : url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function request(url, fetchImpl, timeoutMs) {
  for (const method of ['HEAD', 'GET']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'frontaliere-company-website-resolver/1.0' },
      });
      if (response?.ok) return canonicalUrl(response.url || url);
      if (method === 'HEAD' && response && [403, 405, 501].includes(response.status)) continue;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function resolveCompanyWebsite(domain, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!domain) return null;
  const results = await Promise.all([
    request(`https://${domain}/`, fetchImpl, timeoutMs),
    request(`https://www.${domain}/`, fetchImpl, timeoutMs),
  ]);
  return results[0] && results[0] === results[1] ? results[0] : null;
}

export async function resolveCompanyWebsites(companies, options = {}) {
  const domains = [...new Set(companies.map(({ website }) => normalizeDomain(website)).filter(Boolean))].sort();
  const limit = Number.isInteger(options.limit) ? options.limit : domains.length;
  const selected = domains.slice(0, Math.max(0, limit));
  const entries = await Promise.all(selected.map(async (domain) => [domain, await resolveCompanyWebsite(domain, options)]));
  return Object.fromEntries(entries);
}

export async function run({
  inputPath = path.resolve('data/crawler-companies-auto.json'),
  outputPath = path.resolve('data/company-website-resolved.json'),
  limit = 22,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const companies = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!Array.isArray(companies)) throw new Error('crawler companies input must be an array');
  const domains = await resolveCompanyWebsites(companies, { fetchImpl, timeoutMs, limit });
  const registry = { schemaVersion: 1, domains };
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  let current = null;
  try { current = await readFile(outputPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== serialized) await writeFile(outputPath, serialized);
  return registry;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const limitIndex = process.argv.indexOf('--limit');
  const limit = limitIndex === -1 ? 22 : Number(process.argv[limitIndex + 1]);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const registry = await run({ limit });
  console.log(`resolved ${Object.keys(registry.domains).length} company website domains`);
}
