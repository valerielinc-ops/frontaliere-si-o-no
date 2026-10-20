/**
 * lessons-harvester — tallyFindings: precisione del conteggio reviewer-finding
 * che alimenta l'escalation `recurringDespiteRule`. Due regressioni di FALSO
 * POSITIVO chiuse qui (#2124, bucket `auto-ads` escalato a torto):
 *   1. `❓` = adversarial-uncertainty del reviewer ("non verificato X"), NON un
 *      errore confermato dell'agent → non deve contare.
 *   2. conteggio per-RIGA → una PR con N righe nello stesso bucket gonfiava il
 *      count; la lezione è "N PR DISTINTE", quindi dedup per (PR, bucket).
 * Il segnale legittimo (🔴/🟡 ricorrente su PR distinte) resta intatto.
 */
import { describe, it, expect } from 'vitest';
import { tallyFindings, detectSeverity, bucketFinding, reviewBodyLines } from '../scripts/ci/harvest-agent-lessons.mjs';

type Review = { author: { login: string }; body: string };
type PR = { number: number; reviews: Review[] };
const claudeReview = (body: string): Review => ({ author: { login: 'claude' }, body });

// Testi reali dei sei finding che hanno riacceso #10113 dopo il cutoff
// 2026-09-27T20:24:14Z. Restano verbatim per misurare la classe, non solo il
// lessico sintetico del bucket.
const ISSUE_10113_FINDINGS = [
  {
    pr: 11514,
    line: 'scripts/check-crawler-health.mjs:L728: 🔴 Important: [funnel] The replacement guard treats every finite `generatedAt > P` as a publication for E and omits `at <= E`; a member with a later or out-of-order summary can therefore suppress `summary-missing` even though no summary landed in `(P, E]`, leaving the crawler-health streak frozen. Require the member timestamp to satisfy `at > previousAt && at <= latestAt` before skipping the replacement. Accettazione: `node --input-type=module -e \'import { applyGenerationSummaryAbsence as f } from "./scripts/check-crawler-health.mjs"; const r=f([{slug:"target",generatedAt:"2026-10-03T00:00:00Z"},{slug:"sibling",generatedAt:"2026-10-04T00:30:00Z"},{slug:"future",generatedAt:"2026-10-05T00:00:00Z"}],{groups:{g:["target","sibling","future"]},ledgerEntries:[{group:"g",checkedAt:"2026-10-03T00:00:00Z"},{group:"g",checkedAt:"2026-10-04T01:00:00Z"}]}); const got=r.absent.map(x=>x.slug).sort().join(","); if(got!=="future,target") throw new Error(got);\'`.',
  },
  {
    pr: 11364,
    line: 'scripts/ci/sibling-check-gate.mjs:L377: 🔴 Important: [correctness] The cache is disabled only for the local fallback; the checker extracted from the judged revision or `origin/main` inherits `process.env`, while the checker cache is keyed by the head/ref rather than checker contents, so a verdict produced by a different checker revision can be reused and the gate is no longer pinned to the judged checker. Set `CHECK_SIBLING_PATTERNS_CACHE` to \'0\' for every checker invocation. Accettazione: `rg -n "CHECK_SIBLING_PATTERNS_CACHE: \'0\'" scripts/ci/sibling-check-gate.mjs` shows the cache-disabled environment is applied unconditionally to each checker source.',
  },
  {
    pr: 11184,
    line: 'scripts/ci/check-sibling-patterns.mjs:L797: 🟡 Nit The new function-header filter does not recognize common `export async function ... {` or `export default function ... {` headers, so removing one still contributes a generic sibling expression and can produce a false-positive gate candidate. Extend the header matcher to accept the export/default modifiers. Accettazione: `node --input-type=module -e "import { isGenericRemovedExpression } from \'./scripts/ci/check-sibling-patterns.mjs\'; console.log(isGenericRemovedExpression(\'export async function foo() {\'))"` → `true`. — deferred, non funnel-critical.',
  },
  {
    pr: 10397,
    line: 'PR body:L7: 🔴 Important: [other] The `## Implementato` bullet claims the sibling checker is bounded in partial clones, but supplies no pre/post measurement or explicit revert-risk, leaving a CI optimization claim unvalidated before merge. Add a reproducible pre/post measurement for the partial-clone path to the PR evidence. Accettazione: the PR body contains the benchmark command and environment plus numeric pre/post results for the partial-clone path.',
  },
  {
    pr: 10392,
    line: 'PR body:L6: 🔴 Important: [contract] The PR claims that replacing `git archive` with `git ls-tree` plus `git cat-file --batch` makes the hook complete on the large clone, but provides no pre/post measurement and no explicit revert-risk. Add a repeatable pre/post measurement for the same large-clone revision to the PR body. Accettazione: the old and new `node scripts/ci/check-sibling-patterns.mjs --head <same-ref>` runs both exit 0 and their elapsed times are recorded in the PR body.',
  },
  {
    pr: 10203,
    line: 'scripts/lib/events-retention.mjs:L14: 🔴 Important: [funnel] `eventRouteForHistory()` persists only `slugifyEvent(event)`\'s base slug, while `assignEventSlugs()` adds `-2`, `-3`, and so on for same-title/date siblings; when a non-first sibling changes, the archive records and bridges the wrong path, so its actual historical detail URL can 404. Persist the collision-resolved slug assigned for the event\'s `(canton,comune)` group in `previousRoutes`; affected persistence call sites are `scripts/lib/crawl-checkpoint.mjs:L92` and `scripts/assemble-events-dataset.mjs:L147`. Accettazione: input→output — two events with identical title/startDate in one group give the second event `base-2`, then changing that event must produce `previousRoutes[0].slug===base-2` and a historical migration with `fromSlug===base-2`, not `base`.',
  },
] as const;

