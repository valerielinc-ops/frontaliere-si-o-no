import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { digestDocument } from '../lib/canonical-json-digest.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  LOOP_FLEET_LEDGER_INDEX_FILE,
  LOOP_FLEET_LEDGER_MANIFEST_FILE,
  addLedgerIndexEntry,
  createLedgerIndexState,
  readLedgerIndex,
  writeLedgerIndex,
} from '../lib/loop-fleet-ledger-index.mjs';

const MiB = 1024 * 1024;
const FILE_LIMIT = 72 * MiB;
const TOTAL_LIMIT = 150 * MiB;
const OPTIONS = ['sha', 'inventory', 'restored', 'index', 'output'];
const FIELDS = {
  adsense: ['desktopRpm', 'desktopRpmCHF', 'revenuePerDay', 'revenuePerDayCHF', 'rpm', 'rpmCHF'],
  publisher: ['estMrrCHF'],
};
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function requireThat(condition) {
  if (!condition) throw new Error('invalid projection');
}

function privateMode(stat, mode) {
  return (stat.mode & 0o7777) === mode && stat.uid === process.getuid();
}

function directory(dir) {
  requireThat(fs.realpathSync.native(dir) === dir);
  const stat = fs.lstatSync(dir);
  requireThat(stat.isDirectory() && privateMode(stat, 0o700));
}

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function protectOutput(output, inputs) {
  const parent = path.dirname(output);
  directory(parent);
  requireThat(!statIfPresent(output));
  requireThat(inputs.every((input) => output !== input && !output.startsWith(input + path.sep)));
  // Check ancestors directly so Git environment overrides and discovery stops
  // cannot hide a checkout, a linked worktree or a bare repository.
  for (let dir = parent; ; dir = path.dirname(dir)) {
    requireThat(!statIfPresent(path.join(dir, '.git')));
    requireThat(!(statIfPresent(path.join(dir, 'HEAD')) && statIfPresent(path.join(dir, 'objects'))));
    if (dir === path.dirname(dir)) break;
  }
}

function readPrivate(file, limit, expectedBytes) {
  requireThat(fs.realpathSync.native(file) === file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireThat(stat.isFile() && stat.nlink === 1 && privateMode(stat, 0o600));
    requireThat(stat.size <= limit && (expectedBytes === undefined || stat.size === expectedBytes));
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset);
      requireThat(read > 0);
      offset += read;
    }
    requireThat(fs.readSync(fd, Buffer.alloc(1)) === 0);
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function hex(value, size) {
  return typeof value === 'string' && value.length === size && /^[0-9a-f]+$/u.test(value);
}

