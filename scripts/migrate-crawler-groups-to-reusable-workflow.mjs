#!/usr/bin/env node
/**
 * scripts/migrate-crawler-groups-to-reusable-workflow.mjs
 *
 * One-shot migration script (NOT wired into any CI job) that applies the
 * crawler-group-23 pilot pattern — cross-repo execution via a reusable
 * workflow (`on: workflow_call`) — to crawler-group-01..22.yml.
 *
 * Pilot precedent (verified with a real end-to-end dispatch, all 28 crawlers
 * completed, real commits pushed): frontaliere-si-o-no#6485 -> reverted
 * #6517 (composite action rejects background:/wait-all:) -> #6520 (reusable
 * workflow, dispatch-tested for real) / frontaliere-articles#594 -> #600 ->
 * #602 (points @main instead of a since-deleted branch ref).
 *
 * For each group NN this produces THREE artifacts from the ONE currently
 * committed crawler-group-NN.yml (itself scripts/generate-crawler-group-workflows.mjs's
 * own deterministic output — untouched by this script as an input):
 *
 *  1. crawler-group-NN.yml (frontaliere-si-o-no, OVERWRITTEN in place):
 *     the exact original text, unchanged, with a "DISABLED" header comment
 *     prepended. Kept for fast rollback; the generator can still regenerate
 *     everything below the marker on a future roster change.
 *
 *  2. crawler-group-NN-logic.yml (frontaliere-si-o-no, NEW file): the
 *     reusable workflow (`on: workflow_call`) that actually runs the N
 *     crawlers. Built by transforming the ORIGINAL's parsed YAML object,
 *     not by regenerating from the manifest — so it can never drift from
 *     what is actually committed today.
 *
 *  3. crawler-group-NN.yml (frontaliere-articles, NEW file): the minimal
 *     caller — its own `on:`/`concurrency:`, `uses:` the logic file `@main`.
 *
 * Usage:
 *   node scripts/migrate-crawler-groups-to-reusable-workflow.mjs \
 *     --site-workflows <path to frontaliere-si-o-no/.github/workflows> \
 *     --articles-workflows <path to frontaliere-articles/.github/workflows> \
 *     [--groups 1,2,3] [--dry-run]
 *
 * Exits non-zero if the post-write structural verification (checklist below)
 * fails on ANY generated file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE 5-POINT CHECKLIST THIS SCRIPT ENCODES (found via the group-23 pilot's
 * real dispatch — 3 of these caused a real, silent "0 jobs created" failure;
 * see the fix commits on crawler-group-23-logic.yml):
 * ─────────────────────────────────────────────────────────────────────────
 *  1. NO explicit `token: ""` on the initial cross-repo checkout — omit the
 *     key entirely (falls back to `${{ github.token }}`, sufficient to read
 *     a PUBLIC repo). An explicit empty string fails checkout outright.
 *  2. Nested composite actions (`setup-omniroute`, `setup-claude-haiku-fallback`)
 *     referenced with an ABSOLUTE cross-repo path + `@main`, never `./...`
 *     (a relative path resolves in the CALLER's repo, where it doesn't exist
 *     — GitHub rejects this at parse time, before any job is created).
 *  3. NO `concurrency:` block in the reusable (logic) workflow — only the
 *     caller declares it. A duplicate same-named group on both sides was
 *     observed to break cross-repo workflow_call resolution silently.
 *  4. The caller references the logic file at `@main` — only valid once
 *     that file is merged to `main` on the site.
 *  5. The GITHUB_PAT-from-Remote-Config bootstrap (anonymous checkout ->
 *     load-rc-env.mjs -> `git remote set-url origin` with the PAT) runs
 *     before any step that pushes or opens issues.
 */

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

