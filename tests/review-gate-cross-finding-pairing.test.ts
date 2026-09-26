import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyReview,
  historicalImportantFindings,
  importantFindings,
  partitionHistoricalImportantFindings,
  runReviewGate,
} from '../scripts/ci/review-gate.mjs';

// Accoppiamento per cardinalità FRA finding sullo stesso path (#9968).
//
// Replay delle quattro review reali di valerielinc-ops/frontaliere-si-o-no#9968.
// Un finding a citazione singola (A: `L378`) e uno a due citazioni sullo
// stesso file (B: `L374` + `L391`; la riga del ledger che il parser leggeva
// come un terzo finding C: `L374` non e' piu' un finding) restavano aperti per sempre: il ramo «stable line order»
// considerava solo i finding a citazione singola e il pairing per cardinalità
// di #9341 saltava B perché A citava lo stesso path. Due `## LGTM` con
// `Important: 0` e il gate BLOCKING invariato su c99766c6 ed ed4e4abe.

const FILE = 'components/community/RewardedApplicationOffer.tsx';
const SHA = {
  first: '14338d0705d60a1b1f19ac6f0931414b7562740b',
  second: '966f9a224ada4a44c545c0db6db8da94582ee1ae',
  third: 'c99766c65c78371cfbe7a0add191ef3e40bd0a49',
  fourth: 'ed4e4abe62331a754663be9bb8a9fd491e317316',
};

let nextId = 5326905603;
const bot = (lines: string[], commit: string) => ({
  id: nextId++,
  user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
  state: 'COMMENTED',
  body: lines.join('\n'),
  commit_id: commit,
});

const reviewA = bot([
  '<!-- REVIEW_INPUT_REVISION: body:77c9fddebe44a9b08bd53ab152a8fa002a76745f31e939e464514a411b5e5c55 -->',
  '<!-- CODEX_FALLBACK_REVIEW -->',
  '## Scope',
  'Review del fallback GPT per Offerwall tardiva, del TTL rewarded e della localizzazione dell’overlay (tier: normal).',
  '',
  '## Findings (Important: 1, Nit: 0)',
  'components/community/RewardedApplicationOffer.tsx:L378: 🔴 Important: [funnel] Il callback `onShown` trasferisce sempre la UI a `offerwall_visible` anche dopo l’avvio del video GPT: `gptVideoStartedRef` impedisce solo il dispose dello slot, mentre senza `AbortController` (o con un callback già in coda) la Offerwall tardiva può sovrapporsi al video rewarded attivo e sostituire il flusso dell’utente. Aggiungere una guardia che renda il GPT autorevole dopo l’opt-in e impedisca l’handoff tardivo. Accettazione: input “il video GPT parte, poi appare una Offerwall tardiva” → output “nessun `setPhase(\'offerwall_visible\')`, nessun overlay Offerwall, il flusso GPT continua da solo”.',
  '',
], SHA.first);

const reviewB = bot([
  '<!-- REVIEW_INPUT_REVISION: body:cd6e1617045ba7004426fb2332e17435ec5f73ac8b9e5a04af288033ecba7c51 -->',
  '<!-- CODEX_FALLBACK_REVIEW -->',
  '',
  '## Scope',
  'Re-review del delta del fallback Offerwall/GPT e delle sue interazioni nel componente dell’offerta (tier: incremental).',
  '',
  '## Findings (Important: 1, Nit: 0)',
  'components/community/RewardedApplicationOffer.tsx:L374, L391: 🔴 Important: [funnel] La guardia rende autorevole GPT solo per `onShown`; dopo l’opt-in, una Offerwall tardiva può ancora entrare in `onClosed` a `components/community/RewardedApplicationOffer.tsx:L391`, impostare `offerwall_verifying` e smontare il percorso GPT, quindi il video attivo non continua da solo. Proteggere entrambi i callback dopo l’opt-in impedendo ogni handoff o cambio di fase dell’Offerwall tardiva. Accettazione: input “il video GPT parte, poi la Offerwall tardiva appare e si chiude” → output “nessun cambio a `offerwall_visible`/`offerwall_verifying`, nessun overlay Offerwall, il flusso GPT continua fino al reward”.',
  '',
  '## Findings ledger (id stabile + stato)',
  '- `eabf305bc1f8` **open** — components/community/RewardedApplicationOffer.tsx:L374, L391: 🔴 Important: [funnel] La Offerwall tardiva può ancora sostituire il flusso GPT tramite `onClosed` dopo l’opt-in.',
  '',
], SHA.second);