describe('detectSeverity', () => {
  it('riconosce 🔴/🟡/❓ e null', () => {
    expect(detectSeverity('🔴 q: bug')).toBe('🔴');
    expect(detectSeverity('🟡 nit: foo')).toBe('🟡');
    expect(detectSeverity('❓ q: non verificato')).toBe('❓');
    expect(detectSeverity('plain line')).toBeNull();
  });

  it('ignora un glifo negato da un opener "Nessun/Zero/0 <conteggio>" (era #4342)', () => {
    // Riga di recap LGTM che dichiara ZERO finding di quella severità — il glifo
    // resta nel testo ma non è un finding confermato.
    expect(detectSeverity('Nessun 🔴; test comportamentali + parity guard presenti.')).toBeNull();
    expect(detectSeverity('Zero 🔴. Single-source html fix è corretto e testato.')).toBeNull();
    expect(detectSeverity('0 🟡 rimasti dopo il fix.')).toBeNull();
  });

  it('un secondo glifo NON negato nella stessa riga resta rilevato', () => {
    expect(detectSeverity('Nessun 🔴. Unico 🟡 è advisory-only.')).toBe('🟡');
  });
});

describe('tallyFindings — ❓ non conta (adversarial-uncertainty ≠ errore)', () => {
  it('una riga ❓ che menziona adsense NON incrementa il bucket', () => {
    const prs: PR[] = [{ number: 1, reviews: [claudeReview('❓ q: non verificato che Auto Ads serva da first paint')] }];
    const { counts } = tallyFindings(prs);
    expect(counts['auto-ads']).toBeUndefined();
  });

  it('match in negazione su riga ❓ ("non SEO/AdSense") NON conta (era #2114)', () => {
    const prs: PR[] = [{ number: 2114, reviews: [claudeReview('❓ q: tool interno di lettura A/B, non funnel-critical (non SEO/AdSense) → resta ❓')] }];
    const { counts } = tallyFindings(prs);
    expect(counts['auto-ads']).toBeUndefined();
  });
});

