import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hardenJobLocaleFields } from '../scripts/lib/dedicated-crawler-common.mjs';

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
});
