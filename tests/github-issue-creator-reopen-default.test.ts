import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Una condizione che ritorna deve RIAPRIRE la sua issue, non aprirne una nuova.
 *
 * ## Il difetto, misurato
 *
 * Il dedup di `github-issue-creator.mjs` cercava solo fra le issue APERTE
 * (`findOpenIssueByTitlePrefix`). Un monitor che ritrova la stessa condizione
 * DOPO che la issue precedente e' stata chiusa non vede la gemella chiusa e
 * conia un numero nuovo. Misurato il 2026-08-14 sui due repo:
 *
 *   comm -12 <(gh issue list -R <r> --state open   --limit 300 --json title -q '.[].title[0:60]'|sort -u) \
 *            <(gh issue list -R <r> --state closed --limit 500 --json title -q '.[].title[0:60]'|sort -u)
 *
 * → 11 prefissi condivisi fra aperte e chiuse, di cui 8 ricorrenze vere
 * (sito #5427←#5039, #5480←#4357, #5670←#4677, #5691←#5136/#4947; corpus
 * #311←#271/#250/#240, #312←#273, #313←#266/#206) e 3 tracker rotolanti
 * (sito #1951/#5198, corpus #25) che invece NON vanno toccati.
 *
 * `reopenWithinHours` esisteva gia' ma era opt-in con default 0, e fuori dai
 * validator post-deploy nessuno lo passava: il ramo di riapertura era codice
 * irraggiungibile per tutti i monitor ricorrenti.
 *
 * ## Perche' il prefisso da solo non basta
 *
 * `searchSafePrefix()` taglia a 60 caratteri e BUTTA il token spezzato dal
 * taglio. Le tre fixture qui sotto lo mostrano: condividono tutte lo stesso
 * prefisso di ricerca (`escalation(harvester)`, 22 char dopo la sanitizzazione)
 * pur nominando condizioni diverse. Riaprire sul solo prefisso resusciterebbe
 * la issue SBAGLIATA — peggio che aprirne una nuova, perche' mette una misura
 * sotto un titolo che non la descrive. Il discriminante e' la *firma della
 * condizione*: cifre normalizzate (il conteggio cambia a ogni run), parole no.
 *
 * ## Come si mantiene onesto questo test
 *
 * Provato per mutazione il 2026-08-14:
 *  - rimessa la ricerca a sole-aperte (`findRecentlyClosedIssueByTitlePrefix`
 *    → `return null`): il primo caso diventa ROSSO;
 *  - aggiunte 10 righe di commento innocue al modulo: resta VERDE.
 */

const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const { createGithubIssue } = await import('../scripts/lib/github-issue-creator.mjs');

function ghCalls(): string[][] {
  return execFileSync.mock.calls
    .filter((c) => c[0] === 'gh')
    .map((c) => c[1] as string[]);
}

const callsTo = (sub: string) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);
const ISO = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

// Le tre condiviono lo stesso prefisso di ricerca, per costruzione (verificato
// in-test da `condivide il prefisso di ricerca` qui sotto).
const TITLE_NOW = 'escalation(harvester): fix-outcome/fix-outcome:blocked-secrets ricorre 12 volte';
const TITLE_TWIN = 'escalation(harvester): fix-outcome/fix-outcome:blocked-secrets ricorre 47 volte';
const TITLE_OTHER = 'escalation(harvester): fix-outcome/fix-outcome:blocked-secrets-workflows ricorre 4 volte';

type Twin = {
  number: number;
  title: string;
  url?: string;
  closedAt: string;
  state?: string;
  stateReason?: string | null;
  labels?: { name: string }[];
};

/**
 * Instrada le chiamate `gh` per stato. `ghIssueList()` costruisce sempre
 * `['issue','list','--state',<state>,…]`, quindi lo stato sta in args[3].
 */
function mockWithClosedTwins(twins: Twin[]) {
  execFileSync.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'issue' && args[1] === 'list') {
      return args[3] === 'closed' ? JSON.stringify(twins) : '[]';
    }
    if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/999';
    return '';
  });
}

const twin = (over: Partial<Twin> = {}): Twin => ({
  number: 5039,
  title: TITLE_TWIN,
  url: 'https://github.com/o/r/issues/5039',
  closedAt: ISO(24 * 9), // chiusa 9 giorni fa: dentro la finestra di default (30gg)
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  labels: [{ name: 'bug' }],
  ...over,
});

beforeEach(() => {
  execFileSync.mockReset();
  delete process.env.GH_REPO;
  delete process.env.GITHUB_STEP_SUMMARY;
});

