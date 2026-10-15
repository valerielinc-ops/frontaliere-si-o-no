/**
 * Stored records of the text these crawlers used to write themselves
 * (issue 5253). The builders no longer produce it, but each runner's merge
 * keeps stored locale slots, so every runner now drops that text from its
 * stored jobs right before the merge (`drop<Crawler>FabricatedText`, i.e.
 * `dropFabricatedDescription` with the crawler's old template).
 *
 * Fixtures: the old templates as the builders of origin/main wrote them
 * (2026-09-29), filled with a title and a place.
 */
import { describe, expect, it } from 'vitest';
import { dropHovalFabricatedText } from '../scripts/lib/hoval-job-parser.mjs';
import { dropKnowledgeLabFabricatedText } from '../scripts/lib/knowledge-lab-job-parser.mjs';
import { dropMticFabricatedText } from '../scripts/lib/mtic-job-parser.mjs';
import { dropTarchiniFabricatedText } from '../scripts/lib/tarchini-group-job-parser.mjs';
import { dropArtisaFabricatedText } from '../scripts/lib/artisa-job-parser.mjs';
import { dropPkbFabricatedText } from '../scripts/lib/pkb-private-bank-job-parser.mjs';
import { dropAlpiqFabricatedText } from '../scripts/lib/alpiq-job-parser.mjs';
import { dropJuliusBaerFabricatedText } from '../scripts/lib/julius-baer-job-parser.mjs';
import { dropSwissMedicalNetworkFabricatedText } from '../scripts/lib/swiss-medical-network-job-parser.mjs';
import { dropSwisscomFabricatedText } from '../scripts/lib/swisscom-job-parser.mjs';

type Fossil = {
  name: string;
  drop: (job: any) => boolean;
  sourceLang: string;
  slots: Record<string, string>;
  invented: RegExp;
};

