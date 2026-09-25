/**
 * auth-signup-subscriber-monitor — aritmetica e guscio del monitor contro la
 * recidiva del buco iscrizioni-da-login del 12-15/09/2026.
 *
 * I numeri dei casi "incidente" e "baseline" sono quelli misurati in sola
 * lettura su produzione il 2026-09-24 (vedi l'header di
 * scripts/lib/authSignupSubscriberMetrics.mjs): il test fissa che la
 * decisione su QUEI numeri resti quella giusta.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregate,
  evaluate,
  classifySubscriberDoc,
  providerFamily,
  isAuthChannel,
  AUTH_SUBSCRIBER_FLOOR,
} from '../scripts/lib/authSignupSubscriberMetrics.mjs';
import { runCheck, parseArgs, buildIssueBody, readCreatedSubscribers, gateOutputLines } from '../scripts/check-auth-signup-subscribers.mjs';
import { parse as parseYaml } from 'yaml';

type Cls = 'missing' | 'stub' | 'subscribed';
const accountsOf = (n: Record<Cls, number>, hasCreatedAt = true) => (Object.entries(n) as Array<[Cls, number]>)
  .flatMap(([docClass, count]) => Array.from({ length: count }, () => ({ provider: 'google', docClass, hasCreatedAt })));
const rowsOf = (byChannel: Record<string, number>) => Object.entries(byChannel)
  .flatMap(([source_channel, count]) => Array.from({ length: count }, () => ({ source_channel })));

describe('classificazione', () => {
  it('distingue iscritto, stub di profilo e documento assente', () => {
    expect(classifySubscriberDoc(null)).toBe('missing');
    expect(classifySubscriberDoc(undefined)).toBe('missing');
    // Lo stub del 12-15/09: solo profilo, nessuno status.
    expect(classifySubscriberDoc({ auth_uid: 'u', lastLoginAt: 1, name: 'x' })).toBe('stub');
    expect(classifySubscriberDoc({ status: '  ' })).toBe('stub');
    expect(classifySubscriberDoc({ status: 'confirmed' })).toBe('subscribed');
    expect(classifySubscriberDoc({ status: 'unsubscribed' })).toBe('subscribed');
  });

  it('riconosce i canali di login', () => {
    expect(isAuthChannel('auth_google')).toBe(true);
    expect(isAuthChannel('auth_linkedin')).toBe(true);
    expect(isAuthChannel('job_gate')).toBe(false);
    expect(isAuthChannel(null)).toBe(false);
  });

  it('mappa i provider Auth, LinkedIn incluso come custom token', () => {
    expect(providerFamily({ providerData: [{ providerId: 'google.com' }] })).toBe('google');
    expect(providerFamily({ providerData: [{ providerId: 'password' }] })).toBe('email');
    expect(providerFamily({ providerData: [] })).toBe('custom');
    expect(providerFamily(undefined)).toBe('custom');
  });
});

describe('decisione sui numeri misurati', () => {
  it('13/09: 0 iscritti auth_* su 54 account nuovi apre la soglia (p1) e la quota scoperta', () => {
    const agg = aggregate({
      subscriberRows: rowsOf({ job_gate: 16, auth_google: 0 }),
      accounts: [...accountsOf({ subscribed: 39, stub: 0, missing: 0 }, false), ...accountsOf({ subscribed: 0, stub: 15, missing: 0 })],
    });
    const v = evaluate(agg);
    expect(v.alert).toBe(true);
    expect(v.priority).toBe(1);
    const codes = v.findings.map((f) => f.code);
    expect(codes).toContain('auth_subscribers_below_floor');
    expect(codes).toContain('auth_accounts_without_subscription');
    // Il buco di misura: iscritti senza created_at, informativo.
    expect(codes).toContain('created_at_missing');
    expect(v.findings.find((f) => f.code === 'created_at_missing')!.alert).toBe(false);
  });

  it('11/09 e 17/09: 81 iscritti auth_* su ~100 account nuovi e 2% scoperti sono verdi', () => {
    for (const [auth, subscribed, stub] of [[81, 89, 2], [81, 102, 0]]) {
      const agg = aggregate({
        subscriberRows: rowsOf({ auth_google: auth, job_gate: 15 }),
        accounts: accountsOf({ subscribed, stub, missing: 0 }),
      });
      expect(evaluate(agg)).toMatchObject({ alert: false, priority: null });
    }
  });

  it('senza traffico la soglia iscritti non si valuta', () => {
    const agg = aggregate({ subscriberRows: [], accounts: accountsOf({ subscribed: 3, stub: 0, missing: 0 }) });
    const v = evaluate(agg);
    expect(v.alert).toBe(false);
    expect(v.findings.map((f) => f.code)).toEqual(['low_traffic']);
  });

  it('zero account nuovi non e\' un verde: login rotto o lettura cieca', () => {
    const v = evaluate(aggregate({ subscriberRows: rowsOf({ auth_google: 50 }), accounts: [] }));
    expect(v.alert).toBe(true);
    expect(v.findings[0].code).toBe('no_auth_accounts');
  });

  it('la soglia e\' stretta: esattamente AUTH_SUBSCRIBER_FLOOR iscritti non allarma', () => {
    const agg = aggregate({
      subscriberRows: rowsOf({ auth_linkedin: AUTH_SUBSCRIBER_FLOOR }),
      accounts: accountsOf({ subscribed: 40, stub: 0, missing: 0 }),
    });
    expect(evaluate(agg).alert).toBe(false);
    const below = aggregate({
      subscriberRows: rowsOf({ auth_linkedin: AUTH_SUBSCRIBER_FLOOR - 1 }),
      accounts: accountsOf({ subscribed: 40, stub: 0, missing: 0 }),
    });
    expect(evaluate(below).alert).toBe(true);
  });
});

/* ── Guscio: runCheck con Firestore/Auth finti ──────────────── */

