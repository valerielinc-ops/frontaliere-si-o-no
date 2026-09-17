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

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function relativePath(value) {
  const normalized = text(value);
  if (!normalized || normalized.includes('\\') || path.posix.isAbsolute(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return normalized;
}

function actionPolicyReferences(source) {
  const calls = [];
  const callRe = /\bactionClassForPolicy\s*\(([^)]*)\)/gu;
  for (const match of String(source).matchAll(callRe)) {
    const args = match[1];
    const comma = args.indexOf(',');
    const keyExpression = comma >= 0 ? args.slice(comma + 1) : '';
    // A producer commonly selects a policy key with a ternary. Ignore string
    // literals in the condition (for example the quality value "observed")
    // and inspect only the possible result branches.
    const resultExpression = keyExpression.includes('?')
      ? keyExpression.slice(keyExpression.indexOf('?') + 1)
      : keyExpression;
    const resultBranches = keyExpression.includes('?')
      ? resultExpression.split(':').map((branch) => branch.trim()).filter(Boolean)
      : [resultExpression.trim()];
    const keys = [...resultExpression.matchAll(/(['"])([^'"\r\n]+)\1/gu)]
      .map((keyMatch) => keyMatch[2].trim())
      .filter(Boolean);
    const literalBranchRe = /^(['"])([^'"\r\n]+)\1$/u;
    calls.push({
      line: lineAt(source, match.index),
      keys: [...new Set(keys)],
      dynamic: comma < 0
        || keys.length === 0
        || resultBranches.some((branch) => !literalBranchRe.test(branch))
        || /[A-Za-z_$][\w$]*\s*\(/u.test(keyExpression),
    });
  }
  return {
    calls,
    keys: [...new Set(calls.flatMap((call) => call.keys))].sort(),
    dynamicCalls: calls.filter((call) => call.dynamic).length,
  };
}

function allocationDenyReport(loop) {
  const allocation = loop.allocationPolicy;
  if (!allocation) return { applicable: false, complete: true };
  const boundedCanary = allocation.boundedCanary || {};
  const complete = boundedCanary.enabled === false
    && boundedCanary.maxExposure === 0
    && boundedCanary.requiresReviewedApproval === true
    && allocation.trafficMutationAllowed === false
    && allocation.priceMutationAllowed === false
    && allocation.noAutomaticPriceChange === true;
  return {
    applicable: true,
    boundedCanary: {
      enabled: boundedCanary.enabled ?? null,
      maxExposure: boundedCanary.maxExposure ?? null,
      requiresReviewedApproval: boundedCanary.requiresReviewedApproval ?? null,
    },
    trafficMutationAllowed: allocation.trafficMutationAllowed ?? null,
    priceMutationAllowed: allocation.priceMutationAllowed ?? null,
    noAutomaticPriceChange: allocation.noAutomaticPriceChange ?? null,
    complete,
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
      bindings: [],
      findings,
    };
  }

  const registry = loaded.registry;
  const loops = registry.loops;
  const loopIds = loops.map((loop) => loop.loopId);
  const knownLoopIds = new Set(loopIds);
  const actionClasses = declaredActionClasses(registry);
  const bindings = [];

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
    const binding = loop.binding && typeof loop.binding === 'object' && !Array.isArray(loop.binding)
      ? loop.binding
      : {};
    const declaredWorkflow = relativePath(binding.workflow);
    const declaredProducer = relativePath(binding.producer);
    const workflowFile = declaredWorkflow
      && (declaredWorkflow.endsWith('.yml') || declaredWorkflow.endsWith('.yaml'))
      ? path.posix.join('.github', 'workflows', declaredWorkflow)
      : null;
    const producerFile = declaredProducer?.startsWith('scripts/ci/') && declaredProducer.endsWith('.mjs')
      ? declaredProducer
      : null;
    const denyByConstruction = allocationDenyReport(loop);
    const declaredKeys = Object.keys(loop.actionPolicy || {}).sort();
    const bindingReport = {
      loopId,
      workflow: text(binding.workflow),
      producer: text(binding.producer),
      actionPolicyBinding: {
        declaredKeys,
        referencedKeys: [],
        missingKeys: declaredKeys,
        undeclaredKeys: [],
        dynamicCalls: 0,
        callCount: 0,
        complete: false,
      },
      denyByConstruction,
    };
    bindings.push(bindingReport);

    if (!workflowFile) {
      findings.push(finding(
        registryPath,
        'loop-registry.workflow-declaration',
        `${loopId} binding.workflow must be a relative .yml/.yaml workflow filename`,
      ));
    }
    if (!producerFile) {
      findings.push(finding(
        registryPath,
        'loop-registry.producer-declaration',
        `${loopId} binding.producer must be a relative scripts/ci/*.mjs path`,
      ));
    }
    if (loopId === 'L11' && declaredWorkflow !== L11_WORKFLOW) {
      findings.push(finding(
        registryPath,
        'loop-registry.binding-declaration',
        `L11 binding.workflow must remain ${L11_WORKFLOW}`,
      ));
    }
    if (loopId === 'L11' && declaredProducer !== L11_PRODUCER) {
      findings.push(finding(
        registryPath,
        'loop-registry.binding-declaration',
        `L11 binding.producer must remain ${L11_PRODUCER}`,
      ));
    }
    if (denyByConstruction.applicable && !denyByConstruction.complete) {
      findings.push(finding(
        registryPath,
        'loop-registry.deny-by-construction',
        `${loopId} allocation policy must deny traffic and price mutation and keep bounded canary disabled`,
        1,
        JSON.stringify(denyByConstruction),
      ));
    }

    const workflowCandidates = workflowFile && workflowFiles.includes(workflowFile) ? [workflowFile] : [];
    const producerCandidates = producerFile && producerFiles.includes(producerFile) ? [producerFile] : [];
    const conventionalWorkflowMatches = loopId === 'L11'
      ? []
      : loopWorkflowFiles.filter((file) => normaliseLoopId(path.posix.basename(file).match(LOOP_WORKFLOW_RE)?.[1]) === loopId);
    const conventionalProducerMatches = loopId === 'L11'
      ? []
      : loopProducerFiles.filter((file) => normaliseLoopId(path.posix.basename(file).match(LOOP_PRODUCER_RE)?.[1]) === loopId);
    if (conventionalWorkflowMatches.length > 0
      && (conventionalWorkflowMatches.length !== 1 || conventionalWorkflowMatches[0] !== workflowFile)) {
      findings.push(finding(
        loopId,
        'loop-registry.workflow-binding',
        `${loopId} has ${conventionalWorkflowMatches.length} conventional workflow files, but its declared binding is ${workflowFile || 'missing'}`,
      ));
    }
    if (conventionalProducerMatches.length > 0
      && (conventionalProducerMatches.length !== 1 || conventionalProducerMatches[0] !== producerFile)) {
      findings.push(finding(
        loopId,
        'loop-registry.producer-binding',
        `${loopId} has ${conventionalProducerMatches.length} conventional producer files, but its declared binding is ${producerFile || 'missing'}`,
      ));
    }

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

    const boundWorkflowFile = workflowCandidates[0];
    const boundProducerFile = producerCandidates[0];
    const workflowSource = fs.readFileSync(path.join(root, boundWorkflowFile), 'utf8');
    const producerSource = fs.readFileSync(path.join(root, boundProducerFile), 'utf8');
    const registryToken = '--registry data/loop-fleet/loop-registry.json';
    requireToken(
      findings,
      boundWorkflowFile,
      workflowSource,
      registryToken,
      'loop-registry.workflow-registry-binding',
      `${loopId} workflow does not pass the canonical registry to its runner/evidence recorder`,
    );
    requireToken(
      findings,
      boundWorkflowFile,
      workflowSource,
      `record-loop-fleet-evidence.mjs --loop ${loopId}`,
      'loop-registry.evidence-binding',
      `${loopId} workflow does not record evidence with its registry-bound loop id`,
    );
    if (loopId === 'L11') {
      requireToken(
        findings,
        boundWorkflowFile,
        workflowSource,
        'scripts/ci/technical-operations-audit.mjs',
        'loop-registry.audit-binding',
        'L11 workflow does not execute the technical operations audit',
      );
    } else {
      requireToken(
        findings,
        boundWorkflowFile,
        workflowSource,
        boundProducerFile,
        'loop-registry.runner-binding',
        `${loopId} workflow does not execute its registry-bound producer ${boundProducerFile}`,
      );
    }

    const requiredProducerTokens = loopId === 'L11'
      ? ['actionClassForPolicy', 'validateActionClassAgainstPolicy', 'validateLoopRegistry']
      : ['loadLoopPolicyForRun', 'actionClassForPolicy', 'validateActionClassAgainstPolicy'];
    for (const token of requiredProducerTokens) {
      requireToken(
        findings,
        boundProducerFile,
        producerSource,
        token,
        'loop-registry.policy-runtime-binding',
        `${loopId} producer does not use ${token}; runtime policy would not be registry-driven`,
      );
    }
    const references = actionPolicyReferences(producerSource);
    const missingKeys = declaredKeys.filter((key) => !references.keys.includes(key));
    const undeclaredKeys = references.keys.filter((key) => !declaredKeys.includes(key));
    bindingReport.actionPolicyBinding = {
      declaredKeys,
      referencedKeys: references.keys,
      missingKeys,
      undeclaredKeys,
      dynamicCalls: references.dynamicCalls,
      callCount: references.calls.length,
      complete: references.calls.length > 0
        && references.dynamicCalls === 0
        && missingKeys.length === 0
        && undeclaredKeys.length === 0,
    };
    for (const key of missingKeys) {
      findings.push(finding(
        boundProducerFile,
        'loop-registry.action-policy-unbound',
        `${loopId} producer never resolves actionPolicy.${key}; declared policy branches are not executable`,
        1,
        key,
      ));
    }
    for (const key of undeclaredKeys) {
      findings.push(finding(
        boundProducerFile,
        'loop-registry.action-policy-undeclared',
        `${loopId} producer resolves undeclared actionPolicy.${key}; add it to the canonical registry or remove the branch`,
        1,
        key,
      ));
    }
    for (const call of references.calls.filter((candidate) => candidate.dynamic)) {
      findings.push(finding(
        boundProducerFile,
        'loop-registry.action-policy-dynamic',
        `${loopId} producer has an actionClassForPolicy call whose policy key cannot be verified statically`,
        call.line,
      ));
    }
    if (references.calls.length === 0) {
      findings.push(finding(
        boundProducerFile,
        'loop-registry.action-policy-missing-call',
        `${loopId} producer has no statically verifiable actionClassForPolicy call`,
      ));
    }
    findings.push(...sourcePolicyFindings(boundProducerFile, producerSource, actionClasses));
  }

  return {
    generatedAt: new Date().toISOString(),
    registryPath,
    loopsScanned: loops.length,
    loopIds,
    bindings,
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
