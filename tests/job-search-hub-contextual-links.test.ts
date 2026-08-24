/**
 * Gate: l'hub di ricerca lavoro `/cerca-lavoro-ticino/` deve restare la
 * destinazione delle ancore a intento TRANSAZIONALE nei link contestuali del
 * blog — e non deve tornare a zero link come era prima di questo gate.
 *
 * Perche' esiste
 * --------------
 * Audit di traffico del 2026-08-24 (GA4 + Search Console): l'hub posizionava
 * 13,0 su Google, peggio di quasi tutte le sue pagine figlie, e le query
 * generiche che dovrebbe vincere erano ferme in posizione 4-6
 * («offerte di lavoro ticino» 4,8 — «lavoro ticino» 4,5 — «lavoro lugano» 6,1).
 *
 * Causa misurata sul corpus IT reale (3547 articoli, injector vero):
 * ZERO link contestuali verso `/cerca-lavoro-ticino/`, mentre 671 andavano a
 * `/mercato-lavoro-ticino/`. Le due pagine NON sono la stessa cosa:
 *
 *   /cerca-lavoro-ticino/   → «8917 Offerte di Lavoro Ticino 2026»  (bacheca)
 *   /mercato-lavoro-ticino/ → «Mercato del lavoro — report settimanale» (report)
 *
 * La regola `it.jobs.offerte-ticino` mandava al report ancore che dicono
 * letteralmente «offerte di lavoro in Ticino»: equity di anchor text
 * transazionale consegnata alla pagina informativa. Questo file impedisce che
 * quel routing venga rifatto per distrazione.
 *
 * Il gate e' puro (legge la tabella delle regole, non `dist/` e non il corpus),
 * quindi gira identico in CI e in un worktree sparse.
 */

import { describe, it, expect } from 'vitest';
import {
  BLOG_CONTEXTUAL_LINKS,
  BLOG_LINKS_MAX_PER_ARTICLE,
  type BlogContextualLinkRule,
} from '@/build-plugins/blogContextualLinksData';

const JOB_SEARCH_HUB = '/cerca-lavoro-ticino/';
const JOB_MARKET_REPORT = '/mercato-lavoro-ticino/';

const IT_RULES = BLOG_CONTEXTUAL_LINKS.it;

/** Prima regola che matcha `phrase`, risolta come fa l'injector: priorita' piu' alta. */
function winningRule(phrase: string): BlogContextualLinkRule | undefined {
  return [...IT_RULES]
    .filter((r) => r.keywordPattern.test(phrase))
    .sort((a, b) => b.priority - a.priority)[0];
}

