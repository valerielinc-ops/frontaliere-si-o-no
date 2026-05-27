import { describe, expect, it } from 'vitest';
import { extractLoginLocalizedPageData } from '../scripts/update-sbb-jobs.mjs';

describe('SBB login.org localization parser', () => {
  it('extracts the visible localized HTML instead of the wrong-language JSON-LD payload', () => {
    const html = `
      <html>
        <body>
          <h1 class="page-title">Impiegato/a del commercio al dettaglio AFC trasporti pubblici ,&nbsp;Chiasso</h1>
          <article class="node node--type-job">
            <div class="field field--name-field-profession-short-desc">
              <div class="field__item">
                <p class="text-lead">Ti piace scoprire il mondo, ami il contatto con le persone e sai convincere i clienti.</p>
                <p>Ti piace consigliare la clientela nazionale e internazionale e ami le lingue.</p>
              </div>
            </div>
            <div class="field field--name-field-job-umantis-ort field--type-entity-reference field--label-above flex mrgr+">
              <div class="field__label mrgr">Luogo:</div>
              <div class="flex align-baseline"><i class="icon icon-pin mrgr-"></i>Chiasso</div>
            </div>
            <div class="field field--name-field-profession-tasks field--type-text-long field--label-above">
              <div class="field__label h3">I tuoi compiti</div>
              <div class="field__item"><ul><li>Consigli la clientela</li></ul></div>
            </div>
            <div class="field field--name-field-profession-profile field--type-text-long field--label-above">
              <div class="field__label h3">Cosa porti con te</div>
              <div class="field__item"><ul><li>Orientamento al cliente</li></ul><p>Ti piace il contatto umano.</p></div>
            </div>
          </article>
          <script type="application/ld+json">
            {"@type":"JobPosting","description":"Du entdeckst gerne die Welt und liebst den Kontakt mit Menschen."}
          </script>
        </body>
      </html>
    `;

    const parsed = extractLoginLocalizedPageData(html);
    expect(parsed.title).toContain('Impiegato/a del commercio al dettaglio');
    expect(parsed.description).toContain('Ti piace scoprire il mondo');
    expect(parsed.description).not.toContain('Du entdeckst gerne die Welt');
    expect(parsed.description).toContain('## I tuoi compiti');
    expect(parsed.description).toContain('Consigli la clientela');
    expect(parsed.description).toContain('## Cosa porti con te');
    expect(parsed.location).toBe('Chiasso');
    expect(parsed.requirements).toEqual(['Orientamento al cliente']);
  });
});
