#!/usr/bin/env node
/**
 * Whole-archive step of the isolated commit path (git-commit-data.sh).
 *
 * The expired archive of a crawler is ONE logical array stored in several files
 * (scripts/lib/expired-slice-store.mjs). The commit path merges file by file,
 * which is exact while every row stays in its file. Two cases break it:
 *
 *   1. a row changed file on one side (spill, rebalance, split) while both
 *      sides changed the archive: the per-file merge reads the move as a
 *      deletion from the old file ("remote's deletion wins" / "local deleted"),
 *      so the other writer's edit of that row, routes included, is dropped;
 *   2. the merged file is above the push-safety ceiling: two writers can each
 *      stay below it and their union cross it, and past 100 MB GitHub refuses
 *      the push of the whole batch on every retry.
 *
 * For a key in either case the shell merges the LOGICAL arrays with the same
 * 3-way engine and `apply` re-places the result with the store, keeping every
 * row in the file origin/main has it in.
 *
 *   plan  --base SHA --remote SHA --index FILE --locals TSV --work DIR
 *         prints one affected key per line and writes
 *         <work>/<key>/{base,remote,local}.json
 *   apply --key KEY --remote SHA --index FILE --work DIR
 *         reads <work>/<key>/merged.json and stages the files in the index
 *
 * TSV rows: `<repo path>\t<blob id | absent>` for the paths this writer
 * commits. Every other path is, for this writer, unchanged since the base.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeExpiredSliceRows, EXPIRED_SLICE_SHARD_TARGET_BYTES } from './expired-slice-store.mjs';
import { expiredSliceFileName, expiredSliceKeyOf, parseExpiredSliceFileName } from './expired-slice-names.mjs';
import { localeRouteKeys } from './expired-jobs-archive.mjs';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { jobSliceCeilingBytes } from './main-push-guard.mjs';
import { isInvokedDirectly } from './is-invoked-directly.mjs';

const EXPIRED_DIR = 'data/jobs/expired/by-crawler';
const MAX_BUFFER = 512 * 1024 * 1024;

function git(args, { env, input, encoding = 'utf8' } = {}) {
  return execFileSync('git', args, {
    encoding,
    input,
    maxBuffer: MAX_BUFFER,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** `Map<file name, blob id>` of the expired directory of a commit. */
function commitView(sha) {
  const view = new Map();
  for (const record of git(['ls-tree', '-z', sha, '--', `${EXPIRED_DIR}/`]).split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/su.exec(record);
    if (match) view.set(path.posix.basename(match[2]), match[1]);
  }
  return view;
}

function indexView(indexFile) {
  const view = new Map();
  const listing = git(['ls-files', '-s', '-z', '--', `${EXPIRED_DIR}/`], { env: { GIT_INDEX_FILE: indexFile } });
  for (const record of listing.split('\0')) {
    const match = /^\d+ ([0-9a-f]+) \d\t(.+)$/su.exec(record);
    if (match) view.set(path.posix.basename(match[2]), match[1]);
  }
  return view;
}

/** The files of `key` in a view, in index order. */
function keyFiles(view, key) {
  return [...view.keys()]
    .filter((name) => expiredSliceKeyOf(name) === key)
    .sort((a, b) => parseExpiredSliceFileName(a).index - parseExpiredSliceFileName(b).index);
}

function blobRows(blob, label) {
  const rows = JSON.parse(git(['cat-file', 'blob', blob]));
  if (!Array.isArray(rows)) throw new Error(`expired slice ${label} is not an array`);
  return rows;
}

function loadShards(view, key) {
  return keyFiles(view, key).map((name) => ({
    name,
    index: parseExpiredSliceFileName(name).index,
    rows: blobRows(view.get(name), name),
  }));
}

const flatten = (shards) => shards.flatMap((shard) => shard.rows);

function placement(shards) {
  const bySlug = new Map();
  for (const shard of shards) {
    for (const row of shard.rows) {
      if (row?.slug && !bySlug.has(row.slug)) bySlug.set(row.slug, shard.name);
    }
  }
  return bySlug;
}

function placementsDisagree(a, b) {
  for (const [slug, file] of a) {
    if (b.has(slug) && b.get(slug) !== file) return true;
  }
  return false;
}

function sameKeyBlobs(a, b, key) {
  const names = keyFiles(a, key);
  return names.length === keyFiles(b, key).length && names.every((name) => a.get(name) === b.get(name));
}

