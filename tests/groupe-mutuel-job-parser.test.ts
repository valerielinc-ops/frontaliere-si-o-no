import { describe, expect, it } from 'vitest';
import { groupeMutuelSourceContent } from '../scripts/lib/groupe-mutuel-job-parser.mjs';

// CSOD `externalDescription` of requisitions 4373 (German) and 4371 (French)
// on 2026-09-29, shortened.
const GERMAN = 'Du berätst in Kranken-, Lebens-, Vermögens- und Unternehmensversicherung und bietest massgeschneiderte Lösungen für Kundenbedürfnisse. Durch gezieltes Cross- und Upselling baust du vertrauensvolle Beziehungen auf.';
const FRENCH = 'Tu conseilles les clients avec professionnalisme dans les domaines de l’assurance-maladie, de l’assurance-vie, du patrimoine et des solutions pour les entreprises. Grâce au cross-selling et à l’upselling, tu développes des relations de confiance.';

describe('Groupe Mutuel source content', () => {
  it('publishes only the advertisement, in the slot of its own language', () => {
    const german = groupeMutuelSourceContent({ title: 'Versicherungs- und Vorsorgeberater (m/w) 80-100%', descriptionText: GERMAN });
    const french = groupeMutuelSourceContent({ title: 'Conseiller en Assurances et Prévoyance (h/f) 80-100%', descriptionText: FRENCH });

    expect(german).toEqual({
      sourceLang: 'de',
      description: GERMAN,
      descriptionByLocale: { de: GERMAN },
      titleByLocale: { de: 'Versicherungs- und Vorsorgeberater (m/w) 80-100%' },
    });
    expect(french?.sourceLang).toBe('fr');
    expect(french?.descriptionByLocale).toEqual({ fr: FRENCH });
    for (const content of [german, french]) {
      expect(content?.description).not.toMatch(/Groupe Mutuel is one of Switzerland/);
      expect(content?.description).not.toMatch(/Poste ouvert chez Groupe Mutuel/);
    }
  });

  it('publishes nothing when the posting carries no text', () => {
    expect(groupeMutuelSourceContent({ title: 'Conseiller (h/f)', descriptionText: '  ' })).toBeNull();
  });
});
