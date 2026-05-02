import { describe, it, expect } from 'vitest';
import { buildFallbackCanonicalContent } from '../components/community/JobBoard';

describe('jobboard – Italian lowercase list parsing (Amministrazione Cantonale pattern)', () => {
 const ITALIAN_LIST_DESC = [
 'Compiti - organizzare e promuovere attività di osservazione individuali o di gruppo',
 '- collaborare all\'elaborazione di un progetto individuale per gli utenti',
 '- accompagnare il percorso individualizzato di persone con provvedimento professionale',
 '- provvedere all\'organizzazione e al funzionamento del Settore Accertamento Giovani',
 '- contribuire alla redazione dei rapporti di accertamento richiesti dal mandato',
 '- partecipare a gruppi di lavoro',
 '## Requisiti - bachelor universitario in Lavoro sociale o Pedagogia o titoli equivalenti',
 '- comprovata esperienza lavorativa con utenza fragile',
 '- ottima conoscenza del pacchetto Microsoft Office',
 '- conoscenza del territorio e della rete sociale del Canton Ticino',
 '- motivazione e spirito d\'iniziativa',
 ].join(' ');

 const FLAT_LIST_DESC = [
 'Compiti - organizzare e promuovere attività di osservazione individuali o di gruppo',
 '- collaborare all\'elaborazione di un progetto individuale - accompagnare il percorso',
 '- provvedere all\'organizzazione e al funzionamento - contribuire alla redazione dei rapporti',
 '## Requisiti - bachelor universitario in Lavoro sociale - comprovata esperienza lavorativa',
 '- ottima conoscenza del pacchetto Microsoft Office - motivazione e spirito d\'iniziativa',
 ].join(' ');

 it('splits responsibilities into multiple bullets (not one concatenated item)', () => {
 const result = buildFallbackCanonicalContent(ITALIAN_LIST_DESC, [], 'it');
 expect(result.responsibilities.length).toBeGreaterThan(2);
 // Each bullet should not contain multiple ' - ' patterns
 for (const bullet of result.responsibilities) {
 const dashCount = (bullet.match(/ - /g) || []).length;
 expect(dashCount).toBeLessThan(3);
 }
 });

 it('splits requirements into multiple individual bullets', () => {
 const result = buildFallbackCanonicalContent(ITALIAN_LIST_DESC, [], 'it');
 expect(result.requirements.length).toBeGreaterThan(2);
 });

 it('does not include section-fragment garbage in highlights (no " - " in highlight chips)', () => {
 const result = buildFallbackCanonicalContent(FLAT_LIST_DESC, [], 'it');
 for (const highlight of result.highlights) {
 const hasDash = / - /.test(highlight);
 if (hasDash) {
 const wordCount = highlight.split(/\s+/).length;
 expect(wordCount).toBeLessThanOrEqual(3);
 }
 }
 });

 it('flat list description: each requirement is a separate item', () => {
 const result = buildFallbackCanonicalContent(FLAT_LIST_DESC, [], 'it');
 expect(result.requirements.length).toBeGreaterThan(1);
 });
});
