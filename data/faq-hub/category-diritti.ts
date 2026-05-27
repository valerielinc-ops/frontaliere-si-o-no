import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "diritti" (AE-5, 10/100).
 *
 * Scope: licenziamento (CO art. 335), malattia (LAMal + LPGA),
 * disoccupazione NASpI/AD, cassa integrazione (RHT), mobbing,
 * discriminazione.
 */
export const FAQ_diritti: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'diritti-licenziamento-ordinario-abusivo',
    category: 'diritti',
    question: {
      it: 'Un licenziamento è sempre legittimo in Svizzera?',
      en: 'Is dismissal always lawful in Switzerland?',
      de: 'Ist eine Kündigung in der Schweiz immer rechtmässig?',
      fr: 'Un licenciement est-il toujours licite en Suisse ?',
    },
    answer: {
      it:
        "No. Pur valendo il principio di libertà contrattuale (art. 335 CO), il licenziamento è abusivo se motivato da ragioni protette (art. 336 CO): cittadinanza, appartenenza etnica, opinioni religiose o politiche, attività sindacale, età, genere, stato di famiglia, segnalazione di irregolarità [fonte: Fedlex CO RS 220]. Il licenziamento abusivo espone il datore al pagamento di un'indennità fino a 6 mesi di salario (art. 336a CO). Protezione assoluta per malattia, gravidanza, congedo maternità/paternità, servizio militare e vacanze (art. 336c CO): licenziamento nullo. Ricorso al Tribunale del lavoro entro 180 giorni dalla cessazione. Il frontaliere può rivolgersi ai sindacati (OCST, UNIA, Syna) o all'Ufficio cantonale di conciliazione. Essendo cittadino UE, può pretendere applicazione della clausola di non-discriminazione ALC.",
      en:
        "No. Although the principle of contractual freedom applies (CO art. 335), dismissal is abusive if motivated by protected grounds (CO art. 336): nationality, ethnic background, religious or political opinion, trade-union activity, age, gender, family status, whistleblowing [source: Fedlex CO RS 220]. Abusive dismissal entails a compensation up to 6 months' salary (CO art. 336a). Absolute protection during illness, pregnancy, maternity/paternity leave, military service and holidays (CO art. 336c): dismissal is null. Appeal to the Labour Court within 180 days from termination. Cross-border workers may contact unions (OCST, UNIA, Syna) or the cantonal conciliation office. As EU citizens they invoke the AFMP non-discrimination clause.",
      de:
        "Nein. Trotz Vertragsfreiheit (OR Art. 335) ist eine Kündigung missbräuchlich, wenn sie aus geschützten Gründen erfolgt (OR Art. 336): Nationalität, Ethnie, Religion oder Politik, Gewerkschaftstätigkeit, Alter, Geschlecht, Familienstand, Whistleblowing [Quelle: Fedlex OR SR 220]. Missbräuchliche Kündigung: Entschädigung bis 6 Monatslöhne (OR Art. 336a). Absoluter Schutz während Krankheit, Schwangerschaft, Mutterschafts-/Vaterschaftsurlaub, Militärdienst, Ferien (OR Art. 336c): Kündigung nichtig. Klage beim Arbeitsgericht binnen 180 Tagen. Grenzgänger wenden sich an Gewerkschaften (OCST, UNIA, Syna) oder kantonale Schlichtungsbehörde. Als EU-Bürger berufen sie sich auf die FZA-Nichtdiskriminierungsklausel.",
      fr:
        "Non. Malgré la liberté contractuelle (CO art. 335), le licenciement est abusif s'il est motivé par des motifs protégés (CO art. 336) : nationalité, origine ethnique, opinion religieuse ou politique, activité syndicale, âge, sexe, situation familiale, dénonciation d'irrégularités [source : Fedlex CO RS 220]. Licenciement abusif : indemnité jusqu'à 6 mois de salaire (CO art. 336a). Protection absolue pendant maladie, grossesse, congés maternité/paternité, service militaire et vacances (CO art. 336c) : licenciement nul. Recours au tribunal du travail dans les 180 jours. Les frontaliers peuvent contacter les syndicats (OCST, UNIA, Syna) ou l'office cantonal de conciliation. En tant que citoyens UE, ils invoquent la clause ALCP de non-discrimination.",
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
    id: 'diritti-disoccupazione-naspi-frontaliere',
    category: 'diritti',
    question: {
      it: 'La NASpI italiana spetta al frontaliere licenziato dalla Svizzera?',
      en: 'Is the Italian NASpI available to a cross-border worker dismissed from Switzerland?',
      de: 'Hat der aus der Schweiz entlassene Grenzgänger Anspruch auf italienische NASpI?',
      fr: 'La NASpI italienne est-elle due au frontalier licencié en Suisse ?',
    },
    answer: {
      it:
        "Sì. Secondo il Regolamento UE 883/2004 art. 65, il frontaliere totalmente disoccupato ha diritto all'indennità nello Stato di residenza (Italia), sulla base delle contribuzioni versate all'estero [fonte: Eur-Lex reg. 883/2004]. Si chiede la NASpI (Nuova Assicurazione Sociale per l'Impiego) all'INPS online via SPID entro 68 giorni dalla cessazione, allegando il formulario U1 rilasciato dalla cassa di disoccupazione cantonale svizzera (Ticino: Cassa AD Bellinzona). La NASpI è pari al 75% della retribuzione media mensile imponibile ultimi 4 anni (fino a EUR 1.425/mese 2026), con durata max 24 mesi e riduzione del 3% al mese dal 4° mese. Il frontaliere in disoccupazione parziale (es. riduzione oraria) riceve indennità dalla cassa AD svizzera [fonte: art. 22-24 LAC].",
      en:
        "Yes. Under EU Reg. 883/2004 art. 65 a totally unemployed cross-border worker is entitled to benefits in the country of residence (Italy) based on foreign contributions [source: Eur-Lex reg. 883/2004]. Apply to INPS online via SPID within 68 days of termination, attaching the U1 form from the Swiss cantonal unemployment fund (Ticino: AD Bellinzona). NASpI is 75% of the average taxable monthly salary over the last 4 years (up to EUR 1,425/month in 2026), max 24 months, 3% monthly reduction from month 4. Partially unemployed cross-border workers (e.g. hour reduction) receive benefits from the Swiss AD fund [source: LACI art. 22-24].",
      de:
        "Ja. Gemäss EU-VO 883/2004 Art. 65 hat der voll arbeitslose Grenzgänger Anspruch auf Leistungen im Wohnland (Italien) auf Basis der ausländischen Beiträge [Quelle: Eur-Lex VO 883/2004]. NASpI-Antrag beim INPS online via SPID binnen 68 Tagen nach Ende mit U1 der schweizerischen kantonalen Arbeitslosenkasse (Tessin: ALV Bellinzona). NASpI: 75 % des durchschnittlichen steuerpflichtigen Monatslohns der letzten 4 Jahre (bis 1 425 €/Mt. 2026), max. 24 Monate, 3 % Reduktion ab 4. Monat. Teilweise arbeitslose Grenzgänger (Stundenreduktion) erhalten Leistung von der CH-ALV-Kasse [Quelle: AVIG Art. 22-24].",
      fr:
        "Oui. Selon le règl. UE 883/2004 art. 65, le frontalier totalement au chômage a droit à la prestation dans son pays de résidence (Italie) sur la base des cotisations étrangères [source : Eur-Lex règl. 883/2004]. Demande NASpI à l'INPS en ligne via SPID dans les 68 jours après la fin, avec formulaire U1 de la caisse cantonale suisse (Tessin : CCh Bellinzone). NASpI : 75 % du salaire mensuel moyen imposable des 4 dernières années (jusqu'à 1 425 €/mois 2026), max 24 mois, réduction 3 %/mois dès le 4e mois. Chômage partiel (réduction d'heures) : prestation payée par la caisse suisse [source : LACI art. 22-24].",
    },
    sources: [
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
      'https://www.inps.it/',
    ],
  },
  {
    id: 'diritti-cassa-integrazione-rht',
    category: 'diritti',
    question: {
      it: 'Posso beneficiare della cassa integrazione (RHT) come frontaliere?',
      en: 'Am I eligible for short-time work compensation (RHT) as a cross-border worker?',
      de: 'Kann ich als Grenzgänger Kurzarbeitsentschädigung (KAE) beziehen?',
      fr: 'Puis-je bénéficier de la réduction de l\'horaire de travail (RHT) en tant que frontalier ?',
    },
    answer: {
      it:
        "Sì. La LAC svizzera (Legge sull'assicurazione contro la disoccupazione, RS 837.0) art. 31 prevede l'indennità per lavoro ridotto (RHT) per chi è soggetto a perdita di lavoro temporanea (calo di ordini, COVID, eventi straordinari) [fonte: Fedlex LAC RS 837.0]. Il datore di lavoro presenta istanza all'Ufficio cantonale del lavoro; la durata max è 12 mesi in 2 anni. Il lavoratore a riduzione di orario riceve l'80% del salario perso direttamente in busta paga, finanziato dall'AD svizzera. Per i frontalieri il Regolamento UE 883/2004 art. 65 cpv. 1 lett. a assimila la riduzione di orario alla disoccupazione parziale, pagata dalla cassa AD cantonale svizzera. Non si applica la NASpI italiana. Il frontaliere deve restare disponibile al rientro a tempo pieno (no nuovo lavoro concorrenziale in Italia).",
      en:
        "Yes. The Swiss LACI (Unemployment Insurance Act, RS 837.0) art. 31 provides Short-Time Work Compensation (RHT) for those suffering temporary work loss (order drop, COVID, exceptional events) [source: Fedlex LACI RS 837.0]. The employer files with the cantonal labour office; max duration 12 months over 2 years. The worker with hours reduction receives 80% of lost salary directly on payroll, financed by Swiss AD. For cross-border workers EU Reg. 883/2004 art. 65 para. 1 lit. a assimilates hours reduction to partial unemployment, paid by the Swiss cantonal AD fund. Italian NASpI does not apply. The worker must remain available for full-time return (no competing Italian job).",
      de:
        "Ja. Das schweizerische AVIG (Arbeitslosenversicherungsgesetz SR 837.0) Art. 31 sieht Kurzarbeitsentschädigung (KAE) für temporären Arbeitsausfall (Auftragseinbruch, COVID, ausserordentliche Ereignisse) vor [Quelle: Fedlex AVIG SR 837.0]. Arbeitgeber meldet beim kantonalen Amt; max. 12 Monate in 2 Jahren. Arbeitnehmer mit Stundenreduktion erhält 80 % des Lohnausfalls direkt auf Lohnabrechnung, finanziert durch ALV. Für Grenzgänger assimiliert EU-VO 883/2004 Art. 65 Abs. 1 Bst. a Stundenreduktion = Teilarbeitslosigkeit, bezahlt durch kantonale ALV-Kasse. Italienische NASpI entfällt. Der Arbeitnehmer bleibt für Vollzeitrückkehr verfügbar (keine italienische Konkurrenzstelle).",
      fr:
        "Oui. La LACI suisse (loi sur l'assurance-chômage RS 837.0) art. 31 prévoit la RHT (réduction de l'horaire de travail) pour perte temporaire (baisse de commandes, COVID, événements extraordinaires) [source : Fedlex LACI RS 837.0]. L'employeur dépose une demande à l'office cantonal ; durée max 12 mois sur 2 ans. Le travailleur à horaire réduit reçoit 80 % du salaire perdu directement en paie, financé par l'AC. Pour les frontaliers, le règl. UE 883/2004 art. 65 al. 1 let. a assimile la réduction à chômage partiel payé par la caisse cantonale AC. La NASpI italienne ne s'applique pas. Disponibilité pour retour temps plein obligatoire (pas d'emploi concurrent en Italie).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1982/2184_2184_2184/it',
    ],
  },
  {
    id: 'diritti-mobbing-tutela',
    category: 'diritti',
    question: {
      it: 'Come ci si tutela dal mobbing in Svizzera?',
      en: 'How do I protect myself from mobbing in Switzerland?',
      de: 'Wie schützt man sich in der Schweiz vor Mobbing?',
      fr: 'Comment se protéger du mobbing en Suisse ?',
    },
    answer: {
      it:
        "Il datore di lavoro ha un obbligo di protezione della personalità dei dipendenti (art. 328 CO e art. 6 LL) [fonte: Fedlex CO RS 220, LL RS 822.11]. Il mobbing — molestie psicologiche ripetute nell'ambiente di lavoro — viola questo obbligo e espone il datore a responsabilità civile. Il frontaliere vittima può: (1) notificare per iscritto al datore la situazione (lettera A/R), (2) richiedere intervento dell'HR e del medico del lavoro, (3) rivolgersi al commissariato cantonale per le questioni di personalità (Ticino: Servizio per la personalità), (4) adire il Tribunale del lavoro entro 5 anni per risarcimento e riparazione (art. 49 CO). La giurisprudenza TF (BGE 130 III 699) riconosce indennità fino a CHF 20.000 per mobbing provato. Evidenze utili: email, testimonianze colleghi, certificati medici di depressione/ansia. Sindacati OCST, UNIA offrono consulenza gratuita.",
      en:
        "The employer has a duty to protect employees' personality (CO art. 328 and LTr art. 6) [source: Fedlex CO RS 220, LTr RS 822.11]. Mobbing — repeated psychological harassment at work — breaches this duty and triggers civil liability. A cross-border victim should: (1) notify the employer in writing (registered letter), (2) request HR and occupational physician intervention, (3) contact the cantonal personality office (Ticino: Servizio per la personalità), (4) sue before the Labour Court within 5 years for damages (CO art. 49). Federal Court case law (BGE 130 III 699) allows compensation up to CHF 20,000 for proven mobbing. Helpful evidence: emails, colleague testimonies, medical certificates of depression/anxiety. Unions OCST, UNIA give free advice.",
      de:
        "Der Arbeitgeber hat eine Fürsorgepflicht (OR Art. 328, ArG Art. 6) [Quelle: Fedlex OR SR 220, ArG SR 822.11]. Mobbing — wiederholte psychische Belästigung am Arbeitsplatz — verletzt diese Pflicht und begründet zivilrechtliche Haftung. Opfer-Grenzgänger sollten: (1) schriftlich melden (Einschreiben), (2) HR und Betriebsarzt einschalten, (3) kantonale Personalitätsstelle kontaktieren (Tessin: Servizio per la personalità), (4) binnen 5 Jahren vor Arbeitsgericht klagen (OR Art. 49). Bundesgericht (BGE 130 III 699) spricht bis CHF 20'000 Genugtuung zu. Beweise: E-Mails, Zeugenaussagen, ärztliche Zeugnisse. Gewerkschaften OCST, UNIA beraten gratis.",
      fr:
        "L'employeur a un devoir de protection de la personnalité (CO art. 328 et LTr art. 6) [source : Fedlex CO RS 220, LTr RS 822.11]. Le mobbing — harcèlement psychologique répété au travail — viole cette obligation et engage la responsabilité civile. La victime frontalière peut : (1) notifier l'employeur par écrit (recommandé), (2) solliciter RH et médecin du travail, (3) contacter l'office cantonal de la personnalité (Tessin : Servizio per la personalità), (4) saisir le tribunal du travail dans les 5 ans pour réparation (CO art. 49). Le TF (ATF 130 III 699) reconnaît des indemnités jusqu'à CHF 20 000. Preuves : e-mails, témoignages, certificats médicaux. Syndicats OCST, UNIA : conseils gratuits.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
      'https://www.bger.ch/',
    ],
  },
  {
    id: 'diritti-discriminazione-lavoro',
    category: 'diritti',
    question: {
      it: 'Sono tutelato contro la discriminazione sul lavoro come frontaliere?',
      en: 'Am I protected against workplace discrimination as a cross-border worker?',
      de: 'Bin ich als Grenzgänger vor Arbeitsplatz-Diskriminierung geschützt?',
      fr: 'Suis-je protégé contre la discrimination au travail en tant que frontalier ?',
    },
    answer: {
      it:
        "Sì. L'Accordo sulla libera circolazione (ALC) Allegato I art. 9 impone parità di trattamento tra lavoratori svizzeri ed UE/AELS per salario, prestazioni sociali, condizioni di lavoro, formazione [fonte: Fedlex ALC SR 0.142.112.681]. La Legge federale sulla parità dei sessi (LPar RS 151.1) vieta discriminazioni di genere per assunzione, promozione, licenziamento, salario [fonte: Fedlex LPar RS 151.1]. La Legge contro la discriminazione razziale (art. 261bis CP) sanziona penalmente incitamento all'odio e rifiuto di servizio pubblico basato sulla razza. Ricorsi: Tribunale del lavoro (LPar art. 10) con inversione dell'onere della prova; Commissione cantonale per la parità; Ufficio federale per l'uguaglianza UFU. Il frontaliere italiano può quindi contestare disparità salariale, mancato riconoscimento di anzianità o esclusione da formazioni aziendali. Compensazione fino a 6 mesi di salario (LPar art. 5).",
      en:
        "Yes. The Free Movement Agreement (AFMP) Annex I art. 9 requires equal treatment between Swiss and EU/EFTA workers on pay, social benefits, working conditions and training [source: Fedlex AFMP SR 0.142.112.681]. The Gender Equality Act (LPar RS 151.1) bans gender discrimination in hiring, promotion, dismissal, pay [source: Fedlex LPar RS 151.1]. The Anti-Racism Law (Criminal Code art. 261bis) criminalises incitement and racial exclusion from public services. Remedies: Labour Court (LPar art. 10) with reversed burden of proof; cantonal equality commission; Federal Office for Gender Equality FOGE. An Italian cross-border worker may contest pay gaps, seniority denials or exclusion from training. Compensation up to 6 months' salary (LPar art. 5).",
      de:
        "Ja. Das FZA Anhang I Art. 9 verlangt Gleichbehandlung zwischen Schweizer und EU/EFTA-Arbeitnehmern bei Lohn, Sozialleistungen, Arbeitsbedingungen und Weiterbildung [Quelle: Fedlex FZA SR 0.142.112.681]. Das Gleichstellungsgesetz (GlG SR 151.1) verbietet geschlechtsbezogene Diskriminierung bei Anstellung, Beförderung, Kündigung, Lohn [Quelle: Fedlex GlG SR 151.1]. Antirassismusartikel (StGB Art. 261bis) bestraft Hetze und rassistische Verweigerung öffentlicher Dienste. Rechtsweg: Arbeitsgericht (GlG Art. 10, Beweislastumkehr); kantonale Gleichstellungskommission; EBG. Italienische Grenzgänger können Lohngefälle, Dienstalter-Verweigerung oder Ausschluss von Weiterbildung rügen. Entschädigung bis 6 Monatslöhne (GlG Art. 5).",
      fr:
        "Oui. L'ALCP Annexe I art. 9 impose l'égalité de traitement entre travailleurs suisses et UE/AELE : salaire, prestations sociales, conditions et formation [source : Fedlex ALCP RS 0.142.112.681]. La loi sur l'égalité (LEg RS 151.1) interdit la discrimination de genre à l'embauche, la promotion, le licenciement, le salaire [source : Fedlex LEg RS 151.1]. L'article antiracisme (CP art. 261bis) punit l'incitation et l'exclusion raciste. Voies : tribunal du travail (LEg art. 10, renversement de la preuve) ; commission cantonale de l'égalité ; BFEG fédéral. Le frontalier italien peut contester l'écart salarial, le refus d'ancienneté ou l'exclusion de formations. Indemnité jusqu'à 6 mois de salaire (LEg art. 5).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2002/243/it',
      'https://www.fedlex.admin.ch/eli/cc/1996/1498_1498_1498/it',
    ],
  },
  {
    id: 'diritti-malattia-indennita-lpga',
    category: 'diritti',
    question: {
      it: 'Chi paga lo stipendio in caso di malattia lunga?',
      en: 'Who pays salary during long-term illness?',
      de: 'Wer zahlt den Lohn bei längerer Krankheit?',
      fr: 'Qui paie le salaire en cas de maladie prolongée ?',
    },
    answer: {
      it:
        "Oltre le scale CO (vedi FAQ stipendi) la AIGM collettiva (assicurazione indennità giornaliera malattia) subentra dal giorno 31 generalmente. Copre 720 giorni in 900 al 80-90% del salario, finanziata tramite contributi AIGM tra datore e dipendente [fonte: LPGA RS 830.1 e LCA 958.1]. Dopo 2 anni di malattia persistente, l'AI (Assicurazione Invalidità, RS 831.20) prende in carico il caso se la capacità lavorativa scende sotto 40% [fonte: Fedlex LAI RS 831.20]. Il frontaliere è assicurato AI come i residenti. L'AI può erogare prestazioni di riabilitazione (riqualifica professionale pagata) o rendite parziali/intere. Per le malattie causate dal lavoro (infortuni) interviene invece la LAINF (SUVA). La LPGA (Parte generale sul diritto delle assicurazioni sociali, RS 830.1) disciplina i termini di ricorso (30 giorni), l'obbligo di collaborazione e la procedura.",
      en:
        "Beyond the CO scale (see salary FAQ) the collective AIGM (daily illness allowance) kicks in from day 31 in most cases. It covers 720 days in 900 at 80-90% of salary, funded by AIGM contributions split employer/employee [source: LPGA RS 830.1 and LCA 958.1]. After 2 years of persistent illness the AI (Invalidity Insurance RS 831.20) takes over if work capacity drops below 40% [source: Fedlex LAI RS 831.20]. The cross-border worker is AI-insured as residents. AI may provide rehabilitation (paid retraining) or partial/full pensions. Work-caused illnesses/injuries fall under LAINF (SUVA). LPGA (Social Insurance General Act RS 830.1) governs appeal deadlines (30 days), duty to cooperate and procedure.",
      de:
        "Über die OR-Skala hinaus (siehe Lohn-FAQ) greift die kollektive KTG ab Tag 31 in den meisten Fällen. 720 Tage in 900 zu 80-90 %, finanziert durch KTG-Beiträge hälftig AG/AN [Quelle: ATSG SR 830.1 und VVG 958.1]. Nach 2 Jahren andauernder Krankheit übernimmt die IV (Invalidenversicherung SR 831.20) bei Arbeitsfähigkeit <40 % [Quelle: Fedlex IVG SR 831.20]. Grenzgänger IV-versichert wie Einwohner. IV-Rehabilitation (bezahlte Umschulung) oder Teil-/Ganzrenten möglich. Berufskrankheiten/Unfälle: UVG (SUVA). ATSG (Allg. Teil Sozialversicherungsrecht) regelt Rechtsmittel (30 Tage), Mitwirkungspflicht und Verfahren.",
      fr:
        "Au-delà des échelles CO (voir FAQ salaires) l'APGM collective (assurance perte de gain maladie) prend le relais dès le jour 31 en général. Couvre 720 jours sur 900 à 80-90 % du salaire, financée 50/50 [source : LPGA RS 830.1 et LCA 958.1]. Après 2 ans de maladie persistante, l'AI (assurance invalidité RS 831.20) prend en charge si capacité <40 % [source : Fedlex LAI RS 831.20]. Le frontalier est AI-assuré comme les résidents. L'AI propose réinsertion (reconversion payée) ou rente partielle/entière. Les maladies/accidents du travail relèvent de la LAA (SUVA). La LPGA (partie générale RS 830.1) régit les délais de recours (30 jours), l'obligation de collaborer et la procédure.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2002/510/it',
      'https://www.fedlex.admin.ch/eli/cc/63/1187_1185_1185/it',
    ],
  },
  {
    id: 'diritti-infortunio-sul-lavoro-suva',
    category: 'diritti',
    question: {
      it: 'Cosa fare se ho un infortunio sul lavoro?',
      en: 'What should I do in case of a workplace accident?',
      de: 'Was tun bei einem Arbeitsunfall?',
      fr: 'Que faire en cas d\'accident du travail ?',
    },
    answer: {
      it:
        "Notificare immediatamente l'incidente al datore di lavoro e richiedere compilazione del modulo di notifica infortunio, inviato alla SUVA (o altro assicuratore LAINF) entro 3 giorni [fonte: Fedlex LAINF RS 832.20]. Il medico cura il lavoratore e certifica l'inabilità al lavoro. La SUVA copre tutte le spese mediche senza franchigia (art. 10 LAINF), paga un'indennità giornaliera dell'80% del salario dal 3° giorno (art. 16 LAINF), e in caso di invalidità permanente eroga rendita fino al 80% del salario, o indennità per menomazione. Il frontaliere riceve le prestazioni anche se curato in Italia (con fattura tradotta). I dipendenti con <8 ore/settimana sono coperti solo per infortuni professionali. In caso di infortunio grave o mortale, notifica alla polizia + OCA (Organo cantonale sicurezza lavoro). Ricorso SUVA entro 30 giorni (LPGA art. 56).",
      en:
        "Notify the employer immediately and request the accident-notification form, sent to SUVA (or LAINF insurer) within 3 days [source: Fedlex LAINF RS 832.20]. The doctor treats and certifies work incapacity. SUVA covers all medical costs without deductible (LAINF art. 10), pays a daily allowance of 80% of salary from day 3 (LAINF art. 16), and in case of permanent disability pays a pension up to 80% of salary or impairment compensation. Cross-border workers receive benefits even when treated in Italy (translated invoice). Employees with <8 hours/week are covered only for work accidents. Severe or fatal accidents: notify police + OCA (Cantonal Work Safety Body). Appeal SUVA within 30 days (LPGA art. 56).",
      de:
        "Unfall sofort dem Arbeitgeber melden und Unfallmeldung ausfüllen lassen; binnen 3 Tagen an SUVA (oder UVG-Versicherer) [Quelle: Fedlex UVG SR 832.20]. Arzt behandelt und bescheinigt Arbeitsunfähigkeit. SUVA übernimmt alle Heilkosten ohne Franchise (UVG Art. 10), zahlt Taggeld 80 % des Lohns ab 3. Tag (UVG Art. 16) und bei Dauerinvalidität Rente bis 80 % oder Integritätsentschädigung. Grenzgänger erhalten Leistungen auch bei Behandlung in Italien (übersetzte Rechnung). Unter 8 Std./Woche nur Berufsunfälle gedeckt. Schwere/tödliche Unfälle: Polizei + OCA (Kantonale Arbeitsschutzbehörde). SUVA-Einsprache binnen 30 Tagen (ATSG Art. 56).",
      fr:
        "Signaler immédiatement l'accident à l'employeur et remplir la notification d'accident, envoyée à la SUVA (ou assureur LAA) sous 3 jours [source : Fedlex LAA RS 832.20]. Le médecin soigne et certifie l'incapacité. La SUVA couvre tous les frais médicaux sans franchise (LAA art. 10), verse une indemnité journalière 80 % du salaire dès le 3e jour (LAA art. 16) et, en cas d'invalidité permanente, une rente jusqu'à 80 % ou indemnité d'atteinte. Les frontaliers reçoivent les prestations même soignés en Italie (factures traduites). Moins de 8 h/sem. : couverture accidents professionnels seulement. Accident grave ou mortel : police + OCST sécurité au travail. Opposition SUVA sous 30 jours (LPGA art. 56).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1982/1676_1676_1676/it',
      'https://www.suva.ch/',
    ],
  },
  {
    id: 'diritti-tfr-equivalente-svizzera',
    category: 'diritti',
    question: {
      it: 'Esiste il TFR in Svizzera come in Italia?',
      en: 'Does Swiss law provide a TFR equivalent as in Italy?',
      de: 'Gibt es in der Schweiz ein italienisches TFR-Äquivalent?',
      fr: 'Existe-t-il un équivalent italien du TFR en Suisse ?',
    },
    answer: {
      it:
        "No, non esiste un TFR obbligatorio. L'indennità di partenza (art. 339b-339c CO) è prevista solo per i lavoratori ≥50 anni con ≥20 anni di servizio e corrisponde a 2-8 mesi di salario, ma è largamente sostituita dalle prestazioni del 2° pilastro (LPP) dal 1985 [fonte: Fedlex CO RS 220]. Al termine del rapporto il lavoratore riceve il cumulo delle sue quote LPP come rendita o capitale. Per il frontaliere questo corrisponde di fatto al TFR italiano. In Italia il datore svizzero non è obbligato a versare TFR perché il rapporto di lavoro è regolato dal diritto svizzero (CO art. 320). Se il frontaliere ha precedenti contributi INPS italiani (prima di diventare frontaliere), conserva il TFR accumulato fino a quel punto presso il Fondo Tesoreria o fondi pensione. Il 2° pilastro svizzero viene riconosciuto in Italia come previdenza complementare estera.",
      en:
        "No, there is no mandatory TFR. The severance indemnity (CO art. 339b-339c) is only due to workers aged ≥50 with ≥20 years of service and equals 2-8 months of salary; it has been largely replaced by 2nd-pillar (LPP) benefits since 1985 [source: Fedlex CO RS 220]. At contract end the worker gets the LPP accrued amount as pension or capital. For cross-border workers this is effectively the Italian TFR equivalent. In Italy the Swiss employer is not required to pay TFR since the employment is governed by Swiss law (CO art. 320). A cross-border worker with prior Italian INPS contributions keeps their accrued TFR with the Treasury Fund or pension funds. The Swiss 2nd pillar is recognised in Italy as foreign supplementary pension.",
      de:
        "Nein, es gibt kein obligatorisches TFR. Die Abgangsentschädigung (OR Art. 339b-339c) steht nur Arbeitnehmern ≥50 Jahre mit ≥20 Dienstjahren zu und beträgt 2-8 Monatslöhne; seit 1985 weitgehend durch BVG-Leistungen ersetzt [Quelle: Fedlex OR SR 220]. Bei Vertragsende erhält der Arbeitnehmer den BVG-Saldo als Rente oder Kapital. Für Grenzgänger entspricht dies faktisch dem italienischen TFR. Der Schweizer Arbeitgeber schuldet kein TFR, da der Vertrag schweizerischem Recht untersteht (OR Art. 320). Grenzgänger mit früheren INPS-Beiträgen behalten den angesparten TFR beim Treuhandfonds oder Pensionsfonds. Die 2. Säule wird in Italien als ausländische Vorsorge anerkannt.",
      fr:
        "Non, pas de TFR obligatoire. L'indemnité de départ (CO art. 339b-339c) n'est due qu'aux travailleurs ≥50 ans avec ≥20 ans de service, 2-8 mois de salaire ; largement remplacée par les prestations du 2e pilier (LPP) depuis 1985 [source : Fedlex CO RS 220]. À la fin du contrat le travailleur perçoit le solde LPP en rente ou capital. Pour les frontaliers c'est l'équivalent du TFR italien. L'employeur suisse ne doit pas de TFR, le contrat étant régi par le droit suisse (CO art. 320). Un frontalier avec cotisations INPS antérieures conserve son TFR accumulé au Fonds Tesoreria ou fonds de pension. Le 2e pilier suisse est reconnu en Italie comme prévoyance complémentaire étrangère.",
    },
    relatedLinks: [
      {
        href: '/tfr-calculator/',
        label: {
          it: 'Calcolatore TFR',
          en: 'TFR calculator',
          de: 'TFR-Rechner',
          fr: 'Calculateur TFR',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    ],
  },
  {
    id: 'diritti-certificato-lavoro-obbligo',
    category: 'diritti',
    question: {
      it: 'Il datore è obbligato a rilasciare un certificato di lavoro (Arbeitszeugnis)?',
      en: 'Must the employer issue a work certificate (Arbeitszeugnis)?',
      de: 'Muss der Arbeitgeber ein Arbeitszeugnis ausstellen?',
      fr: 'L\'employeur est-il obligé de délivrer un certificat de travail ?',
    },
    answer: {
      it:
        "Sì, obbligatoriamente (art. 330a CO) [fonte: Fedlex CO RS 220]. Il certificato di lavoro (Arbeitszeugnis) completo deve indicare: tipo di attività, durata, qualità del lavoro e del comportamento, redatto con «linguaggio codificato svizzero» (formule standardizzate neutre, mai negative esplicite). Il dipendente può scegliere tra certificato completo (Qualifikationszeugnis, preferibile) e semplice (solo durata + funzione). Obbligatorio anche durante il rapporto (certificato intermedio). Deve essere consegnato entro 1 mese dalla fine. Se contiene espressioni penalizzanti, il lavoratore può contestare in Tribunale del lavoro (180 giorni). Il datore che rifiuta o ritarda è condannato a un'indennità pari a max 2 mesi di salario (giurisprudenza TF 4A_137/2014). Codici noti: «vollste Zufriedenheit» = ottimo, «vollen» = buono, «Zufriedenheit» = sufficiente.",
      en:
        "Yes, mandatorily (CO art. 330a) [source: Fedlex CO RS 220]. A full work certificate (Arbeitszeugnis) must state: activity, duration, quality of work and conduct, written in Swiss-standard coded language (standardised neutral formulas, never explicitly negative). The employee can choose between full (Qualifikationszeugnis, preferred) and simple (duration + role only). Intermediate certificates are also required upon request during employment. Must be delivered within 1 month of end. If it contains penalising expressions the worker may sue at the Labour Court (180 days). Refusal or delay: compensation up to 2 months' salary (Federal Court 4A_137/2014). Known codes: «vollste Zufriedenheit» = excellent, «vollen» = good, «Zufriedenheit» = sufficient.",
      de:
        "Ja, zwingend (OR Art. 330a) [Quelle: Fedlex OR SR 220]. Ein vollständiges Arbeitszeugnis muss Tätigkeit, Dauer, Leistung und Verhalten angeben, in Schweizer Code-Sprache (standardisiert, nie explizit negativ). Arbeitnehmer wählt zwischen Vollzeugnis (Qualifikationszeugnis, bevorzugt) und einfachem (Dauer + Funktion). Zwischenzeugnis während Anstellung auf Verlangen. Auslieferung binnen 1 Monat nach Ende. Bei verschlechternden Formeln Klage beim Arbeitsgericht (180 Tage). Verweigerung oder Verzug: Entschädigung bis 2 Monatslöhne (BGer 4A_137/2014). Codes: «vollste Zufriedenheit» = sehr gut, «vollen» = gut, «Zufriedenheit» = genügend.",
      fr:
        "Oui, obligatoirement (CO art. 330a) [source : Fedlex CO RS 220]. Le certificat de travail complet (Arbeitszeugnis) doit indiquer : activité, durée, qualité du travail et du comportement, en langage codé suisse (formules standardisées neutres, jamais négatives explicites). Le salarié choisit entre complet (Qualifikationszeugnis, recommandé) et simple (durée + fonction). Certificat intermédiaire pendant l'emploi sur demande. À remettre sous 1 mois après la fin. Expressions pénalisantes : recours au tribunal du travail (180 jours). Refus ou retard : indemnité jusqu'à 2 mois (TF 4A_137/2014). Codes : « vollste Zufriedenheit » = excellent, « vollen » = bien, « Zufriedenheit » = suffisant.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    ],
  },
  {
    id: 'diritti-sindacati-frontalieri-associazioni',
    category: 'diritti',
    question: {
      it: 'A quali sindacati posso iscrivermi come frontaliere?',
      en: 'Which unions can I join as a cross-border worker?',
      de: 'In welche Gewerkschaften kann ich als Grenzgänger eintreten?',
      fr: 'À quels syndicats puis-je adhérer en tant que frontalier ?',
    },
    answer: {
      it:
        "I frontalieri possono iscriversi liberamente ai sindacati svizzeri per assistenza contrattuale, vertenze e consulenza legale. Le principali sigle in Ticino: OCST (Organizzazione Cristiano-Sociale Ticinese, 38.000 iscritti), UNIA (settore industria, edilizia, artigianato, 180.000 iscritti nazionali), Syna, USS (Unione Sindacale Svizzera) [fonte: SECO, registro sindacati]. Il contributo è CHF 30-50/mese. I sindacati svizzeri negoziano i CCL e assistono in caso di disputa con il datore di lavoro, licenziamento abusivo, mobbing. In Italia, i frontalieri possono iscriversi a CGIL, CISL, UIL che hanno sportelli dedicati a Como, Varese, Domodossola. La Camera Sindacale Transfrontaliera (CST) riunisce Ticino-Lombardia e offre consulenza bilingue. La quota sindacale è deducibile fiscalmente (IRPEF italiana max 5,164.57 €, e in NOV svizzera).",
      en:
        "Cross-border workers may freely join Swiss unions for contractual assistance, grievances and legal advice. Main Ticino unions: OCST (Christian-Social Ticino Organisation, 38,000 members), UNIA (industry, construction, crafts, 180,000 national), Syna, USS (Swiss Trade Union Confederation) [source: SECO union register]. Fee CHF 30-50/month. Swiss unions negotiate CLAs and assist in disputes, abusive dismissal, mobbing. In Italy, workers may join CGIL, CISL, UIL with dedicated desks in Como, Varese, Domodossola. The Cross-Border Union Chamber (CST) links Ticino-Lombardy and offers bilingual advice. Union fees are tax-deductible (Italian IRPEF max €5,164.57, and Swiss NOV).",
      de:
        "Grenzgänger können den Schweizer Gewerkschaften frei beitreten. Haupt-Tessiner Verbände: OCST (Christlich-Soziale Organisation Tessin, 38'000 Mitglieder), UNIA (Industrie, Bau, Gewerbe, 180'000 national), Syna, SGB [Quelle: SECO Gewerkschaftsregister]. Beitrag CHF 30-50/Monat. Schweizer Gewerkschaften verhandeln GAV und helfen bei Streitigkeiten, missbräuchlicher Kündigung, Mobbing. In Italien CGIL, CISL, UIL mit Büros in Como, Varese, Domodossola. Die Grenzüberschreitende Gewerkschaftskammer (CST) verbindet Tessin-Lombardei, zweisprachig. Beiträge abziehbar (IRPEF max 5 164,57 €, in CH-NOV).",
      fr:
        "Les frontaliers peuvent adhérer librement aux syndicats suisses pour assistance contractuelle, litiges et conseil juridique. Principales organisations tessinoises : OCST (Organisation chrétienne-sociale du Tessin, 38 000 membres), UNIA (industrie, construction, artisanat, 180 000 national), Syna, USS [source : registre syndical SECO]. Cotisation CHF 30-50/mois. Les syndicats suisses négocient les CCT et assistent en cas de conflit, licenciement abusif, mobbing. En Italie : CGIL, CISL, UIL avec guichets à Côme, Varèse, Domodossola. La Chambre syndicale transfrontalière (CST) lie Tessin-Lombardie avec conseil bilingue. Cotisations déductibles (IRPEF max 5 164,57 €, TOU suisse).",
    },
    relatedLinks: [
      {
        href: '/sindacati-frontalieri/',
        label: {
          it: 'Sindacati frontalieri',
          en: 'Cross-border unions',
          de: 'Grenzgänger-Gewerkschaften',
          fr: 'Syndicats frontaliers',
        },
      },
    ],
    sources: [
      'https://www.seco.admin.ch/',
    ],
  },
];
