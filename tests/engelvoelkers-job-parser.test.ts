import { describe, expect, it } from 'vitest';
import {
  buildEngelvoelkersLocalizedContent,
  inferEngelvoelkersCanton,
  isEngelvoelkersSwissRelevant,
  parseEngelvoelkersDetailPage,
} from '../scripts/lib/engelvoelkers-job-parser.mjs';

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

// Lever posting of the Schaffhausen licensee, minimized from
// /ch/it/azienda/carriera/offerte-di-lavoro/d73b3b54-… (2026-09-29): the
// intro is `descriptionHtml`, the role is in `lists`, the note in `closingHtml`.
const leverPosting = (seniority: string, experience: string) => `<!DOCTYPE html>
<html lang="it"><head>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { data: { details: { posting: {
    text: `${seniority} Immobilienmakler/in 100%`,
    categories: { location: 'Schaffhausen, Switzerland', department: 'buutiq Immobilien AG' },
    content: {
      description: 'Engel & Völkers Schaffhausen\nEngel & Völkers ist ein weltweit führendes Dienstleistungsunternehmen in der Vermittlung von hochwertigen Immobilien.',
      descriptionHtml: '<div><strong style="font-size:10pt">Engel &amp; Völkers Schaffhausen</strong></div>\n<div><span style="font-size:10pt">Engel &amp; Völkers ist ein weltweit führendes Dienstleistungsunternehmen in der Vermittlung von hochwertigen Immobilien. Menschen und Immobilien sind uns eine Herzensangelegenheit.</span></div>',
      lists: [
        { text: 'Ihre Aufgaben', content: '<ul>\n<li>Akquise und Aufbau von Neukundenbeziehungen in Ihrem eigenen Farminggebiet.</li>\n<li>Durchführung von Objektbesichtigungen und Verkaufsverhandlungen.</li>\n</ul>' },
        { text: 'Ihr Profil', content: `<ul>\n<li>Sie sind bereits über ${experience} Jahre als Immobilienmakler/In tätig.</li>\n<li>Sie besitzen einen gültigen Führerausweis der Kategorie B.</li>\n</ul>` },
        { text: 'Unser Angebot', content: '<ul>\n<li>Festanstellung mit leistungsorientierter Provision.</li>\n</ul>' },
      ],
      closingHtml: '<div><span style="font-size:10pt">Wenn Sie ihren Verkaufserfolg selbst in die Hand nehmen möchten, freuen wir uns über Ihre Bewerbung.</span></div>',
    },
  } } } } },
})}</script>
</head><body><main><p>Menu principale</p></main></body></html>`;

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

  it('reads the Lever sections, not only the licensee intro, so two roles no longer share one body', () => {
    const senior = parseEngelvoelkersDetailPage(leverPosting('Senior', '5'), 'fallback');
    const junior = parseEngelvoelkersDetailPage(leverPosting('Junior', '2-5'), 'fallback');

    expect(senior.description).toContain('Engel & Völkers Schaffhausen');
    expect(senior.description).toContain('Ihre Aufgaben\n• Akquise und Aufbau von Neukundenbeziehungen in Ihrem eigenen Farminggebiet.');
    expect(senior.description).toContain('Ihr Profil\n• Sie sind bereits über 5 Jahre als Immobilienmakler/In tätig.');
    expect(senior.description).toContain('Unser Angebot\n• Festanstellung mit leistungsorientierter Provision.');
    expect(senior.description).toContain('freuen wir uns über Ihre Bewerbung.');
    expect(senior.description).not.toContain('Menu principale');
    expect(junior.description).toContain('über 2-5 Jahre');
    expect(junior.description).not.toBe(senior.description);
  });

  it('accepts Swiss licensee locations across cantons and rejects foreign locations', () => {
    expect(isEngelvoelkersSwissRelevant('Zürich, Switzerland')).toBe(true);
    expect(isEngelvoelkersSwissRelevant('Lugano, Switzerland')).toBe(true);
    expect(isEngelvoelkersSwissRelevant('Como, Italy')).toBe(false);
    expect(inferEngelvoelkersCanton('Zürich, Switzerland')).toBe('ZH');
    expect(inferEngelvoelkersCanton('Lugano, Switzerland')).toBe('TI');
  });

  it('localizes the derived canton without a fixed regional fallback', () => {
    const result = buildEngelvoelkersLocalizedContent({
      title: 'Immobilienberater/in',
      location: 'Zürich',
      canton: 'ZH',
      company: 'Engel & Völkers Zürich',
      description: 'Beratung und Verkauf hochwertiger Immobilien.',
    });

    expect(result.descriptionByLocale.it).toContain('Zurigo');
    expect(result.descriptionByLocale.it).toContain('Canton: ZH');
    expect(result.descriptionByLocale.it).not.toContain('Ticino');
  });
});
