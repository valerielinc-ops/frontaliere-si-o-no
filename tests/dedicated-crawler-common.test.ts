import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hardenJobLocaleFields, mergeAndDeduplicate, mergePreserveLocaleData, seedCrawlerSlicesFromDataJobs, addPreviousSlugForLocale, captureLostSlugs, hasFullLocaleCoverage, normalizeContract, mergeLocaleTextMap, pickMergedPostedDate, DEFAULT_PREV_SLUG_CAP, LEGACY_PREV_SLUGS_CAP } from '../scripts/lib/dedicated-crawler-common.mjs';
import { getEvents, clear as clearSlugHistoryJournal } from '../scripts/lib/slug-history-journal.mjs';

describe('normalizeContract — workload percentage-range classification (#3482)', () => {
  it('classifies a range title by its upper bound, not the first number found', () => {
    expect(normalizeContract('', '70% - 100%', '')).toBe('full-time');
    expect(normalizeContract('', 'IT-Support (m/w/d) 70% - 100%', '')).toBe('full-time');
    expect(normalizeContract('80% - 100%', '', '')).toBe('full-time');
  });

  it('still classifies a range whose upper bound stays below the full-time threshold as part-time', () => {
    expect(normalizeContract('', '40% - 60%', '')).toBe('part-time');
  });

  it('still classifies a single below-threshold percentage as part-time', () => {
    expect(normalizeContract('', 'Verkäufer 60%', '')).toBe('part-time');
  });

  it('still classifies a single at/above-threshold percentage as full-time', () => {
    expect(normalizeContract('', 'Verkäufer 100%', '')).toBe('full-time');
  });

  it('never lets a marketing percent in the NOISY description override an explicit title workload', () => {
    // Swiss ads routinely carry benefit/marketing figures ("100% Lohnfortzahlung",
    // "zu 95% weiterempfohlen") — a blanket max over the whole ad would flip an
    // explicit part-time title to full-time (local review of #3536).
    expect(normalizeContract('', 'Verkäufer 60%', 'Wir bieten 100% Lohnfortzahlung bei Krankheit')).toBe('part-time');
    expect(normalizeContract('', 'Pflegefachfrau 50-80%', 'Von Mitarbeitenden zu 95% weiterempfohlen')).toBe('part-time');
  });

  it('uses the description percent only when raw and title carry none', () => {
    expect(normalizeContract('', 'Sachbearbeiter Finanzen', 'Pensum: 60%')).toBe('part-time');
    expect(normalizeContract('', 'Sachbearbeiter Finanzen', 'Pensum: 60% - 100%')).toBe('full-time');
  });

  it('rawContract percent takes precedence over both title and description', () => {
    expect(normalizeContract('50%', 'Stellvertretung 100%', '')).toBe('part-time');
  });
});

