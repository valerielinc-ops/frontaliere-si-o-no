/**
 * Ciclo intero dello Stop hook: copia del gate in una cartella temporanea
 * (registro e stamp del cooldown sono relativi allo script), con `gh`, `sleep`
 * e CLI del coordinatore finti. `sleep` registra la durata invece di dormire.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(__dirname, '../..');
const SESSION = 'session-a';

type FakePr = {
  draft?: boolean;
  mergeable_state?: string;
  reviews?: object[];
  error?: string;
  reviewsError?: boolean;
};

let root: string;

/** Copia lo script e la chiusura dei suoi import relativi. */
function copyModule(rel: string, seen = new Set<string>()) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const source = fs.readFileSync(path.join(SOURCE_ROOT, rel), 'utf-8');
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), source);
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)['"](\.[^'"]+)['"]/gm)) {
    copyModule(path.posix.join(path.posix.dirname(rel), match[1]), seen);
  }
}

function executable(name: string, body: string) {
  fs.writeFileSync(path.join(root, 'bin', name), body, { mode: 0o755 });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-gate-'));
  copyModule('scripts/ci/pr-watch-gate.mjs');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, '.claude'));
  executable('gh', `#!${process.execPath}
const fs = require('fs');
const [cmd, url] = process.argv.slice(2);
if (cmd === 'auth') process.exit(0);
const [, number, reviews, query] = /pulls\\/(\\d+)(\\/reviews)?(?:\\?(.*))?$/.exec(url);
const pr = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'prs.json'))}))[number];
if (pr.error || (reviews && pr.reviewsError)) {
  process.stderr.write(pr.error || 'gh: timeout');
  process.exit(1);
}
if (reviews) {
  const page = Number(new URLSearchParams(query).get('page') || 1);
  console.log(JSON.stringify((pr.reviews || []).slice((page - 1) * 100, page * 100)));
} else {
  console.log(JSON.stringify({ state: 'open', head: { sha: 'HEAD' }, draft: pr.draft === true, mergeable_state: pr.mergeable_state || 'clean' }));
}
`);
  executable('sleep', `#!/bin/sh\necho "$1" >> '${path.join(root, 'slept.log')}'\n`);
  // Coordinatore che dichiara sempre un'attesa armata, solo se il test lo usa.
  executable('coordinator-armed', `#!/bin/sh
echo '{"ok":true,"subscriptions":[{"id":"s","remainingMs":60000,"listenerAlive":true,"waitFor":["merged","closed","reviewed"]}]}'
`);
  executable('coordinator-idle', `#!/bin/sh\necho '{"ok":true,"subscriptions":[]}'\n`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const registryPath = () => path.join(root, '.claude', 'pr-watch-state.json');
const registered = (): number[] => JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).map((e: { number: number }) => e.number);

function watch(...numbers: number[]) {
  fs.writeFileSync(registryPath(), JSON.stringify(numbers.map((number) => ({ owner: 'o', repo: 'r', number, sessionId: SESSION }))));
}

function stop(prs: Record<number, FakePr>, { armed = false, sessionId = SESSION } = {}) {
  fs.writeFileSync(path.join(root, 'prs.json'), JSON.stringify(prs));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    FRONTALIERE_GH_CLI: path.join(root, 'bin', armed ? 'coordinator-armed' : 'coordinator-idle'),
  };
  delete env.GITHUB_ACTIONS;
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/ci/pr-watch-gate.mjs')], {
    input: JSON.stringify({ session_id: sessionId }),
    encoding: 'utf-8',
    env,
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

const slept = () => {
  try {
    return fs.readFileSync(path.join(root, 'slept.log'), 'utf-8').trim().split('\n').map(Number);
  } catch {
    return [];
  }
};

const finding = { commit_id: 'HEAD', state: 'COMMENTED', user: { login: 'frontaliere-automation[bot]', type: 'Bot' }, body: '🔴 Important: x' };

describe('pr-watch-gate: bozze, conflitti e cooldown', () => {
  it('voce parcheggiata: conservata, nessun blocco, avviso; fuori dalla bozza torna a bloccare', () => {
    watch(1);
    for (let turn = 0; turn < 2; turn += 1) {
      const parked = stop({ 1: { draft: true, mergeable_state: 'dirty' } });
      expect(parked.code).toBe(0);
      expect(parked.out.decision).toBeUndefined();
      expect(parked.out.systemMessage).toMatch(/#1 .*parcheggiata in bozza/);
      expect(registered()).toEqual([1]);
    }
    const ready = stop({ 1: {} });
    expect(ready.code).toBe(2);
    expect(ready.out.reason).toContain('#1 (o/r) [awaiting-review]');
    expect(registered()).toEqual([1]);
  });

  it('una draft e una awaiting-review: blocca solo per la seconda', () => {
    watch(1, 2);
    const result = stop({ 1: { draft: true }, 2: {} });
    expect(result.code).toBe(2);
    expect(result.out.reason).toContain('#2 (o/r) [awaiting-review]');
    expect(result.out.reason).not.toContain('--number 1 ');
    expect(result.out.reason).toMatch(/#1 \(o\/r\) parcheggiata in bozza: non blocca/);
    expect(registered()).toEqual([1, 2]);
  });

  it('bozza con 🔴 sulla head blocca, anche oltre la prima pagina di review', () => {
    watch(1);
    const older = Array.from({ length: 100 }, () => ({ ...finding, commit_id: 'OLD' }));
    const result = stop({ 1: { draft: true, reviews: [...older, finding] } }, { armed: true });
    expect(result.code).toBe(2);
    expect(result.out.reason).toContain('[not-lgtm]');
  });

  it('bozza con review illeggibili non viene parcheggiata', () => {
    watch(1);
    expect(stop({ 1: { draft: true, reviewsError: true } }).code).toBe(2);
  });

  it('conflitto senza review: il listener armato non esenta; senza conflitto si', () => {
    watch(1);
    const dirty = stop({ 1: { mergeable_state: 'dirty' } }, { armed: true });
    expect(dirty.code).toBe(2);
    expect(dirty.out.reason).toMatch(/\[conflicting\]/);
    expect(stop({ 1: {} }, { armed: true }).code).toBe(0);
    expect(registered()).toEqual([1]);
  });

  it('lettura fallita: la voce resta senza bloccare; solo un 404 la toglie', () => {
    watch(1);
    expect(stop({ 1: { error: 'gh: timeout' } }).code).toBe(0);
    expect(registered()).toEqual([1]);
    expect(stop({ 1: { error: 'gh: Not Found (HTTP 404)' } }).code).toBe(0);
    expect(registered()).toEqual([]);
  });

  it('il cooldown vale per la sessione che ha ricevuto il blocco, non per le altre', () => {
    fs.writeFileSync(
      registryPath(),
      JSON.stringify([SESSION, 'session-b'].map((sessionId, i) => ({ owner: 'o', repo: 'r', number: i + 1, sessionId }))),
    );
    const prs = { 1: {}, 2: {} };
    stop(prs);
    stop(prs, { sessionId: 'session-b' });
    expect(slept()).toEqual([]);
    stop(prs);
    expect(slept()).toHaveLength(1);
    expect(slept()[0]).toBeGreaterThan(800);
    stop(prs, { sessionId: 'session-b' });
    expect(slept()).toHaveLength(2);
  });
});
