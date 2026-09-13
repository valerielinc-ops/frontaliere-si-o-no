#!/usr/bin/env node

/**
 * Append independently observed lifecycle events to the durable ledger.
 *
 * This helper has no GitHub credentials and no production side effects. The
 * caller must carry the result through the normal reviewed ledger branch/PR.
 * Candidate/owner_assigned remain recorder-owned and are rejected here so a
 * downstream observer cannot overwrite the source of lifecycle authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendJsonlSerialized,
  validateLifecycleEvent,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
const OBSERVED_EVENT_TYPES = new Set([
  'pr_opened',
  'tests_passed',
  'review_approved',
  'merged',
  'post_merge_verified',
]);
const SHA_RE = /^[0-9a-f]{40}$/iu;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readJson(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`${label} is missing: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function readJsonl(file, label) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return [];
  return fs.readFileSync(absolute, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function validateDurableEvent(registry, event, label) {
  if (!object(event)) throw new Error(`${label} is not an object`);
  if (!text(event.recordId)) throw new Error(`${label} has no recordId`);
  if (event.eventType && OBSERVED_EVENT_TYPES.has(event.eventType) === false
      && !['candidate', 'owner_assigned'].includes(event.eventType)) {
    throw new Error(`${label} has unsupported eventType ${event.eventType}`);
  }
  validateLifecycleEvent(registry, event.loopId, event);
  if (!object(event.execution)
      || String(event.execution.loopId || '') !== String(event.loopId || '')
      || !text(event.execution.runId)
      || !/^\d+$/u.test(String(event.execution.runId))
      || !SHA_RE.test(String(event.execution.sha || ''))) {
    throw new Error(`${label} has no durable observer/source execution identity`);
  }
  return event;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Append new observed events idempotently; conflicting record IDs fail closed. */
export function appendLoopFleetLifecycle({
  eventsFile,
  ledgerDir,
  registryPath = DEFAULT_REGISTRY_PATH,
} = {}) {
  if (!eventsFile) throw new Error('eventsFile is required');
  if (!ledgerDir) throw new Error('ledgerDir is required');
  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  const input = readJsonl(eventsFile, 'observed lifecycle events');
  for (const [index, event] of input.entries()) {
    validateDurableEvent(registry, event, `observed lifecycle event ${index + 1}`);
    if (!OBSERVED_EVENT_TYPES.has(event.eventType)) {
      throw new Error(`observed lifecycle event ${event.recordId} must be a downstream event, got ${event.eventType}`);
    }
  }

  const target = path.resolve(ledgerDir, 'lifecycle-events.jsonl');
  const existing = readJsonl(target, 'durable lifecycle ledger');
  const byId = new Map();
  for (const [index, event] of existing.entries()) {
    validateDurableEvent(registry, event, `durable lifecycle event ${index + 1}`);
    const previous = byId.get(event.recordId);
    if (previous && !sameRecord(previous, event)) {
      throw new Error(`durable lifecycle ledger has conflicting duplicate ${event.recordId}`);
    }
    byId.set(event.recordId, event);
  }

  let appended = 0;
  let skipped = 0;
  for (const event of input) {
    const previous = byId.get(event.recordId);
    if (previous) {
      if (!sameRecord(previous, event)) {
        throw new Error(`durable lifecycle ledger has conflicting duplicate ${event.recordId}`);
      }
      skipped += 1;
      continue;
    }
    const result = appendJsonlSerialized(target, event, { label: 'durable lifecycle ledger' });
    byId.set(event.recordId, event);
    if (result.appended) appended += 1;
    else skipped += 1;
  }
  return {
    inputRecords: input.length,
    appended,
    skipped,
    ledgerFile: target,
  };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const result = appendLoopFleetLifecycle({
    eventsFile: valueAfter(argv, '--events-file'),
    ledgerDir: valueAfter(argv, '--ledger-dir'),
    registryPath: valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH),
  });
  logger.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[append-loop-fleet-lifecycle] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