const FOSSILS: Fossil[] = [
  {
    name: 'hoval',
    drop: dropHovalFabricatedText,
    sourceLang: 'de',
    slots: {
      it: "Hoval ha aperto una selezione per il ruolo Servicetechniker con sede a Vaduz. Soluzioni di riscaldamento e climatizzazione all'avanguardia. Per candidarti utilizza il modulo ufficiale nella pagina Hoval.",
      en: 'Hoval is hiring for the Servicetechniker role based in Vaduz. Leading heating and climate technology solutions. Apply through the official Hoval careers page.',
      de: 'Hoval sucht derzeit für die Position Servicetechniker am Standort Vaduz. Führende Heiz- und Klimatechniklösungen. Bewirb dich über die offizielle Karriereseite von Hoval.',
      fr: 'Hoval recrute actuellement pour le poste Servicetechniker basé à Vaduz. Solutions de chauffage et de climatisation de pointe. Postulez via la page carrière officielle de Hoval.',
    },
    invented: /Hoval (?:ha aperto|is hiring|sucht derzeit|recrute actuellement)/,
  },
  {
    name: 'knowledge-lab',
    drop: dropKnowledgeLabFabricatedText,
    sourceLang: 'it',
    slots: {
      it: 'Knowledge Lab cerca un/una Java Developer con sede a Manno. Soluzioni IT innovative per il settore bancario e assicurativo. Candidati tramite il portale ufficiale Knowledge Lab.',
      en: 'Knowledge Lab is hiring for the Java Developer role based in Manno. Innovative IT solutions for banking and insurance. Apply through the official Knowledge Lab careers page.',
      de: 'Knowledge Lab sucht derzeit für die Position Java Developer am Standort Manno. Innovative IT-Lösungen für Bank- und Versicherungswesen. Bewirb dich über die offizielle Karriereseite.',
      fr: "Knowledge Lab recrute actuellement pour le poste Java Developer basé à Manno. Solutions IT innovantes pour la banque et l'assurance. Postulez via le portail officiel.",
    },
    invented: /Knowledge Lab (?:cerca|is hiring|sucht derzeit|recrute actuellement)/,
  },
  {
    name: 'mtic',
    drop: dropMticFabricatedText,
    sourceLang: 'it',
    slots: {
      it: 'MTIC Group / SPS InterCert S.A. ricerca Ispettore con sede a Lugano. Certificazioni, ispezioni e prove nel settore tecnico. Candidati tramite il sito ufficiale MTIC Group.',
      en: 'MTIC Group / SPS InterCert S.A. is hiring for the Ispettore role based in Lugano. Certifications, inspections and testing in technical sectors. Apply through the official MTIC Group careers page.',
      de: 'MTIC Group / SPS InterCert S.A. sucht derzeit für die Position Ispettore am Standort Lugano. Zertifizierungen, Inspektionen und Prüfungen im technischen Bereich.',
      fr: 'MTIC Group / SPS InterCert S.A. recrute actuellement pour le poste Ispettore basé à Lugano. Certifications, inspections et essais dans les secteurs techniques.',
    },
    invented: /MTIC Group \/ SPS InterCert S\.A\. (?:ricerca|is hiring|sucht derzeit|recrute actuellement)/,
  },
  {
    name: 'tarchini-group',
    drop: dropTarchiniFabricatedText,
    sourceLang: 'it',
    slots: {
      it: 'Tarchini Group cerca un/una Custode con sede a Manno. Gruppo immobiliare attivo in Ticino nella progettazione, costruzione e gestione di stabili. Per candidarti invia il CV a risorseumane@tarchinigroup.com.',
      en: 'Tarchini Group is hiring for the Custode role in Manno, Ticino. Real estate group active in property development, construction and management.',
      de: 'Tarchini Group sucht derzeit für die Position Custode in Manno, Tessin. Immobiliengruppe in Planung, Bau und Verwaltung.',
      fr: 'Tarchini Group recrute pour le poste Custode à Manno, Tessin. Groupe immobilier actif dans la planification, construction et gestion.',
    },
    invented: /Tarchini Group (?:cerca|is hiring|sucht derzeit|recrute pour)/,
  },
  {
    name: 'artisa',
    drop: dropArtisaFabricatedText,
    sourceLang: 'it',
    slots: {
      it: "## Posizione aperta\nArtisa Group ha aperto una selezione per il ruolo Project Manager con base Lugano. La vacancy fa parte delle opportunità attive pubblicate nella pagina carriera del gruppo in Ticino.",
      en: "## Open position\nArtisa Group is currently hiring for the Project Manager role based in Lugano. This vacancy is part of the active opportunities published on the group's careers page for Southern Switzerland.",
      de: '## Offene Stelle\nArtisa Group rekrutiert derzeit für die Position Project Manager am Standort Lugano. Diese Stelle gehört zu den aktuell veröffentlichten Karrieremöglichkeiten der Gruppe in der Südschweiz.',
      fr: '## Poste ouvert\nArtisa Group recrute actuellement pour le poste Project Manager basé à Lugano. Cette offre fait partie des opportunités actives publiées sur la page carrière du groupe pour la Suisse italienne.',
    },
    invented: /Artisa Group (?:ha aperto|is currently hiring|rekrutiert derzeit|recrute actuellement)/,
  },
  {
    name: 'pkb-private-bank',
    drop: dropPkbFabricatedText,
    sourceLang: 'it',
    slots: {
      it: 'Posizione aperta presso PKB Private Bank SA a Lugano (TI). PKB è una banca privata svizzera indipendente fondata nel 1958, specializzata in gestione patrimoniale e private banking.',
      en: 'Open position at PKB Private Bank SA in Lugano (TI). PKB is an independent Swiss private bank founded in 1958.',
    },
    invented: /PKB Private Bank SA (?:a|in) Lugano/,
  },
  {
    name: 'alpiq',
    drop: dropAlpiqFabricatedText,
    sourceLang: 'it',
    slots: {
      it: 'Posizione aperta presso Alpiq (Olten). Alpiq è uno dei principali produttori di energia in Svizzera con attivita idroelettriche sul territorio nazionale.',
      de: 'Offene Stelle bei Alpiq (Olten). Alpiq ist einer der führenden Energieproduzenten der Schweiz.',
    },
    invented: /Alpiq \(Olten\)/,
  },
  {
    name: 'julius-baer',
    drop: dropJuliusBaerFabricatedText,
    sourceLang: 'en',
    slots: {
      en: 'Relationship Manager position at Julius Baer in Lugano, Switzerland.',
      it: 'Posizione aperta presso Julius Baer a Lugano.\nRuolo: Relationship Manager.\n\nJulius Baer è uno dei principali gruppi bancari privati svizzeri con sede a Zurigo.',
    },
    invented: /position at Julius Baer|Posizione aperta presso Julius Baer/,
  },
  {
    name: 'swiss-medical-network',
    drop: dropSwissMedicalNetworkFabricatedText,
    sourceLang: 'en',
    slots: {
      en: "Open position: Infirmier/ère at Swiss Medical Network in Genolier, Switzerland.\n\nSwiss Medical Network is Switzerland's leading private healthcare group, established in 2002.",
      it: 'Posizione aperta: Infermiere/a presso Swiss Medical Network a Genolier, Svizzera.\n\nSwiss Medical Network è il principale gruppo sanitario privato in Svizzera.',
    },
    invented: /(?:Open position|Posizione aperta): /,
  },
  {
    name: 'swisscom',
    drop: dropSwisscomFabricatedText,
    sourceLang: 'it',
    slots: {
      it: '# Specialista ICT\n\nPosizione aperta presso Swisscom a Bellinzona.',
      en: '# ICT Specialist\n\nOpen position at Swisscom in Bellinzona.',
    },
    invented: /Posizione aperta presso Swisscom|Open position at Swisscom/,
  },
];

describe.each(FOSSILS)('$name — stored text of the crawler removed before the merge', (fossil) => {
  it('leaves no invented entry in description or in any slot', () => {
    const job: any = {
      sourceLang: fossil.sourceLang,
      description: fossil.slots[fossil.sourceLang],
      descriptionByLocale: { ...fossil.slots },
    };

    expect(fossil.drop(job)).toBe(true);

    expect(job.description).not.toMatch(fossil.invented);
    for (const value of Object.values(job.descriptionByLocale)) expect(String(value)).not.toMatch(fossil.invented);
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a stored job with the posting text alone', () => {
    const text = 'Wir suchen eine engagierte Persönlichkeit, die unser Team mit Erfahrung und Freude an der Arbeit verstärkt.';
    const job: any = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Traduzione del testo.' } };

    expect(fossil.drop(job)).toBe(false);
    expect(job.descriptionByLocale).toEqual({ de: text, it: 'Traduzione del testo.' });
  });
});