describe('tallyFindings — dedup per (PR, bucket)', () => {
  it('una PR con 3 righe ❓/🟡 nello stesso bucket conta al massimo 1', () => {
    const prs: PR[] = [{
      number: 2086,
      reviews: [claudeReview([
        '❓ q: gli Auto Ads in-page cadono dentro #root',
        '❓ q: non verificato AdSense fuori da #root',
        '🟡 nit: adsense loader iniettato due volte',
    ].join('\n'))],
    }];
    const { counts } = tallyFindings(prs);
    // solo la riga 🟡 è countable, e comunque dedup per-PR → 1
    expect(counts['adsense-loader-contract']).toBe(1);
  });

  it('più review della STESSA PR (re-review) restano 1 per bucket', () => {
    const prs: PR[] = [{
      number: 42,
      reviews: [
        claudeReview('🟡 nit: adsense config precedence'),
        claudeReview('🟡 nit: adsense config precedence (ancora)'),
      ],
    }];
    const { counts } = tallyFindings(prs);
    expect(counts['auto-ads']).toBe(1);
  });
});

describe('tallyFindings — scenario #2124 sotto la soglia di escalation', () => {
  it('PR ispirate a #2086/#2114/#2102 NON raggiungono soglia×fattore (3×2=6)', () => {
    const prs: PR[] = [
      { number: 2086, reviews: [claudeReview('❓ q: AdSense in-page dentro #root\n❓ q: non verificato fuori #root')] },
      { number: 2114, reviews: [claudeReview('❓ q: non funnel-critical, non SEO/AdSense → resta ❓')] },
      { number: 2102, reviews: [claudeReview('🟡 nit: adsense loader doppio, idempotenza non verificata')] },
    ];
    const { counts } = tallyFindings(prs);
    // solo #2102 (🟡) conta → 1, ben sotto 6 → niente escalation
    expect(counts['adsense-loader-contract'] ?? 0).toBe(1);
    expect(counts['adsense-loader-contract'] ?? 0).toBeLessThan(3 * 2);
  });
});

describe('tallyFindings — il segnale legittimo resta intatto', () => {
  it('🔴/🟡 confermati su PR DISTINTE contano (1 per PR)', () => {
    const prs: PR[] = [
      { number: 1, reviews: [claudeReview('🔴 Important: structured data manca baseSalary')] },
      { number: 2, reviews: [claudeReview('🟡 jobPosting senza postalCode')] },
      { number: 3, reviews: [claudeReview('🔴 hiringOrganization.name assente nel json-ld')] },
    ];
    const { counts } = tallyFindings(prs);
    expect(counts['structured-data']).toBe(3); // raggiunge THRESHOLD reale
  });

  it('ignora review non di claude', () => {
    const prs: PR[] = [
      { number: 1, reviews: [{ author: { login: 'someone-else' }, body: '🔴 adsense disabilitato' }] },
    ];
    const { counts } = tallyFindings(prs);
    expect(counts['auto-ads']).toBeUndefined();
  });
});

describe('tallyFindings — recap LGTM "Nessun/Zero 🔴" non gonfia sibling-class-fix (#4342)', () => {
  it('un recap zero-finding che nomina "sibling-check" non conta come violazione', () => {
    const prs: PR[] = [
      { number: 4279, reviews: [claudeReview('Nessun 🔴; test comportamentali + parity guard presenti, disposizione sibling-check verificata a campione, unico nit è debito di manutenzione minore non funnel-critical.')] },
      { number: 4276, reviews: [claudeReview('Zero 🔴. Single-source html fix è corretto e testato, sibling-check risolto con giustificazioni verificabili, z-index claim confermato.')] },
      { number: 4259, reviews: [claudeReview('Zero 🔴, no unresolved funnel-critical ❓ — routing fix, merge fix, and their siblings all check out.')] },
    ];
    const { counts } = tallyFindings(prs);
    expect(counts['sibling-class-fix']).toBeUndefined();
  });

  it('un finding sibling REALE (🟡 non negato) resta contato', () => {
    const prs: PR[] = [
      { number: 4267, reviews: [claudeReview('🟡 Nit — questo script gemello condivide lo stesso costrutto non toccato dal fix.')] },
    ];
    const { counts } = tallyFindings(prs);
    expect(counts['sibling-class-fix']).toBe(1);
  });
});

