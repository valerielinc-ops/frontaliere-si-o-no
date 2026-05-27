import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "lamal" (AE-5, 10/100).
 *
 * Scope: premi LAMal, franchigia, sussidi, medici di frontiera,
 * diritto d'opzione per il SSN italiano, modelli assicurativi.
 */
export const FAQ_lamal: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'lamal-obbligo-assicurazione-frontalieri',
    category: 'lamal',
    question: {
      it: 'I frontalieri devono obbligatoriamente assicurarsi con la LAMal?',
      en: 'Must cross-border workers mandatorily take out LAMal insurance?',
      de: 'Müssen Grenzgänger zwingend eine KVG-Versicherung abschliessen?',
      fr: 'Les frontaliers doivent-ils obligatoirement souscrire une assurance LAMal ?',
    },
    answer: {
      it:
        "In linea di principio sì: l'art. 3 cpv. 1 LAMal e l'OAMal art. 1 cpv. 2 lett. d stabiliscono l'obbligo di assicurazione per chi lavora in Svizzera, frontalieri inclusi [fonte: Fedlex LAMal RS 832.10]. Entro 3 mesi dall'inizio dell'attività occorre scegliere: (a) polizza LAMal svizzera; (b) esercitare il diritto di opzione e restare iscritti al SSN italiano tramite formulario E106/S1 consegnato all'Istituto comune LAMal del Cantone Ticino; (c) per i residenti in Italia, Francia, Germania o Austria con Paese dell'UE/AELS, una copertura equivalente nel Paese di residenza. L'assenza di copertura dopo i 3 mesi comporta iscrizione d'ufficio con supplemento fino al 50% sui premi arretrati (art. 5 cpv. 2 LAMal).",
      en:
        "In principle yes: LAMal art. 3 para. 1 and KVV art. 1 para. 2 lit. d establish mandatory insurance for those working in Switzerland, including cross-border workers [source: Fedlex LAMal RS 832.10]. Within 3 months of starting work one must choose: (a) a Swiss LAMal policy; (b) exercise the option right and stay enrolled with the Italian SSN via form E106/S1 filed with the LAMal Joint Institution Ticino; (c) for residents of Italy, France, Germany or Austria, equivalent cover in the country of residence. No cover after 3 months triggers forced enrolment plus a surcharge up to 50% on back premiums (LAMal art. 5 para. 2).",
      de:
        "Grundsätzlich ja: KVG Art. 3 Abs. 1 und KVV Art. 1 Abs. 2 Bst. d begründen die Versicherungspflicht für in der Schweiz Erwerbstätige, auch Grenzgänger [Quelle: Fedlex KVG SR 832.10]. Binnen 3 Monaten ab Stellenantritt wählt man: (a) Schweizer KVG-Police; (b) Optionsrecht und Verbleib im italienischen SSN mittels Formular E106/S1 bei der Gemeinsamen Einrichtung KVG Tessin; (c) als Einwohner von Italien, Frankreich, Deutschland oder Österreich gleichwertige Deckung im Wohnsitzland. Ohne Deckung nach 3 Monaten zwangsweise Zuweisung plus Zuschlag bis 50 % rückwirkend (Art. 5 Abs. 2 KVG).",
      fr:
        "En principe oui : art. 3 al. 1 LAMal et art. 1 al. 2 let. d OAMal instaurent l'obligation d'assurance pour ceux qui travaillent en Suisse, frontaliers compris [source : Fedlex LAMal RS 832.10]. Dans les 3 mois suivant l'embauche, choisir : (a) police LAMal suisse ; (b) droit d'option et maintien au SSN italien via formulaire E106/S1 remis à l'Institution commune LAMal Tessin ; (c) pour les résidents d'Italie, France, Allemagne ou Autriche, couverture équivalente dans le pays de résidence. À défaut, affiliation d'office et majoration jusqu'à 50 % sur primes arriérées (LAMal art. 5 al. 2).",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/lamal-frontalieri/',
        label: {
          it: 'Guida LAMal frontalieri',
          en: 'LAMal cross-border guide',
          de: 'KVG Grenzgänger-Leitfaden',
          fr: 'Guide LAMal frontaliers',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1995/1328_1328_1328/it',
      'https://www.kvg.org/',
    ],
  },
  {
    id: 'lamal-diritto-opzione-ssn',
    category: 'lamal',
    question: {
      it: 'Come si esercita il diritto d\'opzione per il SSN italiano?',
      en: 'How is the option right for the Italian SSN exercised?',
      de: 'Wie wird das Optionsrecht für das italienische SSN ausgeübt?',
      fr: 'Comment exercer le droit d\'option pour le SSN italien ?',
    },
    answer: {
      it:
        "Il diritto d'opzione permette al frontaliere residente in Italia di restare iscritto al SSN italiano e rinunciare alla LAMal. Si esercita entro 3 mesi dall'inizio del lavoro inviando il modulo «Opzione» all'Istituto comune LAMal (Berna), allegando formulario S1/E106 rilasciato dalla ASL di residenza [fonte: Gemeinsame Einrichtung KVG, direttiva A3/2024]. In cambio il datore di lavoro trattiene un contributo di 7,5% sullo stipendio fino a un tetto definito (CHF 70.000 nel 2024) che finanzia il «contributo assistenza sanitaria» versato all'INPS via Confederazione [fonte: Accordo CH-IT 2020 art. 4]. L'opzione è irrevocabile fino alla cessazione del rapporto di lavoro. Il S1 va rinnovato ogni tre anni tramite la ASL.",
      en:
        "The option right lets Italian-resident cross-border workers stay in the SSN and waive LAMal. It is exercised within 3 months of starting work by sending the «Opzione» form to the LAMal Joint Institution (Bern) with S1/E106 issued by the local ASL [source: Gemeinsame Einrichtung KVG, directive A3/2024]. In return the employer withholds a 7.5% contribution on salary up to a ceiling (CHF 70,000 in 2024) funding the «health contribution» paid to INPS via the Confederation [source: CH-IT Agreement 2020 art. 4]. The option is irrevocable until the employment ends. The S1 must be renewed every three years at the ASL.",
      de:
        "Das Optionsrecht erlaubt dem in Italien wohnhaften Grenzgänger, im SSN zu bleiben und auf die KVG zu verzichten. Antrag binnen 3 Monaten ab Stellenantritt an die Gemeinsame Einrichtung KVG (Bern) mit S1/E106 der ASL [Quelle: Gemeinsame Einrichtung KVG, Weisung A3/2024]. Der Arbeitgeber zieht 7,5 % vom Lohn bis Obergrenze (CHF 70 000 2024) ab als «Gesundheitsbeitrag» an INPS via Bund [Quelle: CH-IT-Abkommen 2020 Art. 4]. Das Optionsrecht ist unwiderruflich bis Vertragsende. S1 alle drei Jahre bei der ASL erneuern.",
      fr:
        "Le droit d'option permet au frontalier résident en Italie de rester au SSN et renoncer à la LAMal. S'exerce dans les 3 mois par envoi du formulaire « Opzione » à l'Institution commune LAMal (Berne) avec S1/E106 délivré par l'ASL [source : Gemeinsame Einrichtung KVG, directive A3/2024]. En retour l'employeur retient 7,5 % du salaire jusqu'à un plafond (CHF 70 000 en 2024) comme contribution santé versée à l'INPS via la Confédération [source : Accord CH-IT 2020 art. 4]. Irrévocable jusqu'à la fin du contrat. S1 à renouveler tous les trois ans à l'ASL.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/diritto-opzione-lamal/',
        label: {
          it: 'Diritto di opzione LAMal',
          en: 'LAMal option right',
          de: 'KVG-Optionsrecht',
          fr: "Droit d'option LAMal",
        },
      },
    ],
    sources: [
      'https://www.kvg.org/stakeholder/versicherer/versicherungspflicht/',
      'https://www.fedlex.admin.ch/eli/cc/2023/694/it',
    ],
  },
  {
    id: 'lamal-franchigia-ordinaria-scelta',
    category: 'lamal',
    question: {
      it: 'Qual è la franchigia LAMal più conveniente per un frontaliere?',
      en: 'Which LAMal deductible is most convenient for a cross-border worker?',
      de: 'Welche KVG-Franchise ist für einen Grenzgänger am günstigsten?',
      fr: 'Quelle franchise LAMal est la plus avantageuse pour un frontalier ?',
    },
    answer: {
      it:
        "L'art. 64 LAMal e l'OPre fissano franchigie ordinarie da CHF 300 (base) fino a CHF 2.500 (franchigia massima volontaria) [fonte: Fedlex OPre RS 832.102 art. 93]. Per un frontaliere in salute con <1 visita/anno, una franchigia alta (CHF 2.500) abbatte il premio del 40% circa e conviene se le prestazioni annue restano sotto CHF 2.700 (franchigia + 10% quota-parte fino a CHF 700). Per chi ha cure continuative (gravidanza, malattia cronica) la franchigia base CHF 300 è preferibile. L'UFSP pubblica un calcolatore di convenienza su priminfo.admin.ch. Il cambio di franchigia si effettua entro il 30 novembre, effettivo dal 1° gennaio. Per i minori la franchigia massima è CHF 600.",
      en:
        "LAMal art. 64 and KLV set ordinary deductibles from CHF 300 (standard) up to CHF 2,500 (max voluntary) [source: Fedlex KLV RS 832.102 art. 93]. A healthy worker with <1 visit/year saves around 40% on the premium with the CHF 2,500 deductible if annual care stays under ~CHF 2,700 (deductible + 10% co-pay up to CHF 700). For ongoing care (pregnancy, chronic illness) the standard CHF 300 is better. UFSP publishes a calculator on priminfo.admin.ch. Deductible change by 30 November, effective 1 January. For minors max deductible is CHF 600.",
      de:
        "KVG Art. 64 und KLV legen ordentliche Franchisen von CHF 300 (Basis) bis CHF 2'500 (höchste freiwillige) fest [Quelle: Fedlex KLV SR 832.102 Art. 93]. Für Gesunde mit <1 Arztbesuch/Jahr senkt CHF 2'500 die Prämie um ~40 %, vorteilhaft wenn Behandlungen <~CHF 2'700 bleiben (Franchise + 10 % Selbstbehalt bis CHF 700). Bei chronischen Erkrankungen oder Schwangerschaft Basis CHF 300 bevorzugen. BAG-Rechner auf priminfo.admin.ch. Wechsel bis 30. November, wirksam 1. Januar. Minderjährige max. CHF 600.",
      fr:
        "L'art. 64 LAMal et l'OPAS fixent les franchises ordinaires de CHF 300 (base) à CHF 2 500 (maximum volontaire) [source : Fedlex OPAS RS 832.102 art. 93]. Pour un frontalier en bonne santé (<1 visite/an) CHF 2 500 réduit la prime d'environ 40 %, avantageux si les soins annuels restent sous ~CHF 2 700 (franchise + 10 % quote-part jusqu'à CHF 700). En cas de soins continus (grossesse, maladie chronique) préférer CHF 300. L'OFSP publie un calculateur sur priminfo.admin.ch. Changement au 30 novembre, effet au 1er janvier. Mineurs plafond CHF 600.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1995/4964_4964_4964/it',
      'https://www.priminfo.admin.ch/',
    ],
  },
  {
    id: 'lamal-sussidi-premi',
    category: 'lamal',
    question: {
      it: 'Un frontaliere con LAMal ha diritto ai sussidi per i premi?',
      en: 'Is a cross-border worker under LAMal entitled to premium subsidies?',
      de: 'Hat ein Grenzgänger mit KVG Anrecht auf Prämienverbilligung?',
      fr: 'Un frontalier sous LAMal a-t-il droit aux subventions de primes ?',
    },
    answer: {
      it:
        "Sì ma con vincoli: i sussidi (riduzione individuale dei premi, RIP) sono disciplinati dall'art. 65 LAMal e delegati ai Cantoni [fonte: Fedlex LAMal RS 832.10]. In Ticino la Legge cantonale d'applicazione LAMal art. 33 estende il diritto ai frontalieri «imponibili alla fonte». La domanda si presenta all'Istituto delle assicurazioni sociali (IAS) entro il 31 gennaio sul portale iasti.ch allegando certificato di salario, cedolino di gennaio e attestato di famiglia. Il calcolo considera reddito familiare lordo e numero di figli. Nel 2026 la soglia è circa CHF 60.000 per un single e CHF 90.000 per una coppia con un figlio. Il sussidio è versato direttamente all'assicuratore, riducendo la fattura mensile.",
      en:
        "Yes but conditionally: premium subsidies (individual premium reduction, RIP) are ruled by LAMal art. 65 and delegated to the Cantons [source: Fedlex LAMal RS 832.10]. In Ticino the Cantonal LAMal application law art. 33 extends entitlement to withholding-taxed cross-border workers. Apply to IAS by 31 January on iasti.ch with salary certificate, January payslip and family certificate. The calculation considers gross family income and children. In 2026 thresholds are about CHF 60,000 (single) and CHF 90,000 (couple with one child). The subsidy is paid directly to the insurer, lowering the monthly invoice.",
      de:
        "Ja bedingt: Prämienverbilligungen (IPV) nach KVG Art. 65 sind Kantonssache [Quelle: Fedlex KVG SR 832.10]. Im Tessin erstreckt Art. 33 KVGG den Anspruch auf quellensteuerpflichtige Grenzgänger. Antrag bei IAS bis 31. Januar auf iasti.ch mit Lohnausweis, Januarlohn und Familienbescheinigung. Bemessung nach Bruttofamilieneinkommen und Kinderzahl. 2026 Schwellen ca. CHF 60'000 (alleinstehend) und CHF 90'000 (Paar mit einem Kind). Auszahlung direkt an den Versicherer, reduziert monatliche Rechnung.",
      fr:
        "Oui sous conditions : les subsides (réduction individuelle de primes, RIP) art. 65 LAMal sont délégués aux cantons [source : Fedlex LAMal RS 832.10]. Au Tessin la LApLAMal art. 33 étend le droit aux frontaliers imposés à la source. Demande à IAS avant le 31 janvier sur iasti.ch avec certificat de salaire, fiche de janvier et certificat de famille. Calcul selon revenu familial brut et enfants. En 2026 seuils ~CHF 60 000 (célibataire) et CHF 90 000 (couple + 1 enfant). Subvention versée directement à l'assureur.",
    },
    sources: [
      'https://www.iasti.ch/',
      'https://www4.ti.ch/dss/ias/sai/sussidi-cassa-malati',
    ],
  },
  {
    id: 'lamal-medico-frontaliera',
    category: 'lamal',
    question: {
      it: 'Posso scegliere un medico in Italia con la LAMal?',
      en: 'Can I choose a doctor in Italy under LAMal?',
      de: 'Kann ich unter der KVG einen Arzt in Italien wählen?',
      fr: 'Puis-je choisir un médecin en Italie avec la LAMal ?',
    },
    answer: {
      it:
        "Sì: i frontalieri coperti da LAMal e residenti in uno Stato UE/AELS godono del diritto all'«assistenza internazionale» previsto dall'art. 41 cpv. 2ter LAMal e dal Regolamento UE 883/2004 [fonte: Fedlex LAMal RS 832.10]. Significa che possono farsi curare sia in Svizzera sia nel Paese di residenza (Italia) alle tariffe del sistema SSN italiano, con il documento S1 rilasciato dall'Istituto comune LAMal. I medici di libera scelta (non convenzionati LAMal) in Italia sono quindi accessibili tramite SSN. Per cure non urgenti in un terzo Stato UE serve la preautorizzazione S2. La LAMal rimborsa fino al doppio della tariffa svizzera se si sceglie un fornitore privato non convenzionato in Italia.",
      en:
        "Yes: cross-border workers under LAMal who reside in an EU/EFTA state enjoy the «international care» right of LAMal art. 41 para. 2ter and EU Regulation 883/2004 [source: Fedlex LAMal RS 832.10]. They can be treated in Switzerland or in their country of residence (Italy) at Italian SSN rates via the S1 document from the LAMal Joint Institution. Any Italian SSN doctor is accessible. Non-urgent care in a third EU state requires prior S2 authorisation. LAMal reimburses up to twice the Swiss tariff for private Italian providers.",
      de:
        "Ja: KVG-Grenzgänger mit Wohnsitz in einem EU/EFTA-Staat haben Anspruch auf «internationale Leistungserbringung» gemäss KVG Art. 41 Abs. 2ter und EU-VO 883/2004 [Quelle: Fedlex KVG SR 832.10]. Behandlung wahlweise in der Schweiz oder im Wohnland (Italien) zu SSN-Tarifen mittels Dokument S1 der Gemeinsamen Einrichtung KVG. Jeder SSN-Arzt zugänglich. Nicht dringende Behandlung in einem dritten EU-Land braucht S2-Vorbewilligung. KVG erstattet bis zum doppelten Schweizer Tarif bei privaten Leistungserbringern in Italien.",
      fr:
        "Oui : les frontaliers LAMal résidant dans un État UE/AELE ont droit aux « soins internationaux » art. 41 al. 2ter LAMal et règlement UE 883/2004 [source : Fedlex LAMal RS 832.10]. Soins possibles en Suisse ou dans le pays de résidence (Italie) aux tarifs SSN via le document S1 de l'Institution commune LAMal. Tout médecin SSN accessible. Les soins non urgents dans un État tiers UE requièrent l'autorisation S2. LAMal rembourse jusqu'au double du tarif suisse chez un prestataire privé italien.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1995/1328_1328_1328/it',
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
    ],
  },
  {
    id: 'lamal-modelli-assicurativi',
    category: 'lamal',
    question: {
      it: 'Qual è la differenza tra modello di base, medico di famiglia e HMO?',
      en: 'What is the difference between standard, family-doctor and HMO models?',
      de: 'Was ist der Unterschied zwischen Standardmodell, Hausarzt und HMO?',
      fr: 'Quelle différence entre modèle standard, médecin de famille et HMO ?',
    },
    answer: {
      it:
        "La LAMal consente modelli alternativi (art. 62 LAMal) a premi ridotti [fonte: Fedlex LAMal RS 832.10]. Il modello standard («libera scelta del medico») ha il premio pieno. Il modello «medico di famiglia» obbliga a consultare prima un medico referente (riduzione 5-15%). Il modello «HMO» prevede accesso solo a un centro sanitario convenzionato (sconto 15-20%). Il «Telmed» obbliga a chiamare una hotline medica prima della visita (15% di sconto). Il «farmaco-generico» obbliga all'uso di generici (<5%). Il frontaliere sceglie al momento della sottoscrizione e può cambiare ogni anno entro il 30 novembre. Tutti i modelli coprono le stesse prestazioni di base (catalogo KLV), solo la via d'accesso cambia.",
      en:
        "LAMal allows alternative insurance models (art. 62) at reduced premiums [source: Fedlex LAMal RS 832.10]. The standard model («free doctor choice») charges the full premium. The «family-doctor» model requires a gatekeeper visit first (5-15% discount). The HMO model provides access only through a contracted health centre (15-20% discount). «Telmed» requires calling a medical hotline before visiting (15% off). «Generic» forces generic drug use (<5%). The worker chooses at underwriting and can switch each year by 30 November. All models cover the same KLV basic catalogue, only access differs.",
      de:
        "KVG Art. 62 erlaubt Alternativmodelle mit Prämienrabatt [Quelle: Fedlex KVG SR 832.10]. Standardmodell (freie Arztwahl) volle Prämie. Hausarztmodell: erst Hausarzt (5-15 % Rabatt). HMO-Modell: nur Vertragszentrum (15-20 %). Telmed: medizinische Hotline vor Arztbesuch (15 %). Generika-Modell: Zwang zu Generika (<5 %). Wahl beim Abschluss, jährlicher Wechsel bis 30. November. Alle Modelle decken denselben KLV-Grundkatalog.",
      fr:
        "La LAMal permet des modèles alternatifs (art. 62) à primes réduites [source : Fedlex LAMal RS 832.10]. Modèle standard (libre choix) : prime pleine. Médecin de famille : gatekeeper obligatoire (5-15 % de rabais). HMO : accès via centre contractuel (15-20 %). Telmed : hotline médicale préalable (15 %). Génériques : médicaments génériques imposés (<5 %). Choix à la souscription, changement annuel avant 30 novembre. Tous couvrent le catalogue OPAS de base.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1995/1328_1328_1328/it',
      'https://www.priminfo.admin.ch/',
    ],
  },
  {
    id: 'lamal-premi-2026-ticino',
    category: 'lamal',
    question: {
      it: 'Quali sono i premi LAMal medi in Ticino per il 2026?',
      en: 'What are the average 2026 LAMal premiums in Ticino?',
      de: 'Wie hoch sind die durchschnittlichen KVG-Prämien 2026 im Tessin?',
      fr: 'Quelles sont les primes LAMal moyennes 2026 au Tessin ?',
    },
    answer: {
      it:
        "L'UFSP ha pubblicato i premi 2026 il 24 settembre 2025 [fonte: UFSP, comunicato 24/09/2025]. Il premio medio adulto (con franchigia 300 CHF e copertura infortuni) in Ticino è circa CHF 404/mese (+3,1% sul 2025). Per i giovani 19-25 anni il premio medio è CHF 285, per i bambini CHF 107. Le variazioni cantonali sono significative: Appenzello Interno CHF 220, Ginevra CHF 445. I frontalieri pagano il premio pieno della regione di scelta (di solito regione 1, Lugano-Mendrisio). I sussidi RIP possono ridurre il premio fino al 50% per famiglie con reddito basso. L'UFSP pubblica i dati aggiornati su priminfo.admin.ch con il calcolatore ufficiale.",
      en:
        "UFSP published 2026 premiums on 24 September 2025 [source: UFSP press release 24/09/2025]. The average adult premium (CHF 300 deductible, with accident cover) in Ticino is about CHF 404/month (+3.1% vs 2025). Young adults 19-25 pay on average CHF 285, children CHF 107. Cantonal variation is large: Appenzell Inner CHF 220, Geneva CHF 445. Cross-border workers pay the full premium of the chosen region (usually region 1, Lugano-Mendrisio). Premium subsidies RIP may cut the premium up to 50% for low-income families. UFSP publishes current data on priminfo.admin.ch with the official calculator.",
      de:
        "Das BAG veröffentlichte die Prämien 2026 am 24. September 2025 [Quelle: BAG Medienmitteilung 24.09.2025]. Durchschnittsprämie Erwachsene (Franchise 300 CHF, mit Unfalldeckung) im Tessin ca. CHF 404/Monat (+3,1 % ggü. 2025). Junge Erwachsene 19-25: Ø CHF 285, Kinder CHF 107. Grosse Kantonsunterschiede: Appenzell Innerrhoden CHF 220, Genf CHF 445. Grenzgänger zahlen die volle Prämie der Wahlregion (meist Region 1 Lugano-Mendrisio). IPV kann Prämie für Haushalte mit geringem Einkommen um bis zu 50 % senken. Aktuelle Daten auf priminfo.admin.ch.",
      fr:
        "L'OFSP a publié les primes 2026 le 24 septembre 2025 [source : OFSP communiqué 24/09/2025]. Prime moyenne adulte (franchise CHF 300, couverture accidents) au Tessin ~CHF 404/mois (+3,1 % vs 2025). Jeunes adultes 19-25 ans : ~CHF 285, enfants CHF 107. Fortes variations cantonales : Appenzell Rhodes-Intérieures CHF 220, Genève CHF 445. Les frontaliers paient la prime pleine de la région choisie (souvent région 1 Lugano-Mendrisio). Le subside RIP peut réduire la prime jusqu'à 50 % pour les foyers modestes. Données actualisées sur priminfo.admin.ch.",
    },
    relatedLinks: [
      {
        href: '/statistiche/confronta-premi/',
        label: {
          it: 'Confronto premi LAMal',
          en: 'LAMal premium comparison',
          de: 'KVG-Prämienvergleich',
          fr: 'Comparaison des primes LAMal',
        },
      },
    ],
    sources: [
      'https://www.bag.admin.ch/bag/it/home/versicherungen/krankenversicherung/krankenversicherung-versicherte-mit-wohnsitz-in-der-schweiz/praemien.html',
      'https://www.priminfo.admin.ch/',
    ],
  },
  {
    id: 'lamal-cambio-assicuratore',
    category: 'lamal',
    question: {
      it: 'Come cambio assicuratore LAMal e quando?',
      en: 'How do I change LAMal insurer and when?',
      de: 'Wie und wann wechsle ich die KVG-Versicherung?',
      fr: 'Comment et quand changer d\'assureur LAMal ?',
    },
    answer: {
      it:
        "La LAMal garantisce la libera scelta dell'assicuratore (art. 7 LAMal) [fonte: Fedlex LAMal RS 832.10]. Si può disdire la polizza per il 31 dicembre inviando la lettera raccomandata entro il 30 novembre, oppure per il 30 giugno con preavviso al 31 marzo (solo se la franchigia è quella minima CHF 300). La disdetta per aumento del premio deve avvenire entro un mese dal ricevimento della comunicazione. Nessun certificato medico è richiesto per l'assicurazione di base, che gli assicuratori devono accettare per obbligo. Le complementari invece possono rifiutare o applicare sovrappremi. Confronta sempre su priminfo.admin.ch e verifica il modello (famiglia, HMO, Telmed) e la franchigia scelta.",
      en:
        "LAMal guarantees free choice of insurer (art. 7) [source: Fedlex LAMal RS 832.10]. You can cancel by 31 December (registered letter by 30 November) or by 30 June (notice by 31 March) — the latter only with the CHF 300 minimum deductible. Cancellation due to premium increase must be filed within one month of notice. No medical certificate is required for basic insurance; insurers must accept applicants. Supplementary covers can refuse or apply surcharges. Always compare on priminfo.admin.ch and check model and deductible.",
      de:
        "Das KVG garantiert freie Versichererwahl (Art. 7) [Quelle: Fedlex KVG SR 832.10]. Kündigung per 31. Dezember (eingeschriebener Brief bis 30. November) oder per 30. Juni (Kündigung bis 31. März) — Letzteres nur bei Mindestfranchise CHF 300. Kündigung wegen Prämienerhöhung innert 1 Monat ab Mitteilung. Für die Grundversicherung kein Arztzeugnis nötig; Annahmepflicht. Zusatzversicherungen können ablehnen oder Zuschläge erheben. Vergleich auf priminfo.admin.ch.",
      fr:
        "La LAMal garantit le libre choix de l'assureur (art. 7) [source : Fedlex LAMal RS 832.10]. Résiliation au 31 décembre (lettre recommandée avant 30 novembre) ou au 30 juin (préavis au 31 mars) — ce dernier uniquement avec franchise minimale CHF 300. Résiliation pour hausse de prime : 1 mois dès réception. Aucun certificat médical pour l'assurance de base, obligation d'accepter. Les complémentaires peuvent refuser ou majorer. Comparer sur priminfo.admin.ch.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1995/1328_1328_1328/it',
      'https://www.priminfo.admin.ch/',
    ],
  },
  {
    id: 'lamal-cure-dentali',
    category: 'lamal',
    question: {
      it: 'Le cure dentarie sono coperte dalla LAMal?',
      en: 'Does LAMal cover dental care?',
      de: 'Werden Zahnbehandlungen von der KVG gedeckt?',
      fr: 'Les soins dentaires sont-ils couverts par la LAMal ?',
    },
    answer: {
      it:
        "No, in via generale. L'art. 31 LAMal copre solo cure dentarie causate da malattia grave e inevitabile (es. leucemia, AIDS) o da incidente (se non c'è LAINF) [fonte: Fedlex LAMal RS 832.10]. Otturazioni, igiene, ortodonzia e protesi non sono rimborsate dalla base. Per queste prestazioni occorre una assicurazione complementare dentaria (da CHF 15-40 al mese) o una polizza privata con tetto annuo (CHF 1.500-3.000). Alcune polizze complementari rimborsano fino al 75% dei costi dopo un periodo di attesa di 3-6 mesi. Il frontaliere può anche farsi curare in Italia a prezzi più bassi usando il SSN o studi privati transfrontalieri: nessun rimborso LAMal, ma costi generalmente 40-60% inferiori rispetto alla Svizzera.",
      en:
        "Generally no. LAMal art. 31 covers dental care only if caused by serious unavoidable illness (e.g. leukaemia, AIDS) or by accident (without LAINF) [source: Fedlex LAMal RS 832.10]. Fillings, cleaning, orthodontics and prostheses are not reimbursed by basic insurance. Supplementary dental cover (CHF 15-40/month) or private policies with annual caps (CHF 1,500-3,000) are needed. Some supplementary plans reimburse up to 75% after 3-6 months waiting. Cross-border workers may also get treated in Italy at much lower prices via SSN or private cross-border practices: no LAMal reimbursement, but costs typically 40-60% lower.",
      de:
        "Grundsätzlich nein. KVG Art. 31 deckt zahnärztliche Leistungen nur bei schwerer, unvermeidbarer Krankheit (z. B. Leukämie, AIDS) oder Unfall (ohne UVG) [Quelle: Fedlex KVG SR 832.10]. Füllungen, Hygiene, Zahnspange und Prothesen sind nicht Teil der Grundversicherung. Nötig ist eine Zahnzusatzversicherung (CHF 15-40/Monat) oder Privatpolice mit Jahreslimit (CHF 1'500-3'000). Manche Zusatzversicherungen erstatten bis 75 % nach 3-6 Monaten Wartezeit. Behandlung in Italien via SSN oder grenznahe Privatpraxen ist 40-60 % günstiger — keine KVG-Erstattung.",
      fr:
        "En règle générale non. L'art. 31 LAMal ne couvre que les soins dentaires causés par maladie grave et inévitable (leucémie, SIDA…) ou accident (sans LAA) [source : Fedlex LAMal RS 832.10]. Plombages, hygiène, orthodontie et prothèses ne sont pas remboursés par l'assurance de base. Il faut une complémentaire dentaire (CHF 15-40/mois) ou une police privée avec plafond annuel (CHF 1 500-3 000). Certaines complémentaires remboursent jusqu'à 75 % après 3-6 mois de carence. Les frontaliers peuvent aussi se faire soigner en Italie (SSN ou privé transfrontalier) à des prix 40-60 % plus bas, sans remboursement LAMal.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1995/1328_1328_1328/it',
    ],
  },
  {
    id: 'lamal-infortuni-copertura-lainf',
    category: 'lamal',
    question: {
      it: 'Devo includere la copertura infortuni nella LAMal?',
      en: 'Should I include accident cover in LAMal?',
      de: 'Muss ich die Unfalldeckung in die KVG einschliessen?',
      fr: 'Dois-je inclure la couverture accidents dans la LAMal ?',
    },
    answer: {
      it:
        "Se lavori almeno 8 ore/settimana presso un datore di lavoro svizzero sei coperto obbligatoriamente dalla LAINF (Legge infortuni, RS 832.20) contro gli infortuni professionali e non professionali [fonte: Fedlex LAINF RS 832.20]. In questo caso puoi sospendere la copertura infortuni nella LAMal, riducendo il premio di circa CHF 8-15/mese. Comunica per iscritto all'assicuratore LAMal la sospensione allegando attestato del datore. Se cambi lavoro, sei disoccupato o riduci l'orario sotto le 8 ore, devi riattivare la copertura LAMal entro un mese. I frontalieri con più datori di lavoro part-time sommano le ore per verificare la soglia. Per infortuni all'estero valgono le stesse regole, con copertura in Italia ai tariffari SSN.",
      en:
        "If you work at least 8 hours/week for a Swiss employer you are automatically covered by LAINF (Accident Insurance Law, RS 832.20) for work and leisure accidents [source: Fedlex LAINF RS 832.20]. You can then suspend accident cover in LAMal, saving about CHF 8-15/month. Notify your LAMal insurer in writing with employer certificate. If you change jobs, become unemployed or drop below 8 hours, reactivate LAMal cover within one month. Workers with multiple part-time employers aggregate hours. For accidents abroad, Italian SSN rates apply.",
      de:
        "Bei mindestens 8 Wochenstunden beim Schweizer Arbeitgeber besteht obligatorische UVG-Deckung (SR 832.20) für Berufs- und Freizeitunfälle [Quelle: Fedlex UVG SR 832.20]. Dann kann die Unfalldeckung in der KVG sistiert werden (Prämie -CHF 8-15/Monat). Schriftliche Meldung an KVG-Versicherer mit Arbeitgeberbescheinigung. Bei Stellenwechsel, Arbeitslosigkeit oder weniger als 8 Stunden KVG-Deckung binnen 1 Monat reaktivieren. Teilzeitstunden werden addiert. Auslandsunfälle zu SSN-Tarifen.",
      fr:
        "Avec au moins 8 heures/semaine chez un employeur suisse, couverture LAA obligatoire (RS 832.20) pour accidents professionnels et non professionnels [source : Fedlex LAA RS 832.20]. Possibilité de suspendre la couverture accidents dans la LAMal (-CHF 8-15/mois). Notification écrite à l'assureur LAMal avec attestation employeur. En cas de changement, chômage ou sous 8 heures, réactivation sous 1 mois. Heures cumulées si plusieurs employeurs partiels. Accidents à l'étranger : tarifs SSN italiens.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1982/1676_1676_1676/it',
    ],
  },
];
