import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il chiuditore del feeder `App Error:` (scripts/app-error-issue-sync.mjs →
 * `appErrorReconcile`, regola a due conferme di
 * scripts/lib/monitor-issue-reconcile.mjs).
 *
 * Prima di questo file il feeder coniava e riconfermava ma non chiudeva mai:
 * 7919 e 8773 sono rimaste aperte per settimane con la firma ormai sotto
 * soglia e sono state chiuse a mano il 2026-10-03. Se uno di questi test
 * diventa rosso, il titolo del guasto è:
 * «Feeder app-error: issue aperta con la firma sotto soglia in due report consecutivi»
 * — oppure, nel verso opposto, un chiuditore che chiude su uno zero prodotto
 * da un filtro o da un elenco tagliato.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const readFileSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: unknown[]) => readFileSync(...args) };
});

const appErrorSync = await import('../scripts/app-error-issue-sync.mjs');
const { reconcileMonitorIssues } = await import('../scripts/lib/monitor-issue-reconcile.mjs');
const {
  appErrorReconcile, buildIssueBody, signatureFromIssueBody, signatureOf, titleFor,
} = appErrorSync;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const HOST = 'frontaliereticino.ch';
const CHUNK = 'TypeError: Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/';
const SEO = 'Failed to fetch dynamically imported module: https://cdn.frontaliereticino.ch/assets/seoService.js';
const quiet = () => {};

type Entry = Record<string, unknown>;
const reportOf = (day: string, appErrors: unknown, { complete = true } = {}) => ({
  generated: `${day}T07:12:00.000Z`,
  ga4: {
    errorHealth: {
      totalErrors: 300, errorRate: 0.3, healthStatus: 'ok', appErrors, appErrorsComplete: complete, topStacks: [],
    },
  },
});
const entry = (over: Entry): Entry => ({
  errorType: 'TypeError', errorMessage: 'x is not a function', pagePath: '/it/', hostName: HOST,
  count: 12, users: 3, last7d: 0, lastSeen: daysAgo(20), ...over,
});
/** Il corpo che il feeder scriveva PRIMA del marker: solo le righe Type/Message/Page. */
const legacyBody = (type: string, message: string, page = '/') => [
  '**Workflow:** Weekly Analytics Report — GA4 app_error',
  '',
  `**Type:** ${type}`,
  `**Message:** ${message}`,
  `**Page:** ${page}`,
].join('\n');

/** Una GitHub finta con memoria: i commenti scritti in una run li rilegge la successiva. */
function fakeGithub(issues: Array<Entry>) {
  const writes: string[] = [];
  const comments = new Map<number, Array<{ body: string; created_at: string }>>();
  let clock = Date.now() - 30 * DAY;
  const byNumber = new Map(issues.map((i) => [i.number as number, { state: 'OPEN', labels: [], ...i }]));
  const io = {
    listOpenIssues: () => [...byNumber.values()].filter((i) => i.state === 'OPEN'),
    readIssue: (n: number) => byNumber.get(n) ?? null,
    listComments: (n: number) => comments.get(n) ?? [],
    listEvents: () => [],
    comment: (n: number, body: string) => {
      clock += 60_000;
      comments.set(n, [...(comments.get(n) ?? []), { body, created_at: new Date(clock).toISOString() }]);
      writes.push(`comment #${n}: ${body.split('\n')[0]}`);
      return true;
    },
    close: (n: number) => {
      byNumber.get(n)!.state = 'CLOSED';
      writes.push(`close #${n}`);
      return { number: n, persisted: true };
    },
    removeLabel: () => true,
  };
  const run = async (report: unknown) => {
    clock += DAY;
    return reconcileMonitorIssues({ ...appErrorReconcile(report), io, log: quiet, now: clock });
  };
  return { writes, comments, run };
}

const closeComment = (gh: ReturnType<typeof fakeGithub>, n: number) =>
  (gh.comments.get(n) ?? []).map((c) => c.body).find((b) => b.startsWith('✅')) ?? '';

