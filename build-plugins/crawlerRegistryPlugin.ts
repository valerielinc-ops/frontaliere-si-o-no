/**
 * crawlerRegistryPlugin — Auto-discover job crawler workflows.
 *
 * Scans .github/workflows/crawler-group-*.yml files (consolidated 2026-07:
 * replaces the former 581 individual update-jobs-*.yml workflows — each
 * crawler now runs as a `background: true` step inside one of 23 grouped
 * workflows, see scripts/generate-crawler-group-workflows.mjs) and provides
 * workflow metadata (id, title, schedule, defaultInputs) as
 * /data/jobs-crawler-workflows.json.
 *
 * - Build: writes dist/data/jobs-crawler-workflows.json
 * - Dev server: serves the JSON via middleware (live-scanned on each request)
 */
import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

interface CrawlerWorkflowEntry {
 id: string;
 title: string;
 context: 'jobs';
 description: string;
 details: string;
 expectedDuration: string;
 schedule: string | null;
 summaryKey: string | null;
 defaultInputs?: Record<string, string>;
 /** Present on per-crawler entries: dispatching `id` runs the WHOLE group
  * (crawler-group-NN.yml), not just this crawler — surfaced to the admin UI
  * so a "run" click on one crawler is honestly labeled as running its group. */
 groupSize?: number;
}

/** Mirror the normalization used by scripts/jobs-url-helper.mjs normalizeSummaryKey() */
function normalizeSummaryKey(label: string): string {
 return label
 .trim()
 .toLowerCase()
 .replace(/[^a-z0-9]+/g, '-')
 .replace(/^-+|-+$/g, '') || 'generic-crawler';
}

/**
 * Try to extract the company label used by `printCrawlChangeSummary(diff, LABEL)`.
 * Reads the crawler script and looks for COMPANY_NAME or the literal label arg.
 */
