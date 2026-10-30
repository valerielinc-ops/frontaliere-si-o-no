import { afterEach, describe, expect, it } from 'vitest';
import { updateJobTwitterCardMeta } from '../services/seo/jobTwitterCardMeta';

afterEach(() => {
  document.head.querySelectorAll('meta[name^="twitter:" i], meta[property^="twitter:" i]').forEach((meta) => meta.remove());
});

describe('job detail X card lifecycle', () => {
  it('updates all four fields and removes inherited duplicates across repeated navigations', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="TWITTER:title" content="old"><meta property="twitter:title" content="duplicate"><meta name="twitter:image" content="old">');
    const scriptsBefore = document.head.querySelectorAll('script').length;
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const card = { title: `Job ${locale} "><script>alert(1)</script>`, description: `Full metadata ${locale}`, image: `https://example.com/${locale}.webp` };
      updateJobTwitterCardMeta(card);
      updateJobTwitterCardMeta(card);
      expect(document.head.querySelectorAll('meta[name^="twitter:" i]')).toHaveLength(4);
      expect(document.head.querySelectorAll('meta[property^="twitter:" i]')).toHaveLength(0);
      for (const [field, value] of Object.entries({ card: 'summary_large_image', ...card })) {
        const metas = document.head.querySelectorAll(`meta[name="twitter:${field}"]`);
        expect(metas).toHaveLength(1);
        expect(metas[0].getAttribute('content')).toBe(value);
      }
      expect(document.head.querySelectorAll('script')).toHaveLength(scriptsBefore);
    }
  });
});
