/**
 * Long-lived `git cat-file --batch` process. Spawning a fresh `git show
 * <commit>:<path>` process per historical blob (hundreds to thousands in a
 * typical scan/backfill window) pays its own process-spawn + repo-open cost
 * per call. `cat-file --batch` keeps ONE process alive and streams
 * requests/responses over its stdin/stdout pipe; responses arrive strictly
 * in request order (git's documented batch-mode contract), so a simple FIFO
 * queue suffices.
 *
 * Extracted from scripts/scan-prev-slug-losses.mjs (issue #4654) so
 * scripts/backfill-prev-slugs-from-loss-events.mjs can share the same fix
 * instead of retaining its own per-commit `execSync('git show ...')` loop.
 *
 * @param {string} cwd
 */
import { spawn } from 'node:child_process';

export function createCatFileBatch(cwd) {
  const proc = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  const queue = [];
  // Pending stdout bytes as a list of un-merged chunks, not a single
  // concatenated Buffer. A large historical blob (e.g. a 30MB slice file)
  // arrives over the pipe as hundreds of ~64KB reads; re-running
  // `Buffer.concat([buf, chunk])` on every single one of those (as this
  // used to) re-copies the ENTIRE accumulated buffer each time — O(n^2) in
  // the blob size. Measured: ~1s per 30MB historical version fetched this
  // way, x400 commits walked per file by callers that index a whole slice's
  // history → multi-minute stalls that cancelled the "Recover Lost
  // previousSlugs" job (#5025) despite it already using this shared batch
  // process instead of spawning one `git show` per blob (the fix
  // #4654/#5027 targeted). Chunks are only merged once, via a single
  // Buffer.concat, at the point a full response has actually arrived.
  let chunks = [];
  let chunksLen = 0;

  proc.stdout.on('data', (chunk) => {
    chunks.push(chunk);
    chunksLen += chunk.length;
    drain();
  });
  proc.on('error', (err) => {
    while (queue.length) queue.shift().reject(err);
  });

  // Absolute offset of the first '\n' across the pending chunks, or -1 if
  // not yet received. The header line (hex OID + type + byte size) is a few
  // dozen bytes and — per git's batch-mode framing — always precedes the
  // body, so this stops at the first (usually only) chunk that contains it
  // without touching any body bytes queued behind it.
  function findHeaderEnd() {
    let offset = 0;
    for (const c of chunks) {
      const idx = c.indexOf(10);
      if (idx !== -1) return offset + idx;
      offset += c.length;
    }
    return -1;
  }

  function consumeThrough(n) {
    const full = chunks.length === 1 && chunks[0].length >= n ? chunks[0] : Buffer.concat(chunks, chunksLen);
    const rest = full.subarray(n);
    chunks = rest.length ? [rest] : [];
    chunksLen = rest.length;
  }

  function drain() {
    for (;;) {
      if (chunksLen === 0) return;
      const nl = findHeaderEnd();
      if (nl === -1) return; // header not fully arrived yet
      const headerBuf = chunks[0].length >= nl ? chunks[0].subarray(0, nl) : Buffer.concat(chunks, chunksLen).subarray(0, nl);
      const parts = headerBuf.toString('utf8').split(' ');
      const size = Number(parts[2]);
      if (parts[1] === 'missing' || !Number.isFinite(size)) {
        consumeThrough(nl + 1);
        queue.shift()?.resolve(null);
        continue;
      }
      const need = nl + 1 + size + 1;
      if (chunksLen < need) return; // body still arriving — no copy yet
      const full = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, chunksLen);
      const content = full.subarray(nl + 1, nl + 1 + size).toString('utf8');
      const rest = full.subarray(need);
      chunks = rest.length ? [rest] : [];
      chunksLen = rest.length;
      queue.shift()?.resolve(content);
    }
  }

  return {
    get(objSpec) {
      return new Promise((resolve, reject) => {
        queue.push({ resolve, reject });
        proc.stdin.write(`${objSpec}\n`);
      });
    },
    close() {
      proc.stdin.end();
    },
  };
}
