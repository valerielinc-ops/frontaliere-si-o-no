import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_VERSION = 1;
export const SOURCE_VERSION = 'input@1';

export const PAGE_KINDS = Object.freeze([
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
  'related-search-cluster',
]);

export const TEMPLATE_VERSIONS = Object.freeze({
  'active-job': 'active-job@1',
  'expired-soft-landing': 'expired-soft-landing@1',
  'legacy-slug-bridge': 'legacy-slug-bridge@1',
  'previous-slugs-full-content': 'previous-slugs-full-content@1',
  'cross-locale-reconciliation': 'cross-locale-reconciliation@1',
  'related-search-cluster': 'related-search-cluster@1',
});

const RUNTIME_INPUT_KEYS = new Set([
  'ftbuildid',
  'buildid',
  'buildidtxt',
  'deploybuildid',
  'runid',
  'runnumber',
  'commithash',
  'commitid',
  'lastmod',
  'lastmodified',
  'generatedat',
  'generatedon',
  'generationdate',
  'generationtimestamp',
  'dategenerated',
  'datestamp',
]);

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRuntimeInputKey(key) {
  return RUNTIME_INPUT_KEYS.has(normalizedKey(key));
}

function canonicalValue(value, inArray = false) {
  if (value === undefined) return inArray ? 'null' : undefined;
  if (value === null) return 'null';

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return JSON.stringify(String(value));
    case 'function':
    case 'symbol':
      return inArray ? 'null' : undefined;
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalValue(item, true)).join(',')}]`;
      }

      const entries = Object.entries(value)
        .filter(([key, item]) => !isRuntimeInputKey(key) && item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`;
    }
    default:
      return inArray ? 'null' : undefined;
  }
}

export function canonicalizeInput(input) {
  return canonicalValue(input) ?? 'null';
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function templateVersionForKind(kind) {
  const version = TEMPLATE_VERSIONS[kind];
  if (!version) throw new Error(`Unknown incremental manifest page kind: ${kind}`);
  return version;
}

export function computeInputFingerprint(input) {
  return sha256(canonicalizeInput(input));
}

export function computeInputHash(input, kind, templateVersion = templateVersionForKind(kind)) {
  if (!PAGE_KINDS.includes(kind)) throw new Error(`Unknown incremental manifest page kind: ${kind}`);
  const canonical = canonicalizeInput(input);
  return sha256(`${kind}\n${templateVersion}\n${canonical}`);
}

export function verifyRuntimeInputExclusion() {
  const base = {
    content: { title: 'Role', description: 'Description' },
    nested: { values: ['a', 'b'] },
  };
  const withRuntimeFields = {
    ...base,
    'ft-build-id': '34956104680',
    buildId: '1789466830893',
    lastmod: '2026-09-16',
    generatedAt: '2026-09-16T12:00:00.000Z',
    nested: {
      ...base.nested,
      commit_hash: '0475bae099f92b761165050384a9a867635eb9fd',
      dateGenerated: '2026-09-16',
    },
  };
  const baseHash = computeInputHash(base, 'active-job');
  const runtimeHash = computeInputHash(withRuntimeFields, 'active-job');
  if (baseHash !== runtimeHash) {
    throw new Error('Runtime fields changed the incremental input hash');
  }
  return true;
}

function normalizeManifestPath(pagePath) {
  const normalized = String(pagePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized) throw new Error('Incremental manifest path cannot be empty');
  return normalized;
}

function safeLocaleFileName(locale) {
  const name = String(locale || '').trim();
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
    throw new Error(`Invalid incremental manifest locale: ${locale}`);
  }
  return `${name}.json`;
}

export class IncrementalManifest {
  constructor(locale) {
    this.locale = String(locale);
    this.entries = new Map();
  }

  register(pagePath, kind, input, templateVersion = templateVersionForKind(kind), sourceVersion = SOURCE_VERSION) {
    const normalizedPath = normalizeManifestPath(pagePath);
    this.entries.set(normalizedPath, {
      path: normalizedPath,
      inputHash: computeInputHash(input, kind, templateVersion),
      inputFingerprint: computeInputFingerprint(input),
      kind,
      templateVersion,
      sourceVersion,
      state: 'live',
    });
  }

  toJSON() {
    const entries = [...this.entries.values()].sort((left, right) => compareStrings(left.path, right.path));
    const byKind = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, 0]));
    for (const entry of entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
    return {
      manifestVersion: MANIFEST_VERSION,
      locale: this.locale,
      counts: {
        total: entries.length,
        byKind,
      },
      entries,
    };
  }

  write(rootDir, manifestDir = path.join(rootDir, '.cache', 'incremental-manifest')) {
    fs.mkdirSync(manifestDir, { recursive: true });
    const fileName = safeLocaleFileName(this.locale);
    const target = path.join(manifestDir, fileName);
    const temp = path.join(manifestDir, `.${fileName}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temp, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
      fs.renameSync(temp, target);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return target;
  }
}