function extractSummaryKey(root: string, crawlerSlug: string): string | null {
 const scriptPath = path.resolve(root, 'scripts', `update-${crawlerSlug}-jobs.mjs`);
 if (!fs.existsSync(scriptPath)) return null;

 try {
 const src = fs.readFileSync(scriptPath, 'utf-8');
 // Pattern 1: printCrawlChangeSummary(diff, COMPANY_NAME) where COMPANY_NAME is a const
 const constMatch = src.match(/printCrawlChangeSummary\s*\(\s*\w+\s*,\s*(\w+)\s*\)/);
 if (constMatch) {
 const varName = constMatch[1];
 // Find const declaration: const COMPANY_NAME = 'The Living Circle';
 const declRegex = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`);
 const declMatch = src.match(declRegex);
 if (declMatch) return normalizeSummaryKey(declMatch[1]);
 }
 // Pattern 2: printCrawlChangeSummary(diff, 'Literal String')
 const literalMatch = src.match(/printCrawlChangeSummary\s*\(\s*\w+\s*,\s*['"`]([^'"`]+)['"`]\s*\)/);
 if (literalMatch) return normalizeSummaryKey(literalMatch[1]);
 } catch {
 // non-blocking
 }
 return null;
}

/**
 * Extract each member crawler's slug + display title from a
 * crawler-group-NN.yml's `- name: "Crawler: Update XXX Jobs (Dedicated)"` /
 * `id: crawler-<slug>` step pairs (see scripts/generate-crawler-group-workflows.mjs).
 */
function extractGroupMembers(groupFileContent: string): Array<{ slug: string; title: string; hasStrictLocalization: boolean }> {
 const members: Array<{ slug: string; title: string; hasStrictLocalization: boolean }> = [];
 // Split the file into per-step chunks anchored on `id: crawler-<slug>` so we
 // can scope the strict_localization check to THIS crawler's own step body
 // rather than the whole file (a sibling crawler in the same group might
 // declare it while this one doesn't).
 const stepRegex = /- name:\s*"Crawler:\s*(.+?)"\s*\n\s*id:\s*crawler-([a-z0-9-]+)\s*\n([\s\S]*?)(?=\n\s*- name:|\n\s*- (?!name:)|$)/g;
 let match: RegExpExecArray | null;
 while ((match = stepRegex.exec(groupFileContent)) !== null) {
 const [, rawTitle, slug, stepBody] = match;
 const title = rawTitle
 .replace(/^Update\s+/i, '')
 .replace(/\s+Jobs?\s*\(.*\)\s*$/i, '')
 .trim();
 members.push({
 slug,
 title,
 hasStrictLocalization: stepBody.includes('strict_localization'),
 });
 }
 return members;
}

function scanWorkflows(root: string): CrawlerWorkflowEntry[] {
 const workflowDir = path.resolve(root, '.github/workflows');
 if (!fs.existsSync(workflowDir)) return [];

 const files = fs.readdirSync(workflowDir)
 .filter(f => f.startsWith('crawler-group-') && f.endsWith('.yml'))
 .sort();

 const crawlers: CrawlerWorkflowEntry[] = files.flatMap(filename => {
 const content = fs.readFileSync(path.join(workflowDir, filename), 'utf-8');
 const members = extractGroupMembers(content);
 const groupLabel = filename.replace(/^crawler-group-/, '').replace(/\.yml$/, '');

 return members.map(({ slug, title, hasStrictLocalization }) => {
 const summaryKey = extractSummaryKey(root, slug);
 return {
 // Dispatching this `id` runs the WHOLE group (crawler-group-NN.yml),
 // not just this one crawler — the file-level workflow is the only
 // dispatchable unit since the 2026-07 consolidation.
 id: filename,
 title,
 context: 'jobs' as const,
 summaryKey,
 description: `Crawler dedicato — ${title} (gruppo ${groupLabel}, ${members.length} crawler condividono questo run).`,
 details: 'Crawler dedicato con localizzazione 4 lingue. Eseguito come step background all\'interno del gruppo — avviarlo avvia anche gli altri crawler dello stesso gruppo.',
 expectedDuration: '5-20 min',
 schedule: null,
 groupSize: members.length,
 ...(hasStrictLocalization ? { defaultInputs: { strict_localization: '1' } } : {}),
 };
 });
 });

 // Add the orchestrator workflow if it exists
 const orchestratorPath = path.join(workflowDir, 'orchestrate-crawlers.yml');
 if (fs.existsSync(orchestratorPath)) {
 crawlers.unshift({
 id: 'orchestrate-crawlers.yml',
 title: '🎯 Orchestratore Crawler',
 context: 'jobs',
 summaryKey: null,
 description: 'Dispatcher centralizzato — avvia tutti i 23 gruppi crawler in sequenza con ritardo configurabile.',
 details: `Sostituisce i cron individuali. Runs 2×/day (09:00 + 21:00 UTC).`,
 expectedDuration: '5-10 min (solo dispatch — i gruppi girano in parallelo)',
 schedule: '09:00 / 21:00',
 defaultInputs: { group: 'all', delay_seconds: '20', dry_run: 'false' },
 });
 }

 return crawlers;
}

export function crawlerRegistryPlugin(root: string): Plugin {
 return {
 name: 'crawler-registry-plugin',
 configureServer(server) {
 server.middlewares.use('/data/jobs-crawler-workflows.json', (_req, res) => {
 const workflows = scanWorkflows(root);
 const payload = JSON.stringify({ generatedAt: new Date().toISOString(), workflows }, null, 2);
 res.setHeader('Content-Type', 'application/json');
 res.end(payload);
 });
 },
 closeBundle() {
 const workflows = scanWorkflows(root);
 if (workflows.length === 0) {
 console.log(' 🔧 Crawler registry: .github/workflows not found, skipping');
 return;
 }

 const dest = path.resolve(root, 'dist/data/jobs-crawler-workflows.json');
 fs.mkdirSync(path.dirname(dest), { recursive: true });
 fs.writeFileSync(dest, JSON.stringify({
 generatedAt: new Date().toISOString(),
 workflows,
 }, null, 2));

 console.log(` 🔧 Crawler registry: ${workflows.length} job crawler workflows discovered`);
 },
 };
}
