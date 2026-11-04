import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { digestDocument } from './canonical-json-digest.mjs';

/**
 * The durable branch is append-only but stores one bounded shard per run. The
 * bridge therefore keeps a compact, JSONL-only identity index beside the
 * reader-facing files. A missing/new shard is still parsed and registry-
 * validated before its entries enter the index; tracked Git blob IDs detect a
 * rewrite of an already indexed shard and fail closed.
 */
export const LOOP_FLEET_LEDGER_INDEX_FILE = 'ledger-record-index.jsonl';
const INDEX_KIND = 'loop-fleet-ledger-record-index';
const INDEX_SCHEMA_VERSION = 1;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const GIT_OID_RE = /^[0-9a-f]{40,64}$/iu;
const RECORD_TYPES = new Set(['observation', 'decision', 'health', 'lifecycle']);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function indexKey(type, recordId) {
  return `${type}\u0000${recordId}`;
}

function assertIndexEntry(entry, label) {
  if (!object(entry)) throw new Error(`${label} must be an object`);
  const type = text(entry.record_type);
  const recordId = text(entry.record_id);
  const file = text(entry.file);
  if (!RECORD_TYPES.has(type)) throw new Error(`${label}.record_type is invalid`);
  if (!recordId) throw new Error(`${label}.record_id is missing`);
  if (!file || path.basename(file) !== file || file === LOOP_FLEET_LEDGER_INDEX_FILE) {
    throw new Error(`${label}.file is invalid`);
  }
  if (!DIGEST_RE.test(String(entry.digest || ''))) throw new Error(`${label}.digest is invalid`);
  return { recordType: type, recordId, file, digest: entry.digest };
}

function assertManifest(manifest) {
  if (!object(manifest)) throw new Error('ledger index manifest must be an object');
  const normalized = new Map();
  for (const [file, oid] of Object.entries(manifest)) {
    if (!file || path.basename(file) !== file || file === LOOP_FLEET_LEDGER_INDEX_FILE) {
      throw new Error(`ledger index manifest file is invalid: ${file}`);
    }
    if (oid !== null && !GIT_OID_RE.test(String(oid || ''))) {
      throw new Error(`ledger index manifest digest is invalid for ${file}`);
    }
    normalized.set(file, oid);
  }
  return normalized;
}

export function createLedgerIndexState({ exists = false, manifest = new Map(), entries = [] } = {}) {
  const state = {
    exists,
    dirty: false,
    manifest: new Map(manifest),
    entries: [],
    byKey: new Map(),
  };
  for (const entry of entries) addLedgerIndexEntry(state, entry);
  state.dirty = false;
  return state;
}

export function readLedgerIndex(ledgerDir) {
  const file = path.join(path.resolve(ledgerDir), LOOP_FLEET_LEDGER_INDEX_FILE);
  if (!fs.existsSync(file)) return createLedgerIndexState();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter((line) => line.trim());
  if (!lines.length) throw new Error('ledger index is empty');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`ledger index header is invalid JSON: ${error.message}`);
  }
  if (!object(header)
      || header.kind !== INDEX_KIND
      || header.schema_version !== INDEX_SCHEMA_VERSION) {
    throw new Error('ledger index header is unsupported');
  }
  const manifest = assertManifest(header.files);
  const entries = lines.slice(1).map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`ledger index line ${index + 2} is invalid JSON: ${error.message}`);
    }
    return assertIndexEntry(parsed, `ledger index line ${index + 2}`);
  });
  return createLedgerIndexState({ exists: true, manifest, entries });
}

