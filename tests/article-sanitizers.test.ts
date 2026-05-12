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
