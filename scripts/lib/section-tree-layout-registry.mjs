#!/usr/bin/env node
import { createR2Request } from './r2-section-lock.mjs';
import { isInvokedDirectly } from './is-invoked-directly.mjs';
import {
  emptySectionTreeLayoutRegistry,
  parseSectionTreeLayoutRegistry,
  sectionTreeLayoutSections,
  SECTION_TREE_LAYOUT_REGISTRY_KEY,
} from '../../infra/cloudflare-worker/section-tree-layout-schema.js';
import { SECTION_TREE_FANOUT_SECTIONS } from '../../infra/cloudflare-worker/ticino-tree-bucket.js';

export { SECTION_TREE_LAYOUT_REGISTRY_KEY };
const MAX_CAS_ATTEMPTS = 8;
const MAX_REGISTRY_BYTES = 64 * 1024;
const CAS_BACKOFF_MS = [50, 100, 200, 400, 800, 1200, 1600];

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.[name] ?? null;
}

async function responseBody(response) {
  if (typeof response?.text === 'function') return response.text();
  return '';
}

export async function readSectionTreeLayoutRegistry({ request = createR2Request() } = {}) {
  const response = await request({ method: 'GET', key: SECTION_TREE_LAYOUT_REGISTRY_KEY });
  if (response.status === 404) return { ...emptySectionTreeLayoutRegistry(), etag: null };
  const body = await responseBody(response);
  if (body.length > MAX_REGISTRY_BYTES) {
    throw new Error('[section-tree-layout] R2 registry exceeds the size limit');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`[section-tree-layout] R2 registry read failed (${response.status})`);
  }
  let parsed;
  try {
    parsed = parseSectionTreeLayoutRegistry(JSON.parse(body));
  } catch (error) {
    throw new Error(`[section-tree-layout] R2 registry is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...parsed, etag: responseHeader(response, 'etag') };
}

function serializeRegistry(registry) {
  const sections = Object.fromEntries(
    Object.entries(registry.sections).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({ version: 1, sections });
}

export async function registerSectionTreeFanout(section, reason, {
  request = createR2Request(),
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = MAX_CAS_ATTEMPTS,
} = {}) {
  if (typeof section !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(section)) {
    throw new Error('[section-tree-layout] invalid section name');
  }
  if (!reason || !['it', 'en', 'de', 'fr'].includes(reason.locale)
    || typeof reason.pct !== 'number' || !Number.isFinite(reason.pct) || reason.pct < 0) {
    throw new Error('[section-tree-layout] reason needs a locale and a finite non-negative pct');
  }
  if (SECTION_TREE_FANOUT_SECTIONS.includes(section)) {
    return { added: false, registry: emptySectionTreeLayoutRegistry() };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await readSectionTreeLayoutRegistry({ request });
    if (current.sections[section]) return { added: false, registry: current };
    if (current.etag && /^W\//u.test(current.etag)) {
      throw new Error('[section-tree-layout] registry ETag is weak; refusing a non-strong CAS write');
    }
    const registry = {
      version: 1,
      sections: {
        ...current.sections,
        [section]: {
          layout: 'hash-v1',
          since: now().toISOString(),
          reason: { locale: reason.locale, pct: reason.pct },
        },
      },
    };
    const headers = {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...(current.etag ? { 'if-match': current.etag } : { 'if-none-match': '*' }),
    };
    const response = await request({
      method: 'PUT',
      key: SECTION_TREE_LAYOUT_REGISTRY_KEY,
      body: serializeRegistry(registry),
      headers,
    });
    if (response.status >= 200 && response.status < 300) return { added: true, registry };
    if (response.status !== 409 && response.status !== 412) {
      await responseBody(response);
      throw new Error(`[section-tree-layout] R2 registry write failed (${response.status})`);
    }
    if (attempt + 1 < maxAttempts) await sleep(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)]);
  }
  throw new Error(`[section-tree-layout] could not add ${section} after ${maxAttempts} registry CAS attempts`);
}

export async function readSectionTreeLayoutSections(options) {
  const registry = await readSectionTreeLayoutRegistry(options);
  return sectionTreeLayoutSections(registry);
}

function flag(args, name) {
  const position = args.indexOf(name);
  if (position === -1 || !args[position + 1]) throw new Error(`[section-tree-layout] ${name} is required`);
  return args[position + 1];
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === 'sections') {
    process.stdout.write(`${JSON.stringify(await readSectionTreeLayoutSections())}\n`);
    return;
  }
  if (command === 'add') {
    const result = await registerSectionTreeFanout(flag(args, '--section'), {
      locale: flag(args, '--locale'),
      pct: Number(flag(args, '--pct')),
    });
    process.stdout.write(`${JSON.stringify({ added: result.added, sections: sectionTreeLayoutSections(result.registry) })}\n`);
    return;
  }
  throw new Error('usage: section-tree-layout-registry.mjs <sections|add --section NAME --locale LOCALE --pct PCT>');
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
