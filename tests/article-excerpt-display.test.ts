import { describe, expect, it } from 'vitest';

import { normalizeArticleExcerptPlain } from '@/build-plugins/shared/stripMarkdownPlain';

describe('normalizeArticleExcerptPlain', () => {
  it('leaves an already plain excerpt unchanged', () => {
    expect(normalizeArticleExcerptPlain('La notizia è stata confermata oggi.'))
      .toBe('La notizia è stata confermata oggi.');
  });

  it('removes headings, labels, lists, emphasis and links', () => {
    const raw = '## In breve - La **Pro Patria** vince.\n- [Leggi la fonte](https://example.test)';
    expect(normalizeArticleExcerptPlain(raw))
      .toBe('La Pro Patria vince. Leggi la fonte');
  });

  it('flattens a Markdown table instead of leaking pipes', () => {
    const raw = '| Evento | Esito |\n| --- | --- |\n| Gara | Vinta |';
    expect(normalizeArticleExcerptPlain(raw)).toBe('Evento Esito Gara Vinta');
  });
});
