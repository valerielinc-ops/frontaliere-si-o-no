// @vitest-environment node
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  classifyColour,
  extractDelemontRows,
  parseBaselStadtDutyPage,
  parseMoutierCalendar,
  parseSolothurnDutyPage,
  parseZurichDutyPage,
} from '../scripts/lib/pharmacy-swiss-canton-parser.mjs';

const SOURCE_URL = 'https://www.jura.ch/official.pdf';
const FETCHED_AT = '2026-09-29T12:00:00.000Z';
const BASEL_SOURCE_URL = 'https://www.bs.ch/gd/md/hoheitliche-funktionen/kantonsapothekerin/liste-der-apotheken-basel-stadt';
const BASEL_SOURCE_HTML = readFileSync(new URL('./fixtures/pharmacy-duties/basel-stadt/source.html', import.meta.url), 'utf8');
const ZURICH_SOURCE_URL = 'https://www.avkz.ch/notfalldienst';
const ZURICH_SOURCE_HTML = readFileSync(new URL('./fixtures/pharmacy-duties/zurich/source.html', import.meta.url), 'utf8');
const SOLOTHURN_SOURCE_URL = 'https://avso.ch/notfalldienst-apotheken/';
const SOLOTHURN_SOURCE_HTML = readFileSync(new URL('./fixtures/pharmacy-duties/solothurn/source.html', import.meta.url), 'utf8');

