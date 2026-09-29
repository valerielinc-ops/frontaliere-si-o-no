import { describe, expect, it } from 'vitest';
import { groupeMutuelSourceContent } from '../scripts/lib/groupe-mutuel-job-parser.mjs';

// CSOD `externalDescription` of requisitions 4373 (German) and 4371 (French)
// on 2026-09-29: the whole text of the advertisement, over the shared 50-word
// floor.
const GERMAN = "Du berätst in Kranken-, Lebens-, Vermögens- und Unternehmensversicherung und bietest massgeschneiderte Lösungen für Kundenbedürfnisse Durch gezieltes Cross- und Upselling baust du vertrauensvolle Beziehungen auf und stärkst die Kundenbindung Die Gewinnung neuer Kundschaft – sei es durch Eigeninitiative oder Empfehlungen – gehört zu deinem Alltag Du organisierst und führst Beratungsgespräche, telefonisch oder persönlich, mit Engagement und Fingerspitzengefühl Auch die administrative Nachbearbeitung liegt in deinen Händen: Offerten erstellen, Termine verwalten und weitere\n• Aufgaben erledigst du präzise und effizient";
const FRENCH = "Tu conseilles les clients avec professionnalisme dans les domaines de l’assurance-maladie, de l’assurance-vie, du patrimoine et des solutions pour les entreprises Grâce au cross-selling et à l’upselling, tu développes des relations de confiance et contribues à renforcer leur fidélité L’acquisition de nouveaux clients, qu’elle vienne d’initiatives internes ou de recommandations, fait partie intégrante de ton quotidien Tu organises et réalises des rendez-vous, que ce soit au téléphone ou en présentiel, avec rigueur et sens du contact Tu assures également le suivi administratif : établissement d’offres, gestion des rendez-vous et autres tâches connexes, toujours avec précision";

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

  it('publishes nothing when the posting carries no text, or a text under the 50-word floor', () => {
    expect(groupeMutuelSourceContent({ title: 'Conseiller (h/f)', descriptionText: '  ' })).toBeNull();
    // The first sentence of 4371 alone is not a vacancy body.
    expect(groupeMutuelSourceContent({ title: 'Conseiller (h/f)', descriptionText: FRENCH.split(' Grâce')[0] })).toBeNull();
  });
});

describe('Groupe Mutuel stored jobs — the text the crawler used to write', () => {
  it('drops the company paragraph, the French stub and the translations made from them', async () => {
    const { GROUPE_MUTUEL_FABRICATED_DESCRIPTION_RE } = await import('../scripts/lib/groupe-mutuel-job-parser.mjs');
    const { dropFabricatedDescriptions } = await import('../scripts/lib/drop-fabricated-description.mjs');
    const paragraph = "Groupe Mutuel is one of Switzerland's leading insurance groups, headquartered in Martigny (Valais). The company offers a wide range of insurance and pension products for individuals and businesses across Switzerland.";
    const stored = {
      sourceLang: 'de',
      description: `${GERMAN}\n\n${paragraph}`,
      descriptionByLocale: {
        de: `${GERMAN}\n\n${paragraph}`,
        fr: 'Poste ouvert chez Groupe Mutuel à Martigny.\nRôle : Versicherungs- und Vorsorgeberater (m/w) 80-100%.',
      },
    };
    const clean = { sourceLang: 'fr', description: FRENCH, descriptionByLocale: { fr: FRENCH } };
    dropFabricatedDescriptions([stored, clean], GROUPE_MUTUEL_FABRICATED_DESCRIPTION_RE, 'Groupe Mutuel');
    expect(stored.descriptionByLocale).toEqual({});
    expect(stored.description).toBe('');
    expect(clean.descriptionByLocale).toEqual({ fr: FRENCH });
  });
});
