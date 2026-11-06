// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HEAD_PREFIX, buildSimplePage } from '../../build-plugins/htmlTemplate';

describe('shared HTML Permissions-Policy', () => {
  it('allows same-origin geolocation while keeping camera and microphone disabled', () => {
    const page = buildSimplePage({
      locale: 'it',
      title: 'Farmacie',
      description: 'Elenco farmacie',
      canonicalUrl: 'https://frontaliereticino.ch/farmacie/',
      bodyHtml: '<p>Farmacie</p>',
    });

    expect(HEAD_PREFIX).toContain('camera=(), microphone=(), geolocation=(self)');
    expect(HEAD_PREFIX).not.toContain('geolocation=()');
    expect(page).toContain('content="camera=(), microphone=(), geolocation=(self)"');
  });
});
