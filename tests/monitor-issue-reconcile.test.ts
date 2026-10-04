import { describe, it, expect } from 'vitest';
import {
  decideMonitorIssue,
  reconcileMonitorIssues,
  cleanMarker,
  MAX_CLOSES_PER_RUN,
  MAYBE_RESOLVED_LABEL,
} from '../scripts/lib/monitor-issue-reconcile.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cf5xxReconcile, cf5xxSeenNow, cf5xxVerdict, issueUrlFromBody } from '../scripts/cf-5xx-issue-sync.mjs';
import { checkUrlClean } from '../scripts/ci/cf-5xx-snapshot.mjs';

/**
 * La metà di CHIUSURA dei monitor che coniano (cf-5xx, app-error, PostHog, CWV).
 *
 * Prima di questo file `syncErrorIssues` coniava e riconfermava, ma nessuno
 * chiudeva: le issue guarite restavano aperte per settimane e ogni sweep
 * spendeva un giro per scrivere «input mancante» (8773: 14 commenti; 7919: 28;
 * 9583: 15). Se uno di questi test diventa rosso, il titolo del guasto è:
 * «Monitor che conia senza chiudere: issue aperta con il criterio della scheda
 * già soddisfatto» — oppure, nel verso opposto, un chiuditore che chiude su
 * una misura vuota.
 */

const FAMILY = 'test-family';
const T0 = Date.parse('2026-10-01T04:00:00Z');
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();
const issue = (over: Record<string, unknown> = {}) => ({
  number: 1,
  title: 'Fam: firma',
  state: 'OPEN',
  labels: [] as unknown[],
  ...over,
});
const clean = (measure: string) => ({ clean: true, complete: true, evidence: 'sotto soglia', measure });
const markerComment = (measure: string, hour: number) => ({
  body: `misura pulita\n${cleanMarker({ family: FAMILY, at: at(hour), measure })}`,
  created_at: at(hour),
});
/** Una storia letta e vuota: con `confirmations > 1` va passata esplicitamente. */
const noHistory = { comments: [], events: [] };

describe('regola generale (due misure pulite di run diverse)', () => {
  it('prima misura pulita e completa → annota, non chiude', () => {
    expect(decideMonitorIssue({ issue: issue(), ...noHistory, verdict: clean('m1'), family: FAMILY }).action)
      .toBe('note-first-clean');
  });

  it("seconda misura pulita di un'ALTRA misura → chiude", () => {
    const d = decideMonitorIssue({
      issue: issue(), comments: [markerComment('m1', 0)], events: [], verdict: clean('m2'), family: FAMILY,
    });
    expect(d.action).toBe('close');
  });

  it('la stessa misura rieseguita due volte non è una seconda conferma', () => {
    const d = decideMonitorIssue({
      issue: issue(), comments: [markerComment('m1', 0)], events: [], verdict: clean('m1'), family: FAMILY,
    });
    expect(d.action).toBe('keep');
  });

  it('un marker di UN\'ALTRA famiglia non conta', () => {
    const other = { body: cleanMarker({ family: 'altra', at: at(0), measure: 'm1' }), created_at: at(0) };
    expect(decideMonitorIssue({ issue: issue(), comments: [other], events: [], verdict: clean('m2'), family: FAMILY }).action)
      .toBe('note-first-clean');
  });

  it('una riconferma 🔁 fra le due misure fa ripartire da capo', () => {
    const d = decideMonitorIssue({
      issue: issue(),
      comments: [markerComment('m1', 0), { body: '🔁 Recurrence on workflow run.', created_at: at(5) }],
      events: [],
      verdict: clean('m2'),
      family: FAMILY,
    });
    expect(d.action).toBe('note-first-clean');
  });

  it('un evento `reopened` dopo il marker fa ripartire da capo', () => {
    const d = decideMonitorIssue({
      issue: issue(),
      comments: [markerComment('m1', 0)],
      events: [{ event: 'reopened', created_at: at(3) }],
      verdict: clean('m2'),
      family: FAMILY,
    });
    expect(d.action).toBe('note-first-clean');
  });

  it('CONTROLLO: una 🔁 PRIMA del marker non azzera niente', () => {
    const d = decideMonitorIssue({
      issue: issue(),
      comments: [{ body: '🔁 Recurrence', created_at: at(-5) }, markerComment('m1', 0)],
      events: [],
      verdict: clean('m2'),
      family: FAMILY,
    });
    expect(d.action).toBe('close');
  });

  it('misura incompleta → keep, anche se dice «pulita»', () => {
    const d = decideMonitorIssue({
      issue: issue(),
      comments: [markerComment('m1', 0)],
      verdict: { clean: true, complete: false, evidence: 'report assente', measure: 'm2' },
      family: FAMILY,
    });
    expect(d.action).toBe('keep');
  });

  it('completa ma non pulita → keep', () => {
    const d = decideMonitorIssue({
      issue: issue(), verdict: { clean: false, complete: true, evidence: 'sopra soglia' }, family: FAMILY,
    });
    expect(d.action).toBe('keep');
  });

  it.each([
    ['eventi null', { comments: [markerComment('m1', 0)], events: null }],
    ['eventi assenti', { comments: [markerComment('m1', 0)] }],
    ['commenti null', { comments: null, events: [] }],
    ['commenti assenti', { events: [] }],
    ['entrambi null', { comments: null, events: null }],
  ])('storia della issue illeggibile (%s) con la seconda misura pulita → keep, non chiude', (_label, history) => {
    // Senza storia il chiuditore non sa se c'è stata una riconferma o una
    // riapertura dopo la prima misura pulita: «non so», mai «vuota».
    const d = decideMonitorIssue({
      issue: issue(), ...(history as object), verdict: clean('m2'), family: FAMILY,
    });
    expect(d).toEqual({ action: 'keep', reason: expect.stringContaining('storia della issue illeggibile') });
  });

  it('un titolo misurato sopra soglia in questa run resta aperto, qualunque cosa dica il verdetto', () => {
    // `syncErrorIssues` conia solo le prime N: «assente dalle prime N» non è
    // «sotto soglia», quindi la misura sopra soglia vince sempre.
    const d = decideMonitorIssue({
      issue: issue(), verdict: clean('m1'), family: FAMILY, confirmations: 1, measuredNow: true,
    });
    expect(d.action).toBe('keep');
  });
});

