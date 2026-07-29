/**
 * liechtensteinCorridorContent.ts — 4-locale copy (hub title/lede, per-comune
 * title template, FAQ) for the Liechtenstein corridor (issue #4884, third of
 * the FR/DE/AT/LI rollout started by #4545).
 *
 * OPTIONAL STRETCH DELIVERABLE — not wired into anything. This is plain
 * content data, deliberately kept OUT of `build-plugins/` (no path/URL
 * logic, no router membership sets, no `isXPath()` helpers — that
 * integration belongs to whichever later slice builds the actual SSG
 * plugin, mirroring build-plugins/frenchBorderMunicipalityData.ts's shape
 * but not its routing plumbing). Nothing in this file is imported by
 * `services/router.ts`, `vite.config.ts`, `services/locales/*`, or any
 * `build-plugins/*` file — none of those were touched by this change.
 *
 * SCOPE OF FACTS — every claim below traces to one of two places, nothing
 * else. Do not add a fact here without adding its source to one of these:
 *   1. data/liechtensteinMunicipalities.ts's SOURCES header (fiscal treaty, customs union, AVS/AI, 45-day
 *      threshold, what the source does NOT say about losing frontaliere
 *      status).
 *   2. the `commutingContext` / `nationalPopulation` blocks of the generated
 *      data/liechtenstein-municipalities.json (read below, not re-typed as
 *      literals, so the numbers cannot drift out of sync with the dataset).
 *      Read from the JSON rather than from the builder script on purpose:
 *      this module is reachable from vite.config.ts (plugin -> content), and
 *      pulling a `.mjs` with a `#!/usr/bin/env node` shebang into that graph
 *      makes esbuild fail with `Syntax error "!"`, breaking every locale
 *      build. The sibling builders are imported only by tests, which is why
 *      only this one ever hit it.
 * Deliberately NOT included anywhere in this copy (see
 * data/liechtensteinMunicipalities.ts header, "NOT included"): no
 * health-insurance "Optionsrecht" claim (unsourced to a primary), no
 * post-2023 per-comune population figure, no inference about what happens
 * fiscally after losing frontaliere status via the 45-day threshold (the
 * source is explicit that it does not say — this file must not fill that
 * gap by analogy to Germany's 60-day rule).
 *
 * EDITORIAL REQUIREMENT (non-negotiable for this corridor, not my call to
 * revisit): the page is framed "vivere in Liechtenstein, lavorare in
 * Svizzera" (true for the 2'426 real people in `LIECHTENSTEIN_COMMUTING_CONTEXT.liToCh`,
 * consistent with the site's existing template/audience) but every hub
 * lede below states PROMINENTLY, with the sourced numbers, that the
 * corridor's dominant flow is the opposite (Switzerland -> Liechtenstein,
 * ~6:1). This is not an aside in a footnote: it is the second sentence of
 * every locale's lede below, and it is also its own FAQ entry.
 *
 * NUMBER FORMATTING — deliberately NOT `Number.prototype.toLocaleString`.
 * Node's ICU CLDR data groups inconsistently for the 'it-CH' locale tag
 * specifically: `(14891).toLocaleString('it-CH')` === "14'891" but
 * `(2426).toLocaleString('it-CH')` === "2426" (no separator at all) —
 * CLDR's minimumGroupingDigits:2 for Italian only fires once the leading
 * digit-group has 2+ digits, verified live in this Node runtime. That would
 * put an ungrouped 2426 next to a grouped 14'891 in the same Italian
 * sentence — reads as a typo. `groupThousands()` below is a deterministic,
 * locale-independent Swiss-style (apostrophe) grouper used uniformly across
 * all 4 locales instead, so this can never silently regress again.
 */

import liechtensteinDataset from './liechtenstein-municipalities.json';

export type LiechtensteinLocale = 'it' | 'en' | 'de' | 'fr';
export const LIECHTENSTEIN_LOCALES: readonly LiechtensteinLocale[] = ['it', 'en', 'de', 'fr'] as const;

interface LiechtensteinCommutingContext {
  year: number;
  chToLi: number;
  liToCh: number;
  ratio: string;
  workforceShareCrossBorder: string;
  note: string;
  source: string;
}

interface LiechtensteinNationalPopulation {
  value: number;
  year: number;
  source: string;
}

const CTX = liechtensteinDataset.commutingContext as LiechtensteinCommutingContext;
const NATIONAL = liechtensteinDataset.nationalPopulation as LiechtensteinNationalPopulation;

