import { describe, expect, it } from 'vitest';

import memeGermanBody from '../packages/articles/content/blog-body/de/mendrisio-melano-progetto-meme-risanamento-fonico';

describe('German MeMe article body', () => {
  it('keeps every published body section in German', () => {
    expect(memeGermanBody['blog.article.mendrisio-melano-progetto-meme-risanamento-fonico.body1'])
      .toContain('Kurz zusammengefasst');
    expect(memeGermanBody['blog.article.mendrisio-melano-progetto-meme-risanamento-fonico.body2'])
      .toContain('Auswirkungen auf den grenzüberschreitenden Pendelverkehr');
    expect(memeGermanBody['blog.article.mendrisio-melano-progetto-meme-risanamento-fonico.body3'])
      .toContain('Verkehrsmanagement und nächste Schritte');

    for (const key of Object.keys(memeGermanBody)) {
      expect(memeGermanBody[key], key).not.toContain('In breve');
      expect(memeGermanBody[key], key).not.toContain('Gestione del transito');
      expect(memeGermanBody[key], key).not.toContain('Implicazioni per il pendolarismo');
    }
  });
});