describe('pin, claim e `maybe-resolved`', () => {
  it.each(['keep-open', 'agent:no-age-out', 'pinned', 'tracker', 'do-not-close', 'agent:in-progress'])(
    'una issue con `%s` è fuori dal chiuditore',
    (label) => {
      const d = decideMonitorIssue({
        issue: issue({ labels: [{ name: label }] }), verdict: clean('m1'), family: FAMILY, confirmations: 1,
      });
      expect(d.action).toBe('skip');
    },
  );

  it('`maybe-resolved` NON è un input: con la misura non pulita la issue resta aperta', () => {
    // 8868 e 9815 portano la label e sono ancora vere.
    const d = decideMonitorIssue({
      issue: issue({ labels: [MAYBE_RESOLVED_LABEL] }),
      verdict: { clean: false, complete: true, evidence: 'p75 sopra soglia' },
      family: FAMILY,
      confirmations: 1,
    });
    expect(d.action).toBe('keep');
  });
});

/** Un `io` finto che registra ogni scrittura. */
function fakeIo(issues: Array<Record<string, unknown>>, { comments = [] as unknown[] } = {}) {
  const writes: string[] = [];
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  return {
    writes,
    io: {
      listOpenIssues: () => issues,
      readIssue: (n: number) => byNumber.get(n) ?? null,
      listComments: () => comments,
      listEvents: () => [],
      comment: (n: number, body: string) => { writes.push(`comment #${n}: ${body.split('\n')[0]}`); return true; },
      close: (number: number) => {
        writes.push(`close #${number}`);
        return { number, persisted: true };
      },
      removeLabel: (n: number, label: string) => { writes.push(`unlabel #${n} ${label}`); return true; },
    },
  };
}

const quiet = () => {};

