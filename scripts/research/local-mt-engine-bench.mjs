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
 * Writes a Markdown report to stdout and, when set, to $GITHUB_STEP_SUMMARY.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listSliceFileNames } from '../lib/crawler-slice-files.mjs';
import { buildMopupRequest, missingSlots, needsWork } from '../local-mt-mopup.mjs';

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

function main() {
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
  for (const [name, run] of Object.entries(runs)) {
    if (run.status !== 0 && !run.timedOut) lines.push('', `⚠️ ${name} exited ${run.status}:`, '```', run.stderr.slice(-2000), '```');
  }
  const report = lines.join('\n') + '\n';
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}

main();
