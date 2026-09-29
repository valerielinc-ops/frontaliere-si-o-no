/**
 * Denner — the posting's own language, not a forced `it` slot (issue 5253).
 *
 * `buildDennerJobRecord` files title/description/requirements under `it`
 * whatever the language (137/146 German, 9/146 French on 2026-09-29), and
 * 30/146 stored jobs showed the German title on the Italian page. The stored
 * record below is one of them, minimized.
 */
import { describe, expect, it } from 'vitest';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  buildDennerJobRecord,
  dropStaleDennerItalianTitle,
  rekeyDennerSourceSlots,
} from '../scripts/update-denner-jobs.mjs';

const URL = 'https://www.migros.ch/it/jobs/job/denner/verkaeuferin/00000000-0000-4000-8000-000000000001';
const GERMAN_BODY = 'Frische Produkte, die ihren Namen verdienen. Volle Regale. Zufriedene Kundinnen und Kunden. '
  + 'Du berätst unsere Kundschaft, füllst die Regale auf und sorgst an der Kasse für einen reibungslosen Ablauf. '
  + 'Gemeinsam mit dem Team kontrollierst du die Qualität der Waren, präsentierst Angebote und beantwortest Fragen freundlich. '
  + 'Du arbeitest zuverlässig, aufmerksam und trägst dazu bei, dass unsere Filiale jeden Tag einladend und ordentlich bleibt.';
const ITALIAN_TRANSLATION = 'Prodotti freschi che meritano il loro nome. Scaffali pieni. Clienti soddisfatti. '
  + 'Consigli la nostra clientela, rifornisci gli scaffali e alla cassa garantisci uno svolgimento senza intoppi. '
  + 'Insieme al team controlli la qualità della merce, presenti le offerte e rispondi con cortesia alle domande. '
  + 'Lavori con precisione e affidabilità e contribuisci a mantenere il punto vendita accogliente, ordinato e pronto per le esigenze quotidiane di tutte le persone.';

const STORED = {
  id: 'denner-000000000001',
  url: URL,
  title: 'Verkäufer*in',
  sourceLang: 'de',
  titleByLocale: { it: 'Verkäufer*in', de: 'Verkäufer*in', en: 'Verkäufer*in', fr: 'Verkäufer*in' },
  descriptionByLocale: { it: ITALIAN_TRANSLATION, de: GERMAN_BODY },
  slug: 'verkaufer-in-denner',
  slugByLocale: { it: 'venditore-migros-ticino-aeschi-bei-spiez', de: 'verkaufer-in-denner' },
  needsRetranslation: true,
};

describe('Denner source-language slots', () => {
  it('moves the fresh German title and body out of the Italian slot', () => {
    const fresh = buildDennerJobRecord({ url: URL, rawTitle: 'Verkäufer*in', description: GERMAN_BODY, location: 'Aeschi bei Spiez' });
    expect(fresh?.sourceLang).toBe('de');

    const rekeyed = rekeyDennerSourceSlots(fresh!);
    expect(rekeyed.titleByLocale).toEqual({ de: 'Verkäufer*in' });
    expect(Object.keys(rekeyed.descriptionByLocale)).toEqual(['de']);
  });

  it('leaves an Italian posting as it is', () => {
    const fresh = buildDennerJobRecord({ url: URL, rawTitle: 'Addetto/a alla vendita', description: ITALIAN_TRANSLATION, location: 'Lugano' });
    expect(rekeyDennerSourceSlots(fresh!)).toEqual(fresh);
  });

  it('drops the German title copied into `it`, keeps the Italian description and every slug', () => {
    const fresh = rekeyDennerSourceSlots(buildDennerJobRecord({ url: URL, rawTitle: 'Verkäufer*in', description: GERMAN_BODY, location: 'Aeschi bei Spiez' })!);
    const [merged] = mergePreserveLocaleData([STORED], [{ ...fresh, id: STORED.id }]).map(dropStaleDennerItalianTitle);

    expect(merged.titleByLocale.it).toBeUndefined();
    expect(merged.titleByLocale.de).toBe('Verkäufer*in');
    expect(merged.descriptionByLocale.it).toBe(ITALIAN_TRANSLATION);
    expect(merged.needsRetranslation).toBe(true);
    expect(merged.slugByLocale.it).toBe(STORED.slugByLocale.it);
  });

  it('keeps a real Italian title', () => {
    const translated = { ...STORED, titleByLocale: { ...STORED.titleByLocale, it: 'Venditore/Venditrice' }, needsRetranslation: undefined };
    expect(dropStaleDennerItalianTitle(translated)).toBe(translated);
  });
});
