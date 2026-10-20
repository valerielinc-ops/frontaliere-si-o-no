#!/usr/bin/env node
/**
 * Opens (or updates) a fix issue for a portal stop, or closes every open
 * portal-stop issue for a portal the runner has since passed. Run by
 * assisted-application-agent.yml with GH_TOKEN. The marker files contain no
 * candidate data and live only in the Actions runner's temporary folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  createGithubIssue,
  findOpenGithubIssuesByTitlePrefix,
  resolveGithubIssueByNumber,
} from '../lib/github-issue-creator.mjs';
import { redactStopReport, stopIssue } from './lib/portal/stop-report.mjs';

const WORKFLOW = 'Assisted application agent';
const MODES = new Set(['submit', 'dry_run']);
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

function readJsonFile(file) {
  if (!file || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Read and validate the runner's candidate-free success marker. */
export function readPortalPass(file) {
  const raw = readJsonFile(file);
  if (!raw || typeof raw !== 'object') return null;
  const host = String(raw.host || '').trim().toLowerCase();
  const channel = String(raw.channel || '').trim();
  const mode = String(raw.mode || '').trim();
  const stage = String(raw.stage || '').trim();
  const step = Number(raw.step);
  if (!HOST_RE.test(host) || !channel || /[\r\n]/u.test(channel) || channel.length > 80) return null;
  if (!MODES.has(mode)) return null;
  if ((mode === 'submit' && stage !== 'submitted') || (mode === 'dry_run' && stage !== 'final_review')) return null;
  if (!Number.isSafeInteger(step) || step < 1) return null;
  return { host, channel, mode, step, stage };
}

/** The public, candidate-free comment attached before each resolved issue. */
export function portalPassComment(pass, runUrl = '') {
  return [
    '✅ Il runner ha superato il portale.',
    `- **Run:** ${runUrl || 'non disponibile'}`,
    `- **Host:** \`${pass.host}\``,
    `- **Canale:** \`${pass.channel}\``,
    `- **Modalità:** \`${pass.mode}\``,
    `- **Passo raggiunto:** \`${pass.step}\` (${pass.stage})`,
  ].join('\n');
}

/**
 * Close all open issues for one portal host. The issue creator re-reads every
 * selected number immediately before commenting and closing it.
 */
export async function closeRecoveredPortalStops(
  pass,
  {
    runUrl = '',
    findOpenIssues = findOpenGithubIssuesByTitlePrefix,
    resolveIssueByNumber = resolveGithubIssueByNumber,
  } = {},
) {
  const titlePrefix = `[portal-stop] ${pass.host}:`;
  const issues = await findOpenIssues(titlePrefix);
  if (!Array.isArray(issues)) {
    console.error('[report-portal-stop] open-issue lookup was unreliable; leaving issues open');
    return { closed: 0, lookupFailed: true };
  }
  const preface = portalPassComment(pass, runUrl);
  let closed = 0;
  for (const issue of issues) {
    const issueNumber = Number(issue?.number);
    if (!issue || !Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !String(issue.title || '').startsWith(titlePrefix)) continue;
    try {
      const result = await resolveIssueByNumber(issueNumber, {
        expectedTitle: String(issue.title),
        workflow: WORKFLOW,
        runUrl,
        preface,
      });
      if (result?.persisted) closed += 1;
    } catch (error) {
      console.error(`[report-portal-stop] could not close #${issue.number}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  console.log(`[report-portal-stop] closed ${closed} recovered issue(s) for ${pass.host}`);
  return { closed, lookupFailed: false };
}

export async function reportPortalOutcome({
  stopReportFile = process.env.STOP_REPORT || '',
  portalPassFile = process.env.PORTAL_PASS || '',
  runUrl = process.env.RUN_URL || '',
  createIssue = createGithubIssue,
  findOpenIssues = findOpenGithubIssuesByTitlePrefix,
  resolveIssueByNumber = resolveGithubIssueByNumber,
} = {}) {
  const rawStopReport = readJsonFile(stopReportFile);
  const pass = readPortalPass(portalPassFile);
  if (rawStopReport) {
    const report = redactStopReport(rawStopReport);
    const { title, description, dedupKey } = stopIssue(report, runUrl);
    // agent:fix-queued, not agent:fix: a label set with GITHUB_TOKEN triggers no
    // workflow; the follow-up drainer promotes it with its PAT (~20 min).
    await createIssue({ title, description, dedupKey, priority: 2, labels: ['agent:fix-queued'], workflow: WORKFLOW });
    console.log('[report-portal-stop] issue', title);
    // A run cannot both pass and stop on the same portal. Keep this guard here
    // as well, so a malformed/custom runner cannot resolve its own stop issue.
    const stopHost = String(report.host || '').trim().toLowerCase();
    if (!pass || !stopHost || pass.host === stopHost) return { action: 'reported-stop', closed: 0 };
  }
  if (!pass) {
    console.log('[report-portal-stop] no stop report or portal pass');
    return { action: 'nothing', closed: 0 };
  }
  const result = await closeRecoveredPortalStops(pass, { runUrl, findOpenIssues, resolveIssueByNumber });
  return { action: 'recovered', ...result };
}

if (isInvokedDirectly(import.meta.url)) {
  reportPortalOutcome().catch((error) => {
    console.error(`[report-portal-stop] ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}
