import { describe, expect, it } from 'vitest';

import {
  INSTAGRAM_CREATIVE_FORMATS,
  INSTAGRAM_CREATIVE_IDS,
  INSTAGRAM_MAX_CAPTION_LENGTH,
  buildInstagramCaption,
  chooseInstagramCreative,
  instagramCreativeContent,
  instagramCreativeLedgerFields,
} from '../scripts/lib/instagram-creative.mjs';
import { buildCarouselSlidePlan } from '../scripts/lib/social-carousel-image.mjs';

const PICKS = [
  { title: 'Infermiere/a EOC', statValue: '312 visualizzazioni' },
  { title: 'Magazziniere Migros', statValue: '210 visualizzazioni' },
];

describe('Instagram creative system', () => {
  it('keeps every format complete for every content kind', () => {
    for (const id of INSTAGRAM_CREATIVE_IDS) {
      const format = INSTAGRAM_CREATIVE_FORMATS[id];
      expect(format.objective).toBeTruthy();
      expect(format.primaryMetric).toBeTruthy();
      for (const kind of ['job', 'article', 'border']) {
        expect(format.cover[kind].kicker).toBeTruthy();
        expect(format.cover[kind].title).toBeTruthy();
        expect(format.cta[kind]).toBeTruthy();
        expect(format.closing[kind].title).toBeTruthy();
      }
    }
  });

  it('rotates daily treatments and weekly border treatments', () => {
    for (const kind of ['job', 'article', 'border']) {
      const days = kind === 'border' ? 21 : 7;
      const ids = new Set(
        Array.from({ length: days }, (_, i) => chooseInstagramCreative({
          kind,
          day: `2026-10-${String(3 + i).padStart(2, '0')}`,
        }).id),
      );
      expect(ids).toEqual(new Set(INSTAGRAM_CREATIVE_IDS));
    }
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
      creativeLabel: creative.label,
      creativeObjective: creative.objective,
      primaryMetric: creative.primaryMetric,
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
