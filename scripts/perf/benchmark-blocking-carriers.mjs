/**
 * Reproducible benchmark for the parser-blocking performance contract.
 *
 * Run from the site checkout:
 *   node scripts/perf/benchmark-blocking-carriers.mjs
 *
 * The "before" carrier count is the contract on origin/main at the time of
 * the optimization (early-boot, PostHog, GPT and Funding Choices). The
 * "after" count is read from the current source so this command catches a
 * future regression instead of reporting a hand-entered result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const { minify } = require('html-minifier-terser');

const BEFORE_BLOCKING_CARRIERS = [
  '<script src="/assets/early-boot.js"></script>',
  '<script src="/assets/posthog-init.js"></script>',
  '<script src="/assets/gpt-loader.js"></script>',
  '<script src="/assets/job-board-fc-loader.js"></script>',
];

function read(relativePath) {
  return fs.readFileSync(path.join(siteRoot, relativePath), 'utf8');
}

function templateTag(source, constantName) {
  const line = source
    .split('\n')
    .find((candidate) => candidate.startsWith(`export const ${constantName} = \``));
  const match = line?.match(/`(<script[^`]+<\/script>)`;/);
  if (!match) throw new Error(`Cannot read ${constantName} from source`);
  return match[1];
}

function isParserBlocking(tag) {
  return /<script\b/i.test(tag) && !/\b(?:defer|async)\b/i.test(tag);
}

async function main() {
  const indexHtml = read('index.html');
  const criticalStyle = indexHtml.match(
    /<style data-clarity-unmask="true">[\s\S]*?<\/style>/,
  )?.[0];
  if (!criticalStyle) throw new Error('Root critical style block not found');

  const compactStyle = await minify(criticalStyle, { minifyCSS: true });
  const constantsSource = read('build-plugins/constants.ts');
  const jobBoardSource = read('build-plugins/jobBoardGpt.ts');
  const afterTags = [
    templateTag(constantsSource, 'EARLY_BOOT_SCRIPT'),
    templateTag(constantsSource, 'POSTHOG_SNIPPET'),
    templateTag(jobBoardSource, 'GPT_BOOTSTRAP_TAG'),
    templateTag(jobBoardSource, 'JOB_BOARD_FC_LOADER_TAG'),
  ];
  const beforeBlocking = BEFORE_BLOCKING_CARRIERS.filter(isParserBlocking).length;
  const afterBlocking = afterTags.filter(isParserBlocking).length;

  const report = {
    criticalCssBytes: {
      before: criticalStyle.length,
      after: compactStyle.length,
      saved: criticalStyle.length - compactStyle.length,
    },
    jobBoardParserBlockingCarriers: {
      before: beforeBlocking,
      after: afterBlocking,
      tags: afterTags,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  if (beforeBlocking !== 4) throw new Error(`Unexpected baseline carrier count: ${beforeBlocking}`);
  if (afterBlocking !== 1) throw new Error(`Expected one intentional parser-blocking carrier, got ${afterBlocking}`);
  if (compactStyle.length >= criticalStyle.length) throw new Error('Critical CSS did not shrink');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
