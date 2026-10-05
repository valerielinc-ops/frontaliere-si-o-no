/**
 * Weekend digest parametrized by canton (P9a, sezioni cantonali): the Ticino
 * article keeps its identity and copy; every other canton URL group gets its
 * own stable `eventi-weekend-<it slug>` article counting only its events.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildWeekendDigestArticle,
  resolveDigestCanton,
  CANTON_DIGEST_ARTICLES,
  DIGEST_ARTICLE_ID,
  DIGEST_ARTICLE_SLUGS,
} from '../scripts/lib/events-digest-content.mjs';
import { eventsBasePathForCanton } from '../scripts/lib/events-utils.mjs';

const slugTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'canton-url-slugs.json'), 'utf8'));
const TODAY = '2027-01-01'; // Friday → weekend 2027-01-02..03

const EVENTS = [
  { id: 'gr1', title: 'Concerto a Coira', comune: 'Chur', startDate: '2027-01-02', startTime: '20:00', canton: 'GR' },
  { id: 'gr2', title: 'Mercato a Davos', comune: 'Davos', startDate: '2027-01-03', canton: 'GR' },
  { id: 'gr3', title: 'Senza comune', startDate: '2027-01-03', canton: 'GR' },
  { id: 'ti1', title: 'Concerto al LAC', comune: 'Lugano', startDate: '2027-01-02', canton: 'TI' },
  { id: 'bs1', title: 'Flohmarkt', comune: 'Basel', startDate: '2027-01-02', canton: 'BS' },
  { id: 'bl1', title: 'Konzert', comune: 'Liestal', startDate: '2027-01-03', canton: 'BL' },
  { id: 'far', title: 'Fuori weekend', comune: 'Chur', startDate: '2027-02-10', canton: 'GR' },
];

describe('CANTON_DIGEST_ARTICLES identity table', () => {
  const groups = Object.keys(slugTable.cantons).filter((key) => key !== 'TI').sort();

  it('covers exactly the non-Ticino canton URL groups', () => {
    expect(Object.keys(CANTON_DIGEST_ARTICLES).sort()).toEqual(groups);
  });

  it.each(groups)('%s: id and slugs follow the Ticino pattern on the URL slug table', (group) => {
    const record = slugTable.cantons[group];
    const entry = CANTON_DIGEST_ARTICLES[group];
    expect(entry.id).toBe(`eventi-weekend-${record.it}`);
    expect(entry.slugs).toEqual({
      it: `eventi-weekend-${record.it}`,
      en: `weekend-events-${record.en}`,
      de: `wochenend-veranstaltungen-${record.de}`,
      fr: `evenements-week-end-${record.fr}`,
    });
    for (const slug of Object.values(entry.slugs)) expect(slug).toMatch(/^[a-z0-9-]+$/);
    for (const locale of ['it', 'en', 'de', 'fr']) expect(entry.place[locale]).toMatch(/\S/);
  });

  it('never reuses the Ticino identity', () => {
    const ids = Object.values(CANTON_DIGEST_ARTICLES).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(DIGEST_ARTICLE_ID);
  });
});

describe('resolveDigestCanton', () => {
  it('maps codes and half-cantons onto their URL group, defaulting to Ticino', () => {
    expect(resolveDigestCanton()).toBe('TI');
    expect(resolveDigestCanton('ti')).toBe('TI');
    expect(resolveDigestCanton('GR')).toBe('GR');
    expect(resolveDigestCanton('BL')).toBe('BASILEA');
    expect(resolveDigestCanton('AI')).toBe('APPENZELLO');
  });

  it('throws on an unknown canton instead of falling back to Ticino', () => {
    expect(() => resolveDigestCanton('XX')).toThrow(/unknown canton/);
    expect(() => buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY, canton: 'XX' })).toThrow(/unknown canton/);
  });
});

describe('buildWeekendDigestArticle with a canton', () => {
  it('leaves the Ticino digest unchanged when the canton is TI or omitted', () => {
    const omitted = buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY });
    const explicit = buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY, canton: 'TI' });
    expect(explicit).toEqual(omitted);
    expect(omitted.id).toBe(DIGEST_ARTICLE_ID);
    expect(omitted.slugs).toEqual(DIGEST_ARTICLE_SLUGS);
    expect(omitted.eventCount).toBe(1);
  });

  const gr = buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY, canton: 'GR' });

  it('uses the canton identity and counts only that canton weekend events', () => {
    expect(gr.id).toBe('eventi-weekend-grigioni');
    expect(gr.slugs).toEqual(CANTON_DIGEST_ARTICLES.GR.slugs);
    expect(gr.eventCount).toBe(3);
    expect(gr.weekendStart).toBe('2027-01-02');
    expect(gr.weekendEnd).toBe('2027-01-03');
  });

  it('writes canton copy and links under the canton events base path in every locale', () => {
    const base = eventsBasePathForCanton('GR');
    expect(gr.content.it.title).toBe('Eventi del weekend nei Grigioni: cosa fare sabato e domenica');
    expect(gr.content.de.title).toBe('Veranstaltungen am Wochenende in Graubünden: was tun Sa & So');
    expect(gr.content.fr.title).toBe('Événements du week-end aux Grisons : que faire samedi & dimanche');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const c = gr.content[locale];
      expect(c.body1).toContain(`${base[locale]}/`);
      expect(c.body2).toContain(`(${base[locale]}/chur/)`);
      expect(c.body3).toContain(`${base[locale]}/`);
      expect(`${c.body1}${c.body2}${c.body3}`).not.toMatch(/ticino\/comuni|cerca-lavoro-ticino|jobs-im-tessin|emploi-tessin|find-jobs-ticino/);
      expect(c.faq).toHaveLength(2);
      expect(gr.imageAlt[locale]).toMatch(/\S/);
    }
  });

  it('lists the other cantons separately, grouping half-cantons', () => {
    expect(gr.content.it.body2).toContain('## Eventi anche in altri cantoni');
    expect(gr.content.it.body2).toContain('### Ticino');
    expect(gr.content.it.body2).toContain('/eventi/ticino/lugano/');
    const basel = buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY, canton: 'BS' });
    expect(basel.id).toBe('eventi-weekend-basilea');
    expect(basel.eventCount).toBe(2);
    expect(basel.content.it.body2).toContain('/eventi/basilea/basel/');
    expect(basel.content.it.body2).toContain('/eventi/basilea/liestal/');
  });

  it('writes the empty-weekend copy when the canton has no events', () => {
    const empty = buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY, canton: 'JU' });
    expect(empty.eventCount).toBe(0);
    expect(empty.content.it.body1).toContain('non risultano eventi pubblicati nel Canton Giura');
    expect(empty.content.it.body1).toContain('/eventi/giura/questo-weekend/');
  });
});
