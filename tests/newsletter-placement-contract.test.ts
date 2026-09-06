/**
 * Il contratto di nome fra chi EMETTE `/go/{id}/?pos=…` e chi lo CONSUMA (#7695,
 * follow-up di #7656).
 *
 * La pagina /go/ trasforma il parametro di piazzamento nel `pubref` Partnerize
 * leggendolo PER NOME. Se un emettitore rinomina il parametro o fa driftare la
 * forma, il redirect non fallisce: ripiega in silenzio sul referrer e il click
 * finisce in un secchio indifferenziato — cioe' revenue affiliata non
 * attribuibile allo slot che l'ha generata, senza nessun rosso. Questi test
 * fanno diventare quella divergenza un test rotto invece di un pubref vuoto.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildRedirectPage } from '../build-plugins/affiliateRedirectPlugin';
import { PARTNERS, isPartnerizeUrl, sanitizePubref } from '../services/affiliateService';
import {
  NEWSLETTER_PLACEMENT_RE,
  PLACEMENT_PARAM,
  newsletterPartnerPlacement,
  newsletterRecommendedPlacement,
} from '../functions/src/lib/newsletterPlacements.js';
import {
  buildRecommendedHref,
  pickNewsletterRecommendation,
} from '../services/newsletter/recommendedBlock.mjs';

const wise = PARTNERS.find((p) => p.id === 'wise')!;

/** File che parlano del piazzamento: emettitori + consumatore. */
const CONTRACT_FILES = [
  'functions/src/lib/recommendedBlock.js',
  'scripts/newsletter-template.mjs',
  'build-plugins/affiliateRedirectPlugin.ts',
];

describe('newsletter placement contract', () => {
  it('pins the wire name of the placement parameter', () => {
    // Il nome sul filo e' pubblico: lo portano i link gia' spediti. Cambiarlo
    // e' un atto deliberato che deve rompere qui, non in dashboard.
    expect(PLACEMENT_PARAM).toBe('pos');
  });

  it('the redirect page reads exactly the parameter the emitters write', () => {
    const html = buildRedirectPage(wise);
    expect(isPartnerizeUrl(wise.url)).toBe(true);
    expect(html).toContain(`q.get(${JSON.stringify(PLACEMENT_PARAM)})`);
  });

  it('every emitted placement survives the pubref sanitiser unchanged', () => {
    // Il redirect normalizza a `[a-z0-9_-]` e tronca: una forma che non
    // sopravvive intatta arriva a Partnerize diversa da come e' stata emessa,
    // e le due meta' del funnel non si ricongiungono piu'.
    const placements = [
      newsletterPartnerPlacement(1, 'wise'),
      newsletterPartnerPlacement(3, 'creditagricole'),
      newsletterRecommendedPlacement('weekly_2026-09-06', 'cambiavalute'),
    ];
    for (const pos of placements) {
      expect(pos).toMatch(NEWSLETTER_PLACEMENT_RE);
      expect(sanitizePubref(pos)).toBe(pos);
    }
  });

  it('the four surfaces rendering the same block do not collapse into one pubref', () => {
    // weekly / job alert / welcome / drip rendono lo STESSO blocco verso lo
    // stesso `/go/{goId}/`: se lo slot non porta la campagna, Partnerize vede
    // un unico secchio e nessuna superficie e' confrontabile con un'altra.
    const rec = pickNewsletterRecommendation({ locale: 'it', interest: 'general' });
    const campaigns = ['weekly_2026-09-06', 'jobalert', 'welcome', 'drip'];
    const positions = campaigns.map(
      (campaign) => new URL(buildRecommendedHref(rec!, { campaign })).searchParams.get(PLACEMENT_PARAM)!,
    );
    expect(new Set(positions).size).toBe(campaigns.length);
    for (const pos of positions) {
      expect(pos).toMatch(NEWSLETTER_PLACEMENT_RE);
      // il sanitiser tronca a PUBREF_MAX_LEN: una forma piu' lunga arriverebbe
      // a Partnerize tagliata, cioe' diversa da quella emessa.
      expect(sanitizePubref(pos)).toBe(pos);
    }
  });

  it('buildRecommendedHref emits the shared shape under the shared name', () => {
    const rec = pickNewsletterRecommendation({ locale: 'it', interest: 'general' });
    expect(rec).toBeTruthy();
    expect(rec!.kind).toBe('affiliate');
    const params = new URL(buildRecommendedHref(rec!, {})).searchParams;
    expect(params.get(PLACEMENT_PARAM)).toBe(newsletterRecommendedPlacement('recommended', rec!.goId!));
    expect(params.get(PLACEMENT_PARAM)).toMatch(NEWSLETTER_PLACEMENT_RE);
  });

  it('the newsletter partner rows emit the shared shape under the shared name', async () => {
    const { buildNewsletter } = await import('../scripts/newsletter-template.mjs');
    const html: string = buildNewsletter({
      aiBriefing: '<p>Test.</p>',
      exchangeRate: { rate: 1.0942, previousRate: 1.0885 },
      weeklyFact: { text: 'Fatto.', source: 'USTAT' },
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=test@example.com',
      resubscribeUrl: 'https://frontaliereticino.ch/?action=resubscribe&email=test@example.com',
    });
    const positions = [...html.matchAll(/href="(https:\/\/frontaliereticino\.ch\/go\/[^"]+)"/g)]
      .map((m) => new URL(m[1]).searchParams.get(PLACEMENT_PARAM));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((p) => p && NEWSLETTER_PLACEMENT_RE.test(p))).toBe(true);
    expect(positions[0]).toBe(newsletterPartnerPlacement(1, 'wise'));
  });

  it('no emitter or consumer rebuilds the shapes by hand', () => {
    // Una seconda composizione della forma e' esattamente il modo in cui il
    // contratto e' driftato finora: compila, non fallisce, e produce un pubref
    // che il consumatore non riconosce.
    for (const file of CONTRACT_FILES) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(src, `${file} ricompone la forma invece di importarla`)
        .not.toMatch(/`nl-(partner|recommended)-\$\{/);
      expect(src, `${file} non importa il contratto condiviso`)
        .toContain('newsletterPlacements.js');
    }
  });
});
