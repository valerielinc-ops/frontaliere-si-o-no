#!/usr/bin/env node
/**
 * Build the bounded evidence packet consumed by crawler-data-quality-audit.yml.
 *
 * The weekly audit used to ask Claude to discover and investigate every signal
 * itself. Run 33480042764 spent 81 turns on 61 Bash calls, 19 Reads and 6 Greps
 * without reaching issue transport. This script performs the fleet-wide scans
 * once, deterministically, caps examples, plans dedup actions from the open
 * issue inventory and materializes the multiline issue bodies under /tmp.
 * Claude is left only with at most five already-planned `gh issue` actions.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processFiles as scanPreviousSlugContamination } from '../decontaminate-prev-slugs.mjs';
import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import { extractStableJobId } from '../lib/job-match-key.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const MAX_FINDINGS = 5;
const MAX_EXAMPLES = 5;
const STALE_ACTIVE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const OPEN_ISSUES_LIMIT = 100;
export const GH_ACTION_TIMEOUT_MS = 2 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function normalizeText(value, max = 240) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function sanitizeIssueError(value) {
  return normalizeText(value, 800)
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+\b/gi, '[redacted-token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted-token]')
    .replace(/https:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[redacted-credentials]@');
}

function isSubpath(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertTemporaryPath(target, label) {
  const resolved = path.resolve(target);
  // GitHub runners use /tmp; macOS local verification reports a per-user
  // os.tmpdir() under /var/folders while /tmp resolves separately.
  const tempRoots = [os.tmpdir(), '/tmp', '/private/tmp'].map((root) => path.resolve(root));
  if (!tempRoots.some((root) => isSubpath(root, resolved))) {
    throw new Error(`${label} must stay under the system temporary directory: ${resolved}`);
  }
  return resolved;
}

function readSlices(dataDir) {
  return listSliceFileNames(dataDir).map((file) => {
    const filePath = path.join(dataDir, file);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { file, filePath, jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [] };
  });
}

function countCurrentRetranslation(slices) {
  let count = 0;
  for (const { jobs } of slices) {
    for (const job of jobs) if (job?.needsRetranslation === true) count += 1;
  }
  return count;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${normalizeText(result.stderr || result.stdout, 800)}`);
  }
  return result.stdout.trim();
}

function baselineRetranslation(windowDays, relativeDataDir) {
  const commit = runGit(['rev-list', '-1', `--before=${windowDays} days ago`, 'HEAD']);
  if (!commit) throw new Error(`No baseline commit found ${windowDays} days before HEAD`);
  const result = spawnSync('git', [
    'grep', '-h', '-E', '"needsRetranslation"[[:space:]]*:[[:space:]]*true',
    commit, '--', relativeDataDir,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep baseline failed: ${normalizeText(result.stderr || result.stdout, 800)}`);
  }
  const count = result.stdout.split(/\r?\n/).filter(Boolean).length;
  return { commit, count };
}

function scanContamination(slices) {
  const result = scanPreviousSlugContamination(slices.map((slice) => slice.filePath));
  return {
    moved: result.moved,
    affected: result.affected
      .filter((entry) => entry.moved > 0)
      .map((entry) => ({ file: path.basename(entry.filePath), moved: entry.moved })),
  };
}

function stableIdDuplicates(slices) {
  const duplicates = [];
  for (const { file, jobs } of slices) {
    const groups = new Map();
    for (const job of jobs) {
      const stableId = extractStableJobId(job?.url);
      if (!stableId) continue;
      if (!groups.has(stableId)) groups.set(stableId, []);
      groups.get(stableId).push(job);
    }
    for (const [stableId, group] of groups) {
      const slugs = [...new Set(group.map((job) => normalizeText(job?.slug)).filter(Boolean))];
      if (group.length < 2 || slugs.length < 2) continue;
      duplicates.push({
        file,
        stableId: normalizeText(stableId),
        count: group.length,
        slugs: slugs.slice(0, MAX_EXAMPLES),
      });
    }
  }
  return duplicates;
}

function housekeepingSignals(slices, nowMs) {
  const emptyLocaleBuckets = [];
  const staleActive = [];
  const staleBefore = nowMs - (STALE_ACTIVE_DAYS * 24 * 60 * 60 * 1000);

  for (const { file, jobs } of slices) {
    for (const job of jobs) {
      const byLocale = job?.previousSlugsByLocale;
      if (byLocale && typeof byLocale === 'object') {
        for (const [locale, slugs] of Object.entries(byLocale)) {
          if (Array.isArray(slugs) && slugs.length === 0) {
            emptyLocaleBuckets.push({
              file,
              id: normalizeText(job?.id || job?.url || job?.slug),
              locale: normalizeText(locale, 16),
            });
          }
        }
      }

      const explicitlyInactive = job?.publishable === false
        || ['expired', 'removed', 'rejected'].includes(String(job?.status || '').toLowerCase())
        || Boolean(job?.expiredAt || job?.removedAt);
      const crawledAt = typeof job?.crawledAt === 'string' ? Date.parse(job.crawledAt) : NaN;
      if (!explicitlyInactive && Number.isFinite(crawledAt) && crawledAt < staleBefore) {
        staleActive.push({
          file,
          id: normalizeText(job?.id || job?.url || job?.slug),
          crawledAt: new Date(crawledAt).toISOString(),
        });
      }
    }
  }
  return { emptyLocaleBuckets, staleActive };
}

function finding({ key, title, category, summary, evidence, affectedFiles, nextStep }) {
  return {
    key,
    title,
    category,
    summary,
    evidence,
    affectedFiles: [...new Set(affectedFiles)].sort().slice(0, 20),
    nextStep,
  };
}

/**
 * Pure report builder. Tests inject the already-measured fleet signals so the
 * five-finding worst case is deterministic and needs no repository history.
 */