describe('Swiss canton pharmacy calendar parser', () => {
  it('builds a year of Basel-Stadt 24-hour duties from the official identity and opening declaration', () => {
    const parsed = parseBaselStadtDutyPage({
      html: BASEL_SOURCE_HTML,
      sourceUrl: BASEL_SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    });

    expect(parsed.coverageName).toBe('Basilea Città');
    expect(parsed.pharmacies).toEqual([expect.objectContaining({
      id: 'bs-24-stunden-apotheke-basel',
      name: '24 Stunden Apotheke Basel AG',
      city: 'Basel',
      cantonCode: 'BS',
    })]);
    expect(parsed.rows).toHaveLength(365);
    expect(parsed.rows[0]).toEqual(expect.objectContaining({
      id: 'bs-24-stunden-2026-01-01',
      startsAt: '2025-12-31T23:00:00.000Z',
      endsAt: '2026-01-01T23:00:00.000Z',
      dutyType: '24h',
      status: 'expired',
    }));
    expect(parsed.rows.at(-1)).toEqual(expect.objectContaining({
      id: 'bs-24-stunden-2026-12-31',
      status: 'verified',
    }));
    expect(parsed.rows.find((row) => row.id === 'bs-24-stunden-2026-03-29')).toEqual(expect.objectContaining({
      startsAt: '2026-03-28T23:00:00.000Z',
      endsAt: '2026-03-29T22:00:00.000Z',
    }));
    expect(parsed.rows.find((row) => row.id === 'bs-24-stunden-2026-10-25')).toEqual(expect.objectContaining({
      startsAt: '2026-10-24T22:00:00.000Z',
      endsAt: '2026-10-25T23:00:00.000Z',
    }));
  });

  it('rejects a Basel-Stadt page when the year-round opening declaration disappears', () => {
    const html = '<td><strong>24 Stunden Apotheke Basel AG</strong> Petersgraben 3 4051 Basel Montag-Sonntag 24 Stunden</td>';
    expect(() => parseBaselStadtDutyPage({
      html,
      sourceUrl: BASEL_SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    })).toThrow('Basel-Stadt page no longer declares year-round opening');
  });

  it('builds a year of Zürich 24-hour duties from the official association declaration', () => {
    const parsed = parseZurichDutyPage({
      html: ZURICH_SOURCE_HTML,
      sourceUrl: ZURICH_SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    });

    expect(parsed.coverageName).toBe('Zurigo');
    expect(parsed.pharmacies).toEqual([expect.objectContaining({
      id: 'zh-bellevue-apotheke',
      name: 'Bellevue Apotheke',
      city: 'Zürich',
      cantonCode: 'ZH',
      sourceType: 'association',
    })]);
    expect(parsed.rows).toHaveLength(365);
    expect(parsed.rows[0]).toEqual(expect.objectContaining({
      id: 'zh-bellevue-2026-01-01',
      startsAt: '2025-12-31T23:00:00.000Z',
      endsAt: '2026-01-01T23:00:00.000Z',
      dutyType: '24h',
      sourceType: 'association',
      status: 'expired',
    }));
    expect(parsed.rows.at(-1)).toEqual(expect.objectContaining({
      id: 'zh-bellevue-2026-12-31',
      status: 'verified',
    }));
  });

  it('rejects a Zürich page when the 24-hour declaration disappears', () => {
    const html = '<p>Bellevue Apotheke, Theaterstrasse 14, Zürich, 365 Tage im Jahr geöffnet</p>';
    expect(() => parseZurichDutyPage({
      html,
      sourceUrl: ZURICH_SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    })).toThrow('Zürich page no longer declares daily 24-hour opening');
  });

  it('builds the three current Solothurn regional schedules with source identities and local intervals', () => {
    const parsed = parseSolothurnDutyPage({
      html: SOLOTHURN_SOURCE_HTML,
      sourceUrl: SOLOTHURN_SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    });

    expect(parsed.coverageName).toBe('Soletta · Dorneck-Thierstein, Olten e Soletta');
    expect(parsed.pharmacies).toHaveLength(5);
    expect(parsed.rows).toHaveLength(6);
    expect(new Set(parsed.rows.map((row) => row.coverageName))).toEqual(new Set(['Dorneck-Thierstein', 'Olten', 'Solothurn']));
    expect(parsed.rows.find((row) => row.id === 'so-dorneck-thierstein-2026-10-04')).toEqual(expect.objectContaining({
      pharmacyId: 'so-dorneck-saner-apotheke-dornach',
      coverageType: 'region',
      startsAt: '2026-10-04T07:00:00.000Z',
      endsAt: '2026-10-04T10:00:00.000Z',
      sourceType: 'association',
      status: 'verified',
    }));
    expect(parsed.rows.find((row) => row.id === 'so-olten-2026-12-25')).toEqual(expect.objectContaining({
      pharmacyName: 'Hammer-Apotheke',
      startsAt: '2026-12-25T09:00:00.000Z',
      endsAt: '2026-12-25T11:00:00.000Z',
    }));
  });

  it('fails closed when a Solothurn source introduces an unknown pharmacy identity', () => {
    const html = SOLOTHURN_SOURCE_HTML.replace('Hammer-Apotheke', 'Unknown Apotheke');
    expect(() => parseSolothurnDutyPage({
      html,
      sourceUrl: SOLOTHURN_SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    })).toThrow('Solothurn pharmacy identity is not allowlisted: Unknown Apotheke');
  });

  it('rejects a Delémont row whose pharmacy is not allowlisted', () => {
    const unknownRow = 'Unlisted Pharmacy du sam 1 janvier au sam 7 janvier à8h';
    const text = Array.from({ length: 52 }, () => unknownRow).join('\n');

    expect(() => extractDelemontRows(text, {
      sourceUrl: SOURCE_URL,
      fetchedAt: FETCHED_AT,
      calendarYear: 2026,
    })).toThrow('Delémont pharmacy identity is not allowlisted: Unlisted Pharmacy');
  });

  it('rejects a Moutier crop without a unique dominant colour', () => {
    const pixels = Buffer.alloc(8 * 3);
    for (let index = 0; index < 4; index += 1) {
      pixels.set([220, 20, 20], index * 3);
    }
    for (let index = 4; index < 8; index += 1) {
      pixels.set([20, 20, 220], index * 3);
    }

    expect(classifyColour(pixels)).toBeNull();
  });

  it('rejects duplicate Moutier dates instead of overwriting their colour', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frontaliere-moutier-parser-'));
    const imagePath = join(directory, 'moutier.png');
    const width = 595;
    const height = 842;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        if (x >= 98 && x < 114) pixels.set([220, 20, 20], offset);
        else if (x >= 118 && x < 134) pixels.set([20, 20, 220], offset);
      }
    }
    await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(imagePath);

    const bboxHtml = [
      '<word xMin="100" yMin="50" xMax="150" yMax="60">janvier</word>',
      '<word xMin="100" yMin="200" xMax="108" yMax="210">1</word>',
      '<word xMin="120" yMin="200" xMax="128" yMax="210">1</word>',
    ].join('\n');

    try {
      await expect(parseMoutierCalendar({
        bboxHtml,
        imagePath,
        sourceUrl: SOURCE_URL,
        fetchedAt: FETCHED_AT,
        calendarYear: 2026,
      })).rejects.toThrow('Moutier calendar contains duplicate coloured date: 2026-01-01');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
