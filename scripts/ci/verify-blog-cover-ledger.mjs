#!/usr/bin/env node
/**
 * CI gate: every currently published blog hero must resolve to a valid record.
 * An inferred historical cover is valid only when the ledger and unified
 * index carry its explicit no-credit record. The generation queue is status
 * metadata, never a licence exemption.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { coverKey, validateImageCreditRecord } from '../../packages/articles/engine/shared/imageCredits.mjs';
import { validateGeneratedImageRegistry } from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';
import { isExplicitInferredCover } from '../lib/blog-cover-decisions.mjs';
import { readPublishedBlogCoverBytes } from '../lib/published-blog-cover-bytes.mjs';
import {
  isPublishedDeterministicCardRecord,
  validatePublishedBlogImageEvidence,
} from '../lib/published-blog-image-evidence.mjs';
import {
  PUBLISHED_CANTON_ARTICLES_ARTIFACT,
  PUBLISHED_CANTON_ARTICLES_PATH,
  readPublishedCantonArticlesArtifact,
} from '../lib/published-canton-articles.mjs';

const ROOT = process.cwd();
const REGISTRIES = [
  'packages/articles/content/blog-articles-data.ts',
  'packages/articles/content/swiss-articles-data.ts',
];
const RECORD_DIR = path.join(ROOT, 'packages/articles/content/image-credits/blog');
const IMAGE_CREDITS_INDEX = path.join(ROOT, 'data/image-credits-blog.json');
const GENERATED_EVIDENCE_SNAPSHOT = path.join(ROOT, 'data/published-blog-generated-image-evidence.json');
const BASELINE_RELATIVE_PATH = 'data/blog-cover-corpus-baseline.json';
const BASELINE_REF_ENV = 'BLOG_COVER_LEDGER_BASE_REF';

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseCoverImages(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const covers = new Map();
  const imageRx = /\bimage:\s*'([^']+)'/g;
  let match;
  while ((match = imageRx.exec(source))) {
    const key = coverKey(match[1]);
    if (key) covers.set(key, match[1]);
  }
  return covers;
}

function recordForKey(key) {
  const file = path.join(RECORD_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readBaselineAtRef(ref, { required = false } = {}) {
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { cwd: ROOT, stdio: 'ignore' },
    );
  } catch {
    return {
      baseline: null,
      refResolved: false,
      error: required ? `${BASELINE_RELATIVE_PATH}: comparison baseline ref ${JSON.stringify(ref)} is not resolvable` : null,
    };
  }

  try {
    execFileSync(
      'git',
      ['cat-file', '-e', `${ref}:${BASELINE_RELATIVE_PATH}`],
      { cwd: ROOT, stdio: 'ignore' },
    );
  } catch (error) {
    if (error?.status === 128) {
      return { baseline: null, refResolved: true, error: null };
    }
    return {
      baseline: null,
      refResolved: true,
      error: `${BASELINE_RELATIVE_PATH}: could not inspect baseline at ${JSON.stringify(ref)}`,
    };
  }

  let raw;
  try {
    raw = execFileSync(
      'git',
      ['show', `${ref}:${BASELINE_RELATIVE_PATH}`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return {
      baseline: null,
      refResolved: true,
      error: `${BASELINE_RELATIVE_PATH}: could not read baseline at ${JSON.stringify(ref)}`,
    };
  }
  try {
    return { baseline: JSON.parse(raw), refResolved: true, error: null };
  } catch {
    return {
      baseline: null,
      refResolved: true,
      error: `${BASELINE_RELATIVE_PATH}: baseline at ${JSON.stringify(ref)} is not valid JSON`,
    };
  }
}

function comparisonBaselineRef() {
  // `origin/main` is a moving ref. On a push to main, a concurrent commit can
  // advance it while this run is still checking the older event SHA, turning a
  // valid pre-bootstrap baseline into a false "removal". Callers that know
  // their immutable event/base ref provide it explicitly; local invocations
  // retain the historical origin/main fallback.
  return String(process.env[BASELINE_REF_ENV] || '').trim() || 'origin/main';
}

function readCantonArtifactDeclaration(baseline) {
  const publishedArtifacts = baseline?.publishedArtifacts;
  if (publishedArtifacts === undefined) return { declared: false, value: null, error: null };
  if (!publishedArtifacts || typeof publishedArtifacts !== 'object' || Array.isArray(publishedArtifacts)) {
    return {
      declared: true,
      value: null,
      error: 'blog-cover-corpus-baseline.json: publishedArtifacts must be an object',
    };
  }
  if (!Object.hasOwn(publishedArtifacts, 'cantonArticles')) {
    return { declared: false, value: null, error: null };
  }
  return { declared: true, value: publishedArtifacts.cantonArticles, error: null };
}

function isValidCantonArtifactDeclaration(declaration) {
  return declaration
    && typeof declaration === 'object'
    && !Array.isArray(declaration)
    && declaration.path === PUBLISHED_CANTON_ARTICLES_PATH
    && declaration.present === true
    && /^[0-9a-f]{64}$/.test(String(declaration.sha256 || ''))
    && Number.isSafeInteger(declaration.articleCount)
    && declaration.articleCount >= 0;
}

function main() {
  const inventory = readJson(path.join(ROOT, 'data/blog-cover-ledger.json'));
  const replacements = readJson(path.join(ROOT, 'data/blog-cover-replacements.json'));
  const imageCreditsIndex = readJson(IMAGE_CREDITS_INDEX);
  const generatedRegistry = readJson(path.join(ROOT, 'data/blog-generated-image-registry.json'));
  const generatedEvidenceExists = fs.existsSync(GENERATED_EVIDENCE_SNAPSHOT);
  const generatedEvidence = generatedEvidenceExists ? readJson(GENERATED_EVIDENCE_SNAPSHOT) : null;
  const corpusBaseline = readJson(path.join(ROOT, 'data/blog-cover-corpus-baseline.json'));
  if (!inventory || !replacements || !imageCreditsIndex) {
    throw new Error('blog-cover-ledger.json, blog-cover-replacements.json and image-credits-blog.json are required');
  }

  const errors = [];
  const cantonDeclaration = readCantonArtifactDeclaration(corpusBaseline);
  const configuredComparisonRef = String(process.env[BASELINE_REF_ENV] || '').trim();
  const comparisonRef = configuredComparisonRef || comparisonBaselineRef();
  const comparisonResult = readBaselineAtRef(comparisonRef, { required: Boolean(configuredComparisonRef) });
  const comparisonDeclaration = readCantonArtifactDeclaration(comparisonResult.baseline);
  if (comparisonResult.error) errors.push(comparisonResult.error);
  if (cantonDeclaration.error) errors.push(cantonDeclaration.error);
  if (comparisonDeclaration.declared && !cantonDeclaration.declared) {
    errors.push(
      `${BASELINE_RELATIVE_PATH}: declaration for ${PUBLISHED_CANTON_ARTICLES_PATH} cannot be removed; `
      + `comparison baseline ${comparisonRef} already declares the artifact`,
    );
  }

  let cantonArtifact = null;
  try {
    cantonArtifact = readPublishedCantonArticlesArtifact(ROOT, {
      optional: true,
      expectedCommit: corpusBaseline?.sourceCommit || generatedEvidence?.commit || null,
    });
  } catch (error) {
    errors.push(`${PUBLISHED_CANTON_ARTICLES_PATH}: ${error.message}`);
  }
  if (cantonDeclaration.declared) {
    if (!isValidCantonArtifactDeclaration(cantonDeclaration.value)) {
      errors.push(
        `${BASELINE_RELATIVE_PATH}: publishedArtifacts.cantonArticles must contain `
        + `path=${PUBLISHED_CANTON_ARTICLES_PATH}, present=true, a 64-character sha256 and a non-negative articleCount`,
      );
    } else if (!cantonArtifact) {
      errors.push(
        `${PUBLISHED_CANTON_ARTICLES_PATH}: baseline declares the artifact, but the file is missing`,
      );
    } else {
      const actualSha256 = crypto.createHash('sha256').update(cantonArtifact.raw).digest('hex');
      if (actualSha256 !== cantonDeclaration.value.sha256) {
        errors.push(
          `${PUBLISHED_CANTON_ARTICLES_PATH}: sha256 differs from the baseline `
          + `(expected ${cantonDeclaration.value.sha256}, received ${actualSha256})`,
        );
      }
      if (cantonArtifact.articleCount !== cantonDeclaration.value.articleCount) {
        errors.push(
          `${PUBLISHED_CANTON_ARTICLES_PATH}: article count differs from the baseline `
          + `(expected ${cantonDeclaration.value.articleCount}, received ${cantonArtifact.articleCount})`,
        );
      }
    }
  } else if (!comparisonResult.error && !comparisonDeclaration.declared && !cantonArtifact) {
    console.log(
      `${PUBLISHED_CANTON_ARTICLES_ARTIFACT}: not yet declared by the baseline (pre-bootstrap)`,
    );
  }

  const generatedValidation = generatedRegistry
    ? validateGeneratedImageRegistry(generatedRegistry, { scope: 'article-hero' })
    : { valid: true, errors: [] };
  if (!generatedValidation.valid) throw new Error(`generated registry invalid: ${generatedValidation.errors.join('; ')}`);
  const generatedByUrl = new Map((generatedRegistry?.assets || []).map((record) => [record.imageUrl, record]));
  const currentCoverImages = new Map();
  for (const file of REGISTRIES) {
    for (const [key, image] of parseCoverImages(file)) currentCoverImages.set(key, image);
  }
  for (const article of cantonArtifact?.articles || []) {
    const key = coverKey(article.image);
    if (key) currentCoverImages.set(key, article.image);
  }
  if (generatedEvidenceExists) {
    if (!generatedEvidence || generatedEvidence.schema !== 1
      || !/^[0-9a-f]{40}$/.test(String(generatedEvidence.commit || ''))
      || !generatedEvidence.generated || typeof generatedEvidence.generated !== 'object'
      || Array.isArray(generatedEvidence.generated)) {
      errors.push('published generated-image evidence snapshot is invalid');
    } else {
      if (corpusBaseline?.sourceCommit && generatedEvidence.commit !== corpusBaseline.sourceCommit) {
        errors.push('published generated-image evidence commit differs from the corpus baseline');
      }
      for (const [imageUrl, record] of Object.entries(generatedEvidence.generated)) {
        const validation = validatePublishedBlogImageEvidence(imageUrl, record);
        if (!validation.valid) {
          errors.push(`${imageUrl}: invalid published generated-image evidence${validation.errors.length
            ? `: ${validation.errors.join('; ')}`
            : ''}`);
          continue;
        }
        // `place` is valid reader-facing evidence for the static fallback, but
        // it is not a site-owned article-hero registry entry to reconcile.
        if (record.scope !== 'article-hero') continue;
        const key = coverKey(imageUrl);
        if (!key || currentCoverImages.get(key) !== imageUrl) continue;
        const bytes = readPublishedBlogCoverBytes(ROOT, imageUrl);
        if (!bytes) {
          errors.push(`${imageUrl}: published evidence has no corresponding site cover bytes`);
        } else {
          const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
          if (record.sha256 !== actualSha256 || record.bytes !== bytes.length) {
            errors.push(`${imageUrl}: published registry sha256/bytes do not match the site cover bytes`);
          }
        }
        const existing = generatedByUrl.get(imageUrl);
        if (isPublishedDeterministicCardRecord(record)) {
          if (existing) {
            errors.push(`${imageUrl}: deterministic-card evidence must not remain in the site generated-provider registry`);
          }
          continue;
        }
        if (existing && existing.sha256 !== record.sha256) {
          errors.push(`${imageUrl}: published and site generated registries disagree on sha256`);
          continue;
        }
        generatedByUrl.set(imageUrl, record);
      }
    }
  }
  const currentKeys = new Set(currentCoverImages.keys());
  const counts = { currentUnique: currentKeys.size, withRecord: 0, generated: 0, wikimedia: 0, inferred: 0 };
  for (const key of [...currentKeys].sort()) {
    const inventoryItem = inventory.covers[key];
    if (!inventoryItem) {
      errors.push(`${key}: missing from data/blog-cover-ledger.json`);
      continue;
    }
    const record = recordForKey(key);
    if (!record) {
      if (isExplicitInferredCover(inventoryItem, imageCreditsIndex.covers?.[key])) {
        counts.inferred += 1;
        continue;
      }
      errors.push(`${key}: published cover has no image-credit record`);
      continue;
    }
    const validation = validateImageCreditRecord(record);
    if (!validation.valid) {
      errors.push(`${key}: ${validation.errors.join('; ')}`);
      continue;
    }
    if (coverKey(record.cover) !== key) {
      errors.push(`${key}: record cover does not match key`);
      continue;
    }
    if (record.source === 'inferred') {
      counts.inferred += 1;
      continue;
    }
    if (record.source === 'generated-provider') {
      counts.generated += 1;
      const bytes = readPublishedBlogCoverBytes(ROOT, record.cover);
      if (!bytes) {
        errors.push(`${key}: generated record has no corresponding site cover bytes`);
        continue;
      }
      const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (record.generated.sha256 !== actualSha256 || record.generated.bytes !== bytes.length) {
        errors.push(`${key}: generated record sha256/bytes do not match the site cover bytes`);
        continue;
      }
      const generated = generatedByUrl.get(record.generated.imageUrl);
      if (!generated || generated.sha256 !== record.generated.sha256) {
        errors.push(`${key}: generated record is absent or differs from data/blog-generated-image-registry.json`);
        continue;
      }
    } else {
      counts.wikimedia += 1;
    }
    counts.withRecord += 1;
  }

  for (const [key, item] of Object.entries(replacements.items || {})) {
    if (item.mode !== 'generated') errors.push(`${key}: replacement mode must be generated; fallback repointing is forbidden`);
    if (item.mode === 'generated' && item.fromCover !== item.toCover) {
      errors.push(`${key}: generated replacement must keep the article's own cover URL`);
    }
    if (item.mode === 'generated' && item.status === 'generated' && !recordForKey(key)) {
      errors.push(`${key}: generated replacement is marked complete without a credit record`);
    }
  }
  if (errors.length) {
    for (const error of errors.slice(0, 80)) console.error(`::error::${error}`);
    if (errors.length > 80) console.error(`::error::and ${errors.length - 80} more ledger errors`);
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ ...counts, errors: errors.length }, null, 2));
}

main();
