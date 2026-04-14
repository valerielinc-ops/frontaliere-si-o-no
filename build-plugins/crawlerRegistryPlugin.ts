/**
 * crawlerRegistryPlugin — Auto-discover job crawler workflows.
 *
 * Scans .github/workflows/update-jobs-*.yml files and provides workflow
 * metadata (id, title, schedule, defaultInputs) as /data/jobs-crawler-workflows.json.
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
function extractSummaryKey(root: string, workflowFilename: string): string | null {
 const slug = workflowFilename.replace(/^update-jobs-/, '').replace(/\.yml$/, '');
 const scriptPath = path.resolve(root, 'scripts', `update-${slug}-jobs.mjs`);
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

function scanWorkflows(root: string): CrawlerWorkflowEntry[] {
 const workflowDir = path.resolve(root, '.github/workflows');
 if (!fs.existsSync(workflowDir)) return [];

 const files = fs.readdirSync(workflowDir)
 .filter(f => f.startsWith('update-jobs-') && f.endsWith('.yml'))
 .sort();

 const crawlers: CrawlerWorkflowEntry[] = files.map(filename => {
 const content = fs.readFileSync(path.join(workflowDir, filename), 'utf-8');

 // Extract workflow name: "Update XXX Jobs (Dedicated)" → "XXX"
 const nameMatch = content.match(/^name:\s*(.+)$/m);
 const rawName = (nameMatch?.[1]?.trim() || filename).replace(/^["']|["']$/g, '');
 const title = rawName
 .replace(/^Update\s+/i, '')
 .replace(/\s+Jobs?\s*\(.*\)\s*$/i, '')
 .trim();

 // Extract cron schedule: "cron: '45 8 * * *'" → "08:45"
 const cronMatch = content.match(/cron:\s*'(\d+)\s+(\d+)\s+/);
 const schedule = cronMatch
 ? `${cronMatch[2].padStart(2, '0')}:${cronMatch[1].padStart(2, '0')}`
 : null;

 // Check for strict_localization input
 const hasStrictLocalization = content.includes('strict_localization');

 // Extract the summary key that the crawler script uses when writing to jobs-crawler-summaries.json
 const summaryKey = extractSummaryKey(root, filename);

 return {
 id: filename,
 title,
 context: 'jobs' as const,
 summaryKey,
 description: `Crawler dedicato — ${title}.`,
 details: 'Crawler dedicato con localizzazione 4 lingue.',
 expectedDuration: '5-20 min',
 schedule,
 ...(hasStrictLocalization ? { defaultInputs: { strict_localization: '1' } } : {}),
 };
 });

 // Add the orchestrator workflow if it exists
 const orchestratorPath = path.join(workflowDir, 'orchestrate-crawlers.yml');
 if (fs.existsSync(orchestratorPath)) {
 crawlers.unshift({
 id: 'orchestrate-crawlers.yml',
 title: '🎯 Orchestratore Crawler',
 context: 'jobs',
 summaryKey: null,
 description: 'Dispatcher centralizzato — avvia tutti i crawler in sequenza con ritardo configurabile.',
 details: `Sostituisce i 76 schedule individuali. Runs 2×/day (03:00 + 15:00 UTC).`,
 expectedDuration: '30-45 min',
 schedule: '03:00 / 15:00',
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