function parseArgs(argv) {
  const out = { groups: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--site-workflows') out.siteWorkflows = argv[++i];
    else if (a === '--articles-workflows') out.articlesWorkflows = argv[++i];
    else if (a === '--groups') out.groups = argv[++i].split(',').map((s) => parseInt(s, 10));
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.siteWorkflows || !out.articlesWorkflows) {
    throw new Error('--site-workflows and --articles-workflows are required');
  }
  if (!out.groups) out.groups = Array.from({ length: 22 }, (_, i) => i + 1);
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

// The per-crawler fallback default (the `|| '0'` / `|| '1'` part) varies by
// crawler — only the context prefix changes between workflow_dispatch
// (direct) and workflow_call (cross-repo reusable) execution, so only that
// token is replaced, whatever fallback follows it.
const SKIP_AI_OLD_PREFIX = 'github.event.inputs.skip_ai_translation';
const SKIP_AI_NEW_PREFIX = 'inputs.skip_ai_translation';

function bootstrapRunBody(memberCount) {
  return [
    'if [ -z "${GITHUB_PAT:-}" ]; then',
    `  echo "::error::GITHUB_PAT missing from Remote Config (RC_TO_ENV in scripts/load-rc-env.mjs) — cannot push crawler data to valerielinc-ops/frontaliere-si-o-no or file crawler-failure issues there. Aborting before any crawler runs so this fails loud, not as ${memberCount} silent push failures."`,
    '  exit 1',
    'fi',
    'git remote set-url origin "https://x-access-token:${GITHUB_PAT}@github.com/valerielinc-ops/frontaliere-si-o-no.git"',
    'echo "GH_TOKEN=${GITHUB_PAT}" >> "$GITHUB_ENV"',
    'echo "GH_REPO=valerielinc-ops/frontaliere-si-o-no" >> "$GITHUB_ENV"',
  ].join('\n');
}

function disabledHeader(nn) {
  return [
    '# DISABLED — migrated to frontaliere-articles as a cross-repo execution',
    '# reusable-workflow call, following the pattern validated by the',
    '# crawler-group-23 pilot (frontaliere-si-o-no#6485 -> reverted #6517',
    '# (composite action rejects background:/wait-all:) -> #6520 (reusable',
    '# workflow, dispatch-tested for real) / frontaliere-articles#594 -> #600',
    '# -> #602). This group\'s Actions minutes now run against',
    "# nanakokyobashi-rgb's separate, less-saturated concurrent-job pool",
    "# instead of this account's ~20-concurrent-job Free-plan pool. The job",
    '# logic below is unchanged and kept for fast rollback, but nothing',
    '# dispatches it here anymore: orchestrate-crawlers.yml routes every',
    '# crawler-group-*.yml filename to nanakokyobashi-rgb/frontaliere-articles\'s',
    '# own minimal caller instead (see that step\'s "Discover and dispatch',
    `# crawler group workflows"), which calls .github/workflows/crawler-group-${nn}-logic.yml`,
    "# in THIS repo via `uses:` (a reusable workflow, on: workflow_call). This",
    "# file's own `workflow_dispatch` trigger is left in place on purpose — it",
    '# was always the only trigger this file had, so it stays harmless and',
    '# available for a manual local re-test without any other change.',
    '#',
    "# Rollback: revert orchestrate-crawlers.yml's routing (falls through to",
    '# dispatching this file locally again) and delete this comment block —',
    '# the generator (scripts/generate-crawler-group-workflows.mjs) will',
    "# happily regenerate this file's body from scratch on its next run",
    '# regardless, so there is nothing else to restore.',
    '#',
    '# Note on drift: the routing decision that actually disables this file',
    '# lives in orchestrate-crawlers.yml (matched by FILENAME, not by this',
    '# comment), so a routine generator re-run for a future roster change to',
    '# this group is safe — it regenerates everything BELOW this comment',
    '# block from scratch and would silently drop this header, but the',
    '# orchestrator still redirects every "crawler-group-*.yml" to',
    "# frontaliere-articles regardless of what this file's body says. Re-add",
    '# this header by hand if that happens and the migration is still',
    '# active, so the file stays self-explanatory.',
    '#',
    '',
  ].join('\n');
}

function logicHeader(nn) {
  return [
    `# Crawler Group ${nn} logic — reusable workflow (on: workflow_call).`,
    '#',
    '# Physically hosted here (frontaliere-si-o-no) as the single source of',
    '# the crawling logic — but invoked cross-repo from a minimal caller',
    '# workflow physically hosted in frontaliere-articles (account',
    "# nanakokyobashi-rgb), so the RUN and its concurrency-pool consumption",
    "# are billed against nanako's separate, less-saturated pool instead of",
    "# valerielinc-ops' saturated ~20-concurrent-job Free-plan pool.",
    '#',
    '# Structure validated by the crawler-group-23 pilot',
    '# (frontaliere-si-o-no#6485 -> reverted #6517 -> #6520 /',
    '# frontaliere-articles#594 -> #600 -> #602), dispatch-tested for real',
    '# before this batch migrated the remaining 22 groups + translate-pending.yml',
    '# on top of it. A composite action was tried first and reverted: its',
    '# step schema rejects the background:/wait-all: pair every crawler-group',
    "# workflow needs to run its crawlers in parallel (\"Unexpected value",
    '# \'background\'" at workflow-load time, before a single step runs). A',
    '# reusable workflow avoids that: workflow_call defines a FULL job, so it',
    '# keeps the same step schema as a normal job (background/wait-all',
    '# included) and the real secrets context.',
    '#',
    `# The crawler steps below are a straight copy of this group's own`,
    '# committed crawler-group-NN.yml (same source kept, disabled, for',
    '# rollback). Only two things differ from that body: (1) the first step',
    '# is a public/anonymous checkout of this repo instead of the implicit',
    '# "checkout whatever repo this job is already running in" — a',
    "# workflow_call job's workspace starts empty regardless of which repo's",
    '# workflow called it, and it must start anonymous because the caller\'s',
    '# own ambient token is scoped to frontaliere-articles, not this repo;',
    "# (2) each crawler step's own `GH_TOKEN` env line is dropped (it would",
    '# shadow the GITHUB_PAT-derived one bootstrapped below with the wrong,',
    '# read-only ambient token). CLAUDE_CODE_OAUTH_TOKEN and',
    '# FIREBASE_SERVICE_ACCOUNT_JSON are read via the normal secrets context,',
    "# unchanged — the caller passes them explicitly through this workflow's",
    '# declared workflow_call secrets.',
    '',
  ].join('\n');
}

function callerHeader(nn) {
  return [
    `# Crawler Group ${nn} — cross-repo execution (reusable workflow).`,
    '#',
    '# Physically hosted here (nanakokyobashi-rgb/frontaliere-articles)',
    "# instead of frontaliere-si-o-no, so this group's Actions minutes run",
    "# against this account's separate, less-saturated concurrent-job pool",
    "# instead of valerielinc-ops' ~20-concurrent-job Free-plan pool.",
    '#',
    '# Pattern validated by the crawler-group-23 pilot',
    '# (frontaliere-si-o-no#6485 -> reverted #6517 (composite action rejects',
    '# background:/wait-all:) -> #6520 (reusable workflow) /',
    '# frontaliere-articles#594 -> #600 -> #602), dispatch-tested for real',
    '# end-to-end before this group was migrated on top of it.',
    '#',
    '# The actual job logic (checkout, npm ci, RC secrets, the per-crawler',
    '# steps) is NOT duplicated here — it lives in',
    `# valerielinc-ops/frontaliere-si-o-no/.github/workflows/crawler-group-${nn}-logic.yml`,
    '# (single source of truth, same repo the generator',
    '# scripts/generate-crawler-group-workflows.mjs writes into).',
    '#',
    '# This file only supplies what a workflow_call CALLER must: its own',
    "# `on:` trigger (this repo's Actions minutes are the ones spent),",
    "# `concurrency:` (workflow_call doesn't scope concurrency across repos —",
    '# declared here, on the repo that actually owns the run), and the',
    '# secrets the callee declares under its own `on.workflow_call.secrets:`',
    '# (passed explicitly via `secrets:` — a reusable workflow does NOT',
    "# automatically inherit the caller's secrets context unless `secrets:",
    "# inherit` is used, and that would forward THIS repo's full secret set",
    '# for no reason here).',
    '#',
    `# Rollback: frontaliere-si-o-no's .github/workflows/crawler-group-${nn}.yml`,
    "# (disabled, kept for fast revert) + orchestrate-crawlers.yml's routing.",
    '',
  ].join('\n');
}

/** Find a step by its `uses` value (composite actions have no `name:`). */
function findByUses(steps, uses) {
  const idx = steps.findIndex((s) => s.uses === uses);
  if (idx === -1) throw new Error(`step not found: uses: ${uses}`);
  return idx;
}
function findByName(steps, name) {
  const idx = steps.findIndex((s) => s.name === name);
  if (idx === -1) throw new Error(`step not found: name: ${name}`);
  return idx;
}

function buildLogicDoc(orig, nn) {
  const jobKey = `crawler_group_${nn}`;
  const origJob = orig.jobs[jobKey];
  if (!origJob) throw new Error(`job key not found: ${jobKey}`);
  const steps = origJob.steps;

  const checkoutIdx = 0;
  if (steps[checkoutIdx].name !== 'Checkout') throw new Error('unexpected step 0');
  const setupNodeIdx = findByName(steps, 'Setup Node.js');
  const installDepsIdx = findByName(steps, 'Install dependencies');
  const firebaseIdx = findByName(steps, 'Prepare Firebase credentials (optional)');
  const rcIdx = findByName(steps, 'Load secrets from Remote Config');
  const omniIdx = findByUses(steps, './.github/actions/setup-omniroute');
  const haikuIdx = findByUses(steps, './.github/actions/setup-claude-haiku-fallback');
  const waitIdx = findByName(steps, 'Wait for all crawlers in this group');

  const playwrightIdx = steps.findIndex((s) => s.name === 'Install Playwright browsers');

  const crawlerSteps = steps.filter((s) => s.background === true);
  if (crawlerSteps.length === 0) throw new Error('no crawler (background) steps found');

  // Sanity: every step is accounted for by exactly one of the known slots.
  const knownIdx = new Set([checkoutIdx, setupNodeIdx, installDepsIdx, firebaseIdx, rcIdx, omniIdx, haikuIdx, waitIdx]);
  if (playwrightIdx !== -1) knownIdx.add(playwrightIdx);
  for (let i = 0; i < steps.length; i++) {
    const isCrawler = steps[i].background === true;
    if (!knownIdx.has(i) && !isCrawler) {
      throw new Error(`unrecognized step at index ${i}: ${steps[i].name || steps[i].uses}`);
    }
  }

  const newSteps = [];
  newSteps.push({
    name: 'Checkout frontaliere-si-o-no (public, read-only)',
    uses: 'actions/checkout@v5',
    with: {
      repository: 'valerielinc-ops/frontaliere-si-o-no',
      'fetch-depth': steps[checkoutIdx].with['fetch-depth'],
    },
  });
  newSteps.push(steps[setupNodeIdx]);
  newSteps.push(steps[installDepsIdx]);
  if (playwrightIdx !== -1) newSteps.push(steps[playwrightIdx]);
  newSteps.push(steps[firebaseIdx]);
  newSteps.push({ name: 'Load secrets from Remote Config', run: 'node scripts/load-rc-env.mjs' });
  newSteps.push({
    name: 'Bootstrap write auth for frontaliere-si-o-no (GITHUB_PAT from Remote Config)',
    run: bootstrapRunBody(crawlerSteps.length),
  });
  newSteps.push({ uses: 'valerielinc-ops/frontaliere-si-o-no/.github/actions/setup-omniroute@main' });
  newSteps.push({ uses: 'valerielinc-ops/frontaliere-si-o-no/.github/actions/setup-claude-haiku-fallback@main' });

  for (const step of crawlerSteps) {
    const newEnv = {};
    for (const [k, v] of Object.entries(step.env || {})) {
      if (k === 'GH_TOKEN') continue; // dropped: would shadow the bootstrapped token
      newEnv[k] = typeof v === 'string' && v.includes(SKIP_AI_OLD_PREFIX)
        ? v.split(SKIP_AI_OLD_PREFIX).join(SKIP_AI_NEW_PREFIX)
        : v;
    }
    newSteps.push({ ...step, env: newEnv });
  }

  newSteps.push(steps[waitIdx]);

  return {
    on: {
      workflow_call: {
        inputs: orig.on.workflow_dispatch.inputs,
        secrets: {
          FIREBASE_SERVICE_ACCOUNT_JSON: { required: false },
          CLAUDE_CODE_OAUTH_TOKEN: { required: false },
        },
      },
    },
    // NO concurrency: block — see checklist point 3.
    permissions: { contents: 'read' },
    env: orig.env,
    jobs: {
      [jobKey]: {
        'runs-on': origJob['runs-on'],
        'timeout-minutes': origJob['timeout-minutes'],
        steps: newSteps,
      },
    },
  };
}

function buildCallerDoc(nn) {
  return {
    on: {
      workflow_dispatch: {
        inputs: {
          skip_ai_translation: {
            description: 'Skip AI translation (1=yes, cache only)',
            required: false,
            default: '1',
            type: 'string',
          },
        },
      },
    },
    concurrency: {
      group: `jobs-crawler-group-${nn}`,
      'cancel-in-progress': false,
    },
    jobs: {
      [`crawler_group_${nn}`]: {
        uses: `valerielinc-ops/frontaliere-si-o-no/.github/workflows/crawler-group-${nn}-logic.yml@main`,
        with: { skip_ai_translation: '${{ inputs.skip_ai_translation }}' },
        secrets: {
          FIREBASE_SERVICE_ACCOUNT_JSON: '${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}',
          CLAUDE_CODE_OAUTH_TOKEN: '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}',
        },
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Structural verification — the 5-point checklist, mechanically checked on
// every generated file, not just a sample (deterministic script -> cheap).
// ─────────────────────────────────────────────────────────────────────────
function verifyLogicFile(text, nn, origMemberCount) {
  const problems = [];
  const doc = YAML.parse(text);

  if ('concurrency' in doc) problems.push('has a top-level concurrency: block (checklist #3)');

  const relUses = [...text.matchAll(/uses:\s*\.\/\.github\/actions\//g)];
  if (relUses.length > 0) problems.push(`${relUses.length} relative composite-action uses: ./.github/actions/... (checklist #2)`);

  const jobKey = `crawler_group_${nn}`;
  const job = doc.jobs && doc.jobs[jobKey];
  if (!job) problems.push(`missing job key ${jobKey}`);
  const steps = job ? job.steps : [];

  const checkout = steps[0];
  if (!checkout || checkout.name !== 'Checkout frontaliere-si-o-no (public, read-only)') {
    problems.push('first step is not the public checkout');
  } else {
    if (checkout.with && 'token' in checkout.with) problems.push('checkout step has an explicit token: key (checklist #1)');
    if (!checkout.with || checkout.with.repository !== 'valerielinc-ops/frontaliere-si-o-no') problems.push('checkout step missing/wrong repository:');
  }

  const bg = steps.filter((s) => s.background === true);
  if (bg.length !== origMemberCount) problems.push(`background step count ${bg.length} != original ${origMemberCount}`);
  for (const s of bg) {
    if (s.env && 'GH_TOKEN' in s.env) problems.push(`crawler step "${s.name}" still has GH_TOKEN env`);
    for (const v of Object.values(s.env || {})) {
      if (typeof v === 'string' && v.includes('github.event.inputs.skip_ai_translation')) {
        problems.push(`crawler step "${s.name}" still references github.event.inputs.skip_ai_translation`);
      }
    }
  }

  if (!text.includes('valerielinc-ops/frontaliere-si-o-no/.github/actions/setup-omniroute@main')) problems.push('missing absolute setup-omniroute uses:');
  if (!text.includes('valerielinc-ops/frontaliere-si-o-no/.github/actions/setup-claude-haiku-fallback@main')) problems.push('missing absolute setup-claude-haiku-fallback uses:');
  if (!text.includes('GITHUB_PAT')) problems.push('missing GITHUB_PAT bootstrap');

  return problems;
}

function verifyCallerFile(text, nn) {
  const problems = [];
  const doc = YAML.parse(text);
  const jobKey = `crawler_group_${nn}`;
  const job = doc.jobs && doc.jobs[jobKey];
  if (!job) { problems.push(`missing job key ${jobKey}`); return problems; }
  if (!/-logic\.yml@main$/.test(job.uses || '')) problems.push(`uses: does not end in -logic.yml@main (checklist #4): ${job.uses}`);
  if (!job.uses || !job.uses.startsWith('valerielinc-ops/frontaliere-si-o-no/.github/workflows/crawler-group-')) {
    problems.push(`uses: not pointed at the expected logic file: ${job.uses}`);
  }
  if (doc.concurrency?.group !== `jobs-crawler-group-${nn}`) problems.push('concurrency.group mismatch');
  if (!doc.on || !doc.on.workflow_dispatch) problems.push('missing workflow_dispatch trigger');
  if (!job.secrets || !job.secrets.FIREBASE_SERVICE_ACCOUNT_JSON || !job.secrets.CLAUDE_CODE_OAUTH_TOKEN) problems.push('missing declared secrets passthrough');
  return problems;
}

function verifyDisabledFile(text, origText) {
  const problems = [];
  if (!text.startsWith('# DISABLED')) problems.push('missing DISABLED header');
  if (!text.endsWith(origText)) problems.push('original body not preserved verbatim as a suffix');
  return problems;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];

  for (const g of args.groups) {
    const nn = pad(g);
    const siteFile = path.join(args.siteWorkflows, `crawler-group-${nn}.yml`);
    const logicFile = path.join(args.siteWorkflows, `crawler-group-${nn}-logic.yml`);
    const callerFile = path.join(args.articlesWorkflows, `crawler-group-${nn}.yml`);

    const origText = fs.readFileSync(siteFile, 'utf8');
    const origDoc = YAML.parse(origText);
    const origJob = origDoc.jobs[`crawler_group_${nn}`];
    const origMemberCount = origJob.steps.filter((s) => s.background === true).length;

    const logicDoc = buildLogicDoc(origDoc, nn);
    const logicText = logicHeader(nn) + '\n' + YAML.stringify(logicDoc, { lineWidth: 0 });

    const callerDoc = buildCallerDoc(nn);
    const callerText = callerHeader(nn) + YAML.stringify(callerDoc, { lineWidth: 0 });

    const disabledText = disabledHeader(nn) + origText;

    const problems = [
      ...verifyLogicFile(logicText, nn, origMemberCount).map((p) => `[logic] ${p}`),
      ...verifyCallerFile(callerText, nn).map((p) => `[caller] ${p}`),
      ...verifyDisabledFile(disabledText, origText).map((p) => `[disabled] ${p}`),
    ];

    results.push({ nn, origMemberCount, problems });

    if (!args.dryRun) {
      fs.writeFileSync(siteFile, disabledText, 'utf8');
      fs.writeFileSync(logicFile, logicText, 'utf8');
      fs.writeFileSync(callerFile, callerText, 'utf8');
    }
  }

  let failed = 0;
  for (const r of results) {
    if (r.problems.length > 0) {
      failed++;
      console.log(`❌ group ${r.nn} (${r.origMemberCount} crawlers): ${r.problems.length} problem(s)`);
      for (const p of r.problems) console.log(`     ${p}`);
    } else {
      console.log(`✅ group ${r.nn} (${r.origMemberCount} crawlers): OK`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} groups verified clean.`);
  if (failed > 0) {
    console.error(`${failed} group(s) FAILED verification.`);
    process.exit(1);
  }
}

main();