const confirmationReview = (lines: string[], commit: string, extra: string[] = []) => bot([
  '<!-- CODEX_FALLBACK_REVIEW -->',
  '',
  '## Scope',
  'Re-review incrementale (tier: incremental).',
  '',
  '## Findings (Important: 0, Nit: 0)',
  ...lines.map((line) => `Fix di \`${line}\`: ok.`),
  ...extra,
  '',
  '## LGTM',
  '',
], commit);

const reviewC = bot([
  '<!-- REVIEW_INPUT_REVISION: body:50ebd8af54eb1c2f2e7da68115f1537ed50c4fcea2fd46d7b6983a860f41f5c3 -->',
  '<!-- CODEX_FALLBACK_REVIEW -->',
  '',
  '## Scope',
  'Re-review of the Offerwall-to-GPT late-handoff delta (tier: incremental).',
  '',
  '## Findings (Important: 0, Nit: 0)',
  'Fix di `components/community/RewardedApplicationOffer.tsx:L374`: ok.',
  'Fix di `components/community/RewardedApplicationOffer.tsx:L390`: ok.',
  'Fix di `components/community/RewardedApplicationOffer.tsx:L406`: ok.',
  '',
  '## LGTM',
  '',
], SHA.third);

const reviewD = bot([
  '<!-- REVIEW_INPUT_REVISION: body:c6080d0aff1f53f62d3c27a0deecc691f3492c57bc652d564518458790efdd87 -->',
  '<!-- CODEX_FALLBACK_REVIEW -->',
  '',
  '## Scope',
  'Revisione incrementale del fallback GPT e delle interazioni con callback Offerwall tardive (tier: incremental)',
  '',
  'Fix di `components/community/RewardedApplicationOffer.tsx:L372`: ok.',
  'Fix di `components/community/RewardedApplicationOffer.tsx:L372`: ok.',
  'Fix di `components/community/RewardedApplicationOffer.tsx:L388`: ok.',
  '',
  '## Findings (Important: 0, Nit: 0)',
  '',
  '## LGTM',
  '',
], SHA.fourth);

const openAfter = (reviews: unknown[]) =>
  historicalImportantFindings(reviews, { includeLatest: true, repositoryPaths: [FILE] });

const gate = (reviews: Array<{ commit_id: string }>) => runReviewGate({
  repo: 'valerielinc-ops/frontaliere-si-o-no',
  pr: 9968,
  headSha: reviews[reviews.length - 1].commit_id,
  reviews: [reviews],
  repositoryPaths: [FILE],
  mutate: false,
  changedLinesFn: () => null,
  classifyAndMintReviewFn: async (body: string, options: Record<string, unknown>) =>
    classifyReview(body, { files: [FILE], complete: true, repositoryPaths: [FILE], ...options }),
});

