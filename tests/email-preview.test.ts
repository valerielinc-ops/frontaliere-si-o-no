import { describe, expect, it } from 'vitest';
import { renderEmailPreview } from '../functions/src/lib/emailPreview.js';
import { renderBrandedEmail } from '../functions/src/assistedApplicationEmailLayout.js';
import { buildWelcomeEmail } from '../functions/src/lib/welcomeEmailTemplate.js';

describe('readable email preview', () => {
  it('keeps untrusted copy as text and omits empty summaries', () => {
    expect(renderEmailPreview('   ')).toBe('');
    expect(renderEmailPreview(null)).toBe('');
    const html = renderEmailPreview('<img src=x> & "quoted"');
    expect(html).toContain('&lt;img src=x&gt; &amp; &quot;quoted&quot;');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/display:none|opacity:0|font-size:0|[\u200b\u200c\u034f]/);
  });

  it('preserves localized welcome summaries across every segment', () => {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      for (const segment of ['job', 'salary', 'utility', 'publisher', 'general']) {
        const { html, preheader } = buildWelcomeEmail({ locale, segment, unsubscribeUrl: 'https://example.invalid/unsubscribe/' });
        expect(html).toContain(renderEmailPreview(preheader));
        expect(html).not.toMatch(/display\s*:\s*none|font-size\s*:\s*0(?:px)?[;"']|[\u200b\u200c\u034f]/);
      }
    }
  });

  it('removes hidden copy and zero-font decoration from the shared assisted shell', () => {
    const html = renderBrandedEmail({ heroTitle: 'Aggiornamento', preheader: 'Riproveremo domani.', bodyHtml: '<p>Nessuna azione richiesta.</p>' });
    expect(html).toContain(renderEmailPreview('Riproveremo domani.'));
    expect(html).not.toMatch(/display\s*:\s*none|font-size\s*:\s*0(?:px)?[;"']|&#8203;/);
    expect(html).toContain('height:4px');
  });
});
