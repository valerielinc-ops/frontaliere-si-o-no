import { describe, expect, it } from 'vitest';
import body from '../packages/articles/content/blog-body/de/mendrisio-melano-progetto-meme-risanamento-fonico';

const bodyText = Object.entries(body)
  .filter(([key]) => key.endsWith('.body1') || key.endsWith('.body2') || key.endsWith('.body3'))
  .map(([, value]) => value)
  .join('\n');

describe('Mendrisio-Melano German article body', () => {
  it('does not publish the Italian source text in the DE locale', () => {
    expect(bodyText).toContain('## Kurz zusammengefasst');
    expect(bodyText).toContain('## Auswirkungen auf den grenzüberschreitenden Pendelverkehr');
    expect(bodyText).toContain('## Verkehrsmanagement und nächste Schritte');
    expect(bodyText).not.toMatch(/## (In breve|Fatti chiave|Gestione del transito)/);
    expect(bodyText).not.toContain('Ufficio federale delle strade');
  });
});
