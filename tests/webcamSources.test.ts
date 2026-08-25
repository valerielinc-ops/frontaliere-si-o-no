/**
 * By-construction coverage check: every distinct `sourceUrl` referenced by a
 * `webcams` entry in data/borderCrossings.ts must have a matching entry in
 * the data/webcamSources.ts registry. A new webcam source added without a
 * registry entry breaks this test (issue #6347).
 */
import { describe, expect, it } from 'vitest';
import { borderCrossings } from '../data/borderCrossings';
import { WEBCAM_SOURCES } from '../data/webcamSources';

function distinctSourceUrls(): Set<string> {
 const urls = new Set<string>();
 for (const crossing of borderCrossings) {
  for (const webcam of crossing.webcams ?? []) {
   urls.add(webcam.sourceUrl);
  }
 }
 return urls;
}

describe('webcamSources registry', () => {
 it('is non-empty', () => {
  expect(WEBCAM_SOURCES.length).toBeGreaterThan(0);
 });

 it('has no duplicate officialUrl or id', () => {
  const urls = WEBCAM_SOURCES.map((s) => s.officialUrl);
  const ids = WEBCAM_SOURCES.map((s) => s.id);
  expect(new Set(urls).size).toBe(urls.length);
  expect(new Set(ids).size).toBe(ids.length);
 });

 it('covers every distinct sourceUrl used in borderCrossings.ts webcams', () => {
  const usedUrls = distinctSourceUrls();
  const registryUrls = new Set(WEBCAM_SOURCES.map((s) => s.officialUrl));

  const missing = [...usedUrls].filter((url) => !registryUrls.has(url));

  expect(missing).toEqual([]);
  expect(usedUrls.size).toBeGreaterThanOrEqual(14);
 });
});
