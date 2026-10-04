// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import { RC_TO_ENV, isTrivialSecret } from '../scripts/load-rc-env.mjs';
import { importSpecifiers } from '../scripts/ci/check-dependency-free-import-closure.mjs';
import {
  DEFAULT_SOCIAL_ROBOT_MODE,
  QUEUE_TTL_HOURS,
  ROBOT_LEDGER_VIA,
  SOCIAL_ROBOT_MODES,
  buildQueueEntry,
  confirmQueueEntry,
  deliverSocialPost,
  enqueuePost,
  loadQueue,
  resolveSocialRobotMode,
  selectNextPending,
  socialPublishRoute,
  upsertPending,
} from '../scripts/lib/social-publish-queue.mjs';
import {
  MAX_POSTS_PER_DAY_PER_PLATFORM,
  PAUSE_AFTER_BLOCK_HOURS,
  emptyJournal,
  localDay,
  pausedUntil,
  pressedToday,
} from '../scripts/social-robot/lib/cadence.mjs';
import { RobotError } from '../scripts/social-robot/lib/flows.mjs';
import { displayPath, downloadImages, issueTitleFor, runRobot } from '../scripts/social-robot/lib/robot.mjs';
import { applyConfirmation, parseConfirmArgs } from '../scripts/social-robot/confirm.mjs';
import { resolveBrowserLaunch } from '../scripts/social-robot/lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-robot-test-'));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-04T09:30:00Z');
const HOUR = 3600_000;
const cdn = (name: string) => `https://cdn.frontaliereticino.ch/images/social/instagram/${name}`;

function entry(kind = 'article', day = '2026-10-03', { channel = 'instagram', now = NOW } = {}) {
  return buildQueueEntry({
    channel,
    kind,
    day,
    caption: `${kind} ${day}\n\n#frontalieri`,
    imageUrls: [cdn(`${kind}-${day}-0.jpg`), cdn(`${kind}-${day}-1.jpg`)],
    ledgerEntries: [{ id: `${kind}-slug-a`, kind, url: 'https://frontaliereticino.ch/a/', day }],
    now,
  });
}

describe('Remote Config switch SOCIAL_ROBOT_MODE', () => {
  it('reads absent, empty and unknown values as the safe dry run', () => {
    expect(DEFAULT_SOCIAL_ROBOT_MODE).toBe('dry');
    for (const value of [undefined, '', '  ', 'publish', 'dry-run', 'LIVE!']) {
      expect(resolveSocialRobotMode({ SOCIAL_ROBOT_MODE: value }), String(value)).toBe('dry');
    }
    expect(resolveSocialRobotMode({ SOCIAL_ROBOT_MODE: ' Live ' })).toBe('live');
    expect(resolveSocialRobotMode({ SOCIAL_ROBOT_MODE: 'off' })).toBe('off');
  });

  it('is exported by the loader and never masked in CI logs', () => {
    expect((RC_TO_ENV as Record<string, string[]>).SOCIAL_ROBOT_MODE).toEqual(['SOCIAL_ROBOT_MODE']);
    for (const value of SOCIAL_ROBOT_MODES) expect(isTrivialSecret(value), value).toBe(true);
  });

  it('routes the posters: off = API only, dry = API then queue, live = queue only', () => {
    expect(socialPublishRoute({ mode: 'off', apiReady: false })).toEqual({ api: false, enqueue: false, render: false });
    expect(socialPublishRoute({ mode: 'off', apiReady: true })).toEqual({ api: true, enqueue: false, render: true });
    expect(socialPublishRoute({ mode: 'dry', apiReady: false })).toEqual({ api: false, enqueue: true, render: true });
    expect(socialPublishRoute({ mode: 'dry', apiReady: true })).toEqual({ api: true, enqueue: true, render: true });
    expect(socialPublishRoute({ mode: 'live', apiReady: true })).toEqual({ api: false, enqueue: true, render: true });
  });
});

