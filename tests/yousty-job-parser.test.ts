import { describe, expect, it } from 'vitest';
import { htmlFragmentToMarkdown, parseYoustyApprenticeshipHtml } from '@/scripts/lib/yousty-job-parser.mjs';

const SAMPLE_HTML = `
<!DOCTYPE html>
<html lang="de">
  <body>
    <div class="content-panel-new">
      <noscript>
        <h1>Lehrstelle bei Unione Farmaceutica Distribuzione SA in Lugano als Logistiker/in EFZ</h1>
        <h2>Lehrstellenbeschreibung</h2>
        <div>
          <p><strong>Sei interessato a svolgere un apprendistato come impiegato/a in logistica AFC? Evviva! 🥳</strong></p>
          <p>Galenica è il primo fornitore di servizi sanitari completamente integrato in Svizzera.</p>
          <p><strong>Cosa ti aspetta da noi 🎒</strong></p>
          <ul>
            <li>Imparerai a conoscere l'intero flusso delle merci</li>
            <li>Sarai sostenuto e incoraggiato dai nostri formatori pratici.</li>
          </ul>
          <p><strong>Cosa porti con te 🤙🏼</strong></p>
          <ul>
            <li>Ti piace il lavoro pratico e fisico</li>
          </ul>
        </div>
        <h2>Dein Arbeitsort</h2>
        <div>Via Figino 6, 6917 Lugano</div>
      </noscript>
    </div>
  </body>
</html>
`;

describe('parseYoustyApprenticeshipHtml', () => {
  it('extracts the real apprenticeship description from the noscript block', () => {
    const parsed = parseYoustyApprenticeshipHtml(SAMPLE_HTML, 'https://www.yousty.ch/de-CH/lehrstellen/profile/12692138');

    expect(parsed.description).toContain('Sei interessato a svolgere un apprendistato come impiegato/a in logistica AFC?');
    expect(parsed.description).toContain('Cosa ti aspetta da noi');
    expect(parsed.description).toContain('- Imparerai a conoscere l\'intero flusso delle merci');
    expect(parsed.description).toContain('- Ti piace il lavoro pratico e fisico');
    expect(parsed.description).not.toContain('Dein Arbeitsort');
  });

  it('uses the profile page as the apply URL', () => {
    const parsed = parseYoustyApprenticeshipHtml(SAMPLE_HTML, 'https://www.yousty.ch/de-CH/lehrstellen/profile/12692138');
    expect(parsed.applyUrl).toBe('https://www.yousty.ch/de-CH/lehrstellen/profile/12692138');
  });
});

describe('inline markup stays inside its sentence', () => {
  it('does not split <strong>/<b> runs into their own paragraphs', () => {
    // Solique benefit block and Yousty intro, as served (2026-09-29).
    expect(htmlFragmentToMarkdown('<b>5 Wochen Ferien</b>, mit der Möglichkeit bis zu 10 Ferientage zusätzlich zu kaufen'))
      .toBe('5 Wochen Ferien, mit der Möglichkeit bis zu 10 Ferientage zusätzlich zu kaufen');
    expect(htmlFragmentToMarkdown('<p><strong>Du interessierst dich für eine Lehrstelle? Juhui! </strong>🥳</p><ul><li><p>Du lernst den gesamten Warenfluss kennen</p></li></ul>'))
      .toBe('Du interessierst dich für eine Lehrstelle? Juhui! 🥳\n\n- Du lernst den gesamten Warenfluss kennen');
  });

  it('keeps <br> as a line break inside a paragraph', () => {
    expect(htmlFragmentToMarkdown('<b>Das grösste Apothekennetz</b><br/>Amavita ist ein Unternehmen im Galenica Netzwerk.'))
      .toBe('Das grösste Apothekennetz\nAmavita ist ein Unternehmen im Galenica Netzwerk.');
  });

  it('reads the French profile heading ("Description de l\'apprentissage")', () => {
    const html = `<noscript><h1>Places d’apprentissage chez Amavita à Le Lignon</h1><h2>Description de l&#39;apprentissage</h2><div><p>Nous offrons une place d’apprentissage variée et captivante de Assistant/e en pharmacie CFC.</p></div><h2>Ta façon de travailler</h2><div>Place du Lignon 19, 1219 Le Lignon</div></noscript>`;
    const parsed = parseYoustyApprenticeshipHtml(html, 'https://www.yousty.ch/fr-CH/places-d-apprentissage/profils/12692283');
    expect(parsed.description).toBe('Nous offrons une place d’apprentissage variée et captivante de Assistant/e en pharmacie CFC.');
  });
});
