/**
 * Un crawler RITIRATO con evidenza chiude le sue issue di FALLIMENTO; un
 * ritiro da sola soglia automatica, senza tracker aperto, no.
 *
 * Caso misurato: la issue 10083 («Crawler Failure: Run knowledge-lab») e'
 * rimasta aperta dal 30-09 al 03-10 con il crawler gia' ritirato, perche'
 * close-recovered-failure-issues.mjs cerca lo step `Run <slug>` nel roster e,
 * non trovandolo, la tiene aperta. knowledge-lab era ritirato dalla soglia
 * automatica («11 ondate rosse consecutive (soglia 10)») con il tracker 10662
 * gia' chiuso: quel ritiro NON e' evidenza, e la sua issue va segnalata, non
 * chiusa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const {
  RETIRED_WITHOUT_EVIDENCE_TITLE,
  countCrawlerGroupWorkflows,
  failureFamilyOf,
  judgeRetiredSlug,
  planRetiredClosures,
  retiredClosureNote,
  trackerRef,
} = await import('../scripts/ci/close-retired-crawler-issues.mjs');
const { automaticRetireReason, decideQuarantine, isAutomaticRetireReason } = await import('../scripts/lib/crawler-quarantine.mjs');
const { findCrawlerGroupWorkflow } = await import('../scripts/ci/close-recovered-failure-issues.mjs');
const { resolveGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

// Forma reale delle voci `retired` di data/crawler-quarantine.json al 03-10.
const KNOWLEDGE_LAB = {
  retiredAt: '2026-09-30T23:17:26Z',
  issue: 10662,
  homeGroup: 15,
  reason: '11 ondate rosse consecutive (soglia 10)',
};
const BALLY = {
  retiredAt: '2026-10-03T13:45:10Z',
  issue: 11073,
  homeGroup: 18,
  reason: "La pagina ufficiale careers ora instrada a LinkedIn; il tenant SmartRecruiters del crawler non pubblica piu' annunci",
};

const issue = (number: number, title: string, labels: string[] = []) => ({ number, title, labels });
const plan = (retired: Record<string, any>, openIssues: any[], opts: { roster?: string[], trackers?: Record<number, string | null>, max?: number } = {}) => {
  const trackerReads: number[] = [];
  const result = planRetiredClosures({
    registry: { retired },
    openIssues,
    inRoster: (slug: string) => (opts.roster ?? []).includes(slug),
    trackerState: (n: number) => {
      trackerReads.push(n);
      // `null` (non leggibile) e' un valore del test, non un'assenza.
      return opts.trackers && n in opts.trackers ? opts.trackers[n] : 'CLOSED';
    },
    ...(opts.max ? { max: opts.max } : {}),
  });
  return { ...result, trackerReads };
};

describe('chi decide «ritiro da soglia automatica»', () => {
  it('il motivo che decideQuarantine scrive viene riconosciuto, in entrambi i rami', () => {
    const member = { homeGroup: 13, enteredAt: '2026-09-20T00:00:00Z', failingSince: '2026-09-29T00:00:00Z', issue: 42 };
    const wave = (i: number) => ({
      runId: 1000 + i,
      createdAt: new Date(Date.parse('2026-09-21T09:00:00Z') + i * 12 * 3600_000).toISOString(),
      source: 'notice',
      outcomes: { x: 'failure' },
    });
    const registry = (failingSince: string) => ({ schemaVersion: 1, group: 24, members: { x: { ...member, failingSince } }, retired: {} });
    const byWaves = decideQuarantine({
      registry: registry('2026-09-29T00:00:00Z'),
      waves: Array.from({ length: 12 }, (_, i) => wave(i)),
      now: '2026-09-30T12:00:00Z',
    })[0];
    const byDays = decideQuarantine({ registry: registry('2026-09-20T11:00:00Z'), waves: [wave(0)], now: '2026-09-30T12:00:00Z' })[0];
    expect(byWaves.action).toBe('retire');
    expect(byDays.action).toBe('retire');
    expect(byWaves.reason).not.toBe(byDays.reason);
    expect(isAutomaticRetireReason(byWaves.reason)).toBe(true);
    expect(isAutomaticRetireReason(byDays.reason)).toBe(true);
    expect(byWaves.reason).toBe(automaticRetireReason({ streak: 12, retireRedWaves: 10, days: 1.5, failingSince: '2026-09-29T00:00:00Z', retireDays: 7 }));
  });

  it('il motivo reale di knowledge-lab e\' automatico, quelli scritti a mano no', () => {
    expect(isAutomaticRetireReason(KNOWLEDGE_LAB.reason)).toBe(true);
    expect(isAutomaticRetireReason(BALLY.reason)).toBe(false);
    expect(isAutomaticRetireReason('11 ondate rosse consecutive (soglia 10); fonte: careers chiusa')).toBe(false);
    expect(isAutomaticRetireReason(undefined)).toBe(false);
  });
});

describe('planRetiredClosures', () => {
  it('ritiro con motivo manuale + `Crawler Failure: Run <slug>` aperta → una chiusura', () => {
    const r = plan({ bally: BALLY }, [issue(501, 'Crawler Failure: Run bally')]);
    expect(r.closures.map((c: any) => [c.number, c.family])).toEqual([[501, 'crawler-failure']]);
    expect(r.warnings).toEqual([]);
    // Il motivo basta: il tracker non si legge nemmeno.
    expect(r.trackerReads).toEqual([]);
  });

  it('replay 10083: ritiro da soglia automatica con tracker chiuso → zero chiusure e warning', () => {
    const r = plan({ 'knowledge-lab': KNOWLEDGE_LAB }, [issue(10083, 'Crawler Failure: Run knowledge-lab')], {
      trackers: { 10662: 'CLOSED' },
    });
    expect(r.closures).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ slug: 'knowledge-lab', kind: 'no-evidence', issues: [10083] });
    expect(r.warnings[0].warning).toContain('ritiro senza tracker aperto né evidenza');
    expect(r.warnings[0].warning).toContain('#10662');
    expect(RETIRED_WITHOUT_EVIDENCE_TITLE).toContain('senza tracker aperto né evidenza');
  });

  it('lo stesso ritiro senza issue di fallimento aperte resta visibile come warning', () => {
    const r = plan({ 'knowledge-lab': KNOWLEDGE_LAB }, []);
    expect(r.closures).toEqual([]);
    expect(r.warnings.map((w: any) => [w.slug, w.kind, w.issues])).toEqual([['knowledge-lab', 'no-evidence', []]]);
  });

  it('un tracker non leggibile non vale come aperto (fail-closed)', () => {
    const r = plan({ 'knowledge-lab': KNOWLEDGE_LAB }, [issue(10083, 'Crawler Failure: Run knowledge-lab')], {
      trackers: { 10662: null },
    });
    expect(r.closures).toEqual([]);
    expect(r.warnings[0].warning).toContain('non leggibile');
  });

  it('ritiro da soglia automatica con tracker APERTO → chiusura', () => {
    const r = plan({ 'knowledge-lab': KNOWLEDGE_LAB }, [issue(10083, 'Crawler Failure: Run knowledge-lab')], {
      trackers: { 10662: 'OPEN' },
    });
    expect(r.closures.map((c: any) => c.number)).toEqual([10083]);
    expect(r.trackerReads).toEqual([10662]);
  });

  it('slug ritirato ancora presente in un crawler-group-*.yml → zero chiusure', () => {
    const r = plan({ bally: BALLY }, [issue(501, 'Crawler Failure: Run bally')], { roster: ['bally'] });
    expect(r.closures).toEqual([]);
    expect(r.warnings[0]).toMatchObject({ kind: 'roster-disagreement', issues: [501] });
  });

  it('il roster si legge davvero da crawler-group-*.yml (findCrawlerGroupWorkflow)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-roster-'));
    try {
      fs.writeFileSync(path.join(dir, 'crawler-group-18.yml'), [
        'name: Crawler Group 18 (1 crawlers)',
        'jobs:',
        '  crawl:',
        '    steps:',
        '      - name: Run bally',
        '        id: crawler-bally',
        '',
      ].join('\n'));
      expect(findCrawlerGroupWorkflow('bally', dir)).not.toBeNull();
      expect(findCrawlerGroupWorkflow('pzm-muensingen', dir)).toBeNull();
      const r = planRetiredClosures({
        registry: { retired: { bally: BALLY } },
        openIssues: [issue(501, 'Crawler Failure: Run bally')],
        inRoster: (slug: string) => findCrawlerGroupWorkflow(slug, dir) !== null,
        trackerState: () => 'CLOSED',
      });
      expect(r.closures).toEqual([]);
      expect(r.warnings[0].kind).toBe('roster-disagreement');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('issue protette e famiglie altrui non si toccano', () => {
    const r = plan({ bally: BALLY }, [
      issue(501, 'Crawler Failure: Run bally', ['keep-open']),
      issue(502, '[parser-health] bally: slice would shrink to 10% of prior (2/20)', ['agent:in-progress']),
      issue(503, 'Crawler ritirato: bally'),
      issue(504, '[crawler-health] bally: crawler unhealthy'),
      issue(505, 'Crawler in quarantena: bally'),
    ]);
    expect(r.closures).toEqual([]);
    expect(r.skipped.map((s: any) => s.number)).toEqual([501, 502]);
  });

  it('chiude anche `[parser-health] <slug>:` (nessun altro chiuditore), con match esatto sullo slug', () => {
    const r = plan({ bally: BALLY }, [
      issue(601, '[parser-health] bally: 9/10 jobs have boilerplate-only descriptions'),
      issue(602, '[parser-health] bally-group: 9/10 jobs have boilerplate-only descriptions'),
      issue(603, 'Crawler Failure: Run bally-group'),
    ]);
    expect(r.closures.map((c: any) => [c.number, c.family])).toEqual([[601, 'parser-health']]);
  });

  it('`knowledge-lab-2` non ritirato non viene toccato (match esatto)', () => {
    const r = plan({ 'knowledge-lab': KNOWLEDGE_LAB }, [
      issue(701, 'Crawler Failure: Run knowledge-lab-2'),
      issue(702, '[parser-health] knowledge-lab-2: slice would shrink to 10% of prior (2/20)'),
    ], { trackers: { 10662: 'OPEN' } });
    expect(r.closures).toEqual([]);
    expect(failureFamilyOf('Crawler Failure: Run knowledge-lab-2', 'knowledge-lab')).toBeNull();
    expect(failureFamilyOf('Crawler Failure: Run knowledge-lab', 'knowledge-lab')).toBe('crawler-failure');
  });

  it('tetto per run: l\'eccedenza resta alla run successiva', () => {
    const max = 3;
    const many = Array.from({ length: max + 2 }, (_, i) => issue(800 + i, `[parser-health] bally: shrink ${i}`));
    const r = plan({ bally: BALLY }, many, { max });
    expect(r.closures).toHaveLength(max);
    expect(r.deferred).toHaveLength(many.length - max);
  });

  it('roster non leggibile (nessun crawler-group-NN.yml) = zero, non «nessuno slug nel roster»', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-roster-empty-'));
    try {
      expect(countCrawlerGroupWorkflows(dir)).toBe(0);
      expect(countCrawlerGroupWorkflows(path.join(dir, 'missing'))).toBe(0);
      fs.writeFileSync(path.join(dir, 'crawler-group-07.yml'), 'name: Crawler Group 7 (0 crawlers)\n');
      fs.writeFileSync(path.join(dir, 'crawler-health-monitor.yml'), 'name: x\n');
      expect(countCrawlerGroupWorkflows(dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un ritiro da soglia senza `issue` dice «nessun tracker», non «#undefined»', () => {
    const { issue: _drop, ...noIssue } = KNOWLEDGE_LAB;
    const r = plan({ 'knowledge-lab': noIssue }, []);
    expect(r.warnings[0].kind).toBe('no-evidence');
    expect(r.warnings[0].warning).toContain('nessun tracker');
    expect(r.warnings[0].warning).not.toContain('undefined');
    expect(trackerRef(KNOWLEDGE_LAB)).toBe(`#${KNOWLEDGE_LAB.issue}`);
  });

  it('una voce senza retiredAt non chiude', () => {
    expect(judgeRetiredSlug({ slug: 'x', entry: { ...BALLY, retiredAt: undefined }, inRoster: false, trackerState: 'OPEN' }))
      .toMatchObject({ closable: false, kind: 'no-retired-at' });
  });

  it('il commento cita la voce `retired` (data, motivo, tracker)', () => {
    const note = retiredClosureNote({ slug: 'bally', entry: BALLY, evidence: 'motivo manuale' });
    expect(note).toContain(BALLY.retiredAt);
    expect(note).toContain(BALLY.reason);
    expect(note).toContain(`#${BALLY.issue}`);
  });
});

describe('resolveGithubIssue: opzione `reason`', () => {
  const title = 'Crawler Failure: Run bally';
  beforeEach(() => {
    execFileSync.mockReset();
    delete process.env.GH_REPO;
    delete process.env.ENABLE_FAILURE_REPORT;
    delete process.env.TRUSTED_GH_BIN;
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 501, title, url: 'u', state: 'OPEN' }]);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED' });
      return '';
    });
  });
  const ghCall = (verb: string) => execFileSync.mock.calls
    .map((call) => call[1] as string[])
    .find((args) => args[0] === 'issue' && args[1] === verb);

  it('senza `reason` chiude `completed` col commento di sempre (invariato)', () => {
    expect(resolveGithubIssue(title, { exactTitle: true })?.number).toBe(501);
    expect(ghCall('close')).toEqual(expect.arrayContaining(['--reason', 'completed']));
    expect(ghCall('comment')?.join(' ')).toContain('green again');
  });

  it('con `not_planned` chiude «not planned» e dice che il soggetto e\' ritirato', () => {
    expect(resolveGithubIssue(title, { exactTitle: true, reason: 'not_planned' })?.persisted).toBe(true);
    expect(ghCall('close')).toEqual(expect.arrayContaining(['--reason', 'not planned']));
    const body = ghCall('comment')?.join(' ') ?? '';
    expect(body).toContain('ritirato');
    expect(body).not.toContain('green again');
  });

  it('un valore sconosciuto e\' un errore, prima di qualunque chiamata gh', () => {
    expect(() => resolveGithubIssue(title, { reason: 'wontfix' as any })).toThrow(/unknown --reason/);
    expect(() => resolveGithubIssue(title, { reason: '' as any })).toThrow(/unknown --reason/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('CLI `--resolve [--reason …]`', () => {
  const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'lib', 'github-issue-creator.mjs');
  const title = 'Crawler Failure: Run bally';

  // Un `gh` finto (TRUSTED_GH_BIN) che registra gli argomenti: il CLI gira in un
  // processo vero, quindi qui il mock di node:child_process non c'entra.
  function fakeGh() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-reason-'));
    const log = path.join(dir, 'calls.log');
    const fake = path.join(dir, 'gh');
    fs.writeFileSync(fake, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$1 $2" in',
      `  "issue list") printf '%s' '[{"number":501,"title":"${title}","url":"u","state":"OPEN"}]' ;;`,
      `  "issue view") printf '%s' '{"state":"CLOSED"}' ;;`,
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    return { dir, log, fake };
  }

  async function cli(extra: string[]) {
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const { dir, log, fake } = fakeGh();
    try {
      const res = real.spawnSync(process.execPath, [SCRIPT, '--resolve', '--title', title, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, TRUSTED_GH_BIN: fake, ENABLE_FAILURE_REPORT: 'true', GH_REPO: '', GITHUB_STEP_SUMMARY: '' },
      });
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      return { status: res.status, calls, stderr: res.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('senza `--reason` chiude `completed` (invariato)', async () => {
    const r = await cli([]);
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^issue close 501 --reason completed$/m);
  });

  it('con `--reason not_planned` chiude `not planned`', async () => {
    const r = await cli(['--reason', 'not_planned']);
    expect(r.status).toBe(0);
    expect(r.calls).toMatch(/^issue close 501 --reason not planned$/m);
  });

  it('un valore sconosciuto (o mancante) esce 1 senza chiudere niente', async () => {
    for (const extra of [['--reason', 'wontfix'], ['--reason']]) {
      const r = await cli(extra);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('unknown --reason');
      expect(r.calls).not.toContain('issue close');
    }
  });
});