describe('dedup: una gemella CHIUSA di recente viene RIAPERTA, non riaperta ex-novo', () => {
  it('senza opzioni: riapre la gemella chiusa invece di creare (invariante)', async () => {
    mockWithClosedTwins([twin()]);

    // NIENTE reopenWithinHours: e' il punto. Il comportamento deve valere per
    // default, altrimenti resta il ramo opt-in che nessun monitor passava.
    const res = await createGithubIssue({
      title: TITLE_NOW,
      description: 'blocked-secrets: 12 occorrenze nelle ultime 24h',
      priority: 2,
      labels: ['bug'],
    } as any);

    expect(callsTo('reopen').map((a) => a[2])).toEqual(['5039']);
    expect(callsTo('create')).toHaveLength(0);
    expect(res?.number).toBe(5039);
    expect((res as any)?.reopened).toBe(true);
  });

  it('costa 1 sola chiamata sulle chiuse, e chiede una pagina piu\' larga di 10', async () => {
    // A 244 issue/settimana aperte da monitor sui due repo, il costo per
    // tentativo e' load-bearing: la ricerca fra le chiuse non deve paginare.
    // E la pagina dev'essere piu' larga del ramo APERTE: di canonical aperti
    // con lo stesso prefisso ce n'e' uno, di chiusi se ne accumulano tanti
    // quanti i giri passati (la famiglia `escalation(harvester)` ne ha 8).
    mockWithClosedTwins([twin()]);

    await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    const closedLists = ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'list' && a[3] === 'closed');
    expect(closedLists).toHaveLength(1); // l'indice ha risposto → nessun ripiego
    expect(closedLists[0]).not.toContain('--paginate');
    const limit = Number(closedLists[0][closedLists[0].indexOf('--limit') + 1]);
    expect(limit).toBeGreaterThan(10);
  });

  it('il commento di ricorrenza porta la data e la misura corrente', async () => {
    mockWithClosedTwins([twin()]);

    await createGithubIssue({
      title: TITLE_NOW,
      description: 'blocked-secrets: 12 occorrenze nelle ultime 24h',
      priority: 2,
    } as any);

    const comment = callsTo('comment').find((a) => a[2] === '5039');
    const body = comment?.[comment.indexOf('--body') + 1] ?? '';
    // Data ISO di oggi: senza, una issue riaperta si legge come se nulla fosse
    // cambiato dalla chiusura.
    expect(body).toMatch(/ricorrenza il \d{4}-\d{2}-\d{2}T/);
    expect(body).toContain('blocked-secrets: 12 occorrenze nelle ultime 24h');
    // Il marker 🔁 e' portante: countRecentFailureEvents conta i commenti che
    // lo hanno per far avanzare il gate delle failure consecutive.
    expect(body.startsWith('🔁')).toBe(true);
  });

  it('condivide il prefisso di ricerca ma non la condizione → NON riapre, crea', async () => {
    // TITLE_OTHER e TITLE_NOW hanno gli stessi primi 60 char: sul solo prefisso
    // il dedup riaprirebbe la issue sbagliata.
    mockWithClosedTwins([twin({ number: 4357, title: TITLE_OTHER })]);

    await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(1);
  });

  it('la gemella con agent:no-age-out (tracker rotolante) resta chiusa', async () => {
    mockWithClosedTwins([twin({ labels: [{ name: 'agent:no-age-out' }, { name: 'bug' }] })]);

    await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(1);
  });

  it('il ledger singleton non si riapre nemmeno SENZA agent:no-age-out', async () => {
    // Il label da solo non regge: misurato il 2026-08-14, il ledger
    // crawler-transient ha `agent:no-age-out` sul sito (#5198) ma NON sul
    // corpus (#25, ne' le sue chiuse #24/#21). Un guard solo-label avrebbe
    // giudicato #21 riapribile. Il secondo segnale e' il titolo singleton del
    // modulo stesso.
    const LEDGER = 'Crawler transient failures (rolling ledger)';
    mockWithClosedTwins([twin({ number: 21, title: LEDGER, labels: [{ name: 'crawler-transient' }] })]);

    await createGithubIssue({ title: LEDGER, description: 'misura', priority: 4 } as any);

    expect(callsTo('reopen')).toHaveLength(0);
  });

  it('chiusa come NOT_PLANNED → non si resuscita una decisione umana', async () => {
    mockWithClosedTwins([twin({ stateReason: 'NOT_PLANNED' })]);

    await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(1);
  });

  it('chiusa fuori finestra (60 giorni fa) → issue nuova', async () => {
    mockWithClosedTwins([twin({ closedAt: ISO(24 * 60) })]);

    await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(1);
  });

  it('reopenWithinHours: 0 esplicito → opt-out, torna al comportamento vecchio', async () => {
    mockWithClosedTwins([twin()]);

    await createGithubIssue({
      title: TITLE_NOW,
      description: 'misura',
      priority: 2,
      reopenWithinHours: 0,
    } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(1);
    // E la lista delle chiuse non viene nemmeno interrogata: l'opt-out e' un
    // ramo saltato, non un risultato scartato.
    expect(ghCalls().some((a) => a[0] === 'issue' && a[1] === 'list' && a[3] === 'closed')).toBe(false);
  });

  it('una gemella APERTA vince sulla chiusa: commento, nessuna riapertura', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return args[3] === 'open'
          ? JSON.stringify([{ number: 5427, title: TITLE_TWIN, url: 'u', closedAt: null, state: 'OPEN' }])
          : JSON.stringify([twin()]);
      }
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/999';
      return '';
    });

    const res = await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    expect(callsTo('reopen')).toHaveLength(0);
    expect(callsTo('create')).toHaveLength(0);
    expect(res?.number).toBe(5427);
  });

  it('fra due gemelle valide riapre la piu' + '’' + ' recente', async () => {
    mockWithClosedTwins([
      twin({ number: 4947, closedAt: ISO(24 * 20) }),
      twin({ number: 5136, closedAt: ISO(24 * 2) }),
    ]);

    await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 } as any);

    expect(callsTo('reopen').map((a) => a[2])).toEqual(['5136']);
  });
});
