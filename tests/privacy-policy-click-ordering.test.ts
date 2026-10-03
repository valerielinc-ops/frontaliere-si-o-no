import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Gate sul testo legale: la privacy deve dichiarare l'uso dei clic sugli
 * annunci nelle email (ordine degli annunci) e non negarlo. Legge il sorgente
 * perche' la pagina e' solo italiana e non ha un test di rendering.
 */
const source = readFileSync(
  path.resolve(__dirname, '..', 'components', 'pages', 'PrivacyPolicy.tsx'),
  'utf-8',
);

describe('PrivacyPolicy: uso dei clic sugli annunci dichiarato', () => {
  it('contiene il paragrafo sull\'ordine degli annunci in base ai clic una sola volta', () => {
    expect(source.match(/Ordine degli annunci in base ai clic\./g)).toHaveLength(1);
    expect(source).toContain('cancellato automaticamente 180 giorni dopo l\'ultimo clic');
  });

  it('non nega piu\' la profilazione dei clic', () => {
    expect(source).not.toContain('Non profiliamo il contenuto dei clic');
  });

  it('richiama l\'ordine per clic nella sezione Profilazione e Decisioni Automatizzate', () => {
    expect(source).toContain('incluso l\'ordine degli annunci nelle email in base ai clic');
  });
});
