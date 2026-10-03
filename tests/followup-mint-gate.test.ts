/**
 * Il gate deterministico in ingresso sul conio delle follow-up.
 *
 * Il difetto sorvegliato. `post-merge-followup.yml` conia una issue aggregata per PR
 * mergiata; il divieto di mintare item senza condizione di accettazione falsificabile
 * esisteva solo nel prompt Codex. Misurato il 2026-09-06 sul sito, ultimi 7 giorni:
 * 164 aggregate coniate, 91 (55%) strutturalmente immortali — 76 senza nemmeno un item
 * falsificabile. Una `no-valid-item` non si chiude MAI: `aggregateCloseGate()` la blocca
 * per costruzione (chiuderla sarebbe chiudere su evidenza assente, incidente #5849).
 *
 * PERCHE' ANCHE I PIN SUL SORGENTE, e non solo i casi comportamentali. Su #7577 e #7587
 * i test comportamentali restavano VERDI anche reintroducendo il difetto, perche'
 * esercitavano l'helper in isolamento: un gate che reimplementa in casa il proprio
 * predicato di ammissione supera tutti i casi qui sotto e intanto divergere
 * dall'oracolo di chiusura — che e' esattamente la coda immortale che questo modulo
 * esiste per chiudere (#7587: UN oracolo, i due lati). Allo stesso modo, uno step
 * rimosso dal workflow non fa fallire nessun test comportamentale: il gate semplicemente
 * non gira piu'. I due pin sotto guardano quelle due direzioni.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideMintGate,
  partitionMintedItems,
  rebuildBody,
  retitle,
  itemHeadline,
  parseIssueJson,
  demotedBlock,
  isLosslessSplit,
  canMintQueueLabel,
  hasNeedsHumanLabel,
  hasAutomationDeferredLabel,
  demotedItemsBySourcePr,
  qualifySourcePrLookups,
  triageMarkerCitesBucket,
  preserveDemotedOnSourcePrs,
  decideDailyMintGate,
  partitionDailyBucketItems,
  rebuildDailyBody,
} from '../scripts/ci/gate-minted-followups.mjs';
import {
  citedTokens,
  dedupeDailyItems,
  hasFalsifiableAcceptance,
  parseFollowupItems,
  splitFollowupItems,
} from '../scripts/ci/followup-resolution-match.mjs';

const GATE_SRC = fileURLToPath(new URL('../scripts/ci/gate-minted-followups.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/post-merge-followup.yml', import.meta.url));

const HEAD = `## Origine
- PR: #7600 titolo (merged 2026-09-06)

## Item
`;

const itemValido = ` la soglia va letta da env
- Source: PR body Non implementato
- Stato dichiarato nella PR: \`blocked: manca il dato\`
- Original text: > la soglia e' hardcoded
- Suggested action: sostituisci il letterale con \`intFromEnv('MAX_ITEMS', 10)\` in \`scripts/lib/foo.mjs\`
`;

// La classe dominante: un rischio in prosa sollevato in `## Adversarial check`. Non cita
// nulla che un check possa cercare verbatim, quindi nessuna evidenza potra' mai provarlo
// affrontato — entra in coda e non ne esce piu'.
const itemProsa = ` nessun gate impedisce un drift futuro
- Source: reviewer \`## Adversarial check\`
- Stato dichiarato nella PR: nessuno
- Original text: > il valore potrebbe divergere col tempo
- Suggested action: valutare se serve un campo esplicito
`;

const aggregata = (...items: string[]) =>
  HEAD + items.map((it, i) => `### ${i + 1}.${it}`).join('\n');

const unsafeNoValid = HEAD +
  '### 1. rischio con heading citato\n- Original text:\n```\n### 2. intestazione dentro citazione\n```\n' +
  '- Suggested action: valutare se serve un campo esplicito\n\n' +
  `### 3.${itemProsa}`;

const unsafeUnclosedInfoFence = HEAD +
  '### 1. rischio con fence informata\n```suggestion\n### 2. intestazione ancora nella fence\n- Suggested action: valutare se serve un campo esplicito\n';

const infoFenceLossless = HEAD +
  '### 1. item con fence informata\n- Source: PR body\n- Stato dichiarato nella PR: `blocked: manca il dato`\n' +
  '- Suggested action: chiama `normalizza()` in `scripts/lib/x.mjs`\n```ts\nconst x = 1;\n```\n\n' +
  `### 3.${itemProsa}`;

function runFakeGate({ batchPrs, issue, summaryPath }: { batchPrs: string; issue: object | null; summaryPath: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-gate-test-'));
  const ghPath = join(dir, 'gh');
  const createdAt = new Date().toISOString();
  const issueWithMetadata = issue
    ? { number: 101, title: `follow-up(#${batchPrs}): 3 item deferred - test`, createdAt, ...issue }
    : null;
  const fakeGh = `#!/usr/bin/env node
const args = process.argv.slice(2);
const issue = ${JSON.stringify(issueWithMetadata)};
if (args[0] === 'api') {
  process.stdout.write(JSON.stringify([issue ? [{ number: issue.number, title: issue.title, created_at: issue.createdAt }] : []]));
} else if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify(issue));
}
`;
  writeFileSync(ghPath, fakeGh);
  chmodSync(ghPath, 0o755);
  const result = spawnSync('node', [GATE_SRC], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      BATCH_PRS: batchPrs,
      GH_REPO: 'o/r',
      GITHUB_STEP_SUMMARY: summaryPath,
      DRY_RUN: '0',
      COLLECTION_OK: 'true',
    },
  });
  let summary = '';
  try { summary = readFileSync(summaryPath, 'utf-8'); } catch { /* path intentionally unwritable */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, summary };
}

