/**
 * Tests for scripts/lib/article-sanitizers.mjs — editorial quality
 * sanitizers added after the 2026-05-12 incident on article
 * `temporali-grandine-luganese-11-maggio-2026` (run 25714951592).
 *
 * Two regressions covered:
 *
 *   1. Competitor newsletter promotion. The LLM lifted "iscriversi alla
 *      newsletter giornaliera di Tio" from the source. We strip any
 *      sentence that recommends a competitor's newsletter / app /
 *      subscription. Strict: must contain BOTH a promotion verb AND a
 *      competitor brand.
 *
 *   2. Semantic mismatch on nav: links. Existing validation only checked
 *      that `nav:<action>` is in VALID_NAV_ACTIONS — not that the visible
 *      text matched the action's semantic. So `[calcolatore di
 *      tragitti](nav:calculator)` passed (calculator is a valid token)
 *      and shipped a fiscal-calculator link under a route-planner label.
 *      The new sanitiser strips the link when the text contains
 *      anti-keywords (weather, route, traffic) for that action.
 *
 * Quality preserved:
 *   - Fonte/Source attribution lines are NEVER stripped.
 *   - Legitimate nav: links survive (`nav:transport` with "tragitto",
 *     `nav:exchange` with "CHF/EUR", etc.).
 *   - Translations are NOT semantically rechecked — only IT.
 */

import { describe, expect, it } from 'vitest';
import {
  stripCompetitorPromotion,
  sanitizeNavLinkSemantics,
  stripFabricatedExamples,
  sanitizeBodyIt,
} from '../scripts/lib/article-sanitizers.mjs';

describe('stripCompetitorPromotion', () => {
  it('strips the exact shipped Tio newsletter promotion', () => {
    const input =
      "Per ricevere aggiornamenti costanti sulle condizioni meteorologiche e sulle eventuali allerte diramate dalle autorità, i frontalieri possono iscriversi alla newsletter giornaliera di Tio. Questo può aiutare a rimanere aggiornati.";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(1);
    expect(r.text).not.toMatch(/newsletter giornaliera di Tio/i);
    expect(r.text).toMatch(/Questo può aiutare a rimanere aggiornati/);
  });

  it('strips CDT newsletter promotion', () => {
    const input = "I lettori possono abbonarsi alla newsletter del CDT per restare aggiornati. Le notizie sono importanti.";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(1);
    expect(r.text).toBe("Le notizie sono importanti.");
  });

  it('strips La Regione subscription promotion', () => {
    const input = "Iscriviti alla newsletter di laregione.ch per gli aggiornamenti. Le decisioni del Consiglio federale sono pubbliche.";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(1);
    expect(r.text).toMatch(/Consiglio federale/);
  });

  it('strips Corriere subscription promotion', () => {
    const input = "Per maggiori informazioni, abbonati al Corriere. La pioggia continua.";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(1);
  });

  it('strips multiple competitor promotions in one paragraph', () => {
    const input = "Iscriviti alla newsletter di Tio. Scarica l'app ufficiale di RSI. Le notizie sono importanti.";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(2);
    expect(r.text).toMatch(/notizie sono importanti/);
  });

  it('PRESERVES the Fonte: attribution line', () => {
    const input = "*Fonte: [tio.ch](https://www.tio.ch/ticino/cronaca/1924632/temporali-e-grandine-nel-luganese)*";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(0);
    expect(r.text).toBe(input);
  });

  it('PRESERVES Source/Quelle attribution in other locales', () => {
    expect(stripCompetitorPromotion("*Source: [tio.ch](https://www.tio.ch/x)*").text).toMatch(/Source/);
    expect(stripCompetitorPromotion("*Quelle: [tio.ch](https://www.tio.ch/x)*").text).toMatch(/Quelle/);
  });

  it('PRESERVES content that merely mentions a competitor (no promotion)', () => {
    const input = "La fonte tio.ch ha riportato la notizia. I dati sono confermati.";
    const r = stripCompetitorPromotion(input);
    // "fonte" + "tio.ch" but no promotion cue → keep
    expect(r.removed).toBe(0);
    expect(r.text).toBe(input);
  });

  it('PRESERVES content that promotes OUR newsletter', () => {
    const input = "Iscriviti alla newsletter di Frontaliere Ticino per gli aggiornamenti.";
    const r = stripCompetitorPromotion(input);
    expect(r.removed).toBe(0);
  });

  it('handles empty / null / non-string input safely', () => {
    expect(stripCompetitorPromotion('').text).toBe('');
    expect(stripCompetitorPromotion(null as unknown as string).removed).toBe(0);
    expect(stripCompetitorPromotion(undefined as unknown as string).removed).toBe(0);
  });
});

