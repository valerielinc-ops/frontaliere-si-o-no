#!/usr/bin/env node

/**
 * Audit the executable bindings of the loop fleet against its canonical
 * registry.
 *
 * The registry already validates the policy data. This companion audit checks
 * that the policy is actually wired into every producer and workflow, and
 * that a producer does not silently reintroduce an autonomy level or action
 * class in source code. It is read-only: a finding is evidence for the normal
 * issue -> PR -> review path, never permission to edit a runner or data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateLoopRegistry,
} from '../lib/loop-fleet-contract.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_REGISTRY_PATH = path.join('data', 'loop-fleet', 'loop-registry.json');
export const L11_WORKFLOW = 'technical-operations-supervisor.yml';
export const L11_PRODUCER = 'scripts/ci/record-loop-fleet-evidence.mjs';

const LOOP_ID_RE = /^L\d+$/u;
const LOOP_WORKFLOW_RE = /^loop-(l\d+)-.+\.ya?ml$/iu;
const LOOP_PRODUCER_RE = /^loop-(l\d+)-.+\.mjs$/iu;

function lineAt(source, index) {
  return String(source).slice(0, Math.max(0, index)).split(/\r?\n/u).length;
}

function finding(file, rule, message, line = 1, evidence = null) {
  return {
    file,
    line,
    rule,
    severity: 'error',
    message,
    ...(evidence ? { evidence } : {}),
  };
}

function listFiles(root, directory, pattern) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.posix.join(directory.replaceAll(path.sep, '/'), entry.name))
    .sort();
}

function readRegistry(root, registryPath) {
  const absolute = path.resolve(root, registryPath);
  if (!fs.existsSync(absolute)) {
    return {
      registry: null,
      findings: [finding(registryPath, 'loop-registry.missing', 'canonical loop registry is missing')],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    return {
      registry: null,
      findings: [finding(registryPath, 'loop-registry.invalid-json', `canonical loop registry is invalid JSON: ${error.message}`)],
    };
  }
  try {
    return { registry: validateLoopRegistry(parsed), findings: [] };
  } catch (error) {
    return {
      registry: null,
      findings: [finding(registryPath, 'loop-registry.invalid-contract', error.message)],
    };
  }
}

function requireToken(findings, file, source, token, rule, message) {
  const index = String(source).indexOf(token);
  if (index < 0) findings.push(finding(file, rule, message));
}

function declaredActionClasses(registry) {
  return new Set(registry.loops.flatMap((loop) => loop.actionClasses
    .flatMap((value) => value.split('+').map((part) => part.trim()).filter(Boolean))));
}

function sourcePolicyFindings(file, source, knownActionClasses) {
  const findings = [];
  const text = String(source);
  const levelRe = /\bA[0-4]\b/gu;
  for (const match of text.matchAll(levelRe)) {
    findings.push(finding(
      file,
      'loop-registry.hardcoded-autonomy',
      `producer contains hardcoded autonomy level ${match[0]}; derive autonomy from the registry`,
      lineAt(text, match.index),
      match[0],
    ));
  }

  const actionLiteralRe = /\bactionClass\s*(?::|=)\s*(['"])([^'"]+)\1/gu;
  for (const match of text.matchAll(actionLiteralRe)) {
    const value = match[2].trim();
    const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every((part) => knownActionClasses.has(part))) {
      findings.push(finding(
        file,
        'loop-registry.hardcoded-action-class',
        `producer contains hardcoded action class ${value}; resolve it through actionPolicy`,
        lineAt(text, match.index),
        value,
      ));
    }
  }

  return findings;
}

function normaliseLoopId(raw) {
  return raw ? raw.toUpperCase() : null;
}

function auditExtraFiles(findings, files, knownLoopIds, kind) {
  const pattern = kind === 'workflow' ? LOOP_WORKFLOW_RE : LOOP_PRODUCER_RE;
  for (const file of files) {
    const name = path.posix.basename(file);
    const match = name.match(pattern);
    const loopId = normaliseLoopId(match?.[1]);
    if (loopId && !knownLoopIds.has(loopId)) {
      findings.push(finding(
        file,
        `loop-registry.unregistered-${kind}`,
        `${kind} binds ${loopId}, but that loop is not declared by the canonical registry`,
      ));
    }
  }
}

export function auditLoopFleetBindings({
  root = ROOT,
  registryPath = DEFAULT_REGISTRY_PATH,
} = {}) {
  const loaded = readRegistry(root, registryPath);
  const findings = [...loaded.findings];
  const workflowFiles = listFiles(root, path.join('.github', 'workflows'), /\.ya?ml$/iu);
  const producerFiles = listFiles(root, path.join('scripts', 'ci'), /\.mjs$/iu);
  if (!loaded.registry) {
    return {
      generatedAt: new Date().toISOString(),
      registryPath,
      loopsScanned: 0,
      loopIds: [],
      findings,
    };
  }

  const registry = loaded.registry;
  const loops = registry.loops;
  const loopIds = loops.map((loop) => loop.loopId);
  const knownLoopIds = new Set(loopIds);
  const actionClasses = declaredActionClasses(registry);

  for (const loop of loops) {
    if (!LOOP_ID_RE.test(loop.loopId)) {
      findings.push(finding(
        registryPath,
        'loop-registry.invalid-loop-id',
        `${loop.loopId} is not a stable L<number> loop id`,
      ));
    }
  }

  const loopWorkflowFiles = workflowFiles.filter((file) => LOOP_WORKFLOW_RE.test(path.posix.basename(file)));
  const loopProducerFiles = producerFiles.filter((file) => LOOP_PRODUCER_RE.test(path.posix.basename(file)));
  auditExtraFiles(findings, loopWorkflowFiles, knownLoopIds, 'workflow');
  auditExtraFiles(findings, loopProducerFiles, knownLoopIds, 'producer');

  for (const loop of loops) {
    const loopId = loop.loopId;
    const workflowCandidates = loopId === 'L11'
      ? [path.posix.join('.github', 'workflows', L11_WORKFLOW)].filter((file) => workflowFiles.includes(file))
      : loopWorkflowFiles.filter((file) => normaliseLoopId(path.posix.basename(file).match(LOOP_WORKFLOW_RE)?.[1]) === loopId);
    const producerCandidates = loopId === 'L11'
      ? [L11_PRODUCER].filter((file) => producerFiles.includes(file))
      : loopProducerFiles.filter((file) => normaliseLoopId(path.posix.basename(file).match(LOOP_PRODUCER_RE)?.[1]) === loopId);

    if (workflowCandidates.length !== 1) {
      findings.push(finding(
        loopId,
        'loop-registry.workflow-binding',
        `${loopId} must have exactly one bound workflow; found ${workflowCandidates.length}`,
      ));
    }
    if (producerCandidates.length !== 1) {
      findings.push(finding(
        loopId,
        'loop-registry.producer-binding',
        `${loopId} must have exactly one bound producer; found ${producerCandidates.length}`,
      ));
    }
    if (workflowCandidates.length !== 1 || producerCandidates.length !== 1) continue;

    const workflowFile = workflowCandidates[0];
    const producerFile = producerCandidates[0];
    const workflowSource = fs.readFileSync(path.join(root, workflowFile), 'utf8');
    const producerSource = fs.readFileSync(path.join(root, producerFile), 'utf8');
    const registryToken = '--registry data/loop-fleet/loop-registry.json';
    requireToken(
      findings,
      workflowFile,
      workflowSource,
      registryToken,
      'loop-registry.workflow-registry-binding',
      `${loopId} workflow does not pass the canonical registry to its runner/evidence recorder`,
    );
    requireToken(
      findings,
      workflowFile,
      workflowSource,
      `record-loop-fleet-evidence.mjs --loop ${loopId}`,
      'loop-registry.evidence-binding',
      `${loopId} workflow does not record evidence with its registry-bound loop id`,
    );
    if (loopId === 'L11') {
      requireToken(
        findings,
        workflowFile,
        workflowSource,
        'scripts/ci/technical-operations-audit.mjs',
        'loop-registry.audit-binding',
        'L11 workflow does not execute the technical operations audit',
      );
    } else {
      requireToken(
        findings,
        workflowFile,
        workflowSource,
        producerFile,
        'loop-registry.runner-binding',
        `${loopId} workflow does not execute its registry-bound producer ${producerFile}`,
      );
    }

    const requiredProducerTokens = loopId === 'L11'
      ? ['actionClassForPolicy', 'validateActionClassAgainstPolicy', 'validateLoopRegistry']
      : ['loadLoopPolicyForRun', 'actionClassForPolicy', 'validateActionClassAgainstPolicy'];
    for (const token of requiredProducerTokens) {
      requireToken(
        findings,
        producerFile,
        producerSource,
        token,
        'loop-registry.policy-runtime-binding',
        `${loopId} producer does not use ${token}; runtime policy would not be registry-driven`,
      );
    }
    findings.push(...sourcePolicyFindings(producerFile, producerSource, actionClasses));
  }

  return {
    generatedAt: new Date().toISOString(),
    registryPath,
    loopsScanned: loops.length,
    loopIds,
    findings,
  };
}

function summarize(report) {
  return {
    error: report.findings.filter((item) => item.severity === 'error').length,
    warning: report.findings.filter((item) => item.severity === 'warning').length,
    total: report.findings.length,
  };
}

function main() {
  const report = auditLoopFleetBindings({ root: ROOT });
  const summary = summarize(report);
  console.log(JSON.stringify({ ...report, summary }, null, 2));
  if (summary.error > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
