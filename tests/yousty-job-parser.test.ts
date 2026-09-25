import { describe, expect, it } from 'vitest';
import { parseYoustyApprenticeshipHtml } from '@/scripts/lib/yousty-job-parser.mjs';

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