describe('reconcileMonitorIssues — le scritture', () => {
  it('misura incompleta → zero scritture (un guasto del monitor non chiude e non annota)', async () => {
    const { io, writes } = fakeIo([issue()]);
    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet,
      verdictFor: () => ({ clean: true, complete: false, evidence: 'report mancante' }),
    });
    expect(writes).toEqual([]);
    expect(out.decisions.map((d) => d.action)).toEqual(['keep']);
  });

  it('la chiusura arriva DOPO un commento con l\'evidenza, e per numero esatto', async () => {
    const { io, writes } = fakeIo([issue()]);
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      verdictFor: () => ({ ...clean('m1'), command: 'node x.mjs' }),
    });
    expect(writes).toEqual([
      expect.stringMatching(/^comment #1: ✅ Criterio della scheda soddisfatto/),
      'close #1',
    ]);
  });

  it('la prima misura pulita scrive il marker, la seconda (altra run) chiude', async () => {
    const first = fakeIo([issue()]);
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io: first.io, log: quiet,
      verdictFor: () => clean('m1'), now: T0,
    });
    expect(first.writes).toEqual([expect.stringMatching(/^comment #1: 🟢/)]);

    const second = fakeIo([issue()], { comments: [markerComment('m1', 0)] });
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io: second.io, log: quiet,
      verdictFor: () => clean('m2'), now: T0 + 86_400_000,
    });
    expect(second.writes.at(-1)).toBe('close #1');
  });

  it('rilegge lo stato prima di scrivere: un claim arrivato durante la run vince', async () => {
    const { io, writes } = fakeIo([issue()]);
    io.readIssue = () => issue({ labels: ['agent:in-progress'] });
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      verdictFor: () => clean('m1'),
    });
    expect(writes).toEqual([]);
  });

  it('--dry-run stampa la decisione e non scrive niente', async () => {
    const lines: string[] = [];
    const { io, writes } = fakeIo([issue({ labels: [MAYBE_RESOLVED_LABEL] })]);
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, confirmations: 1, dryRun: true,
      reconfirmedTitles: new Set(['Fam: firma']),
      verdictFor: () => clean('m1'), log: (l) => lines.push(l),
    });
    expect(writes).toEqual([]);
    expect(lines.join('\n')).toContain('[dry-run] #1 close');
    expect(lines.join('\n')).toContain(`toglierei \`${MAYBE_RESOLVED_LABEL}\``);
  });

  it('riconferma sopra soglia di una issue `maybe-resolved` → label tolta, issue aperta', async () => {
    const { io, writes } = fakeIo([issue({ labels: [MAYBE_RESOLVED_LABEL] })]);
    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      measuredTitles: new Set(['Fam: firma']),
      reconfirmedTitles: new Set(['Fam: firma']),
      verdictFor: () => clean('m1'),
    });
    expect(writes).toEqual([`unlabel #1 ${MAYBE_RESOLVED_LABEL}`]);
    expect(out.decisions.map((d) => d.action)).toEqual(['keep']);
  });

  it('gemelle aperte con lo stesso titolo, una pinnata → zero chiusure (la chiusura per titolo è ambigua)', async () => {
    const { io, writes } = fakeIo([
      issue({ number: 1, labels: ['keep-open'] }),
      issue({ number: 2 }),
    ]);
    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      verdictFor: () => clean('m1'),
    });
    expect(writes).toEqual([]);
    expect(out.closed).toEqual([]);
    expect(out.decisions.map((d) => d.action)).toEqual(['keep', 'keep']);
  });

  it('una chiusura che colpisce un\'altra issue non conta come chiusa', async () => {
    const lines: string[] = [];
    const { io } = fakeIo([issue({ number: 2 })]);
    io.close = () => ({ number: 1, persisted: true });
    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, confirmations: 1,
      verdictFor: () => clean('m1'), log: (l) => lines.push(l),
    });
    expect(out.closed).toEqual([]);
    expect(out.failed).toEqual([2]);
    expect(lines.join('\n')).toContain('la chiusura ha colpito #1');
  });

  it('chiude il numero riletto e lascia aperta una gemella senza label di famiglia', async () => {
    const selected = issue({ number: 101, labels: ['cloudflare-5xx'] });
    const unlabelledTwin = issue({ number: 202, labels: [] });
    const writes: string[] = [];
    const io = {
      listOpenIssues: () => [selected],
      readIssue: (number: number) => (number === 101 ? selected : null),
      listComments: () => [],
      listEvents: () => [],
      comment: (number: number, body: string) => {
        writes.push(`comment #${number}: ${body.split('\n')[0]}`);
        return true;
      },
      close: (number: number) => {
        writes.push(`close #${number}`);
        if (number === 101) selected.state = 'CLOSED';
        if (number === 202) unlabelledTwin.state = 'CLOSED';
        return { number, persisted: true };
      },
      removeLabel: () => true,
    };

    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['cloudflare-5xx'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      verdictFor: () => clean('m1'),
    });

    expect(writes).toEqual([
      expect.stringMatching(/^comment #101: ✅ Criterio della scheda soddisfatto/),
      'close #101',
    ]);
    expect(out.closed).toEqual([101]);
    expect(selected.state).toBe('CLOSED');
    expect(unlabelledTwin.state).toBe('OPEN');
  });

  it('riconferma di una issue `maybe-resolved` pinnata o reclamata → label lasciata', async () => {
    const { io, writes } = fakeIo([issue({ labels: [MAYBE_RESOLVED_LABEL, 'agent:in-progress'] })]);
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      measuredTitles: new Set(['Fam: firma']),
      reconfirmedTitles: new Set(['Fam: firma']),
      verdictFor: () => clean('m1'),
    });
    expect(writes).toEqual([]);
  });

  it('ignora i titoli fuori dal prefisso della famiglia', async () => {
    const { io, writes } = fakeIo([issue({ title: 'Altro: firma' })]);
    await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      verdictFor: () => clean('m1'),
    });
    expect(writes).toEqual([]);
  });

  it('elenco illeggibile → nessuna scrittura', async () => {
    const { io, writes } = fakeIo([]);
    io.listOpenIssues = () => null as never;
    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, log: quiet, confirmations: 1,
      verdictFor: () => clean('m1'),
    });
    expect(writes).toEqual([]);
    expect(out.decisions).toEqual([]);
  });

  it(`oltre ${MAX_CLOSES_PER_RUN} chiudibili: ${MAX_CLOSES_PER_RUN} chiusure e una riga di eccedenza`, async () => {
    const all = Array.from({ length: MAX_CLOSES_PER_RUN + 1 }, (_, i) => issue({ number: i + 1, title: `Fam: firma ${i + 1}` }));
    const lines: string[] = [];
    const { io, writes } = fakeIo(all);
    const out = await reconcileMonitorIssues({
      family: FAMILY, labels: ['fam'], titlePrefix: 'Fam:', io, confirmations: 1,
      verdictFor: () => clean('m1'), log: (l) => lines.push(l),
    });
    expect(writes.filter((w) => w.startsWith('close '))).toHaveLength(MAX_CLOSES_PER_RUN);
    expect(out.excess).toEqual([all.at(-1)!.number]);
    expect(lines.filter((l) => l.includes('eccedenza'))).toHaveLength(1);
  });
});