describe('sanitizeNavLinkSemantics — anti-keyword strips', () => {
  it('strips the shipped `[calcolatore di tragitti](nav:calculator)` link', () => {
    const input = "Usa il [calcolatore di tragitti](nav:calculator) per pianificare i percorsi.";
    const r = sanitizeNavLinkSemantics(input);
    expect(r.stripped).toBe(1);
    expect(r.text).toBe("Usa il calcolatore di tragitti per pianificare i percorsi.");
    expect(r.examples[0]).toMatch(/off-topic/);
  });

  it('strips the shipped `[comparatore di condizioni meteorologiche](nav:exchange)` link', () => {
    const input = "Consulta il [comparatore di condizioni meteorologiche](nav:exchange) per gli aggiornamenti.";
    const r = sanitizeNavLinkSemantics(input);
    expect(r.stripped).toBe(1);
    expect(r.text).toBe("Consulta il comparatore di condizioni meteorologiche per gli aggiornamenti.");
  });

  it('strips weather text on any non-weather action', () => {
    expect(sanitizeNavLinkSemantics("[allerta maltempo](nav:calculator)").stripped).toBe(1);
    expect(sanitizeNavLinkSemantics("[previsioni meteo](nav:exchange)").stripped).toBe(1);
    expect(sanitizeNavLinkSemantics("[grandine in Ticino](nav:health)").stripped).toBe(1);
    expect(sanitizeNavLinkSemantics("[temporale Luganese](nav:pension)").stripped).toBe(1);
  });

  it('strips route text on any non-route action', () => {
    expect(sanitizeNavLinkSemantics("[calcolatore di tragitti](nav:calculator)").stripped).toBe(1);
    expect(sanitizeNavLinkSemantics("[itinerario consigliato](nav:health)").stripped).toBe(1);
    expect(sanitizeNavLinkSemantics("[percorsi alternativi](nav:exchange)").stripped).toBe(1);
  });

  it('PRESERVES valid fiscal-calculator usage', () => {
    const r = sanitizeNavLinkSemantics("Usa il [calcolatore fiscale](nav:calculator) per il netto.");
    expect(r.stripped).toBe(0);
    expect(r.text).toContain("[calcolatore fiscale](nav:calculator)");
  });

  it('PRESERVES valid CHF/EUR exchange usage', () => {
    const r = sanitizeNavLinkSemantics("Confronta il [tasso di cambio CHF/EUR](nav:exchange) in tempo reale.");
    expect(r.stripped).toBe(0);
  });

  it('PRESERVES nav:transport with "tragitto" text (legitimate route home)', () => {
    const r = sanitizeNavLinkSemantics("Pianifica il [tragitto pendolare](nav:transport) per ridurre i tempi.");
    expect(r.stripped).toBe(0);
    expect(r.text).toContain("(nav:transport)");
  });

  it('PRESERVES nav:car-cost with "tragitto" text', () => {
    const r = sanitizeNavLinkSemantics("Calcola il [costo del tragitto in auto](nav:car-cost).");
    expect(r.stripped).toBe(0);
  });

  it('PRESERVES nav:traffic-history with "traffico" text', () => {
    const r = sanitizeNavLinkSemantics("Consulta lo [storico del traffico stradale](nav:traffic-history).");
    expect(r.stripped).toBe(0);
  });

  it('PRESERVES nav:border with "valichi/tempi di attesa" text', () => {
    const r = sanitizeNavLinkSemantics("Verifica i [tempi di attesa ai valichi](nav:border).");
    expect(r.stripped).toBe(0);
  });

  it('PRESERVES nav:health with "LAMal" text', () => {
    const r = sanitizeNavLinkSemantics("Scegli la [tua LAMal](nav:health).");
    expect(r.stripped).toBe(0);
  });

  it('PRESERVES nav:permits with "Permesso G" text', () => {
    const r = sanitizeNavLinkSemantics("Verifica i [permessi G e B](nav:permits) per la frontiera.");
    expect(r.stripped).toBe(0);
  });

  it('does not touch unknown actions — those are handled by the existing VALID_NAV_ACTIONS check', () => {
    const r = sanitizeNavLinkSemantics("Vedi il [random](nav:unknown-future-action).");
    expect(r.stripped).toBe(0);
    expect(r.text).toContain("(nav:unknown-future-action)");
  });

  it('handles multiple links in one paragraph', () => {
    const input = "Usa il [calcolatore di tragitti](nav:calculator) e il [comparatore meteo](nav:exchange).";
    const r = sanitizeNavLinkSemantics(input);
    expect(r.stripped).toBe(2);
    expect(r.text).not.toContain("nav:calculator");
    expect(r.text).not.toContain("nav:exchange");
  });
});