export function buildCrawlerDataQualityReport({
  generatedAt,
  windowDays,
  runUrl,
  fileCount,
  jobCount,
  commitCount,
  contamination,
  duplicates,
  translation,
  housekeeping,
}) {
  const findings = [];

  if (contamination.moved > 0) {
    findings.push(finding({
      key: 'previous-slug-cross-job-contamination',
      title: '[data-quality] previousSlugs: contaminazione cross-job rilevata',
      category: 'slug-stability',
      summary: `${contamination.moved} previousSlug attribuiti al job sbagliato`,
      evidence: [
        `decontaminate-prev-slugs dry-run: ${contamination.affected.length} file, ${contamination.moved} slug da reindirizzare`,
        ...contamination.affected.slice(0, MAX_EXAMPLES)
          .map((entry) => `${entry.file}: moved=${entry.moved}`),
      ],
      affectedFiles: contamination.affected.map((entry) => `data/jobs/by-crawler/${entry.file}`),
      nextStep: 'Rintracciare il writer che ha assegnato lo slug al claimant errato e aggiungere un ratchet di idempotenza/reorder.',
    }));
  }

  if (duplicates.length > 0) {
    findings.push(finding({
      key: 'duplicate-stable-id-divergent-slugs',
      title: '[data-quality] merge: stable ID duplicati con slug divergenti',
      category: 'merge-identity',
      summary: `${duplicates.length} gruppi nello stesso slice condividono lo stable ID ma divergono nello slug`,
      evidence: duplicates.slice(0, MAX_EXAMPLES).map((entry) => (
        `${entry.file}: stableId=${entry.stableId}, records=${entry.count}, slugs=${entry.slugs.join(', ')}`
      )),
      affectedFiles: duplicates.map((entry) => `data/jobs/by-crawler/${entry.file}`),
      nextStep: 'Verificare il merge key del crawler e distinguere repost/multi-location reali prima di consolidare identità o route.',
    }));
  }

  const translationThreshold = Math.max(25, Math.ceil(translation.baselineCount * 0.05));
  if (translation.delta >= translationThreshold) {
    findings.push(finding({
      key: 'needs-retranslation-backlog-growth',
      title: '[data-quality] traduzioni: backlog needsRetranslation in crescita',
      category: 'translation-queue',
      summary: `backlog ${translation.baselineCount} → ${translation.currentCount} (+${translation.delta}) in ${windowDays} giorni`,
      evidence: [
        `baseline ${translation.baselineCommit}: ${translation.baselineCount}`,
        `HEAD: ${translation.currentCount}`,
        `soglia crescita: ${translationThreshold} (max 25 o 5% baseline)`,
      ],
      affectedFiles: ['data/jobs/by-crawler/'],
      nextStep: 'Misurare ingressi/uscite della coda per crawler e correggere il punto che reflagga o non drena, senza sopprimere needsRetranslation.',
    }));
  }

  if (housekeeping.emptyLocaleBuckets.length > 0) {
    findings.push(finding({
      key: 'empty-previous-slug-locale-buckets',
      title: '[data-quality] previousSlugs: bucket locale vuoti persistiti',
      category: 'housekeeping',
      summary: `${housekeeping.emptyLocaleBuckets.length} bucket previousSlugsByLocale vuoti`,
      evidence: housekeeping.emptyLocaleBuckets.slice(0, MAX_EXAMPLES)
        .map((entry) => `${entry.file}: id=${entry.id}, locale=${entry.locale}`),
      affectedFiles: housekeeping.emptyLocaleBuckets.map((entry) => `data/jobs/by-crawler/${entry.file}`),
      nextStep: 'Eliminare i bucket vuoti nel writer/merge che li persiste e preservare i bucket non vuoti e le route esistenti.',
    }));
  }

  if (housekeeping.staleActive.length > 0) {
    findings.push(finding({
      key: 'active-records-stale-over-60-days',
      title: '[data-quality] housekeeping: record attivi non ricrawlati da 60 giorni',
      category: 'freshness-contract',
      summary: `${housekeeping.staleActive.length} record correnti hanno crawledAt più vecchio di ${STALE_ACTIVE_DAYS} giorni`,
      evidence: housekeeping.staleActive.slice(0, MAX_EXAMPLES)
        .map((entry) => `${entry.file}: id=${entry.id}, crawledAt=${entry.crawledAt}`),
      affectedFiles: housekeeping.staleActive.map((entry) => `data/jobs/by-crawler/${entry.file}`),
      nextStep: 'Verificare retirement/grace del crawler e rimuovere o aggiornare il record solo tramite il workflow canonico.',
    }));
  }

  return {
    schemaVersion: 1,
    generatedAt,
    runUrl,
    windowDays,
    cap: MAX_FINDINGS,
    metrics: {
      fileCount,
      jobCount,
      commitCount,
      contaminationMoved: contamination.moved,
      duplicateStableIdGroups: duplicates.length,
      needsRetranslationCurrent: translation.currentCount,
      needsRetranslationBaseline: translation.baselineCount,
      needsRetranslationDelta: translation.delta,
      emptyLocaleBuckets: housekeeping.emptyLocaleBuckets.length,
      staleActiveRecords: housekeeping.staleActive.length,
    },
    findings,
  };
}

