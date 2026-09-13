#!/usr/bin/env node

/**
 * Record the independently observed PR link for candidate lifecycle events.
 *
 * The bridge calls this only after GitHub has returned a PR. It preserves the
 * source candidate's execution identity and never creates, edits or merges a
 * PR itself. Repeated bridge attempts are idempotent; a different PR for the
 * same candidate fails closed instead of hiding a routing conflict.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendJsonl,
  buildLifecycleEvent,
  validateLifecycleEvent,
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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

function readJsonl(file) {
  if (!fs.existsSync(path.resolve(file))) return [];
  return fs.readFileSync(path.resolve(file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`lifecycle ledger line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function prRecordId(loopId, candidateId, prUrl, occurredAt) {
  const basis = ['pr_opened', loopId, candidateId, prUrl, occurredAt].join('|');
  return `lf-lifecycle-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

export function appendLoopFleetPrOpenedEvents({
  loopId,
  runId,
  sha,
  ledgerDir,
  prUrl,
  prCreatedAt,
  registryPath = DEFAULT_REGISTRY_PATH,
  now = new Date(),
} = {}) {
  if (!/^L\d+$/u.test(String(loopId || ''))) throw new Error('loopId must look like L0, L1, …');
  if (!text(runId)) throw new Error('runId is required');
  if (!/^[0-9a-f]{40}$/iu.test(String(sha || ''))) throw new Error('sha must be a 40-character commit SHA');
  if (!ledgerDir) throw new Error('ledgerDir is required');
  if (!text(prUrl)) throw new Error('prUrl is required');
  if (!text(prCreatedAt) || !Number.isFinite(Date.parse(prCreatedAt))) throw new Error('prCreatedAt must be an ISO timestamp');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');

  const registry = validateLoopRegistry(readJson(registryPath, 'loop registry'));
  const expectedSha = String(sha).toLowerCase();
  const file = path.join(path.resolve(ledgerDir), 'lifecycle-events.jsonl');
  const events = readJsonl(file);
  const candidates = new Map();
  const existingPrEvents = new Map();
  for (const event of events) {
    validateLifecycleEvent(registry, event.loopId, event);
    if (event.loopId !== loopId) continue;
    if (event.eventType === 'candidate'
      && String(event.execution?.runId || '') === String(runId)
      && String(event.execution?.sha || '').toLowerCase() === expectedSha) {
      candidates.set(event.candidateId, event);
    }
    if (event.eventType === 'pr_opened') {
      const previous = existingPrEvents.get(event.candidateId);
      if (previous && !sameRecord(previous, event)) {
        throw new Error(`candidate ${event.candidateId} has conflicting pr_opened events`);
      }
      existingPrEvents.set(event.candidateId, event);
    }
  }

  let appended = 0;
  let skipped = 0;
  for (const candidate of candidates.values()) {
    const existing = existingPrEvents.get(candidate.candidateId);
    if (existing) {
      if (existing.artifactOrPr !== prUrl) {
        throw new Error(`candidate ${candidate.candidateId} is already linked to ${existing.artifactOrPr}`);
      }
      skipped += 1;
      continue;
    }
    const event = buildLifecycleEvent({
      eventType: 'pr_opened',
      loopId,
      candidateId: candidate.candidateId,
      owner: candidate.owner,
      sourceRecordId: candidate.sourceRecordId,
      sourceRefs: candidate.sourceRefs,
      lifecycle: candidate.lifecycle,
      occurredAt: prCreatedAt,
      artifactOrPr: prUrl,
      recordedAt: now.toISOString(),
    });
    const record = {
      ...event,
      recordId: prRecordId(loopId, candidate.candidateId, prUrl, prCreatedAt),
      execution: candidate.execution,
    };
    validateLifecycleEvent(registry, loopId, record);
    appendJsonl(file, record);
    existingPrEvents.set(candidate.candidateId, record);
    appended += 1;
  }
  return { loopId, runId: String(runId), sha: expectedSha, prUrl, candidates: candidates.size, appended, skipped, file };
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const result = appendLoopFleetPrOpenedEvents({
    loopId: valueAfter(argv, '--loop'),
    runId: valueAfter(argv, '--run-id'),
    sha: valueAfter(argv, '--sha'),
    ledgerDir: valueAfter(argv, '--ledger-dir'),
    prUrl: valueAfter(argv, '--pr-url'),
    prCreatedAt: valueAfter(argv, '--pr-created-at'),
    registryPath: valueAfter(argv, '--registry', DEFAULT_REGISTRY_PATH),
  });
  logger.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[loop-fleet-pr-event] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
