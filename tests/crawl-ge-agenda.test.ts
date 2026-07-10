/**
 * Ville de Genève agenda crawler (#3644, F2 of #3125, pilot non-TI canton):
 * pure parsing logic only — no live network calls. Card fixture below is
 * trimmed real markup captured from https://www.geneve.ch/agenda?page=0
 * (2026-07-06) so the DOM selectors are exercised against the real shape.
 */
import { describe, it, expect } from 'vitest';
import { parseGeneveDateFr, parseGeneveAgendaHtml } from '../scripts/crawl-ge-agenda.mjs';

const NOW = new Date('2026-07-06T00:00:00Z');

describe('parseGeneveDateFr', () => {
  it('parses a single weekday+day+month+time (no year)', () => {
    expect(parseGeneveDateFr('Lundi 6 juillet, 09h30', NOW)).toEqual({
      startDate: '2026-07-06',
      endDate: '2026-07-06',
    });
  });

  it('parses a "Du X au Y mois" range, inheriting the month leftward', () => {
    expect(parseGeneveDateFr('Du 6 au 10 juillet', NOW)).toEqual({
      startDate: '2026-07-06',
      endDate: '2026-07-10',
    });
  });

  it('parses an open-ended "jusqu\'au" date as [today, end]', () => {
    expect(parseGeneveDateFr("jusqu'au 2 août", NOW)).toEqual({
      startDate: '2026-07-06',
      endDate: '2026-08-02',
    });
  });

  it('parses "jusqu\'au" with an explicit year and ignores trailing recurrence text', () => {
    expect(parseGeneveDateFr("jusqu'au 3 septembre 2026, certains mercredis", NOW)).toEqual({
      startDate: '2026-07-06',
      endDate: '2026-09-03',
    });
  });

  it('parses a same-month "X et Y" pair', () => {
    expect(parseGeneveDateFr('2 et 3 août', NOW)).toEqual({
      startDate: '2026-08-02',
      endDate: '2026-08-03',
    });
  });

  it('parses a cross-month "X et Y" pair', () => {
    expect(parseGeneveDateFr('31 octobre et 1 novembre', NOW)).toEqual({
      startDate: '2026-10-31',
      endDate: '2026-11-01',
    });
  });

  it('collapses multiple same-day times into one date', () => {
    expect(parseGeneveDateFr('Dimanche 1 novembre, 09h30, 10h30', NOW)).toEqual({
      startDate: '2026-11-01',
      endDate: '2026-11-01',
    });
  });

  it('rolls the year forward across a year-boundary "X et Y" pair', () => {
    expect(parseGeneveDateFr('31 décembre et 1 janvier', NOW)).toEqual({
      startDate: '2026-12-31',
      endDate: '2027-01-01',
    });
  });

  it('infers next year for a bare day/month that already passed (beyond the grace window)', () => {
    // "5 janvier" relative to a July crawl day has no explicit year and is
    // far in the past for the current year — must roll to next year, not
    // silently produce a stale past date.
    expect(parseGeneveDateFr('5 janvier', NOW)).toEqual({
      startDate: '2027-01-05',
      endDate: '2027-01-05',
    });
  });

  it('returns null for text with no day/month at all (never fabricates a date)', () => {
    expect(parseGeneveDateFr('certains mercredis', NOW)).toBeNull();
  });

  it('returns null for a day that does not exist in the given month (never fabricates a date)', () => {
    // April has 30 days — "31 avril" is a mis-scan, not a real date.
    expect(parseGeneveDateFr('31 avril', NOW)).toBeNull();
    // Feb 29 only exists in a leap year.
    expect(parseGeneveDateFr('29 fevrier 2026', NOW)).toBeNull();
    expect(parseGeneveDateFr('29 fevrier 2028', NOW)).toEqual({
      startDate: '2028-02-29',
      endDate: '2028-02-29',
    });
  });

  it('returns null for empty/missing input', () => {
    expect(parseGeneveDateFr('', NOW)).toBeNull();
    expect(parseGeneveDateFr(undefined as unknown as string, NOW)).toBeNull();
  });
});

