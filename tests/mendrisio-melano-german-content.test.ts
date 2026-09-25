import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const bodySource = execFileSync(
  'git',
  [
    'show',
    'HEAD:packages/articles/content/blog-body/de/mendrisio-melano-progetto-meme-risanamento-fonico.ts',
  ],
  { encoding: 'utf8' },
);

describe('Mendrisio-Melano German article body', () => {
  it('does not publish the Italian source text in the DE locale', () => {
    expect(bodySource).toContain('## Kurz zusammengefasst');
    expect(bodySource).toContain('## Auswirkungen auf den grenzüberschreitenden Pendelverkehr');
    expect(bodySource).toContain('## Verkehrsmanagement und nächste Schritte');
    expect(bodySource).not.toMatch(/## (In breve|Fatti chiave|Gestione del transito)/);
    expect(bodySource).not.toContain('Ufficio federale delle strade');
  });
});