describe('issue #10113 — sibling tooling non è sibling-class-fix', () => {
  const prs: PR[] = ISSUE_10113_FINDINGS.map(({ pr, line }) => ({
    number: pr,
    reviews: [claudeReview(line)],
  }));

  it('riclassifica i quattro finding sul checker/gate come argomento', () => {
    const toolingPrs = new Set([11364, 11184, 10397, 10392]);
    const { counts } = tallyFindings(prs);

    expect(counts['sibling-tooling']).toBe(toolingPrs.size);
    expect(counts['sibling-class-fix'] ?? 0).toBe(0);
  });

  it('lascia #11514 e #10203 fuori dalla classe sibling e dal tooling', () => {
    for (const { pr, line } of ISSUE_10113_FINDINGS.filter(({ pr }) => pr === 11514 || pr === 10203)) {
      expect(bucketFinding(line), `PR ${pr}`).not.toBe('sibling-class-fix');
      expect(bucketFinding(line), `PR ${pr}`).not.toBe('sibling-tooling');
    }
  });

  it('continua a contare una classe mancata vera anche se il gemello è il checker', () => {
    const line = 'scripts/ci/other-check.mjs:L1: 🟡 Nit: il sibling `scripts/ci/check-sibling-patterns.mjs` porta ancora lo stesso costrutto non toccato dal fix.';
    expect(bucketFinding(line)).toBe('sibling-class-fix');
    expect(tallyFindings([{ number: 10113, reviews: [claudeReview(line)] }]).counts['sibling-class-fix']).toBe(1);
  });

  it("ignora l'indirizzo iniziale anche negli altri bucket di processo", () => {
    expect(bucketFinding('scripts/ci/claim-unvalidated-monitor.mjs:L1: 🔴 Important: the cache misses an entry for a new revision.')).not.toBe('unvalidated-claim');
    expect(bucketFinding('PR body:L7: 🔴 Important: the cache misses an entry for a new revision.')).not.toBe('pr-body-contract');
    expect(bucketFinding('scripts/ci/check-sibling-patterns.mjs:L797: 🔴 Important: the cache misses an entry for a new revision.')).not.toBe('sibling-class-fix');
  });
});

describe('tallyFindings — Nits non-funnel esplicitamente differiti non sono recidiva (#10116)', () => {
  it('non conta i stale-comment Nits che il contratto dispone come deferred', () => {
    const prs: PR[] = [
      { number: 9789, reviews: [claudeReview('scripts/crawl-myswitzerland-events.mjs:L42: 🟡 Nit: update both stale comments — deferred, non funnel-critical.')] },
      { number: 9736, reviews: [claudeReview('PR body:L5: 🟡 Nit: il body descrive ancora i valori precedenti — deferred, non funnel-critical.')] },
      { number: 9493, reviews: [claudeReview('.github/workflows/post-merge-followup.yml:L37: 🟡 Nit: il commento descrive ancora il mutex dedicato — deferred, non funnel-critical.')] },
    ];
    const { counts } = tallyFindings(prs);
    expect(counts['stale-comment']).toBeUndefined();
  });

  it('conserva un stale-comment senza disposizione e un 🔴 auto-disposto', () => {
    const prs: PR[] = [
      { number: 1, reviews: [claudeReview('scripts/foo.mjs:L1: 🟡 Nit: commento stale da allineare')] },
      { number: 2, reviews: [claudeReview('scripts/bar.mjs:L2: 🔴 Important: commento stale che descrive un comportamento errato — deferred, non funnel-critical.')] },
    ];
    const { counts } = tallyFindings(prs);
    expect(counts['stale-comment']).toBe(2);
  });
});