function blobOid(data, size) {
  return createHash(size === 40 ? 'sha1' : 'sha256')
    .update('blob ' + data.length + '\0').update(data).digest('hex');
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOptions(argv) {
  requireThat(argv.length === 2 * OPTIONS.length);
  const options = {};
  for (let pos = 0; pos < argv.length; pos += 2) {
    const key = argv[pos].slice(2);
    requireThat(argv[pos] === '--' + key && OPTIONS.includes(key) && !Object.hasOwn(options, key));
    options[key] = argv[pos + 1];
  }
  requireThat(hex(options.sha, 40) || hex(options.sha, 64));
  for (const key of OPTIONS.slice(1)) {
    const value = options[key];
    requireThat(path.isAbsolute(value) && path.resolve(value) === value);
  }
  return options;
}

function readInventory(file, sha) {
  const inventory = JSON.parse(decoder.decode(readPrivate(file, MiB)));
  requireThat(inventory?.source === sha && Array.isArray(inventory.files)
    && inventory.files.length > 0 && inventory.files.length <= 300);
  const names = new Set();
  let total = 0;
  return inventory.files.map((entry) => {
    requireThat(object(entry) && typeof entry.path === 'string');
    const match = /^data\/loop-fleet\/ledger\/(loop-(observations|decisions)(?:-run-[0-9]+)?\.jsonl)$/u.exec(entry.path);
    requireThat(match?.[0] === entry.path && !names.has(entry.path));
    names.add(entry.path);
    requireThat(hex(entry.gitOid, sha.length) && hex(entry.sha256, 64));
    requireThat(Number.isSafeInteger(entry.records) && entry.records >= 0);
    requireThat([entry.bytes, entry.gzipBytes]
      .every((value) => Number.isSafeInteger(value) && value > 0));
    total += entry.bytes;
    requireThat(entry.bytes <= FILE_LIMIT && total <= TOTAL_LIMIT);
    const type = match[2] === 'observations' ? 'observation' : 'decision';
    return { ...entry, name: match[1], type };
  });
}

function readOriginalIndex(dir) {
  const indexFile = path.join(dir, LOOP_FLEET_LEDGER_INDEX_FILE);
  const manifestFile = path.join(dir, LOOP_FLEET_LEDGER_MANIFEST_FILE);
  const index = readPrivate(indexFile, TOTAL_LIMIT);
  const firstLine = index.indexOf(10);
  const header = JSON.parse(decoder.decode(firstLine < 0 ? index : index.subarray(0, firstLine)));
  const declared = new Set(Object.keys(header.files));
  if (statIfPresent(manifestFile)) {
    const bytes = readPrivate(manifestFile, TOTAL_LIMIT - index.length);
    for (const line of decoder.decode(bytes).split('\n')) {
      if (line.trim()) declared.add(JSON.parse(line).file.trim());
    }
  }
  // The reader synthesizes null manifest entries for indexed files. Retain
  // explicit membership separately so that cannot authorize a replacement.
  const original = readLedgerIndex(dir);
  requireThat(original.exists);
  return { original, declared };
}

export function projectRecord(record) {
  const { sourceSnapshot } = record;
  if (!object(sourceSnapshot)) return null;
  if (record.loopId === 'L9') {
    const outcomes = sourceSnapshot.outcomes;
    if (!object(outcomes)) return null;
    const economicFields = ['mrrRecognizedChf', 'recognizedMrrChf'];
    const metrics = object(outcomes.metrics) ? outcomes.metrics : null;
    const hasEconomicFields = economicFields.some((field) => Object.hasOwn(outcomes, field)
      || (metrics && Object.hasOwn(metrics, field)));
    if (!hasEconomicFields) return null;
    const projectedOutcomes = { ...outcomes };
    for (const field of economicFields) delete projectedOutcomes[field];
    if (metrics) {
      const projectedMetrics = { ...metrics };
      for (const field of economicFields) delete projectedMetrics[field];
      projectedOutcomes.metrics = projectedMetrics;
    }
    return {
      ...record,
      sourceSnapshot: { ...sourceSnapshot, outcomes: projectedOutcomes },
    };
  }
  if (record.loopId !== 'L8') return null;
  const { history } = sourceSnapshot;
  if (!object(history)) return null;
  const projectedHistory = { ...history };
  let changed = false;
  for (const [section, fields] of Object.entries(FIELDS)) {
    const data = history[section];
    if (!object(data) || !fields.some((field) => Object.hasOwn(data, field))) continue;
    const retained = { ...data };
    for (const field of fields) delete retained[field];
    projectedHistory[section] = retained;
    changed = true;
  }
  if (!changed) return null;
  return {
    ...record,
    sourceSnapshot: { ...sourceSnapshot, history: projectedHistory, economicFieldsRemoved: true },
  };
}

function projectFile(data, metadata, replaceEntry) {
  requireThat(data.at(-1) === 10);
  const parts = [];
  let records = 0;
  let retainedStart = 0;
  for (let start = 0; start < data.length; ) {
    const end = data.indexOf(10, start);
    const record = JSON.parse(decoder.decode(data.subarray(start, end)));
    requireThat(object(record) && record.recordType === metadata.type
      && typeof record.recordId === 'string' && record.recordId.trim() === record.recordId
      && record.recordId !== '');
    const projected = projectRecord(record);
    if (projected) {
      records++;
      replaceEntry(record, projected);
      parts.push(data.subarray(retainedStart, start), Buffer.from(JSON.stringify(projected) + '\n'));
      retainedStart = end + 1;
    }
    start = end + 1;
  }
  requireThat(records === metadata.records);
  return parts.length ? Buffer.concat([...parts, data.subarray(retainedStart)]) : null;
}

function run(argv) {
  let stage = 'arguments';
  let output;
  let created = false;
  const written = [];
  const previousUmask = process.umask(0o077);
  try {
    const options = parseOptions(argv);
    output = options.output;
    stage = 'output';
    protectOutput(output, [options.restored, options.index]);
    stage = 'input';
    directory(options.restored);
    directory(options.index);
    const inventory = readInventory(options.inventory, options.sha);
    stage = 'index';
    const { original, declared } = readOriginalIndex(options.index);
    const manifest = new Map(original.manifest);
    const positions = new Map();
    original.entries.forEach((entry, position) => {
      const key = entry.recordType + '\0' + entry.recordId;
      positions.set(key, positions.has(key) ? -1 : position);
    });
    const replacements = new Map();
    const changedIds = new Set();

    stage = 'output';
    fs.mkdirSync(output, { mode: 0o700 });
    created = true;
    for (const metadata of inventory) {
      const name = metadata.name;
      stage = 'integrity';
      const data = readPrivate(path.join(options.restored, name), FILE_LIMIT, metadata.bytes);
      requireThat(createHash('sha256').update(data).digest('hex') === metadata.sha256
        && blobOid(data, options.sha.length) === metadata.gitOid);
      const projected = projectFile(data, metadata, (record, replacement) => {
        stage = 'index';
        const position = positions.get(metadata.type + '\0' + record.recordId);
        const entry = original.entries[position];
        requireThat(entry && !changedIds.has(record.recordId) && entry.file === name
          && entry.digest === digestDocument(record));
        changedIds.add(record.recordId);
        replacements.set(position, { ...entry, digest: digestDocument(replacement) });
        stage = 'integrity';
      });
      if (!projected) continue;
      stage = 'index';
      requireThat(declared.has(name) && manifest.has(name)
        && (manifest.get(name) === null || manifest.get(name) === metadata.gitOid));
      manifest.set(name, blobOid(projected, options.sha.length));
      stage = 'output';
      const target = path.join(output, name);
      const fd = fs.openSync(target, 'wx', 0o600);
      written.push(target);
      try {
        fs.writeFileSync(fd, projected);
      } finally {
        fs.closeSync(fd);
      }
    }

    stage = 'index';
    const projectedIndex = createLedgerIndexState({ manifest });
    original.entries.forEach((entry, position) => {
      addLedgerIndexEntry(projectedIndex, replacements.get(position) ?? entry);
    });
    projectedIndex.dirty = true;
    requireThat(writeLedgerIndex(output, projectedIndex));
    written.push(path.join(output, LOOP_FLEET_LEDGER_INDEX_FILE));
    const verified = readLedgerIndex(output);
    requireThat(verified.exists && isDeepStrictEqual(verified.entries, projectedIndex.entries)
      && isDeepStrictEqual(verified.manifest, manifest)
      && !statIfPresent(path.join(output, LOOP_FLEET_LEDGER_MANIFEST_FILE)));
    process.stdout.write(`OK files=${written.length - 1} records=${replacements.size} indexEntries=${verified.entries.length}\n`);
  } catch {
    let cleanupFailed = false;
    for (const file of written.reverse()) {
      try { fs.unlinkSync(file); } catch { cleanupFailed = true; }
    }
    if (created) {
      try { fs.rmdirSync(output); } catch { cleanupFailed = true; }
    }
    process.stderr.write(`ERROR ${cleanupFailed ? 'cleanup' : stage}\n`);
    process.exitCode = 1;
  } finally {
    process.umask(previousUmask);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  run(process.argv.slice(2));
}