/** Deterministic thousands grouping (Swiss apostrophe convention), used for
 *  every locale here instead of `toLocaleString()` — see file header. */
export function groupThousands(value: number): string {
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

const chToLi = groupThousands(CTX.chToLi);
const liToCh = groupThousands(CTX.liToCh);
const nationalPop = groupThousands(NATIONAL.value);

export interface LiechtensteinFaqEntry {
  question: string;
  answer: string;
  /**
   * Marks the entry carrying the mandatory inverted-commuting disclosure
   * (CH->FL outnumbers FL->CH ~6:1). The page renders that answer in its own
   * accent box, and it used to be picked positionally as the LAST array
   * element — so reordering this array would have silently swapped the
   * disclosure for an unrelated answer, with nothing failing. Keyed lookup
   * makes the intent explicit and reorder-proof.
   */
  kind?: 'commuting-direction';
}

export interface LiechtensteinLocaleContent {
  hubTitle: string;
  /** Second sentence MUST carry the inverted-direction disclosure — see
   *  header. Do not shorten this lede by dropping that sentence. */
  hubLede: string;
  /** Per-comune page <title> template, e.g. "Vivere a {comune} (Liechtenstein) e lavorare in Svizzera". */
  municipalityTitle: (comuneName: string) => string;
  faq: LiechtensteinFaqEntry[];
}

export const LIECHTENSTEIN_CONTENT: Record<LiechtensteinLocale, LiechtensteinLocaleContent> = {
  it: {
    hubTitle: 'Vivere in Liechtenstein e lavorare in Svizzera: guida ai comuni del Principato',
    hubLede:
      `Chi vive in uno degli 11 comuni del Liechtenstein (${nationalPop} abitanti, ${NATIONAL.year}) e lavora in Svizzera segue un regime fiscale e previdenziale diverso da quello di Italia, Francia e Germania. ` +
      `Attenzione: questo è il flusso MINORITARIO del corridoio — nel ${CTX.year} erano ${chToLi} le persone che facevano il percorso opposto (Svizzera → Liechtenstein) contro ${liToCh} in questa direzione (${CTX.ratio}), e il 57% (2022) della forza lavoro del Liechtenstein è pendolare in entrata dall'estero. ` +
      `Fonte: ${CTX.source}`,
    municipalityTitle: (comuneName) => `Vivere a ${comuneName} (Liechtenstein) e lavorare in Svizzera`,
    faq: [
      {
        question: 'Come funziona la tassazione per chi vive in Liechtenstein e lavora in Svizzera?',
        answer:
          "L'accordo contro le doppie imposizioni CH-LI (SR 0.672.951.43, art. 15 par. 4) prevede la tassazione esclusiva nello Stato di residenza per i veri frontalieri giornalieri — un meccanismo strutturalmente diverso da quello con Italia, Francia o Germania.",
      },
      {
        question: 'Cosa succede se non rientro ogni giorno al domicilio?',
        answer:
          "Il Protocollo all'accordo (punto 4 lett. c) fissa a 45 giorni lavorativi all'anno la soglia di non-rientro oltre la quale si perde lo status di frontaliere. La fonte consultata non specifica cosa cambia fiscalmente una volta persa la qualifica: non va assunta un'analogia con la regola tedesca dei 60 giorni.",
      },
      {
        question: 'Serve attraversare la dogana ogni giorno per andare al lavoro?',
        answer:
          "No: Liechtenstein e Svizzera sono un'unione doganale dal 1923 (SR 0.631.112.514), condividono un trattato monetario (1980/1981, SR 0.951.951.4) e lo stesso territorio IVA — nessuna formalità doganale, nessun cambio valuta, nessuna differenza di aliquota IVA.",
      },
      {
        question: 'Dove si versano i contributi AVS/AI?',
        answer:
          "Vale il principio del luogo di lavoro (accordo bilaterale 1989, art. 5, con eccezioni all'art. 6): i contributi si versano di norma dove si lavora, quindi in Svizzera.",
      },
      {
        question: 'Il flusso Liechtenstein → Svizzera è il più comune su questo corridoio?',
        answer:
          `No, ed è importante saperlo: nel ${CTX.year} il flusso dominante era l'opposto, Svizzera → Liechtenstein (${chToLi} persone contro ${liToCh}, rapporto ${CTX.ratio}). Questa guida copre il flusso minoritario perché coerente con il pubblico del sito, non perché sia il pattern maggioritario del corridoio.`,
        kind: 'commuting-direction',
      },
    ],
  },

  en: {
    hubTitle: 'Living in Liechtenstein and working in Switzerland: a guide to the Principality’s municipalities',
    hubLede:
      `Residents of Liechtenstein's 11 municipalities (${nationalPop} people, ${NATIONAL.year}) who work in Switzerland follow a tax and social-security regime that differs from Italy, France or Germany. ` +
      `Note: this is the MINORITY flow on this corridor — in ${CTX.year}, ${chToLi} people commuted the other way (Switzerland → Liechtenstein) versus ${liToCh} in this direction (${CTX.ratio}), and 57% (2022) of Liechtenstein's total workforce commutes in from abroad. ` +
      `Source: ${CTX.source}`,
    municipalityTitle: (comuneName) => `Living in ${comuneName} (Liechtenstein) and working in Switzerland`,
    faq: [
      {
        question: 'How is a Liechtenstein resident working in Switzerland taxed?',
        answer:
          'Under the CH-LI double-taxation treaty (SR 0.672.951.43, art. 15 para 4), genuine daily commuters are taxed exclusively in their state of residence — structurally different from the arrangements with Italy, France or Germany.',
      },
      {
        question: 'What happens if I do not return home every day?',
        answer:
          'The treaty’s protocol (point 4 lit. c) sets a 45-working-day/year non-return threshold beyond which frontaliere status is lost. The source consulted does not specify what changes fiscally after that status is lost — do not assume an analogy with Germany’s 60-day rule.',
      },
      {
        question: 'Do I need to clear customs every day to get to work?',
        answer:
          'No: Liechtenstein and Switzerland have formed a customs union since 1923 (SR 0.631.112.514), share a monetary treaty (1980/1981, SR 0.951.951.4) and the same VAT territory — no customs formalities, no currency change, no VAT-rate difference.',
      },
      {
        question: 'Where are AVS/AI (old-age and disability) social-security contributions paid?',
        answer:
          'The place-of-work principle applies (1989 bilateral agreement, art. 5, with exceptions under art. 6): contributions are normally paid where you work, i.e. in Switzerland.',
      },
      {
        question: 'Is the Liechtenstein → Switzerland flow the most common on this corridor?',
        answer:
          `No — and this matters: in ${CTX.year} the dominant flow was the opposite, Switzerland → Liechtenstein (${chToLi} people versus ${liToCh}, a ratio of ${CTX.ratio}). This guide covers the minority flow because it matches this site’s audience, not because it is the corridor’s majority pattern.`,
        kind: 'commuting-direction',
      },
    ],
  },

  de: {
    hubTitle: 'Wohnen in Liechtenstein, arbeiten in der Schweiz: Gemeinde-Ratgeber für das Fürstentum',
    hubLede:
      `Wer in einer der 11 Gemeinden Liechtensteins (${nationalPop} Einwohner, ${NATIONAL.year}) wohnt und in der Schweiz arbeitet, unterliegt einer Steuer- und Sozialversicherungsregelung, die sich von Italien, Frankreich oder Deutschland unterscheidet. ` +
      `Wichtig: Dies ist die MINDERHEITSRICHTUNG auf diesem Korridor — ${CTX.year} pendelten ${chToLi} Personen den umgekehrten Weg (Schweiz → Liechtenstein), gegenüber ${liToCh} in dieser Richtung (Verhältnis ${CTX.ratio}); 57% (2022) der liechtensteinischen Erwerbstätigen pendeln aus dem Ausland ein. ` +
      `Quelle: ${CTX.source}`,
    municipalityTitle: (comuneName) => `Wohnen in ${comuneName} (Liechtenstein) und Arbeiten in der Schweiz`,
    faq: [
      {
        question: 'Wie wird ein Grenzgänger besteuert, der in Liechtenstein wohnt und in der Schweiz arbeitet?',
        answer:
          'Nach dem Doppelbesteuerungsabkommen CH-LI (SR 0.672.951.43, Art. 15 Abs. 4) werden echte Tagesgrenzgänger ausschliesslich im Wohnsitzstaat besteuert — ein strukturell anderer Mechanismus als bei Italien, Frankreich oder Deutschland.',
      },
      {
        question: 'Was passiert, wenn ich nicht jeden Tag nach Hause zurückkehre?',
        answer:
          'Das Protokoll zum Abkommen (Ziff. 4 Bst. c) setzt die Schwelle für den Verlust des Grenzgängerstatus bei 45 Nichtrückkehrtagen pro Jahr an. Die konsultierte Quelle sagt nicht, was sich steuerlich nach Verlust dieses Status ändert — keine Analogie zur deutschen 60-Tage-Regel annehmen.',
      },
      {
        question: 'Muss ich täglich eine Zollgrenze passieren, um zur Arbeit zu kommen?',
        answer:
          'Nein: Liechtenstein und die Schweiz bilden seit 1923 eine Zollunion (SR 0.631.112.514), teilen einen Währungsvertrag (1980/1981, SR 0.951.951.4) und dasselbe Mehrwertsteuergebiet — keine Zollformalitäten, kein Währungswechsel, kein unterschiedlicher Mehrwertsteuersatz.',
      },
      {
        question: 'Wo werden die AHV/IV-Beiträge bezahlt?',
        answer:
          'Es gilt das Erwerbsortsprinzip (bilaterales Abkommen 1989, Art. 5, mit Ausnahmen in Art. 6): Beiträge werden in der Regel dort bezahlt, wo gearbeitet wird, also in der Schweiz.',
      },
      {
        question: 'Ist die Richtung Liechtenstein → Schweiz auf diesem Korridor die häufigste?',
        answer:
          `Nein — und das ist wichtig zu wissen: ${CTX.year} war die dominante Richtung die umgekehrte, Schweiz → Liechtenstein (${chToLi} Personen gegenüber ${liToCh}, Verhältnis ${CTX.ratio}). Dieser Ratgeber deckt die Minderheitsrichtung ab, weil sie zur Leserschaft dieser Seite passt — nicht weil sie das Mehrheitsmuster des Korridors wäre.`,
        kind: 'commuting-direction',
      },
    ],
  },

  fr: {
    hubTitle: 'Vivre au Liechtenstein et travailler en Suisse : guide des communes de la Principauté',
    hubLede:
      `Les habitants des 11 communes du Liechtenstein (${nationalPop} personnes, ${NATIONAL.year}) qui travaillent en Suisse relèvent d'un régime fiscal et de sécurité sociale différent de celui de l'Italie, de la France ou de l'Allemagne. ` +
      `Attention : il s'agit du flux MINORITAIRE de ce corridor — en ${CTX.year}, ${chToLi} personnes faisaient le trajet inverse (Suisse → Liechtenstein) contre ${liToCh} dans ce sens (ratio ${CTX.ratio}), et 57 % (2022) de la population active du Liechtenstein est pendulaire entrante depuis l'étranger. ` +
      `Source : ${CTX.source}`,
    municipalityTitle: (comuneName) => `Vivre à ${comuneName} (Liechtenstein) et travailler en Suisse`,
    faq: [
      {
        question: 'Comment est imposé un résident du Liechtenstein qui travaille en Suisse ?',
        answer:
          "En vertu de la convention de double imposition CH-LI (SR 0.672.951.43, art. 15 al. 4), les véritables frontaliers journaliers sont imposés exclusivement dans leur État de résidence — un mécanisme structurellement différent de celui applicable avec l'Italie, la France ou l'Allemagne.",
      },
      {
        question: 'Que se passe-t-il si je ne rentre pas chez moi chaque jour ?',
        answer:
          "Le protocole de l'accord (point 4 let. c) fixe à 45 jours ouvrés par an le seuil de non-retour au-delà duquel le statut de frontalier est perdu. La source consultée ne précise pas ce qui change fiscalement après la perte de ce statut — ne pas présumer d'une analogie avec la règle allemande des 60 jours.",
      },
      {
        question: 'Faut-il passer la douane chaque jour pour se rendre au travail ?',
        answer:
          "Non : le Liechtenstein et la Suisse forment une union douanière depuis 1923 (SR 0.631.112.514), partagent un traité monétaire (1980/1981, SR 0.951.951.4) et le même territoire TVA — aucune formalité douanière, aucun changement de devise, aucune différence de taux de TVA.",
      },
      {
        question: 'Où sont versées les cotisations AVS/AI ?',
        answer:
          "Le principe du lieu de travail s'applique (accord bilatéral de 1989, art. 5, avec exceptions à l'art. 6) : les cotisations sont normalement versées là où l'on travaille, donc en Suisse.",
      },
      {
        question: 'Le flux Liechtenstein → Suisse est-il le plus courant sur ce corridor ?',
        answer:
          `Non — et c'est important à savoir : en ${CTX.year}, le flux dominant était l'inverse, Suisse → Liechtenstein (${chToLi} personnes contre ${liToCh}, ratio ${CTX.ratio}). Ce guide couvre le flux minoritaire parce qu'il correspond au public de ce site, pas parce qu'il serait le schéma majoritaire du corridor.`,
        kind: 'commuting-direction',
      },
    ],
  },
};
