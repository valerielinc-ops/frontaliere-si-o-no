import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "stipendi" (AE-5, 10/100).
 *
 * Scope: tredicesima, netto, CCL, indennità, tassazione in busta,
 * minimi salariali, bonus e straordinari.
 */
export const FAQ_stipendi: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'stipendi-tredicesima-obbligatoria',
    category: 'stipendi',
    question: {
      it: 'La tredicesima è obbligatoria per i frontalieri in Svizzera?',
      en: 'Is the 13th-month salary mandatory for cross-border workers in Switzerland?',
      de: 'Ist der 13. Monatslohn in der Schweiz für Grenzgänger obligatorisch?',
      fr: 'Le 13e mois est-il obligatoire pour les frontaliers en Suisse ?',
    },
    answer: {
      it:
        "Il Codice delle obbligazioni (CO) art. 322 non impone l'obbligo legale della tredicesima: è un «beneficio consuetudinario» che deve essere esplicitamente previsto dal contratto individuale o dal contratto collettivo di lavoro (CCL) [fonte: Fedlex CO RS 220]. In Ticino la quasi totalità dei CCL applicabili (industria, edilizia, banche, sanità) prevede la tredicesima pari a 1/12 dello stipendio annuo, versata a dicembre o ripartita. Alcuni CCL includono anche la quattordicesima. Se il contratto individuale non menziona la tredicesima e non è coperto da CCL, il datore non è obbligato a versarla. La prassi ticinese è comunque estesa. Il pagamento è subordinato alla presenza effettiva: in caso di assunzione o dimissione nel corso dell'anno si versa pro-rata temporis.",
      en:
        "The Code of Obligations art. 322 does not mandate a 13th-month salary: it is a customary benefit that must be explicitly provided by the individual contract or by a collective labour agreement (CLA/CCL) [source: Fedlex CO RS 220]. In Ticino nearly all applicable CLAs (industry, construction, banks, healthcare) provide a 13th-month equal to 1/12 of annual salary, paid in December or spread. Some CLAs include a 14th-month. Without contractual provision and no CLA, it is not owed. Ticino practice is widespread. Payment is prorated based on actual presence: new hires or leavers get a pro-rata amount.",
      de:
        "Das Obligationenrecht Art. 322 schreibt den 13. Monatslohn nicht vor: es ist eine vertragliche oder GAV-geregelte Leistung [Quelle: Fedlex OR SR 220]. Im Tessin sieht fast jeder einschlägige GAV (Industrie, Bau, Banken, Gesundheit) einen 13. Monatslohn in Höhe von 1/12 des Jahreslohns vor, ausbezahlt im Dezember oder verteilt. Einige GAV sehen zusätzlich einen 14. Monatslohn vor. Ohne Vertrags-/GAV-Regelung keine Pflicht. Die Tessiner Praxis ist weit verbreitet. Bei Ein- oder Austritt wird pro rata temporis gezahlt.",
      fr:
        "Le CO art. 322 n'impose pas le 13e mois : c'est un avantage contractuel ou prévu par la CCT [source : Fedlex CO RS 220]. Au Tessin, presque toutes les CCT applicables (industrie, construction, banques, santé) prévoient un 13e mois = 1/12 du salaire annuel, versé en décembre ou réparti. Certaines CCT ajoutent un 14e mois. Sans contrat/CCT, pas d'obligation. La pratique tessinoise est très répandue. En cas d'embauche ou départ en cours d'année, versement au prorata temporis.",
    },
    relatedLinks: [
      {
        href: '/tredicesima-svizzera/',
        label: {
          it: 'Guida tredicesima svizzera',
          en: 'Swiss 13th-month guide',
          de: 'Leitfaden 13. Monatslohn',
          fr: 'Guide 13e mois suisse',
        },
      },
    ],
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    ],
  },
  {
    id: 'stipendi-ccl-minimi-ticino',
    category: 'stipendi',
    question: {
      it: 'Quali sono i salari minimi nei CCL ticinesi 2026?',
      en: 'What are the 2026 minimum wages in Ticino CLAs?',
      de: 'Wie hoch sind die Mindestlöhne 2026 in Tessiner GAV?',
      fr: 'Quels sont les salaires minimaux 2026 dans les CCT tessinoises ?',
    },
    answer: {
      it:
        "Il Ticino applica un salario minimo cantonale dal 1° dicembre 2021 (Legge cantonale sul salario minimo 11.12.2019, LSM) [fonte: Ti.ch, LSM]. Nel 2026 l'importo è CHF 20,45/ora (rivalutazione annuale ISTAT). Sui CCL di settore i minimi sono spesso più alti: CCL metallurgia CHF 4.400/mese per operai qualificati, CCL vendita CHF 4.100, CCL sanità CHF 4.500 [fonte: SECO, sito contrattazione]. Il CCL dell'edilizia principale (obbligatorio in tutta la Svizzera) fissa CHF 6.060/mese per capisquadra e CHF 5.940 per muratori qualificati. I frontalieri hanno diritto ai minimi svizzeri identici ai residenti (ALC Allegato I art. 9). La verifica si fa sul sito della Segretariato di Stato dell'economia (SECO) tramite motore di ricerca CCL.",
      en:
        "Ticino applies a cantonal minimum wage since 1 December 2021 (Cantonal minimum wage law 11.12.2019, LSM) [source: Ti.ch, LSM]. In 2026 it is CHF 20.45/hour (annual CPI adjustment). Sector CLAs often set higher minimums: metalworking CHF 4,400/month for skilled workers, retail CHF 4,100, healthcare CHF 4,500 [source: SECO contractual database]. The nationwide construction CLA sets CHF 6,060/month for foremen and CHF 5,940 for skilled masons. Cross-border workers are entitled to the same Swiss minimums as residents (AFMP Annex I art. 9). Check on SECO website via the CLA search engine.",
      de:
        "Tessin wendet seit 01.12.2021 einen kantonalen Mindestlohn an (Gesetz über den Mindestlohn 11.12.2019, LSM) [Quelle: Ti.ch, LSM]. 2026: CHF 20,45/Std. (Teuerungsanpassung). Branchen-GAV setzen häufig höhere Mindestlöhne: Metall CHF 4'400/Mt. für qualifizierte Arbeitnehmer, Verkauf CHF 4'100, Gesundheit CHF 4'500 [Quelle: SECO Vertragsdatenbank]. Landesmantelvertrag Bau: CHF 6'060/Mt. für Poliere, CHF 5'940 für qualifizierte Maurer. Grenzgänger haben Anspruch auf dieselben Mindestlöhne wie Einheimische (FZA Anhang I Art. 9). Prüfung auf der SECO-Website über GAV-Suche.",
      fr:
        "Le Tessin applique un salaire minimum cantonal depuis le 01.12.2021 (loi cantonale 11.12.2019, LSM) [source : Ti.ch, LSM]. En 2026 : CHF 20,45/h (indexation annuelle). Les CCT sectorielles fixent souvent davantage : métallurgie CHF 4 400/mois qualifiés, vente CHF 4 100, santé CHF 4 500 [source : SECO base des conventions]. La CCT nationale de la construction : CHF 6 060/mois contremaîtres, CHF 5 940 maçons qualifiés. Les frontaliers ont droit aux mêmes minimums (ALCP Annexe I art. 9). Vérification sur le site du SECO.",
    },
    relatedLinks: [
      {
        href: '/stipendi-frontalieri-ticino/',
        label: {
          it: 'Stipendi frontalieri Ticino',
          en: 'Ticino cross-border salaries',
          de: 'Tessiner Grenzgänger-Löhne',
          fr: 'Salaires frontaliers Tessin',
        },
      },
    ],
    sources: [
      'https://www4.ti.ch/can/rl/ricerca-banche-dati/',
      'https://www.seco.admin.ch/seco/it/home/Arbeit/Personenfreizugigkeit_Arbeitsbeziehungen/flankierende-massnahmen/gesamtarbeitsvertraege.html',
    ],
  },
  {
    id: 'stipendi-calcolo-netto',
    category: 'stipendi',
    question: {
      it: 'Come si calcola il salario netto di un frontaliere?',
      en: 'How is the net salary of a cross-border worker calculated?',
      de: 'Wie wird der Nettolohn eines Grenzgängers berechnet?',
      fr: 'Comment calcule-t-on le salaire net d\'un frontalier ?',
    },
    answer: {
      it:
        "Dal lordo si sottraggono: AVS/AI/IPG 5,3%, AD 1,1%, LAINF non professionale (~0,8-2%), LPP (7-18% in base all'età), eventuale contributo LAMal 7,5% se in opzione SSN, imposta alla fonte (tabella Ticino A0 11,9% a CHF 6.500 mensili). Un frontaliere celibe con CHF 6.500 lordi mensili riceve circa CHF 5.300 netti in busta [fonte: AFC Ticino, tabelle 2026]. La tredicesima versata in dicembre è tassata sulla tabella annuale. Gli straordinari: il CO art. 321c richiede compenso 125% o compenso in tempo libero. Dai CHF 5.300 netti il nuovo frontaliere paga poi IRPEF italiana in dichiarazione (meno franchigia 10.000 € + credito 80% imposta CH). Il calcolatore ufficiale su frontaliereticino.ch fornisce stime precise.",
      en:
        "From gross subtract: AVS/AI/APG 5.3%, AD 1.1%, non-professional LAINF (~0.8-2%), LPP (7-18% by age), optional LAMal SSN 7.5%, withholding tax (Ticino A0 table 11.9% at CHF 6,500/month). A single cross-border worker at CHF 6,500 gross receives about CHF 5,300 net [source: AFC Ticino 2026 tables]. The 13th-month in December is taxed on the annual table. Overtime: CO art. 321c requires 125% pay or compensating leave. The new worker then pays Italian IRPEF (minus €10,000 exemption + 80% Swiss-tax credit) on annual return. The official calculator on frontaliereticino.ch gives precise estimates.",
      de:
        "Vom Bruttolohn werden abgezogen: AHV/IV/EO 5,3 %, ALV 1,1 %, Nichtberufsunfall (~0,8-2 %), BVG (7-18 % nach Alter), optional KVG-SSN 7,5 %, Quellensteuer (Tessin A0: 11,9 % bei CHF 6'500/Mt.). Ein lediger Grenzgänger mit CHF 6'500 brutto erhält ca. CHF 5'300 netto [Quelle: AFC Tessin, Tabellen 2026]. 13. Monatslohn im Dezember auf Jahrestabelle. Überstunden gemäss OR Art. 321c: 125 % oder Freizeit. Der neue Grenzgänger zahlt zudem italienische IRPEF (abzüglich 10 000 € Freibetrag + 80 % CH-Steueranrechnung). Offizieller Rechner auf frontaliereticino.ch.",
      fr:
        "Du brut on déduit : AVS/AI/APG 5,3 %, AC 1,1 %, LAA non professionnelle (~0,8-2 %), LPP (7-18 % selon âge), LAMal-SSN optionnelle 7,5 %, impôt à la source (Tessin A0 : 11,9 % à CHF 6 500/mois). Célibataire avec CHF 6 500 brut : ~CHF 5 300 net [source : AFC Tessin, barèmes 2026]. 13e mois de décembre taxé sur barème annuel. Heures supplémentaires : CO art. 321c, 125 % ou compensation en congé. Le nouveau frontalier paie ensuite l'IRPEF italien (moins franchise 10 000 € + crédit 80 % impôt CH). Calculateur officiel sur frontaliereticino.ch.",
    },
    relatedLinks: [
      {
        href: '/calcolatore/',
        label: {
          it: 'Calcolatore netto',
          en: 'Net calculator',
          de: 'Nettorechner',
          fr: 'Calculateur net',
        },
      },
    ],
    sources: [
      'https://www4.ti.ch/dfe/dc/imposta-alla-fonte',
    ],
  },
  {
    id: 'stipendi-indennita-pasti-km',
    category: 'stipendi',
    question: {
      it: 'Ho diritto all\'indennità pasto e chilometrica come frontaliere?',
      en: 'Am I entitled to meal and mileage allowances as a cross-border worker?',
      de: 'Habe ich als Grenzgänger Anspruch auf Verpflegungs- und Kilometerpauschale?',
      fr: 'Ai-je droit à l\'indemnité repas et kilométrique en tant que frontalier ?',
    },
    answer: {
      it:
        "Dipende dal CCL e dal contratto. L'Ordinanza sui costi (RS 642.118.1) e la circolare 22 AFC fissano i massimi deducibili senza certificato: CHF 15 per pasto fuori sede e CHF 0,70/km per uso auto privata [fonte: AFC, circolare 22]. Nel settore edile il CCL mantello prevede indennità pasto CHF 18 quando il cantiere è distante oltre 8 km, e indennità trasporto CHF 0,45/km oppure biglietto del treno rimborsato. Le indennità rimborsate spese effettive (Spesen) non sono parte del salario e non sono imponibili né alla fonte né all'IRPEF [fonte: art. 327a CO]. Se sono forfetarie e superano i limiti ordinariamente ammessi, la parte eccedente è reddito tassabile. Il datore deve documentare la politica rimborsi.",
      en:
        "Depends on CLA and contract. The Costs Ordinance (RS 642.118.1) and AFC circular 22 set deductible maxima without receipt: CHF 15 per external meal and CHF 0.70/km for private car [source: AFC circular 22]. Construction sector CLA provides CHF 18 meal allowance when site is 8+ km away, and CHF 0.45/km transport or train ticket. Expense reimbursements (Spesen) are not salary and not taxable at source or for IRPEF [source: CO art. 327a]. If flat-rate and above ordinary limits, the excess is taxable. The employer must document the expense policy.",
      de:
        "Abhängig von GAV und Vertrag. Die Kostenverordnung (SR 642.118.1) und ESTV-Kreisschreiben 22 setzen pauschale Obergrenzen ohne Beleg: CHF 15 pro auswärtiges Essen, CHF 0,70/km für Privatauto [Quelle: ESTV KS 22]. Landesmantelvertrag Bau: CHF 18 Verpflegung bei Baustelle über 8 km, CHF 0,45/km Verkehrsspesen oder Bahnticket. Spesen sind keine Lohnbestandteile und quellen-/IRPEF-steuerfrei [Quelle: OR Art. 327a]. Pauschalen über den ordentlichen Grenzen sind steuerpflichtig. Arbeitgeber muss Spesenreglement dokumentieren.",
      fr:
        "Selon CCT et contrat. L'ordonnance sur les coûts (RS 642.118.1) et la circulaire AFC 22 fixent les plafonds sans justificatif : CHF 15 repas extérieur, CHF 0,70/km voiture privée [source : AFC circ. 22]. La CCT nationale construction : CHF 18 repas si chantier >8 km, CHF 0,45/km transport ou billet CFF remboursé. Les indemnités (Spesen) ne sont pas du salaire, non imposables à la source ni IRPEF [source : CO art. 327a]. Forfaitaires au-delà des plafonds : part excédentaire imposable. L'employeur doit documenter la politique.",
    },
    sources: [
      'https://www.estv.admin.ch/dam/estv/it/dokumente/dbst/kreisschreiben/1-022-D-2012-i.pdf',
    ],
  },
  {
    id: 'stipendi-straordinari-lavoro-notturno',
    category: 'stipendi',
    question: {
      it: 'Come sono retribuiti gli straordinari e il lavoro notturno?',
      en: 'How are overtime and night work paid?',
      de: 'Wie werden Überstunden und Nachtarbeit vergütet?',
      fr: 'Comment sont rémunérés les heures supplémentaires et le travail de nuit ?',
    },
    answer: {
      it:
        "Gli straordinari (Überzeit) oltre le 45 ore/settimana in uffici e 50 ore/settimana in industria sono pagati al 125% o compensati in tempo libero (art. 13 LL, RS 822.11) [fonte: Fedlex LL]. Il lavoro di notte regolare (23:00-06:00) prevede un supplemento di tempo del 10% (art. 17b LL) e un supplemento salariale del 25% per lavoro notturno occasionale. Il lavoro domenicale è compensato con il 50% supplementare. Gli straordinari contrattuali (Überstunden, tra 40 e 45 ore) sono pagati al 125% o compensati in riposo, salvo diversa clausola nel CCL. La tredicesima NON include gli straordinari né il supplemento notturno in assenza di clausola esplicita. Il datore deve registrare le ore (ordinanza 3 OLL3) e il frontaliere ha diritto a consultare il registro.",
      en:
        "Overtime (Überzeit) beyond 45 hours/week (offices) or 50 hours/week (industry) is paid at 125% or compensated in leave (LTr art. 13, RS 822.11) [source: Fedlex LTr]. Regular night work (23:00-06:00) grants a 10% time supplement (LTr art. 17b) and 25% salary supplement for occasional night work. Sunday work is compensated +50%. Contractual overtime (Überstunden, between 40 and 45 hours) is paid at 125% or leave compensation unless CLA says otherwise. The 13th-month does NOT include overtime or night supplements without explicit clause. The employer must log hours (Ordinance 3 OLL3) and the worker can consult the log.",
      de:
        "Überzeit über 45 Std./Woche (Büro) bzw. 50 Std./Woche (Industrie) wird zu 125 % vergütet oder in Freizeit kompensiert (ArG Art. 13, SR 822.11) [Quelle: Fedlex ArG]. Regelmässige Nachtarbeit (23-06) hat 10 % Zeitzuschlag (ArG Art. 17b) und 25 % Lohnzuschlag bei gelegentlicher Nachtarbeit. Sonntagsarbeit 50 %. Vertragliche Überstunden (40-45 Std.): 125 % oder Freizeit, sofern GAV nichts anderes bestimmt. 13. Monatslohn umfasst Überstunden und Nachtzuschläge nur bei ausdrücklicher Klausel. Arbeitgeber führt Zeitkontrolle (V3 OLL3); der Arbeitnehmer hat Einsicht.",
      fr:
        "Heures supplémentaires (Überzeit) au-delà de 45 h/sem. (bureaux) ou 50 h/sem. (industrie) : +25 % ou compensation en congé (LTr art. 13, RS 822.11) [source : Fedlex LTr]. Travail de nuit régulier (23 h-6 h) : supplément de temps 10 % (LTr art. 17b) et majoration salariale 25 % si occasionnel. Dimanche : +50 %. Heures supplémentaires contractuelles (40-45 h) : +25 % ou compensation sauf clause CCT. Le 13e mois n'inclut pas heures sup ou suppléments de nuit sans clause explicite. Registre horaire obligatoire (Ord. 3 OLT3), consultable par le frontalier.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1966/57_57_57/it',
    ],
  },
  {
    id: 'stipendi-aliquote-lordo-netto-esempio',
    category: 'stipendi',
    question: {
      it: 'Con 70.000 CHF lordi annui, quanto guadagna davvero un frontaliere?',
      en: 'With CHF 70,000 gross per year, what is a cross-border worker\'s real income?',
      de: 'Mit CHF 70 000 Bruttojahreslohn, was verdient ein Grenzgänger tatsächlich?',
      fr: 'Avec CHF 70 000 brut annuel, combien gagne réellement un frontalier ?',
    },
    answer: {
      it:
        "Esempio calcolato con tabelle Ticino 2026 (celibe, codice A0N, LPP 10%, LAMal opzione SSN, 1 anno di 12 mensilità + tredicesima): lordo CHF 70.000, contributi sociali CHF 4.480 (6,4%), LPP CHF 4.350 (6,2% salario coordinato), LAMal SSN CHF 5.250 (7,5% fino soglia), imposta alla fonte CHF 7.900 (11,3% effettivo). Netto svizzero annuo circa CHF 48.020, mensile CHF 4.000 [fonte: AFC Ticino, calcolatore 2026]. In Italia il nuovo frontaliere paga IRPEF su CHF 48.020 equivalente (~EUR 50.700 al cambio medio 2026), meno franchigia EUR 10.000 e deduzione EUR 3.000 = base EUR 37.700, IRPEF lorda EUR 9.300, meno credito d'imposta EUR 7.400 (80% dell'imposta CH), IRPEF netta EUR 1.900. Netto finale: CHF 48.020 - EUR 1.900 ≈ EUR 48.800.",
      en:
        "Example computed with Ticino 2026 tables (single A0N, LPP 10%, LAMal SSN option, 12 months + 13th): gross CHF 70,000, social contributions CHF 4,480 (6.4%), LPP CHF 4,350 (6.2% coordinated salary), LAMal SSN CHF 5,250 (7.5% up to cap), withholding tax CHF 7,900 (11.3% effective). Swiss annual net about CHF 48,020, monthly CHF 4,000 [source: AFC Ticino calculator 2026]. In Italy the new worker pays IRPEF on CHF 48,020 (~EUR 50,700 at 2026 avg rate), minus €10,000 exemption and €3,000 deduction = base €37,700, gross IRPEF €9,300, minus €7,400 foreign tax credit (80% of CH), net IRPEF €1,900. Final net: CHF 48,020 − €1,900 ≈ €48,800.",
      de:
        "Beispiel Tessin 2026 (ledig A0N, BVG 10 %, KVG-SSN-Option, 12 + 13): brutto CHF 70'000, Sozialbeiträge CHF 4'480 (6,4 %), BVG CHF 4'350 (6,2 % koordinierter Lohn), KVG-SSN CHF 5'250 (7,5 %), Quellensteuer CHF 7'900 (11,3 % effektiv). Schweizer Nettolohn jährlich ca. CHF 48'020, monatlich CHF 4'000 [Quelle: AFC Tessin Rechner 2026]. In Italien zahlt der neue Grenzgänger IRPEF auf CHF 48'020 (~50'700 € zum Jahresmittel), abzüglich 10'000 € Freibetrag + 3'000 € Abzug = Basis 37'700 €, Brutto-IRPEF 9'300 €, abzüglich 7'400 € Anrechnung (80 % CH-Steuer), netto 1'900 €. Endsaldo: CHF 48'020 − 1'900 € ≈ 48'800 €.",
      fr:
        "Exemple barème Tessin 2026 (célibataire A0N, LPP 10 %, LAMal SSN, 12 + 13) : brut CHF 70 000, cotisations sociales CHF 4 480 (6,4 %), LPP CHF 4 350 (6,2 % coordonné), LAMal-SSN CHF 5 250 (7,5 %), impôt source CHF 7 900 (11,3 % effectif). Net suisse annuel ~CHF 48 020, mensuel ~CHF 4 000 [source : calculateur AFC Tessin 2026]. En Italie le nouveau frontalier paie IRPEF sur CHF 48 020 (~50 700 € au taux moyen 2026), moins franchise 10 000 € + déduction 3 000 € = base 37 700 €, IRPEF brut 9 300 €, moins crédit 7 400 € (80 % impôt CH), IRPEF net 1 900 €. Net final : CHF 48 020 − 1 900 € ≈ 48 800 €.",
    },
    relatedLinks: [
      {
        href: '/statistiche/confronta-stipendi/',
        label: {
          it: 'Confronta stipendi',
          en: 'Compare salaries',
          de: 'Löhne vergleichen',
          fr: 'Comparer les salaires',
        },
      },
    ],
    sources: [
      'https://www4.ti.ch/dfe/dc/imposta-alla-fonte',
    ],
  },
  {
    id: 'stipendi-bonus-premio-natale',
    category: 'stipendi',
    question: {
      it: 'Il bonus annuale è obbligatorio e come è tassato?',
      en: 'Is the annual bonus mandatory and how is it taxed?',
      de: 'Ist der Jahresbonus obligatorisch und wie wird er besteuert?',
      fr: 'Le bonus annuel est-il obligatoire et comment est-il imposé ?',
    },
    answer: {
      it:
        "Il bonus non è obbligatorio salvo clausola contrattuale o pratica consolidata (art. 322d CO) [fonte: Fedlex CO RS 220]. Se il contratto definisce criteri oggettivi (risultato, fatturato) e importo determinabile, il bonus è considerato «gratifica» ed è parte del salario dovuto. Se invece è «a discrezione» del datore senza criteri, l'obbligo di pagamento si consolida dopo 3-5 anni di versamento continuativo (giurisprudenza TF 4A_230/2022). La tassazione è identica a quella della tredicesima: imposta alla fonte sulla tabella cantonale, ingloba l'intero reddito annuo. Per il nuovo frontaliere il bonus entra nel reddito imponibile IRPEF italiano nel quadro RC. I contributi sociali AVS e la LPP si applicano. Nel Ticino bonus bancari sono comuni e spesso versati in marzo-aprile dell'anno successivo.",
      en:
        "The bonus is not mandatory unless provided by contract or consolidated practice (CO art. 322d) [source: Fedlex CO RS 220]. If the contract defines objective criteria (results, turnover) with determinable amount, the bonus is a «gratuity» and part of owed salary. If «at employer's discretion» without criteria, obligation consolidates after 3-5 years of continuous payment (Federal Court judgement 4A_230/2022). Taxation is identical to the 13th-month: withholding on the cantonal table covers the full annual income. For the new cross-border worker the bonus enters Italian IRPEF taxable income in section RC. AVS and LPP contributions apply. Ticino banks typically pay bonuses in March-April of the following year.",
      de:
        "Der Bonus ist nur bei Vertragsklausel oder konsolidierter Praxis obligatorisch (OR Art. 322d) [Quelle: Fedlex OR SR 220]. Definiert der Vertrag objektive Kriterien (Ergebnis, Umsatz) und bestimmbaren Betrag, ist der Bonus «Gratifikation» und Lohnbestandteil. Im freien Ermessen des Arbeitgebers: Pflicht nach 3-5 Jahren regelmässiger Zahlung (BGer 4A_230/2022). Besteuerung wie 13. Monatslohn: Quellensteuer auf Kantonstabelle. Neuer Grenzgänger: Bonus in Block RC der IRPEF. AHV und BVG-Beiträge fällig. Tessiner Banken zahlen Boni oft März-April des Folgejahres.",
      fr:
        "Le bonus n'est obligatoire que si prévu au contrat ou par pratique consolidée (CO art. 322d) [source : Fedlex CO RS 220]. Si critères objectifs (résultat, CA) et montant déterminable, c'est une gratification due. « À discrétion » sans critères : obligation après 3-5 ans de versement continu (TF 4A_230/2022). Imposition identique au 13e mois : impôt source sur barème cantonal. Pour le nouveau frontalier : bonus dans le cadre RC de l'IRPEF. Cotisations AVS et LPP dues. Banques tessinoises : bonus versés souvent mars-avril de l'année suivante.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
      'https://www.bger.ch/',
    ],
  },
  {
    id: 'stipendi-lohnausweis-certificato',
    category: 'stipendi',
    question: {
      it: 'Che cos\'è il Lohnausweis e a cosa serve per la dichiarazione italiana?',
      en: 'What is the Lohnausweis and what is it used for in the Italian tax return?',
      de: 'Was ist der Lohnausweis und wozu dient er in der italienischen Steuererklärung?',
      fr: 'Qu\'est-ce que le Lohnausweis et à quoi sert-il dans la déclaration italienne ?',
    },
    answer: {
      it:
        "Il Lohnausweis (certificato di salario) è il documento riassuntivo emesso ogni anno dal datore di lavoro svizzero entro il 31 marzo (art. 127 LIFD) [fonte: Fedlex LIFD RS 642.11]. Riporta salario lordo, tredicesima, bonus, contributi AVS/LPP/LAINF, indennità, prestazioni in natura (alloggio, auto aziendale) e imposta alla fonte versata. Per il nuovo frontaliere è il documento base della dichiarazione italiana: va allegato al modello Redditi PF per giustificare il reddito estero (quadro RC) e il credito d'imposta (quadro CE). Va conservato per almeno 10 anni. In caso di contenzioso con l'AFC Ticino o l'Agenzia delle Entrate, è il documento probatorio principale. Il codice cantonale di compilazione è unificato (modello 11) ed è utilizzabile in tutti i cantoni svizzeri.",
      en:
        "The Lohnausweis (salary certificate) is the annual summary issued by the Swiss employer by 31 March (LIFD art. 127) [source: Fedlex LIFD RS 642.11]. It reports gross salary, 13th-month, bonuses, AVS/LPP/LAINF contributions, allowances, benefits in kind (lodging, company car) and withholding tax paid. For the new cross-border worker it is the cornerstone of the Italian tax return: attached to Redditi PF to justify foreign income (RC) and foreign tax credit (CE). Keep for at least 10 years. In disputes with AFC Ticino or Agenzia delle Entrate it is the primary evidence. The cantonal template is unified (form 11) and valid in all Swiss cantons.",
      de:
        "Der Lohnausweis ist die jährliche Zusammenfassung des Schweizer Arbeitgebers bis 31. März (DBG Art. 127) [Quelle: Fedlex DBG SR 642.11]. Enthält Bruttolohn, 13. ML, Boni, AHV/BVG/UVG-Beiträge, Spesen, Naturalleistungen (Wohnung, Dienstauto) und Quellensteuer. Für neuen Grenzgänger Kernbeleg der italienischen Steuererklärung: Beilage zum Redditi PF für ausländisches Einkommen (RC) und Steueranrechnung (CE). Mindestens 10 Jahre aufbewahren. Bei Streit mit AFC Tessin oder Agenzia Entrate Hauptbeweis. Formular 11 einheitlich für alle Kantone.",
      fr:
        "Le Lohnausweis (certificat de salaire) est le récapitulatif annuel émis par l'employeur suisse au 31 mars (LIFD art. 127) [source : Fedlex LIFD RS 642.11]. Contient salaire brut, 13e mois, bonus, cotisations AVS/LPP/LAA, indemnités, prestations en nature (logement, voiture), impôt à la source. Pour le nouveau frontalier : pièce maîtresse de la déclaration italienne, annexée au Redditi PF pour justifier revenu (RC) et crédit d'impôt (CE). À conserver 10 ans. En litige avec AFC Tessin ou Agenzia Entrate : preuve principale. Modèle 11 unifié pour tous les cantons.",
    },
    sources: [
      'https://www.estv.admin.ch/estv/it/home/direkte-bundessteuer/lohnausweis.html',
    ],
  },
  {
    id: 'stipendi-malattia-continuazione-salario',
    category: 'stipendi',
    question: {
      it: 'Quanti giorni di malattia sono retribuiti e chi paga?',
      en: 'How many sick days are paid and who pays?',
      de: 'Wie viele Krankheitstage werden bezahlt und von wem?',
      fr: 'Combien de jours de maladie sont rémunérés et qui paie ?',
    },
    answer: {
      it:
        "L'art. 324a CO obbliga il datore a pagare il salario durante la malattia in base alla scala bernese, zurighese o basilese (regionale) [fonte: Fedlex CO RS 220]. Scala bernese: 3 settimane nel 1° anno, 1 mese nel 2°, 2 mesi nel 3°, 3 mesi nel 4°-9°, 4 mesi nel 10°-14°, 5 mesi nel 15°-19°. Molti CCL prevedono invece un'assicurazione indennità giornaliera malattia (AIGM) che copre 720 giorni in 900 al 80-90% del salario, gestita dal datore con SUVA/AXA/Helvetia. Il premio AIGM è spesso ripartito al 50% tra datore e dipendente. Il frontaliere riceve l'indennità normalmente tramite busta paga. Il certificato medico va presentato dal 3° giorno. Diritto a 10 giorni/anno per accudire figlio malato (art. 324a cpv. 3 CO).",
      en:
        "CO art. 324a requires the employer to pay salary during illness per the Bern, Zurich or Basel scale (regional) [source: Fedlex CO RS 220]. Bern scale: 3 weeks in year 1, 1 month year 2, 2 months year 3, 3 months years 4-9, 4 months years 10-14, 5 months years 15-19. Many CLAs replace this with a collective daily illness allowance insurance (AIGM) covering 720 days in 900 at 80-90% of salary, managed by the employer with SUVA/AXA/Helvetia. AIGM premium often split 50/50. The cross-border worker receives it through payroll. Medical certificate required from day 3. 10 days/year for sick-child leave (CO art. 324a para. 3).",
      de:
        "OR Art. 324a verpflichtet den Arbeitgeber zur Lohnfortzahlung gemäss Berner, Zürcher oder Basler Skala (regional) [Quelle: Fedlex OR SR 220]. Berner Skala: 3 Wochen im 1. Jahr, 1 Mt. im 2., 2 Mt. im 3., 3 Mt. Jahre 4-9, 4 Mt. Jahre 10-14, 5 Mt. Jahre 15-19. Viele GAV ersetzen dies durch eine Krankentaggeldversicherung (KTG), die 720 Tage in 900 zu 80-90 % deckt (SUVA, AXA, Helvetia). KTG-Prämie oft 50/50. Auszahlung über die Lohnabrechnung. Arztzeugnis ab 3. Tag. 10 Tage/Jahr für Betreuung krankes Kind (OR Art. 324a Abs. 3).",
      fr:
        "L'art. 324a CO oblige l'employeur à verser le salaire en cas de maladie selon l'échelle bernoise, zurichoise ou bâloise (régionale) [source : Fedlex CO RS 220]. Échelle bernoise : 3 semaines année 1, 1 mois année 2, 2 mois année 3, 3 mois années 4-9, 4 mois années 10-14, 5 mois années 15-19. De nombreuses CCT remplacent par une assurance perte de gain maladie (APGM) couvrant 720 jours sur 900 à 80-90 % du salaire (SUVA, AXA, Helvetia). Prime APGM souvent partagée 50/50. Versement via paie. Certificat médical dès le 3e jour. 10 jours/an pour enfant malade (CO art. 324a al. 3).",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    ],
  },
  {
    id: 'stipendi-ferie-vacanze-conteggio',
    category: 'stipendi',
    question: {
      it: 'Quanti giorni di ferie ho diritto come frontaliere?',
      en: 'How many vacation days am I entitled to as a cross-border worker?',
      de: 'Wie viele Ferientage stehen mir als Grenzgänger zu?',
      fr: 'À combien de jours de vacances ai-je droit comme frontalier ?',
    },
    answer: {
      it:
        "L'art. 329a CO garantisce un minimo di 4 settimane/anno di ferie pagate (5 settimane fino ai 20 anni compiuti) [fonte: Fedlex CO RS 220]. I CCL prevedono spesso 5 settimane dal 3° anno di servizio e 6 settimane dai 50 anni. Le ferie sono calcolate in base al tempo pieno (40-42 ore) e riproporzionate per part-time. La tredicesima è pagata sui giorni di ferie perché equivalgono a lavoro retribuito. Le ferie non possono essere liquidate in contanti salvo fine rapporto (art. 329d cpv. 2 CO). Il salario ferie (Ferienlohn) per lavoratori a ore è calcolato 8,33% del salario lordo (per 4 settimane) o 10,64% (per 5). In Italia il frontaliere non accumula giorni di ferie SSN: le ferie sono solo svizzere.",
      en:
        "CO art. 329a guarantees a minimum 4 weeks/year of paid holidays (5 weeks up to age 20) [source: Fedlex CO RS 220]. CLAs often grant 5 weeks from year 3 and 6 weeks from age 50. Holidays are calculated on full-time basis (40-42 hours) and prorated for part-time. The 13th-month is paid on holiday days (equivalent to work). Holidays cannot be cashed out except at employment end (CO art. 329d para. 2). Holiday pay (Ferienlohn) for hourly workers: 8.33% of gross (4 weeks) or 10.64% (5 weeks). In Italy the cross-border worker does not accumulate SSN leave days: holidays are Swiss-only.",
      de:
        "OR Art. 329a garantiert mind. 4 Ferienwochen/Jahr bezahlt (5 Wochen bis 20 Jahre) [Quelle: Fedlex OR SR 220]. GAV gewähren oft 5 Wochen ab 3. Dienstjahr und 6 Wochen ab 50 Jahren. Berechnung auf Vollzeitbasis (40-42 Std.), teilzeitanteilig. 13. Monatslohn auf Ferientage gezahlt. Ferien nicht abgeltbar, ausser bei Vertragsende (OR Art. 329d Abs. 2). Ferienlohn für Stundenlöhner: 8,33 % des Bruttos (4 Wo.) oder 10,64 % (5 Wo.). In Italien keine Ferienansprüche.",
      fr:
        "L'art. 329a CO garantit min. 4 semaines/an de vacances payées (5 semaines jusqu'à 20 ans) [source : Fedlex CO RS 220]. CCT accordent souvent 5 semaines dès la 3e année et 6 dès 50 ans. Base temps plein (40-42 h), prorata temps partiel. 13e mois payé sur jours de vacances. Compensation en espèces interdite sauf fin de rapport (CO art. 329d al. 2). Pour salariés à l'heure : 8,33 % du brut (4 sem.) ou 10,64 % (5 sem.). Pas d'accumulation côté italien : vacances uniquement suisses.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
    ],
  },
];