/**
 * Il verdetto dei 5xx (`confirmations: 1`): `checkUrlClean` sulla storia è già
 * un criterio sostenuto (7 snapshot completi e freschi), e il comando della
 * scheda deve dare lo stesso verdetto del chiuditore.
 */
describe('cf5xxVerdict — il criterio della scheda, applicato dal monitor', () => {
  const URL_A = 'frontaliereticino.ch/fr/trouver-emploi-suisse/recherche-kurs-basel/';
  const NOW = Date.parse('2026-10-08T06:00:00Z');
  const body = (url: string) => `**Status:** 503\n**URL:** ${url}\n**5xx responses (last 23h):** 30`;
  const snap = (daysBefore: number, urls: string[]) => ({
    ts: new Date(NOW - daysBefore * 86_400_000).toISOString(),
    topN: 50,
    topPaths: urls.map((url) => ({ url, count: 1 })),
    errorPaths: urls.map((url) => ({ url, count: 1 })),
    errorPathsComplete: true,
  });
  /** Una presenza vecchia, poi `cleanDays` snapshot puliti fino a `lastDaysBefore`. */
  const series = (cleanDays: number, lastDaysBefore = 0) => [
    snap(lastDaysBefore + cleanDays + 1, [URL_A]),
    ...Array.from({ length: cleanDays }, (_, i) => snap(lastDaysBefore + cleanDays - 1 - i, [])),
  ];
  const decide = (history: object[], issueBody = body(URL_A), seenNow = new Map<string, number>()) => {
    const verdict = cf5xxVerdict({ body: issueBody }, { history, seenNow, now: NOW });
    return {
      verdict,
      action: decideMonitorIssue({ issue: issue({ body: issueBody }), verdict, family: 'cf-5xx', confirmations: 1 }).action,
    };
  };

  it('7 snapshot completi, freschi e puliti → close, e il comando della scheda dice lo stesso', () => {
    const history = series(7);
    const { verdict, action } = decide(history);
    expect(action).toBe('close');
    expect(verdict.command).toBe(`node scripts/ci/cf-5xx-snapshot.mjs --check-url '${URL_A}' --snapshots 7`);
    expect(checkUrlClean(history, URL_A, { now: NOW }).ok).toBe(verdict.clean);
  });

  it('URL ancora fra i path 5xx → keep (misura completa, non pulita)', () => {
    const history = series(7);
    history.at(-1)!.errorPaths = [{ url: URL_A, count: 1 }];
    const { verdict, action } = decide(history);
    expect(verdict.complete).toBe(true);
    expect(action).toBe('keep');
    expect(checkUrlClean(history, URL_A, { now: NOW }).ok).toBe(false);
  });

  it('storia di 5 snapshot → keep, misura incompleta', () => {
    const { verdict, action } = decide(series(4));
    expect(verdict.complete).toBe(false);
    expect(action).toBe('keep');
  });

  it('serie ferma da 4 giorni → keep, misura incompleta', () => {
    const { verdict, action } = decide(series(7, 4));
    expect(verdict.complete).toBe(false);
    expect(action).toBe('keep');
  });

  it('URL mai osservato → keep, misura incompleta', () => {
    const { verdict, action } = decide(series(7), body('frontaliereticino.ch/mai-visto/'));
    expect(verdict.complete).toBe(false);
    expect(action).toBe('keep');
  });

  it('dettagli troncati in uno snapshot → keep, misura incompleta', () => {
    const history = series(7);
    history[3] = { ...history[3], errorPathsComplete: false };
    const { verdict, action } = decide(history);
    expect(verdict.complete).toBe(false);
    expect(action).toBe('keep');
  });

  it('URL nel report di oggi (non ancora nella storia mergiata) → keep', () => {
    const { verdict, action } = decide(series(7), body(URL_A), new Map([[URL_A.replace(/\/+$/, ''), 3]]));
    expect(verdict).toMatchObject({ clean: false, complete: true });
    expect(action).toBe('keep');
  });

  it('URL letto dal corpo, non dal titolo tagliato a 80 caratteri; corpo senza URL → incompleta', () => {
    const long = `frontaliereticino.ch/cerca-lavoro-zurigo/azienda-coop-genossenschaft-kleinandelfingen/`;
    expect(issueUrlFromBody(`**Workflow:** x\r\n\r\n**URL:** ${long}\r\n`)).toBe(long);
    const { verdict, action } = decide(series(7), 'nessuna riga url');
    expect(verdict.complete).toBe(false);
    expect(action).toBe('keep');
  });

  it('report corrente con `detail: null` → keep senza scritture', async () => {
    const reconcile = cf5xxReconcile({ detail: null }, {
      historyFile: '/definitely/not/read.jsonl',
    });
    const { io, writes } = fakeIo([issue({
      number: 101,
      title: `CF 5xx: ${URL_A}`,
      labels: ['cloudflare-5xx'],
      body: body(URL_A),
    })]);
    const out = await reconcileMonitorIssues({
      ...reconcile,
      io,
      log: quiet,
      verdictFor: reconcile.verdictFor,
    });
    expect(out.decisions).toEqual([expect.objectContaining({ action: 'keep' })]);
    expect(out.decisions[0].reason).toContain('report corrente incompleto');
    expect(writes).toEqual([]);
  });
});

