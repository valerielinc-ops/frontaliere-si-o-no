// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isNamedPlugin(plugin: unknown): plugin is { name: string } {
  return Boolean(plugin)
    && typeof plugin === 'object'
    && 'name' in plugin
    && typeof (plugin as { name?: unknown }).name === 'string';
}

function pluginNames(): string[] {
  // Force the full plugin list — agent sessions inherit FAST_BUILD=1 which
  // would otherwise skip every SEO plugin under test here.
  const prev = process.env.FAST_BUILD;
  delete process.env.FAST_BUILD;
  try {
    const resolved = typeof viteConfig === 'function'
      ? viteConfig({ command: 'build', mode: 'production' })
      : viteConfig;
    const plugins = Array.isArray(resolved.plugins) ? resolved.plugins.flat() : [];
    return plugins.filter(isNamedPlugin).map((plugin) => plugin.name);
  } finally {
    if (prev !== undefined) process.env.FAST_BUILD = prev;
  }
}

/**
 * Every plugin name declared in a build-plugins/*.ts source, keyed by file.
 * Matches the `name: 'x', apply: 'build'` head of a returned Vite plugin —
 * the shape every SSG plugin in this repo uses.
 */
function declaredPluginNames(source: string): string[] {
  return [...source.matchAll(/name:\s*'([a-z0-9][a-z0-9-]*)'\s*,\s*\r?\n\s*apply:\s*'build'/g)]
    .map((m) => m[1]);
}

/** `resolveEmployerProfilesFlushed` → `employerProfilesFlushed`. */
function signalOfResolver(resolver: string): string {
  const rest = resolver.replace(/^resolve/, '');
  return rest.charAt(0).toLowerCase() + rest.slice(1);
}

interface SignalEdge {
  readonly signal: string;
  readonly producer: string;
  readonly consumer: string;
}

/**
 * Derive the producer→consumer edges of `build-plugins/shared/buildSignals.ts`
 * straight from the sources, instead of hand-listing them below.
 *
 * The hand-written list is what failed in #5330: PR #5273 added
 * `await employerProfilesFlushed` inside jobsSeoPagesPlugin without adding the
 * matching `expectPluginAfter`, and the producer was registered ~60 entries
 * LATER in vite.config.ts. With `SEQUENTIAL_PROFILE=1` (deploy.yml) every
 * closeBundle is `sequential: true`, so the producer could not run until the
 * consumer returned: the await never settled, the event loop drained, node
 * exited 0 and `vite build` "succeeded" having emitted nothing after
 * jobs-seo-pages — including the six IT landings validate-critical-dist-pages
 * guards. Deriving the edges means the next such `await` is covered the moment
 * it is written.
 */