export function plan({ base, remote, index, locals, work }) {
  const baseView = commitView(base);
  const remoteView = commitView(remote);
  const localView = new Map(baseView);
  const keys = new Set();
  for (const line of fs.readFileSync(locals, 'utf8').split('\n')) {
    if (!line) continue;
    const [filePath, blob] = line.split('\t');
    if (path.posix.dirname(filePath) !== EXPIRED_DIR) continue;
    const name = path.posix.basename(filePath);
    const key = expiredSliceKeyOf(name);
    if (!key) continue;
    keys.add(key);
    if (blob === 'absent') localView.delete(name);
    else localView.set(name, blob);
  }

  const staged = indexView(index);
  const ceiling = jobSliceCeilingBytes();
  const affected = [];
  for (const key of [...keys].sort()) {
    const stagedFiles = keyFiles(staged, key);
    // Only a blob this commit produced can be oversize "because of us": a file
    // identical to origin/main is not rewritten here.
    const oversize = stagedFiles.some((name) => staged.get(name) !== remoteView.get(name)
      && Number(git(['cat-file', '-s', staged.get(name)])) > ceiling);

    const names = new Set([
      ...keyFiles(baseView, key), ...keyFiles(localView, key), ...keyFiles(remoteView, key),
    ]);
    const concurrent = names.size > 1
      && !sameKeyBlobs(localView, baseView, key)
      && !sameKeyBlobs(remoteView, baseView, key)
      && !sameKeyBlobs(localView, remoteView, key);
    if (!oversize && !concurrent) continue;

    const shards = {
      base: loadShards(baseView, key),
      remote: loadShards(remoteView, key),
      local: loadShards(localView, key),
    };
    if (!oversize) {
      const where = {
        base: placement(shards.base),
        remote: placement(shards.remote),
        local: placement(shards.local),
      };
      if (!placementsDisagree(where.base, where.local)
        && !placementsDisagree(where.base, where.remote)
        && !placementsDisagree(where.local, where.remote)) continue;
    }

    const keyWork = path.join(work, key);
    fs.mkdirSync(keyWork, { recursive: true });
    for (const [side, list] of Object.entries(shards)) {
      writeJsonAtomic(path.join(keyWork, `${side}.json`), flatten(list), { streamArray: true });
    }
    affected.push(key);
  }
  return affected;
}

function routesOf(rows) {
  const routes = new Set();
  for (const row of rows) {
    for (const route of localeRouteKeys(row)) routes.add(route);
  }
  return routes;
}

/** Routes the merge must keep: served by either side, minus what a side removed on purpose. */
export function requiredRoutes(baseRows, remoteRows, localRows) {
  const base = routesOf(baseRows);
  const remote = routesOf(remoteRows);
  const local = routesOf(localRows);
  return [...new Set([...remote, ...local])]
    .filter((route) => !base.has(route) || (remote.has(route) && local.has(route)));
}

export function apply({ key, remote, index, work }) {
  const keyWork = path.join(work, key);
  const read = (side) => JSON.parse(fs.readFileSync(path.join(keyWork, `${side}.json`), 'utf8'));
  const merged = read('merged');
  const served = routesOf(merged);
  const lost = requiredRoutes(read('base'), read('remote'), read('local'))
    .filter((route) => !served.has(route));
  if (lost.length > 0) {
    throw new Error(`whole-archive merge of ${key} would lose ${lost.length} route(s): ${lost.slice(0, 5).join(', ')}`);
  }

  const remoteView = commitView(remote);
  const remoteShards = loadShards(remoteView, key);
  const placeDir = path.join(keyWork, 'place');
  fs.rmSync(placeDir, { recursive: true, force: true });
  fs.mkdirSync(placeDir, { recursive: true });
  for (const shard of remoteShards) {
    fs.writeFileSync(path.join(placeDir, shard.name), git(['cat-file', 'blob', remoteView.get(shard.name)], { encoding: 'buffer' }));
  }
  const ceiling = jobSliceCeilingBytes();
  writeExpiredSliceRows(key, merged, {
    dir: placeDir,
    existing: remoteShards,
    hardCeilingBytes: ceiling,
    shardTargetBytes: Math.min(EXPIRED_SLICE_SHARD_TARGET_BYTES, Math.floor(ceiling / 2)),
  });

  const env = { GIT_INDEX_FILE: index };
  const placed = fs.readdirSync(placeDir).filter((name) => expiredSliceKeyOf(name) === key);
  for (const name of keyFiles(indexView(index), key)) {
    if (!placed.includes(name)) git(['update-index', '--force-remove', '--', `${EXPIRED_DIR}/${name}`], { env });
  }
  let placedRows = 0;
  for (const name of placed) {
    const file = path.join(placeDir, name);
    placedRows += JSON.parse(fs.readFileSync(file, 'utf8')).length;
    const blob = git(['hash-object', '-w', '--', file]).trim();
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${EXPIRED_DIR}/${name}`], { env });
  }
  if (placedRows !== merged.length) {
    throw new Error(`whole-archive merge of ${key} placed ${placedRows} of ${merged.length} rows`);
  }
  return {
    rows: placedRows,
    files: placed.sort((a, b) => parseExpiredSliceFileName(a).index - parseExpiredSliceFileName(b).index),
    monolith: expiredSliceFileName(key),
  };
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < rest.length; i += 2) options[rest[i].replace(/^--/u, '')] = rest[i + 1];
    if (command === 'plan') {
      for (const key of plan(options)) console.log(key);
    } else if (command === 'apply') {
      const result = apply(options);
      console.log(`  🧩 whole-archive merge of ${options.key}: ${result.rows} row(s) in ${result.files.join(', ')}`);
    } else {
      throw new Error(`unknown command: ${command ?? '(none)'}`);
    }
  } catch (error) {
    console.error(`❌ expired archive tree merge: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
