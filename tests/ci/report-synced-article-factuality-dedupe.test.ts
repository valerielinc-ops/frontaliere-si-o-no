import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Il reporter di factuality non ri-escala a ogni sync le stesse firme
 * (id, lingua, codici) — issue 5661.
 *
 * Il sync non committa piu' su `main`: pubblica attraverso la PR stabile di
 * `chore/sync-articles-sitemaps`. Finche' quella PR resta aperta, gli stessi
 * articoli risultano «nuovi» (assenti da `main`) a OGNI giro, e la issue
 * canonica riceveva lo stesso elenco a ogni sync: il 2026-10-03
 * `guasto-treno-s50-busto-arsizio-2026 [de]`, committato una volta sola su
 * `main` dopo 18 ore di PR, compariva in 19 commenti di ricorrenza.
 *
 * Diventa rosso se una modifica fa riemettere una firma gia' registrata, o se
 * toglie il fail-open (marker illeggibile o `gh` muto devono far segnalare
 * TUTTO, mai niente).
 *
 * `gh` e' finto instradando `node:child_process` per sotto-comando, come in
 * scan-job-timeouts-dedup.test.ts: `createGithubIssue` gira VERO contro una
 * issue in memoria, cosi' il test vede i commenti che arriverebbero a GitHub.
 */
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const TITLE = 'Content grounding: articoli sincronizzati con claim non verificati';

type FakeIssue = { number: number; title: string; state: string; body: string; url: string };
let issue: FakeIssue;
let comments: string[];
let failList: boolean;

function fakeGh(cmd: string, args: string[]) {
  if (cmd !== 'gh') throw new Error(`comando inatteso nel test: ${cmd}`);
  const [group, sub] = args;
  if (group === 'issue' && sub === 'list') {
    if (failList) throw new Error('gh: HTTP 502');
    return JSON.stringify([issue]);
  }
  if (group === 'issue' && sub === 'view') return JSON.stringify(issue);
  if (group === 'issue' && sub === 'comment') {
    comments.push(args[args.indexOf('--body') + 1]);
    return '';
  }
  if (group === 'issue' && sub === 'edit') {
    const i = args.indexOf('--body-file');
    if (i >= 0) issue.body = readFileSync(args[i + 1], 'utf8');
    return '';
  }
  if (group === 'label') return '[]';
  if (group === 'api') return '[]';
  return '';
}

function finding(id: string, locale: string, codes: string[], criticalCount = 1) {
  return {
    id,
    locale,
    criticalCount,
    issueCount: codes.length,
    worst: 3,
    issues: codes.map((code) => ({ code, severity: 'critical', message: `rilievo ${code}`, evidence: '' })),
  };
}

const report = (findings: ReturnType<typeof finding>[]) => ({
  scanned: findings.length,
  flagged: findings.length,
  diffUnavailable: false,
  findings,
});

let logs: string[];

beforeEach(() => {
  execFileSync.mockReset();
  execFileSync.mockImplementation((cmd: string, args: string[]) => fakeGh(cmd, args));
  vi.resetModules();
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
  delete process.env.GITHUB_STEP_SUMMARY;
  issue = { number: 5661, title: TITLE, state: 'OPEN', body: 'Corpo originale della issue.', url: 'https://github.com/o/r/issues/5661' };
  comments = [];
  failList = false;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.GH_REPO;
  vi.restoreAllMocks();
});

const load = () => import('../../scripts/ci/report-synced-article-factuality.mjs');

describe('firme dei finding', () => {
  it('dipende da id, lingua e INSIEME dei codici, non dal loro ordine', async () => {
    const { findingSignature } = await load();
    const a = findingSignature(finding('art', 'de', ['b-code', 'a-code', 'a-code']));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(findingSignature(finding('art', 'de', ['a-code', 'b-code']))).toBe(a);
    // Un codice in piu' sulla stessa coppia id/lingua e' informazione nuova.
    expect(findingSignature(finding('art', 'de', ['a-code', 'b-code', 'c-code']))).not.toBe(a);
    expect(findingSignature(finding('art', 'fr', ['a-code', 'b-code']))).not.toBe(a);
    expect(findingSignature(finding('altro', 'de', ['a-code', 'b-code']))).not.toBe(a);
  });

  it('partitionFresh separa i nuovi dai gia\' visti', async () => {
    const { findingSignature, partitionFresh } = await load();
    const old = finding('vecchio', 'de', ['x']);
    const nuovo = finding('nuovo', 'de', ['x']);
    const { fresh, repeated } = partitionFresh([old, nuovo], new Set([findingSignature(old)]));
    expect(fresh).toEqual([nuovo]);
    expect(repeated).toEqual([old]);
  });
});

