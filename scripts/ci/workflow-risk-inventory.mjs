#!/usr/bin/env node

/**
 * Build a read-only inventory of workflow side effects and their safeguards.
 *
 * This is an evidence surface for the fleet proposal, not an enforcement
 * switch: it never runs a workflow and never changes permissions, data or
 * external systems. The detector is intentionally conservative. A signal is
 * a reason to inspect the workflow, not proof that the action is unsafe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RISK_CLASSES = Object.freeze([
  'repository-write',
  'published-production',
  'commercial',
  'communication',
  'personal-data-consent',
  'destructive',
  'external-system',
]);

const SIGNALS = Object.freeze([
  { id: 'contents-write', risk: 'repository-write', pattern: /^\s*(?:contents|actions|pull-requests):\s*write\b/gimu },
  { id: 'git-mutation', risk: 'repository-write', pattern: /\bgit\s+(?:add|commit|push|tag|reset)\b/giu },
  { id: 'published-deploy', risk: 'published-production', pattern: /\b(?:firebase\s+deploy|wrangler\s+(?:deploy|publish)|npm\s+run\s+(?:deploy|publish)|cloudflare\s+(?:pages|deploy)|pages[-_ ]publish|fast[-_ ]publish)\b/giu },
  { id: 'published-data', risk: 'published-production', pattern: /(?:public\/data|\bdist\/|\br2\b|\bcloudflare\s+pages\b|\bpages[-_ ]publish\b)/giu },
  { id: 'commercial-domain', risk: 'commercial', pattern: /\b(?:price|prices|pricing|commission|partner|stripe|subscription|billing|adsense|affiliate|revenue|mrr|paid[-_ ]activation|employer[-_ ]activation)\b/giu },
  { id: 'communication-channel', risk: 'communication', pattern: /\b(?:send[-_ ](?:email|mail|alert|newsletter)|newsletter|telegram|reddit|instagram|facebook|slack|outreach|company[-_ ]alert|broadcast)\b/giu },
  { id: 'personal-data-consent', risk: 'personal-data-consent', pattern: /\b(?:consent|subscriber|personal[-_ ]data|pii|cv|resume|application|candidate|email[-_ ]address)\b/giu },
  { id: 'destructive-command', risk: 'destructive', pattern: /\b(?:rm\s+-rf|delete|purge|force[-_ ]push|git\s+reset|overwrite|revoke|disable|suspend|rollback)\b/giu },
  { id: 'external-system-call', risk: 'external-system', pattern: /\b(?:curl|wget|gh\s+api|firebase|gcloud|wrangler|aws\s+|rclone|ssh\s+|docker\s+push)\b/giu },
]);

const PERMISSION_RE = /^\s{2,}(contents|actions|pull-requests|issues|deployments|id-token|packages|statuses|checks|security-events):\s*([^#\s]+)/gimu;
const TRIGGER_RE = /^\s{2,}(schedule|workflow_dispatch|workflow_run|push|pull_request|repository_dispatch|issue_comment|workflow_call):/gimu;
const OWNER_RE = /^\s*#?\s*(?:owner|owned[- ]by|responsible[- ]team):\s*([^#\n]+)/imu;
const KILL_SWITCH_RE = /\b(?:kill[-_ ]switch|dry[-_ ]run|dry_run|pause|paused|suspend|enabled|enable[-_ ]?writes|skip[-_ ]publish|no[-_ ]?apply|confirm[-_ ]?send)\b/giu;
const MANUAL_GATE_RE = /\b(?:approval|approve|confirm|manual|workflow_dispatch|environment:\s*production|strict)\b/giu;
const STRICT_KILL_SWITCH_RE = /\b(?:kill[-_ ]switch|dry[-_ ]run|dry_run|pause(?:d)?|suspend|enable[-_ ]writes|skip[-_ ]publish|no[-_ ]?apply|confirm[-_ ]?send|KILL_SWITCH|DRY_RUN|NO_APPLY)\b/giu;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unique(values) {
  return [...new Set(values)];
}

function matches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function removeComments(source) {
  return source.split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .map((line) => line.replace(/\s+#.*$/u, ''))
    .join('\n');
}

function lineFor(source, index) {
  return source.slice(0, index).split('\n').length;
}

function signalEvidence(source, signal) {
  return matches(source, signal.pattern).slice(0, 12).map((match) => ({
    signal: signal.id,
    line: lineFor(source, match.index || 0),
  }));
}

function permissionEntries(source) {
  return matches(source, PERMISSION_RE).map((match) => ({ scope: match[1], value: match[2] }));
}

function triggers(source) {
  return unique(matches(source, TRIGGER_RE).map((match) => match[1]));
}

function owner(source) {
  const match = OWNER_RE.exec(source);
  return match ? text(match[1]) : null;
}

function hasDirectMutation(source) {
  return /\bgit\s+(?:push|commit)\b|\b(?:firebase\s+deploy|wrangler\s+(?:deploy|publish)|npm\s+run\s+(?:deploy|publish))\b/iu.test(source);
}

function riskLevel(risks, permissions, directMutation) {
  if (risks.some((risk) => ['published-production', 'commercial', 'communication', 'personal-data-consent', 'destructive'].includes(risk))) return 'critical';
  if (directMutation || permissions.some(({ value }) => value === 'write')) return 'high';
  if (risks.includes('external-system') || risks.includes('repository-write')) return 'medium';
  return 'low';
}

function safeguards(source, permissions) {
  const killSwitchMatches = matches(source, STRICT_KILL_SWITCH_RE);
  const manualGateMatches = matches(source, MANUAL_GATE_RE);
  return {
    killSwitch: {
      present: killSwitchMatches.length > 0,
      signals: unique(killSwitchMatches.map((match) => match[0].toLowerCase())).slice(0, 12),
    },
    manualGate: manualGateMatches.length > 0,
    explicitPermissions: permissions.length > 0,
    leastPrivilege: permissions.length > 0 && permissions.every(({ value }) => value === 'read' || value === 'none'),
    reviewedBoundary: /\b(?:pull[- ]request|review|approval|app[- ]token|pat|branch)\b/iu.test(source),
  };
}

/** Inspect one workflow file without loading or executing its commands. */
export function inspectWorkflow({ file, source = fs.readFileSync(file, 'utf8') } = {}) {
  const workflowName = text((/^name:\s*([^\n#]+)/imu.exec(source) || [])[1]) || path.basename(file);
  const operationalSource = `${path.basename(file)}\n${workflowName}\n${removeComments(source)}`;
  const permissions = permissionEntries(source);
  const evidence = [];
  const riskSet = new Set();
  for (const signal of SIGNALS) {
    const found = signalEvidence(operationalSource, signal);
    if (!found.length) continue;
    riskSet.add(signal.risk);
    evidence.push(...found);
  }
  const directMutation = hasDirectMutation(operationalSource);
  const safeguardsFound = safeguards(operationalSource, permissions);
  const risks = unique([...riskSet]);
  const disabled = /\b(?:disabled at cutover|intentionally disabled|schedule removed|if:\s*false)\b/iu.test(source);
  return {
    file: path.relative(process.cwd(), path.resolve(file)) || path.basename(file),
    name: workflowName,
    owner: owner(source),
    triggers: triggers(source),
    permissions,
    risks,
    riskLevel: riskLevel(risks, permissions, directMutation),
    directMutation,
    disabled,
    safeguards: safeguardsFound,
    evidence: evidence.sort((left, right) => left.line - right.line),
  };
}

export function workflowFiles(workflowDir) {
  const root = path.resolve(workflowDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => path.join(root, entry.name));
}

/** Inventory every tracked workflow; the result contains no command output. */
export function buildInventory({ workflowDir } = {}) {
  const files = workflowFiles(workflowDir);
  const workflows = files.map((file) => inspectWorkflow({ file }));
  const byRiskLevel = Object.fromEntries(['low', 'medium', 'high', 'critical'].map((level) => [level, 0]));
  const byRiskClass = Object.fromEntries(RISK_CLASSES.map((risk) => [risk, 0]));
  for (const workflow of workflows) {
    byRiskLevel[workflow.riskLevel] += 1;
    for (const risk of workflow.risks) byRiskClass[risk] += 1;
  }
  const risky = workflows.filter((workflow) => workflow.riskLevel === 'critical' || workflow.riskLevel === 'high');
  const missingOwner = risky.filter((workflow) => !workflow.owner).length;
  const missingKillSwitch = risky.filter((workflow) => !workflow.safeguards.killSwitch.present).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workflowDir: path.resolve(workflowDir),
    workflows,
    summary: {
      filesScanned: workflows.length,
      byRiskLevel,
      byRiskClass,
      riskyWorkflowCount: risky.length,
      riskyMissingOwnerCount: missingOwner,
      riskyMissingKillSwitchCount: missingKillSwitch,
      readOnlyWorkflowCount: workflows.filter((workflow) => workflow.riskLevel === 'low' && workflow.safeguards.leastPrivilege).length,
    },
  };
}

export function strictViolations(report) {
  return report.workflows
    .filter((workflow) => (workflow.riskLevel === 'critical' || workflow.riskLevel === 'high')
      && (!workflow.owner || !workflow.safeguards.killSwitch.present))
    .map((workflow) => ({
      file: workflow.file,
      missing: [
        !workflow.owner ? 'owner' : null,
        !workflow.safeguards.killSwitch.present ? 'kill-switch' : null,
      ].filter(Boolean),
    }));
}

export function renderMarkdown(report) {
  const lines = [
    '## Workflow risk inventory',
    '',
    `- Workflow scansionati: **${report.summary.filesScanned}**`,
    `- Rischio: low ${report.summary.byRiskLevel.low}, medium ${report.summary.byRiskLevel.medium}, high ${report.summary.byRiskLevel.high}, critical ${report.summary.byRiskLevel.critical}`,
    `- Workflow high/critical senza owner dichiarato: **${report.summary.riskyMissingOwnerCount}**`,
    `- Workflow high/critical senza segnale di kill-switch/manual stop: **${report.summary.riskyMissingKillSwitchCount}**`,
    '',
    '| Workflow | Owner | Livello | Rischi | Trigger | Permessi | Kill-switch / manual gate | Mutazione diretta |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const workflow of report.workflows) {
    const permissions = workflow.permissions.length
      ? workflow.permissions.map(({ scope, value }) => `${scope}:${value}`).join(', ')
      : 'n/d';
    lines.push(`| ${workflow.file} | ${workflow.owner || 'n/d'} | ${workflow.riskLevel} | ${workflow.risks.join(', ') || 'none'} | ${workflow.triggers.join(', ') || 'n/d'} | ${permissions} | ${workflow.safeguards.killSwitch.present ? 'yes' : 'no'} / ${workflow.safeguards.manualGate ? 'yes' : 'no'} | ${workflow.directMutation ? 'yes' : 'no'} |`);
  }
  const violations = strictViolations(report);
  if (violations.length) {
    lines.push('', '### Gap da verificare in modalità strict', '', ...violations.map(({ file, missing }) => `- ${file}: manca ${missing.join(' e ')}`));
  }
  lines.push('', 'Inventario read-only: non esegue workflow, non cambia permessi e non modifica dati o sistemi esterni. I segnali sono candidati da verificare, non verdetti automatici.');
  return `${lines.join('\n')}\n`;
}

function valueAfter(argv, flag, fallback = null) {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] || fallback) : fallback;
}

export function main({ argv = process.argv.slice(2), logger = console } = {}) {
  const outDir = path.resolve(valueAfter(argv, '--out-dir', process.env.REPORT_DIR || process.env.RUNNER_TEMP || 'workflow-risk-report'));
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildInventory({ workflowDir: valueAfter(argv, '--workflow-dir', path.join('.github', 'workflows')) });
  fs.writeFileSync(path.join(outDir, 'workflow-risk-inventory.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'workflow-risk-inventory.md'), renderMarkdown(report));
  logger.log(renderMarkdown(report));
  if (argv.includes('--strict') && strictViolations(report).length) process.exitCode = 2;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[workflow-risk-inventory] fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