function signalEdges(): SignalEdge[] {
  const pluginsDir = path.resolve(__dirname, '../build-plugins');
  const producers = new Map<string, string>();
  const consumers = new Map<string, string[]>();

  for (const file of fs.readdirSync(pluginsDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const source = fs.readFileSync(path.join(pluginsDir, file), 'utf-8');
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/shared\/buildSignals'/g)];
    if (imports.length === 0) continue;

    const names = declaredPluginNames(source);
    if (names.length === 0) continue; // not a registered SSG plugin (scratch file, helper)

    const identifiers = imports
      .flatMap((m) => m[1].split(','))
      .map((raw) => raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);

    for (const id of identifiers) {
      if (/^resolve[A-Z].*Flushed$/.test(id)) {
        for (const name of names) producers.set(signalOfResolver(id), name);
      } else if (/Flushed$/.test(id)) {
        for (const name of names) consumers.set(id, [...(consumers.get(id) ?? []), name]);
      }
    }
  }

  const edges: SignalEdge[] = [];
  for (const [signal, consumerNames] of consumers) {
    const producer = producers.get(signal);
    if (!producer) continue;
    for (const consumer of consumerNames) {
      if (consumer !== producer) edges.push({ signal, producer, consumer });
    }
  }
  return edges.sort((a, b) => `${a.signal}${a.consumer}`.localeCompare(`${b.signal}${b.consumer}`));
}

function expectPluginAfter(names: string[], consumer: string, producer: string): void {
  const producerIdx = names.indexOf(producer);
  const consumerIdx = names.indexOf(consumer);

  expect(producerIdx, `${producer} must be registered`).toBeGreaterThanOrEqual(0);
  expect(consumerIdx, `${consumer} must be registered`).toBeGreaterThanOrEqual(0);
  expect(consumerIdx, `${consumer} waits for ${producer}; it must run later in sequential closeBundle`).toBeGreaterThan(producerIdx);
}

describe('build plugin ordering', () => {
  it('keeps signal consumers after their producers in sequential closeBundle builds', () => {
    const names = pluginNames();

    expectPluginAfter(names, 'border-municipality-pages', 'static-pages');
    expectPluginAfter(names, 'profession-landings-links', 'static-pages');
    expectPluginAfter(names, 'profession-landings-links', 'profession-landings');
    expectPluginAfter(names, 'salary-hub-index-link', 'static-pages');
    expectPluginAfter(names, 'salary-hub-index-link', 'salary-hub-seo');
    expectPluginAfter(names, 'related-search-clusters', 'jobs-seo-pages');
    expectPluginAfter(names, 'post-walk-coordinator', 'related-search-clusters');
    // professionCityLandings' below-floor bridge (renderBelowFloorBridge)
    // targets the per-(canton,city,locale) hub that jobs-seo-pages emits
    // unconditionally (issue #4330 item 1) — lock the order so a future
    // reorder can't silently reintroduce the race this guard was added for.
    expectPluginAfter(names, 'profession-city-landings', 'jobs-seo-pages');
    // #5330 — jobs-seo-pages `await employerProfilesFlushed` (#5273) to link
    // every job ad at its evergreen /aziende/<slug>/ hub. The producer was
    // registered AFTER it: under sequential closeBundle that await can never
    // settle, and the build exits 0 with the rest of the chain unrun.
    expectPluginAfter(names, 'jobs-seo-pages', 'employer-profile-pages');
  });

  it('derives every buildSignals edge from source and keeps each consumer after its producer', () => {
    const names = pluginNames();
    const edges = signalEdges();

    // Guard the derivation itself: a regex that stops matching would turn this
    // test into a silent no-op, which is exactly the failure mode it exists to
    // prevent. These two edges are load-bearing and must always be found.
    expect(
      edges.map((e) => `${e.producer} -> ${e.consumer}`),
      'signal-edge derivation regressed (no edges found?)',
    ).toEqual(expect.arrayContaining([
      'employer-profile-pages -> jobs-seo-pages',
      'static-pages -> border-municipality-pages',
    ]));
    expect(edges.length, 'signal-edge derivation regressed').toBeGreaterThanOrEqual(15);

    const violations = edges
      .filter((e) => names.includes(e.producer) && names.includes(e.consumer))
      .filter((e) => names.indexOf(e.consumer) < names.indexOf(e.producer))
      .map((e) => `${e.consumer} awaits ${e.signal} but is registered BEFORE ${e.producer}`);

    expect(
      violations,
      'a closeBundle signal can only travel forward through the vite.config.ts plugin array: '
      + 'deploy.yml builds with SEQUENTIAL_PROFILE=1, so a producer registered after its consumer '
      + 'deadlocks the build into a silent exit 0 (#5330)',
    ).toEqual([]);
  });

  it('keeps deploy output guards before artifact upload', () => {
    const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/deploy.yml'), 'utf-8');
    const criticalGuardIdx = workflow.indexOf('node scripts/validate-critical-dist-pages.mjs');
    const profileGuardIdx = workflow.indexOf('node scripts/validate-build-profile-markers.mjs /tmp/build.log');
    const uploadIdx = workflow.indexOf('Upload Pages artifact');

    expect(criticalGuardIdx).toBeGreaterThanOrEqual(0);
    expect(profileGuardIdx).toBeGreaterThan(criticalGuardIdx);
    expect(uploadIdx).toBeGreaterThan(profileGuardIdx);
  });
});