/**
 * Firestore finto con paginazione vera: `orderBy` e' obbligatorio (senza,
 * `startAfter` non ha un ordine deterministico), `startAfter` riparte dopo il
 * documento passato, `limit` taglia la pagina.
 */
function fakeCreatedCollection(created: Array<{ source_channel: string | null }>, calls: { gets: number }) {
  const all = created.map((row, i) => ({ __i: i, get: (k: string) => (row as any)[k] }));
  const make = (state: { ordered: boolean; after: number; limit: number }): any => ({
    where: () => make(state),
    orderBy: (field: string) => { expect(field).toBe('created_at'); return make({ ...state, ordered: true }); },
    startAfter: (d: { __i: number }) => make({ ...state, after: d.__i + 1 }),
    limit: (n: number) => make({ ...state, limit: n }),
    get: async () => {
      calls.gets++;
      expect(state.ordered, 'query paginata senza orderBy').toBe(true);
      const docs = all.slice(state.after, state.after + state.limit);
      return { size: docs.length, docs };
    },
    doc: (id: string) => ({ id }),
  });
  return make({ ordered: false, after: 0, limit: Infinity });
}

function fakeDeps(opts: {
  created: Array<{ source_channel: string | null }>;
  users: Array<{ email?: string; creationTime: string; providerId?: string }>;
  docs: Record<string, Record<string, unknown>>;
  failListUsers?: boolean;
}) {
  const calls = { gets: 0 };
  const db = {
    calls,
    collection: (name: string) => {
      expect(name).toBe('newsletter_subscribers');
      return fakeCreatedCollection(opts.created, calls);
    },
    getAll: async (...refs: Array<{ id: string }>) => refs.map((r) => ({
      exists: r.id in opts.docs,
      data: () => opts.docs[r.id],
    })),
  };
  const auth = {
    listUsers: async (_n: number, token?: string) => {
      if (opts.failListUsers) throw new Error('PERMISSION_DENIED: auth/insufficient-permission');
      // Due pagine, per coprire la paginazione.
      const half = Math.ceil(opts.users.length / 2);
      const slice = token ? opts.users.slice(half) : opts.users.slice(0, half);
      return {
        users: slice.map((u) => ({
          email: u.email,
          metadata: { creationTime: u.creationTime },
          providerData: u.providerId ? [{ providerId: u.providerId }] : [],
        })),
        pageToken: token ? undefined : 'p2',
      };
    },
  };
  return { db, auth };
}

