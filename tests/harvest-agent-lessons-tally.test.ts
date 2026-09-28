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
import { tallyFindings, detectSeverity, bucketFinding } from '../scripts/ci/harvest-agent-lessons.mjs';

type Review = { author: { login: string }; body: string };
type PR = { number: number; reviews: Review[] };
const claudeReview = (body: string): Review => ({ author: { login: 'claude' }, body });

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
