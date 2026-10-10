import { describe, expect, it } from 'vitest';

import {
  INSTAGRAM_CREATIVE_FORMATS,
  INSTAGRAM_CREATIVE_IDS,
  INSTAGRAM_CREATIVE_VARIANTS,
  INSTAGRAM_MAX_CAPTION_LENGTH,
  buildInstagramCaption,
  chooseInstagramCreative,
  enrichInstagramCreativeLedgerEntry,
  instagramCreativeContent,
  instagramCreativeLedgerFields,
  instagramCreativeLedgerFieldsForId,
} from '../scripts/lib/instagram-creative.mjs';
import { buildCarouselSlidePlan } from '../scripts/lib/social-carousel-image.mjs';

const PICKS = [
  { title: 'Infermiere/a EOC', statValue: '312 visualizzazioni' },
  { title: 'Magazziniere Migros', statValue: '210 visualizzazioni' },
];

describe('Instagram creative system', () => {
  it('keeps every format complete for every content kind', () => {
    for (const format of Object.values(INSTAGRAM_CREATIVE_FORMATS)) {
      expect(format).toBeTruthy();
      expect(format.objective).toBeTruthy();
      expect(format.primaryMetric).toBeTruthy();
      expect(format.hookType).toBeTruthy();
      expect(format.attentionMechanic).toBeTruthy();
      expect(format.engagementLoop).toBeTruthy();
      expect(format.followUpFormat).toBeTruthy();
      for (const kind of ['job', 'article', 'border']) {
        expect(format.cover[kind].kicker).toBeTruthy();
        expect(format.cover[kind].title).toBeTruthy();
        expect(format.cta[kind]).toBeTruthy();
        expect(format.closing[kind].title).toBeTruthy();
      }
    }

    const isoDay = (offset: number) => new Date(Date.UTC(2026, 9, 9 + offset)).toISOString().slice(0, 10);
    const chosen = new Map(
      Array.from({ length: INSTAGRAM_CREATIVE_IDS.length }, (_, offset) => {
        const creative = chooseInstagramCreative({ kind: 'article', day: isoDay(offset) });
        return [creative.id, creative] as const;
      }),
    );
    expect(new Set(chosen.keys())).toEqual(new Set(INSTAGRAM_CREATIVE_IDS));
    for (const variant of INSTAGRAM_CREATIVE_VARIANTS) {
      const creative = chosen.get(variant.id)!;
      expect(creative).toMatchObject({
        id: variant.id,
        baseId: variant.baseId,
        variant: variant.variant,
      });
      expect(creative.cover.kicker).toBeTruthy();
      expect(creative.cover.title).toBeTruthy();
      expect(creative.cta).toBeTruthy();
      expect(creative.closing.title).toBeTruthy();
      expect(creative.hookType).toBeTruthy();
      expect(creative.attentionMechanic).toBeTruthy();
      expect(creative.engagementLoop).toBeTruthy();
      expect(creative.followUpFormat).toBeTruthy();
    }
  });

  it('rotates daily treatments and weekly border treatments', () => {
    const isoDay = (offset: number) => new Date(Date.UTC(2026, 9, 3 + offset)).toISOString().slice(0, 10);
    for (const kind of ['job', 'article', 'border']) {
      const days = kind === 'border' ? INSTAGRAM_CREATIVE_IDS.length * 7 : INSTAGRAM_CREATIVE_IDS.length;
      const ids = new Set(
        Array.from({ length: days }, (_, i) => chooseInstagramCreative({
          kind,
          day: isoDay(i),
        }).id),
      );
      expect(ids).toEqual(new Set(INSTAGRAM_CREATIVE_IDS));
    }
  });

  it('makes the 30-day coverage explicit for daily and weekly cohorts', () => {
    const start = Date.UTC(2026, 9, 1);
    const dailyCounts = new Map<string, Map<string, number>>();
    for (const kind of ['article', 'job']) {
      const counts = new Map<string, number>();
      for (let offset = 0; offset < 30; offset += 1) {
        const day = new Date(start + offset * 86400000).toISOString().slice(0, 10);
        const id = chooseInstagramCreative({ kind, day }).id;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      dailyCounts.set(kind, counts);
    }
    for (const counts of dailyCounts.values()) {
      expect(new Set(counts.keys())).toEqual(new Set(INSTAGRAM_CREATIVE_IDS));
      expect(Math.min(...counts.values())).toBeGreaterThanOrEqual(3);
    }

    const borderDays = INSTAGRAM_CREATIVE_IDS.length * 7;
    const borderIds = new Set(
      Array.from({ length: borderDays }, (_, offset) => {
        const day = new Date(start + offset * 86400000).toISOString().slice(0, 10);
        return chooseInstagramCreative({ kind: 'border', day }).id;
      }),
    );
    expect(borderIds).toEqual(new Set(INSTAGRAM_CREATIVE_IDS));
  });

  it('gives article and job posts different treatments on the same day', () => {
    const article = chooseInstagramCreative({ kind: 'article', day: '2026-10-09' });
    const job = chooseInstagramCreative({ kind: 'job', day: '2026-10-09' });
    expect(article.id).not.toBe(job.id);
  });

  it('fails safe to the proof treatment for malformed dates', () => {
    expect(chooseInstagramCreative({ kind: 'article', day: 'not-a-date' }).id).toBe('proof');
    expect(chooseInstagramCreative({ kind: 'article', day: '2026-02-30' }).id).toBe('proof');
    expect(chooseInstagramCreative({ kind: 'article', day: '2019-12-30' }).id).toBe('proof');
  });

  it('writes the intended interaction into the caption', () => {
    const creative = chooseInstagramCreative({ kind: 'article', day: '2026-10-09' });
    const caption = buildInstagramCaption({
      kind: 'article',
      dayLabel: '09/10/2026',
      picks: PICKS,
      creative,
    });
    expect(caption).toContain(PICKS[0].title);
    expect(caption).toContain(creative.cta);
    expect(caption).toContain('link in bio');
    expect(caption).not.toMatch(/https?:\/\//);
  });

  it('asks a real community question in the conversation treatment', () => {
    const creative = Array.from({ length: 14 }, (_, i) => chooseInstagramCreative({
      kind: 'article',
      day: `2026-10-${String(1 + i).padStart(2, '0')}`,
    })).find((candidate) => candidate.id === 'question')!;
    const caption = buildInstagramCaption({ kind: 'article', dayLabel: '11/10/2026', picks: PICKS, creative });
    expect(creative.objective).toBe('conversation');
    expect(caption).toContain('commenti');
    expect(caption).toContain(creative.question);
  });

  it('keeps extreme five-pick captions within Instagram’s limit', () => {
    const creative = chooseInstagramCreative({ kind: 'article', day: '2026-10-09' });
    const caption = buildInstagramCaption({
      kind: 'article',
      dayLabel: '09/10/2026',
      picks: Array.from({ length: 5 }, () => ({ title: 'Titolo '.repeat(300), statValue: 'Dato '.repeat(100) })),
      creative,
    });
    expect(caption.length).toBeLessThanOrEqual(INSTAGRAM_MAX_CAPTION_LENGTH);
    expect(caption).toContain('#frontalieri');
  });

  it('identifies the treatment in UTM content and the ledger', () => {
    const creative = chooseInstagramCreative({ kind: 'job', day: '2026-10-09' });
    expect(instagramCreativeContent(creative, 'job-123')).toBe(`${creative.id}-job-123`);
    expect(instagramCreativeLedgerFields(creative)).toEqual({
      creativeId: creative.id,
      creativeBaseId: creative.baseId,
      creativeVariant: creative.variant,
      creativeLabel: creative.label,
      creativeObjective: creative.objective,
      primaryMetric: creative.primaryMetric,
      engagementMechanic: 'keyword-comment',
      hookType: creative.hookType,
      attentionMechanic: creative.attentionMechanic,
      engagementLoop: creative.engagementLoop,
      followUpFormat: creative.followUpFormat,
    });
  });

  it('persists the CTA mechanism for every carousel objective', () => {
    const expectedMechanics = {
      shares: 'direct-share',
      saves: 'save-reminder',
      comments: 'keyword-comment',
    };
    for (const format of Object.values(INSTAGRAM_CREATIVE_FORMATS)) {
      expect(instagramCreativeLedgerFields(format).engagementMechanic)
        .toBe(expectedMechanics[format.primaryMetric]);
    }
  });

  it('recovers metadata only for known creative ids and preserves explicit fields', () => {
    expect(instagramCreativeLedgerFieldsForId('question-choice')).toMatchObject({
      creativeId: 'question-choice',
      creativeBaseId: 'question',
      creativeVariant: 'choice',
      engagementMechanic: 'keyword-comment',
      hookType: 'forced-choice',
      attentionMechanic: 'low-friction-choice',
      engagementLoop: 'comment-to-poll',
      followUpFormat: 'story-result',
    });
    expect(instagramCreativeLedgerFieldsForId('legacy-without-id')).toBeNull();

    expect(enrichInstagramCreativeLedgerEntry({
      id: 'card',
      kind: 'article',
      creativeId: 'question-story',
      primaryMetric: 'comments',
      hookType: 'editorial-override',
    })).toMatchObject({
      hookType: 'editorial-override',
      attentionMechanic: 'identity-story',
      engagementLoop: 'comment-to-story',
      followUpFormat: 'comment-reply',
      engagementMechanic: 'keyword-comment',
    });
    expect(enrichInstagramCreativeLedgerEntry({ id: 'old', kind: 'article' })).toEqual({ id: 'old', kind: 'article' });
    expect(enrichInstagramCreativeLedgerEntry({ id: 'reel', kind: 'reel', creativeId: 'reel-number' })).toEqual({
      id: 'reel', kind: 'reel', creativeId: 'reel-number',
    });
  });
});

describe('carousel closing CTA contract', () => {
  it('appends exactly one objective-specific CTA slide after the ranked items', () => {
    const plan = buildCarouselSlidePlan({
      kicker: 'PARLIAMONE',
      title: 'Che lavoro stai cercando?',
      subtitle: '09/10/2026',
      items: [...PICKS, { title: 'Tecnico di laboratorio', statValue: '120 visualizzazioni' }, { title: 'Infermiere/a', statValue: '90 visualizzazioni' }, { title: 'Autista', statValue: '80 visualizzazioni' }],
      closing: {
        kicker: 'TOCCA A TE',
        title: 'Raccontaci cosa stai cercando',
        body: 'La tua risposta orienta il prossimo contenuto.',
        cta: 'Rispondi nei commenti',
      },
    });
    expect(plan).toHaveLength(7);
    expect(plan[0]).toMatchObject({ type: 'cover', title: 'Che lavoro stai cercando?' });
    expect(plan.at(-1)).toMatchObject({ type: 'closing', cta: 'Rispondi nei commenti' });
  });

  it('keeps the legacy plan shape when no closing CTA is requested', () => {
    const plan = buildCarouselSlidePlan({ kicker: 'DATI', title: 'Classifica', items: PICKS });
    expect(plan).toHaveLength(3);
    expect(plan.at(-1)?.type).toBe('item');
  });
});
