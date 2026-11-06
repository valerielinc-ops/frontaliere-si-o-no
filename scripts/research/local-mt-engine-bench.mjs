#!/usr/bin/env node
/**
 * Bench of the Argos worker (scripts/local-mt-translate.py) on real queued work.
 *
 * Builds the same requests the mop-up would hand the worker (needsWork →
 * missingSlots → buildMopupRequest, titles first) from data/jobs/by-crawler,
 * takes a deterministic sample, runs a BASE worker and the HEAD worker on it
 * under the same wall-clock cap, and reports throughput and how many
 * responses are byte-identical. Run by .github/workflows/local-mt-bench.yml on
 * the Linux runner the translation pipeline uses; it is not a unit test.
 *
 *   node scripts/research/local-mt-engine-bench.mjs \
 *     --base /tmp/base-worker.py --requests 600 --cap-seconds 900 \
 *     [--head-env LOCAL_MT_ENGINE=batched] [--base-env LOCAL_MT_ENGINE=legacy] \
 *     [--variant name:ENV=VAL,ENV=VAL]...
 *
 * Each `--variant` runs the HEAD worker once more with its own environment, so
 * one bench can tell which part of a change moves the output.
 *
 * `--judge` scores every response with the mop-up's semantic judge (e5 cosine
 * between source and translation, the gate in front of every mop-up write).
 * The worker's output depends on how CTranslate2 batches the sentences, so
 * byte-equality with the base says only "same batching"; the score says
 * whether the translations are as good.
 *
 * Writes a Markdown report to stdout and, when set, to $GITHUB_STEP_SUMMARY.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import { buildMopupRequest, missingSlots, needsWork } from '../local-mt-mopup.mjs';
import { createLocalMtSemanticJudge, DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD } from '../lib/local-mt-semantic-judge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HEAD_WORKER = path.join(ROOT, 'scripts', 'local-mt-translate.py');
const BY_CRAWLER = path.join(ROOT, 'data', 'jobs', 'by-crawler');

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function envOpts(name) {
  const out = {};
  process.argv.forEach((arg, i) => {
    if (arg === name && process.argv[i + 1]) {
      const [k, ...v] = process.argv[i + 1].split('=');
      out[k] = v.join('=');
    }
  });
  return out;
}

/** Deterministic 32-bit hash, so the sample is stable across runs of one tree. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function buildSample({ total, titleShare = 0.3 }) {
  const titles = [];
  const descriptions = [];
  let nextId = 0;
  for (const file of listSliceFileNames(BY_CRAWLER)) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(BY_CRAWLER, file), 'utf-8')); } catch { continue; }
    if (!Array.isArray(data?.jobs)) continue;
    for (const job of data.jobs) {
      if (!needsWork(job)) continue;
      const from = job.sourceLang || 'it';
      for (const { locale, field } of missingSlots(job)) {
        const text = String((field === 'title' ? job.title : job.description) || '').trim();
        if (!text) continue;
        const { request } = buildMopupRequest({ id: `r${nextId++}`, text, from, to: locale, field });
        (field === 'title' ? titles : descriptions).push(request);
      }
    }
  }
  const byHash = (a, b) => hash(`${a.from}${a.to}${a.text}`) - hash(`${b.from}${b.to}${b.text}`);
  titles.sort(byHash);
  descriptions.sort(byHash);
  const nTitles = Math.min(titles.length, Math.round(total * titleShare));
  return {
    queued: { titles: titles.length, descriptions: descriptions.length },
    sample: [...titles.slice(0, nTitles), ...descriptions.slice(0, total - nTitles)],
  };
}

function runWorker(script, input, { capSeconds, env }) {
  const started = Date.now();
  const proc = spawnSync('python3', [script], {
    input,
    encoding: 'utf-8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: capSeconds * 1000,
    env: { ...process.env, ...env },
  });
  const seconds = (Date.now() - started) / 1000;
  const responses = new Map();
  for (const line of String(proc.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.id) responses.set(row.id, row);
    } catch { /* partial last line after a kill */ }
  }
  const stderr = String(proc.stderr || '');
  const summary = stderr.split('\n').filter((l) => l.includes('🏁') || l.includes('🐍')).join(' / ');
  return { seconds, timedOut: proc.error?.code === 'ETIMEDOUT', status: proc.status, responses, summary, stderr };
}

/**
 * Semantic score of the responses of `run`, on the requests `reference` also
 * answered, and who scores higher where the two texts differ.
 */
async function judgeRun(judge, sample, run, reference) {
  let n = 0;
  let sum = 0;
  let accepted = 0;
  let differing = 0;
  let higher = 0;
  let lower = 0;
  for (const r of sample) {
    const mine = run.responses.get(r.id)?.text;
    const theirs = reference.responses.get(r.id)?.text;
    if (!mine || !theirs) continue;
    const verdict = await judge({ sourceText: r.text, candidateText: mine });
    if (!Number.isFinite(verdict?.score)) continue;
    n++;
    sum += verdict.score;
    if (verdict.score >= DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD) accepted++;
    if (run === reference || mine === theirs) continue;
    const other = await judge({ sourceText: r.text, candidateText: theirs });
    if (!Number.isFinite(other?.score)) continue;
    differing++;
    if (verdict.score > other.score + 0.005) higher++;
    else if (verdict.score < other.score - 0.005) lower++;
  }
  return { n, mean: n ? sum / n : 0, accepted, differing, higher, lower };
}

