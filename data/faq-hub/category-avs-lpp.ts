import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "avs-lpp" (AE-5, 10/100).
 *
 * Scope: AVS (1° pilastro), LPP (2° pilastro), contributi, riscatto,
 * età pensionabile, pensione vedova, pilastro 3a.
 */
export const FAQ_avsLpp: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'avs-lpp-contributi-aliquote-2026',
    category: 'avs-lpp',
    question: {
      it: 'Quali contributi AVS/AI/IPG paga un frontaliere nel 2026?',
      en: 'Which AVS/AI/APG contributions does a cross-border worker pay in 2026?',
      de: 'Welche AHV/IV/EO-Beiträge zahlt ein Grenzgänger 2026?',
      fr: 'Quelles cotisations AVS/AI/APG paie un frontalier en 2026 ?',
    },
    answer: {
      it:
        "Il frontaliere paga i contributi al 1° pilastro secondo la LAVS (RS 831.10): 8,7% AVS + 1,4% AI + 0,5% IPG = 10,6% totale ripartito metà dipendente e metà datore [fonte: Fedlex LAVS RS 831.10, art. 5]. Si aggiungono 2,2% per l'assicurazione disoccupazione (AD/LAC) fino a CHF 148.200/anno (2025, rivalutato annualmente) e 1% sull'eccedenza (contributo di solidarietà). L'aliquota della quota dipendente è quindi 5,3% AVS/AI/IPG + 1,1% AD = 6,4% del salario lordo. I contributi sono obbligatori anche per i lavoratori a tempo parziale che superano CHF 2.500/anno. Le prestazioni AVS sono esportabili: l'accordo CH-UE 2002 garantisce il pagamento della rendita AVS in Italia senza riduzioni.",
      en:
        "The cross-border worker pays 1st-pillar contributions under LAVS (RS 831.10): 8.7% AVS + 1.4% AI + 0.5% APG = 10.6% total split 50/50 employee/employer [source: Fedlex LAVS RS 831.10 art. 5]. Add 2.2% unemployment (AD/LACI) up to CHF 148,200/year (2025, annually indexed) and 1% on the excess (solidarity). The employee share is therefore 5.3% AVS/AI/APG + 1.1% AD = 6.4% of gross salary. Contributions are mandatory also for part-timers earning over CHF 2,500/year. AVS benefits are exportable: the CH-EU 2002 agreement ensures AVS pension payment in Italy without reductions.",
      de:
        "Der Grenzgänger zahlt Beiträge zur 1. Säule gemäss AHVG (SR 831.10): 8,7 % AHV + 1,4 % IV + 0,5 % EO = 10,6 % insgesamt, hälftig Arbeitnehmer/Arbeitgeber [Quelle: Fedlex AHVG SR 831.10 Art. 5]. Dazu 2,2 % Arbeitslosenversicherung (ALV) bis CHF 148'200/Jahr (2025, jährlich indexiert) und 1 % Solidaritätsbeitrag auf dem Überhang. Der Arbeitnehmeranteil: 5,3 % AHV/IV/EO + 1,1 % ALV = 6,4 % des Bruttolohns. Pflichtig auch für Teilzeit ab CHF 2'500/Jahr. AHV-Renten sind gemäss CH-EU-Abkommen 2002 ohne Kürzung nach Italien exportierbar.",
      fr:
        "Le frontalier paie les cotisations 1er pilier selon la LAVS (RS 831.10) : 8,7 % AVS + 1,4 % AI + 0,5 % APG = 10,6 % au total, partagé 50/50 employé/employeur [source : Fedlex LAVS RS 831.10 art. 5]. S'ajoute 2,2 % chômage (AC/LACI) jusqu'à CHF 148 200/an (2025, indexé) et 1 % solidarité sur l'excédent. Part salariale : 5,3 % AVS/AI/APG + 1,1 % AC = 6,4 % du brut. Obligatoire aussi à temps partiel dès CHF 2 500/an. Rentes AVS exportables : l'Accord CH-UE 2002 garantit le versement en Italie sans réduction.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/avs-lpp-frontalieri/',
        label: {
          it: 'Guida AVS/LPP frontalieri',
          en: 'AVS/LPP cross-border guide',
          de: 'AHV/BVG Grenzgänger-Leitfaden',
          fr: 'Guide AVS/LPP frontaliers',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/63/837_843_843/it',
      'https://www.ahv-iv.ch/',
    ],
  },
  {
    id: 'avs-lpp-eta-pensione-2026',
    category: 'avs-lpp',
    question: {
      it: 'A che età posso richiedere la pensione AVS nel 2026?',
      en: 'At what age can I claim AVS pension in 2026?',
      de: 'Ab welchem Alter kann ich 2026 die AHV-Rente beantragen?',
      fr: 'À quel âge puis-je demander la rente AVS en 2026 ?',
    },
    answer: {
      it:
        "La riforma AVS21 approvata in votazione il 25 settembre 2022 e in vigore dal 1° gennaio 2024 ha introdotto la «età di riferimento» (65 anni per uomini e donne) con fasi transitorie per le donne nate 1961-1969 [fonte: Fedlex AVS21, modifiche LAVS 17/12/2021]. Nel 2026 l'età di riferimento per le donne è 64 anni e 9 mesi. È possibile anticipare di 1-24 mesi (riduzione 6,8%/anno) o rinviare fino a 70 anni (+5,2%/anno). L'Accordo CH-UE permette al frontaliere di totalizzare i periodi svizzeri + italiani per raggiungere il minimo di 15 anni pro-rata [fonte: UFAS Memento 10.02]. Si presenta la domanda alla cassa di compensazione 3-4 mesi prima via formulario 318.370.",
      en:
        "The AVS21 reform approved on 25 September 2022 (in force 1 January 2024) introduced the «reference age» (65 for men and women) with transitional phases for women born 1961-1969 [source: Fedlex AVS21, amendments LAVS 17/12/2021]. In 2026 the reference age for women is 64 years and 9 months. Early retirement 1-24 months (6.8%/year reduction) or deferral up to 70 (+5.2%/year) is possible. The CH-EU Agreement lets cross-border workers aggregate Swiss + Italian periods to reach the 15-year pro-rata minimum [source: UFAS Memento 10.02]. File the claim with the compensation office 3-4 months in advance via form 318.370.",
      de:
        "Die AVS21-Reform vom 25.09.2022 (in Kraft 01.01.2024) führt das «Referenzalter» (65 Jahre für Männer und Frauen) ein, mit Übergangsfristen für Frauen Jg. 1961-1969 [Quelle: Fedlex AVS21, AHVG-Änderungen 17.12.2021]. 2026 Referenzalter Frauen 64 J. 9 Mo. Frühbezug 1-24 Monate (Kürzung 6,8 %/Jahr) oder Aufschub bis 70 (+5,2 %/Jahr) möglich. Das CH-EU-Abkommen erlaubt Totalisierung schweizerischer und italienischer Beitragszeiten für das Minimum 15 Jahre pro rata [Quelle: BSV Merkblatt 10.02]. Antrag 3-4 Monate vorher bei der Ausgleichskasse mit Formular 318.370.",
      fr:
        "La réforme AVS21 adoptée le 25.09.2022 (en vigueur 01.01.2024) introduit l'« âge de référence » (65 ans hommes et femmes) avec phases transitoires pour les femmes 1961-1969 [source : Fedlex AVS21, modif. LAVS 17.12.2021]. En 2026 l'âge des femmes est 64 ans 9 mois. Anticipation 1-24 mois (réduction 6,8 %/an) ou ajournement jusqu'à 70 ans (+5,2 %/an). L'Accord CH-UE permet la totalisation des périodes suisses + italiennes pour atteindre les 15 ans pro-rata [source : OFAS mémento 10.02]. Demande 3-4 mois avant à la caisse de compensation, formulaire 318.370.",
    },
    sources: [
      'https://www.bsv.admin.ch/bsv/de/home/sozialversicherungen/ahv/reformen-revisionen/ahv-21.html',
      'https://www.ahv-iv.ch/p/10.02.i',
    ],
  },
  {
    id: 'avs-lpp-riscatto-secondo-pilastro',
    category: 'avs-lpp',
    question: {
      it: 'Posso riscattare il 2° pilastro se lascio la Svizzera?',
      en: 'Can I cash out my 2nd pillar if I leave Switzerland?',
      de: 'Kann ich die 2. Säule auszahlen lassen, wenn ich die Schweiz verlasse?',
      fr: 'Puis-je retirer le 2e pilier si je quitte la Suisse ?',
    },
    answer: {
      it:
        "Solo in parte. L'art. 25f LFLP (RS 831.42) stabilisce che la «parte obbligatoria» del 2° pilastro (LPP obbligatoria) non può essere riscattata in contanti se si trasferisce la residenza in uno Stato UE/AELS con obbligo di assicurazione pensionistica [fonte: Fedlex LFLP RS 831.42]. La parte sovraobbligatoria (eccedenze versate oltre il minimo LPP) può invece essere riscattata immediatamente. La parte obbligatoria può essere versata su un conto di libero passaggio o conto vincolato svizzero, disponibile solo al compimento dell'età di riferimento o per casi speciali (acquisto abitazione primaria, indipendenza economica). Per il frontaliere che rientra definitivamente in Italia senza futuri rapporti svizzeri, il 2° pilastro diventa rendita futura integrativa esportabile.",
      en:
        "Only partially. LFLP art. 25f (RS 831.42) states that the «mandatory» part of the 2nd pillar (LPP obligatoire) cannot be cashed out if residence is transferred to an EU/EFTA state with pension insurance obligation [source: Fedlex LFLP RS 831.42]. The non-mandatory part (excess beyond LPP minimum) can be cashed out. The mandatory part goes to a vested benefit account in Switzerland, payable only at reference age or for special cases (primary home purchase, self-employment). For workers definitively returning to Italy without future Swiss jobs, the 2nd pillar becomes a supplemental exportable future pension.",
      de:
        "Nur teilweise. FZG Art. 25f (SR 831.42) bestimmt, dass der obligatorische Teil der 2. Säule (BVG-Obligatorium) bei Wohnsitzwechsel in einen EU/EFTA-Staat mit Rentenversicherungspflicht nicht bar bezogen werden kann [Quelle: Fedlex FZG SR 831.42]. Der überobligatorische Teil (Übertrag über BVG-Minimum) kann bar bezogen werden. Obligatorischer Teil auf Freizügigkeitskonto, Bezug nur bei Referenzalter oder Spezialfällen (Wohneigentum, Selbständigkeit). Endgültig nach Italien zurückgekehrte Grenzgänger erhalten die 2. Säule als exportierbare Zusatzrente.",
      fr:
        "Seulement partiellement. La LFLP art. 25f (RS 831.42) dispose que la part « obligatoire » du 2e pilier (LPP obligatoire) ne peut être retirée en espèces en cas de transfert de résidence dans un État UE/AELE avec obligation d'assurance pension [source : Fedlex LFLP RS 831.42]. La part surobligatoire (excédent au-dessus du minimum LPP) peut être retirée. La part obligatoire va sur un compte de libre passage suisse, versable à l'âge de référence ou dans des cas particuliers (logement principal, indépendance). Pour un frontalier rentrant définitivement en Italie, le 2e pilier devient une rente future exportable.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1994/2386_2386_2386/it',
      'https://www.bsv.admin.ch/bsv/it/home/sozialversicherungen/bv.html',
    ],
  },
  {
    id: 'avs-lpp-pilastro-3a-frontaliere',
    category: 'avs-lpp',
    question: {
      it: 'Un frontaliere può aprire un conto pilastro 3a?',
      en: 'Can a cross-border worker open a pillar 3a account?',
      de: 'Kann ein Grenzgänger ein Säule-3a-Konto eröffnen?',
      fr: 'Un frontalier peut-il ouvrir un compte pilier 3a ?',
    },
    answer: {
      it:
        "Sì, a condizione di essere soggetti all'AVS e quindi di pagare contributi obbligatori del 1° pilastro [fonte: Fedlex OPP 3 RS 831.461.3]. I frontalieri versano fino a CHF 7.258 (2025) nel 3a bancario/assicurativo, deducibili fiscalmente in Svizzera tramite procedura NOV (art. 89 LAID): il risparmio d'imposta arriva al 25-30% dell'importo versato. In Italia il pilastro 3a non è fiscalmente riconosciuto come previdenza e al riscatto viene tassato come reddito di capitale estero. Il frontaliere lavoratore indipendente senza LPP può versare fino al 20% del reddito lordo, max CHF 36.288. Il conto 3a è riscattabile a 60-70 anni, o per acquisto abitazione primaria, indipendenza, trasferimento definitivo fuori UE.",
      en:
        "Yes, provided the worker pays mandatory AVS contributions [source: Fedlex OPP 3 RS 831.461.3]. Cross-border workers contribute up to CHF 7,258 (2025) in bank or insurance 3a, tax-deductible in Switzerland via the NOV procedure (LHID art. 89): tax saving 25-30% of the amount. Italy does not recognise 3a as retirement saving; at withdrawal it is taxed as foreign capital income. Self-employed without LPP can contribute up to 20% of gross, max CHF 36,288. 3a is redeemable at 60-70, or for primary home, self-employment, definitive departure outside EU.",
      de:
        "Ja, sofern AHV-beitragspflichtig [Quelle: Fedlex BVV 3 SR 831.461.3]. Grenzgänger können bis CHF 7'258 (2025) in Bank- oder Versicherungs-3a einzahlen, steuerlich abziehbar in der Schweiz via NOV-Verfahren (Art. 89 StHG): 25-30 % Steuerersparnis. In Italien kein Altersvorsorge-Status, Bezug wird als ausländisches Kapitaleinkommen besteuert. Selbständige ohne BVG: bis 20 % des Bruttoeinkommens, max. CHF 36'288. 3a-Bezug mit 60-70 Jahren oder bei Wohneigentum, Selbständigkeit, endgültigem Wegzug ausserhalb der EU.",
      fr:
        "Oui, à condition d'être soumis à l'AVS [source : Fedlex OPP 3 RS 831.461.3]. Les frontaliers cotisent jusqu'à CHF 7 258 (2025) en 3a bancaire/assurance, déductibles en Suisse via TOU (LHID art. 89) : économie d'impôt 25-30 %. En Italie le 3a n'est pas reconnu comme prévoyance ; au retrait imposé comme revenu de capital étranger. Indépendants sans LPP : jusqu'à 20 % du brut, max CHF 36 288. Retrait du 3a à 60-70 ans, ou logement principal, indépendance, départ définitif hors UE.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1985/1925_1925_1925/it',
    ],
  },
  {
    id: 'avs-lpp-pensione-superstiti-vedova',
    category: 'avs-lpp',
    question: {
      it: 'La pensione di reversibilità AVS spetta anche al coniuge italiano di un frontaliere?',
      en: 'Is AVS survivor pension available to the Italian spouse of a cross-border worker?',
      de: 'Steht die AHV-Hinterlassenenrente auch dem italienischen Ehepartner eines Grenzgängers zu?',
      fr: 'La rente de survivants AVS est-elle due au conjoint italien d\'un frontalier ?',
    },
    answer: {
      it:
        "Sì. L'art. 23 LAVS riconosce la rendita vedovile al coniuge superstite se il defunto aveva almeno 1 anno di contributi AVS [fonte: Fedlex LAVS RS 831.10]. La rendita è pari all'80% della rendita di vecchiaia ipotetica. Per la vedova senza figli è richiesta un'età minima di 45 anni e almeno 5 anni di matrimonio. Per il vedovo dopo la votazione sentenza federale BGE 139 V 297 (parità di trattamento), il diritto sussiste fino a quando ha figli minori di 18 anni, con estensione normativa in discussione in Parlamento nel 2025. I figli ricevono la rendita di orfano (40% AVS). Le prestazioni sono esportabili in Italia via Reg. UE 883/2004 e pagate dalla Cassa svizzera di compensazione Ginevra.",
      en:
        "Yes. LAVS art. 23 grants a widow/widower pension to the surviving spouse if the deceased had at least 1 year of AVS contributions [source: Fedlex LAVS RS 831.10]. The pension is 80% of the hypothetical retirement pension. Widows without children need age 45+ and 5 years of marriage. For widowers, after Federal Court ruling BGE 139 V 297 (equal treatment), the right exists while minor children under 18 are present; legislative extension is in Parliament in 2025. Children receive the orphan pension (40% AVS). Benefits are exportable to Italy under EU Reg. 883/2004 and paid by the Swiss Compensation Office Geneva.",
      de:
        "Ja. AHVG Art. 23 gewährt dem überlebenden Ehegatten eine Hinterlassenenrente, sofern der Verstorbene mind. 1 Jahr AHV-Beiträge geleistet hat [Quelle: Fedlex AHVG SR 831.10]. Rente 80 % der hypothetischen Altersrente. Witwen ohne Kinder: Mindestalter 45 und 5 Jahre Ehe. Für Witwer nach BGE 139 V 297 (Gleichbehandlung) besteht Anspruch solange minderjährige Kinder unter 18 vorhanden sind; gesetzliche Ausdehnung 2025 im Parlament. Kinder erhalten die Waisenrente (40 % AHV). Export nach Italien gemäss EU-VO 883/2004, Auszahlung durch Schweizerische Ausgleichskasse Genf.",
      fr:
        "Oui. L'art. 23 LAVS accorde une rente au conjoint survivant si le défunt avait au moins 1 année de cotisations AVS [source : Fedlex LAVS RS 831.10]. Rente = 80 % de la rente de vieillesse hypothétique. Veuves sans enfants : âge 45+ et 5 ans de mariage. Veufs : après l'ATF 139 V 297 (égalité), droit tant qu'il y a des enfants mineurs ; extension législative en discussion en 2025. Les enfants reçoivent la rente d'orphelin (40 % AVS). Exportable en Italie via règl. UE 883/2004, versée par la Caisse suisse de compensation Genève.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/63/837_843_843/it',
      'https://www.zas.admin.ch/',
    ],
  },
  {
    id: 'avs-lpp-totalizzazione-periodi-italia',
    category: 'avs-lpp',
    question: {
      it: 'Come si totalizzano i periodi contributivi italiani e svizzeri?',
      en: 'How are Italian and Swiss contribution periods totalised?',
      de: 'Wie werden italienische und schweizerische Beitragszeiten totalisiert?',
      fr: 'Comment sont totalisées les périodes italiennes et suisses ?',
    },
    answer: {
      it:
        "Il Regolamento UE 883/2004 e la Decisione nº H1 della Commissione UE prevedono la totalizzazione dei periodi ai fini del diritto alla pensione, senza «doppia» contabilizzazione [fonte: Eur-Lex reg. 883/2004]. In pratica: il frontaliere con 10 anni AVS e 8 anni INPS raggiunge il minimo di 15 anni per AVS e INPS separatamente. AVS paga pro-quota (10/43esimi di rendita completa); INPS paga pro-quota sulla base italiana (8 anni contributi). Le due rendite si sommano e insieme coprono la carriera. La domanda unica si presenta presso l'ente dello Stato di residenza (INPS), che inoltra alla Cassa svizzera di compensazione di Ginevra con formulario P1000. Tempo istruttoria medio: 6-12 mesi.",
      en:
        "EU Regulation 883/2004 and Commission Decision H1 provide for totalisation of periods for pension entitlement, without double counting [source: Eur-Lex reg. 883/2004]. In practice: a worker with 10 AVS years and 8 INPS years reaches the 15-year minimum for AVS and INPS separately. AVS pays pro-rata (10/43 of full pension); INPS pays pro-rata on Italian basis (8 years of contributions). The two pensions add up. The single claim is filed with the country-of-residence institution (INPS), which forwards it to the Swiss Compensation Office Geneva via form P1000. Average processing: 6-12 months.",
      de:
        "EU-VO 883/2004 und Beschluss H1 sehen Totalisierung der Versicherungszeiten für den Rentenanspruch ohne Doppelanrechnung vor [Quelle: Eur-Lex VO 883/2004]. Beispiel: 10 Jahre AHV und 8 Jahre INPS erreichen jeweils die 15 Jahre. AHV zahlt pro rata (10/43 Vollrente), INPS pro rata auf italienischer Basis (8 Jahre). Die Renten kumulieren. Einheitsantrag beim Wohnsitzträger (INPS), Weiterleitung an die Schweizerische Ausgleichskasse Genf mit Formular P1000. Bearbeitung 6-12 Monate.",
      fr:
        "Le règlement UE 883/2004 et la décision H1 prévoient la totalisation des périodes pour le droit à la pension, sans double comptage [source : Eur-Lex règl. 883/2004]. En pratique : 10 ans AVS + 8 ans INPS atteignent les 15 ans pour AVS et INPS séparément. AVS paie pro rata (10/43 de la pension complète), INPS pro rata sur base italienne (8 ans). Les deux rentes se cumulent. Demande unique auprès de l'institution du pays de résidence (INPS) qui transmet à la Caisse suisse de compensation Genève (formulaire P1000). Traitement 6-12 mois.",
    },
    sources: [
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
      'https://www.zas.admin.ch/zas/it/home/particuliers/prestations-dans-un-etat-membre-de-l-u.html',
    ],
  },
  {
    id: 'avs-lpp-contributi-volontari',
    category: 'avs-lpp',
    question: {
      it: 'Posso versare contributi AVS volontari dall\'Italia?',
      en: 'Can I pay voluntary AVS contributions from Italy?',
      de: 'Kann ich aus Italien freiwillige AHV-Beiträge leisten?',
      fr: 'Puis-je verser des cotisations AVS volontaires depuis l\'Italie ?',
    },
    answer: {
      it:
        "Dal 2001 l'AVS volontaria è limitata ai cittadini svizzeri e UE/AELS residenti FUORI dall'UE/AELS (art. 2 LAVS) [fonte: Fedlex LAVS RS 831.10]. Il frontaliere residente in Italia NON può quindi versare contributi volontari AVS: durante i periodi senza attività svizzera (disoccupazione, congedo) deve versare contributi in Italia (INPS Gestione Separata o Artigiani/Commercianti). Una eccezione: i contributi AVS per persone non attive residenti in Svizzera (mariti, casalinghi a 18-65 anni) restano obbligatori ma sono rilevanti solo per titolari di permesso B/C. Chi ha lacune contributive può ricorrere alla totalizzazione dei periodi italiani tramite formulario U1/E205, ottenendo la pensione pro-rata senza dover versare volontariamente.",
      en:
        "Since 2001 voluntary AVS is restricted to Swiss and EU/EFTA citizens residing OUTSIDE EU/EFTA (LAVS art. 2) [source: Fedlex LAVS RS 831.10]. A cross-border worker residing in Italy CANNOT pay voluntary AVS; during inactive periods (unemployment, leave) they must pay in Italy (INPS Gestione Separata or Artigiani/Commercianti). An exception: AVS for non-active Swiss residents (18-65, housewives) remains mandatory but only relevant for B/C permit holders. Gaps can be closed via period totalisation using form U1/E205, earning a pro-rata pension without voluntary payments.",
      de:
        "Seit 2001 ist die freiwillige AHV auf Schweizer und EU/EFTA-Bürger mit Wohnsitz AUSSERHALB EU/EFTA beschränkt (AHVG Art. 2) [Quelle: Fedlex AHVG SR 831.10]. Grenzgänger mit Wohnsitz Italien können KEINE freiwilligen Beiträge leisten; bei Erwerbsunterbruch zahlen sie in Italien (INPS Gestione Separata oder Artigiani/Commercianti). Ausnahme: AHV für nicht erwerbstätige Schweizer Einwohner (18-65, Hausmänner/-frauen) bleibt obligatorisch, aber nur für B/C-Inhaber relevant. Lücken über Totalisierung mit U1/E205, keine freiwilligen Beiträge nötig.",
      fr:
        "Depuis 2001 l'AVS volontaire est réservée aux citoyens suisses et UE/AELE résidant HORS UE/AELE (LAVS art. 2) [source : Fedlex LAVS RS 831.10]. Le frontalier résident en Italie NE peut PAS cotiser volontairement ; en cas d'interruption il cotise en Italie (INPS Gestione Separata ou Artigiani/Commercianti). Exception : l'AVS pour non-actifs résidant en Suisse (18-65 ans, au foyer) reste obligatoire mais ne concerne que les titulaires B/C. Les lacunes se comblent par la totalisation des périodes italiennes avec le formulaire U1/E205, pension pro-rata sans versements volontaires.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/63/837_843_843/it',
    ],
  },
  {
    id: 'avs-lpp-deduzione-coordinamento',
    category: 'avs-lpp',
    question: {
      it: 'Che cos\'è la deduzione di coordinamento LPP e come influisce sul salario?',
      en: 'What is the LPP coordination deduction and how does it affect salary?',
      de: 'Was ist der BVG-Koordinationsabzug und wie wirkt er sich auf den Lohn aus?',
      fr: 'Qu\'est-ce que la déduction de coordination LPP et son impact sur le salaire ?',
    },
    answer: {
      it:
        "La «deduzione di coordinamento» è la quota di salario già coperta dall'AVS che non entra nel calcolo LPP (art. 8 LPP) [fonte: Fedlex LPP RS 831.40]. Nel 2025 la deduzione è CHF 26.460, ossia 7/8 della rendita AVS massima (CHF 30.240). Il salario LPP coordinato è: salario annuo - CHF 26.460, capped a CHF 90.720 - CHF 26.460 = CHF 64.260. Solo su questa parte si calcolano i contributi LPP obbligatori (7-18% a seconda dell'età). Dal 1° gennaio 2026 la riforma LPP (approvata votazione del 22/09/2024) riduce la deduzione a 20% del salario AVS, con un minimo di CHF 7.980, migliorando la copertura dei salari bassi e dei part-time [fonte: UFAS, Riforma LPP in vigore dal 01/2026].",
      en:
        "The «coordination deduction» is the salary portion already covered by AVS, excluded from LPP computation (LPP art. 8) [source: Fedlex LPP RS 831.40]. In 2025 it is CHF 26,460, i.e. 7/8 of the maximum AVS pension (CHF 30,240). The coordinated LPP salary is: annual salary − CHF 26,460, capped at CHF 90,720 − CHF 26,460 = CHF 64,260. Only on this portion are mandatory LPP contributions calculated (7-18% by age). From 1 January 2026 the LPP reform (approved on 22/09/2024) cuts the deduction to 20% of AVS salary with a floor of CHF 7,980, improving coverage for low wages and part-time [source: UFAS, LPP reform in force 01/2026].",
      de:
        "Der «Koordinationsabzug» ist der bereits AHV-gedeckte Lohnteil, nicht BVG-pflichtig (BVG Art. 8) [Quelle: Fedlex BVG SR 831.40]. 2025: CHF 26'460, d. h. 7/8 der max. AHV-Rente (CHF 30'240). Koordinierter BVG-Lohn: Jahreslohn − CHF 26'460, Obergrenze CHF 90'720 − CHF 26'460 = CHF 64'260. Nur auf diesem Teil BVG-Obligatorium (7-18 % nach Alter). Ab 01.01.2026 reduziert die BVG-Reform (Volksabstimmung 22.09.2024) den Abzug auf 20 % des AHV-Lohns, Minimum CHF 7'980, verbessert Deckung für Tieflohn und Teilzeit [Quelle: BSV BVG-Reform ab 01/2026].",
      fr:
        "La « déduction de coordination » est la part du salaire déjà couverte par l'AVS, exclue du calcul LPP (art. 8 LPP) [source : Fedlex LPP RS 831.40]. En 2025 : CHF 26 460, soit 7/8 de la rente AVS max (CHF 30 240). Salaire LPP coordonné : salaire annuel − CHF 26 460, plafond CHF 90 720 − CHF 26 460 = CHF 64 260. Cotisations LPP obligatoires (7-18 % selon l'âge) sur cette part. Dès le 01.01.2026 la réforme LPP (votation 22.09.2024) abaisse la déduction à 20 % du salaire AVS, minimum CHF 7 980, meilleure couverture pour bas salaires et temps partiel [source : OFAS réforme LPP 01/2026].",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1983/797_797_797/it',
      'https://www.bsv.admin.ch/bsv/de/home/sozialversicherungen/bv/reformen-revisionen.html',
    ],
  },
  {
    id: 'avs-lpp-calcolo-rendita-aliquote',
    category: 'avs-lpp',
    question: {
      it: 'Come si calcola la rendita AVS per un frontaliere con 30 anni di contributi in Svizzera?',
      en: 'How is the AVS pension computed for a cross-border worker with 30 years of Swiss contributions?',
      de: 'Wie wird die AHV-Rente bei 30 Jahren schweizerischer Beitragszeit berechnet?',
      fr: 'Comment calcule-t-on la rente AVS avec 30 ans de cotisations suisses ?',
    },
    answer: {
      it:
        "La formula LAVS usa la «rendita parziale pro-rata» (art. 38 LAVS) [fonte: Fedlex LAVS RS 831.10]. Con 30 anni su 44 di carriera teorica (1964-2008 o simile), il beneficiario riceve 30/44 = 68,2% della rendita piena corrispondente al reddito medio annuo. Nel 2025 la rendita piena max è CHF 30.240 e la min CHF 15.120. Esempio: salario medio annuo CHF 75.000 dà una rendita AVS piena di circa CHF 26.800; a 30/44 sono CHF 18.300/anno. Si somma la rendita INPS pro-rata in base ai periodi italiani. L'ESTRATTO CONTO individuale (Ecinfo) è consultabile su ahv-iv.ch e mostra anni e stipendi contabilizzati. Lacune inferiori a 1 anno sono colmate dagli «anni di gioventù» (16-20).",
      en:
        "The LAVS formula uses the pro-rata partial pension (LAVS art. 38) [source: Fedlex LAVS RS 831.10]. With 30 years out of 44 theoretical (1964-2008 or equivalent), the beneficiary gets 30/44 = 68.2% of the full pension for the average income. In 2025 max full pension is CHF 30,240 and min CHF 15,120. Example: average salary CHF 75,000 gives full AVS about CHF 26,800; at 30/44 it is CHF 18,300/year. Add the INPS pro-rata pension on Italian periods. The individual ESTRATTO CONTO (Ecinfo) is available on ahv-iv.ch showing years and income. Gaps under 1 year are filled by «youth years» (16-20).",
      de:
        "Die AHV-Formel nutzt die pro-rata-Teilrente (AHVG Art. 38) [Quelle: Fedlex AHVG SR 831.10]. Bei 30 von 44 theoretischen Jahren (1964-2008 o. ä.): 30/44 = 68,2 % der Vollrente zum Durchschnittseinkommen. 2025: max. Vollrente CHF 30'240, min. CHF 15'120. Beispiel: Durchschnittslohn CHF 75'000 ergibt AHV-Vollrente ~CHF 26'800; 30/44 sind CHF 18'300/Jahr. Plus INPS-pro-rata für italienische Perioden. Individueller Kontoauszug (Ecinfo) auf ahv-iv.ch. Lücken unter 1 Jahr werden durch «Jugendjahre» (16-20) gefüllt.",
      fr:
        "La formule LAVS utilise la rente partielle pro-rata (LAVS art. 38) [source : Fedlex LAVS RS 831.10]. Pour 30 ans sur 44 théoriques (1964-2008 ou équivalent) : 30/44 = 68,2 % de la rente complète au revenu moyen. En 2025 rente max CHF 30 240, min CHF 15 120. Exemple : salaire moyen CHF 75 000 donne AVS complète ~CHF 26 800 ; 30/44 = CHF 18 300/an. Ajouter la rente INPS pro-rata sur les périodes italiennes. Extrait individuel (Ecinfo) sur ahv-iv.ch montrant années et salaires. Lacunes <1 an comblées par les « années de jeunesse » (16-20).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/63/837_843_843/it',
      'https://www.ahv-iv.ch/p/1.01.i',
    ],
  },
  {
    id: 'avs-lpp-lacune-contributive',
    category: 'avs-lpp',
    question: {
      it: 'Come verifico se ho lacune AVS e come le colmo?',
      en: 'How do I check AVS contribution gaps and fill them?',
      de: 'Wie prüfe ich AHV-Lücken und wie fülle ich sie?',
      fr: 'Comment vérifier les lacunes AVS et comment les combler ?',
    },
    answer: {
      it:
        "Si richiede l'«estratto conto individuale» (CK/CI) alla Cassa svizzera di compensazione (Ginevra) tramite formulario 318.180, oppure online su ahv-iv.ch con AVS13. L'estratto mostra anni, mesi e importi contabilizzati dal 1948 [fonte: UFAS Memento 1.02]. Lacune fino a 3 anni possono essere colmate versando contributi retroattivi entro 5 anni dall'inizio del rapporto (art. 16 OAVS) [fonte: Fedlex OAVS RS 831.101]. Lacune oltre 3 anni non sono recuperabili ma possono essere compensate da «anni di gioventù» (tra 17 e 20) o da periodi italiani tramite totalizzazione (Reg. 883/2004). Il coniuge che non lavora ma risiede in Svizzera può versare contributi come persona non attiva (min. CHF 530/anno, 2025).",
      en:
        "Request the individual contribution statement (CK/CI) from the Swiss Compensation Office (Geneva) via form 318.180, or online on ahv-iv.ch with AVS13. The statement shows years, months and amounts since 1948 [source: UFAS Memento 1.02]. Gaps up to 3 years can be backfilled with retroactive contributions within 5 years of job start (OAVS art. 16) [source: Fedlex OAVS RS 831.101]. Gaps over 3 years are unrecoverable but may be offset by «youth years» (17-20) or Italian periods via totalisation (Reg. 883/2004). A non-working spouse resident in Switzerland can pay contributions as non-active (min. CHF 530/year, 2025).",
      de:
        "Individueller Kontoauszug (IK) bei der Schweizerischen Ausgleichskasse Genf mit Formular 318.180 oder online auf ahv-iv.ch mit AHV13. Anzeigt Jahre, Monate und Beträge seit 1948 [Quelle: BSV Merkblatt 1.02]. Lücken bis 3 Jahre mit rückwirkenden Beiträgen innerhalb 5 Jahren nach Stellenantritt schliessbar (AHVV Art. 16) [Quelle: Fedlex AHVV SR 831.101]. Lücken über 3 Jahre nicht mehr einzahlbar, aber durch «Jugendjahre» (17-20) oder italienische Perioden via Totalisierung (VO 883/2004) kompensierbar. Nichterwerbstätige Ehepartner in der Schweiz zahlen Beiträge (min. CHF 530/Jahr 2025).",
      fr:
        "Demander l'extrait de compte individuel (CI) à la Caisse suisse de compensation Genève via formulaire 318.180 ou en ligne sur ahv-iv.ch (AVS13). Il indique années, mois et montants depuis 1948 [source : OFAS mémento 1.02]. Lacunes jusqu'à 3 ans : cotisations rétroactives sous 5 ans (RAVS art. 16) [source : Fedlex RAVS RS 831.101]. Lacunes de plus de 3 ans non rachetables mais compensables par « années de jeunesse » (17-20) ou périodes italiennes via totalisation (règl. 883/2004). Le conjoint non-actif résidant en Suisse cotise comme non-actif (min. CHF 530/an 2025).",
    },
    sources: [
      'https://www.zas.admin.ch/',
      'https://www.ahv-iv.ch/p/1.02.i',
    ],
  },
];