describe('dedicated-crawler-common locale hardening', () => {
  it('flags wrong-language copied locales for retranslation without deleting (deploy has no AI)', () => {
    // hardenJobLocaleFields runs in the deploy pipeline where no AI is available.
    // Deleting wrong-language placeholders would leave locales empty and block the
    // deploy gate. Instead, we keep the value and set needsRetranslation=true so
    // the translate pipeline can retranslate with AI when quota is available.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'demo-job',
      title: 'Impiegato/a del commercio',
      description: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
      titleByLocale: {
        it: 'Impiegato/a del commercio',
        en: 'Impiegato/a del commercio',
        de: 'Impiegato/a del commercio',
        fr: 'Impiegato/a del commercio',
      },
      descriptionByLocale: {
        it: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
        en: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
        de: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
        fr: 'Ti piace scoprire il mondo e ami il contatto con le persone. Questa descrizione è chiaramente italiana e abbastanza lunga da attivare il detector.',
      },
      slugByLocale: {
        it: 'demo-job',
        en: 'demo-job',
        de: 'demo-job',
        fr: 'demo-job',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    const result = hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(result.changed).toBe(true);
    expect(after[0].sourceLang).toBe('it');
    // Source locale content is preserved correctly
    expect(after[0].descriptionByLocale.it).toContain('Ti piace scoprire il mondo');
    // Wrong-language copies are KEPT as placeholders (not deleted) to avoid empty locales.
    // The job is flagged for retranslation — the translate pipeline will fix it with AI.
    expect(after[0].descriptionByLocale.en).toBeDefined();
    expect(after[0].descriptionByLocale.de).toBeDefined();
    expect(after[0].descriptionByLocale.fr).toBeDefined();
    expect(after[0].needsRetranslation).toBe(true);
  });

  it('rehomes real titles stored under the wrong locale instead of keeping fake copies', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'quality-technician',
      title: 'Quality Technician (80-100%)',
      description: 'Posizione tecnica con responsabilita di qualita e supporto operativo. Questa descrizione e italiana e sufficientemente lunga da identificare la lingua sorgente in modo affidabile per il test.',
      titleByLocale: {
        it: 'Technicien Qualité (80-100%)',
      },
      descriptionByLocale: {
        it: 'Posizione tecnica con responsabilita di qualita e supporto operativo. Questa descrizione e italiana e sufficientemente lunga da identificare la lingua sorgente in modo affidabile per il test.',
      },
      slugByLocale: {
        it: 'quality-technician',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(after[0].titleByLocale.en).toBe('Quality Technician (80-100%)');
    expect(after[0].titleByLocale.fr).toBe('Technicien Qualité (80-100%)');
    expect(after[0].titleByLocale.it).toBe('Quality Technician (80-100%)');
  });

  it('rebuilds federal localized slugs when they still contain the raw German department placeholder', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'responsabile-sistemi-di-comando-e-informazione-swiss-armed-forces-vtg-rivera',
      title: 'Leiter/-in Führungs- und Informationssysteme',
      company: 'Swiss Armed Forces (VTG)',
      location: 'Rivera',
      description: 'Deutschsprachige Stellenbeschreibung mit ausreichend Inhalt, damit die Quellsprache fuer diesen VTG-Job stabil deutsch bleibt und nur die lokalisierten Slugs repariert werden muessen.',
      titleByLocale: {
        it: 'Responsabile Sistemi di Comando e Informazione',
        en: 'Head of Command and Information Systems',
        de: 'Leiter/-in Führungs- und Informationssysteme',
        fr: "Responsable Systèmes de Commandement et d'Information",
      },
      descriptionByLocale: {
        de: 'Deutschsprachige Stellenbeschreibung mit ausreichend Inhalt, damit die Quellsprache fuer diesen VTG-Job stabil deutsch bleibt und nur die lokalisierten Slugs repariert werden muessen.',
      },
      slugByLocale: {
        it: 'responsabile-sistemi-di-comando-e-informazione-swiss-armed-forces-vtg-rivera',
        en: 'head-of-command-and-information-systems-eidgenossisches-departement-fur-verteidigung-bevolkerungsschutz-und-sport-vbs-rivera',
        de: 'leiter-in-fuhrungs-und-informationssysteme-eidgenossisches-departement-fur-verteidigung-bevolkerungsschutz-und-sport-vbs-rivera',
        fr: 'chef-des-systemes-de-commandement-et-d-information-eidgenossisches-departement-fur-verteidigung-bevolkerungsschutz-und-sport-vbs-rivera',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    const result = hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(result.changed).toBe(true);
    expect(after[0].slugByLocale.en).toBe('head-of-command-and-information-systems-swiss-armed-forces-vtg-rivera');
    expect(after[0].slugByLocale.de).toBe('leiter-in-fuhrungs-und-informationssysteme-swiss-armed-forces-vtg-rivera');
    expect(after[0].slugByLocale.fr).toBe('responsable-systemes-de-commandement-et-d-information-swiss-armed-forces-vtg-rivera');
    expect(after[0].previousSlugs).toContain('head-of-command-and-information-systems-eidgenossisches-departement-fur-verteidigung-bevolkerungsschutz-und-sport-vbs-rivera');
    expect(after[0].previousSlugs).toContain('leiter-in-fuhrungs-und-informationssysteme-eidgenossisches-departement-fur-verteidigung-bevolkerungsschutz-und-sport-vbs-rivera');
    expect(after[0].previousSlugs).toContain('chef-des-systemes-de-commandement-et-d-information-eidgenossisches-departement-fur-verteidigung-bevolkerungsschutz-und-sport-vbs-rivera');
  });

  it('heuristically repairs italian titles and slugs when german or french source titles leak into locale fields', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [
      {
        slug: 'mitarbeiter-in-telemarketing',
        title: 'Mitarbeiter:in Telemarketing',
        company: 'AXA Svizzera',
        location: 'Winterthur',
        description: 'Komm zur AXA. Diese deutschsprachige Beschreibung ist bewusst lang genug, damit die Sprachenerkennung eine deutsche Quelle erkennt und die Heuristik fuer den italienischen Titel aktivieren kann.',
        titleByLocale: {
          de: 'Mitarbeiter:in Telemarketing',
          it: 'Mitarbeiter:in Telemarketing',
        },
        descriptionByLocale: {
          de: 'Komm zur AXA. Diese deutschsprachige Beschreibung ist bewusst lang genug, damit die Sprachenerkennung eine deutsche Quelle erkennt und die Heuristik fuer den italienischen Titel aktivieren kann.',
          it: 'Descrizione italiana gia disponibile per evitare che il test dipenda da una traduzione esterna. Questa frase e abbastanza lunga da mantenere il job stabile durante il repair.',
        },
        slugByLocale: {
          de: 'mitarbeiter-in-telemarketing-axa-svizzera-winterthur',
          it: 'mitarbeiter-in-telemarketing',
        },
      },
      {
        slug: 'vendeuse-vendeur-landi-cdd-d-avril-a-aout-2026-f-h-d-landi-rhone-lavaux-sa-saxon',
        title: "Vendeuse/vendeur LANDI - CDD d'avril à août 2026 (f/h/d)",
        company: 'LANDI Rhône-Lavaux SA',
        location: 'Saxon',
        description: "Description française suffisamment longue pour que la détection de langue identifie correctement une source FR et déclenche la réparation heuristique du titre et du slug italiens sur ce job de vente LANDI.",
        titleByLocale: {
          fr: "Vendeuse/vendeur LANDI - CDD d'avril à août 2026 (f/h/d)",
          it: "Vendeuse/vendeur LANDI - CDD d'avril à août 2026 (f/h/d)",
        },
        descriptionByLocale: {
          fr: "Description française suffisamment longue pour que la détection de langue identifie correctement une source FR et déclenche la réparation heuristique du titre et du slug italiens sur ce job de vente LANDI.",
          it: 'Descrizione italiana gia presente. Serve solo a mantenere il test stabile e ad evitare dipendenze da traduttori esterni durante il repair locale.',
        },
        slugByLocale: {
          fr: 'vendeuse-vendeur-landi-cdd-d-avril-a-aout-2026-f-h-d-landi-rhone-lavaux-sa-saxon',
          it: 'vendeuse-vendeur-landi-cdd-d-avril-a-aout-2026-f-h-d-landi-rhone-lavaux-sa-saxon',
        },
      },
    ];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(after[0].titleByLocale.it).toBe('Collaboratore/trice Telemarketing');
    expect(after[0].slugByLocale.it).toBe('collaboratore-trice-telemarketing-axa-svizzera-winterthur');
    expect(after[0].slug).toBe('collaboratore-trice-telemarketing-axa-svizzera-winterthur');

    expect(after[1].titleByLocale.it).toBe('Venditrice / Venditore LANDI - contratto a termine da aprile ad agosto 2026 (f/m/d)');
    // Gender trigraph is canonicalized to "m-w-d" in the slug to prevent churn
    // when the AI translator emits a different permutation (f/m/d → m/w/d here).
    expect(after[1].slugByLocale.it).toBe('venditrice-venditore-landi-contratto-a-termine-da-aprile-ad-agosto-2026-m-w-d-landi-rhone-lavaux-sa-saxon');
    expect(after[1].slug).toBe('venditrice-venditore-landi-contratto-a-termine-da-aprile-ad-agosto-2026-m-w-d-landi-rhone-lavaux-sa-saxon');
  });

  it('enriches thin italian descriptions with company boilerplate for recurring crawler outputs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'mechanical-simulation-engineer-agie-losone',
      title: 'Mechanical Simulation Engineer',
      company: 'AGIE Charmilles SA',
      location: 'Losone',
      description: 'Short source description kept on purpose to trigger the thin-description enrichment flow for recurring AGIE crawler outputs.',
      titleByLocale: {
        en: 'Mechanical Simulation Engineer',
        it: 'Ingegnere di simulazione meccanica',
      },
      descriptionByLocale: {
        it: 'AGIE Charmilles SA cerca Mechanical Simulation Engineer a Losone.',
      },
      slugByLocale: {
        it: 'ingegnere-di-simulazione-meccanica-agie-charmilles-sa-losone',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    const itDescription = after[0].descriptionByLocale.it;

    expect(itDescription.length).toBeGreaterThanOrEqual(300);
    expect(itDescription).toContain('AGIE Charmilles SA');
    expect(itDescription).toContain('Georg Fischer');
  });

  it('repairs remaining german and french italian slugs from recurring live regressions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [
      {
        slug: 'lehre-als-logistiker-in-efz-distribution-gemischte-zustellung-briefe-und-pakete-post-ch-ag-davos',
        title: 'Lehre als Logistiker:in EFZ Distribution gemischte Zustellung (Briefe und Pakete)',
        company: 'Post CH AG',
        location: 'Davos',
        description: 'Deutschsprachige Lehrstellenbeschreibung mit genügend Inhalt, damit die Heuristik auf der italienischen Seite denselben Job stabil umschreibt und den slug nicht deutsch belässt.',
        titleByLocale: {
          de: 'Lehre als Logistiker:in EFZ Distribution gemischte Zustellung (Briefe und Pakete)',
          it: 'Lehre als Logistiker:in EFZ Distribution gemischte Zustellung (Briefe und Pakete)',
        },
        descriptionByLocale: {
          de: 'Deutschsprachige Lehrstellenbeschreibung mit genügend Inhalt, damit die Heuristik auf der italienischen Seite denselben Job stabil umschreibt und den slug nicht deutsch belässt.',
          it: 'Descrizione italiana minima usata solo per evitare dipendenze esterne durante il repair locale. Il titolo e lo slug devono comunque essere ricostruiti in italiano.',
        },
        slugByLocale: {
          de: 'lehre-als-logistiker-in-efz-distribution-gemischte-zustellung-briefe-und-pakete-post-ch-ag-davos',
          it: 'lehre-als-logistiker-in-efz-distribution-gemischte-zustellung-briefe-und-pakete-post-ch-ag-davos',
        },
      },
      {
        slug: 'gerante-adjointe-gerant-adjoint-h-f-d-volg-anniviers',
        title: 'Gérante adjointe / gérant adjoint (h/f/d)',
        company: 'VOLG',
        location: 'Anniviers',
        description: 'Description française suffisamment longue pour conserver la source et déclencher la réparation heuristique du titre et du slug italiens sur cette offre VOLG.',
        titleByLocale: {
          fr: 'Gérante adjointe / gérant adjoint (h/f/d)',
          it: 'Gérante adjointe / gérant adjoint (h/f/d)',
        },
        descriptionByLocale: {
          fr: 'Description française suffisamment longue pour conserver la source et déclencher la réparation heuristique du titre et du slug italiens sur cette offre VOLG.',
          it: 'Descrizione italiana breve ma sufficiente per mantenere stabile il test mentre titolo e slug vengono corretti in modo locale.',
        },
        slugByLocale: {
          fr: 'gerante-adjointe-gerant-adjoint-h-f-d-volg-anniviers',
          it: 'gerante-adjointe-gerant-adjoint-h-f-d-volg-anniviers',
        },
      },
      {
        slug: 'projektleiter-in-installationen-oder-junior-projektleiter-in-100-elektro-saas-znl-der-tz-stromag-saas-fee',
        title: 'Projektleiter/in Installationen oder Junior Projektleiter/in (100%)',
        company: 'Elektro Saas, ZNL der TZ Stromag',
        location: 'Saas-Fee',
        description: 'Deutschsprachige Stellenbeschreibung mit genug Text, damit der italienische Titel und der italienische slug für diesen Burkhalter-Fall vollständig aus der Heuristik abgeleitet werden können.',
        titleByLocale: {
          de: 'Projektleiter/in Installationen oder Junior Projektleiter/in (100%)',
          it: 'Projektleiter/in Installationen oder Junior Projektleiter/in (100%)',
        },
        descriptionByLocale: {
          de: 'Deutschsprachige Stellenbeschreibung mit genug Text, damit der italienische Titel und der italienische slug für diesen Burkhalter-Fall vollständig aus der Heuristik abgeleitet werden können.',
          it: 'Descrizione italiana di supporto usata per mantenere il test autosufficiente mentre il titolo e lo slug vengono ricostruiti correttamente.',
        },
        slugByLocale: {
          de: 'projektleiter-in-installationen-oder-junior-projektleiter-in-100-elektro-saas-znl-der-tz-stromag-saas-fee',
          it: 'projektleiter-in-installationen-oder-junior-projektleiter-in-100-elektro-saas-znl-der-tz-stromag-saas-fee',
        },
      },
      {
        slug: 'nachwuchskader-verkauf-coop-mezzovico',
        title: 'Nachwuchskader Verkauf',
        company: 'Coop',
        location: 'Mezzovico',
        description: 'Deutschsprachige Coop-Beschreibung mit ausreichend Text, damit die italienische Heuristik auf dem bestehenden Datensatz greift und der slug nicht deutsch bleibt.',
        titleByLocale: {
          de: 'Nachwuchskader Verkauf',
          it: 'Nachwuchskader Verkauf',
        },
        descriptionByLocale: {
          de: 'Deutschsprachige Coop-Beschreibung mit ausreichend Text, damit die italienische Heuristik auf dem bestehenden Datensatz greift und der slug nicht deutsch bleibt.',
          it: 'Descrizione italiana di servizio usata solo per mantenere il test indipendente da traduttori esterni.',
        },
        slugByLocale: {
          de: 'nachwuchskader-verkauf-coop-mezzovico',
          it: 'nachwuchskader-verkauf-coop-mezzovico',
        },
      },
      {
        slug: 'vendeuse-vendeur-f-m-d-volg-vissoie',
        title: 'vendeuse / vendeur (h/f/d)',
        company: 'VOLG',
        location: 'Vissoie',
        description: 'Description française assez longue pour que la réparation heuristique du titre italien soit déclenchée même lorsque le titre contient des espaces autour de la barre.',
        titleByLocale: {
          fr: 'vendeuse / vendeur (h/f/d)',
          it: 'vendeuse / vendeur (f/m/d)',
        },
        descriptionByLocale: {
          fr: 'Description française assez longue pour que la réparation heuristique du titre italien soit déclenchée même lorsque le titre contient des espaces autour de la barre.',
          it: 'Descrizione italiana breve usata solo come appoggio per il test locale.',
        },
        slugByLocale: {
          fr: 'vendeuse-vendeur-h-f-d-volg-vissoie',
          it: 'vendeuse-vendeur-f-m-d-volg-vissoie',
        },
      },
    ];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(after[0].titleByLocale.it).toBe('Apprendistato come impiegata/impiegato in logistica CFC Distribuzione recapito misto (lettere e pacchi)');
    expect(after[0].slugByLocale.it).toBe('apprendistato-come-impiegata-impiegato-in-logistica-cfc-distribuzione-recapito-misto-lettere-e-pacchi-post-ch-ag-davos');
    expect(after[0].slug).toBe('apprendistato-come-impiegata-impiegato-in-logistica-cfc-distribuzione-recapito-misto-lettere-e-pacchi-post-ch-ag-davos');

    expect(after[1].titleByLocale.it).toBe('Vicegerente / Gerente aggiunto/a (f/m/d)');
    // Gender trigraph canonicalized to "m-w-d" in slug (stable across translator runs).
    expect(after[1].slugByLocale.it).toBe('vicegerente-gerente-aggiunto-a-m-w-d-volg-anniviers');
    expect(after[1].slug).toBe('vicegerente-gerente-aggiunto-a-m-w-d-volg-anniviers');

    expect(after[2].titleByLocale.it).toBe('Responsabile di progetto installazioni o Junior responsabile di progetto (100%)');
    expect(after[2].slugByLocale.it).toBe('responsabile-di-progetto-installazioni-o-junior-responsabile-di-progetto-100-elektro-saas-znl-der-tz-stromag-saas-fee');
    expect(after[2].slug).toBe('responsabile-di-progetto-installazioni-o-junior-responsabile-di-progetto-100-elektro-saas-znl-der-tz-stromag-saas-fee');

    expect(after[3].titleByLocale.it).toBe('Responsabile junior vendita');
    expect(after[3].slugByLocale.it).toBe('responsabile-junior-vendita-coop-mezzovico');
    expect(after[3].slug).toBe('responsabile-junior-vendita-coop-mezzovico');

    expect(after[4].titleByLocale.it).toBe('Venditrice / Venditore (f/m/d)');
    // Gender trigraph canonicalized to "m-w-d" in slug (stable across translator runs).
    expect(after[4].slugByLocale.it).toBe('venditrice-venditore-m-w-d-volg-vissoie');
    expect(after[4].slug).toBe('venditrice-venditore-m-w-d-volg-vissoie');
  });

  it('enriches thin italian descriptions and localizes german real-estate roles for ticino premium properties', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [{
      slug: 'engel-volkers-immobilienberater-in-100-ascona-ticino-premium-properties-sa-ascona',
      title: 'Engel & Völkers | Immobilienberater/in 100 % | Ascona',
      company: 'Ticino Premium Properties SA',
      location: 'Ascona',
      description: 'Deutschsprachige Immobilienbeschreibung mit ausreichend Text, damit die italienische Lokalisierung aus der Heuristik erfolgt und gleichzeitig die dünne Beschreibung mit Boilerplate ergänzt wird.',
      titleByLocale: {
        de: 'Engel & Völkers | Immobilienberater/in 100 % | Ascona',
        it: 'Engel & Völkers | Immobilienberater/in 100 % | Ascona',
      },
      descriptionByLocale: {
        de: 'Deutschsprachige Immobilienbeschreibung mit ausreichend Text, damit die italienische Lokalisierung aus der Heuristik erfolgt und gleichzeitig die dünne Beschreibung mit Boilerplate ergänzt wird.',
        it: 'Engel & Völkers cerca una figura commerciale ad Ascona.',
      },
      slugByLocale: {
        de: 'engel-volkers-immobilienberater-in-100-ascona-ticino-premium-properties-sa-ascona',
        it: 'engel-volkers-immobilienberater-in-100-ascona-ticino-premium-properties-sa-ascona',
      },
    }];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
    const itDescription = after[0].descriptionByLocale.it;

    expect(after[0].titleByLocale.it).toBe('Engel & Völkers | Consulente immobiliare 100 % | Ascona');
    expect(after[0].slugByLocale.it).toBe('engel-volkers-consulente-immobiliare-100-ascona-ticino-premium-properties-sa-ascona');
    expect(itDescription.length).toBeGreaterThanOrEqual(300);
    expect(itDescription).toContain('Ticino Premium Properties SA');
  });

  it('repairs recurring VTG and Hamilton italian slug regressions from localized titles', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-hardening-'));
    const jobsPath = path.join(tempDir, 'jobs.json');
    const jobs = [
      {
        slug: 'lernende-r-strassentransportfachmann-frau-cfc-swiss-armed-forces-vtg-claro-ti',
        title: 'Lernende/-r Strassentransportfachmann/-frau EFZ',
        company: 'Swiss Armed Forces (VTG)',
        location: 'Claro (TI)',
        description: 'Deutschsprachige Stellenbeschreibung mit ausreichend Inhalt, damit die italienische Reparatur fuer diesen VTG-Lehrberuf ohne externe Uebersetzung reproduzierbar getestet werden kann.',
        titleByLocale: {
          de: 'Lernende/-r Strassentransportfachmann/-frau EFZ',
          it: 'Lernende/-r Strassentransportfachmann/-frau CFC',
        },
        descriptionByLocale: {
          de: 'Deutschsprachige Stellenbeschreibung mit ausreichend Inhalt, damit die italienische Reparatur fuer diesen VTG-Lehrberuf ohne externe Uebersetzung reproduzierbar getestet werden kann.',
          it: 'Descrizione italiana di supporto usata solo per mantenere stabile il test locale durante la riparazione del titolo e dello slug.',
        },
        slugByLocale: {
          de: 'lernende-r-strassentransportfachmann-frau-efz-swiss-armed-forces-vtg-claro-ti',
          it: 'lernende-r-strassentransportfachmann-frau-cfc-swiss-armed-forces-vtg-claro-ti',
        },
      },
      {
        slug: 'entwickler-fur-crm-systeme-80-100-m-w-d-hamilton-bonaduz-ag-bonaduz',
        title: 'ICT Developer CRM 80 - 100 % (w/m/d)',
        company: 'Hamilton Bonaduz AG',
        location: 'Bonaduz',
        description: 'Deutschsprachige Hamilton-Beschreibung mit genug Text, damit der Source-Lang deutsch bleibt, waehrend der eigentliche Jobtitel englisch ist und die italienische Reparatur deterministisch erfolgen muss.',
        titleByLocale: {
          en: 'ICT Developer CRM 80 - 100 % (w/m/d)',
          de: 'IKT-Entwickler CRM 80 - 100 % (w/m/d)',
          it: 'Entwickler für CRM-Systeme (80 - 100 %) (m/w/d)',
        },
        descriptionByLocale: {
          de: 'Deutschsprachige Hamilton-Beschreibung mit genug Text, damit der Source-Lang deutsch bleibt, waehrend der eigentliche Jobtitel englisch ist und die italienische Reparatur deterministisch erfolgen muss.',
          it: 'Descrizione italiana di supporto usata solo per mantenere stabile il test locale mentre titolo e slug vengono ricostruiti.',
        },
        slugByLocale: {
          en: 'ict-developer-crm-80-100-w-m-d-hamilton-bonaduz-ag-bonaduz',
          de: 'ikt-entwickler-crm-80-100-w-m-d-hamilton-bonaduz-ag-bonaduz',
          it: 'entwickler-fur-crm-systeme-80-100-m-w-d-hamilton-bonaduz-ag-bonaduz',
        },
      },
    ];
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');

    hardenJobLocaleFields({ dataJobsPath: jobsPath });
    const after = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

    expect(after[0].titleByLocale.it).toBe('Apprendista Specialista in trasporti stradali CFC');
    expect(after[0].slugByLocale.it).toBe('apprendista-specialista-in-trasporti-stradali-cfc-swiss-armed-forces-vtg-claro-ti');
    expect(after[0].slug).toBe('apprendista-specialista-in-trasporti-stradali-cfc-swiss-armed-forces-vtg-claro-ti');

    expect(after[1].titleByLocale.it).toBe('Sviluppatore/trice ICT CRM 80 - 100 % (w/m/d)');
    // Note: gender trigraph is canonicalized to "m-w-d" in the slug even when the
    // title retains the original "(w/m/d)" form. This prevents slug churn when the
    // AI translator swaps between trigraph permutations across runs.
    expect(after[1].slugByLocale.it).toBe('sviluppatore-trice-ict-crm-80-100-m-w-d-hamilton-bonaduz-ag-bonaduz');
    expect(after[1].slug).toBe('sviluppatore-trice-ict-crm-80-100-m-w-d-hamilton-bonaduz-ag-bonaduz');
  });
});