describe('marker nel body della issue', () => {
  it('marker assente, vuoto o malformato -> nessuna firma vista (fail-open)', async () => {
    const { parseSeenSignatures } = await load();
    for (const body of [
      '',
      null,
      undefined,
      'nessun marker qui',
      '<!-- factuality-seen:  -->',
      '<!-- factuality-seen: abc,def -->',
      '<!-- factuality-seen: 0123456789ab,NON-HEX!!!! -->',
    ]) {
      expect(parseSeenSignatures(body as string).size).toBe(0);
    }
    const ok = parseSeenSignatures('testo\n\n<!-- factuality-seen: 0123456789ab,ba9876543210 -->\n');
    expect([...ok]).toEqual(['0123456789ab', 'ba9876543210']);
  });

  it('withSeenMarker sostituisce il marker esistente invece di aggiungerne un secondo', async () => {
    const { withSeenMarker, parseSeenSignatures } = await load();
    const once = withSeenMarker('Corpo.', ['0123456789ab']);
    const twice = withSeenMarker(once, ['0123456789ab', 'ba9876543210']);
    expect(twice.match(/factuality-seen:/g)).toHaveLength(1);
    expect(twice.startsWith('Corpo.')).toBe(true);
    expect([...parseSeenSignatures(twice)]).toEqual(['0123456789ab', 'ba9876543210']);
  });

  it('withSeenMarker rispetta il tetto tenendo le firme piu\' recenti', async () => {
    const { withSeenMarker, parseSeenSignatures } = await load();
    const sigs = Array.from({ length: 50 }, (_, n) => n.toString(16).padStart(12, '0'));
    const cap = 7;
    const seen = [...parseSeenSignatures(withSeenMarker('', sigs, cap))];
    expect(seen).toEqual(sigs.slice(-cap));
  });

  it('withSeenMarker non supera mai il limite GitHub del body', async () => {
    const { withSeenMarker, parseSeenSignatures } = await load();
    const big = 'x'.repeat(60000);
    const sigs = Array.from({ length: 600 }, (_, n) => n.toString(16).padStart(12, '0'));
    const out = withSeenMarker(big, sigs);
    expect(out.length).toBeLessThanOrEqual(65536);
    const kept = [...parseSeenSignatures(out)];
    expect(kept.length).toBeGreaterThan(0);
    // Si perdono le firme piu' vecchie, mai il testo del body.
    expect(kept).toEqual(sigs.slice(-kept.length));
    expect(out.startsWith(big)).toBe(true);
  });
});

