import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "lavoro" (AE-5, 10/100).
 *
 * Scope: cerca lavoro, agenzie (gratuità per candidato), concorsi pubblici,
 * CV svizzero, URC/Caisse, intervista, contratto.
 */
export const FAQ_lavoro: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'lavoro-agenzie-gratuite-candidato',
    category: 'lavoro',
    question: {
      it: 'Le agenzie di collocamento in Svizzera sono gratuite per il candidato?',
      en: 'Are Swiss placement agencies free for the candidate?',
      de: 'Sind Schweizer Arbeitsvermittler für die Bewerber kostenlos?',
      fr: 'Les agences de placement suisses sont-elles gratuites pour le candidat ?',
    },
    answer: {
      it:
        "Sì, obbligatoriamente gratuite per il candidato. La Legge sul collocamento e il personale a prestito (LC, RS 823.11) art. 9 vieta di addebitare commissioni al lavoratore [fonte: Fedlex LC RS 823.11]. Le agenzie incassano la commissione dal datore di lavoro cliente. Il lavoratore interinale (temporaneo) è pagato dalla agenzia stessa (Adecco, Randstad, Manpower, Kelly) secondo il CCL per il lavoro a prestito, con minimi salariali garantiti e indennità di anzianità. In caso di richiesta di pagamento di fee o abbonamento da parte dell'agenzia, occorre segnalare alla SECO (cantone Ticino: Ufficio per la sorveglianza del mercato del lavoro). Le agenzie online gratuite più usate sono jobs.ch, jobup.ch, jobsuchmaschine.ch. I frontalieri possono registrarsi all'URC (Ufficio regionale di collocamento) svizzero solo se disoccupati con formulario U1.",
      en:
        "Yes, mandatorily free for the candidate. The Employment Services and Hiring of Services Act (LC, RS 823.11) art. 9 forbids charging the worker [source: Fedlex LC RS 823.11]. Agencies are paid by the employer client. Temporary workers (interim) are paid directly by the agency (Adecco, Randstad, Manpower, Kelly) under the collective temp-work CLA, with guaranteed minimum salaries and seniority bonuses. If an agency requests fees or subscriptions, report to SECO (Ticino: market supervision office). Most used free online agencies: jobs.ch, jobup.ch, jobsuchmaschine.ch. Cross-border workers can register with the Swiss URC (Regional Employment Office) only if unemployed with U1 form.",
      de:
        "Ja, für Bewerber zwingend kostenlos. Arbeitsvermittlungsgesetz (AVG SR 823.11) Art. 9 verbietet Abrechnung beim Arbeitnehmer [Quelle: Fedlex AVG SR 823.11]. Agenturen kassieren vom Kunden-Arbeitgeber. Temporärarbeitende werden von der Agentur bezahlt (Adecco, Randstad, Manpower, Kelly) nach GAV Personalverleih mit Mindestlöhnen und Dienstaltersentschädigung. Bei Gebühren- oder Abo-Forderung Meldung an SECO (Tessin: Amt für Arbeitsmarktaufsicht). Meistgenutzte Plattformen: jobs.ch, jobup.ch. Grenzgänger melden sich beim RAV nur mit Formular U1 (arbeitslos).",
      fr:
        "Oui, obligatoirement gratuites pour le candidat. La loi sur le service de l'emploi (LSE RS 823.11) art. 9 interdit toute facturation au travailleur [source : Fedlex LSE RS 823.11]. Les agences sont payées par l'employeur client. Les intérimaires sont rémunérés par l'agence (Adecco, Randstad, Manpower, Kelly) selon la CCT location de services avec salaires minimaux et primes d'ancienneté. Toute demande de frais : signalement au SECO (Tessin : office de surveillance du marché du travail). Plateformes gratuites : jobs.ch, jobup.ch. Inscription à l'ORP (office régional de placement) uniquement si chômage avec formulaire U1.",
    },
    relatedLinks: [
      {
        href: '/job-board/',
        label: {
          it: 'Offerte di lavoro in Ticino',
          en: 'Ticino job board',
          de: 'Tessin Stellenangebote',
          fr: 'Offres d\'emploi Tessin',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1991/392_392_392/it',
    ],
  },
  {
    id: 'lavoro-cv-svizzero-formato',
    category: 'lavoro',
    question: {
      it: 'Come si struttura un CV svizzero efficace?',
      en: 'How do I structure an effective Swiss CV?',
      de: 'Wie strukturiere ich einen wirkungsvollen Schweizer Lebenslauf?',
      fr: 'Comment structurer un CV suisse efficace ?',
    },
    answer: {
      it:
        "Il CV svizzero segue il modello europeo ma con alcune specificità: foto professionale, dati personali essenziali (nome, data nascita, nazionalità, stato civile, permesso G/B), formazione in ordine cronologico inverso (dal più recente), esperienze lavorative con riferimenti al CCL applicato o azienda completa, competenze linguistiche secondo il quadro europeo (A1-C2), referenze disponibili (è normale fornire 2-3 nomi con contatti diretti) [fonte: SECO, guida CV]. Lunghezza ideale 2 pagine, formato PDF. Il «diploma» va specificato con titolo, anno e ente (es. «Diploma di Geometra, 2010, ITG Bellinzona»). Foto obbligatoria (non è considerata discriminazione in Svizzera). Lettera di accompagnamento sempre in tedesco, francese o italiano a seconda della regione. Allegare certificati di servizio (Arbeitszeugnis) e diplomi.",
      en:
        "The Swiss CV follows the European model with specifics: professional photo, essential personal data (name, DOB, nationality, civil status, permit G/B), reverse-chronological education, work experience citing the applicable CLA or full company name, language skills per European framework (A1-C2), references (2-3 direct contacts) [source: SECO CV guide]. Ideal length 2 pages, PDF. Diploma must be stated with title, year and issuing body (e.g. «Surveyor diploma, 2010, ITG Bellinzona»). Photo is standard (not discriminatory in Switzerland). Cover letter in German, French or Italian per region. Attach work certificates (Arbeitszeugnis) and diplomas.",
      de:
        "Der Schweizer CV folgt dem europäischen Modell mit Besonderheiten: professionelles Foto, essentielle Personendaten (Name, Geburtsdatum, Nationalität, Zivilstand, G/B-Ausweis), Bildung rückwärts-chronologisch, Berufserfahrung mit GAV oder vollständigem Firmennamen, Sprachkenntnisse nach GER (A1-C2), Referenzen (2-3 Direktkontakte) [Quelle: SECO CV-Leitfaden]. Ideallänge 2 Seiten, PDF. Diplom mit Titel, Jahr, Aussteller (z. B. «Geometer-Diplom 2010, ITG Bellinzona»). Foto Standard (nicht diskriminierend in CH). Anschreiben in der Regionalsprache. Arbeitszeugnisse und Diplome beilegen.",
      fr:
        "Le CV suisse suit le modèle européen avec quelques spécificités : photo professionnelle, données personnelles essentielles (nom, date de naissance, nationalité, état civil, permis G/B), formation par ordre antichronologique, expérience avec CCT ou nom complet de l'entreprise, langues selon le cadre européen (A1-C2), références (2-3 contacts directs) [source : guide CV SECO]. Longueur idéale 2 pages, PDF. Diplôme avec titre, année et organisme (ex. « Diplôme de géomètre 2010, ITG Bellinzona »). Photo standard. Lettre de motivation en langue régionale. Joindre certificats de travail (Arbeitszeugnis) et diplômes.",
    },
    sources: [
      'https://www.arbeit.swiss/secoalv/it/home.html',
    ],
  },
  {
    id: 'lavoro-urc-iscrizione-frontaliere',
    category: 'lavoro',
    question: {
      it: 'Mi posso iscrivere all\'URC (Ufficio regionale di collocamento) da frontaliere?',
      en: 'Can I register with the Swiss URC as a cross-border worker?',
      de: 'Kann ich mich als Grenzgänger beim RAV (Regionale Arbeitsvermittlung) anmelden?',
      fr: 'Puis-je m\'inscrire à l\'ORP en tant que frontalier ?',
    },
    answer: {
      it:
        "Iscrizione come lavoratore occupato: no. L'URC assiste solo le persone iscritte alla disoccupazione svizzera, cioè residenti in Svizzera. Il frontaliere residente in Italia in cerca di lavoro può consultare liberamente i siti ufficiali come arbeit.swiss (SECO) e gli URC cantonali online [fonte: SECO, sito URC]. Può partecipare a eventi e fiere dell'impiego. Se perde il lavoro, secondo Regolamento UE 883/2004 art. 65 l'URC svizzero può fornire assistenza al collocamento se il frontaliere accede ai servizi italiani NASpI contemporaneamente, ma l'indennità è italiana [fonte: Eur-Lex reg. 883/2004]. I Centri per l'Impiego italiani (CPI) della Regione Lombardia hanno sportelli transfrontalieri (es. Como, Varese) con supporto dedicato ai frontalieri. Esistono anche gli EURES (European Employment Services) per la mobilità UE.",
      en:
        "Registration as an employed worker: no. The URC only helps persons registered as Swiss unemployed, i.e. Swiss residents. Italian-resident cross-border job seekers can freely consult arbeit.swiss (SECO) and cantonal URC websites [source: SECO URC site]. They can attend events and job fairs. If they lose their job, EU Reg. 883/2004 art. 65 says the Swiss URC can assist placement while Italian NASpI is accessed, but the benefit is Italian [source: Eur-Lex reg. 883/2004]. Italian Employment Centres (CPI) of Lombardy have cross-border desks (Como, Varese) dedicated to cross-border workers. EURES (European Employment Services) supports EU mobility.",
      de:
        "Als Beschäftigter: nein. Das RAV betreut nur in der Schweiz arbeitslos gemeldete Personen (d. h. CH-Wohnsitz). In Italien wohnhafte Stellensuchende können arbeit.swiss (SECO) und kantonale RAV-Sites frei nutzen [Quelle: SECO RAV-Site]. Teilnahme an Events/Messen möglich. Nach Arbeitsverlust: gemäss EU-VO 883/2004 Art. 65 RAV-Stellenvermittlung während NASpI in Italien, Leistung bleibt italienisch [Quelle: Eur-Lex VO 883/2004]. Italienische Arbeitsämter Lombardei (CPI) haben Grenzschalter (Como, Varese). EURES für EU-Mobilität.",
      fr:
        "En tant qu'employé : non. L'ORP n'assiste que les personnes inscrites au chômage suisse (domicile en Suisse). Frontalier résidant en Italie en recherche : consultation libre de arbeit.swiss (SECO) et sites ORP cantonaux [source : site SECO ORP]. Participation aux événements/forums possible. En cas de perte d'emploi : règl. UE 883/2004 art. 65 : l'ORP suisse peut assister au placement pendant la NASpI italienne, prestation italienne [source : Eur-Lex règl. 883/2004]. Les CPI de Lombardie ont des guichets transfrontaliers (Côme, Varèse). EURES pour la mobilité UE.",
    },
    sources: [
      'https://www.arbeit.swiss/',
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
    ],
  },
  {
    id: 'lavoro-concorsi-pubblici-svizzera',
    category: 'lavoro',
    question: {
      it: 'I frontalieri possono partecipare ai concorsi pubblici svizzeri?',
      en: 'Can cross-border workers take part in Swiss public competitions?',
      de: 'Können Grenzgänger an öffentlichen Wettbewerben in der Schweiz teilnehmen?',
      fr: 'Les frontaliers peuvent-ils participer aux concours publics suisses ?',
    },
    answer: {
      it:
        "Sì, ma con vincoli. La Confederazione e i Cantoni applicano il principio di non discriminazione ALC (art. 9 Allegato I) per i cittadini UE/AELS [fonte: Fedlex ALC SR 0.142.112.681]. Concorsi aperti: amministrazione federale (admin.ch/stelleninserate), amministrazione cantonale ticinese (ti.ch, sezione concorsi), enti pubblici autonomi (FFS, Posta, IKRK, EPFL). Alcune posizioni specifiche richiedono cittadinanza svizzera per motivi di sovranità: forze armate, polizia di confine, magistratura, diplomazia. Per l'insegnamento pubblico serve il diploma riconosciuto dalla CDPE (Conferenza direttori cantonali pubblica educazione). Molti concorsi comunali ticinesi preferiscono candidati con buona conoscenza del contesto locale. Tempi di selezione 2-4 mesi, contratti spesso di diritto pubblico con stipendi superiori al privato.",
      en:
        "Yes, with constraints. The Confederation and Cantons apply the AFMP non-discrimination principle (Annex I art. 9) for EU/EFTA citizens [source: Fedlex AFMP SR 0.142.112.681]. Open competitions: federal administration (admin.ch/stelleninserate), Ticino cantonal administration (ti.ch, jobs section), autonomous entities (SBB, Post, ICRC, EPFL). Some positions require Swiss citizenship for sovereignty: armed forces, border police, judiciary, diplomacy. Public teaching requires a diploma recognised by CDPE (Cantonal Directors of Public Education). Many Ticino municipal competitions favour locals. Selection 2-4 months, public-law contracts with salaries often above private sector.",
      de:
        "Ja, mit Einschränkungen. Bund und Kantone wenden das FZA-Nichtdiskriminierungsprinzip (Anhang I Art. 9) auf EU/EFTA-Bürger an [Quelle: Fedlex FZA SR 0.142.112.681]. Offene Ausschreibungen: Bundesverwaltung (admin.ch/stelleninserate), Tessiner Kantonsverwaltung (ti.ch), selbständige Anstalten (SBB, Post, IKRK, EPFL). Einige Stellen verlangen Schweizer Bürgerrecht (Armee, Grenzpolizei, Justiz, Diplomatie). Öffentlicher Unterricht: EDK-anerkanntes Diplom. Tessiner Gemeindeausschreibungen bevorzugen oft Ortskenner. Auswahl 2-4 Monate, öffentlich-rechtliche Verträge mit höheren Löhnen.",
      fr:
        "Oui, sous contraintes. Confédération et cantons appliquent le principe ALCP de non-discrimination (Annexe I art. 9) aux citoyens UE/AELE [source : Fedlex ALCP RS 0.142.112.681]. Concours ouverts : administration fédérale (admin.ch/stelleninserate), administration cantonale tessinoise (ti.ch), entités autonomes (CFF, Poste, CICR, EPFL). Certaines fonctions exigent la nationalité suisse (armée, corps des gardes-frontière, magistrature, diplomatie). Enseignement public : diplôme reconnu CDIP. Concours communaux tessinois favorisent souvent la connaissance locale. Sélection 2-4 mois, contrats de droit public aux salaires supérieurs au privé.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2002/243/it',
      'https://www.stelle.admin.ch/',
    ],
  },
  {
    id: 'lavoro-contratto-lavoro-preavviso',
    category: 'lavoro',
    question: {
      it: 'Quali sono i termini di preavviso nei contratti svizzeri?',
      en: 'What are the notice periods in Swiss employment contracts?',
      de: 'Welche Kündigungsfristen gelten in Schweizer Arbeitsverträgen?',
      fr: 'Quels sont les délais de préavis dans les contrats suisses ?',
    },
    answer: {
      it:
        "L'art. 335c CO stabilisce i preavvisi minimi [fonte: Fedlex CO RS 220]: 7 giorni durante il periodo di prova (solitamente 1-3 mesi all'inizio, art. 335b CO), 1 mese nel 1° anno di servizio, 2 mesi dal 2° al 9° anno, 3 mesi dal 10° anno. I CCL possono prolungarli (es. banche fino a 6 mesi per dirigenti). Il preavviso inizia il 1° del mese successivo alla ricezione della lettera di disdetta. La disdetta può avvenire per qualunque causa ma non nei periodi protetti (art. 336c CO: malattia, gravidanza, servizio militare, vacanza già fissata). In questi periodi la disdetta è nulla o sospesa. Il mancato rispetto del preavviso obbliga al pagamento del salario per il periodo non rispettato (art. 337c CO). La disdetta deve essere scritta se richiesta dalla controparte.",
      en:
        "CO art. 335c sets minimum notice periods [source: Fedlex CO RS 220]: 7 days during trial period (typically 1-3 months at start, CO art. 335b), 1 month in year 1, 2 months years 2-9, 3 months from year 10. CLAs may extend (e.g. 6 months for bank executives). Notice starts on the 1st of the month after delivery of the cancellation letter. Cancellation may be for any reason except during protected periods (CO art. 336c: illness, pregnancy, military service, booked holidays). In those periods cancellation is void or suspended. Failing to observe notice triggers pay for the missed period (CO art. 337c). Cancellation must be written if requested.",
      de:
        "OR Art. 335c setzt Mindestfristen [Quelle: Fedlex OR SR 220]: 7 Tage in der Probezeit (i. d. R. 1-3 Monate, OR Art. 335b), 1 Mt. im 1. Jahr, 2 Mt. 2.-9. Jahr, 3 Mt. ab 10. Jahr. GAV können verlängern (Banken 6 Mt. für Kader). Fristbeginn am 1. des Folgemonats nach Zugang der Kündigung. Kündigung frei, jedoch nicht während Sperrfristen (OR Art. 336c: Krankheit, Schwangerschaft, Militärdienst, Ferien). Kündigungen sind nichtig oder ruhend. Nichtbeachtung: Lohnzahlung für die nicht eingehaltene Dauer (OR Art. 337c). Schriftlichkeit auf Verlangen.",
      fr:
        "L'art. 335c CO fixe les délais minimaux [source : Fedlex CO RS 220] : 7 jours pendant le temps d'essai (habituellement 1-3 mois au début, CO art. 335b), 1 mois en 1re année, 2 mois 2e-9e année, 3 mois dès la 10e. Les CCT peuvent prolonger (banques cadres 6 mois). Délai dès le 1er du mois suivant la réception. Résiliation libre sauf périodes protégées (CO art. 336c : maladie, grossesse, service militaire, vacances fixées). Nulle ou suspendue dans ces cas. Non-respect : salaire dû pour la période non respectée (CO art. 337c). Forme écrite sur demande.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/diritto-lavoro-frontalieri/',
        label: {
          it: 'Diritto del lavoro',
          en: 'Labour law',
          de: 'Arbeitsrecht',
          fr: 'Droit du travail',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    ],
  },
  {
    id: 'lavoro-riconoscimento-diplomi',
    category: 'lavoro',
    question: {
      it: 'Come faccio riconoscere il mio diploma italiano in Svizzera?',
      en: 'How do I get my Italian diploma recognised in Switzerland?',
      de: 'Wie lasse ich mein italienisches Diplom in der Schweiz anerkennen?',
      fr: 'Comment faire reconnaître mon diplôme italien en Suisse ?',
    },
    answer: {
      it:
        "Il riconoscimento dipende dalla professione. Per le professioni regolamentate (medico, infermiere, avvocato, architetto, insegnante) il SERI (Segreteria di Stato per la formazione, ricerca e innovazione) emette l'attestato di equivalenza secondo la Direttiva UE 2005/36/CE [fonte: SERI, portale riconoscimento]. Domanda online su sbfi.admin.ch con diplomi tradotti, tassa CHF 550-950. Tempo 4-6 mesi. Per medici: MEBEKO (Commissione delle professioni mediche). Per infermieri: Croce Rossa Svizzera (CRS). Per professioni non regolamentate (ingegnere, informatico, economista) il riconoscimento formale non è obbligatorio: il datore valuta direttamente. Il SERI fornisce comunque un parere di equivalenza del livello (ISCED) utile nei concorsi. Per insegnanti: CDPE (Conferenza svizzera dei direttori cantonali dell'educazione).",
      en:
        "Recognition depends on profession. For regulated professions (doctor, nurse, lawyer, architect, teacher) SERI (State Secretariat for Education, Research and Innovation) issues equivalence under EU Directive 2005/36/EC [source: SERI recognition portal]. Online application on sbfi.admin.ch with translated diplomas, fee CHF 550-950. 4-6 months. Doctors: MEBEKO (Medical Professions Commission). Nurses: Swiss Red Cross (SRK). For non-regulated professions (engineer, IT, economist) formal recognition is not mandatory: the employer decides. SERI issues an ISCED level equivalence opinion useful in competitions. Teachers: CDPE (Conference of Cantonal Ministers of Education).",
      de:
        "Die Anerkennung hängt vom Beruf ab. Reglementierte Berufe (Arzt, Pflege, Anwalt, Architekt, Lehrer): SBFI erteilt Gleichwertigkeit gemäss EU-Richtlinie 2005/36/EG [Quelle: SBFI-Portal]. Online-Antrag auf sbfi.admin.ch mit übersetzten Diplomen, Gebühr CHF 550-950. 4-6 Monate. Ärzte: MEBEKO. Pflege: Schweizerisches Rotes Kreuz (SRK). Nicht reglementierte Berufe (Ingenieur, IT, Ökonom): keine Pflicht; Arbeitgeber entscheidet. SBFI erteilt ISCED-Niveau-Gutachten für Wettbewerbe. Lehrer: EDK (Schweizerische Konferenz der kantonalen Erziehungsdirektoren).",
      fr:
        "La reconnaissance dépend de la profession. Professions réglementées (médecin, infirmier, avocat, architecte, enseignant) : le SEFRI délivre l'attestation d'équivalence selon la directive UE 2005/36/CE [source : portail SEFRI]. Demande en ligne sur sbfi.admin.ch avec diplômes traduits, taxe CHF 550-950. 4-6 mois. Médecins : MEBEKO. Infirmiers : Croix-Rouge suisse (CRS). Non réglementées (ingénieur, informatique, économiste) : pas d'obligation, l'employeur décide. Le SEFRI émet un avis de niveau CITE utile pour les concours. Enseignants : CDIP.",
    },
    sources: [
      'https://www.sbfi.admin.ch/sbfi/it/home/formazione/riconoscimento-di-diplomi-esteri.html',
    ],
  },
  {
    id: 'lavoro-lingue-ticino-necessarie',
    category: 'lavoro',
    question: {
      it: 'Quali lingue servono per lavorare in Ticino?',
      en: 'Which languages are needed to work in Ticino?',
      de: 'Welche Sprachen braucht man, um im Tessin zu arbeiten?',
      fr: 'Quelles langues faut-il pour travailler au Tessin ?',
    },
    answer: {
      it:
        "L'italiano è la lingua principale (art. 1 Costituzione cantonale ticinese) [fonte: ti.ch, costituzione]. Nelle professioni commerciali, finanziarie e di accoglienza è richiesto il tedesco a livello B2-C1 (banche, private banking), con francese apprezzato. L'inglese è quasi sempre richiesto a livello B2+ nelle multinazionali, farmaceutiche (es. Roche a Mendrisio) e tech. Il settore pubblico cantonale (concorsi) richiede italiano madrelingua scritto e orale, e spesso tedesco B1 per posizioni interfaccia con la Confederazione. Nel settore edilizio e manifatturiero è sufficiente italiano con rudimenti di tedesco per cantieri misti. Il certificato linguistico CELI (Perugia) o TELC o Goethe-Zertifikat è spesso richiesto per prove formali. L'Ufficio della formazione professionale offre corsi gratuiti di tedesco A1-B2 per frontalieri registrati all'URC.",
      en:
        "Italian is the main language (Ticino Constitution art. 1) [source: ti.ch constitution]. Commercial, financial and hospitality roles require German B2-C1 (banks, private banking), French is appreciated. English is nearly always required at B2+ in multinationals, pharma (e.g. Roche Mendrisio) and tech. Cantonal public sector requires native Italian (written and oral) and often German B1 for federal-interface positions. Construction and manufacturing: Italian plus some German for mixed sites. Language certificates CELI (Perugia), TELC or Goethe-Zertifikat are often required. The Vocational Training Office offers free German A1-B2 courses for URC-registered cross-border workers.",
      de:
        "Italienisch ist die Hauptsprache (Tessiner Verfassung Art. 1) [Quelle: ti.ch Verfassung]. Im Handel, Finanzsektor und Gastgewerbe B2-C1 Deutsch gefragt (Banken, Private Banking), Französisch geschätzt. Englisch fast immer B2+ in Multinationals, Pharma (z. B. Roche Mendrisio) und Tech. Kantonaler öffentlicher Dienst: Italienisch als Muttersprache, oft Deutsch B1 für Bundesbezug. Bau und Fertigung: Italienisch plus etwas Deutsch. Zertifikate CELI (Perugia), TELC oder Goethe-Zertifikat oft nötig. Amt für Berufsbildung bietet Grenzgängern gratis Deutschkurse A1-B2.",
      fr:
        "L'italien est la langue principale (Constitution tessinoise art. 1) [source : ti.ch constitution]. Dans le commerce, la finance et l'accueil : allemand B2-C1 (banques, private banking), français apprécié. Anglais B2+ quasi partout dans les multinationales, pharma (Roche Mendrisio) et tech. Secteur public cantonal : italien langue maternelle, souvent allemand B1 pour interface fédérale. BTP et industrie : italien + bases d'allemand. Certificats CELI (Pérouse), TELC ou Goethe-Zertifikat souvent exigés. L'Office de la formation professionnelle propose des cours gratuits d'allemand A1-B2 aux frontaliers inscrits à l'ORP.",
    },
    sources: [
      'https://www4.ti.ch/can/rl/',
    ],
  },
  {
    id: 'lavoro-colloquio-differenze-culturali',
    category: 'lavoro',
    question: {
      it: 'Quali sono le principali differenze culturali nei colloqui di lavoro in Ticino?',
      en: 'What are the main cultural differences in Ticino job interviews?',
      de: 'Was sind die wichtigsten kulturellen Unterschiede bei Bewerbungsgesprächen im Tessin?',
      fr: 'Quelles sont les principales différences culturelles dans les entretiens au Tessin ?',
    },
    answer: {
      it:
        "Il colloquio ticinese mescola la formalità svizzera con la calore latino. Puntualità assoluta (5 minuti d'anticipo è il minimo), abbigliamento formale per banche e assicurazioni, business casual altrove. Stretta di mano ferma e occhi negli occhi. Evitare eccessiva familiarità: «lei» formale finché non invitato al «tu» (raro al primo colloquio). Le domande sono dirette ma cortesi: esperienza, motivazione, conoscenza aziendale, disponibilità. Evitare di denigrare ex-datori di lavoro. La franchezza sul salario è normale: indicare una fascia realistica basata sul CCL. Portare sempre copia cartacea del CV, certificato di salario precedente (Arbeitszeugnis), diplomi, referenze. Il follow-up con email di ringraziamento entro 24 ore è gradito. Tempi medi di risposta 2-4 settimane [fonte: Camera di commercio Cantone Ticino, guida colloqui].",
      en:
        "Ticino interviews blend Swiss formality with Latin warmth. Absolute punctuality (5 minutes early minimum), formal attire for banks/insurance, business casual elsewhere. Firm handshake, eye contact. Avoid excess familiarity: formal «you» until invited to first-name basis (rare in first interview). Questions are direct but polite: experience, motivation, company knowledge, availability. Do not denigrate past employers. Salary openness is normal: give a realistic range based on the CLA. Always bring paper CV copy, prior Arbeitszeugnis, diplomas, references. Thank-you email within 24 hours is appreciated. Average response time 2-4 weeks [source: Ticino Chamber of Commerce interview guide].",
      de:
        "Tessiner Vorstellungsgespräche verbinden Schweizer Formalität mit lateinischer Wärme. Pünktlichkeit absolut (5 Min. früher), formelle Kleidung bei Banken/Versicherungen, Business Casual sonst. Fester Händedruck, Blickkontakt. Keine übertriebene Vertraulichkeit: Siezen, bis zum Duzen eingeladen (selten im Erstgespräch). Fragen direkt, aber höflich: Erfahrung, Motivation, Firmenwissen, Verfügbarkeit. Vorheriger Arbeitgeber nicht schlecht machen. Lohnangabe üblich: Spanne nach GAV. Papier-CV, Arbeitszeugnis, Diplome, Referenzen mitbringen. Dank-E-Mail binnen 24 h geschätzt. Antwortzeit 2-4 Wochen [Quelle: Tessiner Handelskammer Interview-Guide].",
      fr:
        "Les entretiens tessinois mêlent formalité suisse et chaleur latine. Ponctualité absolue (5 minutes d'avance), tenue formelle banques/assurances, business casual ailleurs. Poignée de main ferme, contact visuel. Éviter la familiarité : vouvoiement jusqu'à invitation au tutoiement (rare). Questions directes mais polies : expérience, motivation, connaissance de l'entreprise, disponibilité. Ne pas dénigrer les anciens employeurs. Ouverture sur le salaire normale : fourchette réaliste selon CCT. Apporter CV papier, Arbeitszeugnis, diplômes, références. E-mail de remerciement sous 24 h apprécié. Réponse 2-4 semaines [source : guide entretiens Chambre de commerce Tessin].",
    },
    sources: [
      'https://www.cc-ti.ch/',
    ],
  },
  {
    id: 'lavoro-settori-assumono-ticino',
    category: 'lavoro',
    question: {
      it: 'Quali sono i settori che assumono di più in Ticino nel 2026?',
      en: 'Which sectors hire most in Ticino in 2026?',
      de: 'Welche Branchen stellen 2026 im Tessin am meisten ein?',
      fr: 'Quels sont les secteurs qui recrutent le plus au Tessin en 2026 ?',
    },
    answer: {
      it:
        "Secondo l'Osservatorio del mercato del lavoro (IUSL-SUPSI) e l'Ufficio cantonale di statistica (USTAT), i settori a più forte dinamica nel 2026 sono: sanità (infermieri, medici, OSS, con deficit strutturale >2.000 posti), industria farmaceutica e biotech (Roche Mendrisio, Galenica, IBSA Lugano), informatica e cybersecurity (polo AlpTransit, EPFL Lugano), turismo e gastronomia (CCL ristorazione, alta stagione estiva), logistica e edilizia [fonte: USTAT, Rapporto occupazione 2026]. Banche e private banking restano importanti ma in contrazione (-3% occupati 2024-2026). Per i frontalieri il settore sanitario offre CCL con minimo CHF 4.500/mese e turni flessibili. L'industria 4.0 di Mendrisio-Stabio cerca periti meccatronici con tedesco. Offerte aggiornate su jobs.ch, jobup.ch, admin.ch.",
      en:
        "Per the Labour Market Observatory (IUSL-SUPSI) and the Cantonal Statistics Office (USTAT), the most dynamic sectors in 2026 are: healthcare (nurses, doctors, auxiliaries, structural deficit >2,000 posts), pharma and biotech (Roche Mendrisio, Galenica, IBSA Lugano), IT and cybersecurity (AlpTransit hub, EPFL Lugano), tourism and catering (CLA restaurants, summer peak), logistics and construction [source: USTAT 2026 employment report]. Banks and private banking remain important but contracting (-3% employed 2024-2026). Healthcare offers CLA minimum CHF 4,500/month and flexible shifts for cross-border workers. Industry 4.0 in Mendrisio-Stabio seeks mechatronic technicians with German. Postings on jobs.ch, jobup.ch, admin.ch.",
      de:
        "Laut Arbeitsmarktobservatorium (IUSL-SUPSI) und USTAT sind die dynamischsten Branchen 2026: Gesundheit (Pflege, Ärzte, FaGe, strukturelles Defizit >2'000 Stellen), Pharma und Biotech (Roche Mendrisio, Galenica, IBSA Lugano), IT und Cybersecurity (AlpTransit, EPFL Lugano), Tourismus und Gastronomie (GAV Gastgewerbe, Sommerspitze), Logistik und Bau [Quelle: USTAT Beschäftigungsbericht 2026]. Banken und Private Banking: rückläufig (-3 % Beschäftigte 2024-2026). Gesundheit: GAV-Minimum CHF 4'500/Mt. und flexible Schichten. Industrie 4.0 Mendrisio-Stabio sucht Mechatroniker mit Deutsch. Stellen auf jobs.ch, jobup.ch, admin.ch.",
      fr:
        "Selon l'Observatoire du marché du travail (IUSL-SUPSI) et l'USTAT, les secteurs les plus dynamiques en 2026 sont : santé (infirmiers, médecins, ASSC, déficit structurel >2 000 postes), pharma et biotech (Roche Mendrisio, Galenica, IBSA Lugano), informatique et cybersécurité (pôle AlpTransit, EPFL Lugano), tourisme et restauration (CCT restauration, pic été), logistique et construction [source : USTAT rapport emploi 2026]. Banques et private banking en contraction (-3 % emplois 2024-2026). Santé : CCT minimum CHF 4 500/mois et horaires flexibles pour frontaliers. Industrie 4.0 Mendrisio-Stabio cherche mécatroniciens germanophones. Offres sur jobs.ch, jobup.ch, admin.ch.",
    },
    relatedLinks: [
      {
        href: '/job-board/',
        label: {
          it: 'Offerte Ticino aggiornate',
          en: 'Latest Ticino jobs',
          de: 'Aktuelle Stellen Tessin',
          fr: 'Offres Tessin à jour',
        },
      },
    ],
    sources: [
      'https://www3.ti.ch/ustat/',
    ],
  },
  {
    id: 'lavoro-permesso-lavoro-tempo-determinato',
    category: 'lavoro',
    question: {
      it: 'Un contratto a tempo determinato dà diritto al permesso G?',
      en: 'Does a fixed-term contract give right to a G permit?',
      de: 'Gibt ein befristeter Vertrag Anrecht auf die G-Bewilligung?',
      fr: 'Un contrat à durée déterminée donne-t-il droit au permis G ?',
    },
    answer: {
      it:
        "Sì, il permesso G è rilasciato anche per contratti a tempo determinato (CTD), con durata pari al contratto fino a un massimo di 5 anni [fonte: Fedlex OLCP RS 142.203 art. 7]. Per contratti fino a 3 mesi basta la notifica online via EasyGov senza rilascio fisico del permesso (procedura semplificata ALC art. 9 Allegato I). Per contratti 3-12 mesi si rilascia il permesso di durata limitata. Alla scadenza del CTD il permesso decade salvo rinnovo o nuovo contratto. Se il contratto si trasforma in tempo indeterminato, il permesso si prolunga automaticamente a 5 anni. L'interinale (via Adecco, Randstad) ottiene un permesso G collegato a un unico «datore di lavoro a prestito» anche se cambia mandato. I contratti stagionali (hotellerie, edilizia) seguono la stessa procedura.",
      en:
        "Yes, the G permit is also issued for fixed-term contracts (CTD), for the contract duration up to 5 years [source: Fedlex OLCP RS 142.203 art. 7]. Contracts up to 3 months require only online notification on EasyGov without physical permit (simplified AFMP art. 9 Annex I procedure). Contracts 3-12 months get a time-limited permit. On expiry the permit lapses unless renewed or replaced by a new contract. Conversion to open-ended extends the permit to 5 years automatically. Temp agency workers (Adecco, Randstad) get a G linked to a single «service provider» employer even when assignments change. Seasonal contracts (hospitality, construction) follow the same procedure.",
      de:
        "Ja, die G-Bewilligung wird auch für befristete Verträge (CTD) erteilt, Dauer = Vertragsdauer, max. 5 Jahre [Quelle: Fedlex VFP SR 142.203 Art. 7]. Verträge bis 3 Monate: nur Online-Meldung EasyGov ohne physische Bewilligung (vereinfachtes Verfahren FZA Art. 9 Anhang I). 3-12 Mt.: zeitlich beschränkte Bewilligung. Bei Ablauf erlischt sie, sofern kein Neuvertrag. Umwandlung in unbefristet: automatische Verlängerung auf 5 Jahre. Temporärarbeitende (Adecco, Randstad) erhalten G-Bewilligung auf den Personalverleiher auch bei Mandatswechsel. Saisonverträge analog.",
      fr:
        "Oui, le permis G est également délivré pour les CDD, durée = contrat, max 5 ans [source : Fedlex OLCP RS 142.203 art. 7]. Contrats jusqu'à 3 mois : simple annonce en ligne sur EasyGov sans permis physique (procédure simplifiée ALCP art. 9 Annexe I). 3-12 mois : permis de durée limitée. À l'échéance le permis cesse sauf renouvellement. Transformation en CDI : permis prolongé automatiquement à 5 ans. Intérimaires (Adecco, Randstad) : G lié à un seul « bailleur de services » même en cas de changement de mission. Contrats saisonniers : même procédure.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/759/it',
    ],
  },
];