describe('mergePreserveLocaleData URL matching', () => {
  it('matches URLs with &amp; vs & encoding differences', async () => {
    const { mergePreserveLocaleData } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const existing = [{
      url: 'https://careers.orior.ch/job/Stabio-Buyer-ingredienti-&-trade%2C-100-TI/1375846633/',
      title: 'Buyer ingredienti & trade, 100%',
      titleByLocale: {
        it: 'Ingredienti d\'acquisto e commercio, 100%',
        en: 'Buyer ingredienti & trade, 100%',
        de: 'Einkäufer Zutaten & Handel, 100%',
        fr: 'Acheteur Ingrédients & Commerce, 100%',
      },
      slugByLocale: {
        it: 'buyer-ingredienti-trade-100-rapelli-stabio',
        en: 'buyer-ingredienti-trade-100-rapelli-stabio',
        de: 'einkaufer-zutaten-handel-100-rapelli-stabio',
        fr: 'acheteur-ingredients-commerce-100-rapelli-stabio',
      },
    }];

    const fresh = [{
      url: 'https://careers.orior.ch/job/Stabio-Buyer-ingredienti-&amp;-trade%2C-100-TI/1375846633/',
      title: 'Buyer ingredienti & trade, 100%',
      titleByLocale: { it: 'Buyer ingredienti & trade, 100%' },
      slugByLocale: { it: 'buyer-ingredienti-trade-100-rapelli-stabio' },
    }];

    const merged = mergePreserveLocaleData(existing, fresh);
    expect(merged).toHaveLength(1);
    // DE/FR translations must be preserved from existing
    expect(merged[0].titleByLocale.de).toBe('Einkäufer Zutaten & Handel, 100%');
    expect(merged[0].titleByLocale.fr).toBe('Acheteur Ingrédients & Commerce, 100%');
    expect(merged[0].slugByLocale.de).toBe('einkaufer-zutaten-handel-100-rapelli-stabio');
    expect(merged[0].slugByLocale.fr).toBe('acheteur-ingredients-commerce-100-rapelli-stabio');
  });

  it('preserves translations when fresh job only has source locale', async () => {
    const { mergePreserveLocaleData } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const existing = [{
      url: 'https://example.com/job/123',
      title: 'Product Manager',
      titleByLocale: {
        it: 'Responsabile del prodotto',
        en: 'Product Manager',
        de: 'Produktmanager',
        fr: 'Chef de produit',
      },
      slugByLocale: {
        it: 'responsabile-del-prodotto-example-zurich',
        en: 'product-manager-example-zurich',
        de: 'produktmanager-example-zurich',
        fr: 'chef-de-produit-example-zurich',
      },
    }];

    const fresh = [{
      url: 'https://example.com/job/123',
      title: 'Product Manager',
      titleByLocale: { it: 'Product Manager' },
      slugByLocale: { it: 'product-manager-example-zurich' },
    }];

    const merged = mergePreserveLocaleData(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].titleByLocale.de).toBe('Produktmanager');
    expect(merged[0].titleByLocale.fr).toBe('Chef de produit');
    expect(merged[0].slugByLocale.de).toBe('produktmanager-example-zurich');
    expect(merged[0].slugByLocale.fr).toBe('chef-de-produit-example-zurich');
  });

  it('skips the bridge for a colliding (non-injective) matchKey instead of cross-contaminating', async () => {
    const { mergePreserveLocaleData } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    // Two distinct postings that collapse to the same slug bridge key (the
    // Geberit `…-geberit-ch` + `…-geberit-ch-2` collision pair). Each fresh job
    // emits the RAW slug (no `-2` suffix) → identical matchKey. Binding both to
    // one old record would duplicate `old.id` and cross-contaminate previousSlugs
    // / translations onto the wrong job. The guard must let them re-index fresh.
    const existing = [
      {
        id: 'geberit-OLD-A',
        slug: 'talent-for-sales-management-a-100-geberit-ch',
        url: 'https://jobs.geberit.com/job/X/1363323000/',
        title: 'Talent for Sales Management a 100%',
        previousSlugs: ['old-bridge-a'],
        titleByLocale: { it: 'Talento Vendite A', de: 'Verkaufstalent A' },
      },
      {
        id: 'geberit-OLD-B',
        slug: 'talent-for-sales-management-a-100-geberit-ch-2',
        url: 'https://jobs.geberit.com/job/Y/1363323999/',
        title: 'Talent for Sales Management a 100%',
        previousSlugs: ['old-bridge-b'],
        titleByLocale: { it: 'Talento Vendite B', de: 'Verkaufstalent B' },
      },
    ];

    const fresh = [
      {
        id: 'geberit-1799',
        slug: 'talent-for-sales-management-a-100-geberit-ch',
        url: 'https://jobs.geberit.com/job-invite/1799/',
        title: 'Talent for Sales Management a 100%',
        titleByLocale: { de: 'Verkaufstalent A' },
        sourceLang: 'de',
      },
      {
        id: 'geberit-1800',
        slug: 'talent-for-sales-management-a-100-geberit-ch',
        url: 'https://jobs.geberit.com/job-invite/1800/',
        title: 'Talent for Sales Management a 100%',
        titleByLocale: { de: 'Verkaufstalent B' },
        sourceLang: 'de',
      },
    ];

    const matchKey = (job: { slug?: string }) =>
      String(job?.slug || '').trim().toLowerCase();
    const merged = mergePreserveLocaleData(existing, fresh, { matchKey });

    // Both fresh kept with their own distinct ids — no inheritance from a single
    // old, no duplicate id, no cross-contaminated previousSlugs. `geberit-OLD-B`
    // has its own unique (non-colliding) key and no fresh job matched it this
    // run, so the grace-period guard retains it as-is (own previousSlugs are
    // fine here — that's B's own history, not contamination from A).
    expect(merged).toHaveLength(3);
    const freshJobs = merged.filter((j) => j.id !== 'geberit-OLD-B');
    const ids = freshJobs.map((j) => j.id).sort();
    expect(ids).toEqual(['geberit-1799', 'geberit-1800']);
    expect(new Set(ids).size).toBe(2);
    for (const job of freshJobs) {
      expect(job.previousSlugs ?? []).not.toContain('old-bridge-a');
      expect(job.previousSlugs ?? []).not.toContain('old-bridge-b');
    }

    const retainedB = merged.find((j) => j.id === 'geberit-OLD-B');
    expect(retainedB).toBeDefined();
    expect(retainedB.previousSlugs).toEqual(['old-bridge-b']);
    expect(retainedB.crawlerMissStreak).toBe(1);
  });
});