describe('gate sul conio — comportamento', () => {
  it('needs-human è un veto terminale per una nuova coda minted', () => {
    expect(hasNeedsHumanLabel({ labels: [{ name: 'needs-human' }] })).toBe(true);
    expect(hasNeedsHumanLabel({ labels: ['Needs-Human'] })).toBe(true);
    expect(canMintQueueLabel({ labels: [] })).toBe(true);
    expect(canMintQueueLabel({ labels: [{ name: 'needs-human' }] })).toBe(false);
    for (const labels of [[{}], [null], [''], [{ name: '' }], [{ name: null }], ['ok', {}]]) {
      expect(canMintQueueLabel({ labels })).toBe(false);
    }
    expect(canMintQueueLabel({})).toBe(false);
  });

  it('automation-deferred blocca una nuova coda finché lo sweep non cambia l’input', () => {
    const issue = { labels: [{ name: 'automation-deferred' }] };
    expect(hasAutomationDeferredLabel(issue)).toBe(true);
    expect(canMintQueueLabel(issue)).toBe(false);
  });

  it('fu-parked lascia al drainer il controllo del retry', () => {
    expect(canMintQueueLabel({ labels: [{ name: 'fu-parked' }] })).toBe(false);
    expect(canMintQueueLabel({ labels: ['FU-PARKED'] })).toBe(false);
    expect(canMintQueueLabel({ labels: [{ name: 'fu-reparked:1' }] })).toBe(true);
  });

  it('un padre decomposto o in decomposizione non rientra in agent:fix-queued', () => {
    // Titolo di fallimento: «Gate sul conio: un padre decomposto è stato rimesso in
    // `agent:fix-queued`». Un padre `decomposed:1` ha item `open` per costruzione (il
    // lavoro è delle figlie): riaccodarlo a ogni run e farlo ritogliere dal drainer
    // (PARENT-DEQUEUE) è un ciclo label/commento senza fine (#9443, #9508).
    for (const name of ['decomposed:1', 'agent:decompose-queued', 'agent:decompose']) {
      expect(canMintQueueLabel({ labels: [{ name }] }), name).toBe(false);
      expect(canMintQueueLabel({ labels: ['follow-up', name.toUpperCase()] }), name).toBe(false);
    }
    // Solo il nome esatto: una figlia (`from-decompose`) e un retry restano accodabili.
    expect(canMintQueueLabel({ labels: [{ name: 'from-decompose' }] })).toBe(true);
    expect(canMintQueueLabel({ labels: [{ name: 'decompose-retried' }] })).toBe(true);
  });

  it('maybe-resolved da sola NON è un veto: un bucket con item aperti deve poter tornare in coda', () => {
    expect(canMintQueueLabel({ labels: [{ name: 'maybe-resolved' }] })).toBe(true);
  });

  it('sopprime l\'aggregata in cui NESSUN item porta una condizione falsificabile', () => {
    const d = decideMintGate({ body: aggregata(itemProsa, itemProsa), createdAt: new Date().toISOString() });
    expect(d.action).toBe('suppress');
    expect(d.reason).toBe('no-valid-item');
    expect(d.demoted).toHaveLength(2);
  });

  it('demota i soli item non falsificabili e ricompone il corpo coi superstiti rinumerati', () => {
    const d = decideMintGate({ body: aggregata(itemProsa, itemValido, itemProsa), createdAt: new Date().toISOString() });
    expect(d.action).toBe('demote');
    expect(d.valid).toHaveLength(1);
    expect(d.demoted).toHaveLength(2);
    // Il superstite diventa `### 1.` (formato uniforme, parsabile dal fixer) e la prosa sparisce.
    expect(d.body).toContain('### 1. la soglia va letta da env');
    expect(d.body).not.toContain('nessun gate impedisce un drift futuro');
    expect(d.body).not.toMatch(/^### 2\./m);
    // Il corpo ricostruito e' ancora leggibile dallo stesso oracolo: 1 item, valido.
    const p = partitionMintedItems(d.body as string);
    expect(p.valid).toHaveLength(1);
    expect(p.demoted).toHaveLength(0);
  });

  it('non tocca l\'aggregata in cui ogni item e\' gia\' falsificabile', () => {
    const d = decideMintGate({ body: aggregata(itemValido, itemValido), createdAt: new Date().toISOString() });
    expect(d.action).toBe('keep');
  });

  it('non sopprime un corpo non ricomponibile anche quando nessun item e\' valido', () => {
    expect(isLosslessSplit(unsafeNoValid)).toBe(false);
    const d = decideMintGate({ body: unsafeNoValid, createdAt: new Date().toISOString() });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('unsafe-rewrite');
  });

  it('non tratta un heading in una fence informata non chiusa come un item vero', () => {
    expect(isLosslessSplit(unsafeUnclosedInfoFence)).toBe(false);
    const d = decideMintGate({ body: unsafeUnclosedInfoFence, createdAt: new Date().toISOString() });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('unsafe-rewrite');
  });

  it('IL VERSO SICURO: un corpo senza struttura a item non viene MAI soppresso', () => {
    // «Non so leggerlo» non e' «e' vuoto» — stessa regola di `aggregateCloseGate`.
    // Sopprimere qui cancellerebbe lavoro vero che il conio ha solo formattato male.
    const d = decideMintGate({ body: 'testo libero senza nessuna sezione item', createdAt: new Date().toISOString() });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('aggregate-unparsed');
  });

  it('non riscrive una issue che non e\' appena stata coniata', () => {
    // Un backfill via workflow_dispatch su una PR vecchia non deve poter riscrivere
    // una issue che nel frattempo un umano ha curato.
    const vecchia = new Date(Date.now() - 30 * 864e5).toISOString();
    expect(decideMintGate({ body: aggregata(itemProsa), createdAt: vecchia }).action).toBe('skip');
    expect(decideMintGate({ body: aggregata(itemProsa), createdAt: vecchia }).reason).toBe('not-freshly-minted');
  });

  it('riallinea il conteggio nel titolo e sa estrarre la riga dell\'item demoto', () => {
    expect(retitle('follow-up(#7600): 4 item deferred — foo', 1)).toBe('follow-up(#7600): 1 item deferred — foo');
    // Il conio è un LLM e può usare un sostantivo diverso: lì il replace sarebbe un no-op
    // silenzioso e il titolo resterebbe sul conteggio VECCHIO. Meglio `null` — non tocco
    // il titolo e lo dico — che riscriverlo identico fingendo di averlo riallineato.
    expect(retitle('follow-up(#7600): 4 residui deferred — foo', 1)).toBeNull();
    // E «già allineato» NON è «senza conteggio»: col confronto fatto DOPO il replace le
    // due cose collassavano, e il log diceva «titolo senza conteggio, resta disallineato»
    // su un titolo perfettamente allineato — proprio nell'unico posto in cui si guarda
    // per capire un disallineamento.
    expect(retitle('follow-up(#7600): 1 item deferred — foo', 1)).toBe('follow-up(#7600): 1 item deferred — foo');
    // `gh()` ritorna null quando fallisce, e `JSON.parse(null)` NON lancia: legge "null"
    // e ritorna null. Senza questo filtro l'oggetto nullo entrava nella lista.
    expect(parseIssueJson(null)).toBeNull();
    expect(parseIssueJson('null')).toBeNull();
    expect(parseIssueJson('')).toBeNull();
    expect(parseIssueJson('[]')).toBeNull();
    expect(parseIssueJson('{"number":1}')).toEqual({ number: 1 });
    expect(itemHeadline(itemProsa)).toBe('nessun gate impedisce un drift futuro');
  });

  it('rebuildBody non perde la testa della issue (origine + PR di provenienza)', () => {
    const b = rebuildBody(HEAD, [itemValido]);
    expect(b).toContain('- PR: #7600');
    expect(b).toContain('### 1.');
  });
});

describe('gate sul conio — la demozione non perde il testo', () => {
  it('il blocco per la PR porta il TESTO INTEGRALE dell\'item, non la sua prima riga', () => {
    // Nel ramo `demote` il corpo della issue viene riscritto senza gli item demoti: questo
    // blocco e' l'unica copia che resta. Se conservasse il solo titolo, il prezzo
    // dichiarato («resta leggibile sulla PR») sarebbe falso, e in modo irreversibile.
    const b = demotedBlock([itemProsa]);
    expect(b).toContain('nessun gate impedisce un drift futuro');
    expect(b).toContain('- Source: reviewer');
    expect(b).toContain('- Stato dichiarato nella PR: nessuno');
    expect(b).toContain('- Original text: > il valore potrebbe divergere col tempo');
    expect(b).toContain('- Suggested action: valutare se serve un campo esplicito');
  });

  it('NON riscrive un corpo che non si ricompone identico dai suoi item', () => {
    // `splitFollowupItems()` spezza su `^### \d+\.` anche dentro un blocco citato, e il
    // conio cita verbatim body di PR e review, che usano quel formato. Il frammento
    // spurio farebbe buttare via la coda dell'item vero: il round-trip lo intercetta.
    // La citazione sta in un blocco recintato, cioe' a colonna zero: e' li' che
    // `^### \d+\.` colpisce davvero. (Una citazione indentata o dentro un `>` non
    // comincia a colonna zero e resta innocua — il caso sotto lo mostra.)
    const conCitazione = HEAD +
      '### 1. item che cita il body di una PR\n- Original text:\n```\n### 2. la PR citata numerava cosi\n```\n' +
      '- Suggested action: chiama `normalizza()` in `scripts/lib/x.mjs`\n\n' +
      `### 2.${itemProsa}`;
    expect(isLosslessSplit(conCitazione)).toBe(false);
    const d = decideMintGate({ body: conCitazione, createdAt: new Date().toISOString() });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('unsafe-rewrite');
    expect(d.body).toBeNull();
  });

  it('un corpo normale si ricompone identico, quindi la demozione parte', () => {
    expect(isLosslessSplit(aggregata(itemValido, itemProsa))).toBe(true);
    expect(decideMintGate({ body: aggregata(itemValido, itemProsa), createdAt: new Date().toISOString() }).action).toBe('demote');
  });

  it('considera lossless una numerazione non consecutiva e mantiene attivo il ramo demote', () => {
    const body = HEAD + `### 1.${itemValido}\n### 3.${itemProsa}`;
    expect(isLosslessSplit(body)).toBe(true);
    const d = decideMintGate({ body, createdAt: new Date().toISOString() });
    expect(d.action).toBe('demote');
    expect(d.body).toContain('### 1. la soglia va letta da env');
  });

  it('riconosce le fence con info string e normalizza anche una numerazione duplicata', () => {
    expect(isLosslessSplit(infoFenceLossless)).toBe(true);
    const duplicate = HEAD + `### 1.${itemValido}\n### 1.${itemProsa}`;
    expect(isLosslessSplit(duplicate)).toBe(true);
  });

  it('porta unsafe-rewrite nel job summary invece di saltarlo in silenzio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mint-gate-summary-'));
    const summaryPath = join(dir, 'summary.md');
    writeFileSync(summaryPath, '');
    const result = runFakeGate({ batchPrs: '900', issue: { body: unsafeNoValid }, summaryPath });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(result.summary).toContain('unsafe-rewrite');
    expect(result.stdout).toContain('MINT_GATE_TALLY');
    expect(result.stdout).toContain('reason=unsafe-rewrite');
  });
});