function dedupMarker(key) {
  return `<!-- crawler-data-quality:${key} -->`;
}

/** Return the ISO-8601 audit week and a Monday-aligned rotation ordinal. */
export function auditCycle(generatedAt) {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid report.generatedAt: ${generatedAt}`);
  const instant = new Date(timestamp);
  const isoDay = instant.getUTCDay() || 7;
  const mondayMs = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate() - isoDay + 1,
  );
  const thursday = new Date(mondayMs + (3 * DAY_MS));
  const isoYear = thursday.getUTCFullYear();
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const januaryFourthIsoDay = januaryFourth.getUTCDay() || 7;
  const firstMondayMs = Date.UTC(isoYear, 0, 4 - januaryFourthIsoDay + 1);
  const isoWeek = 1 + Math.floor((mondayMs - firstMondayMs) / WEEK_MS);
  return {
    key: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
    ordinal: Math.floor(mondayMs / WEEK_MS),
  };
}

function auditCycleMarker(generatedAt) {
  return `<!-- crawler-data-quality-cycle:${auditCycle(generatedAt).key} -->`;
}

function boundedFindingWindow(report) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  if (findings.length <= MAX_FINDINGS) return { cursor: 0, findings };

  // Rotate once per audit week. A stable run is reproducible, while every
  // candidate enters the five-action window over successive weekly runs.
  const cycle = auditCycle(report.generatedAt);
  const cursor = ((cycle.ordinal % findings.length) + findings.length) % findings.length;
  const rotated = [...findings.slice(cursor), ...findings.slice(0, cursor)];
  return { cursor, findings: rotated.slice(0, MAX_FINDINGS) };
}

/** Plan at most five deterministic create/comment actions for this audit week. */
export function planIssueActions(report, openIssues = [], bodyDir = '/tmp') {
  const window = boundedFindingWindow(report);
  const actions = [];
  for (const entry of window.findings) {
    const marker = dedupMarker(entry.key);
    const cycleMarker = auditCycleMarker(report.generatedAt);
    const existing = openIssues.find((issue) => (
      String(issue?.body || '').includes(marker) || String(issue?.title || '') === entry.title
    ));
    const evidenceSurfaces = existing
      ? [existing.body, ...(Array.isArray(existing.comments)
        ? existing.comments.map((comment) => comment?.body)
        : [])]
      : [];
    const alreadyHandledThisCycle = evidenceSurfaces.some((value) => {
      const text = String(value || '');
      return text.includes(marker) && text.includes(cycleMarker);
    });
    if (alreadyHandledThisCycle) continue;

    actions.push({
      index: actions.length + 1,
      key: entry.key,
      kind: existing ? 'comment' : 'create',
      ...(existing ? { issueNumber: Number(existing.number) } : { title: entry.title }),
      bodyFile: path.join(bodyDir, `crawler-data-quality-issue-${actions.length + 1}.md`),
    });
  }
  return actions;
}

function markdownBody(entry, report, action) {
  const recurrence = action.kind === 'comment'
    ? `\n🔁 Ricorrenza rilevata nel run ${report.runUrl}.\n`
    : '';
  const lines = [
    dedupMarker(entry.key),
    auditCycleMarker(report.generatedAt),
    recurrence.trim(),
    '## Evidenza deterministica',
    '',
    `- ${entry.summary}`,
    ...entry.evidence.map((item) => `- \`${normalizeText(item, 600).replaceAll('`', "'")}\``),
    '',
    '## File interessati',
    '',
    ...entry.affectedFiles.map((file) => `- \`${file}\``),
    '',
    '## Prossimo passo suggerito',
    '',
    entry.nextStep,
    '',
    '## Provenienza',
    '',
    `- Run: ${report.runUrl}`,
    `- Report: schema ${report.schemaVersion}, finestra ${report.windowDays} giorni, generato ${report.generatedAt}`,
  ];
  return `${lines.filter((line, index) => line || lines[index - 1]).join('\n').trim()}\n`;
}

