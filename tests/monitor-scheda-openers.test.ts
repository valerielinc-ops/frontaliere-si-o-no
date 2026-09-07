/**
 * Ogni opener di monitor emette `OSSERVATORE` e `COMANDO`.
 *
 * ─── Perche' questa rete e non un'altra ──────────────────────────────────
 *
 * `tests/failure-issue-closers.test.ts` copre gia' l'altra meta': che per ogni
 * titolo coniato esista QUALCUNO che lo chiude. Non e' la stessa domanda.
 * Quella rete verifica che un chiuditore esista; questa verifica che la issue
 * dica **a quale condizione osservabile** si chiude, e con quale comando la si
 * verifica. `crawler-health` passava la prima e falliva la seconda: aveva un
 * closer funzionante e la sua condizione viveva solo nel codice di quel closer,
 * invisibile a chi la issue la raccoglie.
 *
 * La meta' che conta e' `COMANDO`: un nome si scrive, un comando si esegue.
 * Il test non lo ESEGUE — l'esecuzione e' una decisione aperta del proprietario
 * (scheda `03-forma-dell-osservatore`, D8) — ma pretende che ci sia, che stia su
 * una riga sola e che non sia un segnaposto.
 */
import { describe, expect, it } from 'vitest';
import { buildScheda } from '../scripts/lib/monitor-scheda.mjs';
import { buildAlertBody } from '../scripts/audit-canton-url-drift.mjs';
import { buildHealthScheda } from '../scripts/check-crawler-health.mjs';
import { buildFailBody, buildReadyBody } from '../scripts/dmarc-monitor.mjs';
import { buildIssueBody as buildCf5xxBody } from '../scripts/cf-5xx-issue-sync.mjs';
import { buildIssueBody as buildAppErrorBody } from '../scripts/app-error-issue-sync.mjs';
import { buildIssueBody as buildPostHogBody } from '../scripts/posthog-error-issue-sync.mjs';
import { buildIssueBody as buildCwvBody } from '../scripts/cwv-monitor-check.mjs';
import { buildIssueBody as buildTelegramBody } from '../scripts/monitor-telegram-member-count.mjs';
import { buildIssueBody as buildCampaignGoalBody } from '../scripts/campaign-goal-check.mjs';
import { buildIndexationIssueBody, buildStructuredDataIssueBody } from '../scripts/monitor-gsc-job-indexation.mjs';
import { buildIssueBody as buildSourceLivenessBody } from '../scripts/check-source-liveness.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Il corpo di ogni opener, con l'input minimo che lo fa rendere. */
const OPENERS: Array<[string, () => string]> = [
  ['canton-url-drift', () => buildAlertBody(
    {
      date: '2026-09-14', base: 'abc12345678', days: 7, shards: [0, 6, 12, 19, 25],
      common: 44634, drifted: 351, rate: 0.0079, totalSlugs: 304263, projectedUrlsPerWindow: 9571,
      direction: { towards: 101, away: 118, lateral: 74, unresolved: 58 },
    },
    { reason: 'due run consecutivi sopra la soglia', baseline: 0.0079, threshold: 0.00395 },
    '2026-09-07 0.80% → 2026-09-14 0.79%',
  )],
  ['crawler-health', () => buildHealthScheda({
    slug: 'acme', status: 'broken', reason: '3 consecutive runs returned 0 jobs', consecutiveEmptyRuns: 3,
  })],
  ['dmarc (fail)', () => buildFailBody(
    {
      total: 1000, totalPass: 900, totalFail: 100, sources: [],
      failingSources: [{ org: 'acme', known: false, total: 80, fail: 80, pass: 0, topFailIP: '1.2.3.4' }],
    },
    7, '2026-09-01', 'none',
  )],
  ['dmarc (ready)', () => buildReadyBody(
    { total: 1000, totalPass: 1000, totalFail: 0, sources: [], failingSources: [] },
    7, '2026-09-01', 'quarantine',
  )],
  ['cf-5xx', () => buildCf5xxBody(
    { url: 'cdn.frontaliereticino.ch/assets/x.js', status: 502, count: 24, shape: null }, '23',
  )],
  ['app-error', () => buildAppErrorBody(
    { errorType: 'TypeError', errorMessage: 'x is not a function', pagePath: '/it/', count: 42, users: 12 },
    { errorRate: 0.4, healthStatus: 'ok', stack: undefined },
  )],
  ['posthog', () => buildPostHogBody({
    type: 'TypeError', message: 'x is not a function', count: 42, sessions: 12,
    sampleUrl: 'https://frontaliereticino.ch/it/', sampleExceptionList: [],
  })],
  ['cwv', () => buildCwvBody({
    metric: 'CLS', path: '/it/', threshold: 0.1,
    previous: { date: '2026-08-31', cls_p75: 0.21 },
    current: { date: '2026-09-07', cls_p75: 0.24 },
    fmt: (v: number) => String(v),
  })],
  ['telegram-member-count', () => buildTelegramBody({
    chatId: '@canale', count: 1234, daysUnchanged: 21, reason: 'invariato da 21 giorni',
  })],
  ['campaign-goal', () => buildCampaignGoalBody({
    goal: { id: 'g1', title: 'Traffico organico', source: 'gsc', matureAfterDays: 30, issueRef: '#1' },
    outcome: { targetDescription: '>= 1000 click/settimana', detail: '640 click/settimana' },
    matureAt: '2026-08-01',
  })],
  ['gsc-indexation', () => buildIndexationIssueBody(
    [{ url: 'https://frontaliereticino.ch/it/x/', googleCanonical: '', crawlTime: '' }],
    { PASS: 9, FAIL: 1, WARN: 0, STALE: 0 }, 1, [],
  )],
  ['gsc-structured-data', () => buildStructuredDataIssueBody(
    [{ url: 'https://frontaliereticino.ch/it/x/', richResults: 'FAIL', richResultsIssues: ['manca baseSalary'] }],
  )],
  ['source-liveness', () => buildSourceLivenessBody({
    alive: false, reason: '3 giorni sotto la soglia', floor: 200, windowDays: 7,
    deadDays: [{ date: '2026-09-05', count: 3 }],
  })],
];

