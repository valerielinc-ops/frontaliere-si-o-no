#!/usr/bin/env node
/**
 * Audit and inventory the historical blog-cover ledger without checking out
 * public/images/blog.  The hero bytes are read from Git objects, because the
 * directory is large and this audit is also used by sparse CI checkouts.
 *
 * Usage:
 *   node scripts/audit/blog-cover-ledger.mjs --write data/blog-cover-ledger.json
 *   node scripts/audit/blog-cover-ledger.mjs --json
 *
 * The first pass is deliberately conservative. It can prove an existing
 * record, an exact duplicate of a recorded cover, or a newsroom byline that
 * came through the journalist path. Everything else is marked inferred and
 * kept with an explicit no-credit record; only the bounded generated queue
 * may replace a cover, and it always keeps the article's own URL.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const ROOT = process.cwd();
const HERO_PREFIX = 'public/images/blog/';
const HERO_RX = /\.(?:webp|png|jpe?g|avif)$/i;
const THUMB_RX = /\/thumbnails\//;
const REGISTRIES = [
  { section: 'frontaliere', file: 'packages/articles/content/blog-articles-data.ts' },
  { section: 'svizzera', file: 'packages/articles/content/swiss-articles-data.ts' },
];
const RECORD_DIR = 'packages/articles/content/image-credits/blog';
const GENERATED_AT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());

function runGit(args, { input = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseArgs(argv) {
  const options = { write: null, json: false, perceptual: false, sourceMatches: 'data/blog-cover-wikimedia-matches.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--perceptual') options.perceptual = true;
    else if (arg === '--source-matches') options.sourceMatches = argv[++i] || options.sourceMatches;
    else if (arg === '--write') options.write = argv[++i] || null;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/audit/blog-cover-ledger.mjs [--write <path>] [--json] [--perceptual] [--source-matches <path>]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function coverKey(value) {
  const match = String(value || '').match(/\/images\/blog\/([^/?#]+)\.(?:webp|png|jpe?g|avif)(?:[?#].*)?$/i);
  return match ? match[1] : null;
}

function parseRegistry(source, section) {
  const articles = [];
  const starts = [...source.matchAll(/^\s*\{\s*$/gm)].map((match) => match.index);
  for (const start of starts) {
    const endMatch = /^\s*\},\s*$/gm;
    endMatch.lastIndex = start;
    const end = endMatch.exec(source)?.index;
    if (end === undefined) continue;
    const block = source.slice(start, end);
    const id = block.match(/\bid:\s*'([^']+)'/)?.[1];
    const image = block.match(/\bimage:\s*'([^']+)'/)?.[1];
    if (!id || !image) continue;
    articles.push({
      section,
      id,
      category: block.match(/\bcategory:\s*'([^']+)'/)?.[1] || null,
      date: block.match(/\bdate:\s*'([^']+)'/)?.[1] || null,
      updatedAt: block.match(/\bupdatedAt:\s*'([^']+)'/)?.[1] || null,
      image,
      authorSlug: block.match(/\bauthorSlug:\s*'([^']+)'/)?.[1] || null,
      authorName: block.match(/\bauthorName:\s*'([^']+)'/)?.[1] || null,
    });
  }
  return articles;
}

function readRegistryArticles({ fromGit = false } = {}) {
  return REGISTRIES.flatMap(({ section, file }) => {
    const source = fromGit
      ? requireGitSync(['show', `HEAD:${file}`])
      : fs.readFileSync(path.join(ROOT, file), 'utf8');
    return parseRegistry(source, section);
  });
}

function listHeroPaths() {
  const tree = requireGitSync(['ls-tree', '-r', '--name-only', 'HEAD', '--', HERO_PREFIX]);
  return tree.split(/\r?\n/).filter((name) => name.startsWith(HERO_PREFIX) && HERO_RX.test(name) && !THUMB_RX.test(name));
}

function requireGitSync(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function readRecords() {
  const dir = path.join(ROOT, RECORD_DIR);
  if (!fs.existsSync(dir)) return new Map();
  const records = new Map();
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      records.set(name.slice(0, -5), { file: `${RECORD_DIR}/${name}`, record });
    } catch (error) {
      records.set(name.slice(0, -5), { file: `${RECORD_DIR}/${name}`, record: null, parseError: String(error) });
    }
  }
  return records;
}

function baselineRecordKeys() {
  return new Set(
    requireGitSync(['ls-tree', '-r', '--name-only', 'HEAD', '--', RECORD_DIR])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => path.basename(file, '.json')),
  );
}

/** Read a set of blobs from Git without writing them to the worktree. */
async function readGitBlobs(paths, onBlob) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0);
    let current = null;
    let inputIndex = 0;
    let failed = null;
    const consume = () => {
      while (!failed) {
        if (!current) {
          const newline = pending.indexOf(10);
          if (newline < 0) return;
          const header = pending.subarray(0, newline).toString('utf8');
          pending = pending.subarray(newline + 1);
          const match = header.match(/^[0-9a-f]+ blob (\d+)$/);
          if (!match) {
            failed = new Error(`Unexpected git cat-file response: ${header}`);
            return;
          }
          current = { path: paths[inputIndex++], size: Number(match[1]) };
        }
        if (pending.length < current.size + 1) return;
        const blob = pending.subarray(0, current.size);
        const separator = pending[current.size];
        pending = pending.subarray(current.size + 1);
        if (separator !== 10) {
          failed = new Error(`Malformed git cat-file blob for ${current.path}`);
          return;
        }
        const item = current;
        current = null;
        try {
          onBlob(item.path, blob);
        } catch (error) {
          failed = error;
          return;
        }
      }
    };
    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      consume();
      if (failed) child.kill();
    });
    child.stderr.on('data', () => {});
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`git cat-file --batch exited with ${code}`));
      else if (inputIndex !== paths.length || current || pending.length > 0) reject(new Error('git cat-file returned an incomplete blob stream'));
      else resolve();
    });
    for (const item of paths) child.stdin.write(`HEAD:${item}\n`);
    child.stdin.end();
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function dHash(buffer) {
  const { data } = await sharp(buffer, { failOn: 'none' })
    .resize({ width: 9, height: 8, fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      bits += data[row * 9 + column] < data[row * 9 + column + 1] ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`);
}

function hammingDistance(left, right) {
  let value = left ^ right;
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

async function perceptualMatches(heroPaths, heroesByKey, recordsOnDisk, exactRecordKeys) {
  const hashes = new Map();
  for (const file of heroPaths) {
    const bytes = execFileSync('git', ['cat-file', 'blob', `HEAD:${file}`], { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 });
    hashes.set(file, await dHash(bytes));
  }
  const recorded = [];
  for (const [key, entry] of recordsOnDisk) {
    const heroPath = heroesByKey.get(coverKey(entry.record?.cover));
    if (heroPath && hashes.has(heroPath)) recorded.push({ key, value: hashes.get(heroPath) });
  }
  const matches = new Map();
  for (const [key, heroPath] of heroesByKey) {
    if (exactRecordKeys.has(key)) continue;
    const value = hashes.get(heroPath);
    let best = null;
    for (const candidate of recorded) {
      if (candidate.key === key) continue;
      const distance = hammingDistance(value, candidate.value);
      if (!best || distance < best.distance) best = { key: candidate.key, distance };
    }
    // A strict dHash threshold keeps visually unrelated editorial photos out
    // of the inheritance path. Exact matches are handled separately.
    if (best && best.distance <= 4) matches.set(key, best);
  }
  return matches;
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function repairPlan() {
  const plan = readJsonIfPresent(path.join(ROOT, 'data/blog-cover-replacements.json'));
  if (!plan?.items || typeof plan.items !== 'object') return {};
  // Older plans contained fallback repointings. They are historical evidence,
  // not an instruction: a new audit must never revive a cross-article target.
  return Object.fromEntries(Object.entries(plan.items).filter(([, item]) => (
    item?.mode === 'generated' && item.fromCover === item.toCover
  )));
}

function trafficIndex() {
  const entries = readJsonIfPresent(path.join(ROOT, 'public/article-trending.json'))?.entries;
  return new Map(Array.isArray(entries) ? entries.map((entry) => [entry.id, { views: entry.views || 0, lastViewed: entry.lastViewed || null }]) : []);
}

function priority(article, traffic) {
  const stats = traffic.get(article.id) || {};
  const date = Date.parse(article.updatedAt || article.date || '') || 0;
  return (Number(stats.views) || 0) * 1000000000 + (Number(stats.lastViewed) || 0) + date / 1e9;
}

function summarize(records) {
  const counts = {};
  for (const item of records.values()) counts[item.proofLevel] = (counts[item.proofLevel] || 0) + 1;
  return Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [String(level), counts[level] || 0]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registryArticles = readRegistryArticles();
  const historicalRegistryArticles = readRegistryArticles({ fromGit: true });
  const byKey = new Map();
  const historicalByKey = new Map();
  for (const article of registryArticles) {
    const key = coverKey(article.image);
    if (!key) continue;
    const list = byKey.get(key) || [];
    list.push(article);
    byKey.set(key, list);
  }
  for (const article of historicalRegistryArticles) {
    const key = coverKey(article.image);
    if (!key) continue;
    const list = historicalByKey.get(key) || [];
    list.push(article);
    historicalByKey.set(key, list);
  }

  const heroPaths = listHeroPaths();
  const heroesByKey = new Map(heroPaths.map((file) => [path.basename(file).replace(/\.[^.]+$/, ''), file]));
  const recordsOnDisk = readRecords();
  const baselineKeys = baselineRecordKeys();
  const baselineRecords = new Map([...recordsOnDisk].filter(([key]) => baselineKeys.has(key)));
  const baselineCommonsTitleToKey = new Map();
  for (const [key, entry] of baselineRecords) {
    const title = entry.record?.commons?.title;
    if (title && !baselineCommonsTitleToKey.has(title)) baselineCommonsTitleToKey.set(title, key);
  }
  const priorInventory = readJsonIfPresent(path.join(ROOT, 'data/blog-cover-ledger.json'));
  const priorCovers = priorInventory?.covers && typeof priorInventory.covers === 'object'
    ? priorInventory.covers
    : {};
  const repairs = repairPlan();
  const sourceMatches = readJsonIfPresent(path.resolve(ROOT, options.sourceMatches)) || {};
  const allBlobPaths = heroPaths;
  const hashes = new Map();
  await readGitBlobs(allBlobPaths, (file, bytes) => hashes.set(file, sha256(bytes)));
  const recordHashToKey = new Map();
  for (const [key, entry] of baselineRecords) {
    const cover = entry.record?.cover;
    const heroPath = cover ? heroesByKey.get(coverKey(cover)) : null;
    if (heroPath && hashes.has(heroPath)) recordHashToKey.set(hashes.get(heroPath), key);
  }
  const exactRecordKeys = new Set([...baselineRecords.keys()]);
  const perceptual = options.perceptual
    ? await perceptualMatches(heroPaths, heroesByKey, baselineRecords, exactRecordKeys)
    : new Map();

  const traffic = trafficIndex();
  const items = new Map();
  for (const [key, heroPath] of heroesByKey) {
    const currentReferences = (byKey.get(key) || []).slice().sort((a, b) => priority(b, traffic) - priority(a, traffic));
    const prior = priorCovers[key];
    const references = (prior?.references || historicalByKey.get(key) || currentReferences).slice().sort((a, b) => priority(b, traffic) - priority(a, traffic));
    const recordEntry = recordsOnDisk.get(key);
    const baselineRecord = baselineRecords.get(key);
    const inheritedRecord = recordEntry?.record && !baselineRecord && recordEntry.record.source === 'wikimedia-commons';
    const repair = repairs[key];
    const hash = hashes.get(heroPath);
    const exactDuplicate = !recordEntry && recordHashToKey.get(hash);
    const perceptualDuplicate = !recordEntry && !exactDuplicate ? perceptual.get(key) : null;
    const sourceMatch = !recordEntry && !exactDuplicate && !perceptualDuplicate ? sourceMatches[key] : null;
    const journalist = references.find((article) => article.authorSlug === 'samuele-valente');
    let proofLevel = 6;
    let action = references.length ? 'record-inferred' : 'retire-unpublished';
    let evidence = 'inferred';
    let recordFile = recordEntry?.record ? recordEntry.file : null;
    let inheritedFrom = null;
    let sourceProof = null;
    let reason = references.length
      ? 'Nessun record o sorgente verificabile nel checkout storico; copertina conservata con record inferred senza credito.'
      : 'Blob non più referenziato da un registro pubblicato.';

    if (repair) {
      proofLevel = Number(repair.proofLevel) || 6;
      action = 'replace-generated';
      evidence = proofLevel === 5 ? 'journalist-author' : 'inferred';
      reason = repair.reason || reason;
    } else if (prior && Number.isInteger(prior.proofLevel) && prior.proofLevel !== 1) {
      proofLevel = prior.proofLevel;
      action = prior.action || action;
      evidence = prior.evidence || evidence;
      inheritedFrom = prior.inheritedFrom || null;
      reason = prior.reason || reason;
      if (proofLevel === 2 && inheritedFrom) {
        const parentPath = heroesByKey.get(inheritedFrom);
        const parentHash = parentPath ? hashes.get(parentPath) : null;
        const exactParent = recordHashToKey.get(hash);
        const perceptualParent = perceptual.get(key);
        if (exactParent && exactParent !== key) {
          inheritedFrom = exactParent;
          evidence = 'duplicate-sha256';
          reason = 'Duplicato esatto (sha256) di una copertina già registrata; il record è ereditato con il nuovo cover path.';
        } else if (parentHash && parentHash === hash) {
          evidence = 'duplicate-sha256';
          reason = 'Duplicato esatto (sha256) di una copertina già registrata; il record è ereditato con il nuovo cover path.';
        } else if (perceptualParent?.key && perceptualParent.key !== key) {
          inheritedFrom = perceptualParent.key;
          evidence = 'duplicate-dhash';
          reason = `Duplicato percettivo stretto (dHash distanza ${perceptualParent.distance}) di una copertina già registrata; il record è ereditato.`;
        }
      }
      if (prior.sourceProof) sourceProof = prior.sourceProof;
      if (proofLevel === 6 && action === 'replace-fallback') {
        action = 'record-inferred';
        reason = 'Copertina senza prova certa; conservata con record inferred senza credito.';
      }
    } else if (baselineRecord?.record) {
      proofLevel = 1;
      action = 'keep';
      evidence = 'ledger-record';
      reason = 'Record di licenza già presente nel ledger.';
    } else if (inheritedRecord) {
      proofLevel = 2;
      action = 'copy-record';
      evidence = 'materialized-inherited-record';
      recordFile = recordEntry.file;
      const inheritedHash = hashes.get(heroPath);
      inheritedFrom = recordHashToKey.get(inheritedHash)
        || baselineCommonsTitleToKey.get(recordEntry.record.commons?.title)
        || null;
      reason = inheritedFrom
        ? 'Record materializzato da un duplicato esatto di una copertina già registrata.'
        : 'Record materializzato da una copertina già registrata con corrispondenza percettiva stretta.';
    } else if (exactDuplicate) {
      proofLevel = 2;
      action = 'copy-record';
      evidence = 'duplicate-sha256';
      inheritedFrom = exactDuplicate;
      reason = 'Duplicato esatto di una copertina già registrata; il record verrà ereditato con il nuovo cover path.';
    } else if (perceptualDuplicate) {
      proofLevel = 2;
      action = 'copy-record';
      evidence = 'duplicate-dhash';
      inheritedFrom = perceptualDuplicate.key;
      reason = `Duplicato percettivo stretto (dHash distanza ${perceptualDuplicate.distance}) di una copertina già registrata; il record verrà ereditato.`;
    } else if (sourceMatch?.source === 'wikimedia-commons' && sourceMatch?.licence?.family) {
      proofLevel = 4;
      action = 'write-record';
      evidence = 'wikimedia-search-dhash';
      recordFile = `${RECORD_DIR}/${key}.json`;
      reason = `Match dHash stretto (distanza ${sourceMatch.distance}) con ${sourceMatch.commons?.title || 'un file Wikimedia'} cercato con la query «${sourceMatch._query || 'storica'}»; licenza letta da extmetadata.`;
      sourceProof = { commons: sourceMatch.commons, author: sourceMatch.author, attribution: sourceMatch.attribution, licence: sourceMatch.licence, distance: sourceMatch.distance, query: sourceMatch._query || null };
    } else if (journalist) {
      proofLevel = 5;
      action = 'replace-generated';
      evidence = 'journalist-author';
      reason = `Copertina associata al percorso redazionale (${journalist.authorName || journalist.authorSlug}); la licenza non è dimostrabile.`;
    }

    items.set(key, {
      cover: `/images/blog/${key}${path.extname(heroPath)}`,
      hash,
      published: currentReferences.length > 0,
      historicalPublished: references.length > 0,
      references: references.map(({ section, id, category, date, updatedAt, authorSlug }) => ({ section, id, category, date, updatedAt, authorSlug })),
      ...(currentReferences.length !== references.length ? {
        currentReferences: currentReferences.map(({ section, id, category, date, updatedAt, authorSlug }) => ({ section, id, category, date, updatedAt, authorSlug })),
      } : {}),
      proofLevel,
      evidence,
      recordFile,
      inheritedFrom,
      action,
      reason,
      priority: references[0] ? Math.round(priority(references[0], traffic)) : 0,
      ...(sourceProof ? { sourceProof } : {}),
    });
  }

  // A registry can briefly outlive a byte removed from the sparse historical
  // archive (for example after a previous CDN-only cleanup). It is still a
  // published cover reference and must enter the inventory, otherwise the CI
  // gate would report a path that the audit never explains.
  for (const [key, articles] of byKey) {
    if (items.has(key)) continue;
    const references = articles.slice().sort((a, b) => priority(b, traffic) - priority(a, traffic));
    const historicalReferences = (historicalByKey.get(key) || references).slice().sort((a, b) => priority(b, traffic) - priority(a, traffic));
    items.set(key, {
      cover: references[0]?.image || `/images/blog/${key}.webp`,
      hash: null,
      published: true,
      historicalPublished: historicalReferences.length > 0,
      references: historicalReferences.map(({ section, id, category, date, updatedAt, authorSlug }) => ({ section, id, category, date, updatedAt, authorSlug })),
      ...(historicalReferences.length !== references.length ? {
        currentReferences: references.map(({ section, id, category, date, updatedAt, authorSlug }) => ({ section, id, category, date, updatedAt, authorSlug })),
      } : {}),
      proofLevel: 6,
      evidence: 'missing-historical-blob',
      recordFile: null,
      inheritedFrom: null,
      action: 'record-inferred',
      reason: 'Riferimento pubblicato senza blob storico nel checkout; conservato con record inferred senza credito.',
      priority: Math.round(priority(references[0], traffic)),
    });
  }

  const counts = summarize(items);
  const published = [...items.values()].filter((item) => item.published);
  const withRecord = published.filter((item) => item.action === 'keep' || item.action === 'copy-record').length;
  const replacements = published.filter((item) => item.action.startsWith('replace-')).length;
  const output = {
    schema: 1,
    generatedAt: GENERATED_AT,
    source: {
      gitCommit: requireGitSync(['rev-parse', 'HEAD']).trim(),
      heroFiles: heroPaths.length,
      publishedHeroFiles: published.length,
      registryArticles: registryArticles.filter((article) => coverKey(article.image)).length,
      recordsOnDisk: recordsOnDisk.size,
      duplicateMethod: 'sha256 of Git blob bytes; no public/images/blog checkout',
    },
    counts: {
      allCoversByProofLevel: counts,
      publishedCovers: published.length,
      publishedWithExistingOrInheritedRecord: withRecord,
      publishedReplacements: replacements,
    },
    covers: Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.write) {
    const destination = path.resolve(ROOT, options.write);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  }
  if (options.json) console.log(text);
  else console.log(JSON.stringify({ ...output.counts, recordsByLevel: counts }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
