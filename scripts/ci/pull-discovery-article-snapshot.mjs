#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDiscoveryArticleSnapshot } from './discovery-article-snapshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function writeGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath !== 'string' || !outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

try {
  const result = await syncDiscoveryArticleSnapshot({
    indexFilePath: path.join(root, 'public/data/discovery-articles.json'),
    manifestFilePath: path.join(root, 'public/data/discovery-articles-manifest.json'),
  });
  console.log(`[discovery-snapshot] status=${result.status} changed=${result.changed} count=${result.count} commit=${result.commit}`);
  for (const failure of result.readinessFailures || []) {
    console.log(`[discovery-snapshot] waiting for ${failure.articleId}/${failure.locale}: ${failure.reason}`);
  }
  writeGithubOutput('status', result.status);
  writeGithubOutput('changed', String(result.changed));
} catch (error) {
  console.error(`[discovery-snapshot] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
}