function cardHtml({
  href = '/agenda/atelier-initiation-ecriture-braille-7-grand-juillet-gratuit-0',
  date = 'Lundi 6 juillet, 09h30',
  title = "Atelier d'initiation à l'écriture braille dès 7 ans à Grand Juillet (gratuit)",
  description = 'Atelier ludique de découverte du braille, tous les jours du festival sauf les 4, 8 et 12 juillet au Grand Lieu, ferme de Budé 1209',
  tags = ['100% gratuit - En plein air', 'Atelier'],
  img = '/sites/default/files/styles/1_48_445x300/public/openagenda/oa-48925009.jpg.webp?itok=6fZquLMj',
}: {
  href?: string;
  date?: string;
  title?: string;
  description?: string;
  tags?: string[];
  img?: string;
} = {}) {
  const tagsHtml = tags.map((t) => `<p class="no-margin tags">${t}</p>`).join('\n');
  return `
    <article class="event teaser teaser-default clearfix">
      <div class="boite bg-color-twentythree text-color-three illustration">
        <a href="${href}">
          <div class="evenements-lies--img">
            <img loading="lazy" src="${img}" width="445" height="300" alt="">
          </div>
          <div class="boite__contenu bg-color-twentythree text-color-three">
            <div class="date"><small class="bg-color-five text-color-three has-label">${date}</small></div>
            <h3 class="titre bg-color-twentythree text-color-three">
              <div class="field field--name-field-teaser-title field--type-string field--label-hidden field--item">${title}</div>
            </h3>
            <p class="bg-color-twentythree text-color-three">${description}</p>
            ${tagsHtml}
          </div>
        </a>
      </div>
    </article>
  `;
}

describe('parseGeneveAgendaHtml', () => {
  // Fixture dates are July 2026: pin `now` inside the range so the
  // year-inference is deterministic forever (no calendar time-bomb — the
  // suite went red on 2026-07-10 when the un-pinned `now` crossed the
  // start date + grace window of these very fixtures).
  const FIXED_NOW = new Date('2026-07-08T12:00:00Z');

  it('parses a real card into the canonical event shape (region-fallback comune)', () => {
    const html = `<div>${cardHtml()}</div>`;
    const events = parseGeneveAgendaHtml(html, 0, FIXED_NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'ge-agenda:atelier-initiation-ecriture-braille-7-grand-juillet-gratuit-0',
      title: "Atelier d'initiation à l'écriture braille dès 7 ans à Grand Juillet (gratuit)",
      startDate: '2026-07-06',
      category: 'Atelier',
      region: 'Genève',
      comune: 'Genève',
      comuneMatch: 'region',
      canton: 'GE',
      url: 'https://www.geneve.ch/agenda/atelier-initiation-ecriture-braille-7-grand-juillet-gratuit-0',
      imageUrl:
        'https://www.geneve.ch/sites/default/files/styles/1_48_445x300/public/openagenda/oa-48925009.jpg.webp?itok=6fZquLMj',
    });
    expect(events[0].endDate).toBeUndefined();
  });

  it('sets endDate only when it differs from startDate (a "Du X au Y" range)', () => {
    const html = `<div>${cardHtml({ date: 'Du 6 au 10 juillet' })}</div>`;
    const events = parseGeneveAgendaHtml(html, 0, FIXED_NOW);
    expect(events[0].startDate).toBe('2026-07-06');
    expect(events[0].endDate).toBe('2026-07-10');
  });

  it('resolves the exact comune when a different real GE municipality is named in the description', () => {
    // "Vernier" is stored in data/canton-municipalities.json without a
    // canton-disambiguator suffix (unlike e.g. "Carouge (GE)"), so it's a
    // clean exact-match fixture for a non-Genève GE comune.
    const html = `<div>${cardHtml({
      href: '/agenda/spectacle-vernier',
      title: 'Spectacle en plein air',
      description: 'Un spectacle familial au parc de Vernier, entrée libre',
    })}</div>`;
    const events = parseGeneveAgendaHtml(html, 0);
    expect(events[0].comune).toBe('Vernier');
    expect(events[0].comuneMatch).toBe('exact');
  });

  it('skips a card whose date text is genuinely unparseable, never fabricating a date', () => {
    const html = `<div>${cardHtml({ date: 'certains mercredis' })}</div>`;
    const events = parseGeneveAgendaHtml(html, 0);
    expect(events).toHaveLength(0);
  });

  it('skips a card with no title and one with no href', () => {
    const noTitle = cardHtml({ title: '' });
    const noHref = cardHtml({ href: '' });
    const events = parseGeneveAgendaHtml(`<div>${noTitle}${noHref}</div>`, 0);
    expect(events).toHaveLength(0);
  });

  it('parses multiple cards on one page independently', () => {
    const html = `<div>${cardHtml({ href: '/agenda/event-a', title: 'Event A' })}${cardHtml({
      href: '/agenda/event-b',
      title: 'Event B',
      date: '2 et 3 août',
    })}</div>`;
    const events = parseGeneveAgendaHtml(html, 0);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.title)).toEqual(['Event A', 'Event B']);
  });

  it('returns [] for a page with no event cards', () => {
    expect(parseGeneveAgendaHtml('<div><p>no events today</p></div>', 5)).toEqual([]);
  });
});
