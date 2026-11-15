#!/usr/bin/env node

/**
 * Deterministic contract for the assisted-application Actions runner.
 *
 * The workflow must remain safe when no dedicated runner is configured: the
 * only accepted opt-in is the documented `assisted-application` label, and
 * every other value must resolve to GitHub-hosted `ubuntu-latest`. A crawler
 * proxy is a network setting, not a runner selector, so it must not enter this
 * contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import YAML from 'yaml';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');

export const ASSISTED_APPLICATION_WORKFLOW_PATH = path.join(
  '.github',
  'workflows',
  'assisted-application-agent.yml',
);
export const SELFHOSTED_RUNNER_DOC_PATH = path.join('docs', 'SELFHOSTED-RUNNER.md');
export const ASSISTED_APPLICATION_RUNNER_VARIABLE = 'ASSISTED_APPLICATION_RUNNER';
export const ASSISTED_APPLICATION_RUNNER_LABEL = 'assisted-application';
export const DEFAULT_RUNNER_LABEL = 'ubuntu-latest';
export const EXPECTED_RUNNER_LABELS = Object.freeze([
  'self-hosted',
  ASSISTED_APPLICATION_RUNNER_LABEL,
]);

function text(value) {
  return value == null ? '' : String(value);
}

function sectionAfterHeading(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) return '';
  const rest = markdown.slice(start + heading.length);
  const nextHeading = rest.search(/^##\s+/mu);
  return rest.slice(0, nextHeading < 0 ? rest.length : nextHeading);
}

function parseRunnerSelector(runsOn, errors) {
  const selector = text(runsOn).trim();
  if (!selector.startsWith('${{') || !selector.endsWith('}}')) {
    errors.push('jobs.agent.runs-on must be an Actions expression with an explicit fallback');
    return;
  }

  const expression = selector.slice(3, -2).trim();
  if (/STEALTH_BROWSER_PROXY|crawler|proxy/iu.test(expression)) {
    errors.push('jobs.agent.runs-on must not use crawler proxy settings');
  }

  const variableRefs = expression.match(new RegExp(`\\b${ASSISTED_APPLICATION_RUNNER_VARIABLE}\\b`, 'g')) || [];
  if (variableRefs.length !== 1) {
    errors.push(`runner selector must reference ${ASSISTED_APPLICATION_RUNNER_VARIABLE} exactly once`);
  }

  const allowedValue = expression.match(
    new RegExp(
      `\\bvars\\.${ASSISTED_APPLICATION_RUNNER_VARIABLE}\\s*==\\s*(['"])([^'"]+)\\1`,
    ),
  );
  if (!allowedValue || allowedValue[2] !== ASSISTED_APPLICATION_RUNNER_LABEL) {
    errors.push(`runner selector must allow only the documented ${ASSISTED_APPLICATION_RUNNER_LABEL} label`);
  }

  const fallback = expression.match(/\|\|\s*(['"])([^'"]+)\1\s*$/u);
  if (!fallback || fallback[2] !== DEFAULT_RUNNER_LABEL) {
    errors.push(`runner selector must fall back to ${DEFAULT_RUNNER_LABEL}`);
  }

  const fromJson = expression.match(/fromJSON\s*\(\s*(['"])(.*?)\1\s*\)/u);
  if (!fromJson) {
    errors.push('runner selector must require the self-hosted runner and its dedicated label');
    return;
  }

  let labels;
  try {
    labels = JSON.parse(fromJson[2]);
  } catch {
    errors.push('runner selector contains invalid JSON runner labels');
    return;
  }
  if (!Array.isArray(labels) || labels.length !== EXPECTED_RUNNER_LABELS.length
    || labels.some((label, index) => label !== EXPECTED_RUNNER_LABELS[index])) {
    errors.push(`runner selector labels must be exactly ${JSON.stringify(EXPECTED_RUNNER_LABELS)}`);
  }
}

/**
 * Validate the checked-in workflow and documentation without network access.
 * @param {{ workflowSource?: string, docsSource?: string }} input
 * @returns {string[]}
 */
export function validateAssistedApplicationRunnerRouting({ workflowSource, docsSource } = {}) {
  const errors = [];
  let workflow;
  try {
    workflow = YAML.parse(text(workflowSource));
  } catch (error) {
    errors.push(`workflow YAML is invalid: ${error.message}`);
    workflow = null;
  }

  const agentJob = workflow?.jobs?.agent;
  if (!agentJob || typeof agentJob !== 'object' || Array.isArray(agentJob)) {
    errors.push('workflow must define the assisted-application jobs.agent job');
  } else {
    parseRunnerSelector(agentJob['runs-on'], errors);
  }

  const applicationSection = sectionAfterHeading(
    text(docsSource),
    '## Assisted application workflow runner (opt-in)',
  );
  if (!applicationSection) {
    errors.push('SELFHOSTED-RUNNER.md must document the assisted application runner contract');
  } else {
    const assignment = new RegExp(
      `\\b${ASSISTED_APPLICATION_RUNNER_VARIABLE}\\s*=\\s*${ASSISTED_APPLICATION_RUNNER_LABEL}\\b`,
    );
    if (!assignment.test(applicationSection)) {
      errors.push(`documentation must set ${ASSISTED_APPLICATION_RUNNER_VARIABLE}=${ASSISTED_APPLICATION_RUNNER_LABEL}`);
    }
    if (!new RegExp(`\\b${DEFAULT_RUNNER_LABEL}\\b`).test(applicationSection)
      || !/fallback/iu.test(applicationSection)) {
      errors.push(`documentation must describe the ${DEFAULT_RUNNER_LABEL} fallback`);
    }
    if (!new RegExp(`\\b${ASSISTED_APPLICATION_RUNNER_LABEL}\\b`).test(applicationSection)) {
      errors.push(`documentation must name the ${ASSISTED_APPLICATION_RUNNER_LABEL} runner label`);
    }
    if (!/STEALTH_BROWSER_PROXY/iu.test(applicationSection)
      || !/crawler/iu.test(applicationSection)
      || !/(separat|independent|non|not)/iu.test(applicationSection)) {
      errors.push('documentation must separate STEALTH_BROWSER_PROXY from the application runner');
    }
  }

  return errors;
}

export function checkAssistedApplicationRunnerRouting(root = ROOT) {
  const workflowPath = path.join(root, ASSISTED_APPLICATION_WORKFLOW_PATH);
  const docsPath = path.join(root, SELFHOSTED_RUNNER_DOC_PATH);
  const workflowSource = fs.readFileSync(workflowPath, 'utf8');
  const docsSource = fs.readFileSync(docsPath, 'utf8');
  return validateAssistedApplicationRunnerRouting({ workflowSource, docsSource });
}

const isDirectInvocation = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  let errors;
  try {
    errors = checkAssistedApplicationRunnerRouting();
  } catch (error) {
    errors = [error.message];
  }
  if (errors.length > 0) {
    console.error('❌ assisted application runner routing contract failed');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('✅ assisted application runner routing contract is valid');
  }
}
