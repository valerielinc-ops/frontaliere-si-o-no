import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type KnipConfig = {
  project: string[];
  entry: string[];
  ignore?: string[];
  ignoreBinaries?: string[];
  ignoreExportsUsedInFile?: boolean;
  vite?: { config: string[] };
  vitest?: { config: string[]; entry: string[] };
  playwright?: { config: string[]; entry: string[] };
  tailwind?: { config: string[] };
  postcss?: { config: string[] };
};

/**
 * knip.config.ts — dead-code detection for frontaliereticino.
 *
 * Design rules (per project owner):
 * 1. NO blanket folder exclusions. `project` is a POSITIVE whitelist of
 *    source directories, so external tooling (.gitnexus, .claude, .gstack,
 *    .superpowers, .serena, .playwright-mcp, etc.) is naturally outside scope
 *    without listing each one.
 * 2. GitHub Actions workflows are taught to knip explicitly: every script
 *    referenced by `node scripts/...`, `npx tsx scripts/...`, or
 *    `node --xxx scripts/...` inside `.github/workflows/*.yml` is registered
 *    as a knip `entry`. Workflows themselves are not JS code, so without this
 *    step a script invoked only by cron/CI would look orphan.
 * 3. Dynamic `import()` template-string targets are added as entries:
 *    - `services/locales/blog-body/**` (loaded by services/blogBodyLoader.ts)
 * 4. functions/ has its own package.json → out of scope for this knip run
 *    (it should have its own knip config if needed).
 */

const ROOT = process.cwd();

/** Extract `scripts/foo.{mjs,cjs,js,ts}` paths from every workflow YAML file. */
function extractWorkflowScriptEntries(): string[] {
  const dir = join(ROOT, '.github', 'workflows');
  const found = new Set<string>();
  const patterns = [
    /\bnode(?:\s+--[\w=\-]+)*\s+(scripts\/[\w./-]+\.(?:mjs|cjs|js|ts))\b/g,
    /\bnpx\s+tsx\s+(scripts\/[\w./-]+\.(?:ts|mjs|cjs|js))\b/g,
    /\btsx\s+(scripts\/[\w./-]+\.(?:ts|mjs|cjs|js))\b/g,
  ];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch {
    return [];
  }
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        found.add(m[1]);
      }
    }
  }
  return [...found].sort();
}

const workflowEntries = extractWorkflowScriptEntries();

const config: KnipConfig = {
  // POSITIVE whitelist — only the directories that contain frontaliereticino
  // source. Anything outside (external tooling, build artifacts, data dumps,
  // generated cron files) is simply not in scope, no exclusions needed.
  project: [
    'App.tsx',
    'index.tsx',
    'constants.ts',
    'types.ts',
    'vite.config.ts',
    'vitest.config.ts',
    'vitest.post-build.config.ts',
    'playwright.config.ts',
    'playwright.live.config.ts',
    'tailwind.config.js',
    'postcss.config.js',
    'build-plugins/**/*.{ts,tsx,js,mjs,cjs}',
    'components/**/*.{ts,tsx}',
    'hooks/**/*.{ts,tsx}',
    'scripts/**/*.{ts,mjs,cjs,js}',
    'server/**/*.{ts,js,mjs,cjs}',
    'services/**/*.{ts,tsx}',
    'tests/**/*.{ts,tsx}',
  ],

  entry: [
    // App bootstrap.
    'index.tsx',

    // Build-time roots — Vite picks them up dynamically.
    'build-plugins/**/*.{ts,js,mjs,cjs}',

    // Every CLI/cron script becomes a root. Workflow YAML is parsed below for
    // documentation/audit purposes but the blanket here guarantees no script
    // is misclassified as orphan because of cron-only invocation.
    'scripts/**/*.{ts,mjs,cjs,js}',

    // Workflow-referenced scripts (parsed from .github/workflows/*.yml).
    // This list is REDUNDANT with the blanket above but kept explicit so
    // future tightening (e.g. dropping the blanket and relying on workflow
    // refs) is a one-line change. It also produces a useful diff when a
    // workflow adds a new script entry.
    ...workflowEntries,

    // Express-style runtime endpoints deployed independently.
    'server/**/*.{js,mjs,cjs,ts}',

    // Dynamic-import roots (template-string targets knip cannot resolve).
    'services/locales/blog-body/**/*.ts',
  ],

  ignore: [
    'vite-env.d.ts',
  ],

  ignoreBinaries: [
    'gh',
    'firebase',
    'playwright',
    'gitnexus',
    'tsx',
  ],

  ignoreExportsUsedInFile: true,

  // Tool-aware plugins — knip uses these to discover additional entry points
  // from each tool's own config (e.g. test files from vitest.config).
  vite: { config: ['vite.config.ts'] },
  vitest: {
    config: ['vitest.config.ts', 'vitest.post-build.config.ts'],
    entry: ['tests/setup.tsx', 'tests/**/*.{test,spec}.{ts,tsx}'],
  },
  playwright: {
    config: ['playwright.config.ts', 'playwright.live.config.ts'],
    entry: ['tests/e2e/**/*.spec.ts'],
  },
  tailwind: { config: ['tailwind.config.js'] },
  postcss: { config: ['postcss.config.js'] },
};

export default config;
