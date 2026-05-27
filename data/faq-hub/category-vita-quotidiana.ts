import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "vita-quotidiana" (AE-5, 10/100).
 *
 * Scope: affitto (LUL), scuola (materne-medie), banche (UBS/PostFinance),
 * cambio valuta, costo vita, Billag/SSR.
 */
export const FAQ_vitaQuotidiana: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'vita-quotidiana-costo-vita-lugano-vs-varese',
    category: 'vita-quotidiana',
    question: {
      it: 'Quanto costa vivere a Lugano rispetto a Varese o Como?',
      en: 'How much does it cost to live in Lugano compared to Varese or Como?',
      de: 'Wie viel kostet das Leben in Lugano im Vergleich zu Varese oder Como?',
      fr: 'Quel est le coût de la vie à Lugano comparé à Varese ou Côme ?',
    },
    answer: {
      it:
        "L'indice UFSE (Ufficio federale di statistica) 2024 mostra un differenziale medio del +68% tra Lugano e Varese a parità di paniere [fonte: UFSE, Indice prezzi al consumo 2024]. Un appartamento di 70 mq a Lugano costa CHF 1.800-2.300/mese, a Varese EUR 650-850. Un caffè a Lugano CHF 4,50, a Varese EUR 1,20. La spesa alimentare settimanale per una famiglia di 4 persone: CHF 300-400 Lugano vs EUR 180-220 Varese. I trasporti pubblici Lugano abbonamento CHF 80/mese, Varese EUR 30. Istruzione pubblica gratuita in entrambi i Paesi, ma il materiale scolastico costa di più in Svizzera. La bolletta elettrica media annuale: CHF 900 Lugano vs EUR 650 Varese. Un frontaliere che mantiene la residenza in Italia beneficia dei costi più bassi mantenendo lo stipendio elevato.",
      en:
        "The UFSE (Federal Statistical Office) 2024 index shows an average gap of +68% between Lugano and Varese for the same basket [source: UFSE, Consumer Price Index 2024]. A 70 m² flat in Lugano costs CHF 1,800-2,300/month, in Varese EUR 650-850. A coffee: CHF 4.50 Lugano vs EUR 1.20 Varese. Weekly grocery for a family of four: CHF 300-400 Lugano vs EUR 180-220 Varese. Public transport subscription: CHF 80/month Lugano vs EUR 30 Varese. Public education is free in both, but school supplies cost more in Switzerland. Average yearly electricity bill: CHF 900 Lugano vs EUR 650 Varese. A cross-border worker keeping Italian residence benefits from lower costs while earning Swiss wages.",
      de:
        "Der BFS-Index 2024 zeigt einen Durchschnittsunterschied von +68 % zwischen Lugano und Varese für denselben Warenkorb [Quelle: BFS LIK 2024]. 70 m² Wohnung: Lugano CHF 1'800-2'300/Mt., Varese 650-850 €. Kaffee: CHF 4,50 vs 1,20 €. Wocheneinkauf Familie mit 4 Personen: CHF 300-400 vs 180-220 €. Öffentlicher Verkehr: CHF 80/Mt. Lugano vs 30 € Varese. Öffentliche Schule gratis, Schulmaterial teurer in CH. Stromrechnung im Jahr: CHF 900 Lugano vs 650 € Varese. Grenzgänger mit italienischem Wohnsitz profitieren von tieferen Kosten bei Schweizer Löhnen.",
      fr:
        "L'indice OFS 2024 montre un écart moyen de +68 % entre Lugano et Varese pour le même panier [source : OFS IPC 2024]. Appartement 70 m² : Lugano CHF 1 800-2 300/mois, Varese 650-850 €. Café : CHF 4,50 vs 1,20 €. Courses hebdomadaires famille de 4 : CHF 300-400 vs 180-220 €. Transports publics : CHF 80/mois Lugano vs 30 € Varese. École publique gratuite dans les deux pays, matériel plus cher en Suisse. Facture électrique annuelle : CHF 900 Lugano vs 650 € Varese. Le frontalier avec résidence italienne profite de coûts plus bas et de salaires suisses.",
    },
    relatedLinks: [
      {
        href: '/costo-della-vita/',
        label: {
          it: 'Costo della vita CH vs IT',
          en: 'Cost of living CH vs IT',
          de: 'Lebenskosten CH vs IT',
          fr: 'Coût de la vie CH vs IT',
        },
      },
    ],
    sources: [
      'https://www.bfs.admin.ch/bfs/it/home/statistiche/prezzi.html',
    ],
  },
  {
    id: 'vita-quotidiana-cambio-euro-chf-banca',
    category: 'vita-quotidiana',
    question: {
      it: 'Dove conviene cambiare CHF in EUR come frontaliere?',
      en: 'Where is it best to exchange CHF to EUR as a cross-border worker?',
      de: 'Wo wechselt man als Grenzgänger am besten CHF in EUR?',
      fr: 'Où vaut-il mieux changer des CHF en EUR en tant que frontalier ?',
    },
    answer: {
      it:
        "Le opzioni principali: (a) bancomat italiani prelevando CHF (spese 1-3%), (b) app di cambio online (Revolut, Wise — spread 0,3-0,5%), (c) cambiavalute privati a Chiasso, Ponte Tresa (spread 0,5-1,5%), (d) banche italiane (spread 2-4%), (e) PostFinance CH e banche italiane con conto multivaluta (spread zero per clienti business). Conviene mantenere il salario in CHF su conto svizzero e cambiare solo il necessario per le spese italiane. Revolut e Wise permettono cambio al «mid-market» senza commissione su importi <EUR 1.000/mese. Il frontaliere può aprire un conto multivaluta in Italia (Fineco, illimity) senza essere cliente svizzero. Attenzione: spostamenti fisici di contanti oltre EUR 10.000 devono essere dichiarati (Reg. UE 1672/2018) [fonte: Eur-Lex reg. 1672/2018].",
      en:
        "Main options: (a) Italian ATMs withdrawing CHF (1-3% fees), (b) online exchange apps (Revolut, Wise — spread 0.3-0.5%), (c) private exchanges in Chiasso, Ponte Tresa (spread 0.5-1.5%), (d) Italian banks (spread 2-4%), (e) PostFinance CH and Italian multi-currency accounts (zero spread for business). Best to keep salary in CHF on a Swiss account and convert only what is needed for Italian expenses. Revolut and Wise exchange at «mid-market» rate with no fee under EUR 1,000/month. Cross-border workers can open Italian multi-currency accounts (Fineco, illimity) without being Swiss clients. Physical cash over EUR 10,000 must be declared (EU Reg. 1672/2018) [source: Eur-Lex reg. 1672/2018].",
      de:
        "Hauptoptionen: (a) italienische Bancomat mit CHF-Abhebung (1-3 % Gebühr), (b) Online-Apps (Revolut, Wise — Spread 0,3-0,5 %), (c) private Wechselstuben in Chiasso, Ponte Tresa (0,5-1,5 %), (d) italienische Banken (2-4 %), (e) PostFinance CH und italienische Multi-Währungskonten (spreadfrei Business). Gehalt auf Schweizer Konto halten und nur Bedarf wechseln. Revolut und Wise: Mid-Market-Kurs, gratis bis 1'000 €/Monat. Multi-Währungskonten in Italien (Fineco, illimity) ohne CH-Kundschaft. Physisches Bargeld über 10'000 € muss deklariert werden (EU-VO 1672/2018) [Quelle: Eur-Lex VO 1672/2018].",
      fr:
        "Options principales : (a) bancomats italiens en CHF (frais 1-3 %), (b) applis de change (Revolut, Wise — spread 0,3-0,5 %), (c) bureaux privés Chiasso/Ponte Tresa (0,5-1,5 %), (d) banques italiennes (2-4 %), (e) PostFinance CH et comptes multidevises italiens (spread zéro Business). Mieux vaut garder le salaire en CHF et ne convertir que le nécessaire. Revolut et Wise : taux mid-market, sans frais <1 000 €/mois. Comptes multidevises en Italie (Fineco, illimity) ouverts aux frontaliers. Espèces physiques >10 000 € à déclarer (règl. UE 1672/2018) [source : Eur-Lex règl. 1672/2018].",
    },
    relatedLinks: [
      {
        href: '/comparatori/cambio-valuta/',
        label: {
          it: 'Comparatore cambio valuta',
          en: 'Currency exchange comparator',
          de: 'Währungsrechner',
          fr: 'Comparateur change',
        },
      },
    ],
    sources: [
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32018R1672',
    ],
  },
  {
    id: 'vita-quotidiana-banche-apertura-conto-frontaliere',
    category: 'vita-quotidiana',
    question: {
      it: 'Posso aprire un conto bancario svizzero come frontaliere?',
      en: 'Can I open a Swiss bank account as a cross-border worker?',
      de: 'Kann ich als Grenzgänger ein Schweizer Bankkonto eröffnen?',
      fr: 'Puis-je ouvrir un compte bancaire suisse en tant que frontalier ?',
    },
    answer: {
      it:
        "Sì, ma con condizioni più restrittive rispetto ai residenti svizzeri [fonte: FINMA, regolamento antiriciclaggio]. PostFinance, UBS, Credit Suisse/UBS, Raiffeisen, BPS Suisse e Banca Stato accettano frontalieri con permesso G e contratto di lavoro svizzero. Documenti richiesti: permesso G, contratto di lavoro, passaporto/carta d'identità, certificato di residenza italiano, giustificativo domicilio italiano (bolletta). Alcune banche richiedono saldo minimo di CHF 5.000-10.000 per conti correnti gratuiti. Il conto è necessario per ricevere lo stipendio svizzero e per il 2° pilastro. Conti online come Neon, Revolut Business CH richiedono solo documenti digitali. I frontalieri non possono aprire conti «cittadini» (privati per residenti); i prodotti offerti sono conti stipendio, conti risparmio e conti deposito titoli. CRS (scambio automatico CH-IT) implica notifica annuale a fisco italiano.",
      en:
        "Yes, but under stricter conditions than Swiss residents [source: FINMA AML regulation]. PostFinance, UBS, Credit Suisse/UBS, Raiffeisen, BPS Suisse and Banca Stato accept cross-border workers with G permit and Swiss work contract. Required: G permit, work contract, passport/ID, Italian residence certificate, proof of Italian address (bill). Some banks require minimum balance CHF 5,000-10,000 for free accounts. The account is needed to receive Swiss salary and manage the 2nd pillar. Online banks like Neon, Revolut Business CH only need digital docs. Cross-border workers cannot open «resident» accounts; offered products are salary, savings and securities deposits. CRS (automatic CH-IT exchange) triggers yearly reporting to Italian tax authorities.",
      de:
        "Ja, mit strengeren Bedingungen als für Einwohner [Quelle: FINMA GwG-Verordnung]. PostFinance, UBS, Credit Suisse/UBS, Raiffeisen, BPS Suisse und Banca Stato nehmen Grenzgänger mit G-Bewilligung und Schweizer Arbeitsvertrag an. Unterlagen: G-Bewilligung, Vertrag, Pass/ID, italienisches Wohnsitzzeugnis, Adressnachweis (Rechnung). Teilweise Mindestsaldo CHF 5'000-10'000 für kostenlose Konten. Nötig für Lohn und 2. Säule. Online-Banken wie Neon, Revolut Business CH: nur digitale Unterlagen. Kein «Einwohnerkonto»; angeboten werden Lohn-, Spar- und Depotkonten. CRS (automatischer CH-IT-Austausch) meldet jährlich an italienisches Steueramt.",
      fr:
        "Oui, sous conditions plus strictes que les résidents [source : règl. FINMA LBA]. PostFinance, UBS, Credit Suisse/UBS, Raiffeisen, BPS Suisse et Banca Stato acceptent les frontaliers avec permis G et contrat suisse. Documents : permis G, contrat, passeport/CNI, certificat de résidence italien, justificatif d'adresse (facture). Certaines banques exigent un solde minimum CHF 5 000-10 000 pour des comptes gratuits. Nécessaire pour le salaire et le 2e pilier. Banques en ligne (Neon, Revolut Business CH) : documents numériques uniquement. Pas de compte « résident » ; comptes salaire, épargne, titres. Le CRS (échange automatique CH-IT) signale chaque année au fisc italien.",
    },
    sources: [
      'https://www.finma.ch/',
      'https://www.snb.ch/',
    ],
  },
  {
    id: 'vita-quotidiana-affitto-alloggio-lugano',
    category: 'vita-quotidiana',
    question: {
      it: 'Quanto costa affittare un appartamento a Lugano o Mendrisio?',
      en: 'How much does it cost to rent an apartment in Lugano or Mendrisio?',
      de: 'Wie viel kostet es, eine Wohnung in Lugano oder Mendrisio zu mieten?',
      fr: 'Combien coûte la location d\'un appartement à Lugano ou Mendrisio ?',
    },
    answer: {
      it:
        "L'indice ufficiale dei canoni (OCA, TI-USTAT 2024) indica: Lugano centro CHF 24/mq/mese (appartamento 60 mq ≈ CHF 1.450 al mese + CHF 200 spese), Mendrisio centro CHF 18/mq (60 mq ≈ CHF 1.090), Bellinzona CHF 16/mq, Locarno CHF 19/mq [fonte: TI.ch USTAT, canoni locazione 2024]. Il frontaliere può affittare come privato in Svizzera per uso secondario (pied-à-terre) o per trasferirsi in permesso B. La locazione è regolata dal CO art. 253-274g. Cauzione massima 3 mesi d'affitto su conto bancario vincolato. Gli annunci appaiono su homegate.ch, immoscout24.ch, comparis.ch. Il contratto prevede preavviso 3 mesi per la risoluzione. I costi energetici (riscaldamento, acqua calda) sono separati e regolati da nebenkosten annuale. Allarga il tuo raggio a Capriasca o Cadro per canoni minori.",
      en:
        "The official rent index (OCA, TI-USTAT 2024): Lugano centre CHF 24/m²/month (60 m² flat ≈ CHF 1,450/month + CHF 200 charges), Mendrisio centre CHF 18/m² (60 m² ≈ CHF 1,090), Bellinzona CHF 16/m², Locarno CHF 19/m² [source: TI.ch USTAT 2024 rent data]. A cross-border worker can rent privately in Switzerland for occasional use or to move to B permit. Lease regulated by CO art. 253-274g. Maximum deposit 3 months' rent on an escrow account. Listings on homegate.ch, immoscout24.ch, comparis.ch. Standard notice 3 months. Energy costs (heating, hot water) are separate and settled annually (Nebenkosten). Widen your search to Capriasca or Cadro for lower rents.",
      de:
        "Der offizielle Mietindex (OCA, TI-USTAT 2024): Lugano Zentrum CHF 24/m²/Mt. (60 m² ≈ CHF 1'450/Mt. + CHF 200 Nebenkosten), Mendrisio Zentrum CHF 18/m² (60 m² ≈ CHF 1'090), Bellinzona CHF 16/m², Locarno CHF 19/m² [Quelle: TI.ch USTAT Mietzinsdaten 2024]. Grenzgänger können für gelegentliche Nutzung oder B-Umzug mieten. Mietrecht OR Art. 253-274g. Kaution max. 3 Monatsmieten auf Sperrkonto. Angebote: homegate.ch, immoscout24.ch, comparis.ch. Kündigungsfrist 3 Mt. Energiekosten separat (Nebenkosten, jährliche Abrechnung). Capriasca oder Cadro für tiefere Mieten.",
      fr:
        "L'indice officiel des loyers (OCA, TI-USTAT 2024) : Lugano centre CHF 24/m²/mois (appartement 60 m² ≈ CHF 1 450/mois + CHF 200 charges), Mendrisio centre CHF 18/m² (60 m² ≈ CHF 1 090), Bellinzone CHF 16/m², Locarno CHF 19/m² [source : TI.ch USTAT loyers 2024]. Le frontalier peut louer en Suisse pour usage secondaire ou permis B. Bail régi par CO art. 253-274g. Caution max 3 mois sur compte bloqué. Annonces : homegate.ch, immoscout24.ch, comparis.ch. Préavis 3 mois. Charges énergie séparées (Nebenkosten, décompte annuel). Élargir à Capriasca ou Cadro pour loyers plus bas.",
    },
    sources: [
      'https://www3.ti.ch/ustat/',
    ],
  },
  {
    id: 'vita-quotidiana-serafe-canone-radio-tv',
    category: 'vita-quotidiana',
    question: {
      it: 'I frontalieri devono pagare il canone Serafe/SSR?',
      en: 'Must cross-border workers pay the Serafe/SSR media fee?',
      de: 'Müssen Grenzgänger die Serafe/SRG-Gebühr zahlen?',
      fr: 'Les frontaliers doivent-ils payer la redevance Serafe/SSR ?',
    },
    answer: {
      it:
        "Il canone radio-TV Serafe (ex Billag) è dovuto da ogni «economia domestica» residente in Svizzera (art. 69 LRTV) [fonte: Fedlex LRTV RS 784.40]. Chi NON risiede in Svizzera (frontaliere con permesso G) NON paga il canone sulla propria abitazione italiana. Se però il frontaliere affitta o possiede un appartamento in Svizzera (anche come pied-à-terre), quell'economia domestica paga il canone Serafe CHF 335/anno (2025). Si notifica l'avvio al comune di ubicazione. I dipendenti che ascoltano radio o TV al lavoro: canone aziendale pagato dal datore secondo fatturato (da CHF 365 a oltre CHF 49.925 per anno). Se si possiede una casa secondaria in Svizzera non usata per abitazione, si può richiedere l'esenzione. In Italia si paga il canone RAI (EUR 90/anno, addebito in bolletta elettrica).",
      en:
        "The Serafe (formerly Billag) radio-TV fee is owed by every «household» resident in Switzerland (LRTV art. 69) [source: Fedlex LRTV RS 784.40]. Those NOT resident in Switzerland (G permit holders) do NOT pay the fee on their Italian home. However, if the cross-border worker rents or owns a Swiss dwelling (even as pied-à-terre), that household pays Serafe CHF 335/year (2025). You notify the municipality of location. Employees listening at work: corporate fee paid by the employer by turnover (from CHF 365 to over CHF 49,925/year). A Swiss secondary home not used for living can be exempted. In Italy the RAI fee is EUR 90/year (billed on the electricity invoice).",
      de:
        "Die Serafe-Abgabe (ehemals Billag) für Radio und Fernsehen schuldet jeder in der Schweiz ansässige Haushalt (RTVG Art. 69) [Quelle: Fedlex RTVG SR 784.40]. Wer NICHT in der Schweiz wohnt (G-Bewilligung), zahlt für die italienische Wohnung nichts. Mietet oder besitzt der Grenzgänger eine Schweizer Wohnung (auch als Pied-à-terre), schuldet dieser Haushalt CHF 335/Jahr (2025). Anmeldung bei der Gemeinde. Arbeitnehmer am Arbeitsplatz: Firmenabgabe vom Arbeitgeber nach Umsatz (CHF 365 bis >CHF 49'925/Jahr). Schweizer Zweitwohnung ohne Nutzung: Befreiung möglich. In Italien: RAI 90 €/Jahr, mit Stromrechnung.",
      fr:
        "La redevance Serafe (ex-Billag) est due par chaque ménage résidant en Suisse (LRTV art. 69) [source : Fedlex LRTV RS 784.40]. Ceux qui ne résident PAS en Suisse (permis G) NE la paient PAS pour leur logement italien. En revanche, si le frontalier loue ou possède un logement suisse (même pied-à-terre), ce ménage paie Serafe CHF 335/an (2025). Notification à la commune. Salariés qui écoutent au travail : redevance entreprise payée par l'employeur selon CA (CHF 365 à >CHF 49 925/an). Résidence secondaire non utilisée : exemption possible. En Italie : redevance RAI 90 €/an sur la facture d'électricité.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/2007/144/it',
      'https://www.serafe.ch/',
    ],
  },
  {
    id: 'vita-quotidiana-scuola-pubblica-figli',
    category: 'vita-quotidiana',
    question: {
      it: 'Posso iscrivere i figli alla scuola pubblica svizzera?',
      en: 'Can I enrol my children in Swiss public schools?',
      de: 'Kann ich meine Kinder in die Schweizer öffentliche Schule einschreiben?',
      fr: 'Puis-je inscrire mes enfants à l\'école publique suisse ?',
    },
    answer: {
      it:
        "Solo se la famiglia è effettivamente residente in Svizzera (permesso B/C). La scuola pubblica ticinese (Scuola dell'Infanzia 3-6 anni, scuola elementare 6-11, media 11-15, liceo 15-19) è gratuita e obbligatoria per i residenti (Legge cantonale sulla scuola, art. 1) [fonte: Ti.ch DECS]. I figli di frontalieri con permesso G residenti in Italia frequentano la scuola italiana. Eccezioni: scuole private internazionali a Lugano (es. TASIS, Franklin College) aperte a chiunque paghi la retta (CHF 25.000-45.000/anno). Alcuni Comuni ticinesi accettano figli di dipendenti strategici come «ospiti» con autorizzazione speciale DECS (rari, principalmente edilizia). Per i figli di frontalieri il Cantone offre formazione duale (apprendistato) con lavoro + scuola 1-2 giorni/settimana per residenti.",
      en:
        "Only if the family is actually resident in Switzerland (B/C permit). The Ticino public school (Kindergarten 3-6, primary 6-11, middle 11-15, high school 15-19) is free and compulsory for residents (cantonal school law art. 1) [source: Ti.ch DECS]. Children of G permit cross-border workers residing in Italy attend Italian school. Exceptions: Lugano international private schools (TASIS, Franklin College) open to anyone paying tuition (CHF 25,000-45,000/year). Some Ticino municipalities accept children of strategic employees as «guests» with DECS special authorisation (rare, mostly construction). For cross-border workers' children the Canton offers dual training (apprenticeship) with work + school 1-2 days/week for residents.",
      de:
        "Nur bei tatsächlichem Wohnsitz in der Schweiz (B/C-Bewilligung). Die Tessiner öffentliche Schule (Kindergarten 3-6, Primarschule 6-11, Mittelstufe 11-15, Gymnasium 15-19) ist für Einwohner gratis und obligatorisch (kantonales Schulgesetz Art. 1) [Quelle: Ti.ch DECS]. G-Grenzgänger: Kinder besuchen die italienische Schule. Ausnahme: private internationale Schulen in Lugano (TASIS, Franklin College) ab CHF 25'000-45'000/Jahr. Einige Gemeinden nehmen Kinder strategischer Mitarbeitender als «Gäste» mit DECS-Bewilligung auf (selten, v. a. Bau). Duale Berufsbildung (Lehre) nur für Einwohner.",
      fr:
        "Seulement si la famille réside effectivement en Suisse (permis B/C). L'école publique tessinoise (jardin d'enfants 3-6 ans, primaire 6-11, cycle 11-15, gymnase 15-19) est gratuite et obligatoire pour les résidents (loi cantonale sur l'école art. 1) [source : Ti.ch DECS]. Frontaliers avec permis G : enfants scolarisés en Italie. Exceptions : écoles privées internationales à Lugano (TASIS, Franklin College) ouvertes à tous moyennant finance (CHF 25 000-45 000/an). Certaines communes tessinoises accueillent des enfants de salariés stratégiques comme « invités » avec autorisation DECS (rare, surtout BTP). La formation duale (apprentissage) n'est ouverte qu'aux résidents.",
    },
    sources: [
      'https://www4.ti.ch/decs/',
    ],
  },
  {
    id: 'vita-quotidiana-spesa-supermercati',
    category: 'vita-quotidiana',
    question: {
      it: 'È più conveniente fare la spesa in Svizzera o in Italia?',
      en: 'Is grocery shopping cheaper in Switzerland or in Italy?',
      de: 'Ist der Lebensmitteleinkauf in der Schweiz oder in Italien günstiger?',
      fr: 'Est-il plus avantageux de faire les courses en Suisse ou en Italie ?',
    },
    answer: {
      it:
        "In media la spesa alimentare in Italia costa il 40-50% in meno rispetto alla Svizzera, a parità di qualità [fonte: UFSE, Rapporto prezzi transfrontalieri 2024]. Pane, latte, carne, frutta e verdura sono significativamente più economici in Italia. Per questo molti frontalieri fanno la spesa settimanale in Italia nei supermercati Esselunga, Coop Italia, Lidl IT, Conad e iper Como/Chiasso. Limiti doganali: alimenti fino a CHF 300/persona/giorno rientrano in franchigia (Ordinanza sulle concessioni doganali, RS 631.012) [fonte: AFD]. Oltre la franchigia si paga IVA svizzera 8,1%. Carne e derivati animali: limite 1 kg/giorno per persona. Bevande alcoliche: 5L vino/persona, 1L super-alcolici. Il frontaliere deve dichiarare all'AFD solo se supera questi limiti. In Svizzera Migros, Coop, Denner e Aldi hanno offerte settimanali più competitive.",
      en:
        "On average, groceries in Italy cost 40-50% less than in Switzerland for the same quality [source: UFSE 2024 cross-border price report]. Bread, milk, meat, fruit and vegetables are significantly cheaper in Italy. Many cross-border workers do weekly shopping in Italy at Esselunga, Coop Italia, Lidl IT, Conad and Como/Chiasso hypermarkets. Customs limits: food up to CHF 300/person/day is exempt (Customs concessions ordinance, RS 631.012) [source: BAZG]. Beyond the franchise 8.1% Swiss VAT applies. Meat and animal products: 1 kg/person/day. Alcohol: 5L wine/person, 1L spirits. The cross-border worker declares to BAZG only if limits are exceeded. In Switzerland Migros, Coop, Denner and Aldi offer competitive weekly promotions.",
      de:
        "Im Schnitt sind Lebensmittel in Italien 40-50 % günstiger als in der Schweiz bei gleicher Qualität [Quelle: BFS Grenzpreisbericht 2024]. Brot, Milch, Fleisch, Obst und Gemüse deutlich günstiger. Viele Grenzgänger kaufen wöchentlich in Italien bei Esselunga, Coop Italia, Lidl IT, Conad und Como/Chiasso-Hypermärkten. Zollgrenzen: Lebensmittel bis CHF 300/Person/Tag zollfrei (Zollerleichterungs-VO SR 631.012) [Quelle: BAZG]. Darüber 8,1 % CH-MwSt. Fleisch: 1 kg/Person/Tag. Alkohol: 5 L Wein/Person, 1 L Spirituosen. Meldung an BAZG nur bei Überschreitung. In der Schweiz sind Migros, Coop, Denner und Aldi mit Wochenaktionen.",
      fr:
        "En moyenne, les courses en Italie coûtent 40-50 % de moins qu'en Suisse à qualité égale [source : rapport OFS prix transfrontaliers 2024]. Pain, lait, viande, fruits et légumes nettement moins chers en Italie. Beaucoup de frontaliers font leurs courses à Esselunga, Coop Italia, Lidl IT, Conad et hypermarchés Como/Chiasso. Limites douane : aliments jusqu'à CHF 300/pers./jour en franchise (ordonnance sur les concessions douanières RS 631.012) [source : OFDF]. Au-delà, TVA suisse 8,1 %. Viande : 1 kg/pers./jour. Alcool : 5 L vin/pers., 1 L spiritueux. Déclaration à l'OFDF seulement si dépassement. En Suisse : Migros, Coop, Denner, Aldi avec promos hebdomadaires.",
    },
    sources: [
      'https://www.bazg.admin.ch/bazg/it/home/privatpersonen.html',
    ],
  },
  {
    id: 'vita-quotidiana-telefono-internet-ticino',
    category: 'vita-quotidiana',
    question: {
      it: 'Quali operatori telefonici conviene scegliere come frontaliere?',
      en: 'Which telecom operators are best for cross-border workers?',
      de: 'Welche Mobilfunkanbieter eignen sich am besten für Grenzgänger?',
      fr: 'Quels opérateurs téléphoniques choisir en tant que frontalier ?',
    },
    answer: {
      it:
        "La scelta dipende dall'uso. Se resta la SIM italiana (TIM, Vodafone, Iliad, ho.Mobile) si paga roaming UE gratuito (Reg. UE 2022/612) ma la Svizzera NON è UE: alcuni piani Extra-UE includono Svizzera (Iliad gigabyte in CH gratuiti fino a 8 GB, TIM Europe 30), altri applicano tariffe alte (fino a EUR 1/MB) [fonte: AGCOM, delibera 292/22/CONS]. Conviene un'offerta «Svizzera inclusa» per frontalieri. SIM svizzera (Swisscom, Sunrise, Salt) costa CHF 30-60/mese con roaming UE incluso, ma richiede permesso G come documento. Operatori virtuali low-cost (Yallo, digitec, Lebara) da CHF 20. Soluzione ibrida: SIM italiana per Italia + eSIM svizzera dati-only (Digital Republic CHF 15) per Svizzera. Internet casa a domicilio italiano: fibra TIM, Vodafone, Fastweb da EUR 25/mese.",
      en:
        "Choice depends on use. With an Italian SIM (TIM, Vodafone, Iliad, ho.Mobile) EU roaming is free (EU Reg. 2022/612) but Switzerland is NOT EU: some Extra-EU plans include Switzerland (Iliad free 8 GB in CH, TIM Europe 30), others apply high rates (up to EUR 1/MB) [source: AGCOM, decision 292/22/CONS]. A Swiss-inclusive plan is best. Swiss SIM (Swisscom, Sunrise, Salt) costs CHF 30-60/month with EU roaming, but requires G permit. Low-cost MVNOs (Yallo, digitec, Lebara) from CHF 20. Hybrid solution: Italian SIM for Italy + data-only Swiss eSIM (Digital Republic CHF 15) for Switzerland. Home internet at Italian address: TIM, Vodafone, Fastweb fibre from EUR 25/month.",
      de:
        "Wahl je nach Nutzung. Italienische SIM (TIM, Vodafone, Iliad, ho.Mobile): EU-Roaming gratis (EU-VO 2022/612), aber Schweiz ≠ EU: einige Extra-EU-Pakete schliessen CH ein (Iliad 8 GB gratis, TIM Europe 30), andere hohe Tarife bis 1 €/MB [Quelle: AGCOM Beschluss 292/22/CONS]. Schweizerisch inklusives Angebot bevorzugen. Schweizer SIM (Swisscom, Sunrise, Salt) CHF 30-60/Mt. mit EU-Roaming, aber G-Bewilligung nötig. Low-Cost MVNOs (Yallo, digitec, Lebara) ab CHF 20. Hybridlösung: IT-SIM für Italien + nur-Daten-eSIM Schweiz (Digital Republic CHF 15). Hausinternet italienische Adresse: TIM, Vodafone, Fastweb Glasfaser ab 25 €/Mt.",
      fr:
        "Choix selon l'usage. SIM italienne (TIM, Vodafone, Iliad, ho.Mobile) : roaming UE gratuit (règl. UE 2022/612) mais la Suisse n'est PAS UE : certains plans Extra-UE incluent la Suisse (Iliad 8 Go gratuits, TIM Europe 30), d'autres appliquent des tarifs élevés (jusqu'à 1 €/Mo) [source : AGCOM décision 292/22/CONS]. Privilégier une offre « Suisse incluse ». SIM suisse (Swisscom, Sunrise, Salt) CHF 30-60/mois avec roaming UE, mais permis G requis. MVNO low-cost (Yallo, digitec, Lebara) dès CHF 20. Solution hybride : SIM IT pour l'Italie + eSIM CH data-only (Digital Republic CHF 15). Internet domicile IT : fibre TIM, Vodafone, Fastweb dès 25 €/mois.",
    },
    sources: [
      'https://www.agcom.it/',
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32022R0612',
    ],
  },
  {
    id: 'vita-quotidiana-sanita-dottori-transfrontalieri',
    category: 'vita-quotidiana',
    question: {
      it: 'Posso curarmi in Italia con copertura svizzera?',
      en: 'Can I get Italian healthcare with Swiss cover?',
      de: 'Kann ich mich in Italien mit Schweizer Deckung behandeln lassen?',
      fr: 'Puis-je me soigner en Italie avec une couverture suisse ?',
    },
    answer: {
      it:
        "Sì, con il formulario S1 rilasciato dall'Istituto comune LAMal il frontaliere LAMal residente in Italia può farsi curare dal SSN italiano alle stesse tariffe degli altri italiani. Il S1 va depositato alla ASL di residenza entro 3 mesi e rinnovato ogni 3 anni [fonte: Reg. UE 883/2004 art. 17]. Gli assicurati in opzione SSN italiano ricevono tessera TEAM (Tessera Europea Assicurazione Malattia) per visite in Italia, Svizzera e UE in emergenza. Cure programmate all'estero richiedono autorizzazione S2 preventiva del proprio sistema sanitario. Il frontaliere LAMal può anche farsi rimborsare dalla propria cassa svizzera fino al doppio della tariffa svizzera per cure in Italia non urgenti (art. 41 cpv. 2ter LAMal). Controllare la convenzione transfrontaliera IRCCS Lugano e Ospedale Sant'Anna di Como.",
      en:
        "Yes, with an S1 form issued by the LAMal Joint Institution, an Italian-resident LAMal cross-border worker can receive Italian SSN care at standard Italian rates. The S1 is filed with the local ASL within 3 months and renewed every 3 years [source: EU Reg. 883/2004 art. 17]. SSN-option insureds get the European Health Insurance Card (EHIC) for emergency care in Italy, Switzerland and the EU. Planned foreign care needs prior S2 authorisation. LAMal-insured workers may also be reimbursed by their Swiss fund up to twice the Swiss tariff for non-urgent Italian care (LAMal art. 41 para. 2ter). Check the cross-border agreement between IRCCS Lugano and Ospedale Sant'Anna Como.",
      de:
        "Ja, mit dem Formular S1 der Gemeinsamen Einrichtung KVG kann der in Italien wohnhafte KVG-Grenzgänger italienische SSN-Versorgung zu Standardtarifen erhalten. S1 binnen 3 Monaten bei der ASL einreichen, alle 3 Jahre erneuern [Quelle: EU-VO 883/2004 Art. 17]. SSN-Option: EHIC-Karte für Notfälle. Geplante Auslandbehandlung: S2-Vorbewilligung. KVG-Versicherte können von der Schweizer Kasse bis zum Doppelten des CH-Tarifs für nicht dringende Behandlung in Italien erstattet werden (KVG Art. 41 Abs. 2ter). Grenzabkommen IRCCS Lugano ↔ Ospedale Sant'Anna Como beachten.",
      fr:
        "Oui, avec le formulaire S1 délivré par l'Institution commune LAMal, le frontalier LAMal résidant en Italie peut être soigné par le SSN italien aux tarifs standards. S1 à déposer à l'ASL locale sous 3 mois et renouveler tous les 3 ans [source : règl. UE 883/2004 art. 17]. Option SSN : carte CEAM pour soins d'urgence. Soins programmés à l'étranger : autorisation S2. Les assurés LAMal peuvent aussi être remboursés par leur caisse suisse jusqu'au double du tarif suisse pour des soins italiens non urgents (LAMal art. 41 al. 2ter). Vérifier la convention transfrontalière IRCCS Lugano ↔ Ospedale Sant'Anna Côme.",
    },
    sources: [
      'https://eur-lex.europa.eu/legal-content/IT/TXT/?uri=CELEX%3A32004R0883',
    ],
  },
  {
    id: 'vita-quotidiana-parcheggio-multa-circolazione',
    category: 'vita-quotidiana',
    question: {
      it: 'Come si pagano le multe svizzere dall\'Italia?',
      en: 'How do I pay Swiss traffic fines from Italy?',
      de: 'Wie bezahle ich Schweizer Bussen aus Italien?',
      fr: 'Comment payer les amendes suisses depuis l\'Italie ?',
    },
    answer: {
      it:
        "Le multe svizzere vanno pagate entro 30 giorni via bonifico IBAN sul bollettino allegato o sul sito della polizia cantonale [fonte: Ti.ch, polizia]. Dal 2024 la Svizzera ha ratificato la Convenzione UE per il riconoscimento reciproco delle sanzioni pecuniarie: se non paghi, l'autorità italiana può riscuotere via Agenzia Entrate-Riscossione (art. 10 Accordo di cooperazione in materia di polizia e giustizia [fonte: Fedlex SR 0.360.268.1]). Per multe fino a CHF 100 (sanzione disciplinare, es. eccesso di velocità lieve, infrazione di parcheggio) si può usare la «Ordnungsbusse» che non richiede la notifica personale. Sopra CHF 300 è una «contravvenzione» con notifica. Non pagare espone al rinnovo negato di permessi di circolazione o all'arresto all'ingresso successivo in Svizzera. I ricorsi vanno presentati alla Pretura entro 20 giorni.",
      en:
        "Swiss fines must be paid within 30 days by IBAN transfer on the attached slip or via the cantonal police website [source: Ti.ch police]. Since 2024 Switzerland has ratified the EU Convention on mutual recognition of financial penalties: unpaid fines can be collected by Italy's Agenzia Entrate-Riscossione (art. 10 Police and justice cooperation agreement [source: Fedlex SR 0.360.268.1]). Fines up to CHF 100 (disciplinary, minor speeding, parking) use the «Ordnungsbusse» without personal notification. Above CHF 300 it is a «contravention» with notification. Non-payment can block circulation permit renewal or trigger detention on re-entry. Appeals at the Pretura within 20 days.",
      de:
        "Schweizer Bussen sind binnen 30 Tagen per IBAN-Überweisung oder auf der Kantonspolizei-Website zu zahlen [Quelle: Ti.ch Polizei]. Seit 2024 ratifiziert die Schweiz das EU-Übereinkommen zur gegenseitigen Anerkennung von Geldsanktionen: unbezahlte Bussen kann die italienische Agenzia Entrate-Riscossione eintreiben (Art. 10 Polizei- und Justizabkommen [Quelle: Fedlex SR 0.360.268.1]). Bis CHF 100 (Disziplin, leichte Geschwindigkeit, Parkieren): Ordnungsbusse ohne persönliche Zustellung. Über CHF 300: Übertretung mit Zustellung. Nichtzahlung: kein Führerschein-Renewal oder Verhaftung bei Wiedereinreise. Beschwerde bei der Pretura binnen 20 Tagen.",
      fr:
        "Les amendes suisses se paient sous 30 jours par virement IBAN sur le bulletin joint ou via le site de la police cantonale [source : Ti.ch police]. Depuis 2024 la Suisse a ratifié la Convention UE sur la reconnaissance mutuelle des sanctions pécuniaires : les amendes impayées peuvent être perçues par l'Agenzia Entrate-Riscossione italienne (art. 10 accord coopération police-justice [source : Fedlex RS 0.360.268.1]). Amendes jusqu'à CHF 100 (disciplinaires, petits excès de vitesse, stationnement) : « Ordnungsbusse » sans notification personnelle. Au-delà de CHF 300 : contravention avec notification. Non-paiement : refus de renouvellement du permis ou interpellation à la prochaine entrée. Recours à la Pretura sous 20 jours.",
    },
    sources: [
      'https://www4.ti.ch/di/polizia/',
    ],
  },
];
