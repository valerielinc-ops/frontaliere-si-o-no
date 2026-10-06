import { describe, expect, it } from 'vitest';
import nidiBody from '../../packages/articles/content/blog-body/it/nidi-extrascolastico-ticino-un-servizio';

describe('residual SEO content accessibility fixes', () => {
  it('does not expose Markdown emphasis markers in the nidi article body', () => {
    const body = Object.values(nidiBody).join('\n');

    expect(body).toContain('> "La nuova lista d’attesa unica rappresenta un importante passo avanti nella gestione dei servizi per l’infanzia nel nostro cantone."');
    expect(body).not.toContain('_La nuova lista d’attesa unica rappresenta un importante passo avanti nella gestione dei servizi per l’infanzia nel nostro cantone_');
  });
});
