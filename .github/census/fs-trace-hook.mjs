// CENSIMENTO TEMPORANEO (non va mergiato): caricato con NODE_OPTIONS=--import in
// ogni processo Node della suite (main di Vitest, fork dei worker, processi figli
// dei test). Registra, attribuite al file di test in esecuzione:
//   - le SCRITTURE su path dentro il repo (fuori da node_modules/.git/.cache);
//   - le LETTURE sotto le radici di dati vivi di live-data-test-guard.mjs.
// Nei worker il file di test corrente è `globalThis.__vitest_worker__.filepath`;
// ai processi figli arriva via env `CENSUS_TEST_FILE`, iniettata qui patchando
// child_process.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const ROOT = process.env.CENSUS_REPO_ROOT;
const LOG = process.env.CENSUS_LOG_FILE;
const LIVE_ROOTS = JSON.parse(process.env.CENSUS_LIVE_ROOTS || '[]');

if (ROOT && LOG) {
  const orig = {
    appendFileSync: fs.appendFileSync,
  };
  const seen = new Set();
  const rel = (p) => {
    if (p === undefined || p === null) return null;
    let s;
    if (typeof p === 'number') return null;
    if (p instanceof URL) s = p.pathname;
    else if (Buffer.isBuffer(p)) s = p.toString();
    else s = String(p);
    const abs = path.resolve(s);
    if (abs !== ROOT && !abs.startsWith(`${ROOT}/`)) return null;
    const r = abs.slice(ROOT.length + 1);
    if (!r || r.startsWith('node_modules/') || r.startsWith('.git/') || r === '.git' || r.startsWith('.cache/')
      || r.includes('/node_modules/')) return null;
    return r;
  };
  const currentTest = () => {
    const state = globalThis.__vitest_worker__;
    const file = state && state.filepath;
    if (file) return rel(file) || String(file);
    return process.env.CENSUS_TEST_FILE || null;
  };
  const log = (kind, op, p) => {
    const r = rel(p);
    if (!r) return;
    let key;
    if (kind === 'read') {
      const root = LIVE_ROOTS.find((lr) => r === lr || r.startsWith(lr));
      if (!root) return;
      key = `read|${currentTest()}|${root}`;
      if (seen.has(key)) return;
      seen.add(key);
      orig.appendFileSync(LOG, `${JSON.stringify({ kind, op, root, path: r, test: currentTest(), pid: process.pid, child: !globalThis.__vitest_worker__ })}\n`);
      return;
    }
    key = `write|${currentTest()}|${r}|${op}`;
    if (seen.has(key)) return;
    seen.add(key);
    orig.appendFileSync(LOG, `${JSON.stringify({ kind, op, path: r, test: currentTest(), pid: process.pid, child: !globalThis.__vitest_worker__ })}\n`);
  };
  const isWriteFlag = (flags) => {
    if (flags === undefined || flags === null) return false;
    if (typeof flags === 'number') {
      const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = fs.constants;
      return Boolean(flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC));
    }
    return /[wa+]/.test(String(flags));
  };
  const wrap = (obj, name, fn) => {
    const original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = function wrapped(...args) {
      try { fn(args); } catch { /* il censimento non deve mai rompere un test */ }
      return original.apply(this, args);
    };
  };
  const writers1 = ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'truncateSync', 'truncate',
    'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'createWriteStream'];
  const writers2 = ['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'symlinkSync', 'symlink', 'linkSync', 'link'];
  const readers = ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'createReadStream', 'opendirSync', 'opendir'];
  for (const target of [fs, fs.promises]) {
    for (const name of writers1) wrap(target, name, (a) => log('write', name, a[0]));
    // rename/copy/cp/link: la destinazione è il secondo argomento; per rename
    // anche la sorgente sparisce, quindi si registrano entrambe.
    for (const name of writers2) wrap(target, name, (a) => {
      log('write', name, a[1]);
      if (name.startsWith('rename')) log('write', `${name}:src`, a[0]);
    });
    for (const name of readers) wrap(target, name, (a) => log('read', name, a[0]));
    wrap(target, target === fs ? 'openSync' : 'open', (a) => {
      if (isWriteFlag(a[1])) log('write', 'open', a[0]);
      else log('read', 'open', a[0]);
    });
    if (target === fs) wrap(fs, 'open', (a) => {
      if (isWriteFlag(a[1])) log('write', 'open', a[0]);
      else log('read', 'open', a[0]);
    });
  }
  // Attribuzione nei processi figli: ogni spawn porta con sé il file di test.
  const withEnv = (opts) => {
    const test = currentTest();
    if (!test) return opts;
    const base = opts && typeof opts === 'object' ? opts : {};
    return { ...base, env: { ...(base.env || process.env), CENSUS_TEST_FILE: test } };
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function patched(file, args, opts, ...rest) {
      if (Array.isArray(args)) return original.call(this, file, args, withEnv(opts), ...rest);
      if (typeof args === 'function' || args === undefined) return original.call(this, file, [], withEnv(undefined), ...(typeof args === 'function' ? [args] : []));
      return original.call(this, file, withEnv(args), opts, ...rest);
    };
  }
  for (const name of ['exec', 'execSync']) {
    const original = childProcess[name];
    childProcess[name] = function patched(command, opts, ...rest) {
      if (typeof opts === 'function') return original.call(this, command, withEnv(undefined), opts, ...rest);
      return original.call(this, command, withEnv(opts), ...rest);
    };
  }
  syncBuiltinESMExports();
}
