import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMinimalRewriteDescriptions,
  meetsPoorSourceWordFloor,
  wordCount,
} from '../scripts/lib/event-description-fallback.mjs';

test('fallback uses two distinct structured facts and meets the 50-word floor', () => {
  const descriptions = buildMinimalRewriteDescriptions({
    facts: {
      venue: 'Teatro Civico',
      comune: 'Lugano',
      category: 'concerto',
    },
  });
  assert.ok(descriptions);
  assert.equal(meetsPoorSourceWordFloor(descriptions), true);
  for (const text of Object.values(descriptions)) assert.ok(wordCount(text) >= 50);
  assert.match(descriptions.it, /Teatro Civico/u);
  assert.match(descriptions.it, /Lugano/u);
});

test('fallback refuses a record without two distinct factual values', () => {
  assert.equal(buildMinimalRewriteDescriptions({ facts: { venue: 'Teatro Civico' } }), null);
  assert.equal(buildMinimalRewriteDescriptions({ facts: { venue: 'Teatro Civico', comune: 'Teatro Civico' } }), null);
});