describe('runCheck — guscio I/O', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-signup-')); dirs.push(d); return d; };

  const until = new Date('2026-09-13T07:25:00Z');
  const inWindow = '2026-09-12T20:00:00Z';
  const outOfWindow = '2026-09-10T20:00:00Z';

  it('allarma sul buco, scrive alert.json e storia senza alcuna email', async () => {
    const users = Array.from({ length: 20 }, (_, i) => ({
      email: `Utente${i}@Example.com`, creationTime: inWindow, providerId: 'google.com',
    }));
    users.push({ email: 'vecchio@example.com', creationTime: outOfWindow, providerId: 'google.com' });
    const docs: Record<string, Record<string, unknown>> = {};
    // 12 stub di solo profilo, 8 iscritti via gate: il 13/09 in piccolo.
    for (let i = 0; i < 12; i++) docs[`utente${i}@example.com`] = { auth_uid: `u${i}`, lastLoginAt: 1 };
    for (let i = 12; i < 20; i++) docs[`utente${i}@example.com`] = { status: 'confirmed', source_channel: 'auth_google' };
    const outDir = tmp();
    const { agg, verdict } = await runCheck({
      ...fakeDeps({ created: [{ source_channel: 'job_gate' }, { source_channel: 'auth_google' }], users, docs }),
      until, outDir,
    });
    expect(agg.accountsTotal).toBe(20);
    expect(agg.accountClasses).toEqual({ subscribed: 8, stub: 12, missing: 0 });
    expect(agg.authSubscribers).toBe(1);
    expect(verdict.alert).toBe(true);

    const alert = JSON.parse(fs.readFileSync(path.join(outDir, 'alert.json'), 'utf8'));
    expect(alert.priority).toBe(1);
    expect(alert.title).toMatch(/^\[auth-signup\] auth_subscribers_below_floor: /);
    expect(alert.title.slice(0, 60)).toContain('auth_subscribers_below_floor');
    const history = JSON.parse(fs.readFileSync(path.join(outDir, 'history.json'), 'utf8'));
    expect(history.days).toHaveLength(1);
    expect(history.days[0]).toMatchObject({ date: '2026-09-13', authSubscribers: 1, accountsTotal: 20 });
    for (const f of ['alert.json', 'history.json']) {
      expect(fs.readFileSync(path.join(outDir, f), 'utf8')).not.toMatch(/@example\.com/i);
    }
  });

  it('un giro pulito cancella alert.json (la condizione di chiusura della issue)', async () => {
    const outDir = tmp();
    fs.writeFileSync(path.join(outDir, 'alert.json'), '{}');
    const users = Array.from({ length: 15 }, (_, i) => ({ email: `a${i}@example.com`, creationTime: inWindow, providerId: 'google.com' }));
    const docs = Object.fromEntries(users.map((u) => [u.email, { status: 'confirmed', created_at: 1 }]));
    const created = Array.from({ length: 15 }, () => ({ source_channel: 'auth_google' }));
    const { verdict } = await runCheck({ ...fakeDeps({ created, users, docs }), until, outDir });
    expect(verdict.alert).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'alert.json'))).toBe(false);
  });

  it('--dry-run non scrive nulla', async () => {
    const outDir = tmp();
    await runCheck({ ...fakeDeps({ created: [], users: [], docs: {} }), until, outDir, dryRun: true });
    expect(fs.readdirSync(outDir)).toEqual([]);
  });
});

