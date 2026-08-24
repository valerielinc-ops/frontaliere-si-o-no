/**
 * crawlerRegistryPlugin — Auto-discover job crawler workflows.
 *
 * Consolidation (2026-07): the 581 individual `update-jobs-*.yml` workflows
 * (one GitHub Actions workflow per crawler) were replaced by 23 grouped
 * `crawler-group-*.yml` workflows, each bundling ~25 crawlers as concurrent
 * `background: true` steps inside ONE job (see
 * scripts/generate-crawler-group-workflows.mjs). There is no longer a 1:1
 * mapping between a crawler and a dispatchable GitHub Actions workflow file.
 *
 * To keep the admin panel's existing per-crawler summary/status UI working
 * unchanged (components/pages/AdminPanel.tsx matches a crawler's job-count
 * summary by slug/summaryKey, and dispatches/polls runs by `workflow.id` as
 * a literal GitHub Actions workflow filename), this plugin still emits ONE
 * registry entry PER CRAWLER — but `id` now points at that crawler's
 * CONTAINING GROUP workflow file, since that's the only thing GitHub can
 * actually dispatch/poll. Manually triggering a single crawler from the
 * admin panel now dispatches its whole group (that group's other ~25
 * crawlers run alongside it) — an honest consequence of the consolidation,
 * not a bug. `groupId`/`groupMemberCount` are added so the UI can label this
 * clearly if desired.
 *
 * Provides workflow metadata (id, title, schedule, defaultInputs) as
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
 slug?: string;
 groupId?: string;
 groupMemberCount?: number;
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
function extractSummaryKey(root: string, slug: string): string | null {
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

/**
 * Extract per-crawler slugs from a generated crawler-group-NN.yml file. Each
 * crawler's background step has a stable `id: crawler-<slug>` marker (see
 * scripts/generate-crawler-group-workflows.mjs) and a `name: Run <slug>` —
 * both are greppable without a full YAML parse (kept dependency-free/fast
 * since this runs on every dev-server request).
 */
function extractGroupMembers(content: string): string[] {
 const ids = [...content.matchAll(/^\s*id:\s*crawler-(\S+)\s*$/gm)].map(m => m[1]);
 return ids;
}

function scanWorkflows(root: string): CrawlerWorkflowEntry[] {
 const workflowDir = path.resolve(root, '.github/workflows');
 if (!fs.existsSync(workflowDir)) return [];

 const groupFiles = fs.readdirSync(workflowDir)
 .filter(f => /^crawler-group-\d+\.yml$/.test(f))
 .sort();

 const crawlers: CrawlerWorkflowEntry[] = [];

 for (const filename of groupFiles) {
 const content = fs.readFileSync(path.join(workflowDir, filename), 'utf-8');
 const members = extractGroupMembers(content);

 for (const slug of members) {
 // Human-friendly title from the slug (e.g. "klinik-schuetzen" -> "Klinik Schuetzen").
 const title = slug
 .split('-')
 .map(part => part.charAt(0).toUpperCase() + part.slice(1))
 .join(' ');

 // Group workflows are workflow_dispatch-only (scheduling lives in
 // orchestrate-crawlers.yml), so there's no per-crawler cron to extract.
 const schedule = null;

 // strict_localization is no longer a group-level workflow_dispatch
 // input (it's baked into each crawler's own inlined shell body with
 // its original per-crawler fallback default) — no defaultInputs needed.
 const summaryKey = extractSummaryKey(root, slug);

 crawlers.push({
 id: filename,
 title,
 context: 'jobs' as const,
 summaryKey,
 description: `Crawler dedicato — ${title} (parte di ${filename}).`,
 details: `Crawler dedicato con localizzazione 4 lingue. Eseguito insieme ad altri ${members.length - 1} crawler nello stesso gruppo (${filename}) — il dispatch avvia l'intero gruppo.`,
 expectedDuration: '5-20 min',
 schedule,
 slug,
 groupId: filename,
 groupMemberCount: members.length,
 });
 }
 }

 // Add the orchestrator workflow if it exists
 const orchestratorPath = path.join(workflowDir, 'orchestrate-crawlers.yml');
 if (fs.existsSync(orchestratorPath)) {
 crawlers.unshift({
 id: 'orchestrate-crawlers.yml',
 title: '🎯 Orchestratore Crawler',
 context: 'jobs',
 summaryKey: null,
 description: 'Dispatcher centralizzato — avvia tutti i crawler-group in sequenza con ritardo configurabile.',
 details: `Dispatcha i ${groupFiles.length} workflow crawler-group (ognuno esegue in parallelo, come background steps, i crawler del proprio gruppo). Nessun crawler ha più uno schedule individuale. Runs 2×/day (09:00 + 21:00 UTC).`,
 expectedDuration: '60-90 min',
 schedule: '09:00 / 21:00',
 defaultInputs: { group: 'all', delay_seconds: '60', dry_run: 'false' },
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