describe('mergePreserveLocaleData grace-period retention (silent job loss guard)', () => {
  it('retains a job missing from a single run instead of dropping it immediately', async () => {
    const { mergePreserveLocaleData } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    const existing = [
      { id: 'still-open', url: 'https://example.com/job/still-open', title: 'Still Open Role' },
      { id: 'shows-up', url: 'https://example.com/job/shows-up', title: 'Shows Up Role' },
    ];
    // Simulates a pagination fail-soft: only job "shows-up" was captured on
    // this run; "still-open" is genuinely still live but got missed.
    const fresh = [
      { url: 'https://example.com/job/shows-up', title: 'Shows Up Role' },
    ];

    const merged = mergePreserveLocaleData(existing, fresh);
    expect(merged).toHaveLength(2);
    const retained = merged.find((j) => j.id === 'still-open');
    expect(retained).toBeDefined();
    expect(retained.crawlerMissStreak).toBe(1);
  });

  it('drops a job only after it has been missing for more consecutive runs than the grace period allows', async () => {
    const { mergePreserveLocaleData } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    let dataset = [
      { id: 'flaky-source', url: 'https://example.com/job/flaky-source', title: 'Flaky Source Role' },
    ];

    // Run 1: missed (miss streak 1) — retained.
    dataset = mergePreserveLocaleData(dataset, []);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].crawlerMissStreak).toBe(1);

    // Run 2: missed again (miss streak 2) — still within grace period, retained.
    dataset = mergePreserveLocaleData(dataset, []);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].crawlerMissStreak).toBe(2);

    // Run 3: missed a third consecutive time — grace period exhausted, dropped
    // (flows into computeCrawlDiff's removedJobs / archive path from here).
    dataset = mergePreserveLocaleData(dataset, []);
    expect(dataset).toHaveLength(0);
  });

  it('resets the miss streak once the job is captured again by a later run', async () => {
    const { mergePreserveLocaleData } = await import('../scripts/lib/dedicated-crawler-common.mjs');

    let dataset = [
      { id: 'intermittent', url: 'https://example.com/job/intermittent', title: 'Intermittent Role' },
    ];

    // Missed once.
    dataset = mergePreserveLocaleData(dataset, []);
    expect(dataset[0].crawlerMissStreak).toBe(1);

    // Reappears — miss streak must clear, not keep climbing toward the drop threshold.
    dataset = mergePreserveLocaleData(dataset, [
      { url: 'https://example.com/job/intermittent', title: 'Intermittent Role' },
    ]);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].crawlerMissStreak).toBeUndefined();

    // Missed again after reappearing — streak restarts from 1, not from where it left off.
    dataset = mergePreserveLocaleData(dataset, []);
    expect(dataset).toHaveLength(1);
    expect(dataset[0].crawlerMissStreak).toBe(1);
  });
});