describe('hub di ricerca lavoro — routing dei link contestuali del blog', () => {
  it('almeno tre regole IT puntano all\'hub di ricerca (era zero)', () => {
    const toHub = IT_RULES.filter((r) => r.targetUrl === JOB_SEARCH_HUB);
    expect(toHub.length).toBeGreaterThanOrEqual(3);
  });

  // Le query che l'audit ha trovato ferme in posizione 4-6. Sono le ancore che
  // devono arrivare alla bacheca, non al report.
  const TRANSACTIONAL = [
    'le offerte di lavoro in Ticino sono aumentate',
    'i posti di lavoro in Ticino restano scoperti',
    'annunci di lavoro a Lugano per frontalieri',
    'chi cerca lavoro in Ticino trova soprattutto profili tecnici',
    'il lavoro in Ticino attira molti frontalieri',
    'il lavoro a Lugano paga meglio',
    'per trovare lavoro serve pazienza',
    'cercare un nuovo lavoro dopo i quaranta',
  ];

  it.each(TRANSACTIONAL)('intento transazionale → bacheca: %s', (phrase) => {
    const rule = winningRule(phrase);
    expect(rule, `nessuna regola matcha: ${phrase}`).toBeDefined();
    expect(rule!.targetUrl).toBe(JOB_SEARCH_HUB);
  });

  // Il contraltare: l'intento informativo NON deve migrare sulla bacheca,
  // altrimenti il report perde la sua ragione d'essere e il gate sopra
  // diventerebbe soddisfacibile svuotando `/mercato-lavoro-ticino/`.
  const INFORMATIONAL = [
    'il mercato del lavoro in Ticino mostra segnali di espansione',
    'il tasso di occupazione in Ticino e\' salito',
  ];

  it.each(INFORMATIONAL)('intento informativo → report: %s', (phrase) => {
    const rule = winningRule(phrase);
    expect(rule, `nessuna regola matcha: ${phrase}`).toBeDefined();
    expect(rule!.targetUrl).toBe(JOB_MARKET_REPORT);
  });

  it('«mercato del lavoro in Ticino» batte «lavoro in Ticino» per priorita\'', () => {
    // Le due regexp si sovrappongono sulla stessa frase. L'injector ammette un
    // solo link per paragrafo (`usedSegments`), quindi la priorita' decide chi
    // vince il paragrafo condiviso: deve vincere il report.
    const mercato = IT_RULES.find((r) => r.id === 'it.jobs.mercato-lavoro');
    const lavoroIn = IT_RULES.find((r) => r.id === 'it.jobs.lavoro-in-ticino');
    expect(mercato).toBeDefined();
    expect(lavoroIn).toBeDefined();
    expect(mercato!.priority).toBeGreaterThan(lavoroIn!.priority);
  });

  it('nessuna ancora non descrittiva fra le regole dell\'hub', () => {
    // L'anchor text e' la fetta di testo matchata, quindi una regexp che possa
    // matchare «qui»/«clicca qui» produrrebbe un link non descrittivo — che
    // `scripts/audit-link-anchor-text.mjs` conta come offesa.
    const NON_DESCRIPTIVE = ['qui', 'clicca qui', 'qui', 'leggi tutto', 'vedi'];
    const toHub = IT_RULES.filter((r) => r.targetUrl === JOB_SEARCH_HUB);
    for (const rule of toHub) {
      for (const bad of NON_DESCRIPTIVE) {
        expect(
          rule.keywordPattern.test(bad),
          `${rule.id} matcha l'ancora non descrittiva "${bad}"`,
        ).toBe(false);
      }
      // Ogni regola dell'hub deve nominare il lavoro: e' cio' che rende
      // l'ancora descrittiva del bersaglio.
      expect(rule.keywordPattern.source.toLowerCase()).toContain('lavoro');
    }
  });

  // ── La stessa classe di difetto negli altri tre locali (Non-Negotiable #6) ──
  //
  // Il routing sbagliato non era solo italiano: `en.jobs.openings`,
  // `de.jobs.stellen` e `fr.jobs.offres` mandavano al report le stesse ancore
  // transazionali. Le rotte canoniche degli hub vengono da
  // `build-plugins/jobBoardSeo.ts:JOB_BOARD_LANDING_PATHS`.
  const HUB_BY_LOCALE = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  } as const;

  it.each(Object.entries(HUB_BY_LOCALE))(
    'locale %s: almeno tre regole puntano a %s',
    (locale, hub) => {
      const rules = BLOG_CONTEXTUAL_LINKS[locale as keyof typeof HUB_BY_LOCALE];
      const toHub = rules.filter((r) => r.targetUrl === hub);
      expect(toHub.length).toBeGreaterThanOrEqual(3);
    },
  );

  const SIBLING_TRANSACTIONAL: ReadonlyArray<[keyof typeof HUB_BY_LOCALE, string]> = [
    ['en', 'job offers in Ticino are up this quarter'],
    ['en', 'many jobs in Lugano stay unfilled'],
    ['en', 'how to find a job as a cross-border worker'],
    ['de', 'Stellenangebote im Tessin sind gestiegen'],
    ['de', 'viele Jobs im Tessin bleiben unbesetzt'],
    ['de', 'die Jobsuche dauert oft Monate'],
    ['fr', 'les offres d\'emploi au Tessin augmentent'],
    ['fr', 'le travail au Tessin attire les frontaliers'],
    ['fr', 'trouver un emploi demande du temps'],
  ];

  it.each(SIBLING_TRANSACTIONAL)('%s intento transazionale → bacheca: %s', (locale, phrase) => {
    const rules = BLOG_CONTEXTUAL_LINKS[locale];
    const rule = [...rules]
      .filter((r) => r.keywordPattern.test(phrase))
      .sort((a, b) => b.priority - a.priority)[0];
    expect(rule, `nessuna regola ${locale} matcha: ${phrase}`).toBeDefined();
    expect(rule!.targetUrl).toBe(HUB_BY_LOCALE[locale]);
  });

  it('nessun locale manda piu\' l\'intento transazionale al report di mercato', () => {
    // Guardia esplicita contro il ritorno del difetto originale.
    const REPORTS = [
      '/mercato-lavoro-ticino/',
      '/en/ticino-job-market/',
      '/de/tessin-arbeitsmarkt/',
      '/fr/marche-travail-tessin/',
    ];
    const TRANSACTIONAL_IDS = [
      'it.jobs.offerte-ticino',
      'en.jobs.openings',
      'de.jobs.stellen',
      'fr.jobs.offres',
    ];
    for (const locale of Object.keys(HUB_BY_LOCALE) as (keyof typeof HUB_BY_LOCALE)[]) {
      for (const rule of BLOG_CONTEXTUAL_LINKS[locale]) {
        if (!TRANSACTIONAL_IDS.includes(rule.id)) continue;
        expect(REPORTS, `${rule.id} e' tornato a puntare al report`).not.toContain(rule.targetUrl);
        expect(rule.targetUrl).toBe(HUB_BY_LOCALE[locale]);
      }
    }
  });

  it('il cap per articolo resta in vigore (niente keyword stuffing)', () => {
    // Il dedup per targetUrl dell'injector da' al massimo UN link all'hub per
    // articolo; questo cap limita il totale. Se qualcuno lo alzasse molto, le
    // tre regole nuove diventerebbero una fonte di over-linking.
    expect(BLOG_LINKS_MAX_PER_ARTICLE).toBeLessThanOrEqual(4);
  });
});