describe('sanitizeNavLinkSemantics — positive allowlist fallback', () => {
  it('strips a nav:calculator link whose text has no fiscal keyword', () => {
    // No anti-keyword, but also no positive (calcolatore/stipendio/fiscale/…)
    const r = sanitizeNavLinkSemantics("Vedi il [link generico](nav:calculator).");
    expect(r.stripped).toBe(1);
    expect(r.examples[0]).toMatch(/no semantic match/);
  });

  it('strips a nav:exchange link whose text has no currency keyword', () => {
    const r = sanitizeNavLinkSemantics("Consulta il [link generico qui](nav:exchange).");
    expect(r.stripped).toBe(1);
  });
});

describe('sanitizeBodyIt — orchestration', () => {
  it('applies both sanitizers in sequence', () => {
    const input =
      "Usa il [calcolatore di tragitti](nav:calculator). Iscriviti alla newsletter di Tio. Questo è importante.";
    const r = sanitizeBodyIt(input);
    expect(r.navStripped).toBe(1);
    expect(r.competitorRemoved).toBe(1);
    expect(r.text).toMatch(/Questo è importante/);
    expect(r.text).not.toMatch(/newsletter di Tio/i);
    expect(r.text).not.toMatch(/\(nav:calculator\)/);
  });

  it('returns zero counts on clean input', () => {
    const r = sanitizeBodyIt("Usa il [calcolatore fiscale](nav:calculator) per il netto.");
    expect(r.navStripped).toBe(0);
    expect(r.competitorRemoved).toBe(0);
  });
});