describe('regola a due report puliti e completi', () => {
  const sig = entry({ errorMessage: 'guarito', count: 40, last7d: 0, lastSeen: daysAgo(15) });
  const issue = { number: 11, title: titleFor(sig), body: buildIssueBody(sig, { errorRate: 0.3, healthStatus: 'ok' }) };

  it('primo report pulito → nota; stesso report rieseguito → niente; report di un altro giorno → chiusura con l\'evidenza', async () => {
    const gh = fakeGithub([issue]);
    const first = reportOf(daysAgo(7), [sig]);

    await gh.run(first);
    expect(gh.writes).toEqual([expect.stringMatching(/^comment #11: 🟢/)]);

    await gh.run(first);
    expect(gh.writes).toHaveLength(1);

    await gh.run(reportOf(daysAgo(0), [sig]));
    expect(gh.writes.slice(1)).toEqual([expect.stringMatching(/^comment #11: ✅/), 'close #11']);
    const evidence = closeComment(gh, 11);
    expect(evidence).toContain('0 hit negli ultimi 7 giorni');
    expect(evidence).toContain('40 nella finestra del report');
    expect(evidence).toContain(`ultima volta ${daysAgo(15)}`);
    expect(evidence).toContain(`report-${daysAgo(7)}`);
    expect(evidence).toContain(`report-${daysAgo(0)}`);
  });

  it('una firma tornata sopra soglia fra i due report non chiude', async () => {
    const gh = fakeGithub([issue]);
    await gh.run(reportOf(daysAgo(7), [sig]));
    await gh.run(reportOf(daysAgo(0), [{ ...sig, last7d: 9, lastSeen: daysAgo(0) }]));
    expect(gh.writes).toEqual([expect.stringMatching(/^comment #11: 🟢/)]);
  });
});

describe('replay delle issue reali', () => {
  // 8612 e 9465 sono state coniate prima del marker: il corpo porta solo Type/Message.
  const news = entry({ errorType: 'error_boundary', errorMessage: `${CHUNK}News`, pagePath: '/en/find-jobs-ticino/', count: 129, users: 11, last7d: 3, lastSeen: daysAgo(4) });
  const jobs = entry({ errorType: 'error_boundary', errorMessage: `${CHUNK}JobsPage.js`, pagePath: '/', count: 9, users: 4, last7d: 2, lastSeen: daysAgo(2) });
  const seo = entry({ errorType: 'api_error', errorMessage: SEO, pagePath: '/', count: 17, users: 10, last7d: 7, lastSeen: daysAgo(1) });
  const i8612 = {
    number: 8612,
    title: 'App Error: error_boundary — TypeError: Failed to fetch dynamically imported module: htt…',
    body: legacyBody('error_boundary', `${CHUNK}News`, '/en/find-jobs-ticino/'),
  };
  const i9465 = {
    number: 9465,
    title: 'App Error: api_error — Failed to fetch dynamically imported module: https://cdn.fr…',
    body: legacyBody('api_error', SEO, '/profilo/'),
  };

  it('i titoli reali sono quelli che `titleFor` conia', () => {
    expect(titleFor(news)).toBe(i8612.title);
    expect(titleFor(seo)).toBe(i9465.title);
  });

  it('8612: 129 hit a 30 giorni, 3 negli ultimi 7 → pulita, anche se il titolo è condiviso con un altro chunk', () => {
    const { verdictFor } = appErrorReconcile(reportOf(daysAgo(0), [news, jobs, seo]));
    const v = verdictFor(i8612);
    expect(v).toMatchObject({ complete: true, clean: true });
    expect(v.evidence).toContain('3 hit negli ultimi 7 giorni');
    expect(v.evidence).toContain('129 nella finestra del report');
  });

  it('9465: la stessa classe ancora sopra soglia nella sua firma → non pulita', () => {
    const { verdictFor } = appErrorReconcile(reportOf(daysAgo(0), [news, jobs, seo]));
    expect(verdictFor(i9465)).toMatchObject({ complete: true, clean: false });
  });

  it('7919: firma finita nella deny-list → nessuna chiusura, evidenza «non misurata»', async () => {
    const i7919 = {
      number: 7919,
      title: 'App Error: unhandled_rejection — InvalidStateError: Object store cannot be found in the data…',
      body: legacyBody('unhandled_rejection', 'InvalidStateError: Object store cannot be found in the database'),
    };
    const gh = fakeGithub([i7919]);
    const out = await gh.run(reportOf(daysAgo(0), [news]));
    await gh.run(reportOf(daysAgo(-7), [news]));
    expect(gh.writes).toEqual([]);
    expect(out.decisions[0].action).toBe('keep');
    expect(out.decisions[0].reason).toContain('non misurata');
  });
});

describe('misura incompleta → zero scritture', () => {
  const sig = entry({ errorMessage: 'sparita', count: 6 });
  const issue = { number: 21, title: titleFor(sig), body: buildIssueBody(sig, { errorRate: 0.3, healthStatus: 'ok' }) };
  const other = entry({ errorMessage: 'altro errore', count: 50, last7d: 1 });

  it('firma assente da un elenco NON completo (top-N tagliato) → complete:false', async () => {
    const gh = fakeGithub([issue]);
    const report = reportOf(daysAgo(0), [other], { complete: false });
    expect(appErrorReconcile(report).verdictFor(issue)).toMatchObject({ complete: false });
    await gh.run(report);
    await gh.run(reportOf(daysAgo(-7), [other], { complete: false }));
    expect(gh.writes).toEqual([]);
  });

  it('firma assente da un elenco COMPLETO → pulita', () => {
    expect(appErrorReconcile(reportOf(daysAgo(0), [other])).verdictFor(issue)).toMatchObject({ complete: true, clean: true });
  });

  it.each([
    ['report mancante', null],
    ['`appErrors` non array', { generated: `${daysAgo(0)}T07:00:00Z`, ga4: { errorHealth: { totalErrors: 3, appErrors: null } } }],
    ['senza data di generazione', { ga4: { errorHealth: { totalErrors: 3, appErrors: [], appErrorsComplete: true } } }],
  ])('%s → zero scritture', async (_label, report) => {
    const gh = fakeGithub([issue]);
    const out = await gh.run(report);
    expect(gh.writes).toEqual([]);
    expect(out.decisions.map((d: { action: string }) => d.action)).toEqual(['keep']);
  });

  it('firma presente senza `last7d` (recenza non misurata) → complete:false', () => {
    // Sotto soglia anche sulla finestra intera: il conio non la riconferma, e
    // la chiusura non ha gli ultimi 7 giorni su cui decidere.
    const { last7d: _drop, ...unmeasured } = { ...sig, count: 3 };
    expect(appErrorReconcile(reportOf(daysAgo(0), [unmeasured])).verdictFor(issue)).toMatchObject({ complete: false });
  });
});

describe('titoli che condividono i primi 60 caratteri', () => {
  const prefix = 'TypeError: Cannot read properties of undefined (reading \'prop';
  const a = entry({ errorMessage: `${prefix}A\') at a.js`, count: 30, last7d: 1 });
  const b = entry({ errorMessage: `${prefix}B\') at b.js`, count: 30, last7d: 25, lastSeen: daysAgo(0) });

  it('lo stesso titolo per due firme diverse', () => {
    expect(titleFor(a)).toBe(titleFor(b));
    expect(signatureOf(a)).not.toEqual(signatureOf(b));
  });

  it('con MONITOR_KEY ciascuna issue è associata alla propria firma', () => {
    // `b` è sopra soglia: il titolo condiviso è caldo e nessuna delle due è pulita;
    // senza `b` sopra soglia, `a` si misura sulla sua firma e non su quella di `b`.
    const quietB = { ...b, last7d: 2 };
    const { verdictFor } = appErrorReconcile(reportOf(daysAgo(0), [a, quietB]));
    const issueA = { number: 31, title: titleFor(a), body: buildIssueBody(a, { errorRate: 0.3, healthStatus: 'ok' }) };
    const issueB = { number: 32, title: titleFor(b), body: buildIssueBody(b, { errorRate: 0.3, healthStatus: 'ok' }) };
    expect(verdictFor(issueA).evidence).toContain('1 hit negli ultimi 7 giorni');
    expect(verdictFor(issueB).evidence).toContain('2 hit negli ultimi 7 giorni');

    const hot = appErrorReconcile(reportOf(daysAgo(0), [a, b])).verdictFor(issueA);
    expect(hot).toMatchObject({ complete: true, clean: false });
  });

  it('senza marker né righe Type/Message e con il titolo ambiguo → complete:false', () => {
    const { verdictFor } = appErrorReconcile(reportOf(daysAgo(0), [a, { ...b, last7d: 2 }]));
    const v = verdictFor({ number: 33, title: titleFor(a), body: 'corpo riscritto a mano' });
    expect(v.complete).toBe(false);
    expect(v.evidence).toContain('titolo ambiguo');
  });

  it('MONITOR_KEY sopravvive a spazi, `|` e `-->` nel messaggio', () => {
    const weird = entry({ errorType: 'unhandled_error', errorMessage: 'a | b --> c   d' });
    const body = buildIssueBody(weird, { errorRate: 0.3, healthStatus: 'ok' });
    expect(body.match(/<!-- MONITOR_KEY: [^\n]* -->/g)).toHaveLength(1);
    expect(signatureFromIssueBody(body)).toMatchObject({ ...signatureOf(weird), source: 'MONITOR_KEY' });
  });
});

describe('main() passa dalla fase «riconcilia» anche quando non conia niente', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    readFileSync.mockReset();
    delete process.env.GH_REPO;
  });

  it('nessuna firma sopra soglia: la issue aperta riceve la prima nota pulita', async () => {
    const sig = entry({ errorMessage: 'guarito', count: 40, last7d: 0 });
    const issue = {
      number: 41, title: titleFor(sig), state: 'OPEN', labels: ['stability', 'app-error'],
      body: buildIssueBody(sig, { errorRate: 0.3, healthStatus: 'ok' }),
    };
    readFileSync.mockReturnValue(JSON.stringify(reportOf(daysAgo(0), [sig])));
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd !== 'gh') return '';
      if (args[0] === 'api' && String(args.at(-3) ?? '').includes('labels=app-error')) return `${JSON.stringify(issue)}\n`;
      if (args[0] === 'api' && /issues\/41$/.test(String(args[1]))) return `${JSON.stringify(issue)}\n`;
      return '';
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await appErrorSync.main();
    logged.mockRestore();

    const ghArgs = execFileSync.mock.calls.filter((c) => c[0] === 'gh').map((c) => c[1] as string[]);
    expect(ghArgs.filter((a) => a[0] === 'issue' && a[1] === 'create')).toEqual([]);
    const comment = ghArgs.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.[2]).toBe('41');
    expect(comment?.[comment.indexOf('--body') + 1]).toContain('MONITOR_CLEAN: family=app-error');
  });
});
