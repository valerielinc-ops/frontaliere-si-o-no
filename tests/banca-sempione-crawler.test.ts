import { describe, expect, it } from 'vitest';
import {
  inferLocation,
  shouldKeepBancaSempioneJob,
  wpContentToMarkdown,
} from '../scripts/update-banca-sempione-jobs.mjs';

describe('banca sempione crawler location guards', () => {
  it('classifies explicit Middle East roles as Dubai even if the body mentions Lugano headquarters', () => {
    const inferred = inferLocation(
      'Relationship Manager – Banca del Sempione (Middle East)',
      'Banca del Sempione is headquartered in Lugano and is looking for a profile focused on Dubai and the DIFC market.',
    );

    expect(inferred).toEqual({ location: 'Dubai', canton: '', country: 'AE' });
    expect(shouldKeepBancaSempioneJob(inferred)).toBe(false);
  });

  it('keeps Banca Sempione roles in any target Swiss canton (Lugano, Zurich, …)', () => {
    const zurich = inferLocation(
      'Private Banking Assistant',
      'The role is based in Zurich and supports the local office.',
    );
    const lugano = inferLocation(
      'Global Wealth Management – Consulente alla Clientela / Private Banker',
      'Role based in Lugano with client coverage in Ticino.',
    );

    // Banca Sempione has a Zurich office; cathedral CH-wide scope keeps it.
    expect(zurich).toEqual({ location: 'Zurich', canton: 'ZH' });
    expect(shouldKeepBancaSempioneJob(zurich)).toBe(true);
    expect(lugano).toEqual({ location: 'Lugano', canton: 'TI' });
    expect(shouldKeepBancaSempioneJob(lugano)).toBe(true);
  });
});

// Minimized from https://www.bancasempione.ch/wp-json/wp/v2/job (content.rendered of
// "Stage Amministrazione Crediti – Banca del Sempione (Lugano)", 2026-09-29).
const WP_CONTENT = `
<p class="wp-block-paragraph"><strong>Il ruolo:</strong></p>



<p class="wp-block-paragraph">Come stagista all&#8217;interno del nostro team Crediti, la persona inserita fornirà supporto alle attività amministrative e operative del Settore.</p>



<p class="wp-block-paragraph"><strong>Le responsabilità:</strong></p>



<ul class="wp-block-list">
<li>Supporto amministrativo alle attività del Settore Crediti;</li>



<li>Gestione, verifica e organizzazione della documentazione relativa alle pratiche di credito;</li>



<li>Supporto operativo al team nelle attività quotidiane e nei processi del Settore Crediti.</li>
</ul>



<p class="wp-block-paragraph"><strong>Modalità di candidatura</strong>: Inviare il CV e la lettera di motivazione in italiano cliccando sul pulsante &#8220;CANDIDATI&#8221;.</p>
`;

describe('banca sempione description (flat 6/6: 300-char flattened snippet)', () => {
  it('publishes the whole WordPress content with its bullet lists', () => {
    const md = wpContentToMarkdown(WP_CONTENT);
    expect(md).toBe([
      'Il ruolo:',
      '',
      'Come stagista all’interno del nostro team Crediti, la persona inserita fornirà supporto alle attività amministrative e operative del Settore.',
      '',
      'Le responsabilità:',
      '',
      '- Supporto amministrativo alle attività del Settore Crediti;',
      '- Gestione, verifica e organizzazione della documentazione relativa alle pratiche di credito;',
      '- Supporto operativo al team nelle attività quotidiane e nei processi del Settore Crediti.',
      '',
      'Modalità di candidatura: Inviare il CV e la lettera di motivazione in italiano cliccando sul pulsante “CANDIDATI”.',
    ].join('\n'));
    expect(md).not.toMatch(/…$|a Swiss private bank headquartered/);
  });

  it('classifies the Milan branch role as Italy, not as the Lugano headquarters', () => {
    const inferred = inferLocation(
      'Responsabile Compliance e AM – Banca del Sempione (Milano Branch)',
      'Il ruolo: Responsabile Compliance AML della costituenda branch di Banca del Sempione a Milano.',
    );
    expect(inferred).toEqual({ location: 'Milano', canton: '', country: 'IT' });
    expect(shouldKeepBancaSempioneJob(inferred)).toBe(false);
  });
});