describe('bucketFinding — AdsSense findings keep their failure mode (#10115)', () => {
  it('mantiene il finding generico adsense nel fallback auto-ads', () => {
    expect(bucketFinding('🟡 adsense non viene inizializzato sulla pagina')).toBe('auto-ads');
  });

  // Verbatim dalla finestra che ha aperto #10115. Sono cinque difetti Ads
  // distinti: thin/noindex, lifecycle dello slot, bot-gate e delivery del
  // loader. Il test protegge la misura, non la soglia: i due renderer thin
  // restano nello stesso sottobucket e i tre finding diversi non vengono più
  // sommati.
  const findings: Array<[string, string, string]> = [
    ['#10030', '🔴 Important: [funnel] The new `DRIVEBY_AD_SNIPPET` and `ARTICLE_INLINE_MOBILE` units are emitted unconditionally before the `wordCount`-based robots decision, so a thin render can be `noindex,follow` while still carrying manual AdSense units; gate both new interpolations on the same `indexable` value used by `robots` and `endOfContentMultiplexHtml.', 'adsense-thin-content'],
    ['#10028', '🔴 Important: [funnel] The new static-slot watcher is reachable only through `startAds()`, but the loader returns before `startAds()` when consent is absent or `reader_noads_active` is true, so the marked drive-by `<ins>` keeps its 1100px reserve forever. Initialize the watcher before the consent/ads-loading gate while keeping the AdSense request consent-gated.', 'adsense-slot-lifecycle'],
    ['#9836', '🔴 Important: [funnel] `matchesAutomationScreenSignature()` classifies as bot every session Windows Chrome otherwise normal with screen CSS 1280x1200 and English language or `Asia/Singapore`; the same inline rule feeds the AdSense/job-gate, so a real session loses ads and access to the CTA.', 'adsense-bot-gate'],
    ['#9835', '🔴 Important: [funnel] `extractAssetUrlsFromHtml()` drops same-origin `/assets/...` references, while the graph verdict does not reject a successful entry with zero discovered CDN assets; other locales can keep the global graph green while that page has no CSS, SPA bundle, or AdSense loader.', 'adsense-loader-contract'],
    ['#9492', '🔴 Important: [funnel] the second related-search renderer still calls `endOfContentMultiplexHtml({ indexable: true })`, so thin cluster pages emitted through that path continue to receive the manual multiplex slot this PR is intended to suppress.', 'adsense-thin-content'],
  ];

  it('does not collapse heterogeneous reviewer findings into auto-ads', () => {
    for (const [pr, line, expected] of findings) {
      expect(bucketFinding(line), pr).toBe(expected);
    }
  });

  it('still counts a repeated concrete class, while keeping distinct classes separate', () => {
    const prs = findings.map(([number, line]) => ({
      number: Number(number.slice(1)),
      mergedAt: '2026-09-27T00:00:00Z',
      reviews: [{ author: { login: 'claude' }, body: line }],
    }));
    const { counts } = tallyFindings(prs);
    expect(counts['adsense-thin-content']).toBe(2);
    expect(counts['adsense-slot-lifecycle']).toBe(1);
    expect(counts['adsense-bot-gate']).toBe(1);
    expect(counts['adsense-loader-contract']).toBe(1);
    expect(counts['auto-ads']).toBeUndefined();
  });
});

describe('bucketFinding — adsense-bot-gate richiede due segnali espliciti (#10209)', () => {
  const genuine = [
    '🔴 Important: `matchesAutomationScreenSignature()` classifies as bot every session Windows Chrome otherwise normal; the same inline rule feeds the AdSense/job-gate, so a real session loses ads and access to the CTA.',
    '🔴 Important: the bot gate misclassifies legitimate users and suppresses Auto Ads for a real session.',
    '🔴 Important: a false positive in the AdSense bot classifier blocks the user CTA.',
  ];

  const falsePositives = [
    // #10125: `load` and `automatic` must not satisfy `ads?` + `automation`.
    '.github/workflows/bing-seo-loop.yml:L370: 🔴 Important: the new tree-report steps authenticate the issue creator with `${{ github.token }}`, so the automatic triage/fixer can stop at an unprocessed backlog issue. Load and use the App or PAT credential.',
    // #10066: an advertised listing and a camel-case helper are not an
    // AdSense bot-gate finding.
    'scripts/lib/prospector/spec-crawler.mjs:L89: 🔴 Important: the browser rescue cannot restore the advertised listings; inspect the settled page before accepting `looksLikeAntiBotChallenge()`.',
    // #10051: `ad` + `both` is not the pair of signals the bucket measures.
    'components/community/BlogArticles.tsx:L2218: 🔴 Important: the first-paint grid rules are emitted in both critical CSS surfaces, so the article shell adds CLS.',
    // #9956: `instead` + `antiBotExhausted` must not match either.
    'scripts/lib/prospector/spec-crawler.mjs:L119: 🔴 Important: a transport failure is mislabeled instead of retaining its classification; gate `antiBotExhausted` on a confirmed response.',
  ];

  it('mantiene i finding reali del gate', () => {
    for (const line of genuine) expect(bucketFinding(line), line).toBe('adsense-bot-gate');
  });

  it('scarta i falsi positivi osservati nella finestra dell’escalation', () => {
    for (const line of falsePositives) {
      expect(bucketFinding(line), line).not.toBe('adsense-bot-gate');
    }
  });

  it('non riapre il bucket quando la finestra contiene solo quei falsi positivi', () => {
    const prs = falsePositives.map((line, i) => ({
      number: 10200 + i,
      reviews: [claudeReview(line)],
    }));
    const { counts } = tallyFindings(prs);
    expect(counts['adsense-bot-gate'] ?? 0).toBe(0);
  });
});

