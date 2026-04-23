import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "famiglia" (AE-5, 10/100).
 *
 * Scope: assegni familiari (Swiss vs IT), maternità 14 settimane,
 * figli IT vs CH, ricongiungimento G permit, congedo paternità.
 */
export const FAQ_famiglia: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'famiglia-assegni-familiari-lafam',
    category: 'famiglia',
    question: {
      it: 'Come funzionano gli assegni familiari LAFam per i frontalieri?',
      en: 'How do LAFam family allowances work for cross-border workers?',
      de: 'Wie funktionieren die FamZG-Familienzulagen für Grenzgänger?',
      fr: 'Comment fonctionnent les allocations familiales LAFam pour frontaliers ?',
    },
    answer: {
      it:
        "La LAFam (RS 836.2) prevede assegni familiari per ogni lavoratore soggetto ad AVS [fonte: Fedlex LAFam RS 836.2]. In Ticino nel 2026 sono CHF 200/mese per figlio fino a 16 anni (o fino a 25 se in formazione) e CHF 250 per figlio in formazione 16-25. In base al Regolamento UE 883/2004 art. 67, il frontaliere con figli residenti in Italia riceve il differenziale se l'assegno italiano (ANF o Assegno Unico Universale INPS) è inferiore a quello svizzero. La prassi: INPS calcola e paga l'Assegno Unico in Italia, il datore di lavoro svizzero integra la differenza tramite la Cassa di compensazione per assegni familiari (CCAF) cantonale. Il frontaliere deve fornire al datore e alla cassa CH il certificato di famiglia aggiornato + attestato INPS sull'importo dell'Assegno Unico.",
      en:
        "LAFam (RS 836.2) provides family allowances for every AVS-subject worker [source: Fedlex LAFam RS 836.2]. In Ticino 2026: CHF 200/month per child up to 16 (or 25 if in training) and CHF 250 per child in training age 16-25. Under EU Reg. 883/2004 art. 67, a cross-border worker with children resident in Italy receives the differential if the Italian allowance (ANF or INPS Universal Allowance) is lower than the Swiss one. Practice: INPS computes and pays the Italian Universal Allowance; the Swiss employer tops up the difference through the cantonal Family Allowance Compensation Office (CCAF). The worker must provide the employer and the CH office with an up-to-date family certificate + INPS statement of the allowance amount.",
      de:
        "FamZG (SR 836.2) sieht Familienzulagen für jeden AHV-pflichtigen Arbeitnehmer vor [Quelle: Fedlex FamZG SR 836.2]. Tessin 2026: CHF 200/Monat pro Kind bis 16 (oder 25 in Ausbildung), CHF 250 für Auszubildende 16-25. Gemäss EU-VO 883/2004 Art. 67 erhält der Grenzgänger mit Kindern in Italien die Differenz, wenn die italienische Zulage (ANF oder INPS Assegno Unico) tiefer ist. Praxis: INPS berechnet und zahlt die italienische Zulage; der Schweizer Arbeitgeber ergänzt über die kantonale Familienausgleichskasse (FAK). Arbeitnehmer muss Familienbescheinigung und INPS-Auszug einreichen.",
      fr:
        "La LAFam (RS 836.2) prévoit des allocations pour tout travailleur soumis à l'AVS [source : Fedlex LAFam RS 836.2]. Au Tessin 2026 : CHF 200/mois par enfant jusqu'à 16 ans (ou 25 en formation), CHF 250 en formation 16-25. Selon le règlement UE 883/2004 art. 67, le frontalier avec enfants en Italie reçoit le différentiel si l'allocation italienne (ANF ou Assegno Unico INPS) est inférieure. Pratique : l'INPS calcule et verse la prestation italienne ; l'employeur suisse comble la différence via la Caisse cantonale d'allocations familiales (CAF/CCAF). Le frontalier fournit l'attestation de famille et le relevé INPS.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/assegni-familiari-frontalieri/',
        label: {
          it: 'Assegni familiari frontalieri',
          en: 'Cross-border family allowances',
          de: 'Grenzgänger-Familienzulagen',
          fr: 'Allocations familiales frontaliers',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2008/108/it',
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
    ],
  },
  {
    id: 'famiglia-assegno-unico-universale-inps',
    category: 'famiglia',
    question: {
      it: 'Come si richiede l\'Assegno Unico Universale in Italia da frontaliere?',
      en: 'How do I apply for the Italian Universal Child Allowance as a cross-border worker?',
      de: 'Wie beantrage ich den italienischen Assegno Unico als Grenzgänger?',
      fr: 'Comment demander l\'Assegno Unico italien en tant que frontalier ?',
    },
    answer: {
      it:
        "L'Assegno Unico Universale (AUU) è stato istituito dal dlgs 230/2021 e sostituisce ANF, detrazioni figli e premio nascita [fonte: Normattiva, dlgs 230/2021]. Domanda su inps.it tramite SPID/CIE entro il 30 giugno per l'anno in corso (ritroattivo per marzo-maggio se presentata entro il 30 giugno). Importo 2026: da EUR 57,45 a EUR 199,40/mese per figlio in base all'ISEE familiare (<40.000 €, 40.000-45.000 €, >45.000 €). I figli maggiorenni 18-21 anni studenti o con basso reddito (<8.000 €) ricevono importo ridotto. Il frontaliere residente in Italia ha diritto pieno. Il datore di lavoro svizzero integra l'eventuale differenziale via CCAF (vedi domanda precedente). L'AUU non è tassato IRPEF e non concorre all'ISEE dell'anno successivo.",
      en:
        "The Universal Child Allowance (AUU) was created by dlgs 230/2021, replacing ANF, child tax credits and birth premium [source: Normattiva, dlgs 230/2021]. Apply on inps.it with SPID/CIE by 30 June of the year (retroactive to March-May if filed by 30 June). Amount in 2026: from EUR 57.45 to EUR 199.40/month per child based on the household ISEE (<40,000 €, 40,000-45,000 €, >45,000 €). Adult children 18-21 in study or low income (<€8,000) get a reduced amount. An Italian-resident cross-border worker has full rights. The Swiss employer tops up the differential via CCAF. AUU is not subject to IRPEF and does not count toward the next year's ISEE.",
      de:
        "Der Assegno Unico Universale (AUU) wurde durch GD 230/2021 eingeführt und ersetzt ANF, Kinderabzug und Geburtsprämie [Quelle: Normattiva, GD 230/2021]. Antrag auf inps.it mit SPID/CIE bis 30. Juni des Jahres (rückwirkend bis März-Mai bei Einreichung bis 30.06.). Betrag 2026: von 57,45 € bis 199,40 €/Monat pro Kind nach ISEE (<40 000 €, 40 000-45 000 €, >45 000 €). Volljährige 18-21 in Ausbildung oder mit geringem Einkommen (<8 000 €) erhalten reduzierten Betrag. In Italien wohnhafter Grenzgänger voll anspruchsberechtigt. Schweizer Arbeitgeber ergänzt Differenz via FAK. AUU nicht IRPEF-pflichtig und nicht im ISEE des Folgejahres.",
      fr:
        "L'Assegno Unico Universale (AUU) a été instauré par le décret 230/2021, remplaçant ANF, déductions pour enfants et prime de naissance [source : Normattiva décret 230/2021]. Demande sur inps.it avec SPID/CIE avant le 30 juin de l'année (rétroactif mars-mai si déposé au 30/06). Montant 2026 : de 57,45 € à 199,40 €/mois/enfant selon ISEE (<40 000 €, 40 000-45 000 €, >45 000 €). Enfants majeurs 18-21 ans en études ou revenu <8 000 € : montant réduit. Le frontalier résidant en Italie a droit plein. L'employeur suisse comble le différentiel via la CAF. L'AUU n'est pas imposable IRPEF et n'entre pas dans l'ISEE de l'année suivante.",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2021-12-21;230',
      'https://www.inps.it/',
    ],
  },
  {
    id: 'famiglia-maternita-congedo-ch-vs-it',
    category: 'famiglia',
    question: {
      it: 'Come funziona il congedo di maternità per una frontaliera?',
      en: 'How does maternity leave work for a cross-border worker?',
      de: 'Wie funktioniert der Mutterschaftsurlaub für Grenzgängerinnen?',
      fr: 'Comment fonctionne le congé de maternité pour une frontalière ?',
    },
    answer: {
      it:
        "In Svizzera l'IPG (LIPG RS 834.1) prevede 14 settimane di congedo retribuite all'80% del salario, max CHF 220/giorno (2025), attivabili tramite la Cassa di compensazione AVS [fonte: Fedlex LIPG RS 834.1]. La frontaliera lavoratrice svizzera ha pieno diritto come le residenti. Domanda con formulario 311.380 entro 5 anni dal parto, allegando certificato medico e Lohnausweis. In Italia parallelamente, il congedo obbligatorio è 5 mesi (2 pre + 3 post), retribuzione 80% dall'INPS (art. 16 dlgs 151/2001). Il principio di non-cumulo del Regolamento UE 883/2004 art. 10 impedisce di riscuotere due prestazioni per lo stesso evento: si riceve la svizzera e INPS integra eventualmente la parte residua. Il posto di lavoro svizzero è protetto (CO art. 336c). Allattamento: pausa 30-90 min giornalieri retribuiti fino al 1° anno.",
      en:
        "In Switzerland APG (LAPG RS 834.1) provides 14 weeks of paid leave at 80% of salary, max CHF 220/day (2025), via the AVS compensation office [source: Fedlex LAPG RS 834.1]. A cross-border worker employed in Switzerland has full rights like residents. Apply with form 311.380 within 5 years of birth, attaching medical certificate and Lohnausweis. In Italy mandatory leave is 5 months (2 pre + 3 post) paid at 80% by INPS (dlgs 151/2001 art. 16). The non-cumulation principle of EU Reg. 883/2004 art. 10 prevents double benefits for the same event: Swiss benefit is paid first, INPS tops up any residual. Swiss job is protected (CO art. 336c). Breastfeeding: 30-90 min paid daily break to age 1.",
      de:
        "In der Schweiz sieht EOG (SR 834.1) 14 Wochen bezahlten Mutterschaftsurlaub zu 80 % des Lohns, max. CHF 220/Tag (2025), via AHV-Ausgleichskasse vor [Quelle: Fedlex EOG SR 834.1]. In der CH beschäftigte Grenzgängerin voll anspruchsberechtigt. Antrag Formular 311.380 innert 5 Jahren mit Arztzeugnis und Lohnausweis. In Italien 5 Monate Pflicht (2 vor + 3 nach) zu 80 % INPS (GD 151/2001 Art. 16). EU-VO 883/2004 Art. 10 verbietet Kumulierung: CH-Leistung zuerst, INPS ergänzt Rest. Stelle geschützt (OR Art. 336c). Stillen: 30-90 Min. bezahlter Pausen bis Alter 1.",
      fr:
        "En Suisse l'APG (LAPG RS 834.1) prévoit 14 semaines de congé à 80 % du salaire, max CHF 220/jour (2025), via la caisse AVS [source : Fedlex LAPG RS 834.1]. La frontalière employée en Suisse a droit plein comme les résidentes. Demande formulaire 311.380 dans les 5 ans après la naissance avec certificat médical et Lohnausweis. En Italie le congé obligatoire est de 5 mois (2 avant + 3 après) à 80 % INPS (décret 151/2001 art. 16). Le règlement UE 883/2004 art. 10 interdit le cumul : prestation CH d'abord, INPS complète le reliquat. Poste protégé (CO art. 336c). Allaitement : 30-90 min de pause payée jusqu'à 1 an.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2005/187/it',
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2001-03-26;151',
    ],
  },
  {
    id: 'famiglia-paternita-congedo',
    category: 'famiglia',
    question: {
      it: 'Esiste il congedo di paternità in Svizzera per i frontalieri?',
      en: 'Is there a paternity leave in Switzerland for cross-border workers?',
      de: 'Gibt es einen Vaterschaftsurlaub in der Schweiz für Grenzgänger?',
      fr: 'Existe-t-il un congé paternité en Suisse pour les frontaliers ?',
    },
    answer: {
      it:
        "Sì. Dal 1° gennaio 2021 la LIPG (art. 16i-16j) prevede 2 settimane (10 giorni lavorativi) di congedo di paternità retribuito all'80% max CHF 220/giorno, da fruire entro 6 mesi dal parto [fonte: Fedlex LIPG RS 834.1]. Domanda con formulario 318.750 alla cassa di compensazione AVS. Il frontaliere padre lavoratore in Svizzera ha pieno diritto. In Italia il congedo padre è 10 giorni obbligatori retribuiti al 100% INPS (L. 234/2021), utilizzabili entro 5 mesi dalla nascita. L'EU Reg. 883/2004 consente all'uomo frontaliere di cumulare entrambi i congedi perché sono prestazioni distinte nei due Paesi, ma con tetto del salario effettivo. Alcuni CCL svizzeri prevedono congedi più generosi (es. UBS 20 giorni, Swisscom 4 settimane).",
      en:
        "Yes. Since 1 January 2021 LAPG (art. 16i-16j) provides 2 weeks (10 working days) of paternity leave paid at 80% max CHF 220/day, to be used within 6 months of birth [source: Fedlex LAPG RS 834.1]. Apply on form 318.750 with the AVS compensation office. A father cross-border worker employed in Switzerland has full rights. In Italy, paternity leave is 10 mandatory days paid 100% INPS (Law 234/2021), usable within 5 months. EU Reg. 883/2004 lets the male cross-border worker combine both leaves because they are distinct in the two countries, but capped at actual salary. Some Swiss CLAs are more generous (UBS 20 days, Swisscom 4 weeks).",
      de:
        "Ja. Seit 01.01.2021 sieht das EOG (Art. 16i-16j) 2 Wochen (10 Arbeitstage) Vaterschaftsurlaub zu 80 %, max. CHF 220/Tag vor, innerhalb 6 Monaten nach Geburt beziehbar [Quelle: Fedlex EOG SR 834.1]. Antrag Formular 318.750 bei AHV-Ausgleichskasse. Vater als Grenzgänger in CH voll anspruchsberechtigt. In Italien 10 Pflichttage zu 100 % INPS (Gesetz 234/2021), in 5 Monaten nutzbar. EU-VO 883/2004 erlaubt Kombination beider Urlaube als verschiedene Leistungen, begrenzt auf den tatsächlichen Lohn. GAV können mehr gewähren (UBS 20 Tage, Swisscom 4 Wochen).",
      fr:
        "Oui. Depuis le 01.01.2021, l'APG (art. 16i-16j) prévoit 2 semaines (10 jours ouvrables) de congé paternité à 80 %, max CHF 220/jour, à prendre dans les 6 mois suivant la naissance [source : Fedlex LAPG RS 834.1]. Demande formulaire 318.750 à la caisse AVS. Père frontalier employé en Suisse : droit plein. En Italie : 10 jours obligatoires à 100 % INPS (loi 234/2021), à prendre en 5 mois. Le règlement UE 883/2004 permet de cumuler les deux congés (prestations distinctes) dans la limite du salaire réel. Certaines CCT suisses sont plus généreuses (UBS 20 jours, Swisscom 4 semaines).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2005/187/it',
    ],
  },
  {
    id: 'famiglia-figli-asilo-nido-transfrontaliero',
    category: 'famiglia',
    question: {
      it: 'Posso iscrivere mio figlio all\'asilo nido in Svizzera?',
      en: 'Can I enrol my child in a Swiss daycare?',
      de: 'Kann ich mein Kind in einer Schweizer Kinderkrippe anmelden?',
      fr: 'Puis-je inscrire mon enfant à la crèche en Suisse ?',
    },
    answer: {
      it:
        "Gli asili nido («Nidi d'Infanzia»/Kita) svizzeri accettano bambini da 3 mesi a 3 anni a pagamento. I residenti pagano tariffe basate sul reddito (ordinanza cantonale LAsi 2019). I frontalieri pagano la tariffa piena (CHF 100-160/giorno, CHF 1.800-2.800/mese tempo pieno) perché i Comuni sussidiano solo i residenti [fonte: Ti.ch DECS, nidi infanzia]. Alcuni datori di lavoro (banche, industria farmaceutica) offrono nidi aziendali a tariffa ridotta come fringe benefit. La retta asilo è deducibile dalle imposte svizzere per chi è in NOV (art. 33 cpv. 3 LIFD, max CHF 25.000/anno/figlio). In Italia invece il Bonus Nido INPS rimborsa fino a EUR 3.000/anno in base all'ISEE. Il frontaliere può iscrivere i figli in Italia usando il Bonus Nido italiano, mantenendo in Svizzera solo se necessario.",
      en:
        "Swiss daycare («Nidi»/Kita) take children 3 months-3 years for a fee. Residents pay income-based rates (cantonal ordinance LAsi 2019). Cross-border workers pay the full fee (CHF 100-160/day, CHF 1,800-2,800/month full-time) because municipalities only subsidise residents [source: Ti.ch DECS, daycares]. Some employers (banks, pharma) offer subsidised corporate daycares as fringe benefits. The fee is tax-deductible in Switzerland for those on NOV (LIFD art. 33 para. 3, max CHF 25,000/year/child). In Italy the INPS Nursery Bonus refunds up to EUR 3,000/year based on ISEE. Cross-border workers often enrol children in Italy using the Italian Bonus and Swiss daycare only where needed.",
      de:
        "Schweizer Kitas nehmen Kinder von 3 Monaten bis 3 Jahren gegen Gebühr auf. Einwohner: einkommensabhängige Tarife (Kantons-VO LAsi 2019). Grenzgänger zahlen vollen Tarif (CHF 100-160/Tag, CHF 1'800-2'800/Mt. Vollzeit), da Gemeinden nur Einwohner subventionieren [Quelle: Ti.ch DECS Kitas]. Einige Arbeitgeber (Banken, Pharma) bieten verbilligte Firmen-Kitas als Fringe Benefit. Beiträge abziehbar in NOV (DBG Art. 33 Abs. 3, max CHF 25'000/Jahr/Kind). In Italien erstattet der INPS Bonus Nido bis 3 000 €/Jahr nach ISEE. Grenzgänger nutzen häufig IT-Kita mit Bonus und CH-Kita nur bei Bedarf.",
      fr:
        "Les crèches suisses accueillent les enfants de 3 mois à 3 ans contre paiement. Résidents : tarif selon revenu (ordonnance cantonale LAsi 2019). Les frontaliers paient le plein tarif (CHF 100-160/jour, CHF 1 800-2 800/mois temps plein) car les communes ne subventionnent que les résidents [source : Ti.ch DECS crèches]. Certains employeurs (banques, pharma) offrent des crèches d'entreprise subventionnées. Frais déductibles en TOU (LIFD art. 33 al. 3, max CHF 25 000/an/enfant). En Italie le Bonus Nido INPS rembourse jusqu'à 3 000 €/an selon ISEE. Les frontaliers inscrivent souvent les enfants en Italie avec le Bonus et recourent à la crèche suisse en complément.",
    },
    sources: [
      'https://www4.ti.ch/decs/',
    ],
  },
  {
    id: 'famiglia-borse-studio-figli-frontalieri',
    category: 'famiglia',
    question: {
      it: 'I figli di frontalieri possono ricevere borse di studio in Svizzera?',
      en: 'Can children of cross-border workers receive Swiss study grants?',
      de: 'Können Kinder von Grenzgängern Schweizer Stipendien erhalten?',
      fr: 'Les enfants de frontaliers peuvent-ils recevoir des bourses d\'études suisses ?',
    },
    answer: {
      it:
        "Le borse di studio cantonali sono riservate ai residenti in Svizzera (Legge cantonale borse di studio ticinese, art. 3) [fonte: Ti.ch, Ufficio aiuti studio]. I figli di frontalieri con permesso G residenti in Italia non possono quindi accedervi. Possono invece ottenere le borse di studio italiane regionali (Lombardia: Dote Scuola) o nazionali (DSU per università) con criteri ISEE. Eccezione: i figli di frontalieri iscritti a scuole universitarie professionali (SUP) o politecnici svizzeri (USI Lugano, SUPSI) possono beneficiare di sconti tasse interne o borse di merito erogate dall'ateneo stesso, indipendentemente dalla residenza. Le borse di talento di SUPSI sono 2.000-8.000 CHF/anno in base al merito. Tutte le università svizzere applicano tasse universitarie uniformi ai residenti UE/AELS (CHF 1.500-2.000/semestre).",
      en:
        "Cantonal study grants are reserved for Swiss residents (Ticino cantonal grants law, art. 3) [source: Ti.ch, Study Aid Office]. Children of G permit cross-border workers residing in Italy cannot apply. They can apply for Italian regional grants (Lombardy: Dote Scuola) or national (DSU for universities) with ISEE criteria. Exception: children of cross-border workers enrolled at Swiss universities of applied sciences (USI Lugano, SUPSI) can receive internal fee reductions or merit scholarships regardless of residence. SUPSI talent grants are CHF 2,000-8,000/year. All Swiss universities apply uniform fees to EU/EFTA students (CHF 1,500-2,000/semester).",
      de:
        "Kantonale Stipendien sind Einwohnern vorbehalten (Tessiner Stipendiengesetz Art. 3) [Quelle: Ti.ch Amt für Ausbildungsbeiträge]. Kinder von G-Grenzgängern in Italien haben keinen Zugang. Sie können italienische Regional- (Lombardei: Dote Scuola) oder Nationalstipendien (DSU Uni) nach ISEE beantragen. Ausnahme: Kinder an Schweizer Fachhochschulen (USI Lugano, SUPSI) können interne Gebührenermässigung oder Leistungsstipendien erhalten, unabhängig vom Wohnsitz. SUPSI-Talentstipendien: CHF 2'000-8'000/Jahr. Uniform-Studiengebühren für EU/EFTA-Studenten (CHF 1'500-2'000/Semester).",
      fr:
        "Les bourses cantonales sont réservées aux résidents (loi cantonale tessinoise sur les bourses art. 3) [source : Ti.ch Office aides aux études]. Les enfants de frontaliers G en Italie n'y ont pas droit. Ils peuvent demander des bourses italiennes régionales (Lombardie : Dote Scuola) ou nationales (DSU université) selon ISEE. Exception : enfants inscrits dans des hautes écoles suisses (USI Lugano, SUPSI) peuvent bénéficier de réductions internes ou bourses au mérite indépendamment du domicile. Bourses talents SUPSI : CHF 2 000-8 000/an. Frais universitaires uniformes pour étudiants UE/AELE (CHF 1 500-2 000/semestre).",
    },
    sources: [
      'https://www4.ti.ch/decs/ds/uast/',
    ],
  },
  {
    id: 'famiglia-ricongiungimento-coniuge-permesso-g',
    category: 'famiglia',
    question: {
      it: 'Mio coniuge non-UE può vivere in Italia con me frontaliere?',
      en: 'Can my non-EU spouse live with me in Italy as a cross-border worker?',
      de: 'Kann mein Ehepartner aus einem Drittstaat mit mir als Grenzgänger in Italien leben?',
      fr: 'Mon conjoint non-UE peut-il vivre avec moi en Italie en tant que frontalier ?',
    },
    answer: {
      it:
        "Sì. Il frontaliere cittadino UE/AELS o italiano ha diritto al ricongiungimento del coniuge non-UE in Italia secondo il dlgs 30/2007 (attuazione dir. UE 2004/38/CE) [fonte: Normattiva, dlgs 30/2007]. Documenti: certificato di matrimonio apostillato, richiesta di «carta di soggiorno di familiare di cittadino UE» presentata al Comune italiano di residenza entro 3 mesi dall'ingresso del coniuge. Durata 5 anni, rinnovabile. Non serve visto d'ingresso se viene da Paese con accordo Schengen; altrimenti visto familiare presso consolato italiano. Il coniuge può lavorare liberamente in Italia senza permesso. Per il lavoro in Svizzera però serve il permesso G o B, con procedura separata via datore di lavoro svizzero. I figli minorenni non-UE ricevono parimenti la carta di soggiorno familiare.",
      en:
        "Yes. A cross-border worker who is EU/EFTA or Italian citizen has the right to reunite a non-EU spouse in Italy under dlgs 30/2007 (transposing EU dir. 2004/38/EC) [source: Normattiva, dlgs 30/2007]. Required: apostilled marriage certificate, application for «EU family-member residence card» filed with the Italian municipality within 3 months of spouse's entry. 5-year validity, renewable. No entry visa needed from Schengen countries; otherwise family visa at Italian consulate. The spouse may freely work in Italy without a separate permit. For Swiss work a G or B permit is needed via Swiss employer. Non-EU minor children likewise receive the family residence card.",
      de:
        "Ja. EU/EFTA- oder italienischer Grenzgänger hat das Recht auf Familiennachzug des Drittstaaten-Ehegatten in Italien gemäss GD 30/2007 (Umsetzung EU-Richtlinie 2004/38/EG) [Quelle: Normattiva, GD 30/2007]. Unterlagen: apostillierte Heiratsurkunde, Antrag auf «Aufenthaltskarte für EU-Familienangehörige» bei italienischer Wohngemeinde binnen 3 Monaten nach Einreise. Gültigkeit 5 Jahre, verlängerbar. Kein Einreisevisum aus Schengen, sonst Familienvisum bei italienischer Vertretung. Ehepartner darf frei in Italien arbeiten. Für Schweizer Arbeit G- oder B-Bewilligung separat. Minderjährige Drittstaatenkinder erhalten ebenfalls die Familienaufenthaltskarte.",
      fr:
        "Oui. Un frontalier citoyen UE/AELE ou italien peut faire venir son conjoint non-UE en Italie selon le décret 30/2007 (transposition de la directive UE 2004/38/CE) [source : Normattiva décret 30/2007]. Documents : certificat de mariage apostillé, demande de « carte de séjour familial d'un citoyen UE » à la commune italienne dans les 3 mois. Validité 5 ans, renouvelable. Pas de visa d'entrée pour les Schengen ; sinon visa familial au consulat. Le conjoint peut travailler librement en Italie sans permis. Pour le travail suisse, permis G ou B nécessaire via employeur suisse. Enfants mineurs non-UE : carte de séjour familial également.",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2007-02-06;30',
    ],
  },
  {
    id: 'famiglia-tutela-minori-convenzione-aia',
    category: 'famiglia',
    question: {
      it: 'In caso di separazione, dove si decide l\'affidamento dei figli?',
      en: 'In case of separation, where is child custody decided?',
      de: 'Wo wird bei Trennung das Sorgerecht für Kinder entschieden?',
      fr: 'En cas de séparation, où se décide la garde des enfants ?',
    },
    answer: {
      it:
        "La competenza è del tribunale dello Stato di residenza abituale dei minori (Reg. UE 2019/1111 «Bruxelles II-ter») [fonte: Eur-Lex reg. 2019/1111]. Se la famiglia vive in Italia e il frontaliere lavora in Svizzera, il tribunale ordinario italiano (Tribunale dei minorenni o sezione specializzata) decide. Se invece la residenza dei figli è in Svizzera, competente è il tribunale cantonale svizzero secondo LDIP. La Convenzione dell'Aia del 1996 sul diritto dei minori disciplina la cooperazione tra autorità per sentenze transfrontaliere [fonte: Fedlex SR 0.211.231.011]. Per gli assegni alimentari frontalieri, si applica il Reg. UE 4/2009: sentenza italiana eseguibile direttamente in CH via certificazione. Il frontaliere che paga l'assegno può dedurlo dal reddito imponibile svizzero in NOV (art. 33 LIFD). Mediazione familiare è obbligatoria in Ticino prima della causa (art. 297 CPC).",
      en:
        "Jurisdiction lies with the court of the child's habitual residence (EU Reg. 2019/1111 «Brussels II-ter») [source: Eur-Lex reg. 2019/1111]. If the family lives in Italy and the worker commutes to Switzerland, the Italian ordinary court (juvenile tribunal or specialised section) decides. If children reside in Switzerland, the cantonal court applies per LDIP. The 1996 Hague Convention on Child Protection governs cross-border cooperation [source: Fedlex SR 0.211.231.011]. For cross-border alimony, EU Reg. 4/2009: Italian judgment directly enforceable in CH via certification. The cross-border worker paying alimony can deduct it from Swiss taxable income in NOV (LIFD art. 33). Family mediation is compulsory in Ticino before trial (CPC art. 297).",
      de:
        "Zuständig ist das Gericht des gewöhnlichen Kindesaufenthalts (EU-VO 2019/1111 «Brüssel II-ter») [Quelle: Eur-Lex VO 2019/1111]. Lebt die Familie in Italien und der Grenzgänger pendelt in die Schweiz, entscheidet das italienische ordentliche Gericht (Jugendgericht oder Sonderkammer). Leben die Kinder in der Schweiz: kantonales Gericht nach IPRG. Haager Kinderschutzübereinkommen 1996: grenzüberschreitende Behördenkooperation [Quelle: Fedlex SR 0.211.231.011]. Grenzüberschreitender Unterhalt: EU-VO 4/2009, italienisches Urteil in CH direkt vollstreckbar (Bescheinigung). Unterhaltszahlender Grenzgänger kann in NOV abziehen (DBG Art. 33). Mediation im Tessin zwingend vor Verfahren (ZPO Art. 297).",
      fr:
        "Compétence au tribunal de la résidence habituelle des enfants (règl. UE 2019/1111 « Bruxelles II-ter ») [source : Eur-Lex règl. 2019/1111]. Si la famille vit en Italie et le frontalier travaille en Suisse, le tribunal ordinaire italien (tribunal pour mineurs ou section spécialisée) décide. Si les enfants résident en Suisse : tribunal cantonal selon LDIP. Convention de La Haye 1996 sur la protection des enfants : coopération transfrontalière [source : Fedlex RS 0.211.231.011]. Pensions alimentaires : règl. UE 4/2009, jugement italien directement exécutoire en CH via certification. Le frontalier payant la pension peut la déduire en TOU (LIFD art. 33). Médiation familiale obligatoire au Tessin avant procès (CPC art. 297).",
    },
    sources: [
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32019R1111',
    ],
  },
  {
    id: 'famiglia-anf-italia-restituzione-arretrati',
    category: 'famiglia',
    question: {
      it: 'Gli arretrati dell\'ANF italiano possono essere richiesti dal frontaliere?',
      en: 'Can a cross-border worker claim back Italian ANF arrears?',
      de: 'Kann ein Grenzgänger italienische ANF-Rückstände einfordern?',
      fr: 'Un frontalier peut-il réclamer les arriérés d\'ANF italiens ?',
    },
    answer: {
      it:
        "L'Assegno per il Nucleo Familiare (ANF) è stato abolito dal 1° marzo 2022 per i nuclei con figli e sostituito dall'AUU [fonte: Normattiva, dlgs 230/2021]. Tuttavia ANF resta per nuclei «senza figli» (coniuge invalido, fratelli a carico, ecc.). Per gli arretrati ANF fino a febbraio 2022 il frontaliere può presentare domanda tardiva all'INPS entro 5 anni dall'avvio del diritto (prescrizione quinquennale art. 6 L. 138/1943). Serve il modulo SR16 + dichiarazione dei redditi familiari. L'ANF italiano aveva scaglioni di reddito annuo, 7 tipologie di nucleo, 30 fasce di importo. Il frontaliere che non ha richiesto l'ANF per anni 2017-2021 può ancora recuperarlo via tardiva. Per i periodi 2022-2026 AUU: recupero via INPS con conguaglio.",
      en:
        "The Italian Family Allowance (ANF) was abolished on 1 March 2022 for families with children, replaced by AUU [source: Normattiva, dlgs 230/2021]. ANF however remains for «childless» households (disabled spouse, dependent siblings). For ANF arrears up to February 2022 the cross-border worker can file a late application with INPS within 5 years (5-year prescription, Law 138/1943 art. 6). Requires form SR16 + family income statement. Italian ANF had income brackets, 7 household types, 30 amount tiers. Cross-border workers who did not claim ANF for 2017-2021 can still recover it via late application. For 2022-2026 AUU arrears: recovery via INPS balance.",
      de:
        "Der italienische ANF-Familienzuschlag wurde am 01.03.2022 für Haushalte mit Kindern durch AUU ersetzt [Quelle: Normattiva, GD 230/2021]. ANF bleibt für «kinderlose» Haushalte (invalide Ehepartner, unterstützte Geschwister). Rückstände bis Februar 2022 können binnen 5 Jahren nachträglich beim INPS beantragt werden (Verjährung Gesetz 138/1943 Art. 6). Formular SR16 + Einkommenserklärung. Italienischer ANF hatte Einkommensstufen, 7 Haushaltstypen, 30 Beträge. Nicht beantragte ANF 2017-2021 können über Nachantrag geholt werden. Für 2022-2026 AUU: Nachberechnung via INPS.",
      fr:
        "L'ANF italien a été supprimé le 01/03/2022 pour les foyers avec enfants et remplacé par l'AUU [source : Normattiva décret 230/2021]. L'ANF reste pour les foyers « sans enfants » (conjoint handicapé, frères à charge). Arriérés ANF jusqu'à février 2022 : demande tardive à l'INPS dans les 5 ans (prescription, loi 138/1943 art. 6). Formulaire SR16 + déclaration de revenus familiaux. L'ANF italien avait des tranches de revenus, 7 types de foyers, 30 niveaux. Les frontaliers qui n'ont pas demandé l'ANF 2017-2021 peuvent encore le récupérer en tardive. Pour 2022-2026 AUU : régularisation via INPS.",
    },
    sources: [
      'https://www.inps.it/',
    ],
  },
  {
    id: 'famiglia-cura-genitori-anziani-ricongiungimento',
    category: 'famiglia',
    question: {
      it: 'Posso assistere i miei genitori anziani in Italia come frontaliere?',
      en: 'Can I care for my elderly parents in Italy as a cross-border worker?',
      de: 'Kann ich als Grenzgänger meine betagten Eltern in Italien pflegen?',
      fr: 'Puis-je m\'occuper de mes parents âgés en Italie en tant que frontalier ?',
    },
    answer: {
      it:
        "Sì. Il frontaliere residente in Italia può beneficiare dei permessi italiani L. 104/1992 (3 giorni/mese) se ha genitori disabili e continua a lavorare in Svizzera [fonte: Normattiva, L. 104/1992]. In questi casi la retribuzione del giorno è a carico INPS via datore svizzero che compensa con la Cassa di compensazione AVS (Reg. UE 883/2004 art. 21). Per assenze prolungate il frontaliere può richiedere congedo straordinario retribuito di 2 anni cumulabili art. 42 cpv. 5 dlgs 151/2001 [fonte: Normattiva, dlgs 151/2001]. Il datore svizzero è obbligato a concedere congedi non retribuiti per cure familiari per assimilazione ALC. In Svizzera esiste anche il congedo di cura per familiari gravemente malati (14 settimane pagato 80% IPG, art. 16n LIPG dal 2021) accessibile al frontaliere.",
      en:
        "Yes. An Italian-resident cross-border worker can use Italian L. 104/1992 leaves (3 days/month) for disabled parents while working in Switzerland [source: Normattiva, L. 104/1992]. The daily pay is covered by INPS through the Swiss employer in compensation with the AVS office (EU Reg. 883/2004 art. 21). For longer absences, extraordinary paid leave of up to 2 years cumulative is possible per dlgs 151/2001 art. 42 para. 5 [source: Normattiva, dlgs 151/2001]. The Swiss employer must grant unpaid family-care leave by AFMP assimilation. Switzerland also has care leave for severely ill family members (14 weeks paid 80% APG, LAPG art. 16n since 2021) available to cross-border workers.",
      de:
        "Ja. Ein in Italien wohnhafter Grenzgänger kann italienische L. 104/1992 Urlaube (3 Tage/Mt.) für behinderte Eltern nutzen, während er in CH arbeitet [Quelle: Normattiva, L. 104/1992]. Lohn zahlt INPS via Schweizer Arbeitgeber mit Ausgleich über AHV-Kasse (EU-VO 883/2004 Art. 21). Längere Abwesenheiten: bezahlter Sonderurlaub bis 2 Jahre kumulativ nach GD 151/2001 Art. 42 Abs. 5 [Quelle: Normattiva, GD 151/2001]. Schweizer Arbeitgeber muss unbezahlten Pflegurlaub analog FZA gewähren. In CH gibt es ferner den Betreuungsurlaub für schwerkranke Familienangehörige (14 Wochen 80 % EOG, LAPG Art. 16n seit 2021).",
      fr:
        "Oui. Le frontalier résidant en Italie peut utiliser les congés italiens L. 104/1992 (3 jours/mois) pour parents handicapés tout en travaillant en Suisse [source : Normattiva L. 104/1992]. La rémunération de la journée est à la charge de l'INPS via l'employeur suisse avec compensation par la caisse AVS (règl. UE 883/2004 art. 21). Pour des absences plus longues : congé extraordinaire payé jusqu'à 2 ans cumulés selon décret 151/2001 art. 42 al. 5 [source : Normattiva décret 151/2001]. L'employeur suisse doit accorder un congé non payé pour soins familiaux par assimilation ALCP. En Suisse existe aussi le congé de prise en charge (14 semaines à 80 % APG, LAPG art. 16n depuis 2021).",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1992-02-05;104',
    ],
  },
];
