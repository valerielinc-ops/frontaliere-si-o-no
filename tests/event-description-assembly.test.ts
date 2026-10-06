import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemble } from '../scripts/assemble-events-dataset.mjs';
import {
  EVENT_DESCRIPTION_PROMPT_VERSION,
  EVENT_DESCRIPTION_REWRITE_MODEL,
  rewriteCacheKey,
  sourceDescriptionHash,
} from '../scripts/lib/event-description-policy.mjs';

describe('event description assembly boundary', () => {
  it('publishes only an exact rewrite-cache hit and keeps pending events factual-only', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'event-description-assembly-'));
    try {
      const sliceDir = path.join(root, 'data', 'events', 'by-source');
      const datasetPath = path.join(root, 'data', 'events.json');
      const cachePath = path.join(root, 'data', 'events-description-rewrites.json');
      const sourceEvent = {
        id: 'guidle:rewritten',
        title: 'Mostra civica',
        startDate: '2026-10-12',
        venue: 'Museo civico',
        comune: 'Lugano',
        canton: 'TI',
        url: 'https://example.test/rewritten',
        sourceKey: 'guidle',
        sourceName: 'Guidle',
        description: 'La mostra presenta opere locali nel museo civico durante la stagione autunnale.',
      };
      const pendingEvent = {
        ...sourceEvent,
        id: 'guidle:pending',
        url: 'https://example.test/pending',
      };
      const rewrittenHash = sourceDescriptionHash(sourceEvent)!;
      const pendingHash = sourceDescriptionHash(pendingEvent)!;
      const slice = { schemaVersion: 1, sourceKey: 'guidle', assembledAt: '2026-10-06T08:00:00.000Z', events: [sourceEvent, pendingEvent] };
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(path.join(sliceDir, 'guidle.json'), `${JSON.stringify(slice)}\n`);
      writeFileSync(cachePath, `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          [rewriteCacheKey(sourceEvent.id, rewrittenHash)]: {
            id: sourceEvent.id,
            sourceDescriptionHash: rewrittenHash,
            description: 'La mostra riunisce opere locali. L’appuntamento si tiene al museo civico.',
            descriptionByLocale: {
              it: 'La mostra riunisce opere locali. L’appuntamento si tiene al museo civico.',
              en: 'The exhibition brings together local works. The event takes place at the civic museum.',
              de: 'Die Ausstellung versammelt lokale Werke. Der Anlass findet im Stadtmuseum statt.',
              fr: 'L’exposition réunit des œuvres locales. Le rendez-vous a lieu au musée civique.',
            },
            model: EVENT_DESCRIPTION_REWRITE_MODEL,
            promptVersion: EVENT_DESCRIPTION_PROMPT_VERSION,
            rewrittenAt: '2026-10-06T08:00:00.000Z',
          },
        },
      }, null, 2)}\n`);

      const result = assemble({ sliceDir, datasetPath, rewriteCachePath: cachePath });
      const byId = new Map(result.events.map((event: any) => [event.id, event]));
      expect(byId.get(sourceEvent.id)).toMatchObject({
        description: 'La mostra riunisce opere locali. L’appuntamento si tiene al museo civico.',
        sourceDescriptionHash: rewrittenHash,
        descriptionRewriteValidated: true,
      });
      expect(byId.get(sourceEvent.id)?.descriptionByLocale?.en).toContain('exhibition');
      expect(byId.get(pendingEvent.id)?.description).toBeUndefined();
      expect(byId.get(pendingEvent.id)?.descriptionByLocale).toBeUndefined();
      expect(byId.get(pendingEvent.id)?.sourceDescriptionHash).toBe(pendingHash);
      const publicDataset = JSON.parse(readFileSync(path.join(root, 'public', 'data', 'events.json'), 'utf8'));
      expect(publicDataset.events.find((event: any) => event.id === pendingEvent.id)?.description).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
