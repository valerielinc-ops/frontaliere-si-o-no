// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  classifyColour,
  extractDelemontRows,
  parseMoutierCalendar,
} from '../scripts/lib/pharmacy-swiss-canton-parser.mjs';

const SOURCE_URL = 'https://www.jura.ch/official.pdf';
const FETCHED_AT = '2026-09-29T12:00:00.000Z';

describe('Swiss canton pharmacy calendar parser', () => {
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
