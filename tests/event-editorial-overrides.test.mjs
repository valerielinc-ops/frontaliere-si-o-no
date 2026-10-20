import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEditorialOverride } from './event-editorial-overrides.mjs';

test('applies a reviewed category and localized copy correction by stable id', () => {
  const event = { id: 'guidle:ADZbG4C', category: 'Metal / Hardcore', description: 'old copy' };
  const corrected = applyEditorialOverride(event, {
    overrides: {
      'guidle:ADZbG4C': {
        category: 'musica',
        musicStyle: 'avant-garde pop',
        descriptionByLocale: { en: 'Artist correction.' },
      },
    },
  });

  assert.equal(corrected.category, 'musica');
  assert.equal(corrected.musicStyle, 'avant-garde pop');
  assert.deepEqual(corrected.descriptionByLocale, { en: 'Artist correction.' });
  assert.equal(corrected.description, 'old copy');
});

test('does not mutate an event without a matching override', () => {
  const event = { id: 'guidle:other', category: 'Music' };
  assert.deepEqual(applyEditorialOverride(event, { overrides: {} }), event);
});

test('merges a partial locale correction without deleting existing translations', () => {
  const corrected = applyEditorialOverride(
    { id: 'guidle:partial', descriptionByLocale: { en: 'E', de: 'D', fr: 'F' } },
    { overrides: { 'guidle:partial': { descriptionByLocale: { it: 'I' } } } },
  );
  assert.deepEqual(corrected.descriptionByLocale, { en: 'E', de: 'D', fr: 'F', it: 'I' });
});
