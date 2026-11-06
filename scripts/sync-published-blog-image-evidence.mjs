#!/usr/bin/env node
/** Pull the manifest-pinned generated blog-image evidence used by the OG gate. */

import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ARTICLES_API_BASE } from './lib/articles-api-base.mjs';
import { validatePublishedBlogImageEvidence } from './lib/published-blog-image-evidence.mjs';

const BLOG_CREDITS_ARTIFACT = 'data/image-credits-blog.json';
const SNAPSHOT_PATH = path.join('data', 'og-published-blog-generated-image-evidence.json');

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

export async function syncPublishedBlogImageEvidence({
  root = process.cwd(),
  apiBase = ARTICLES_API_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const base = String(apiBase).replace(/\/+$/, '');
  const manifestText = await fetchText(fetchImpl, `${base}/manifest.json`);
  const manifest = parseJson(manifestText, 'article API manifest');
  if (!isRecord(manifest)
    || !/^[0-9a-f]{40}$/.test(String(manifest.commit || ''))
    || !isRecord(manifest.files)) {
    throw new Error('article API manifest is missing a valid commit or files map');
  }

  const expectedBytes = manifest.files[BLOG_CREDITS_ARTIFACT];
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`article API manifest is missing a valid byte count for ${BLOG_CREDITS_ARTIFACT}`);
  }

  const creditsText = await fetchText(fetchImpl, `${base}/${BLOG_CREDITS_ARTIFACT}`);
  const receivedBytes = Buffer.byteLength(creditsText, 'utf8');
  if (receivedBytes !== expectedBytes) {
    throw new Error(`${BLOG_CREDITS_ARTIFACT} byte count ${receivedBytes} differs from manifest ${expectedBytes}`);
  }

  const credits = parseJson(creditsText, BLOG_CREDITS_ARTIFACT);
  if (!isRecord(credits)
    || credits.schema !== 1
    || credits.section !== 'blog'
    || credits.commit !== manifest.commit
    || !isRecord(credits.generated)) {
    throw new Error(`${BLOG_CREDITS_ARTIFACT} does not match the manifest-pinned blog image evidence contract`);
  }

  for (const [imageUrl, record] of Object.entries(credits.generated)) {
    const validation = validatePublishedBlogImageEvidence(imageUrl, record);
    if (!validation.valid) {
      throw new Error(`${BLOG_CREDITS_ARTIFACT} has invalid evidence for ${imageUrl}: ${validation.errors.join('; ')}`);
    }
  }

  const finalManifest = parseJson(
    await fetchText(fetchImpl, `${base}/manifest.json`),
    'article API manifest after image evidence fetch',
  );
  if (!isRecord(finalManifest) || finalManifest.commit !== manifest.commit) {
    throw new Error(`article API manifest changed during fetch (${manifest.commit} → ${finalManifest?.commit || 'invalid'})`);
  }
  const finalExpectedBytes = finalManifest.files?.[BLOG_CREDITS_ARTIFACT];
  if (!isRecord(finalManifest.files) || finalExpectedBytes !== expectedBytes) {
    throw new Error(`${BLOG_CREDITS_ARTIFACT} manifest byte count changed during fetch (${expectedBytes} → ${finalExpectedBytes ?? 'missing'})`);
  }

  const snapshotPath = path.join(root, SNAPSHOT_PATH);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify({
    schema: 1,
    commit: manifest.commit,
    generated: credits.generated,
  }, null, 2)}\n`, 'utf8');

  return {
    commit: manifest.commit,
    recordCount: Object.keys(credits.generated).length,
    snapshotPath,
  };
}

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})()) {
  syncPublishedBlogImageEvidence()
    .then(({ commit, recordCount }) => {
      console.log(`published blog image evidence: ${recordCount} records from ${commit}`);
    })
    .catch((error) => {
      console.error(`::error::${error.message}`);
      process.exitCode = 1;
    });
}
