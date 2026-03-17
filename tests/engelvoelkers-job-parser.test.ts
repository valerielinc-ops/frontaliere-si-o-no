import { describe, expect, it } from 'vitest';
import { parseEngelvoelkersDetailPage } from '../scripts/lib/engelvoelkers-job-parser.mjs';

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="it">
  <head>
    <title>Immobilienberater/in 100 % | Ascona</title>
    <meta name="description" content="Wir suchen dich für unser Team! Kurzer Meta-Teaser." />
    <meta property="og:title" content="Engel &amp; Völkers | Immobilienberater/in 100 % | Ascona" />
    <script id="__NEXT_DATA__" type="application/json">
      {
        "props": {
          "pageProps": {
            "data": {
              "details": {
                "posting": {
                  "text": "Immobilienberater/in 100 % | Ascona",
                  "categories": {
                    "location": "Ascona, Switzerland",
                    "team": "Sales & Key Account"
                  },
                  "content": {
                    "description": "Wir suchen dich für unser Team! Bist du fasziniert von der Immobilienwelt und möchtest Kundinnen und Kunden auf hohem Niveau begleiten?",
                    "descriptionHtml": "<div><b>Wir suchen dich für unser Team!</b></div><div><span>Bist du fasziniert von der Immobilienwelt, bringst Eigeninitiative mit und verstehst es, Menschen mit deiner dienstleistungsorientierten Art für dich zu gewinnen?</span></div><div><span>Dann schreibe deine eigene Erfolgsgeschichte mit uns und werde Teil einer einzigartigen Marke.</span></div><ul><li>Akquisition und Verkauf hochwertiger Immobilien</li><li>Beratung anspruchsvoller Kundschaft im Tessin</li></ul>"
                  }
                }
              }
            }
          }
        }
      }
    </script>
  </head>
  <body>
    <nav>
      <a>Trova gli immobili in vendita</a>
      <a>Trova gli immobili in affitto</a>
    </nav>
    <main>
      <p>Menu principale</p>
    </main>
  </body>
</html>`;

describe('Engel & Völkers parser', () => {
  it('extracts the vacancy title and rich description from __NEXT_DATA__ instead of navigation chrome', () => {
    const result = parseEngelvoelkersDetailPage(FIXTURE_HTML, 'fallback title');

    expect(result.title).toBe('Immobilienberater/in 100 % | Ascona');
    expect(result.description).toContain('Wir suchen dich für unser Team!');
    expect(result.description).toContain('Akquisition und Verkauf hochwertiger Immobilien');
    expect(result.description).toContain('Beratung anspruchsvoller Kundschaft im Tessin');
    expect(result.description).not.toContain('Trova gli immobili in vendita');
    expect(result.description.length).toBeGreaterThan(180);
  });
});