describe('lettura paginata — nessun verdetto su una popolazione troncata', () => {
  const since = new Date('2026-09-12T07:25:00Z');
  const until = new Date('2026-09-13T07:25:00Z');

  it('legge tutte le pagine oltre la dimensione di pagina', async () => {
    const created = Array.from({ length: 2500 }, (_, i) => ({ source_channel: i % 2 ? 'auth_google' : 'job_gate' }));
    const { db } = fakeDeps({ created, users: [], docs: {} });
    const rows = await readCreatedSubscribers(db, since, until, { pageSize: 1000 });
    expect(rows).toHaveLength(2500);
    expect(rows.filter((r: any) => r.source_channel === 'auth_google')).toHaveLength(1250);
    expect(db.calls.gets).toBe(3);
  });

  it('una pagina esattamente piena chiede la successiva (vuota) e si ferma', async () => {
    const created = Array.from({ length: 1000 }, () => ({ source_channel: 'auth_google' }));
    const { db } = fakeDeps({ created, users: [], docs: {} });
    const rows = await readCreatedSubscribers(db, since, until, { pageSize: 1000 });
    expect(rows).toHaveLength(1000);
    expect(db.calls.gets).toBe(2);
  });

  it('oltre il tetto di pagine lancia invece di dare un verdetto', async () => {
    const created = Array.from({ length: 30 }, () => ({ source_channel: 'auth_google' }));
    const { db } = fakeDeps({ created, users: [], docs: {} });
    await expect(readCreatedSubscribers(db, since, until, { pageSize: 10, maxPages: 2 })).rejects.toThrow(/nessun verdetto/);
  });

  it('runCheck conta l\'intera finestra anche su piu\' pagine', async () => {
    const created = Array.from({ length: 25 }, () => ({ source_channel: 'auth_google' }));
    const users = Array.from({ length: 12 }, (_, i) => ({ email: `p${i}@example.com`, creationTime: '2026-09-12T20:00:00Z', providerId: 'google.com' }));
    const docs = Object.fromEntries(users.map((u) => [u.email, { status: 'confirmed', created_at: 1 }]));
    const { agg } = await runCheck({ ...fakeDeps({ created, users, docs }), until, dryRun: true, pageSize: 10 });
    expect(agg.authSubscribers).toBe(25);
  });
});