/** Materialize the compact prompt packet and prebuilt multiline issue bodies. */
export function materializeIssuePacket(report, openIssues, { outputPath, bodyDir }) {
  const safeOutputPath = assertTemporaryPath(outputPath, 'outputPath');
  const safeBodyDir = assertTemporaryPath(bodyDir, 'bodyDir');
  fs.mkdirSync(path.dirname(safeOutputPath), { recursive: true });
  fs.mkdirSync(safeBodyDir, { recursive: true });

  const actions = planIssueActions(report, openIssues, safeBodyDir);
  const findingsByKey = new Map(report.findings.map((entry) => [entry.key, entry]));
  for (const action of actions) {
    const expected = path.join(safeBodyDir, `crawler-data-quality-issue-${action.index}.md`);
    if (path.resolve(action.bodyFile) !== path.resolve(expected)) {
      throw new Error(`Unexpected body slot for action ${action.index}: ${action.bodyFile}`);
    }
    const entry = findingsByKey.get(action.key);
    if (!entry) throw new Error(`Missing finding for action key: ${action.key}`);
    fs.writeFileSync(expected, markdownBody(entry, report, action), 'utf8');
  }

  const window = boundedFindingWindow(report);

  const packet = {
    schemaVersion: report.schemaVersion,
    runUrl: report.runUrl,
    metrics: report.metrics,
    scheduling: {
      totalFindings: report.findings.length,
      actionCursor: window.cursor,
      alreadyHandledThisCycle: window.findings.length - actions.length,
      deferredFindings: Math.max(0, report.findings.length - window.findings.length),
    },
    actions,
  };
  fs.writeFileSync(safeOutputPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
  return packet;
}

export function validateOpenIssueInventory(parsed, limit = OPEN_ISSUES_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error(`open-issues-limit must be an integer between 1 and 10000: ${limit}`);
  }
  if (!Array.isArray(parsed)) throw new Error('openIssuesFile must contain a JSON array');
  if (parsed.length >= limit) {
    throw new Error(
      `Open crawler-data-quality issue inventory reached its fetch cap (${parsed.length}/${limit}); refusing mutations because dedup coverage may be incomplete`,
    );
  }
  return parsed;
}

export function loadOpenIssues(filePath, limit = OPEN_ISSUES_LIMIT) {
  validateOpenIssueInventory([], limit);
  if (!filePath) return [];
  const safePath = assertTemporaryPath(filePath, 'openIssuesFile');
  const parsed = JSON.parse(fs.readFileSync(safePath, 'utf8'));
  return validateOpenIssueInventory(parsed, limit);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string, signal?: NodeJS.Signals | null, error?: Error }}
 */