describe('review gate: pairing per cardinalità fra finding sullo stesso path (#9968)', () => {
  it('legge le citazioni reali: A a citazione singola, B a due, il ledger non è un finding', () => {
    expect(importantFindings(reviewA.body).map((finding) => finding.citations)).toEqual([
      [{ path: FILE, line: 378 }],
    ]);
    // La riga `- \`eabf305bc1f8\` **open** — …: 🔴 Important: …` sotto
    // `## Findings ledger` è la copia del ledger, non un rilievo nuovo: prima
    // diventava un finding C con testo `- \`eabf305bc1f8\` **open** — …`.
    expect(importantFindings(reviewB.body).map((finding) => finding.citations)).toEqual([
      [{ path: FILE, line: 374 }, { path: FILE, line: 391 }],
    ]);
  });

  it('replay #9968: la review su c99766c6 chiude A e B e il gate approva', async () => {
    expect(openAfter([reviewA, reviewB, reviewC])).toHaveLength(0);
    const result = await gate([reviewA, reviewB, reviewC]);
    expect(result.reason).toBeUndefined();
    expect(result.approved).toBe(true);
  });

  it('replay #9968: la review su ed4e4abe approva la HEAD corrente', async () => {
    expect(openAfter([reviewA, reviewB, reviewC, reviewD])).toHaveLength(0);
    const result = await gate([reviewA, reviewB, reviewC, reviewD]);
    expect(result.reason).toBeUndefined();
    expect(result.approved).toBe(true);
  });

  // La sequenza nella forma incrementale: la terza review conferma solo
  // l'anchor esatto `L374`, la quarta le due righe spostate. La conferma di
  // B:`L374` resta a livello di citazione, e le due conferme distinte della
  // quarta review coprono A:`L378` e B:`L391` in ordine di riga.
  it('porta la conferma esatta di B:L374 e accoppia L378/L391 con L372/L388 della review successiva', async () => {
    const exactOnly = confirmationReview([`${FILE}:L374`], SHA.third);
    const remaining = openAfter([reviewA, reviewB, exactOnly]);
    expect(remaining.map((finding) => finding.citations.map((citation) => citation.line)))
      .toEqual([[378], [374, 391]]);

    expect(openAfter([reviewA, reviewB, exactOnly, reviewD])).toHaveLength(0);
    const result = await gate([reviewA, reviewB, exactOnly, reviewD]);
    expect(result.approved).toBe(true);
  });

  it('resta BLOCKING con meno conferme distinte delle citazioni aperte', async () => {
    const partial = confirmationReview([`${FILE}:L374`, `${FILE}:L390`], SHA.third);
    const onlyOneMoved = confirmationReview([`${FILE}:L372`, `${FILE}:L372`], SHA.fourth);
    expect(openAfter([reviewA, reviewB, partial])).toHaveLength(2);
    expect(openAfter([reviewA, reviewB, partial, onlyOneMoved])).toHaveLength(2);
    const result = await gate([reviewA, reviewB, partial, onlyOneMoved]);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('finding Important in-diff o non risolvibile');
  });

  it('resta BLOCKING con più conferme spostate delle localita aperte', async () => {
    const tooMany = confirmationReview(
      [`${FILE}:L372`, `${FILE}:L388`, `${FILE}:L400`, `${FILE}:L410`],
      SHA.third,
    );
    expect(openAfter([reviewA, reviewB, tooMany])).toHaveLength(2);
    const result = await gate([reviewA, reviewB, tooMany]);
    expect(result.approved).toBe(false);
  });

  it('resta BLOCKING quando le conferme citano un file omonimo in un’altra directory', async () => {
    const otherFile = 'components/jobs/RewardedApplicationOffer.tsx';
    const wrongFile = confirmationReview(
      [`${FILE}:L374`, `${otherFile}:L372`, `${otherFile}:L388`],
      SHA.third,
    );
    expect(openAfter([reviewA, reviewB, wrongFile])).toHaveLength(2);
    const result = await gate([reviewA, reviewB, wrongFile]);
    expect(result.approved).toBe(false);
  });

  it('resta BLOCKING quando le conferme spostate citano solo il basename', async () => {
    const bare = confirmationReview(
      [`${FILE}:L374`, 'RewardedApplicationOffer.tsx:L372', 'RewardedApplicationOffer.tsx:L388'],
      SHA.third,
    );
    expect(openAfter([reviewA, reviewB, bare])).toHaveLength(2);
    const result = await gate([reviewA, reviewB, bare]);
    expect(result.approved).toBe(false);
  });

  it('resta BLOCKING quando un finding aperto cita il file con un path non qualificato', async () => {
    const bareFinding = bot([
      '<!-- CODEX_FALLBACK_REVIEW -->',
      '## Findings (Important: 1, Nit: 0)',
      'RewardedApplicationOffer.tsx:L500: 🔴 Important: [funnel] il reward non viene registrato.',
      '',
    ], SHA.second);
    const confirmations = confirmationReview(
      [`${FILE}:L374`, `${FILE}:L372`, `${FILE}:L388`, `${FILE}:L495`],
      SHA.third,
    );
    expect(openAfter([reviewA, reviewB, bareFinding, confirmations]).length).toBeGreaterThan(0);
    const result = await gate([reviewA, reviewB, bareFinding, confirmations]);
    expect(result.approved).toBe(false);
  });

  it('resta BLOCKING quando l’ultima review porta un 🔴 Important reale', async () => {
    const withRed = confirmationReview(
      [`${FILE}:L372`, `${FILE}:L388`],
      SHA.fourth,
      [`${FILE}:L372: 🔴 Important: [funnel] la guardia GPT lascia ancora passare \`onClosed\`.`],
    ).body.replace('Important: 0', 'Important: 1');
    const latest = { ...reviewD, body: withRed };
    const result = await gate([reviewA, reviewB, reviewC, latest]);
    expect(result.approved).toBe(false);
    expect(result.reason).toBe('finding Important in-diff o non risolvibile');
  });

  it('non eredita una conferma su un finding riaperto dopo di essa', () => {
    const exactOnly = confirmationReview([`${FILE}:L374`], SHA.third);
    // Il reviewer ripropone B tale e quale dopo la conferma parziale: le sue
    // citazioni sono nuove e la conferma di L374 non vale per loro.
    const reraised = { ...reviewB, id: nextId++, commit_id: SHA.fourth };
    const moved = confirmationReview([`${FILE}:L372`, `${FILE}:L388`], SHA.fourth);
    const remaining = openAfter([reviewA, reviewB, exactOnly, reraised, moved]);
    expect(remaining.length).toBeGreaterThan(0);
  });
});

