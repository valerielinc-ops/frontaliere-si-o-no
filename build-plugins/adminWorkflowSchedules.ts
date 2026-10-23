import fs from 'node:fs';
import path from 'node:path';
import { describeCronForLocalDay, type CronOccurrence } from '../services/adminCron';

export interface AdminWorkflowSchedule {
  cron: string;
  source: 'github-actions' | 'cloud-scheduler';
  occurrencesToday: CronOccurrence[];
}

export interface AdminWorkflowScheduleEntry {
  id: string;
  name: string;
  schedules: AdminWorkflowSchedule[];
}

export interface AdminWorkflowSchedulePayload {
  generatedAt: string;
  timezone: string;
  workflows: AdminWorkflowScheduleEntry[];
}

/**
 * The repository has many scheduled maintenance workflows. The admin board is
 * intentionally narrower: it mirrors the actions exposed by the admin
 * workflow registry, the generated crawler groups, and the newsletter sender.
 * Keeping this allowlist here prevents unrelated CI/monitoring crons from
 * appearing as owner work.
 */
export const ADMIN_SCHEDULED_WORKFLOW_IDS = new Set([
  'generate-article.yml',
  'update-unemployment-rate.yml',
  'analytics.yml',
  'seo-serp-autopilot.yml',
  'adsense-prereview.yml',
  'send-newsletter.yml',
  'orchestrate-crawlers.yml',
]);

function isKnownWorkflow(filename: string): boolean {
  return ADMIN_SCHEDULED_WORKFLOW_IDS.has(filename) || /^crawler-group-\d+\.yml$/u.test(filename);
}

function workflowName(content: string, filename: string): string {
  const match = content.match(/^name:\s*(?:['"]([^'"]+)['"]|([^\n#]+))/m);
  return String(match?.[1] || match?.[2] || filename).trim();
}

function githubCrons(content: string): string[] {
  return [...content.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gmu)].map((match) => match[1].trim());
}

function cloudSchedulerCron(root: string): string | null {
  const sourcePath = path.resolve(root, 'functions/src/orchestratorCronDispatch.js');
  if (!fs.existsSync(sourcePath)) return null;
  const source = fs.readFileSync(sourcePath, 'utf8');
  return source.match(/ORCHESTRATOR_CLOUD_SCHEDULE\s*=\s*['"]([^'"]+)['"]/u)?.[1] || null;
}

export function scanAdminWorkflowSchedules(root: string, day = new Date()): AdminWorkflowScheduleEntry[] {
  const workflowDir = path.resolve(root, '.github/workflows');
  if (!fs.existsSync(workflowDir)) return [];
  const entries: AdminWorkflowScheduleEntry[] = [];
  for (const filename of fs.readdirSync(workflowDir).filter((file) => /\.ya?ml$/u.test(file)).sort()) {
    if (!isKnownWorkflow(filename)) continue;
    const content = fs.readFileSync(path.join(workflowDir, filename), 'utf8');
    const schedules = githubCrons(content).map((cron) => ({
      cron,
      source: 'github-actions' as const,
      occurrencesToday: describeCronForLocalDay(cron, day),
    }));
    if (schedules.length > 0 || /^crawler-group-\d+\.yml$/u.test(filename)) entries.push({ id: filename, name: workflowName(content, filename), schedules });
  }
  const orchestratorCron = cloudSchedulerCron(root);
  if (orchestratorCron && !entries.some((entry) => entry.id === 'orchestrate-crawlers.yml')) {
    entries.push({
      id: 'orchestrate-crawlers.yml',
      name: 'Orchestratore Crawler',
      schedules: [{
        cron: orchestratorCron,
        source: 'cloud-scheduler',
        occurrencesToday: describeCronForLocalDay(orchestratorCron, day),
      }],
    });
  }
  return entries;
}

export function buildAdminWorkflowSchedulePayload(root: string, now = new Date()): AdminWorkflowSchedulePayload {
  return {
    generatedAt: now.toISOString(),
    timezone: 'Europe/Zurich',
    workflows: scanAdminWorkflowSchedules(root, now),
  };
}
