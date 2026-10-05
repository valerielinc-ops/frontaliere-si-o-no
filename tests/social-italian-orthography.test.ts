import { describe, expect, it } from 'vitest';

import {
  buildCarouselCaption,
  buildCarouselSlideCopy,
  buildTikTokCaption,
} from '../scripts/lib/social-post-utils.mjs';
import {
  findUnaccentedItalianForms,
  UNACCENTED_ITALIAN_FORMS,
} from '../scripts/lib/italian-orthography.mjs';

const DAY_LABEL = '05/10/2026';
const KINDS = ['article', 'job', 'border'] as const;
const CAPTION_BUILDERS = [
  ['instagram', buildCarouselCaption],
  ['tiktok', buildTikTokCaption],
] as const;
const PICKS = [
  { title: 'Più opportunità nella Città di Lugano', statValue: '312 visualizzazioni' },
  { title: 'Perché scegliere questo lavoro', statValue: '210 visualizzazioni' },
];
const SLIDE_ITEMS = PICKS.map((pick) => ({
  ...pick,
  statLabel: 'Visualizzazioni',
  footerNote: 'Lugano',
}));

function slideText(copy: ReturnType<typeof buildCarouselSlideCopy>) {
  return [
    copy.kicker,
    copy.title,
    copy.subtitle,
    ...copy.items.flatMap((item) => [
      item.title,
      item.statLabel,
      item.statValue,
      item.footerNote,
    ]),
  ].filter(Boolean).join('\n');
}

describe('social Italian orthography', () => {
  it('checks captions and slide copy for every kind on both platforms', () => {
    const failures: Array<{ platform: string; kind: string; forms: string[] }> = [];

    for (const [platform, buildCaption] of CAPTION_BUILDERS) {
      for (const kind of KINDS) {
        const caption = buildCaption({ kind, dayLabel: DAY_LABEL, picks: PICKS });
        const slides = buildCarouselSlideCopy({
          kind,
          dayLabel: DAY_LABEL,
          items: SLIDE_ITEMS,
        });
        const forms = findUnaccentedItalianForms(caption + '\n' + slideText(slides));
        if (forms.length > 0) {
          failures.push({
            platform,
            kind,
            forms: forms.map((entry) => entry.form + ' → ' + entry.correct),
          });
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps the forbidden forms explicit and reusable', () => {
    const sample = UNACCENTED_ITALIAN_FORMS.map((entry) => entry.form).join(' ');
    expect(findUnaccentedItalianForms(sample).map((entry) => entry.form)).toEqual(
      UNACCENTED_ITALIAN_FORMS.map((entry) => entry.form),
    );
  });
});