async function main() {
  const base = opt('--base');
  if (!base || !fs.existsSync(base)) throw new Error('--base <worker.py> is required');
  const total = Number(opt('--requests', '600'));
  const capSeconds = Number(opt('--cap-seconds', '900'));
  const { queued, sample } = buildSample({ total });
  const input = sample.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const directions = {};
  for (const r of sample) directions[`${r.from}>${r.to}`] = (directions[`${r.from}>${r.to}`] || 0) + 1;

  const runs = {
    base: runWorker(base, input, { capSeconds, env: envOpts('--base-env') }),
    head: runWorker(HEAD_WORKER, input, { capSeconds, env: envOpts('--head-env') }),
  };
  process.argv.forEach((arg, i) => {
    if (arg !== '--variant' || !process.argv[i + 1]) return;
    const [name, spec = ''] = process.argv[i + 1].split(':');
    const env = Object.fromEntries(spec.split(',').filter(Boolean).map((kv) => {
      const [k, ...v] = kv.split('=');
      return [k, v.join('=')];
    }));
    runs[name] = runWorker(HEAD_WORKER, input, { capSeconds, env });
  });

  const compare = (other, reference = runs.base) => {
    let both = 0;
    let identical = 0;
    const diffs = [];
    for (const r of sample) {
      const a = reference.responses.get(r.id);
      const b = other.responses.get(r.id);
      if (!a?.text || !b?.text) continue;
      both++;
      if (a.text === b.text) identical++;
      else if (diffs.length < 8) {
        // Show the first line that differs, not the (usually equal) head of a
        // long description.
        const la = a.text.split('\n');
        const lb = b.text.split('\n');
        let i = 0;
        while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
        diffs.push({
          dir: `${r.from}>${r.to}`,
          lines: `${la.length}/${lb.length}`,
          base: String(la[i] ?? '').slice(0, 200),
          head: String(lb[i] ?? '').slice(0, 200),
        });
      }
    }
    return { both, identical, diffs };
  };
  const row = (name, run, same, sameAsHead) => {
    const done = [...run.responses.values()].filter((x) => x.text).length;
    return `| ${name} | ${run.seconds.toFixed(0)} s${run.timedOut ? ' (cap)' : ''} | ${done}/${sample.length} | ${(done / Math.max(1, run.seconds) * 60).toFixed(1)} | ${same} | ${sameAsHead} | ${run.summary.replace(/\|/g, '/')} |`;
  };
  const lines = [
    '## Argos worker bench',
    '',
    `Queue on this tree: ${queued.titles} title + ${queued.descriptions} description requests. Sample: ${sample.length} (${Object.entries(directions).map(([k, v]) => `${k} ${v}`).join(', ')}), cap ${capSeconds}s per worker, ${os.cpus().length} CPUs.`,
    '',
    '| worker | wall | requests done | requests/min | identical to base | identical to head | worker log |',
    '|---|---|---|---|---|---|---|',
  ];
  const comparisons = {};
  // A bench with a crashed worker or an unusable judge is not a measurement:
  // the report is still printed, the step fails.
  const failures = [];
  for (const [name, run] of Object.entries(runs)) {
    const done = [...run.responses.values()].filter((x) => x.text).length;
    if (run.status !== 0 && !run.timedOut) failures.push(`${name} exited ${run.status}`);
    else if (done === 0) failures.push(`${name} produced no response`);
  }
  for (const [name, run] of Object.entries(runs)) {
    if (name === 'base') {
      lines.push(row(name, run, '—', '—'));
      continue;
    }
    const share = (c) => `${c.identical}/${c.both} (${c.both ? ((100 * c.identical) / c.both).toFixed(1) : '0.0'}%)`;
    const c = compare(run);
    comparisons[name] = c;
    // Head against a head variant: does the output depend on how the units
    // were grouped (chunk size, batch mode)?
    lines.push(row(name, run, share(c), name === 'head' ? '—' : share(compare(run, runs.head))));
  }
  for (const [name, c] of Object.entries(comparisons)) {
    if (!c.diffs.length) continue;
    lines.push('', `<details><summary>${name}: first responses that differ from base</summary>`, '');
    for (const d of c.diffs) lines.push(`- \`${d.dir}\` (lines ${d.lines}, first differing line)  \n  base: ${JSON.stringify(d.base)}  \n  ${name}: ${JSON.stringify(d.head)}`);
    lines.push('', '</details>');
  }
  if (process.argv.includes('--judge')) {
    const judge = createLocalMtSemanticJudge({ cacheMax: 20000 });
    lines.push(
      '',
      `### Semantic judge (e5 cosine source/translation, write threshold ${DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD})`,
      '',
      'On the requests both the worker and base answered. "differing" = responses whose text is not base\'s; higher/lower = score against base\'s text for the same request (±0.005 is a tie).',
      '',
      '| worker | scored | mean score | at or above threshold | differing from base | scores higher | scores lower |',
      '|---|---|---|---|---|---|---|',
    );
    for (const [name, run] of Object.entries(runs)) {
      const j = await judgeRun(judge, sample, run, runs.base);
      // A judge that cannot score (model or native binaries missing) must not
      // leave a table that reads like a measurement.
      if (j.n === 0) failures.push(`semantic judge scored no response of ${name}`);
      lines.push(`| ${name} | ${j.n} | ${j.mean.toFixed(4)} | ${j.accepted} (${j.n ? ((100 * j.accepted) / j.n).toFixed(1) : '0.0'}%) | ${name === 'base' ? '—' : j.differing} | ${name === 'base' ? '—' : j.higher} | ${name === 'base' ? '—' : j.lower} |`);
    }
  }
  for (const [name, run] of Object.entries(runs)) {
    if (run.status !== 0 && !run.timedOut) lines.push('', `⚠️ ${name} exited ${run.status}:`, '```', run.stderr.slice(-2000), '```');
  }
  const report = lines.join('\n') + '\n';
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (failures.length) {
    console.error(`❌ bench not valid: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