export function addLedgerIndexEntry(state, entry) {
  const normalized = entry.record_type
    ? assertIndexEntry(entry, 'ledger index entry')
    : assertIndexEntry({
      record_type: entry.recordType,
      record_id: entry.recordId,
      file: entry.file,
      digest: entry.digest,
    }, 'ledger index entry');
  const key = indexKey(normalized.recordType, normalized.recordId);
  const previous = state.byKey.get(key);
  if (previous && previous.digest !== normalized.digest) {
    throw new Error(`ledger index contains conflicting duplicate ${normalized.recordId}`);
  }
  state.entries.push(normalized);
  if (!previous) state.byKey.set(key, normalized);
  state.manifest.set(normalized.file, state.manifest.get(normalized.file) ?? null);
  state.dirty = true;
  return normalized;
}

export function addLedgerRecordToIndex(state, { type, record, file }) {
  const recordId = text(record?.recordId);
  if (!recordId) throw new Error(`cannot index ${type} record without recordId`);
  return addLedgerIndexEntry(state, {
    recordType: type,
    recordId,
    file: path.basename(file),
    digest: digestDocument(record),
  });
}

export function ledgerIndexEntry(state, type, recordId) {
  return state.byKey.get(indexKey(type, recordId)) || null;
}

export function ledgerIndexRecordCount(state, type) {
  return state.entries.filter((entry) => entry.recordType === type).length;
}

export function ledgerIndexHasFile(state, file) {
  return state.manifest.has(path.basename(file));
}

export function setLedgerIndexFile(state, file, oid = null) {
  const name = path.basename(file);
  if (!name || name === LOOP_FLEET_LEDGER_INDEX_FILE) throw new Error(`invalid ledger index file: ${file}`);
  if (oid !== null && !GIT_OID_RE.test(String(oid || ''))) {
    throw new Error(`invalid Git object id for ledger file ${name}`);
  }
  const previous = state.manifest.get(name);
  if (previous && oid && previous !== oid) {
    throw new Error(`ledger file ${name} changed after it was indexed`);
  }
  if (!state.manifest.has(name) || (previous === null && oid)) {
    state.manifest.set(name, oid);
    state.dirty = true;
  }
}

function writeAtomic(file, content) {
  const target = path.resolve(file);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeSync(fd, content, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

export function writeLedgerIndex(ledgerDir, state) {
  if (!state.dirty) return false;
  const file = path.join(path.resolve(ledgerDir), LOOP_FLEET_LEDGER_INDEX_FILE);
  const header = {
    kind: INDEX_KIND,
    schema_version: INDEX_SCHEMA_VERSION,
    files: Object.fromEntries([...state.manifest.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
  const content = [JSON.stringify(header), ...state.entries.map((entry) => JSON.stringify({
    record_type: entry.recordType,
    record_id: entry.recordId,
    file: entry.file,
    digest: entry.digest,
  }))].join('\n') + '\n';
  writeAtomic(file, content);
  state.exists = true;
  state.dirty = false;
  return true;
}

/** Return tracked Git blob IDs when the ledger directory belongs to a worktree. */
export function trackedLedgerFileOids(ledgerDir) {
  try {
    const root = execFileSync('git', ['-C', path.resolve(ledgerDir), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const output = execFileSync('git', ['-C', root, 'ls-files', '-s'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ledgerPrefix = `${path.relative(root, path.resolve(ledgerDir)).split(path.sep).join('/')}/`;
    const result = new Map();
    for (const line of output.split(/\r?\n/u)) {
      const match = line.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t(.+)$/iu);
      if (!match || !match[2].startsWith(ledgerPrefix)) continue;
      const name = match[2].slice(ledgerPrefix.length);
      if (name && name !== LOOP_FLEET_LEDGER_INDEX_FILE && !name.includes('/')) result.set(name, match[1].toLowerCase());
    }
    return result;
  } catch {
    return null;
  }
}

export function ledgerFileOid(ledgerDir, file) {
  try {
    const root = execFileSync('git', ['-C', path.resolve(ledgerDir), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const relative = path.relative(root, path.resolve(file));
    return execFileSync('git', ['-C', root, 'hash-object', '--', relative], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
  } catch {
    return null;
  }
}
