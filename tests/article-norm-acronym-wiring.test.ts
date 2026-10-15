/**
 * Il cablaggio del gate, non la funzione.
 *
 * `assertNoFabricatedNormAcronyms()` ha i suoi test unitari in
 * tests/article-factuality-gates.test.ts, ma quelli passano identici anche se
 * NESSUN produttore la chiama. E' la stessa forma di lacuna documentata in
 * cima a tests/article-fabrication-generator-guard.test.ts per
 * `assertNoFabricatedReferences` (#4639): la funzione esisteva, e un percorso
 * su due non la invocava.
 *
 * Il difetto e' arrivato una seconda volta. Il gate e' stato cablato in
 * `publish-journalist-article.mjs` e lasciato fuori da `create-article.mjs`,
 * che e' il percorso di generazione AI. Li' `runFactualityGates()` copre
 * `content.it` ma gira PRIMA di `translateArticle()`, e dopo la traduzione
 * veniva chiamato solo il guard delle ISTITUZIONI (SECO/UFOL) — una famiglia
 * di pattern diversa. Una sigla normativa fabbricata sopravvive alla
 * traduzione invariata (LFW identica su it/en/de/fr in
 * `apprendistato-uri-2024-2025`, LCO in
 * `infiltrazioni-criminali-ticino-grigioni`), quindi un controllo solo-IT
 * pre-traduzione e' cieco proprio sul caso per cui il gate esiste.
 *
 * Perche' un file separato invece di aggiungerlo al guard gia' esistente:
 * quello importa `create-article.mjs`, che a module-scope tira dentro
 * `data/municipalities.ts` e `data/borderCrossings.ts`. Un test di cablaggio
 * che muore quando il modulo non e' importabile non e' un guard, e la
 * scansione del sorgente e' anche l'unico modo di verificare l'ORDINE delle
 * chiamate, che un import non mostra.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('assertNoFabricatedNormAcronyms — e cablata in ENTRAMBI i produttori, dopo la traduzione', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const produttori = ['scripts/create-article.mjs', 'scripts/publish-journalist-article.mjs'];

  for (const rel of produttori) {
    const src = readFileSync(join(root, rel), 'utf8');

    it(`${rel} importa assertNoFabricatedNormAcronyms`, () => {
      expect(
        /import\s*\{[^}]*\bassertNoFabricatedNormAcronyms\b[^}]*\}\s*from\s*['"][^'"]*article-factuality-gates\.mjs['"]/s.test(src),
        `${rel} non importa il gate: i suoi test unitari resterebbero verdi lo stesso`,
      ).toBe(true);
    });

    it(`${rel} la chiama su en/de/fr`, () => {
      expect(
        /assertNoFabricatedNormAcronyms\(\s*\{[^}]*\ben\b[^}]*\bde\b[^}]*\bfr\b[^}]*\}/s.test(src),
        `${rel} non controlla le traduzioni: una sigla fabbricata che sopravvive alla traduzione passa`,
      ).toBe(true);
    });

    it(`${rel} la chiama DOPO translateArticle(), non prima`, () => {
      // L'ordine e' il punto: chiamata prima della traduzione, `data.content.en`
      // non esiste ancora e `if (!content) continue` la salta in SILENZIO —
      // il gate risulterebbe cablato e non guarderebbe niente.
      const traduzione = src.search(/await\s+translateArticle\(/);
      const controllo = src.search(/assertNoFabricatedNormAcronyms\(\s*\{[^}]*\ben\b[^}]*\bde\b[^}]*\bfr\b[^}]*\}/s);
      expect(traduzione, `${rel}: nessuna chiamata await translateArticle()`).toBeGreaterThan(-1);
      expect(controllo, `${rel}: nessun controllo su en/de/fr`).toBeGreaterThan(-1);
      expect(controllo, `${rel}: il controllo su en/de/fr precede translateArticle(), quindi non vede niente`).toBeGreaterThan(traduzione);
    });
  }
});