describe('main(): una segnalazione per firma, non per sync', () => {
  const deps = (findings: ReturnType<typeof finding>[]) => ({
    runAudit: () => report(findings),
    newArticleIds: () => new Set(findings.map((f) => f.id)),
  });

  it('lo stesso elenco al sync successivo non produce un secondo commento', async () => {
    const { main } = await load();
    const findings = [
      finding('guasto-treno-s50-busto-arsizio-2026', 'de', ['translation-semantic-truncation']),
      finding('tirocinio-grigioni-guida-pratica', 'it', ['unknown-institution'], 0),
    ];

    await main(deps(findings));
    expect(comments).toHaveLength(1);
    expect(issue.body).toContain('<!-- factuality-seen: ');
    expect(issue.body.startsWith('Corpo originale della issue.')).toBe(true);

    // Il sync dopo: la PR di sync e' ancora aperta, gli stessi articoli sono
    // ancora «nuovi» rispetto a main.
    await main(deps(findings));
    expect(comments).toHaveLength(1);
    expect(logs.some((l) => l.includes('tutti gia\' segnalati'))).toBe(true);
  });

  it('un codice nuovo sullo stesso body-locale viene segnalato, e solo quello', async () => {
    const { main } = await load();
    const prima = finding('craveggia-ticino-pendolare', 'en', ['translation-semantic-truncation']);
    const accanto = finding('miazzina-pendolare-fisco-ticino', 'fr', ['translation-semantic-truncation']);
    await main(deps([prima, accanto]));
    expect(comments).toHaveLength(1);

    const peggiorato = finding('craveggia-ticino-pendolare', 'en', ['translation-semantic-truncation', 'incomplete-ending']);
    await main(deps([peggiorato, accanto]));
    expect(comments).toHaveLength(1 + 1);
    const ultimo = comments[comments.length - 1];
    expect(ultimo).toContain('`craveggia-ticino-pendolare`');
    expect(ultimo).not.toContain('`miazzina-pendolare-fisco-ticino`');

    // E al terzo giro, di nuovo silenzio.
    await main(deps([peggiorato, accanto]));
    expect(comments).toHaveLength(1 + 1);
  });

  // Un rilievo oltre il tetto del commento (MAX_ARTICLES_IN_BODY, o tagliato da
  // MAX_BODY_CHARS) compare solo come conteggio: se si registrasse come «gia'
  // segnalato», nessun commento lo nominerebbe mai.
  const named = (body: string) => [...body.matchAll(/^### \[([a-z]{2})\] `([^`]+)`/gm)].map((m) => `${m[2]}|${m[1]}`);

  it('oltre il tetto del commento: i rilievi non elencati tornano al sync dopo', async () => {
    const { main } = await load();
    const findings = Array.from({ length: 30 }, (_, n) => finding(`articolo-${n}`, 'de', ['x']));
    const all = findings.map((f) => `${f.id}|${f.locale}`);

    await main(deps(findings));
    expect(comments).toHaveLength(1);
    const primo = named(comments[0]);
    expect(primo.length).toBeGreaterThan(0);
    expect(primo.length).toBeLessThan(findings.length);

    await main(deps(findings));
    expect(comments).toHaveLength(1 + 1);
    const secondo = named(comments[1]);
    expect(secondo.filter((k) => primo.includes(k))).toEqual([]);
    expect([...primo, ...secondo].sort()).toEqual([...all].sort());

    await main(deps(findings));
    expect(comments).toHaveLength(1 + 1);
  });

  it('un rilievo tagliato dal limite di caratteri del body non risulta segnalato', async () => {
    const { buildReportIssue } = await load();
    const lungo = (n: number) => ({
      ...finding(`lungo-${n}`, 'fr', ['x']),
      issues: [{ code: 'x', severity: 'critical', message: 'm'.repeat(8000), evidence: '' }],
    });
    const findings = Array.from({ length: 20 }, (_, n) => lungo(n));
    const { description, listed } = buildReportIssue(report(findings), findings, undefined);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(findings.length);
    expect(named(description).slice(0, listed.length)).toEqual(listed.map((f) => `${f.id}|${f.locale}`));
    // L'ultimo «elencato» c'e' per intero; il primo escluso no (al piu' monco).
    const ultimo = description.indexOf(`\`${listed[listed.length - 1].id}\``);
    expect(description.indexOf('m'.repeat(8000), ultimo)).toBeGreaterThan(ultimo);
    const escluso = description.indexOf(`\`${findings[listed.length].id}\``);
    if (escluso >= 0) expect(description.indexOf('m'.repeat(8000), escluso)).toBe(-1);
  });

  it('un marker corrotto nel body fa segnalare tutto (fail-open)', async () => {
    const { main } = await load();
    issue.body = 'Corpo.\n\n<!-- factuality-seen: rotto -->';
    const findings = [finding('articolo', 'de', ['x'])];
    await main(deps(findings));
    expect(comments).toHaveLength(1);
  });

  it('lettura gh fallita -> si segnala tutto e il log lo dice', async () => {
    const { main, findingSignature, withSeenMarker } = await load();
    const findings = [finding('articolo', 'de', ['x'])];
    // La issue sa gia' di questo finding: se la lettura riuscisse, tacerebbe.
    issue.body = withSeenMarker('Corpo.', [findingSignature(findings[0])]);
    failList = true;
    const createIssue = vi.fn(async () => ({ number: 5661, persisted: true }));
    await main({ ...deps(findings), createIssue });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('fail-open'))).toBe(true);
  });

  it('se la segnalazione non e\' persistita le firme NON si registrano', async () => {
    const { main } = await load();
    const findings = [finding('articolo', 'de', ['x'])];
    const recordSeen = vi.fn();
    const createIssue = vi.fn(async () => ({ number: null, persisted: false }));
    await main({ ...deps(findings), createIssue, recordSeen });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(recordSeen).not.toHaveBeenCalled();
  });

  it('la registrazione fonde il marker gia\' presente invece di sostituirlo', async () => {
    const { recordSeenSignatures, parseSeenSignatures } = await load();
    issue.body = 'Corpo.\n\n<!-- factuality-seen: 0123456789ab -->\n';
    expect(recordSeenSignatures(5661, ['ba9876543210'])).toBe(true);
    expect([...parseSeenSignatures(issue.body)]).toEqual(['0123456789ab', 'ba9876543210']);
  });
});