describe('tallyFindings — esempio porta `at` = PR mergedAt (post-fix guard, #5516)', () => {
  // reviewer-finding non aveva mai un timestamp per-esempio, quindi la guardia
  // post-fix (examplesSinceFix) non poteva filtrare le occorrenze pre-fix: un
  // bucket come sibling-class-fix ricontava per sempre le stesse PR già chiuse
  // da un'escalation precedente. Lo stamp qui è ciò che rende il filtro possibile.
  it('propaga mergedAt del PR come `at` di ogni esempio', () => {
    const prs = [{
      number: 5426,
      mergedAt: '2026-08-09T10:39:00Z',
      reviews: [claudeReview('🟡 nit: script gemello condivide lo stesso costrutto non toccato')],
    }];
    const { examples } = tallyFindings(prs);
    expect(examples['sibling-class-fix'][0].at).toBe('2026-08-09T10:39:00Z');
  });

  it('PR senza mergedAt lascia `at` undefined, non lancia (retrocompat con i call site esistenti)', () => {
    const prs = [{ number: 1, reviews: [claudeReview('🔴 adsense disabilitato')] }];
    const { examples } = tallyFindings(prs);
    expect(examples['auto-ads'][0].at).toBeUndefined();
  });
});

describe('tallyFindings — body di review malformato con `\\n` letterali', () => {
  // Forma reale delle review del 13-19/09 (difetto del reviewer spento da #9781):
  // l'intero body su UNA riga, con la sequenza `\n` al posto degli a-capo.
  const malformed = [
    '<!-- CODEX_FALLBACK_REVIEW -->', '', '## Scope',
    'Static SSG changes for plate auctions (tier: high)', '',
    '## Findings (Important: 1, Nit: 0)',
    '- `scripts/foo.mjs:L12`: 🔴 Important: il parser tratta ogni riga vuota come fine sezione e perde gli annunci successivi',
    '', '## Adversarial check', '- ❓ q: coperto il caso senza titolo?',
  ].join('\\n');
  const bot = (body: string) => ({ author: { login: 'frontaliere-automation' }, body });

  it('letto come una riga sola genererebbe il cluster fantasma', () => {
    // E' il difetto: la riga unica prende il glifo del finding e il nome
    // dalle prime parole del body.
    expect(bucketFinding(malformed)).toBe('fp:codex-fallback-review-scope');
  });

  it('normalizza i `\\n` letterali prima di dividere: niente fp:codex-fallback-review-scope', () => {
    expect(reviewBodyLines(malformed)).toHaveLength(10);
    const { counts } = tallyFindings([{ number: 9326, reviews: [bot(malformed)] }]);
    expect(counts['fp:codex-fallback-review-scope']).toBeUndefined();
    // Il finding vero resta contato, nel suo bucket.
    expect(counts).toEqual({ 'fp:parser-tratta-ogni-riga': 1 });
  });

  it('un body sano che cita `\\n` in prosa non viene spezzato', () => {
    const healthy = 'La regex `\\n` qui e\' prosa\n🟡 nit: adsense loader iniettato due volte';
    expect(reviewBodyLines(healthy)).toEqual([
      'La regex `\\n` qui e\' prosa',
      '🟡 nit: adsense loader iniettato due volte',
    ]);
  });
});