describe('gate di chiusura — solo dopo una misura riuscita e verde', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-signup-gate-')); dirs.push(d); return d; };
  const until = new Date('2026-09-13T07:25:00Z');
  const cleanUsers = Array.from({ length: 12 }, (_, i) => ({ email: `g${i}@example.com`, creationTime: '2026-09-12T20:00:00Z', providerId: 'google.com' }));
  const cleanDocs = Object.fromEntries(cleanUsers.map((u) => [u.email, { status: 'confirmed', created_at: 1 }]));
  const cleanCreated = Array.from({ length: 12 }, () => ({ source_channel: 'auth_google' }));

  it('gateOutputLines dichiara la misura e il verdetto', () => {
    expect(gateOutputLines({ alert: false })).toEqual(['measured=true', 'alert=false']);
    expect(gateOutputLines({ alert: true })).toEqual(['measured=true', 'alert=true']);
  });

  it('giro pulito: GITHUB_OUTPUT riceve measured=true e alert=false', async () => {
    const dir = tmp();
    const out = path.join(dir, 'gh-output');
    await runCheck({ ...fakeDeps({ created: cleanCreated, users: cleanUsers, docs: cleanDocs }), until, outDir: dir, githubOutput: out });
    expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toEqual(['measured=true', 'alert=false']);
  });

  it('crash di lettura Auth: nessun measured, alert.json esistente intatto', async () => {
    const dir = tmp();
    const out = path.join(dir, 'gh-output');
    fs.writeFileSync(path.join(dir, 'alert.json'), '{"title":"[auth-signup] x"}');
    await expect(runCheck({
      ...fakeDeps({ created: cleanCreated, users: cleanUsers, docs: cleanDocs, failListUsers: true }),
      until, outDir: dir, githubOutput: out,
    })).rejects.toThrow(/PERMISSION_DENIED/);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'alert.json'))).toBe(true);
  });

  it('il workflow chiude le issue solo con measured=true e alert=false, e instrada il crash al reporter', () => {
    const wf = parseYaml(fs.readFileSync(path.join(__dirname, '..', '.github/workflows/auth-signup-subscriber-monitor.yml'), 'utf8'));
    const steps: Array<{ name: string; id?: string; if?: string }> = wf.jobs.check.steps;
    const byName = (re: RegExp) => { const s = steps.find((x) => re.test(x.name)); expect(s, String(re)).toBeDefined(); return s!; };
    const cond = (s: { if?: string }) => String(s.if || '').replace(/\s+/g, ' ');

    const close = byName(/^Close recovered/);
    expect(cond(close)).toContain("steps.check.outputs.measured == 'true'");
    expect(cond(close)).toContain("steps.check.outputs.alert == 'false'");

    for (const s of [byName(/^Open issue/), byName(/^Fail if threshold/)]) {
      expect(cond(s)).toContain("steps.check.outputs.measured == 'true'");
      expect(cond(s)).toContain("steps.check.outputs.alert == 'true'");
      expect(cond(s)).not.toMatch(/steps\.check\.outcome == 'failure'\s*$/);
    }

    const crash = byName(/^Fail if measurement did not complete/);
    expect(cond(crash)).toContain("steps.check.outputs.measured != 'true'");
    const reporter = byName(/^Report unexpected failure/);
    expect(cond(reporter)).toContain("steps.failgate.conclusion != 'failure'");
    expect(steps.indexOf(crash)).toBeLessThan(steps.indexOf(reporter));
    expect(byName(/^Fail if threshold/).id).toBe('failgate');
  });

  it('firebase-admin arriva dal lockfile via npm ci, non da un install separato', () => {
    const wf = parseYaml(fs.readFileSync(path.join(__dirname, '..', '.github/workflows/auth-signup-subscriber-monitor.yml'), 'utf8'));
    const steps: Array<{ name: string; run?: string }> = wf.jobs.check.steps;
    const install = steps.find((s) => /^Install dependencies$/.test(s.name));
    expect(install, 'Install dependencies step').toBeDefined();
    expect(String(install!.run || '')).toMatch(/npm ci(?!\s*--omit=dev)/);
    expect(String(install!.run || '')).not.toMatch(/--omit=dev/);

    const src = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/auth-signup-subscriber-monitor.yml'), 'utf8');
    expect(src).not.toMatch(/npm install --no-save(?:--no-package-lock)?\s+["']?firebase-admin@latest/);
    expect(steps.some((s) => /^Install firebase-admin/.test(s.name))).toBe(false);
  });
});

describe('CLI e corpo della issue', () => {
  it('parseArgs legge finestra e replay, e rifiuta una data invalida', () => {
    expect(parseArgs([])).toMatchObject({ hours: 24, until: null, json: false, dryRun: false });
    const a = parseArgs(['--hours=48', '--until=2026-09-14T07:25:00Z', '--json', '--dry-run']);
    expect(a.hours).toBe(48);
    expect(a.until!.toISOString()).toBe('2026-09-14T07:25:00.000Z');
    expect(a.json && a.dryRun).toBe(true);
    expect(() => parseArgs(['--until=ieri'])).toThrow(/ISO/);
  });

  it('il COMANDO della scheda e\' la variante che non conia la issue', () => {
    const agg = aggregate({ subscriberRows: [], accounts: accountsOf({ subscribed: 20, stub: 20, missing: 0 }) });
    const body = buildIssueBody(agg, evaluate(agg), { hours: 24, since: 'a', until: 'b' });
    expect(body).toMatch(/\*\*COMANDO\*\*: `node scripts\/check-auth-signup-subscribers\.mjs --json --dry-run`/);
  });
});
