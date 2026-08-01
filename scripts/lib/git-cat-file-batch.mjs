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
  let buf = Buffer.alloc(0);

  proc.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    drain();
  });
  proc.on('error', (err) => {
    while (queue.length) queue.shift().reject(err);
  });

  function drain() {
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl === -1) return;
      const header = buf.subarray(0, nl).toString('utf8');
      const parts = header.split(' ');
      if (parts[1] === 'missing') {
        buf = buf.subarray(nl + 1);
        queue.shift()?.resolve(null);
        continue;
      }
      const size = Number(parts[2]);
      if (!Number.isFinite(size)) {
        buf = buf.subarray(nl + 1);
        queue.shift()?.resolve(null);
        continue;
      }
      const need = nl + 1 + size + 1;
      if (buf.length < need) return;
      const content = buf.subarray(nl + 1, nl + 1 + size).toString('utf8');
      buf = buf.subarray(need);
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