/**
 * Il report corrente di Cloudflare è metà della misura (la storia mergiata non
 * contiene ancora lo snapshot di oggi). `cf-status-report.mjs --limit=50`
 * restituisce le prime 50 righe di `detail`: un `detail` pieno al limite è un
 * top-N troncato, e un URL oltre la cinquantesima riga non vi compare pur
 * fallendo adesso. Senza un `detailByHour` dichiarato completo quella lista
 * non prova che un URL sia a zero → «non so» → keep, zero scritture.
 */
describe('cf5xxReconcile — il report corrente deve essere completo', () => {
  const URL_A = 'frontaliereticino.ch/fr/trouver-emploi-suisse/recherche-kurs-basel/';
  const body = `**Status:** 503\n**URL:** ${URL_A}\n**5xx responses (last 23h):** 30`;
  const now = Date.now();
  const snap = (daysBefore: number, urls: string[]) => ({
    ts: new Date(now - daysBefore * 86_400_000).toISOString(),
    topN: 50,
    topPaths: urls.map((url) => ({ url, count: 1 })),
    errorPaths: urls.map((url) => ({ url, count: 1 })),
    errorPathsComplete: true,
  });
  /** Una presenza vecchia, poi sette snapshot puliti e freschi: la storia da sola chiuderebbe. */
  const historyFile = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cf5xx-reconcile-'));
    const file = path.join(dir, 'history.jsonl');
    const rows = [snap(8, [URL_A]), ...Array.from({ length: 7 }, (_, i) => snap(6 - i, []))];
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  const run = async (data: unknown) => {
    const cfg = cf5xxReconcile(data, { historyFile: historyFile() });
    const { io, writes } = fakeIo([issue({ number: 101, title: `CF 5xx: ${URL_A}`, body, labels: ['cloudflare-5xx'] })]);
    const out = await reconcileMonitorIssues({ ...cfg, io, log: quiet });
    return { out, writes, verdict: await cfg.verdictFor({ body }) };
  };
  const row = (url: string, count = 1) => ({ status: 503, url, count });
  /** Un `detail` pieno al limite delle righe chieste a cf-status-report, senza URL_A. */
  const fullDetail = () => Array.from({ length: 50 }, (_, i) => row(`frontaliereticino.ch/altro-${i}/`, 100));

  it('detail pieno al limite delle righe, senza orario completo → keep, zero scritture', async () => {
    const { out, writes, verdict } = await run({ detail: fullDetail() });
    expect(verdict.complete).toBe(false);
    expect(out.decisions.map((d) => d.action)).toEqual(['keep']);
    expect(out.decisions[0].reason).toContain('report corrente incompleto');
    expect(writes).toEqual([]);
  });

  it('detail pieno al limite con `detailByHour` presente ma NON completo → keep', async () => {
    const detailByHour = fullDetail().map((r) => ({ ...r, hour: new Date(now).toISOString() }));
    const { out, writes } = await run({ detail: fullDetail(), detailByHour, detailByHourComplete: false });
    expect(out.decisions.map((d) => d.action)).toEqual(['keep']);
    expect(writes).toEqual([]);
  });

  it.each([
    ['detail null', { detail: null }],
    ['detail assente', {}],
    ['detail non array', { detail: 'x' }],
    ['report nullo', null],
  ])('%s + sette snapshot puliti → keep, zero scritture', async (_label, data) => {
    const { out, writes, verdict } = await run(data);
    expect(verdict.complete).toBe(false);
    expect(out.decisions.map((d) => d.action)).toEqual(['keep']);
    expect(writes).toEqual([]);
  });

  it('detail troncato ma `detailByHour` completo che contiene l\'URL → keep (misura completa, non pulita)', async () => {
    const detailByHour = [{ ...row(URL_A, 2), hour: new Date(now).toISOString() }];
    const { out, verdict } = await run({ detail: fullDetail(), detailByHour, detailByHourComplete: true });
    expect(verdict).toMatchObject({ clean: false, complete: true });
    expect(out.decisions.map((d) => d.action)).toEqual(['keep']);
  });

  it('CONTROLLO: detail sotto il limite e senza l\'URL → chiude', async () => {
    const { out, writes } = await run({ detail: fullDetail().slice(1) });
    expect(out.decisions.map((d) => d.action)).toEqual(['close']);
    expect(writes.at(-1)).toBe('close #101');
  });

  it('CONTROLLO: detail troncato ma `detailByHour` completo senza l\'URL → chiude', async () => {
    const detailByHour = fullDetail().map((r) => ({ ...r, hour: new Date(now).toISOString() }));
    const { out } = await run({ detail: fullDetail(), detailByHour, detailByHourComplete: true });
    expect(out.decisions.map((d) => d.action)).toEqual(['close']);
  });

  it('cf5xxSeenNow somma le righe per URL e restituisce null su un report non misurato', () => {
    const seen = cf5xxSeenNow({ detail: [row(`https://${URL_A}`, 2), { ...row(URL_A, 3), status: 502 }] });
    expect(seen?.get(URL_A.replace(/\/+$/, ''))).toBe(5);
    expect(cf5xxSeenNow({ detail: fullDetail() })).toBeNull();
    expect(cf5xxSeenNow(null)).toBeNull();
  });

  it('cf5xxVerdict senza report corrente → incompleta, anche con la storia pulita', () => {
    const history = [snap(8, [URL_A]), ...Array.from({ length: 7 }, (_, i) => snap(6 - i, []))];
    expect(cf5xxVerdict({ body }, { history, now })).toMatchObject({ clean: false, complete: false });
    expect(cf5xxVerdict({ body }, { history, seenNow: null, now })).toMatchObject({ clean: false, complete: false });
  });
});