function defaultIssueRunner(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_ACTION_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Execute a validated packet serially; the first failed mutation stops the run.
 * @param {any} packet
 * @param {(command: string, args: string[]) => { status: number | null, stdout: string, stderr: string, signal?: NodeJS.Signals | null, error?: Error }} runner
 */
export function executeIssuePacket(packet, runner = defaultIssueRunner) {
  if (!packet || !Array.isArray(packet.actions)) throw new Error('packet.actions must be an array');
  if (packet.actions.length > MAX_FINDINGS) {
    throw new Error(`packet exceeds mutation cap: ${packet.actions.length} > ${MAX_FINDINGS}`);
  }

  let created = 0;
  let commented = 0;
  for (const [offset, action] of packet.actions.entries()) {
    if (!action || action.index !== offset + 1) throw new Error(`Invalid action index at offset ${offset}`);
    const bodyFile = assertTemporaryPath(action.bodyFile, `action ${action.index} bodyFile`);
    if (!fs.statSync(bodyFile).isFile()) throw new Error(`Missing body file for action ${action.index}`);

    let args;
    if (action.kind === 'create') {
      const title = String(action.title || '');
      if (!/^\[data-quality\] [^\r\n]{1,180}$/.test(title)) {
        throw new Error(`Invalid create title for action ${action.index}`);
      }
      args = ['issue', 'create', '--title', title, '--label', 'crawler-data-quality', '--body-file', bodyFile];
    } else if (action.kind === 'comment') {
      if (!Number.isSafeInteger(action.issueNumber) || action.issueNumber < 1) {
        throw new Error(`Invalid issue number for action ${action.index}`);
      }
      args = ['issue', 'comment', String(action.issueNumber), '--body-file', bodyFile];
    } else {
      throw new Error(`Unsupported action kind at ${action.index}: ${action.kind}`);
    }

    const result = runner('gh', args);
    if (!result || result.status !== 0) {
      const failure = result?.error?.message || result?.stderr || result?.stdout || 'unknown error';
      throw new Error(
        `gh action ${action.index} failed (status=${result?.status ?? 'null'}, signal=${result?.signal ?? 'none'}): ${sanitizeIssueError(failure)}`,
      );
    }
    if (action.kind === 'create') created += 1;
    else commented += 1;
  }
  return { attempted: packet.actions.length, created, commented };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.execute === 'true') {
    if (!args.packet) throw new Error('--packet is required with --execute true');
    const packetPath = assertTemporaryPath(args.packet, 'packetPath');
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(executeIssuePacket(packet))}\n`);
    return;
  }
  const dataDir = path.resolve(args['data-dir'] || DEFAULT_DATA_DIR);
  const outputPath = args.output;
  const bodyDir = args['body-dir'];
  const runUrl = args['run-url'];
  const windowDays = Number(args['window-days'] || 15);
  const openIssuesLimit = Number(args['open-issues-limit'] || OPEN_ISSUES_LIMIT);
  const generatedAt = new Date(args.now || Date.now()).toISOString();

  if (!outputPath || !bodyDir || !runUrl) {
    throw new Error('--output, --body-dir and --run-url are required');
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(runUrl)) {
    throw new Error(`Invalid GitHub Actions run URL: ${runUrl}`);
  }
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 90) {
    throw new Error(`window-days must be an integer between 1 and 90: ${args['window-days']}`);
  }
  if (!isSubpath(ROOT, dataDir)) throw new Error(`data-dir must stay inside the repository: ${dataDir}`);

  const slices = readSlices(dataDir);
  if (slices.length === 0) throw new Error(`No crawler slices found in ${dataDir}`);
  const relativeDataDir = path.relative(ROOT, dataDir).split(path.sep).join('/');
  const baseline = baselineRetranslation(windowDays, relativeDataDir);
  const currentTranslation = countCurrentRetranslation(slices);
  const contamination = scanContamination(slices);
  const duplicates = stableIdDuplicates(slices);
  const housekeeping = housekeepingSignals(slices, Date.parse(generatedAt));
  const commitCount = Number(runGit([
    'rev-list', '--count', `--since=${windowDays} days ago`, 'HEAD', '--', relativeDataDir,
  ]));
  const report = buildCrawlerDataQualityReport({
    generatedAt,
    windowDays,
    runUrl,
    fileCount: slices.length,
    jobCount: slices.reduce((sum, slice) => sum + slice.jobs.length, 0),
    commitCount,
    contamination,
    duplicates,
    translation: {
      baselineCommit: baseline.commit,
      baselineCount: baseline.count,
      currentCount: currentTranslation,
      delta: currentTranslation - baseline.count,
    },
    housekeeping,
  });
  const packet = materializeIssuePacket(report, loadOpenIssues(args['open-issues'], openIssuesLimit), {
    outputPath,
    bodyDir,
  });

  process.stderr.write(
    `[crawler-data-quality] files=${report.metrics.fileCount} jobs=${report.metrics.jobCount}`
      + ` commits=${report.metrics.commitCount} findings=${packet.actions.length}`
      + ` translation=${report.metrics.needsRetranslationBaseline}->${report.metrics.needsRetranslationCurrent}\n`,
  );
  process.stdout.write(JSON.stringify(packet));
}

const isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) main();
