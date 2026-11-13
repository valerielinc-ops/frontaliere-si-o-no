#!/usr/bin/env node
import { isInvokedDirectly } from './is-invoked-directly.mjs';
import { fanoutSectionTree, rewriteSectionTreeIndex } from './ticino-tree-fanout.mjs';
import { parseFanoutAutoThreshold, decideSectionTreeFanout } from './section-tree-fanout-policy.mjs';
import { readSectionTreeLayoutRegistry } from './section-tree-layout-registry.mjs';
import { sectionTreeLayoutSections } from '../../infra/cloudflare-worker/section-tree-layout-schema.js';

export const WORKER_LAYOUT_PROBE_ATTEMPTS = 18;
export const WORKER_LAYOUT_PROBE_RETRY_MS = 20_000;

function responseHeader(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.[name] ?? null;
}

function workerProbeUrl(sub, section) {
  const path = sub.replace(/^\/+|\/+$/gu, '');
  const url = new URL(`https://frontaliereticino.ch/${path}/`);
  url.searchParams.set('__frontaliere_section_tree_layout', 'hash-v1');
  url.searchParams.set('section', section);
  return url.toString();
}

export async function requireWorkerSectionTreeLayout(section, sub, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = WORKER_LAYOUT_PROBE_ATTEMPTS,
  retryMs = WORKER_LAYOUT_PROBE_RETRY_MS,
} = {}) {
  const url = workerProbeUrl(sub, section);
  let lastFailure = 'probe did not return a response';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      });
      const generic = response?.headers?.get?.('x-frontaliere-section-tree-layout');
      const advertisedSection = responseHeader(response, 'x-frontaliere-section');
      const legacy = responseHeader(response, `x-frontaliere-${section}-tree-layout`);
      if (response?.status === 204 && generic === 'hash-v1' && advertisedSection === section) return;
      if (response?.status === 204 && legacy === 'hash-v1') return;
      lastFailure = `HTTP ${response?.status ?? 'no response'} did not advertise hash-v1 for ${section}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(retryMs);
  }
  throw new Error(`[section-tree-layout] Worker did not confirm hash-v1 for ${section} after ${attempts} probes (${lastFailure}); refusing to publish hashed paths`);
}

export async function stageSectionTreeLayout({
  section,
  locale,
  percent,
  threshold = parseFanoutAutoThreshold(process.env.FANOUT_AUTO_THRESHOLD_PCT),
  stage,
  sub,
  mode = 'filesystem',
  readRegistry = readSectionTreeLayoutRegistry,
  probeWorker = requireWorkerSectionTreeLayout,
  applyFilesystemFanout = fanoutSectionTree,
  applyIndexFanout = rewriteSectionTreeIndex,
  stderr = console.error,
} = {}) {
  if (!section || !locale || !stage || !sub) throw new Error('section, locale, stage and sub are required');
  if (!['filesystem', 'index'].includes(mode)) throw new Error(`unsupported section tree staging mode: ${mode}`);
  const registry = await readRegistry();
  const initialSections = sectionTreeLayoutSections(registry);
  const decision = decideSectionTreeFanout({
    percent,
    threshold,
    alreadyFanned: initialSections.includes(section),
  });
  if (Number(percent) >= 30) {
    stderr(`::warning::[tree-fanout] section=${section} locale=${locale} pct=${percent} warning=unfanned-tree-at-least-30`);
  }
  stderr(`[tree-fanout] section=${section} locale=${locale} pct=${percent} decision=${decision}`);

  if (decision === 'keep') {
    return { decision, moved: 0, sections: initialSections };
  }
  if (decision === 'fan') {
    throw new Error(`[section-tree-layout:preflight-required] ${section} crosses the automatic fan-out threshold in ${locale}, but is not in the durable registry; the cross-locale preflight must register and probe it before any section push`);
  }
  const sections = initialSections;
  await probeWorker(section, sub);

  let moved = 0;
  if (mode === 'filesystem') {
    applyFilesystemFanout(`${stage}/${sub}`);
  } else {
    moved = applyIndexFanout(stage, section, sub, 'hash-v1');
  }
  return { decision, moved, sections };
}

function flag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function main(args = process.argv.slice(2)) {
  if (args[0] !== 'stage') throw new Error('usage: section-tree-layout-stage.mjs stage --section NAME --locale LOCALE --pct PCT --stage DIR --sub PATH --mode filesystem|index');
  const result = await stageSectionTreeLayout({
    section: flag(args, '--section'),
    locale: flag(args, '--locale'),
    percent: Number(flag(args, '--pct')),
    threshold: parseFanoutAutoThreshold(flag(args, '--threshold', process.env.FANOUT_AUTO_THRESHOLD_PCT)),
    stage: flag(args, '--stage'),
    sub: flag(args, '--sub'),
    mode: flag(args, '--mode'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
