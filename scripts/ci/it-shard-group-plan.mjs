#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const IT_SHARD_GROUP_IDS = Object.freeze([
  'zurigo',
  'svizzera',
  'small-1',
  'small-2',
  'small-3',
  'small-4',
]);

const BALANCED_GROUP_IDS = Object.freeze(IT_SHARD_GROUP_IDS.slice(2));
const LARGE_SECTIONS = Object.freeze(['zurigo', 'svizzera']);
const SHA_RE = /^[0-9a-f]{40}$/iu;
const RUN_ID_RE = /^\d+$/u;

function text(value) {
  return value == null ? '' : String(value).trim();
}

export function countFilesRecursive(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`section source directory is missing: ${root}`);
  }
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const dir = fs.opendirSync(current);
    try {
      let entry;
      while ((entry = dir.readSync()) !== null) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(child);
        else if (entry.isFile()) count += 1;
      }
    } finally {
      dir.closeSync();
    }
  }
  return count;
}

export function createItShardGroupPlan({
  repoRoot = process.cwd(),
  distDir = path.join(repoRoot, 'dist'),
  sections,
  sourceRunId,
  sourceSha,
  buildId,
}) {
  const normalizedSections = [...new Set((Array.isArray(sections) ? sections : [])
    .map((section) => text(section).toLowerCase())
    .filter(Boolean))].sort();
  if (normalizedSections.length === 0) {
    throw new Error('IT shard source plan must contain a non-empty required section set');
  }
  const slugMap = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/lib/section-shard-slugs.json'), 'utf8'));
  for (const section of normalizedSections) {
    if (!slugMap[section]?.it) throw new Error(`unknown IT shard section: ${section}`);
  }

  const counts = new Map(normalizedSections.map((section) => [
    section,
    countFilesRecursive(path.join(distDir, slugMap[section].it)),
  ]));
  const groups = IT_SHARD_GROUP_IDS.map((id) => ({ id, sections: [], files: 0 }));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  for (const section of LARGE_SECTIONS) {
    if (!counts.has(section)) continue;
    const group = groupById.get(section);
    group.sections.push(section);
    group.files += counts.get(section);
  }

  const balanced = normalizedSections
    .filter((section) => !LARGE_SECTIONS.includes(section))
    .sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  for (const section of balanced) {
    const target = BALANCED_GROUP_IDS
      .map((id) => groupById.get(id))
      .sort((a, b) => (a.files - b.files) || a.id.localeCompare(b.id))[0];
    target.sections.push(section);
    target.files += counts.get(section);
  }

  for (const group of groups) group.sections.sort();
  const groupedSections = groups.flatMap((group) => group.sections).sort();
  if (groupedSections.length !== normalizedSections.length
      || groupedSections.some((section, index) => section !== normalizedSections[index])) {
    throw new Error('IT shard group assignment is not a one-to-one partition of required sections');
  }

  const runId = text(sourceRunId);
  const sha = text(sourceSha).toLowerCase();
  const normalizedBuildId = text(buildId);
  if (!RUN_ID_RE.test(runId)) throw new Error('source run id is missing or malformed');
  if (!SHA_RE.test(sha)) throw new Error('source SHA is missing or malformed');
  if (!RUN_ID_RE.test(normalizedBuildId)) throw new Error('build id is missing or malformed');

  return {
    schemaVersion: 1,
    kind: 'it-shard-push-group-plan',
    sourceRunId: runId,
    sourceSha: sha,
    buildId: normalizedBuildId,
    requiredSections: normalizedSections,
    fileCounts: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    groups,
  };
}

export function validateItShardGroupPlan(plan, { sourceRunId, sourceSha, buildId } = {}) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: ['plan is not an object'] };
  if (plan.schemaVersion !== 1) errors.push('schemaVersion is unsupported');
  if (plan.kind !== 'it-shard-push-group-plan') errors.push('kind is invalid');
  if (sourceRunId != null && text(plan.sourceRunId) !== text(sourceRunId)) errors.push('sourceRunId does not match');
  if (sourceSha != null && text(plan.sourceSha).toLowerCase() !== text(sourceSha).toLowerCase()) errors.push('sourceSha does not match');
  if (buildId != null && text(plan.buildId) !== text(buildId)) errors.push('buildId does not match');
  if (!RUN_ID_RE.test(text(plan.sourceRunId))) errors.push('sourceRunId is missing or malformed');
  if (!SHA_RE.test(text(plan.sourceSha))) errors.push('sourceSha is missing or malformed');
  if (!RUN_ID_RE.test(text(plan.buildId))) errors.push('buildId is missing or malformed');
  const required = Array.isArray(plan.requiredSections) ? plan.requiredSections : [];
  if (required.length === 0) errors.push('requiredSections is empty or missing');
  if (required.some((section) => typeof section !== 'string' || !text(section))) {
    errors.push('requiredSections contains an invalid section key');
  }
  if (new Set(required).size !== required.length) errors.push('requiredSections contains duplicate sections');
  if (!Array.isArray(plan.groups)) errors.push('groups is not an array');
  else {
    const ids = plan.groups.map((group) => text(group?.id));
    if (ids.length !== IT_SHARD_GROUP_IDS.length || IT_SHARD_GROUP_IDS.some((id) => !ids.includes(id))) {
      errors.push('groups do not match the required group ids');
    }
    const sections = plan.groups.flatMap((group) => Array.isArray(group?.sections) ? group.sections : []);
    if ([...sections].sort().join('\n') !== [...required].sort().join('\n')) {
      errors.push('group sections do not partition requiredSections');
    }
    for (const section of LARGE_SECTIONS) {
      const group = plan.groups.find((candidate) => candidate?.id === section);
      if (required.includes(section) && (group?.sections?.length !== 1 || group.sections[0] !== section)) {
        errors.push(`${section} must stay alone in its group`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    args[key] = argv[index + 1]?.startsWith('--') ? true : (argv[index + 1] ?? true);
    if (args[key] !== true) index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['validate-plan']) {
    const plan = JSON.parse(fs.readFileSync(args['validate-plan'], 'utf8'));
    const verdict = validateItShardGroupPlan(plan, {
      sourceRunId: args['source-run-id'],
      sourceSha: args['source-sha'],
      buildId: args['build-id'],
    });
    console.log(JSON.stringify(verdict));
    if (!verdict.valid) process.exitCode = 1;
    return;
  }
  if (!args['sections-json'] || !args['source-run-id'] || !args['source-sha'] || !args['build-id'] || !args.out) {
    throw new Error('usage: it-shard-group-plan.mjs --sections-json <json> --source-run-id <id> --source-sha <sha> --build-id <id> --out <file>');
  }
  const plan = createItShardGroupPlan({
    repoRoot: args['repo-root'] || process.cwd(),
    distDir: args['dist-dir'] || path.join(args['repo-root'] || process.cwd(), 'dist'),
    sections: JSON.parse(args['sections-json']),
    sourceRunId: args['source-run-id'],
    sourceSha: args['source-sha'],
    buildId: args['build-id'],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify({ requiredSections: plan.requiredSections, groups: plan.groups }));
}

if (process.argv[1] && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })()) {
  try { main(); } catch (error) {
    console.error(`[it-shard-group-plan] ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  }
}