describe('Swiss-only location filtering (Swatch Group US-jobs leak, 2026-06-17)', () => {
  it('isTargetSwissLocation: bare common words that collide with tiny communes are not Swiss', async () => {
    const { isTargetSwissLocation } = await import('../scripts/lib/target-swiss-locations.mjs');
    // Sâles (FR), Concise (VD), Court (BE): real but tiny communes whose
    // accent-stripped names are common job-prose words.
    expect(isTargetSwissLocation('Retail Sales Advisor')).toBe(false);
    expect(isTargetSwissLocation('a concise job description')).toBe(false);
    expect(isTargetSwissLocation('tennis court attendant')).toBe(false);
    // Genuine target locations still match.
    expect(isTargetSwissLocation('Lugano, Ticino')).toBe(true);
    expect(isTargetSwissLocation('Sion, Valais')).toBe(true);
  });

  it('foreign gates use word boundaries, not substrings ("company" must not match commune "Pany")', async () => {
    const { isExplicitlyOutsideTarget, isLocationExplicitlyForeign } = await import(
      '../scripts/lib/dedicated-crawler-common.mjs'
    );
    // "company address ... United States" must read as foreign — previously the
    // substring "pany" matched commune "Pany" (GR) and cancelled the rejection.
    const usText = 'Company address The Swatch Group (U.S.) Inc. 800 Waterford Way Miami FL United States';
    expect(isExplicitlyOutsideTarget(usText)).toBe(true);
    expect(isLocationExplicitlyForeign('Garden City, company HQ, United States')).toBe(true);
  });

  it('foreign-job gates do not treat a foreign border town as a Swiss location', async () => {
    const { isExplicitlyOutsideTarget, isLocationExplicitlyForeign } = await import(
      '../scripts/lib/dedicated-crawler-common.mjs'
    );
    const { isTargetSwissLocation } = await import('../scripts/lib/target-swiss-locations.mjs');
    // BORDER_PROXIMITY_BY_CANTON lists foreign towns (Como/Varese for TI,
    // Evian/Thonon for VS) so cross-border jobs surface — but they must NOT be
    // read as "this text names a Swiss location" by the foreign-job gates, or an
    // explicit foreign job (e.g. "Como, Italy") would have its rejection cancelled.
    for (const loc of ['Como, Italy', 'Varese, Italia', 'Evian, France']) {
      expect(isTargetSwissLocation(loc, { includeBorderProximity: false })).toBe(false);
      expect(isLocationExplicitlyForeign(loc)).toBe(true);
      expect(isExplicitlyOutsideTarget(loc)).toBe(true);
    }
    // The border keyword still surfaces cross-border relevance for the default
    // (inclusion) callers, and a genuine border-area Swiss city is kept.
    expect(isTargetSwissLocation('Como')).toBe(true);
    expect(isLocationExplicitlyForeign('Chiasso, Ticino')).toBe(false);
  });

  it('jobLocationBlockCountryIsForeign: reads the authoritative ATS job-location country', async () => {
    const { jobLocationBlockCountryIsForeign } = await import(
      '../scripts/lib/dedicated-crawler-common.mjs'
    );
    const usBlock =
      'Job location • Stevens Creek Boulevard 2855 • 95050 Santa Clara CA (California) • United States • Company address • The Swatch Group (U.S.) Inc.';
    const auBlock = 'Job location 2000 Sydney Company address The Swatch Group (Australia)';
    const usTruncated = 'Job location 75225 Dallas TX Company address Swatch Group';
    const chBlock =
      'Job location Rue des Sors 3 2074 Marin (Neuchatel) Switzerland Company address Swatch Group';
    expect(jobLocationBlockCountryIsForeign(usBlock)).toBe(true);
    expect(jobLocationBlockCountryIsForeign(auBlock)).toBe(true);
    expect(jobLocationBlockCountryIsForeign(usTruncated)).toBe(true);
    // Swiss block (and Swiss-HQ boilerplate) must be kept.
    expect(jobLocationBlockCountryIsForeign(chBlock)).toBe(false);
    // No structured block, or casual prose, never matches.
    expect(jobLocationBlockCountryIsForeign('this job location is flexible, some travel')).toBe(false);
    expect(jobLocationBlockCountryIsForeign('')).toBe(false);
  });

  it('getMergeExclusionReasons excludes a US Swatch store but keeps a Swiss one', async () => {
    const { getMergeExclusionReasons } = await import('../scripts/lib/dedicated-crawler-common.mjs');
    const cfg = { minQualityScore: 0, minDescriptionChars: 0 };
    const usJob = {
      title: 'Swatch Part Time Keyholder - Valley Fair (CA)',
      company: 'The Swatch Group (U.S.) Inc.',
      location: 'Ticino',
      url: 'https://www.swatchgroup.com/en/job/31148',
      description:
        'Swatch Part Time Keyholder. As a member of the Retail Sales Team you will be coached on sales techniques. Job location • Stevens Creek Boulevard 2855 • 95050 Santa Clara CA (California) • United States • Company address • The Swatch Group (U.S.) Inc. • 800 Waterford Way • Miami FL 33126',
    };
    const chJob = {
      title: 'SALES ASSOCIATE 50-100% ZÜRICH',
      company: 'The Swatch Group',
      location: 'Zürich',
      url: 'https://www.swatchgroup.com/en/job/40000',
      description:
        'Sales Associate role in our boutique. Job location Bahnhofstrasse 69 8001 Zurich (Zurich) Switzerland Company address Swatch Group',
    };
    expect(getMergeExclusionReasons(usJob, cfg)).toContain('job_location_block_foreign');
    expect(getMergeExclusionReasons(chJob, cfg)).not.toContain('job_location_block_foreign');
  });
});

// ─── seedCrawlerSlicesFromDataJobs (issue #3089 items 2 + 3) ────────────────
//
// This is the raw, pre-quality-gate seed that `runDedicatedBaseCrawler` runs
// against the freshly-merged `data/jobs.json` before the shared crawler reads
// each crawler's slice back. Two "should never happen" invariants shipped in
// #3107/#3122 but had no direct unit coverage — this locks them in.
describe('seedCrawlerSlicesFromDataJobs (#3089 items 2 + 3)', () => {
  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-seed-slices-'));
    fs.mkdirSync(path.join(root, 'data', 'jobs', 'by-crawler'), { recursive: true });
    return root;
  }

  const sliceDir = (root: string) => path.join(root, 'data', 'jobs', 'by-crawler');
  const dataJobsPath = (root: string) => path.join(root, 'data', 'jobs.json');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('item 2: warns instead of silently leaving a stale slice when a scoped companyKey matches 0 jobs but an on-disk slice already holds jobs (alias/canton-suffix mismatch)', () => {
    const root = makeRoot();
    // The merged data/jobs.json only has jobs under a differently-shaped key
    // (e.g. a canton-suffixed alias), never the plain scoped key "acme".
    fs.writeFileSync(
      dataJobsPath(root),
      JSON.stringify([{ companyKey: 'acme-ti', title: 'Some job' }]),
    );
    // A previous run's slice for the scoped key still holds jobs on disk.
    const staleSlicePath = path.join(sliceDir(root), 'acme.json');
    const staleJobs = { jobs: [{ companyKey: 'acme', title: 'Stale job' }] };
    fs.writeFileSync(staleSlicePath, JSON.stringify(staleJobs));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => seedCrawlerSlicesFromDataJobs(root, ['acme'])).not.toThrow();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/companyKey "acme" matched 0 jobs.*slice NOT refreshed/s),
    );
    // The slice is left untouched (not silently emptied nor silently kept
    // stale without any signal) — the warn IS the signal.
    expect(JSON.parse(fs.readFileSync(staleSlicePath, 'utf-8'))).toEqual(staleJobs);
    void logSpy;
  });

  it('item 2: a scoped companyKey matching 0 jobs with no pre-existing slice is a legitimate no-op (info log, no warn)', () => {
    const root = makeRoot();
    fs.writeFileSync(dataJobsPath(root), JSON.stringify([{ companyKey: 'other-co', title: 'Some job' }]));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => seedCrawlerSlicesFromDataJobs(root, ['brand-new-co'])).not.toThrow();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/companyKey "brand-new-co" matched 0 jobs \(no slice to refresh\)/),
    );
  });

  it('item 2: a matching companyKey still reseeds the slice from the fresh merge (happy path unaffected)', () => {
    const root = makeRoot();
    fs.writeFileSync(
      dataJobsPath(root),
      JSON.stringify([
        { companyKey: 'acme', title: 'Fresh job 1' },
        { companyKey: 'acme', title: 'Fresh job 2' },
        { companyKey: 'other-co', title: 'Not scoped' },
      ]),
    );
    const slicePath = path.join(sliceDir(root), 'acme.json');
    fs.writeFileSync(slicePath, JSON.stringify({ jobs: [{ companyKey: 'acme', title: 'Old stale job' }] }));

    seedCrawlerSlicesFromDataJobs(root, ['acme']);

    const written = JSON.parse(fs.readFileSync(slicePath, 'utf-8'));
    expect(written.jobs).toHaveLength(2);
    expect(written.jobs.map((j: { title: string }) => j.title)).toEqual(['Fresh job 1', 'Fresh job 2']);
  });

  it('item 3: rethrows (and logs via console.error) instead of silently proceeding stale when data/jobs.json is corrupt', () => {
    const root = makeRoot();
    fs.writeFileSync(dataJobsPath(root), '{ this is not valid json');
    const slicePath = path.join(sliceDir(root), 'acme.json');
    fs.writeFileSync(slicePath, JSON.stringify({ jobs: [{ companyKey: 'acme', title: 'Stale job' }] }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => seedCrawlerSlicesFromDataJobs(root, ['acme'])).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Slice seed failed/));
    // Nothing was silently rewritten — the stale slice is untouched, and the
    // failure is CI-visible (thrown), not just a console.warn.
    expect(JSON.parse(fs.readFileSync(slicePath, 'utf-8')).jobs[0].title).toBe('Stale job');
  });

  it('item 3: rethrows when the per-crawler slice write fails mid-loop (e.g. target path collides with a directory)', () => {
    const root = makeRoot();
    fs.writeFileSync(
      dataJobsPath(root),
      JSON.stringify([{ companyKey: 'acme', title: 'Fresh job' }]),
    );
    // Make the write target a directory instead of a file so writeJsonAtomic's
    // rename-into-place fails mid-loop (simulates a real write failure, not a
    // parse error).
    fs.mkdirSync(path.join(sliceDir(root), 'acme.json'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => seedCrawlerSlicesFromDataJobs(root, ['acme'])).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Slice seed failed/));
  });
});