describe('gate sul conio — conservazione per item e per repository', () => {
  const dailyItem = (id: string, sources: string, what: string) => [
    `\n- State: open`,
    `- Sources: ${sources}`,
    `- Suggested action: controllare ${what}`,
  ].join('\n');
  const marker = (bucket: number) => JSON.stringify({ comments: [
    { body: `## Post-merge follow-up triage\nBucket giornaliero: #${bucket} (daily).` },
  ] });

  it('ogni item demoto va solo sulle PR della SUA Sources; senza Sources, sul fallback', () => {
    const groups = demotedItemsBySourcePr([
      dailyItem('a', 'PR #1742', 'a'),
      dailyItem('b', 'PR #1740; PR #1742', 'b'),
      '\n- Suggested action: nessuna fonte',
    ], [1740, 1742, 1771]);
    const byPr = Object.fromEntries(groups.map(({ pr, items }) => [pr, items.map((it) => /controllare (\w)/.exec(it)?.[1] ?? 'x')]));
    expect(byPr).toEqual({ 1742: ['a', 'b', 'x'], 1740: ['b', 'x'], 1771: ['x'] });
  });

  it('il ramo suppress di un daily conserva il TESTO, non [object Object]', () => {
    const body = [
      '## Batch',
      '- Daily key: 2026-09-25 (Europe/Zurich)',
      '- State: collecting',
      '- Target repository: o/r',
      '',
      '### FU-2026-09-25-001 — vago',
      '- State: open',
      '- Sources: PR #1742',
      '- Suggested action: controllare il file',
      '',
    ].join('\n');
    const d = decideMintGate({ title: 'follow-up(daily:2026-09-25): 1 item — o/r', body }, { triageComplete: true });
    expect(d.action).toBe('suppress');
    expect(d.demoted.every((it: unknown) => typeof it === 'string')).toBe(true);
    expect(demotedBlock(d.demoted)).toContain('- Sources: PR #1742');
    expect(demotedBlock(d.demoted)).not.toContain('[object Object]');
  });

  it('qualifica la PR col repository il cui marker cita il bucket', () => {
    const site = { repo: 'site/r', read: () => ({ ok: true, comments: marker(1234) }) };
    const corpus = { repo: 'corpus/r', read: () => ({ ok: true, comments: marker(9769) }) };
    expect(triageMarkerCitesBucket(marker(9769), 9769)).toBe(true);
    expect(triageMarkerCitesBucket(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\nbucket per PR #9769: #1' }] }), 9769)).toBe(false);
    // Marker REALE di #10050: un bucket per bullet, `#N` + tag daily, senza «bucket».
    const realMarker = JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\n\nCreated/updated: 1 item.\n- Corpus #1957 `follow-up(daily:2026-09-28)` — `FU-2026-09-28-010` (riallineamento della baseline adattata in `scripts/ci/loop-sync-manifest.json`).\n\nDropped: 3 item — `non-actionable-churn` (reviewer ❓ marcato `deferred, non funnel-critical`).' }] });
    expect(triageMarkerCitesBucket(realMarker, 1957)).toBe(true);
    expect(triageMarkerCitesBucket(realMarker, 10050)).toBe(false);
    expect(triageMarkerCitesBucket(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\n- PR #1957 `follow-up(daily:2026-09-28)`' }] }), 1957)).toBe(false);
    // Review #10338: la forma col tag vale solo nella finestra di claim del
    // collector; una citazione storica dopo la lista non qualifica il bucket.
    const withHistory = JSON.stringify({ comments: [{ body: [
      '## Post-merge follow-up triage',
      '',
      'Created/updated: 1 item.',
      '- Corpus #1957 `follow-up(daily:2026-09-28)` — `FU-2026-09-28-009`',
      '',
      'Historical #10171 `follow-up(daily:2026-09-28)`',
    ].join('\n') }] });
    expect(triageMarkerCitesBucket(withHistory, 1957)).toBe(true);
    expect(triageMarkerCitesBucket(withHistory, 10171)).toBe(false);
    // `pull-request #N` e' una PR, non un bucket.
    const pullRequest = JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\nCreated/updated: 1 item.\n- pull-request #1957 `follow-up(daily:2026-09-28)`' }] });
    expect(triageMarkerCitesBucket(pullRequest, 1957)).toBe(false);
    expect(qualifySourcePrLookups(1742, 9769, [site, corpus])!.map((l) => l.repo)).toEqual(['corpus/r']);
    // Nessun marker cita il bucket: risoluzione legacy, primo repository in cui e' una PR.
    expect(qualifySourcePrLookups(1742, 5555, [site, corpus])!.map((l) => l.repo)).toEqual(['site/r']);
    // Lettura indisponibile prima di poter decidere: null, niente riscrittura.
    const broken = { repo: 'corpus/r', read: () => ({ ok: false, notPr: false }) };
    expect(qualifySourcePrLookups(1742, 9769, [site, broken])).toBeNull();
    const absent = { repo: 'corpus/r', read: () => ({ ok: false, notPr: true }) };
    expect(qualifySourcePrLookups(1742, 9769, [absent])).toEqual([]);
  });

  it('un commento per PR sorgente, con i soli suoi item', () => {
    const posts: Array<{ repo: string; pr: number; body: string }> = [];
    const lookups = [
      { repo: 'site/r', read: (n: number) => (n === 1742 ? { ok: true, comments: marker(1) } : { ok: false, notPr: true }) },
      { repo: 'corpus/r', read: () => ({ ok: true, comments: marker(9769) }) },
    ];
    const results = preserveDemotedOnSourcePrs({
      bucketNumber: 9769,
      demoted: [dailyItem('a', 'PR #1742', 'uno'), dailyItem('b', 'PR #1740', 'due')],
      fallbackTargets: [1740, 1742],
      intro: '<!-- followup-mint-gate -->\nIssue #9769 resta aperta',
      lookups,
      post: (lookup: { repo: string }, pr: number, body: string) => { posts.push({ repo: lookup.repo, pr, body }); return 'ok'; },
      log: () => {},
    });
    expect(results).toEqual(['ok', 'ok']);
    expect(posts.map((p) => `${p.repo}#${p.pr}`)).toEqual(['corpus/r#1742', 'corpus/r#1740']);
    expect(posts[0].body).toContain('controllare uno');
    expect(posts[0].body).not.toContain('controllare due');
    expect(posts[1].body).toContain('controllare due');
    expect(posts[1].body).not.toContain('controllare uno');
  });
});

// Titolo di fallimento: «Gate sul conio: item già `done` rimosso dal corpo del bucket».
// Misurato il 2026-10-02 sul bucket 10677: FU-064 marcato `done` alle 11:38Z, demoto e
// tolto dal corpo alle 22:08Z. Un bucket `collecting` viene ripartizionato a ogni
// passata e gli oracoli di ammissione guardano lo stato di OGGI, non quello del conio.
describe('gate sul conio — un item già done è un fatto registrato, non un candidato', () => {
  const DAY = '2026-10-02';
  const TITLE = `follow-up(daily:${DAY}): 2 items — owner/repo`;
  const falsifiable = (id: string, state: string, token = 'firstGuard()') => [
    `### ${id} — Proteggi il comportamento`,
    `- State: ${state}`,
    '- Sources: PR #8101; reviewer 🟡',
    '- Target file: `scripts/example.mjs`',
    `- Suggested action: aggiungi \`${token}\` in \`scripts/example.mjs\``,
    `- Acceptance token: \`${token}\``,
  ].join('\n');
  // Accettazione non falsificabile: l'oracolo di oggi la respinge.
  const vague = (id: string, state: string) => [
    `### ${id} — Rischio da rivalutare`,
    `- State: ${state}`,
    '- Sources: PR #8102; reviewer 🟡',
    '- Suggested action: valuta il rischio in futuro',
  ].join('\n');
  // Item macchina: ammesso solo finché il workflow citato è rotto.
  const machine = (id: string, state: string) => [
    `### ${id} — Ripara la misura`,
    `- State: ${state}`,
    '- Sources: PR #8103; reviewer 🟡',
    '- Target file: `.github/workflows/measure.yml`',
    '- Suggested action: chiamare `machineCheck()` in `.github/workflows/measure.yml`',
  ].join('\n');
  const bucket = (...items: string[]) => [
    '## Batch',
    `- Daily key: ${DAY} (Europe/Zurich)`,
    '- State: collecting',
    '- Target repository: owner/repo',
    '',
    '## Item',
    ...items.flatMap((entry) => ['', entry]),
    '',
  ].join('\n');
  const idsAndStates = (text: string) => parseFollowupItems(text).map((item) => `${item.id}:${item.state}`);
  const withWorkflow = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'mint-gate-done-'));
    try {
      writeFileSync(join(dir, 'measure.yml'), 'name: Measure\non: workflow_dispatch\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/ci/measure.mjs\n');
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('un item done con accettazione oggi non falsificabile resta nel corpo, done, e non è fra i demoti', () => {
    const source = bucket(falsifiable(`FU-${DAY}-001`, 'open'), vague(`FU-${DAY}-002`, 'done'));
    const partition = partitionDailyBucketItems(source);
    expect(partition.demoted).toEqual([]);
    expect(partition.donePreserved).toEqual([`FU-${DAY}-002`]);

    const decision = decideDailyMintGate({ title: TITLE, body: source });
    expect(decision.action).toBe('seal');
    expect(decision.demoted).toEqual([]);
    expect(decision.donePreserved).toEqual([`FU-${DAY}-002`]);
    // Conteggio, ID stabili e stati invariati: il reconciler non vede `mismatched-item-count`.
    expect(idsAndStates(decision.body || '')).toEqual(idsAndStates(source));
  });

  it('lo stesso item, ma open, viene demoto come prima', () => {
    const source = bucket(falsifiable(`FU-${DAY}-001`, 'open'), vague(`FU-${DAY}-002`, 'open'));
    const decision = decideDailyMintGate({ title: TITLE, body: source });
    expect(decision.action).toBe('demote');
    expect(decision.donePreserved).toEqual([]);
    expect(decision.demoted.join('\n')).toContain('valuta il rischio in futuro');
    expect(idsAndStates(decision.body || '')).toEqual([`FU-${DAY}-001:open`]);
  });

  it('solo done salta l\'ammissione: in-progress e blocked restano valutati', () => {
    for (const state of ['in-progress', 'blocked']) {
      const source = bucket(falsifiable(`FU-${DAY}-001`, 'open'), vague(`FU-${DAY}-002`, state));
      const partition = partitionDailyBucketItems(source);
      expect(partition.demoted.map((item: { id: string }) => item.id)).toEqual([`FU-${DAY}-002`]);
      expect(partition.donePreserved).toEqual([]);
    }
  });

  it('un item macchina done sopravvive quando il workflow che ha riparato non è più rotto', () => {
    withWorkflow((dir) => {
      const healthy = {
        workflowDirectory: dir,
        getRuns: () => [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }],
      };
      const done = bucket(falsifiable(`FU-${DAY}-001`, 'open'), machine(`FU-${DAY}-002`, 'done'));
      const kept = decideDailyMintGate({ title: TITLE, body: done }, { machineOptions: healthy });
      expect(kept.action).toBe('seal');
      expect(kept.donePreserved).toEqual([`FU-${DAY}-002`]);
      expect(idsAndStates(kept.body || '')).toEqual(idsAndStates(done));

      // Controllo: lo stesso item ancora open, stesso oracolo → demoto.
      const open = bucket(falsifiable(`FU-${DAY}-001`, 'open'), machine(`FU-${DAY}-002`, 'open'));
      const dropped = decideDailyMintGate({ title: TITLE, body: open }, { machineOptions: healthy });
      expect(dropped.action).toBe('demote');
      expect(idsAndStates(dropped.body || '')).toEqual([`FU-${DAY}-001:open`]);
    });
  });

  it('un bucket già sealed non perde un item done a una passata successiva', () => {
    const source = bucket(falsifiable(`FU-${DAY}-001`, 'open'), vague(`FU-${DAY}-002`, 'done'))
      .replace('- State: collecting', '- State: sealed');
    const decision = decideDailyMintGate({ title: TITLE, body: source });
    expect(decision).toMatchObject({ action: 'keep', reason: 'already-sealed', body: null });
    expect(decision.donePreserved).toEqual([`FU-${DAY}-002`]);
  });

  it('coppia duplicata done + open: resta il done, in qualunque ordine, con le Sources di entrambi', () => {
    const third = falsifiable(`FU-${DAY}-003`, 'open', 'thirdGuard()');
    const openTwin = falsifiable(`FU-${DAY}-001`, 'open');
    const doneTwin = falsifiable(`FU-${DAY}-002`, 'done').replace('PR #8101', 'PR #8104');
    for (const source of [bucket(openTwin, third, doneTwin), bucket(doneTwin, third, openTwin)]) {
      const parsed = parseFollowupItems(source);
      const result = dedupeDailyItems(parsed, 'owner/repo');
      expect(result.duplicates.map((entry) => entry.item.id)).toEqual([`FU-${DAY}-001`]);
      const survivor = result.items.find((item) => item.id === `FU-${DAY}-002`);
      expect(survivor?.state).toBe('done');
      expect(survivor?.text).toContain('PR #8101');
      expect(survivor?.text).toContain('PR #8104');
      // I superstiti restano nell'ordine sorgente.
      const order = parsed.map((item) => item.id).filter((id) => id !== `FU-${DAY}-001`);
      expect(result.items.map((item) => item.id)).toEqual(order);

      const decision = decideDailyMintGate({ title: TITLE, body: source });
      expect(decision.action).toBe('dedupe');
      const rebuilt = parseFollowupItems(decision.body || '');
      expect(rebuilt.map((item) => `${item.id}:${item.state}`).sort())
        .toEqual([`FU-${DAY}-002:done`, `FU-${DAY}-003:open`]);
    }
  });

  it('rebuildDailyBody lascia byte-identico il testo di un item done conservato', () => {
    const doneItem = vague(`FU-${DAY}-002`, 'done');
    const source = bucket(falsifiable(`FU-${DAY}-001`, 'open'), doneItem);
    const { head, valid } = partitionDailyBucketItems(source);
    expect(rebuildDailyBody(head, valid)).toContain(doneItem);
  });

  it('PIN: la riga contabile porta done_preserved, la misura del difetto', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    expect(src).toMatch(/MINT_GATE_TALLY[^\n]*done_preserved=\$\{t\.donePreserved\}/);
  });
});

describe('gate sul conio — pin sul sorgente', () => {
  it('PIN: il sealing richiede triage_complete verificato su ogni PR, mai batch vuoto/solo exit 0', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    const wf = readFileSync(WORKFLOW, 'utf-8');
    expect(src).toContain("process.env.TRIAGE_COMPLETE === 'true'");
    expect(wf).toContain('Verify complete follow-up triage');
    expect(wf).toContain('triage_complete=$complete');
    expect(wf).toContain('BATCH_COUNT: ${{ steps.collect.outputs.batch_count }}');
    expect(src).toContain("process.env.COLLECTION_OK === 'true'");
    // Marker e persistenza per ogni PR si verificano con il predicato unico del
    // collector, non con una copia bash (che non conosceva la prova del gate).
    expect(wf).toContain('node scripts/ci/collect-followup-batch.mjs --verify-persistence "$csv"');
    expect(wf).not.toContain('bucket_persisted_for_pr');
    expect(wf).toContain('persistence_ok=$persistence_ok');
    expect(wf).not.toContain("steps.collect.outputs.batch_count == '0' || steps.followup.outputs.claude_outcome");
  });

  it('PIN: le scritture ottimistiche verificano titolo oltre al body', () => {
    const gate = readFileSync(GATE_SRC, 'utf-8');
    const reconcile = readFileSync(fileURLToPath(new URL('../scripts/ci/reconcile-followups.mjs', import.meta.url)), 'utf-8');
    expect(gate).toContain('sameIssueSnapshot');
    expect(gate).toContain("String(actual.title || '') === String(expected?.title || '')");
    expect(reconcile).toContain("String(latest.title || '') !== String(iss.title || '')");
    expect(reconcile).toContain("'--json', 'title,body'");
  });

  it('PIN: il gate verifica anche le issue del corpus e commenta la PR sul sito', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    const wf = readFileSync(WORKFLOW, 'utf-8');
    expect((wf.match(/node scripts\/ci\/gate-minted-followups\.mjs/g) || [])).toHaveLength(2);
    expect(wf).toContain('GH_REPO: nanakokyobashi-rgb/frontaliere-articles');
    expect(wf).toContain('GH_TOKEN: ${{ env.GITHUB_PAT_NANAKO || env.GITHUB_PAT }}');
    expect(wf).toContain('GATE_PR_REPO: ${{ github.repository }}');
    expect(src).toContain('GATE_PR_TOKEN');
    expect(src).toContain('function ghPr(');
    expect(wf).toMatch(/if \[ -z "\$\{GH_TOKEN:-\}" \]/);
    expect(src).toContain("const prRepoArgs = process.env.GATE_PR_REPO ? ['--repo', process.env.GATE_PR_REPO] : repoArgs;");
    expect(src).toContain("['pr', 'comment', String(pr), ...prRepoArgs");
    // I daily del sito portano anche Sources del corpus (#9443): lo step del sito
    // dichiara il repository gemello in cui risolverle, con il token del corpus.
    expect(wf).toContain('GATE_ALT_PR_REPO: nanakokyobashi-rgb/frontaliere-articles');
    expect(wf).toContain('GATE_ALT_PR_TOKEN: ${{ env.GITHUB_PAT_NANAKO || env.GITHUB_PAT }}');
  });

  it('PIN: un summary non scrivibile non cambia il verdetto dopo le scritture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mint-gate-unwritable-summary-'));
    const summaryPath = join(dir, 'missing', 'summary.md');
    const result = runFakeGate({ batchPrs: '999999', issue: null, summaryPath });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('summary non scrivibile');
  });

  it('PIN: il criterio di ingresso E\' l\'oracolo di uscita, importato — mai reimplementato', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    // Direzione 1 del difetto: il gate si scrive un predicato proprio. I casi
    // comportamentali sopra resterebbero verdi (un clone si comporta uguale... finche'
    // uno dei due non cambia), e i due lati tornerebbero a divergere — #7587.
    expect(src).toMatch(/import\s*\{[^}]*hasFalsifiableAcceptance[^}]*\}\s*from\s*'\.\/followup-resolution-match\.mjs'/s);
    expect(src).toMatch(/import\s*\{[^}]*splitFollowupItems[^}]*\}\s*from\s*'\.\/followup-resolution-match\.mjs'/s);
    expect(src).toMatch(/import\s*\{[^}]*machineAdmission[^}]*\}\s*from\s*'\.\/lib\/machine-broken\.mjs'/s);
    expect(src).toContain('machineAdmission(it');
    // Nessuna copia locale dell'oracolo: ne' una funzione omonima, ne' la regione
    // `Suggested action` riconosciuta a mano, ne' una soglia di token propria.
    expect(src).not.toMatch(/function\s+hasFalsifiableAcceptance/);
    expect(src).not.toMatch(/function\s+isDistinctiveToken/);
    expect(src).not.toMatch(/\/suggested action\/i/i);
    expect(src).not.toMatch(/ACCEPTANCE_CONDITION\s*=/);
  });

  it('PIN: si CONSERVA prima di distruggere — il commento sulla PR precede la riscrittura', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    // Terza direzione che nessun caso comportamentale vede: l'ORDINE delle due scritture.
    // Riscrivere il corpo e poi provare a commentare perde gli item per sempre quando la
    // seconda chiamata fallisce — ed e' la finestra in cui `gh` fallisce piu' spesso
    // (rate limit dopo N scritture in un batch).
    const comment = src.indexOf("'pr', 'comment'");
    const edit = src.indexOf("'issue', 'edit'");
    expect(comment).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(-1);
    expect(comment).toBeLessThan(edit);
    // E la riscrittura e' esplicitamente subordinata all'esito del commento.
    expect(src).toMatch(/d\.action === 'demote' && posted === null/);
  });

  it('PIN: ogni demozione lascia una traccia CONTABILE, non solo prosa in un commento', () => {
    const src = readFileSync(GATE_SRC, 'utf-8');
    // Senza un conteggio grep-abile, un item scartato a torto sparisce e nessuno può
    // mostrare che il filtro non è troppo aggressivo: «atteso zero» diventerebbe una
    // misura su un lato solo. Nessun caso comportamentale vede la sparizione di questa
    // riga, perché non cambia nessuna decisione.
    expect(src).toContain('MINT_GATE_TALLY');
    expect(src).toMatch(/demoted=\$\{t\.demoted\}/);
    expect(src).toMatch(/demotedTotal/);
  });

  it('PIN: la misura che regge la clausola «formula poi giudica» è vera oggi, e la clausola c\'è', () => {
    // Questo test PARTE dalla misura, così se la clausola sparisce dal prompt cade
    // citando il perché invece di dire soltanto «manca una stringa».
    // Il metro NON si applica al bullet grezzo: lì `suggestedActionText()` ricade
    // sull'intero testo e i backtick destinati a `Original text` fanno sembrare l'item
    // ammissibile, mentre alla chiusura quella regione è esclusa per costruzione.
    const bullet = 'Nessun gate rilegge `manifest.counts` dopo il transport, quindi un set troncato passa.';
    const coniato = `### 1. x\n- Original text:\n  > ${bullet}\n- Suggested action: valutare se serve un controllo esplicito\n`;
    expect(citedTokens(bullet)).toEqual(['manifest.counts']); // ammissione col metro whole-body
    expect(citedTokens(splitFollowupItems(coniato)[0])).toEqual([]); // chiusura: regione esclusa
    // La cintura che rende innocua la divergenza per il predicato di ammissione:
    // `holds()` esige la regione, quindi dal gate quel fallback non è raggiungibile.
    expect(hasFalsifiableAcceptance(bullet)).toBe(false);
    // E il prompt del conio porta la clausola che chiude la classe a monte.
    const wf = readFileSync(WORKFLOW, 'utf-8');
    expect(wf).toContain('PRIMA FORMULA L\'AZIONE, POI GIUDICA QUELLA');
    expect(wf).toMatch(/DERIVALO invece di scartarlo/);
  });

  it('PIN: lo step gira nel workflow, zero-Claude, DOPO il conio e senza poterlo far cadere', () => {
    const wf = readFileSync(WORKFLOW, 'utf-8');
    // Direzione 2: lo step viene tolto o spostato prima del conio. Nessun test
    // comportamentale se ne accorge — il gate semplicemente non gira piu'.
    const gate = wf.indexOf('node scripts/ci/gate-minted-followups.mjs');
    const conio = wf.indexOf('uses: ./.github/actions/claude-codex-fallback');
    const stepStart = wf.lastIndexOf('- name: Run Codex Luna Max follow-up triage', conio);
    expect(gate).toBeGreaterThan(-1);
    expect(conio).toBeGreaterThan(-1);
    expect(stepStart).toBeGreaterThan(-1);
    expect(stepStart).toBeLessThan(conio);
    expect(gate).toBeGreaterThan(conio);
    expect(wf.slice(stepStart, gate)).toContain('Run Codex Luna Max follow-up triage');
    // Deve girare anche se il conio e' morto in timeout DOPO aver creato la issue,
    // e non deve poter far fallire il triage.
    const step = wf.slice(wf.lastIndexOf('- name:', gate), gate);
    expect(step).toContain('if: always()');
    expect(step).toContain('continue-on-error: true');
    // Zero-Claude: nessun token/OAuth in questo step.
    expect(step).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