/**
 * Gli opener il cui corpo si costruisce dentro una funzione async non
 * esportata: chiamarli qui vorrebbe dire esportare mezzo script per un test.
 * Il controllo statico costa una riga e prende il caso che conta davvero —
 * qualcuno toglie la scheda da un opener.
 */
const OPENERS_STATICI = [
  'scripts/monitor-jobs-pipeline-queue.mjs',
  'scripts/monitor-seo-ctr-by-template.mjs',
];

describe('opener dei monitor — il blocco `## Scheda`', () => {
  for (const [name, render] of OPENERS) {
    describe(name, () => {
      const body = render();

      it('porta il blocco `## Scheda`', () => {
        expect(body).toContain('## Scheda');
      });

      it('nomina un OSSERVATORE non vuoto', () => {
        const m = body.match(/\*\*4-OSSERVATORE\.\*\*(.*)/);
        expect(m, `${name}: nessun campo 4-OSSERVATORE`).not.toBeNull();
        expect(m![1].trim().length).toBeGreaterThan(10);
      });

      it('porta un COMANDO eseguibile su una riga sola', () => {
        const m = body.match(/\*\*COMANDO\*\*: `([^`\n]+)`/);
        expect(m, `${name}: nessun campo COMANDO`).not.toBeNull();
        const cmd = m![1].trim();
        expect(cmd.length).toBeGreaterThan(10);
        // Un segnaposto non e' un comando: la scheda `Funnel impact` e' fallita
        // esattamente cosi', tornando prosa dentro un campo strutturato.
        expect(cmd).not.toMatch(/^(TBD|N\/A|—|-)$/i);
        expect(cmd).toMatch(/^(node|npm|git|jq|gh|bash|source)\b/);
      });

      it('dice cosa si misura, prima e dopo', () => {
        expect(body).toMatch(/\*\*3-METRICA\.\*\* .*atteso=/);
      });
    });
  }
});

describe('opener senza corpo esportato — controllo statico', () => {
  for (const rel of OPENERS_STATICI) {
    it(`${rel} chiama ancora buildScheda`, () => {
      const src = readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(src).toContain("from './lib/monitor-scheda.mjs'");
      expect(src).toContain('buildScheda({');
    });
  }
});

describe('buildScheda — l\'invariante e\' eseguibile, non un commento', () => {
  const ok = { causa: 'c', fix: 'f', metrica: 'prima=1 atteso=0', comando: 'node x.mjs', osservatore: 'il monitor' };

  it('rende il blocco quando i campi ci sono', () => {
    expect(buildScheda(ok)).toContain('**COMANDO**: `node x.mjs`');
  });

  it('rifiuta una scheda senza COMANDO', () => {
    expect(() => buildScheda({ ...ok, comando: '  ' })).toThrow(/COMANDO mancante/);
  });

  it('rifiuta un COMANDO su piu\' righe', () => {
    expect(() => buildScheda({ ...ok, comando: 'node a.mjs\nnode b.mjs' })).toThrow(/piu' righe/);
  });

  it('rifiuta una scheda senza OSSERVATORE', () => {
    expect(() => buildScheda({ ...ok, osservatore: ['', '  '] })).toThrow(/OSSERVATORE mancante/);
  });
});