// Companion senza riga nominato come lettore del dato (#9965).
//
// Replay delle review reali di valerielinc-ops/frontaliere-si-o-no#9965. Il
// primo 🔴 è ancorato a `services/applicationIntent.ts:L70` e cita nel testo
// `scripts/send-job-alerts.mjs` («letto da»), il consumer che legge il
// profilo, senza riga. La review 5326904148 (`## LGTM`, `Important: 0`)
// conferma `services/applicationIntent.ts:L91`, la riga spostata dell'anchor.
// Il companion esiste nel tree, nessuno lo conferma mai: il finding restava
// aperto e il gate di main dava OPEN=2 prima ancora della riapertura falsa.
describe('review gate: companion senza riga come contesto dopo un LGTM (#9965)', () => {
  const pages9965 = JSON.parse(readFileSync(
    new URL('./fixtures/review-replay/pr-9965-reviews.json', import.meta.url), 'utf8',
  )) as Array<Array<{ id: number; body: string; submitted_at: string; commit_id: string }>>;
  const TREE = [
    'App.tsx',
    'scripts/send-job-alerts.mjs',
    'services/applicationIntent.ts',
    'services/behaviorTracker.ts',
  ];
  // Fino alla review 6: prima della riapertura falsa (5327178068).
  const beforeReopen = pages9965.map((page) => page.filter((review) => review.submitted_at < '2026-09-26T19:30:00Z'));
  const all = beforeReopen.flat();
  const opened = all[0];
  const approving = all[1];
  const intentOpen = (reviews: unknown[], options: Record<string, unknown> = { repositoryPaths: TREE }) =>
    historicalImportantFindings(reviews, { includeLatest: true, ...options })
      .filter((finding) => finding.citations.some((citation) => citation.path === 'services/applicationIntent.ts' && citation.line === 70));
  const withBody = (review: { body: string }, body: string) => ({ ...review, body });

  it('legge l’anchor preciso e il companion senza riga', () => {
    expect(importantFindings(opened.body)[0].citations).toEqual([
      { path: 'services/applicationIntent.ts', line: 70 },
      { path: 'scripts/send-job-alerts.mjs', line: null },
    ]);
  });

  it('replay #9965: l’LGTM che conferma l’anchor preciso chiude il finding, resta aperto solo il 🔴 mai confermato', () => {
    const { open, confirmed } = partitionHistoricalImportantFindings(beforeReopen, { includeLatest: true, repositoryPaths: TREE });
    expect(open.map((finding) => finding.citations[0])).toEqual([{ path: 'services/behaviorTracker.ts', line: 316 }]);
    expect(confirmed.map((finding) => finding.citations[0])).toEqual([{ path: 'services/applicationIntent.ts', line: 70 }]);
  });

  it('resta aperto se la review che conferma non è approvante', () => {
    const notApproving = withBody(approving, approving.body
      .replace('## Findings (Important: 0, Nit: 0)', '## Findings (Important: 1, Nit: 0)')
      .replace('## LGTM', 'services/other.ts:L1: 🔴 Important: [funnel] altro rilievo.'));
    expect(intentOpen([opened, notApproving])).toHaveLength(1);
  });

  it('resta aperto se l’anchor preciso non è confermato', () => {
    const elsewhere = withBody(approving, approving.body.replace('services/applicationIntent.ts:L91', 'services/behaviorTracker.ts:L91'));
    expect(intentOpen([opened, elsewhere])).toHaveLength(1);
  });

  it('resta aperto quando il companion è l’unico anchor', () => {
    const onlyCompanion = withBody(opened, opened.body.replace(
      'services/applicationIntent.ts:L70: 🔴 Important:',
      '🔴 Important:',
    ));
    expect(importantFindings(onlyCompanion.body)[0].citations).toEqual([{ path: 'scripts/send-job-alerts.mjs', line: null }]);
    expect(historicalImportantFindings([onlyCompanion, approving], { includeLatest: true, repositoryPaths: TREE })).toHaveLength(1);
  });

  it('resta aperto quando il finding chiede di correggere anche il companion', () => {
    const fixCompanion = withBody(opened, opened.body.replace(
      'Persistere il profilo',
      'Correggi anche `scripts/send-job-alerts.mjs`. Persistere il profilo',
    ));
    expect(intentOpen([fixCompanion, approving])).toHaveLength(1);
  });

  it('resta aperto senza tree autorevole: assente o di fallback', () => {
    expect(intentOpen([opened, approving], {})).toHaveLength(1);
    expect(intentOpen([opened, approving], { repositoryPaths: TREE, repositoryPathsFromFallback: true })).toHaveLength(1);
  });
});