// Regression tests for issue #3284 (previousSlugs writer regression: 6136
// losses in 24h). Root cause: mergeAndDeduplicate() had three dedup passes
// (existing-vs-existing fingerprint collision, heuristic-key collision, and
// the final post-registry fingerprint collision) that called preferJob(a, b)
// bare — preferJob returns ONE of the two whole job objects, so the loser's
// previousSlugs / previousSlugsByLocale history (accumulated separately on
// each duplicate record) was silently discarded with no journal entry. Fixed
// by routing all three passes through mergeDuplicateJobPreservingSlugHistory,
// which unions previousSlugs/previousSlugsByLocale before preferJob picks a
// winner, and journals via captureLostSlugs.
describe('mergeAndDeduplicate — previousSlugs history preserved across duplicate collapse (#3284)', () => {
  const cfg = { minQualityScore: 0, minDescriptionChars: 0 };
  let registryOverridePath;
  let prevOverride;

  beforeEach(() => {
    // mergeAndDeduplicate() reads/writes a persistent slug registry
    // (data/slug-registry.json in the real repo). Point it at a throwaway
    // temp file for the duration of this test so we never mutate the
    // tracked registry as a side effect of running the suite.
    prevOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    registryOverridePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-slug-registry-')), 'slug-registry.json');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryOverridePath;
  });

  afterEach(() => {
    if (prevOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    else process.env.SLUG_REGISTRY_PATH_OVERRIDE = prevOverride;
  });

  it('unions previousSlugsByLocale from both sides of an existing-vs-existing fingerprint collision instead of discarding the loser', () => {
    // Two existing-slice records for the SAME posting (same url ⇒ same
    // fingerprint) that accumulated DIFFERENT previousSlugsByLocale entries
    // on separate crawl runs — exactly the shape observed in the flagged
    // commits (e.g. coop-ticino.json company-9wwgfj: active slug unchanged,
    // but previousSlugsByLocale.en/.fr silently shrank).
    const base = {
      id: 'job-dup-1',
      title: 'Department Manager',
      company: 'Coop',
      location: 'Ticino',
      url: 'https://example.com/jobs/dup-1',
      description: 'A'.repeat(50),
      slug: 'department-manager-coop',
      slugByLocale: { it: 'responsabile-reparto-coop', en: 'department-manager-coop' },
      postedDate: '2026-06-30',
      crawledAt: '2026-06-30T00:00:00.000Z',
    };
    const existingA = {
      ...base,
      previousSlugsByLocale: { en: ['department-manager-including-deputy-management-coop'] },
    };
    const existingB = {
      ...base,
      previousSlugsByLocale: { en: ['department-manager-with-deputy-management-responsibilities-coop'] },
    };

    const result = mergeAndDeduplicate([existingA, existingB], [], cfg);
    const jobs = result.merged;
    expect(jobs.length).toBe(1);
    const merged = jobs[0];

    // BOTH sides' historical slugs must survive the collapse.
    expect(merged.previousSlugsByLocale?.en || []).toContain(
      'department-manager-including-deputy-management-coop'
    );
    expect(merged.previousSlugsByLocale?.en || []).toContain(
      'department-manager-with-deputy-management-responsibilities-coop'
    );
  });

  it('journals the loser\'s active slug when it differs from the winner\'s, instead of dropping it untracked', () => {
    const existingA = {
      id: 'job-dup-2',
      title: 'Sales Associate',
      company: 'Coop',
      location: 'Ticino',
      url: 'https://example.com/jobs/dup-2',
      description: 'B'.repeat(50),
      slug: 'sales-associate-coop',
      slugByLocale: { it: 'addetto-vendita-coop', en: 'sales-associate-coop' },
      postedDate: '2026-06-30',
      crawledAt: '2026-06-30T00:00:00.000Z',
      featured: true, // ensures deterministic winner via preferJob's score
    };
    const existingB = {
      ...existingA,
      featured: false,
      slug: 'sales-associate-coop-old',
      slugByLocale: { it: 'addetto-vendita-coop', en: 'sales-associate-coop-old' },
    };

    const result = mergeAndDeduplicate([existingA, existingB], [], cfg);
    const jobs = result.merged;
    expect(jobs.length).toBe(1);
    const merged = jobs[0];

    // existingA wins (featured), but existingB's now-superseded active EN
    // slug must be captured into previousSlugsByLocale, not lost.
    const allEn = [
      ...(merged.previousSlugsByLocale?.en || []),
      ...(Array.isArray(merged.previousSlugs) ? merged.previousSlugs : []),
    ];
    expect(allEn).toContain('sales-associate-coop-old');
  });

  // Regression tests for issues #3313/#3314: every previousSlugs-history
  // cap-trim (`.slice(0, 20)` keep-oldest) in this file used to drop the
  // overflow silently, with no journal entry — the same un-journaled
  // cap-trim construct #3284 fixed for the bare preferJob() drop, just at
  // a different step (trimming AFTER the union, not the union itself).
  // Each site must now call recordSlugMutation({action: 'cap-trim', ...})
  // for every entry it trims beyond the 20-cap.
  it('journals cap-trim (not silent-drop) when the existing-vs-existing union exceeds the legacy flat cap (mergeDuplicateJobPreservingSlugHistory)', () => {
    clearSlugHistoryJournal();
    const base = {
      title: 'Warehouse Operator',
      company: 'Coop',
      location: 'Ticino',
      url: 'https://example.com/jobs/dup-cap-1',
      description: 'C'.repeat(50),
      slug: 'warehouse-operator-coop',
      slugByLocale: { it: 'warehouse-operator-coop' },
      postedDate: '2026-06-30',
      crawledAt: '2026-06-30T00:00:00.000Z',
    };
    // LEGACY_PREV_SLUGS_CAP (issue #3630) is the flat legacy array's cap —
    // it unions across multiple sources (here: two merging job records), so
    // it must be sized bigger than any single-bucket cap. Each side supplies
    // more than half the cap so their union overflows it.
    const half = Math.ceil(LEGACY_PREV_SLUGS_CAP / 2) + 5;
    const existingA = { ...base, id: 'job-cap-a', previousSlugs: Array.from({ length: half }, (_, i) => `a-slug-${i}`) };
    const existingB = { ...base, id: 'job-cap-b', previousSlugs: Array.from({ length: half }, (_, i) => `b-slug-${i}`) };

    const result = mergeAndDeduplicate([existingA, existingB], [], cfg);
    const jobs = result.merged;
    expect(jobs.length).toBe(1);
    const merged = jobs[0];

    // 2*half unique entries capped to LEGACY_PREV_SLUGS_CAP — the merge must
    // not silently drop the overflow; it must journal a cap-trim event.
    expect(merged.previousSlugs.length).toBe(LEGACY_PREV_SLUGS_CAP);
    const trims = getEvents().filter((e) => e.action === 'cap-trim');
    expect(trims.some((e) => e.source.includes('mergeDuplicateJobPreservingSlugHistory'))).toBe(true);
  });

  it('journals cap-trim (not silent-drop) on the incoming-vs-existing merge path when previousSlugs/previousSlugsByLocale union exceeds the cap (mergeAndDeduplicate "best" merge)', () => {
    clearSlugHistoryJournal();
    // Per-locale union (existing.it + incoming.it) stays at the unchanged
    // per-locale DEFAULT_PREV_SLUG_CAP (20): 15+15=30 still exceeds it, so
    // that trim path is unaffected by the #3630 fix. The flat union needs
    // its own larger fixtures to exceed the now-bigger LEGACY_PREV_SLUGS_CAP.
    const flatHalf = Math.ceil(LEGACY_PREV_SLUGS_CAP / 2) + 5;
    const existing = {
      id: 'job-cap-c',
      title: 'Logistics Coordinator',
      company: 'Coop',
      location: 'Ticino',
      url: 'https://example.com/jobs/dup-cap-2',
      description: 'D'.repeat(50),
      slug: 'logistics-coordinator-coop',
      slugByLocale: { it: 'logistics-coordinator-coop' },
      postedDate: '2026-06-30',
      crawledAt: '2026-06-30T00:00:00.000Z',
      previousSlugs: Array.from({ length: flatHalf }, (_, i) => `existing-slug-${i}`),
      previousSlugsByLocale: { it: Array.from({ length: 15 }, (_, i) => `existing-it-${i}`) },
    };
    const incoming = {
      ...existing,
      id: undefined,
      crawledAt: '2026-07-01T00:00:00.000Z',
      previousSlugs: Array.from({ length: flatHalf }, (_, i) => `incoming-slug-${i}`),
      previousSlugsByLocale: { it: Array.from({ length: 15 }, (_, i) => `incoming-it-${i}`) },
    };

    const result = mergeAndDeduplicate([existing], [incoming], cfg);
    const jobs = result.merged;
    expect(jobs.length).toBe(1);
    const merged = jobs[0];

    // Flat union (2*flatHalf → LEGACY_PREV_SLUGS_CAP) and per-locale union
    // (30→20) must both be capped WITHOUT silently discarding overflow —
    // each must journal.
    expect(merged.previousSlugs.length).toBe(LEGACY_PREV_SLUGS_CAP);
    expect(merged.previousSlugsByLocale.it.length).toBe(DEFAULT_PREV_SLUG_CAP);
    const trims = getEvents().filter((e) => e.action === 'cap-trim');
    expect(trims.some((e) => e.source.includes('mergeAndDeduplicate'))).toBe(true);
  });

  // Regression test for issue #3377: "previousSlugs writer regression: 4193
  // losses in 24 hours". addPreviousSlugForLocale's per-locale cap was
  // already correct, but it also rebuilds the flat legacy `previousSlugs`
  // mirror via syncLegacyPreviousSlugs — that internal helper unioned the
  // locale-aware (fresh) entries BEFORE the legacy (stale) entries, then
  // capped with `.slice(0, cap)` (oldest-kept). Net effect: a slug captured
  // by THIS call was silently dropped instead of the truly stale ones once
  // the job's history exceeded the 20-entry cap — an inverted LRU.
  it('addPreviousSlugForLocale keeps a freshly-captured slug on the flat previousSlugs mirror when the job is already at cap (#3377)', () => {
    clearSlugHistoryJournal();
    // The flat mirror is capped at LEGACY_PREV_SLUGS_CAP (issue #3630: it
    // unions across locale buckets, not a single bucket), so the job must
    // already be at THAT cap — not the per-locale DEFAULT_PREV_SLUG_CAP —
    // for this call to exercise the eviction path at all.
    const job = {
      id: 'job-3377-a',
      slug: 'old-active-slug',
      previousSlugs: Array.from({ length: LEGACY_PREV_SLUGS_CAP }, (_, i) => `stale-slug-${i}`),
    };
    addPreviousSlugForLocale(job, 'it', 'freshly-captured-slug', DEFAULT_PREV_SLUG_CAP, 'test-source');
    expect(job.previousSlugs).toHaveLength(LEGACY_PREV_SLUGS_CAP);
    expect(job.previousSlugs).toContain('freshly-captured-slug');
    expect(job.previousSlugs).not.toContain('stale-slug-0');
  });

  // Same regression, exercised through captureLostSlugs — the helper the
  // 54 hand-rolled company-crawler mergeJobs() functions were codemodded to
  // call in this PR (they previously did `{...prev, ...job}` with no
  // capture call at all, silently clobbering the flat `job.slug` field on
  // every re-crawl with zero history preserved).
  it('captureLostSlugs preserves the previous active slug when the job is already at the legacy flat cap (#3377)', () => {
    clearSlugHistoryJournal();
    // Same LEGACY_PREV_SLUGS_CAP vs DEFAULT_PREV_SLUG_CAP distinction as the
    // addPreviousSlugForLocale test above (issue #3630).
    const merged = {
      id: 'job-3377-b',
      slug: 'new-active-slug-from-this-crawl',
      previousSlugs: Array.from({ length: LEGACY_PREV_SLUGS_CAP }, (_, i) => `stale-slug-${i}`),
    };
    captureLostSlugs(merged, {}, 'old-active-slug-about-to-be-lost', DEFAULT_PREV_SLUG_CAP);
    expect(merged.previousSlugs).toHaveLength(LEGACY_PREV_SLUGS_CAP);
    expect(merged.previousSlugs).toContain('old-active-slug-about-to-be-lost');
  });
});

describe('mergeAndDeduplicate — postedDate falls back to legacy datePosted instead of fabricating today (#3843 item 3)', () => {
  const cfg = { minQualityScore: 0, minDescriptionChars: 0 };
  let registryOverridePath;
  let prevOverride;

  beforeEach(() => {
    prevOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    registryOverridePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ft-slug-registry-')), 'slug-registry.json');
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = registryOverridePath;
  });

  afterEach(() => {
    if (prevOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    else process.env.SLUG_REGISTRY_PATH_OVERRIDE = prevOverride;
  });

  const baseJob = (over = {}) => ({
    id: 'job-dateposted-1',
    title: 'Infermiere diplomato',
    company: 'Clinica Test',
    location: 'Lugano, Ticino',
    url: 'https://example.com/jobs/dateposted-1',
    description: 'D'.repeat(60),
    slug: 'infermiere-diplomato-clinica-test',
    ...over,
  });

  it('uses next.datePosted when neither side carries postedDate (legacy crawler emits only datePosted)', () => {
    const prev = baseJob({ datePosted: '2026-06-15', crawledAt: '2026-06-20T00:00:00.000Z' });
    const next = baseJob({ datePosted: '2026-06-15' });
    const { merged } = mergeAndDeduplicate([prev], [next], cfg);
    expect(merged).toHaveLength(1);
    // Before the fix this fabricated today's nowIsoDate.
    expect(merged[0].postedDate).toBe('2026-06-15');
  });

  it('keeps the older real source date when prev.postedDate was fabricated by an earlier merge run', () => {
    // prev.postedDate = nowIsoDate stamped by a pre-fix merge; the incoming
    // legacy job still carries the true (older) source posting date.
    const prev = baseJob({ postedDate: '2026-07-01', crawledAt: '2026-07-01T00:00:00.000Z' });
    const next = baseJob({ datePosted: '2026-06-10' });
    const { merged } = mergeAndDeduplicate([prev], [next], cfg);
    expect(merged).toHaveLength(1);
    expect(merged[0].postedDate).toBe('2026-06-10');
  });

  it('does not let a crawler that stamps datePosted=today churn an established older postedDate forward (preserveOlder semantics)', () => {
    const today = new Date().toISOString().split('T')[0];
    const prev = baseJob({ postedDate: '2026-06-01', crawledAt: '2026-06-01T00:00:00.000Z' });
    const next = baseJob({ datePosted: today });
    const { merged } = mergeAndDeduplicate([prev], [next], cfg);
    expect(merged).toHaveLength(1);
    expect(merged[0].postedDate).toBe('2026-06-01');
  });

  it('existing-vs-existing collapse (mergeDuplicateJobPreservingSlugHistory path) keeps the older datePosted-only date instead of the winner\'s fabricated one', () => {
    const winner = baseJob({ postedDate: '2026-07-05', crawledAt: '2026-07-05T00:00:00.000Z', featured: true });
    const loser = baseJob({ datePosted: '2026-05-20', crawledAt: '2026-07-05T00:00:00.000Z', featured: false });
    const { merged } = mergeAndDeduplicate([winner, loser], [], cfg);
    expect(merged).toHaveLength(1);
    expect(merged[0].postedDate).toBe('2026-05-20');
  });

  it('pickMergedPostedDate: lets next win when it is actually older, prefers real dates over unparseable ones, and returns empty when both sides are blank', () => {
    expect(pickMergedPostedDate(
      { postedDate: '2026-07-01' },
      { postedDate: '2026-06-01' },
    )).toBe('2026-06-01');
    expect(pickMergedPostedDate(
      { postedDate: 'not-a-date' },
      { datePosted: '2026-06-01' },
    )).toBe('2026-06-01');
    expect(pickMergedPostedDate({}, {})).toBe('');
  });
});

describe('mergePreserveLocaleData — cap-trim journaling (#3313/#3314)', () => {
  beforeEach(() => clearSlugHistoryJournal());

  it('journals cap-trim when merged previousSlugsByLocale[locale] exceeds the 20-entry cap', () => {
    const oldArr = Array.from({ length: 15 }, (_, i) => `old-it-${i}`);
    const freshArr = Array.from({ length: 15 }, (_, i) => `fresh-it-${i}`);
    const existingJobs = [{
      id: 'job-mpl-1',
      url: 'https://example.com/jobs/mpl-1',
      previousSlugsByLocale: { it: oldArr },
    }];
    const freshJobs = [{
      id: 'job-mpl-1',
      url: 'https://example.com/jobs/mpl-1',
      previousSlugsByLocale: { it: freshArr },
    }];

    const [merged] = mergePreserveLocaleData(existingJobs, freshJobs, { matchKey: (j) => j.id });
    expect(merged.previousSlugsByLocale.it).toHaveLength(20);
    const trims = getEvents().filter((e) => e.action === 'cap-trim');
    expect(trims.some((e) => e.source.includes('mergePreserveLocaleData'))).toBe(true);
  });

  it('journals cap-trim in syncLegacyPreviousSlugs when the flat previousSlugs union across locales exceeds the cap', () => {
    // Issue #3630: LEGACY_PREV_SLUGS_CAP (= DEFAULT_PREV_SLUG_CAP * 4 locales)
    // is the theoretical ceiling a union built PURELY from per-locale-capped
    // buckets can reach — 3 locales at 8 each can never trip it alone. Real
    // production jobs (e.g. company-de3q6m) also carry flat-only legacy
    // entries pre-dating locale attribution (syncLegacyPreviousSlugs's own
    // doc comment: "PLUS any existing legacy entries that haven't been
    // attributed to a locale yet"). Model that here with extra flat-only
    // stale entries so the union still genuinely exceeds the cap while every
    // individual locale bucket stays comfortably under DEFAULT_PREV_SLUG_CAP.
    const perLocaleCount = 8;
    const localeCount = 3; // it/en/de below
    const staleFlatOnlyCount = LEGACY_PREV_SLUGS_CAP - perLocaleCount * localeCount + 10;
    const existingJobs = [{
      id: 'job-mpl-2',
      url: 'https://example.com/jobs/mpl-2',
      previousSlugs: Array.from({ length: staleFlatOnlyCount }, (_, i) => `stale-flat-${i}`),
      previousSlugsByLocale: {
        it: Array.from({ length: perLocaleCount }, (_, i) => `it-${i}`),
        en: Array.from({ length: perLocaleCount }, (_, i) => `en-${i}`),
        de: Array.from({ length: perLocaleCount }, (_, i) => `de-${i}`),
      },
    }];
    const freshJobs = [{
      id: 'job-mpl-2',
      url: 'https://example.com/jobs/mpl-2',
      previousSlugsByLocale: {},
    }];

    const [merged] = mergePreserveLocaleData(existingJobs, freshJobs, { matchKey: (j) => j.id });
    // Each locale array stays under its own DEFAULT_PREV_SLUG_CAP (8 entries
    // each), so the per-locale trim never fires — but the flat legacy union
    // (stale flat-only entries + all locale buckets) DOES exceed
    // LEGACY_PREV_SLUGS_CAP, so syncLegacyPreviousSlugs must trim it.
    expect(merged.previousSlugsByLocale.it).toHaveLength(perLocaleCount);
    expect(merged.previousSlugsByLocale.en).toHaveLength(perLocaleCount);
    expect(merged.previousSlugsByLocale.de).toHaveLength(perLocaleCount);
    expect(merged.previousSlugs.length).toBe(LEGACY_PREV_SLUGS_CAP);
    const trims = getEvents().filter((e) => e.action === 'cap-trim');
    expect(trims.some((e) => e.source.includes('syncLegacyPreviousSlugs'))).toBe(true);
  });
});

describe('hasFullLocaleCoverage — post-merge needsRetranslation guard (#3442)', () => {
  // Dedicated crawlers that set `needsRetranslation = true` in their OWN
  // post-processing step (after runDedicatedBaseCrawler's merge already ran)
  // bypass the merge-time translation-stability lock entirely. Coop
  // (repairJobFromJsonLd) and Lastminute (SR API enrichment) both used to
  // unconditionally re-flag an already fully-translated job on every
  // re-crawl, forcing the AI pipeline to re-translate the same source title
  // and churn slugByLocale (and, downstream, previousSlugs) every cycle.
  // hasFullLocaleCoverage() is the shared guard both call sites now check
  // before setting the flag.
  const fullJob = {
    titleByLocale: { it: 'Venditore', en: 'Salesperson', de: 'Verkaufer', fr: 'Vendeur' },
    slugByLocale: { it: 'venditore-x', en: 'salesperson-x', de: 'verkaufer-x', fr: 'vendeur-x' },
    descriptionByLocale: {
      it: 'x'.repeat(150), en: 'x'.repeat(150), de: 'x'.repeat(150), fr: 'x'.repeat(150),
    },
  };

  it('returns true when title/slug/description are all present in every locale', () => {
    expect(hasFullLocaleCoverage(fullJob)).toBe(true);
  });

  it('returns false when a locale description is missing (translation genuinely pending)', () => {
    const partial = { ...fullJob, descriptionByLocale: { ...fullJob.descriptionByLocale, en: '' } };
    expect(hasFullLocaleCoverage(partial)).toBe(false);
  });

  it('returns false when a locale slug is missing', () => {
    const partial = { ...fullJob, slugByLocale: { ...fullJob.slugByLocale, fr: '' } };
    expect(hasFullLocaleCoverage(partial)).toBe(false);
  });

  it('returns false for an empty/undefined job (never crashes)', () => {
    expect(hasFullLocaleCoverage({})).toBe(false);
    expect(hasFullLocaleCoverage(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// mergeLocaleTextMap — sourceLocale-aware merge (regression, issue #3453)
// ─────────────────────────────────────────────────────────────
//
// Several dedicated crawlers (Coop, Oscam, La Fonte, AIL) rebuild a job's
// description from freshly fetched source data every crawl cycle and used to
// reset the ENTIRE descriptionByLocale map to just the freshly fetched
// locale whenever the rebuilt text differed from the previously stored
// description by more than 100 chars — a bound easily crossed by incidental
// reformatting (footer/company/locality lines shift the assembled length)
// rather than a genuine rewrite of the source posting. That wiped
// already-translated locales outright. The fix reuses this exact function
// (already the safe-merge primitive for titleByLocale/slugByLocale
// elsewhere) with an explicit `sourceLocale` so only the fetched locale's
// slot is authoritative and every other locale keeps its real translation,
// no matter how large the source-locale delta is.
describe('mergeLocaleTextMap — sourceLocale-aware merge (issue #3453)', () => {
  it('preserves other-locale translations even when the source-locale text changes drastically (>100 chars)', () => {
    const existing = {
      it: 'Breve descrizione originale.',
      de: 'Eine bereits vollständig übersetzte und lange deutsche Stellenbeschreibung mit vielen Details zur Position.',
      en: 'A fully translated, long English job description with plenty of detail about the role.',
      fr: "Une description de poste française déjà entièrement traduite et détaillée.",
    };
    // Freshly rebuilt source-locale text, far longer than the prior stored
    // description (delta > 100 chars) — e.g. after incidental reformatting
    // of the Coop detail-page footer/header, not a real content rewrite.
    const freshItText =
      'Descrizione italiana completamente ricostruita, molto più lunga del testo precedente, con intestazione azienda, sede e piè di pagina aggiornati per riflettere il nuovo formato del template di assemblaggio.';
    expect(Math.abs(freshItText.length - existing.it.length)).toBeGreaterThan(100);

    const merged = mergeLocaleTextMap(existing, { it: freshItText }, 30, 'it');

    // Source locale is refreshed...
    expect(merged.it).toBe(freshItText);
    // ...but the other, already-translated locales are NOT wiped.
    expect(merged.de).toBe(existing.de);
    expect(merged.en).toBe(existing.en);
    expect(merged.fr).toBe(existing.fr);
  });

  it('still fills a genuinely empty non-source locale from the incoming map instead of leaving it missing', () => {
    const existing = { it: 'Testo sorgente originale abbastanza lungo da superare la soglia minima.' };
    const merged = mergeLocaleTextMap(
      existing,
      { it: 'Testo sorgente riscritto, molto più lungo del precedente per superare la soglia di 100 caratteri di differenza.', de: 'Ein neuer deutscher Text, der lang genug ist, um die Mindestzeichenzahl zu erreichen.' },
      30,
      'it',
    );
    expect(merged.de).toContain('neuer deutscher Text');
  });

  it('updates the source locale regardless of delta size (no reset gate needed)', () => {
    const existing = { it: 'Testo corto.', en: 'A short but real english translation of the posting.' };
    const tinyEdit = 'Testo corto!'; // 1-char delta, well under 100
    const merged = mergeLocaleTextMap(existing, { it: tinyEdit }, 3, 'it');
    expect(merged.it).toBe(tinyEdit);
    expect(merged.en).toBe(existing.en);
  });
});