describe('deliverSocialPost', () => {
  const quiet = { log: () => {}, error: () => {} };
  it('records an API publish and queues nothing', async () => {
    const recordPublished = vi.fn();
    const enqueue = vi.fn();
    const out = await deliverSocialPost({ route: { api: true, enqueue: true }, label: 'X', publish: async () => ({ ok: true }), recordPublished, enqueue, log: quiet });
    expect(out).toBe('api');
    expect(recordPublished).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues a post the API failed to publish, and never records it', async () => {
    const recordPublished = vi.fn();
    const enqueue = vi.fn();
    const out = await deliverSocialPost({ route: { api: true, enqueue: true }, label: 'X', publish: async () => ({ ok: false, reason: '400' }), recordPublished, enqueue, log: quiet });
    expect(out).toBe('queued');
    expect(recordPublished).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('never calls the API in live mode', async () => {
    const publish = vi.fn();
    const out = await deliverSocialPost({ route: socialPublishRoute({ mode: 'live', apiReady: true }), label: 'X', publish, recordPublished: vi.fn(), enqueue: vi.fn(), log: quiet });
    expect(out).toBe('queued');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('the queue', () => {
  it('builds an entry keyed like the CDN slides, expiring with its kind', () => {
    const e = entry('article');
    expect(e.id).toBe('article-2026-10-03');
    expect(Date.parse(e.expiresAt) - Date.parse(e.createdAt)).toBe(QUEUE_TTL_HOURS.article * HOUR);
    expect(() => buildQueueEntry({ ...e, imageUrls: ['https://evil.example/x.jpg'] })).toThrow(/outside/);
    expect(() => buildQueueEntry({ ...e, caption: ' ' })).toThrow(/caption/);
  });

  it('replaces the pending post of the same kind and drops expired ones', () => {
    const old = entry('article', '2026-10-02', { now: NOW - 24 * HOUR });
    const stale = entry('job', '2026-09-30', { now: NOW - 72 * HOUR });
    const border = entry('border', '2026-09-28', { now: NOW - 72 * HOUR });
    const next = upsertPending({ pending: [old, stale, border] }, entry('article'), NOW);
    expect(next.pending.map((e: { id: string }) => e.id).sort()).toEqual(['article-2026-10-03', 'border-2026-09-28']);
  });

  it('writes the queue file the workflow commits', () => {
    const dir = tempDir();
    const file = path.join(dir, 'instagram-queue.json');
    enqueuePost(file, entry('article'), NOW);
    enqueuePost(file, entry('job'), NOW);
    expect(loadQueue(file).pending.map((e: { id: string }) => e.id)).toEqual(['article-2026-10-03', 'job-2026-10-03']);
  });

  it('selects the oldest post the robot may still press', () => {
    const a = entry('article', '2026-10-03', { now: NOW - 2 * HOUR });
    const j = entry('job', '2026-10-03', { now: NOW - HOUR });
    const b = entry('border', '2026-09-28', { now: NOW - 3 * HOUR });
    const t = entry('article', '2026-10-03', { channel: 'tiktok' });
    const queue = { pending: [j, a, b, t] };
    expect(selectNextPending(queue, { channel: 'instagram', now: NOW })?.id).toBe(b.id);
    expect(selectNextPending(queue, { channel: 'instagram', now: NOW, blockedIds: new Set([b.id]) })?.id).toBe(a.id);
    const ledger = { posted: [{ id: 'x', queueId: b.id }, { id: 'y', queueId: a.id }] };
    expect(selectNextPending(queue, { channel: 'instagram', now: NOW, ledger })?.id).toBe(j.id);
    expect(selectNextPending(queue, { channel: 'instagram', now: NOW + 40 * HOUR, ledger })).toBeNull();
    expect(selectNextPending({ pending: [{ ...a, imageUrls: ['https://evil.example/a.jpg'] }] }, { channel: 'instagram', now: NOW })).toBeNull();
  });
});

describe('confirmation → ledger', () => {
  it('moves the entry into the ledger with the robot marker, once', () => {
    const e = entry('article');
    const first = confirmQueueEntry({ queue: { pending: [e] }, ledger: { posted: [] }, queueId: e.id, confirmedAt: '2026-10-04T10:00:00Z', evidence: 'Post condiviso' });
    expect(first.queue.pending).toEqual([]);
    expect(first.ledgerEntries).toEqual([{ ...e.ledgerEntries[0], ts: '2026-10-04T10:00:00.000Z', queueId: e.id, via: ROBOT_LEDGER_VIA, robotEvidence: 'Post condiviso' }]);
    const again = confirmQueueEntry({ queue: { pending: [] }, ledger: { posted: first.ledgerEntries }, queueId: e.id, confirmedAt: '2026-10-04T10:05:00Z' });
    expect(again.alreadyConfirmed).toBe(true);
    expect(again.ledgerEntries).toEqual([]);
  });

  it('uses the entries sent with the confirmation when a newer ranking replaced the queue entry', () => {
    const res = confirmQueueEntry({ queue: { pending: [] }, ledger: { posted: [] }, queueId: 'job-2026-10-03', confirmedAt: '2026-10-04T10:00:00Z', fallbackLedgerEntries: [{ id: 's', kind: 'job' }] });
    expect(res.source).toBe('confirmation');
    expect(res.ledgerEntries[0]).toMatchObject({ id: 's', kind: 'job', queueId: 'job-2026-10-03' });
    expect(() => confirmQueueEntry({ queue: { pending: [] }, ledger: { posted: [] }, queueId: 'job-2026-10-03', confirmedAt: '2026-10-04T10:00:00Z' })).toThrow(/no ledger entries/);
  });

  it('confirm.mjs writes queue and ledger files and validates its inputs', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'data'));
    const e = entry('article');
    fs.writeFileSync(path.join(root, 'data', 'instagram-queue.json'), JSON.stringify({ schemaVersion: 1, pending: [e] }));
    const args = parseConfirmArgs(['--channel=instagram', `--queue-id=${e.id}`, '--confirmed-at=2026-10-04T10:00:00Z', '--evidence=ok']);
    applyConfirmation({ root, ...args });
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data', 'instagram-posted.json'), 'utf8'));
    expect(ledger.posted.map((p: { queueId: string }) => p.queueId)).toEqual([e.id]);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data', 'instagram-queue.json'), 'utf8')).pending).toEqual([]);
    expect(() => parseConfirmArgs(['--channel=facebook', `--queue-id=${e.id}`, '--confirmed-at=2026-10-04T10:00:00Z'])).toThrow(/channel/);
    expect(() => parseConfirmArgs(['--channel=tiktok', '--queue-id=../../etc', '--confirmed-at=2026-10-04T10:00:00Z'])).toThrow(/queue-id/);
    expect(() => parseConfirmArgs(['--channel=tiktok', `--queue-id=${e.id}`, '--confirmed-at=ieri'])).toThrow(/confirmed-at/);
  });
});

describe('cadence', () => {
  it('counts only the presses of the local (Zurich) day', () => {
    const journal = emptyJournal();
    journal.attempts.push(
      { channel: 'instagram', outcome: 'published', at: '2026-10-04T06:00:00Z', queueId: 'a' },
      { channel: 'instagram', outcome: 'unconfirmed', at: '2026-10-04T07:00:00Z', queueId: 'b' },
      { channel: 'instagram', outcome: 'dry-run', at: '2026-10-04T08:00:00Z', queueId: 'c' },
      { channel: 'instagram', outcome: 'published', at: '2026-10-03T21:59:00Z', queueId: 'd' }, // 23:59 in Zurich
      { channel: 'tiktok', outcome: 'published', at: '2026-10-04T08:00:00Z', queueId: 'e' },
    );
    expect(localDay('2026-10-03T22:30:00Z')).toBe('2026-10-04');
    expect(pressedToday(journal, 'instagram', NOW)).toBe(2);
    expect(pressedToday(journal, 'tiktok', NOW)).toBe(1);
  });
});

type Deps = Parameters<typeof runRobot>[0];

function harness({ queue = { pending: [entry('article')] }, journal = emptyJournal(), flow = async (_c: string, _e: unknown, _f: string[], o: { dryRun: boolean }) => ({ status: o.dryRun ? 'dry-run' : 'published', evidence: 'Post condiviso' }) } = {}) {
  let stored = journal;
  let clock = NOW;
  const calls = { flow: [] as Array<{ dryRun: boolean; id: string }>, dispatch: [] as Array<Record<string, unknown>>, issues: [] as Array<{ title: string; description: string; labels: string[] }>, order: [] as string[] };
  const deps = (over: Partial<Deps> = {}): Deps => ({
    cliMode: 'publish',
    rcMode: 'live',
    platforms: ['instagram'],
    now: () => clock,
    rng: () => 0,
    sleep: async () => {},
    reader: { readQueue: () => queue, readLedger: () => ({ posted: [] }) },
    journalStore: { load: () => JSON.parse(JSON.stringify(stored)), save: (j: typeof stored) => { stored = JSON.parse(JSON.stringify(j)); } },
    fetchImages: async () => ['/tmp/slide-1.jpg'],
    diagnosticsFor: () => path.join(os.homedir(), 'Library', 'Application Support', 'frontaliere', 'social-robot', 'diagnostics', 'x'),
    publishWith: async (c: string, e: { id: string }, f: string[], o: { dryRun: boolean }) => {
      calls.flow.push({ dryRun: o.dryRun, id: e.id });
      calls.order.push('flow');
      return flow(c, e, f, o);
    },
    dispatchConfirm: async (args: Record<string, unknown>) => { calls.dispatch.push(args); calls.order.push('dispatch'); return { ok: true }; },
    reportIssue: async (issue: { title: string; description: string; labels: string[] }) => { calls.issues.push(issue); },
    log: { log: () => {}, warn: () => {}, error: () => {} },
    ...over,
  }) as Deps;
  return { deps, calls, journal: () => stored, advance: (ms: number) => { clock += ms; } };
}

describe('runRobot', () => {
  it('stays a dry run unless the command line AND Remote Config allow publishing', async () => {
    for (const [cliMode, rcMode] of [['dry-run', 'live'], ['publish', 'dry'], ['dry-run', 'dry']] as const) {
      const h = harness();
      const out = await runRobot(h.deps({ cliMode, rcMode }));
      expect(out.dryRun, `${cliMode}/${rcMode}`).toBe(true);
      expect(h.calls.flow.map((c) => c.dryRun)).toEqual([true]);
      expect(h.calls.dispatch).toEqual([]);
      expect(h.journal().attempts.map((a: { outcome: string }) => a.outcome)).toEqual(['dry-run']);
    }
  });

  it('does nothing when Remote Config says off', async () => {
    const h = harness();
    await runRobot(h.deps({ rcMode: 'off' }));
    expect(h.calls.flow).toEqual([]);
  });

  it('dispatches the ledger confirmation only after the flow saw the platform confirm', async () => {
    const h = harness();
    const out = await runRobot(h.deps());
    expect(out.results).toEqual([{ channel: 'instagram', outcome: 'published', queueId: 'article-2026-10-03', confirmDispatched: true }]);
    expect(h.calls.order).toEqual(['flow', 'dispatch']);
    expect(h.calls.dispatch[0]).toMatchObject({ channel: 'instagram', queueId: 'article-2026-10-03', evidence: 'Post condiviso' });
    // never pressed twice, even before the confirm commit reaches origin/main
    const again = await runRobot(h.deps());
    expect(again.results[0].outcome).toBe('empty');
    expect(h.calls.flow).toHaveLength(1);
  });

  it('never marks a post pressed without confirmation: unconfirmed, blocked, issue for a human', async () => {
    const h = harness({ flow: async () => { throw new RobotError('confirmation-missing', 'no confirmation', { step: 'confirmation', pressed: true }); } });
    const out = await runRobot(h.deps());
    expect(out.results[0]).toMatchObject({ outcome: 'unconfirmed', errorClass: 'confirmation-missing' });
    expect(h.calls.dispatch).toEqual([]);
    expect(h.calls.issues).toHaveLength(1);
    expect(h.calls.issues[0].labels).toContain('needs-human');
    await runRobot(h.deps());
    expect(h.calls.flow).toHaveLength(1);
  });

  it('opens the issue with a stable title on any error, with the home folder hidden', async () => {
    const h = harness({ flow: async () => { throw new RobotError('selector-missing', 'no control found for step "caption"', { step: 'caption' }); } });
    await runRobot(h.deps());
    h.advance(6 * HOUR);
    await runRobot(h.deps());
    expect(h.calls.issues.map((i) => i.title)).toEqual([issueTitleFor('instagram'), issueTitleFor('instagram')]);
    expect(h.calls.issues[0].description).toContain('`selector-missing`');
    expect(h.calls.issues[0].description).not.toContain(os.homedir());
    expect(h.calls.issues[0].labels).not.toContain('needs-human');
    expect(h.calls.dispatch).toEqual([]);
  });

  it('pauses a platform after a login wall instead of insisting', async () => {
    const h = harness({ flow: async () => { throw new RobotError('login-required', 'login page', { step: 'open' }); } });
    await runRobot(h.deps());
    expect(pausedUntil(h.journal(), 'instagram', NOW)).toBe(new Date(NOW + PAUSE_AFTER_BLOCK_HOURS * HOUR).toISOString());
    const second = await runRobot(h.deps());
    expect(second.results[0].outcome).toBe('paused');
    expect(h.calls.flow).toHaveLength(1);
    h.advance(PAUSE_AFTER_BLOCK_HOURS * HOUR + 1);
    await runRobot(h.deps());
    expect(h.calls.flow).toHaveLength(2);
  });

  it('respects the daily cap per platform', async () => {
    const journal = emptyJournal();
    for (let i = 0; i < MAX_POSTS_PER_DAY_PER_PLATFORM; i++) {
      journal.attempts.push({ channel: 'instagram', outcome: 'published', at: new Date(NOW - (i + 1) * HOUR).toISOString(), queueId: `old-${i}`, confirmDispatched: true });
    }
    const h = harness({ journal });
    const out = await runRobot(h.deps());
    expect(out.results[0].outcome).toBe('cap');
    expect(h.calls.flow).toEqual([]);
  });

  it('retries a confirm dispatch that failed before doing anything new', async () => {
    const journal = emptyJournal();
    journal.attempts.push({ channel: 'tiktok', outcome: 'published', at: new Date(NOW - HOUR).toISOString(), queueId: 'job-2026-10-03', confirmDispatched: false, evidence: 'ok', ledgerEntries: [{ id: 'j', kind: 'job' }] });
    const h = harness({ journal, queue: { pending: [] } });
    await runRobot(h.deps());
    expect(h.calls.dispatch).toEqual([expect.objectContaining({ channel: 'tiktok', queueId: 'job-2026-10-03', ledgerEntries: [{ id: 'j', kind: 'job' }] })]);
    expect(h.journal().attempts[0].confirmDispatched).toBe(true);
  });
});

describe('robot helpers', () => {
  it('downloads only images from the site CDN', async () => {
    const dir = tempDir();
    const ok = async () => new Response(new Uint8Array([0xff, 0xd8]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    const files = await downloadImages(entry('article'), dir, { fetchImpl: ok as typeof fetch });
    expect(files.map((f: string) => path.basename(f))).toEqual(['slide-1.jpg', 'slide-2.jpg']);
    const html = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(downloadImages(entry('article'), dir, { fetchImpl: html as typeof fetch })).rejects.toMatchObject({ errorClass: 'download' });
    await expect(downloadImages({ imageUrls: ['https://evil.example/a.jpg'] }, dir, { fetchImpl: ok as typeof fetch })).rejects.toMatchObject({ errorClass: 'download' });
  });

  it('hides the home folder in paths it publishes', () => {
    expect(displayPath('/home/tester/Library/x', '/home/tester')).toBe('~/Library/x');
  });

  it('prefers real Chrome, then the newest cached Chromium, never a download', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const home = '/home/tester';
    const cached = `${home}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const base = { env: {}, home, platform: 'darwin', listDir: () => ['chromium-1208', 'chromium-1234', 'ffmpeg-1011'] };
    expect(resolveBrowserLaunch({ ...base, exists: (p: string) => p === chrome || p === cached })).toEqual({ channel: 'chrome', kind: 'chrome' });
    expect(resolveBrowserLaunch({ ...base, exists: (p: string) => p === cached })).toEqual({ executablePath: cached, kind: 'cached-chromium' });
    expect(resolveBrowserLaunch({ ...base, env: { SOCIAL_ROBOT_BROWSER_PATH: '/x/chrome' }, exists: () => true })).toEqual({ executablePath: '/x/chrome', kind: 'explicit' });
  });
});

describe('Mac host launch agent', () => {
  const script = path.join(ROOT, 'scripts', 'social-robot', 'launchd.sh');

  it('writes a plist with one calendar entry per window that runs the copy in the state folder', () => {
    const dir = tempDir();
    const env = { ...process.env, SR_NO_LAUNCHCTL: '1', SR_LAUNCH_AGENTS_DIR: path.join(dir, 'agents'), SR_LOG_DIR: path.join(dir, 'logs'), SOCIAL_ROBOT_STATE_DIR: path.join(dir, 'state'), SR_WINDOWS: '09:05 17:45' };
    const plistPath = execFileSync('bash', [script, 'install'], { env, encoding: 'utf8' }).trim();
    const plist = fs.readFileSync(plistPath, 'utf8');
    const windows = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(windows).toEqual(['9:5', '17:45']);
    expect(plist).toContain(`<string>${path.join(dir, 'state', 'launchd.sh')}</string>`);
    expect(fs.existsSync(path.join(dir, 'state', 'launchd.sh'))).toBe(true);
    const bad = spawnSync('bash', [script, 'install'], { env: { ...env, SR_WINDOWS: '24:61' }, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
  });

  it('extracts every relative import of the robot and of the loader into its snapshot', () => {
    const source = fs.readFileSync(script, 'utf8');
    const declared = (source.match(/^snapshot_paths="([^"]+)"/m)?.[1] ?? '').split(/\s+/).filter(Boolean);
    const covered = (rel: string) => declared.some((p) => rel === p || rel.startsWith(`${p}/`));
    const seen = new Set<string>();
    const walk = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const abs = path.join(ROOT, rel);
      for (const spec of importSpecifiers(fs.readFileSync(abs, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        walk(path.relative(ROOT, path.resolve(path.dirname(abs), spec)));
      }
    };
    walk('scripts/social-robot/run.mjs');
    walk('scripts/load-rc-env.mjs');
    const missing = [...seen].filter((rel) => !covered(rel));
    expect(missing).toEqual([]);
  });
});

describe('workflows', () => {
  const wf = (name: string) => YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8'));

  it('serialises the confirm job with the daily poster of the same channel', () => {
    const group = String(wf('social-robot-confirm.yml').concurrency.group);
    for (const channel of wf('social-robot-confirm.yml').on.workflow_dispatch.inputs.channel.options) {
      const resolved = group.replace('${{ inputs.channel }}', channel);
      expect(resolved).toBe(String(wf(`${channel}-daily-broadcast.yml`).concurrency.group));
    }
  });

  it('commits the queue file in the same step that commits the ledger', () => {
    for (const channel of ['instagram', 'tiktok']) {
      const steps = wf(`${channel}-daily-broadcast.yml`).jobs.post.steps as Array<{ name?: string; run?: string }>;
      const commit = steps.find((s) => /git commit/.test(s.run ?? ''));
      expect(commit?.run, channel).toContain(`data/${channel}-queue.json`);
      expect(commit?.run, channel).toContain(`data/${channel}-posted.json`);
    }
  });
});