describe('stripFabricatedExamples — forced frontaliere case-injection', () => {
  it('strips the shipped Unispital body1 "Esempi concreti" (Lugano/Chiasso)', () => {
    // Real text from `direttrice-unispital-zurigo-whistleblower` body1
    const body = `### Impatto sui frontalieri
Per i frontalieri che lavorano nel settore sanitario...

#### Checklist per i frontalieri
1. Conoscere i diritti.
2. Documentazione.

#### Esempi concreti
- Lugano: Un'infermiera frontaliera ha segnalato carenze igieniche in un ospedale, portando a un'indagine.
- Chiasso: Un medico ha denunciato pratiche non etiche, ottenendo protezione legale e un risarcimento.
`;
    const r = stripFabricatedExamples(body);
    expect(r.removedSections).toBe(1);
    expect(r.examples[0]).toMatch(/Lugano/);
    expect(r.text).toMatch(/Checklist per i frontalieri/);
    expect(r.text).not.toMatch(/Lugano:.+infermiera/);
    expect(r.text).not.toMatch(/Chiasso:.+medico/);
    // The "#### Esempi concreti" heading must be gone
    expect(r.text).not.toMatch(/Esempi concreti/);
  });

  it('strips the shipped Unispital body3 "Esempi concreti" (ORL/Ospedale Civico)', () => {
    const body = `### 5. Seguire le indicazioni delle autorità
In caso di emergenza, comunicare con le autorità.

### Esempi concreti
- 💡 Un infermiere dell'ORL ha segnalato irregolarità nella gestione dei farmaci, portando a un'indagine interna e al recupero di CHF 50.000.
- ⚠️ Un medico dell'Ospedale Civico di Lugano ha denunciato pratiche di bilancio fraudolente, risultando in un'indagine della FINMA.

Per ulteriori informazioni, usa il calcolatore.`;
    const r = stripFabricatedExamples(body);
    expect(r.removedSections).toBe(1);
    expect(r.text).toMatch(/Seguire le indicazioni delle autorità/);
    expect(r.text).toMatch(/Per ulteriori informazioni, usa il calcolatore/);
    expect(r.text).not.toMatch(/ORL/);
    expect(r.text).not.toMatch(/Ospedale Civico di Lugano/);
    expect(r.text).not.toMatch(/CHF 50\.000/);
  });

  it('strips "Casi pratici" heading variant', () => {
    const body = `## Casi pratici
- Lugano: Un'infermiera ha denunciato un caso di frode e ottenuto un risarcimento.
`;
    expect(stripFabricatedExamples(body).removedSections).toBe(1);
  });

  it('strips "Per esempio" heading variant', () => {
    const body = `### Per esempio:
- Mendrisio: Un medico ha segnalato irregolarità, ottenendo protezione legale.
`;
    expect(stripFabricatedExamples(body).removedSections).toBe(1);
  });

  it('PRESERVES legitimate "Esempi concreti" with numeric/legal data (no role+place pattern)', () => {
    // A real "Esempi concreti" section with verifiable tax data should
    // NOT match because no bullet has role + locality + outcome pattern.
    const body = `### Esempi concreti
- Aliquota fiscale per redditi sotto 50k CHF: 5%.
- Aliquota fiscale per redditi 50-100k CHF: 12%.
- La tredicesima è inclusa nel calcolo annuale.
`;
    const r = stripFabricatedExamples(body);
    expect(r.removedSections).toBe(0);
    expect(r.text).toBe(body);
  });

  it('PRESERVES generic checklist sections that are not "Esempi concreti"', () => {
    const body = `### Checklist operativa
- Verificare il regolamento.
- Raccogliere documenti.
- Contattare il superiore.
`;
    expect(stripFabricatedExamples(body).removedSections).toBe(0);
  });

  it('PRESERVES a section with role but no locality/outcome (too weak signal)', () => {
    const body = `### Profili tipici
- Infermiere: turni variabili, busta paga oraria.
- Medico: stipendio annuale, turni di reperibilità.
`;
    expect(stripFabricatedExamples(body).removedSections).toBe(0);
  });

  it('strips a section with mixed bullets when at least one is fabricated', () => {
    const body = `### Esempi concreti
- Generic info that\'s fine.
- Lugano: Un medico ha denunciato pratiche illegali, recuperando CHF 100.000.
- More generic info.
`;
    const r = stripFabricatedExamples(body);
    expect(r.removedSections).toBe(1);
    // The whole section dies — conservatism trades a few legitimate
    // bullets for safety from fabrications.
    expect(r.text).not.toMatch(/Generic info/);
  });

  it('handles multiple fabricated sections in one body', () => {
    const body = `## Sezione 1
Testo normale.

### Esempi concreti
- Lugano: Un infermiere ha segnalato CHF 50.000.

## Sezione 2
Altro testo.

### Casi pratici
- Chiasso: Una medico ha denunciato e ottenuto un risarcimento.
`;
    const r = stripFabricatedExamples(body);
    expect(r.removedSections).toBe(2);
    expect(r.text).toMatch(/Testo normale/);
    expect(r.text).toMatch(/Altro testo/);
    expect(r.text).not.toMatch(/Lugano:/);
    expect(r.text).not.toMatch(/Chiasso:/);
  });

  it('handles empty / null / non-string input safely', () => {
    expect(stripFabricatedExamples('').text).toBe('');
    expect(stripFabricatedExamples(null as unknown as string).removedSections).toBe(0);
    expect(stripFabricatedExamples(undefined as unknown as string).removedSections).toBe(0);
  });
});

describe('sanitizeBodyIt — full pipeline including fabricated-examples strip', () => {
  it('strips fabricated examples + competitor promo + bad nav: in one pass', () => {
    const body = `### 6. Strumenti utili
Usa il [calcolatore di tragitti](nav:calculator) per pianificare.

### Esempi concreti
- Lugano: Un'infermiera ha segnalato CHF 50.000 di irregolarità.

Iscriviti alla newsletter giornaliera di Tio. Le notizie sono importanti.`;
    const r = sanitizeBodyIt(body);
    expect(r.fabricatedSectionsRemoved).toBe(1);
    expect(r.navStripped).toBe(1);
    expect(r.competitorRemoved).toBe(1);
    expect(r.text).toMatch(/Le notizie sono importanti/);
    expect(r.text).not.toMatch(/Lugano:.+infermiera/);
    expect(r.text).not.toMatch(/nav:calculator/);
    expect(r.text).not.toMatch(/newsletter giornaliera di Tio/i);
  });
});
