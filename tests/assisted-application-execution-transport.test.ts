import { describe, expect, it } from 'vitest';
import { nextRemoteBatch } from '../scripts/assisted-application/remote-executor.mjs';
import { executionArtifacts } from '../scripts/assisted-application/lib/execution-artifacts.mjs';
import { privateBrowserEnvironment } from '../scripts/assisted-application/lib/darwin-isolation.mjs';
import { controllerWorkerSource } from '../scripts/assisted-application/remote-controller.mjs';
import { processGroupAlive, waitForDetachedChild, createProcessGroupRegistry, reapRegisteredProcessGroups } from '../scripts/assisted-application/lib/execution-process.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { inspectProcess } from '../scripts/assisted-application/lib/process-registry.mjs';
import { once } from 'node:events';

describe('remote executor transport boundaries', () => {
  it('reaps a separately detached browser after its agent dies with SIGKILL', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-browser-fixture-'));
    const registry = path.join(temporary, 'groups'); createProcessGroupRegistry(registry);
    const module = pathToFileURL(path.resolve('scripts/assisted-application/lib/execution-process.mjs')).href;
    const ready = path.join(temporary, 'ready');
    const browser = `import{registerDetachedProcessGroup}from ${JSON.stringify(module)};registerDetachedProcessGroup(${JSON.stringify(registry)},process.pid);(await import('node:fs')).writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const leader = `require('node:child_process').spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(browser)}],{detached:true,stdio:'ignore',env:{}});setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', leader], { detached: true, stdio: 'ignore', env: {} }); let browserPid = 0;
    try {
      for (let count = 0; count < 100 && !fs.existsSync(ready); count++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.existsSync(ready)).toBe(true); browserPid = Number(fs.readFileSync(ready, 'utf8'));
      child.kill('SIGKILL'); await expect(waitForDetachedChild(child, 5000)).rejects.toThrow('remote_executor_runtime_failed');
      expect(processGroupAlive(browserPid)).toBe(true);
      await reapRegisteredProcessGroups(registry); expect(processGroupAlive(browserPid)).toBe(false);
      expect(fs.existsSync(path.join(registry, 'registration-open'))).toBe(false);
    } finally {
      for (const pid of [child.pid, browserPid]) if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {}
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 12_000);
  it('freezes an incomplete registration with its own live group without killing it', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-pending-fixture-')); createProcessGroupRegistry(path.join(temporary, 'groups'));
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: {} });
    try {
      fs.writeFileSync(path.join(temporary, 'groups', `${child.pid}.pending`), 'partial');
      await expect(reapRegisteredProcessGroups(path.join(temporary, 'groups'))).rejects.toMatchObject({ processGroupUnreaped: true });
      expect(processGroupAlive(child.pid)).toBe(true);
    } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it('recovers automatically after SIGKILL between pending write and rename when the owned group is proved dead', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-dead-pending-')); const groups = path.join(temporary, 'groups'); createProcessGroupRegistry(groups);
    const code = `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(groups)},process.pid+'.pending'),'partial');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', env: {} });
    try {
      const pending = path.join(groups, `${child.pid}.pending`);
      for (let count = 0; count < 100 && !fs.existsSync(pending); count++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.existsSync(pending)).toBe(true); child.kill('SIGKILL'); await once(child, 'exit');
      expect(processGroupAlive(child.pid)).toBe(false);
      await reapRegisteredProcessGroups(groups); expect(fs.existsSync(pending)).toBe(false);
      fs.rmSync(groups, { recursive: true }); createProcessGroupRegistry(groups);
      expect(fs.existsSync(path.join(groups, 'registration-open'))).toBe(true);
    } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it('reaps a complete pending registration only with the matching birth identity of its owned group', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-full-pending-')); const groups = path.join(temporary, 'groups'); createProcessGroupRegistry(groups);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: {} });
    try {
      const identity = inspectProcess(child.pid);
      fs.writeFileSync(path.join(groups, `${child.pid}.pending`), JSON.stringify({ pid: child.pid, started: `${identity.started}-mismatch` }));
      await expect(reapRegisteredProcessGroups(groups)).rejects.toMatchObject({ processGroupUnreaped: true });
      expect(processGroupAlive(child.pid)).toBe(true);
      fs.writeFileSync(path.join(groups, `${child.pid}.pending`), JSON.stringify({ pid: child.pid, started: identity.started }));
      await reapRegisteredProcessGroups(groups); expect(processGroupAlive(child.pid)).toBe(false);
    } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it('keeps the controller on trusted main when main advances after worker source selection', () => {
    const previous = 'a'.repeat(40); const current = 'b'.repeat(40);
    expect(controllerWorkerSource({ checkoutSha: current, githubSha: current, githubRef: 'refs/heads/main', workerSourceSha: previous })).toBe(previous);
    expect(() => controllerWorkerSource({ checkoutSha: previous, githubSha: current, githubRef: 'refs/heads/main', workerSourceSha: previous })).toThrow('source_mismatch');
    expect(() => controllerWorkerSource({ checkoutSha: current, githubSha: current, githubRef: 'refs/heads/feature', workerSourceSha: previous })).toThrow('source_mismatch');
  });
  it('reaps a TERM-resistant descendant even when the detached leader exits first', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-process-fixture-')); const ready = path.join(temporary, 'ready');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',env:{}});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', leader], { detached: true, stdio: 'ignore', env: {} });
    try {
      for (let count = 0; count < 100 && !fs.existsSync(ready); count++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.existsSync(ready)).toBe(true);
      await expect(waitForDetachedChild(child, 50)).rejects.toThrow('remote_executor_timeout');
      expect(processGroupAlive(child.pid)).toBe(false);
    } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} fs.rmSync(temporary, { recursive: true, force: true }); }
  }, 12_000);
  it('visits pending orders beyond the first full batch and then starts a fresh fair sweep', async () => {
    const orders = Array.from({ length: 61 }, (_, index) => ({ id: String(index).padStart(3, '0') }));
    const db = { collection(name) {
      expect(name).toBe('assisted_applications'); let after = ''; let limit = 0;
      const query = {
        where(field, operator, value) { expect([field, operator, value]).toEqual(['automationState', '==', 'submitting']); return query; },
        orderBy(field) { expect(field).toBe('__name__'); return query; },
        limit(value) { limit = value; return query; },
        startAfter(cursor) { after = cursor.id; return query; },
        async get() { return { docs: orders.filter(doc => doc.id > after).slice(0, limit) }; },
      }; return query;
    } };
    let cursor = null; const seen = [];
    do { const page = await nextRemoteBatch({ db, cursor }); seen.push(...page.docs.map(doc => doc.id)); cursor = page.cursor; } while (cursor);
    expect(seen).toEqual(orders.map(doc => doc.id));
    expect((await nextRemoteBatch({ db, cursor })).docs[0].id).toBe('000');
  });
  it('never passes manager credentials or the owner home into the browser environment', () => {
    expect(privateBrowserEnvironment({ home: '/private/browser-home', temporary: '/private/browser-tmp',
      env: { HOME: '/owner', GOOGLE_APPLICATION_CREDENTIALS: '/owner/service-account', CODEX_AUTH_JSON: 'secret', PATH: '/owner/bin', LANG: 'it' } }))
      .toEqual({ PATH: '/usr/bin:/bin', HOME: '/private/browser-home', TMPDIR: '/private/browser-tmp', OPENSSL_CONF: '/dev/null', LANG: 'it' });
  });
  it('bridges only bounded already-redacted issue fields, with no arbitrary artifact payload', () => {
    const stop = { host: 'jobs.example.test', path: '/[posting]/apply', reason: 'captcha', channel: 'lever', step: 2,
      buttons: ['Continue'], fields: [], errors: ['contact fixture@example.test'], agent: [], privateDump: 'excluded' };
    const result = executionArtifacts({ stop, arbitraryDump: 'excluded' });
    expect(result.stop.privateDump).toBeUndefined(); expect(result.arbitraryDump).toBeUndefined();
    expect(result.stop.errors).toEqual(['contact [email]']);
    expect(executionArtifacts({ stop: { ...stop, path: '/apply?candidate=private' } })).toEqual({});
    expect(executionArtifacts({ stop: { ...stop, buttons: ['x'.repeat(40_000)] } })).toEqual({});
    expect(executionArtifacts({ pass: { host: 'jobs.example.test', channel: 'lever', mode: 'submit', stage: 'unknown' } })).toEqual({});
  });
});
