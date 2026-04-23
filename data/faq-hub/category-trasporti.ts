import type { FaqHubEntry } from './types';

/**
 * FAQ hub — category "trasporti" (AE-5, 10/100).
 *
 * Scope: auto (bollo, dogana, targa CH), treno (GA, abbonamenti),
 * assicurazione auto, carpooling, pendolarismo.
 */
export const FAQ_trasporti: ReadonlyArray<FaqHubEntry> = [
  {
    id: 'trasporti-auto-italiana-lavoro-ch',
    category: 'trasporti',
    question: {
      it: 'Posso usare la mia auto italiana per andare a lavoro in Svizzera?',
      en: 'Can I use my Italian-plated car to commute to work in Switzerland?',
      de: 'Darf ich mein Auto mit italienischem Kennzeichen zur Arbeit in der Schweiz benutzen?',
      fr: 'Puis-je utiliser ma voiture immatriculée en Italie pour me rendre au travail en Suisse ?',
    },
    answer: {
      it:
        "Sì, il frontaliere con permesso G può usare liberamente l'auto italiana per il pendolarismo quotidiano tra Italia e Svizzera, senza sdoganarla [fonte: AFD — Amministrazione federale delle dogane, scheda «Veicoli esteri»]. L'auto va però usata principalmente in Italia e non per spostamenti interni alla Svizzera (tranne il tragitto casa-lavoro). L'uso di un'auto italiana per viaggi privati prolungati in Svizzera può richiedere sdoganamento. Serve la vignetta autostradale svizzera (CHF 40/anno + CHF 40 eVignette 2026). La responsabilità civile italiana è valida tramite Carta Verde, ma si consiglia di informare l'assicurazione dell'uso frontaliero (possibile sovrappremio del 5-10%). Se si acquista auto in Svizzera con targa CH, il frontaliere residente in Italia deve pagare IVA e immatricolarla in Italia entro 6 mesi.",
      en:
        "Yes, a G permit cross-border worker may freely use their Italian-plated car for daily commute between Italy and Switzerland, without customs clearance [source: Swiss Federal Customs Administration, «Foreign vehicles» fact sheet]. The car must be used mainly in Italy and not for internal trips in Switzerland (except the home-work route). Extended private Swiss use may require customs clearance. The Swiss motorway vignette is required (CHF 40/year + CHF 40 eVignette 2026). Italian third-party liability is valid via Green Card, but notify the insurer of cross-border use (possible 5-10% surcharge). If you buy a CH-plated car as an Italian resident, you must pay Italian VAT and re-register it in Italy within 6 months.",
      de:
        "Ja, Grenzgänger mit G-Bewilligung dürfen ihr italienisches Auto ohne Verzollung für den täglichen Pendlerverkehr nutzen [Quelle: EZV — Eidgenössische Zollverwaltung, Merkblatt «Ausländische Fahrzeuge»]. Das Auto ist hauptsächlich in Italien zu verwenden; rein innerschweizerische Fahrten (ausser Arbeitsweg) sind eingeschränkt. Ausgedehnte Schweizer Privatfahrten können Verzollung verlangen. Autobahnvignette obligatorisch (CHF 40 + CHF 40 eVignette 2026). Italienische Haftpflicht über Grüne Karte gültig; Versicherer über Grenznutzung informieren (5-10 % Zuschlag möglich). Beim Kauf eines CH-Fahrzeugs durch einen in Italien Wohnhaften: italienische MwSt zahlen und binnen 6 Monaten in Italien immatrikulieren.",
      fr:
        "Oui, le frontalier avec permis G peut utiliser librement sa voiture immatriculée en Italie pour les trajets quotidiens Italie-Suisse sans dédouanement [source : AFD — Administration fédérale des douanes, fiche « Véhicules étrangers »]. La voiture doit rester principalement utilisée en Italie (hors trajet domicile-travail). Un usage privé prolongé en Suisse peut imposer le dédouanement. Vignette autoroutière obligatoire (CHF 40/an + CHF 40 eVignette 2026). Responsabilité civile italienne valable via Carte Verte ; informer l'assureur de l'usage frontalier (surprime 5-10 % possible). Achat d'une voiture suisse par un résident italien : payer la TVA italienne et immatriculer en Italie sous 6 mois.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/trasferimento-auto/',
        label: {
          it: 'Trasferimento auto CH-IT',
          en: 'CH-IT car transfer',
          de: 'Auto-Transfer CH-IT',
          fr: 'Transfert voiture CH-IT',
        },
      },
    ],
    sources: [
      'https://www.bazg.admin.ch/bazg/it/home/themen/einfuhr-in-die-schweiz.html',
    ],
  },
  {
    id: 'trasporti-vignetta-autostradale',
    category: 'trasporti',
    question: {
      it: 'La vignetta autostradale svizzera è obbligatoria per i frontalieri?',
      en: 'Is the Swiss motorway vignette mandatory for cross-border workers?',
      de: 'Ist die Schweizer Autobahnvignette für Grenzgänger obligatorisch?',
      fr: 'La vignette autoroutière suisse est-elle obligatoire pour les frontaliers ?',
    },
    answer: {
      it:
        "Sì, per circolare sulle autostrade e semi-autostrade svizzere (rete nazionale) serve la vignetta (art. 1 LVA, RS 741.71) [fonte: Fedlex LVA]. Costo CHF 40 per l'anno solare, valida da 1° dicembre anno precedente al 31 gennaio anno successivo. Dal 1° agosto 2023 è disponibile anche la eVignette digitale legata alla targa (stesso prezzo), acquistabile su via.admin.ch. L'eVignette si trasferisce a un nuovo veicolo solo in caso di vendita o distruzione del vecchio. La mancata vignetta comporta multa di CHF 200 + obbligo di acquisto. Non esiste tariffa ridotta per frontalieri. Se si evita l'autostrada (es. via Chiasso superficie) non serve. Il rimborso della vignetta da parte del datore di lavoro è esentasse se legato a spostamenti per servizio.",
      en:
        "Yes, to use Swiss motorways and semi-motorways (national network) the vignette is required (LVA art. 1, RS 741.71) [source: Fedlex LVA]. Cost CHF 40 per calendar year, valid from 1 December previous year to 31 January following. Since 1 August 2023 a digital eVignette (same price) linked to the plate is available on via.admin.ch. The eVignette can be transferred to a new vehicle only if the old one is sold or destroyed. Missing vignette: CHF 200 fine + compulsory purchase. No reduced rate for cross-border workers. Surface routes (e.g. via Chiasso-Mendrisio) are exempt. Vignette reimbursement by the employer for business trips is tax-free.",
      de:
        "Ja, für Schweizer Autobahnen und Halbautobahnen ist die Vignette erforderlich (NSAG Art. 1, SR 741.71) [Quelle: Fedlex NSAG]. CHF 40 pro Kalenderjahr, gültig 1. Dezember Vorjahr bis 31. Januar Folgejahr. Seit 01.08.2023 gibt es die kennzeichengebundene eVignette (gleich teuer) auf via.admin.ch. eVignette nur bei Verkauf/Zerstörung übertragbar. Fehlende Vignette: CHF 200 Busse + Kaufpflicht. Keine Grenzgängerermässigung. Ohne Autobahn (z. B. oberirdisch Chiasso-Mendrisio) keine Pflicht. Vignetten-Rückerstattung durch Arbeitgeber für Geschäftsfahrten steuerfrei.",
      fr:
        "Oui, pour circuler sur les autoroutes et semi-autoroutes suisses la vignette est requise (LVA art. 1, RS 741.71) [source : Fedlex LVA]. CHF 40/année civile, valable 1er décembre année précédente au 31 janvier suivante. Depuis 01.08.2023 l'eVignette numérique (même prix) liée à la plaque est disponible sur via.admin.ch. Transfert uniquement en cas de vente/destruction de l'ancien véhicule. Absence : CHF 200 d'amende + achat obligatoire. Aucun tarif réduit. Trajets sur route ordinaire (Chiasso-Mendrisio) exemptés. Remboursement par l'employeur pour déplacement professionnel : non imposable.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1994/1078_1078_1078/it',
      'https://www.via.admin.ch/',
    ],
  },
  {
    id: 'trasporti-abbonamento-ga-generale',
    category: 'trasporti',
    question: {
      it: 'Conviene l\'abbonamento generale FFS per un frontaliere?',
      en: 'Is the SBB GA travelcard worthwhile for a cross-border worker?',
      de: 'Lohnt sich das SBB-Generalabonnement für einen Grenzgänger?',
      fr: 'L\'abonnement général CFF vaut-il la peine pour un frontalier ?',
    },
    answer: {
      it:
        "L'AG (Generalabonnement) costa CHF 3.995 in 2ª classe adulto nel 2025 (comprese FFS, treni regionali, battelli, autopostali) [fonte: FFS, tariffe 2025]. Per un frontaliere Chiasso-Lugano il biglietto singolo costa CHF 13,80, quindi AG conviene oltre 289 tratte/anno (circa 145 giorni). L'alternativa più economica è l'abbonamento di tratta (Punto-a-Punto, CHF 1.850/anno Chiasso-Lugano) o lo «Step» multitratta. L'abbonamento metà-prezzo (CHF 190/anno) dimezza i biglietti singoli e conviene per viaggi occasionali. Per frontalieri italiani esiste il biglietto Ticino Ticket gratuito solo per turisti in albergo. Il datore di lavoro può rimborsare parzialmente l'abbonamento come indennità trasporto (esentasse se non supera il costo documentato).",
      en:
        "The GA (Generalabonnement) costs CHF 3,995 in 2nd class adult in 2025 (SBB, regional trains, boats, PostBus) [source: SBB 2025 fares]. For a Chiasso-Lugano commuter a single ticket is CHF 13.80, so the GA pays off beyond 289 trips/year (about 145 days). Cheaper alternatives: the Punto-a-Punto route pass (CHF 1,850/year Chiasso-Lugano) or the Step multi-route pass. The half-fare card (CHF 190/year) halves single tickets — good for occasional travel. The free Ticino Ticket is for hotel tourists only. The employer may partially reimburse the pass as a transport allowance (tax-free if documented).",
      de:
        "Das GA (Generalabonnement) kostet 2025 CHF 3'995 in der 2. Klasse Erwachsene (SBB, Regionalbahnen, Schiffe, Postauto) [Quelle: SBB Tarife 2025]. Pendler Chiasso-Lugano: Einzelticket CHF 13,80, GA rentiert ab 289 Fahrten/Jahr (ca. 145 Tagen). Günstigere Alternativen: Streckenabonnement (Punto-a-Punto, CHF 1'850/Jahr Chiasso-Lugano) oder Step. Halbtax-Abo (CHF 190/Jahr) halbiert Einzelbillette — gut für Gelegenheitsreisen. Das kostenlose Ticino Ticket ist nur für Hotelgäste. Der Arbeitgeber kann Teil erstatten (steuerfrei wenn belegt).",
      fr:
        "L'AG (abonnement général) coûte CHF 3 995 en 2e classe adulte en 2025 (CFF, trains régionaux, bateaux, CarPostal) [source : CFF tarifs 2025]. Pour un pendulaire Chiasso-Lugano, billet simple CHF 13,80, l'AG est rentable au-delà de 289 trajets/an (~145 jours). Alternatives : abonnement de parcours (Punto-a-Punto, CHF 1 850/an Chiasso-Lugano) ou Step multi-parcours. L'AG demi-tarif (CHF 190/an) divise par deux les billets simples. Le Ticino Ticket gratuit est réservé aux touristes hôtels. L'employeur peut rembourser en partie (hors taxe si justifié).",
    },
    sources: [
      'https://www.sbb.ch/it/abbonamenti-e-biglietti/abbonamenti-pendolari/ag.html',
    ],
  },
  {
    id: 'trasporti-carpooling-parcheggi',
    category: 'trasporti',
    question: {
      it: 'Esistono parcheggi scambiatori e carpooling per frontalieri?',
      en: 'Are there park-and-ride and carpooling options for cross-border workers?',
      de: 'Gibt es Park-&-Ride und Carpooling-Angebote für Grenzgänger?',
      fr: 'Y a-t-il des parkings relais et du covoiturage pour frontaliers ?',
    },
    answer: {
      it:
        "Sì. La Rete dei parcheggi scambiatori (park&rail/park&ride) del Canton Ticino offre 12 strutture principali a Mendrisio, Chiasso, Balerna, Bellinzona, Lugano [fonte: TI.ch, mobilità]. Abbonamento annuale CHF 480 a Mendrisio FFS, CHF 720 a Lugano Cornaredo. Per carpooling la piattaforma ufficiale è Hitchhiker.ch (gratuita) e BlaBlaCar usata da frontalieri su tratte Como-Lugano, Varese-Lugano. Il datore di lavoro può organizzare navette aziendali (es. CSCS Manno, AlpTransit Bodio) e beneficiare di incentivi fiscali cantonali per la «mobilità aziendale». Dal 2026 il Cantone Ticino ha introdotto la «Tessera Mobilità Frontalieri» che dà sconti del 30% sugli abbonamenti Arcobaleno se l'orario di lavoro è compatibile con la riduzione del traffico di confine (piano Mobilità 2030).",
      en:
        "Yes. The Ticino cantonal park-and-ride network offers 12 main hubs in Mendrisio, Chiasso, Balerna, Bellinzona and Lugano [source: TI.ch, mobility]. Annual subscription CHF 480 at Mendrisio SBB, CHF 720 at Lugano Cornaredo. Official carpooling platform: Hitchhiker.ch (free) and BlaBlaCar on Como-Lugano and Varese-Lugano. The employer may run shuttles (e.g. CSCS Manno, AlpTransit Bodio) and benefit from cantonal tax incentives for corporate mobility. From 2026 Ticino introduced the «Cross-border Mobility Card» giving 30% off Arcobaleno subscriptions when work schedule matches border-traffic reduction goals (Mobility 2030 plan).",
      de:
        "Ja. Das Tessiner P&R-Netz bietet 12 Hauptstandorte in Mendrisio, Chiasso, Balerna, Bellinzona und Lugano [Quelle: TI.ch Mobilität]. Jahresabo CHF 480 in Mendrisio SBB, CHF 720 in Lugano Cornaredo. Offizielle Fahrgemeinschaftsplattform: Hitchhiker.ch (gratis) und BlaBlaCar auf Como-Lugano und Varese-Lugano. Arbeitgeber können Pendelbusse einsetzen (CSCS Manno, AlpTransit Bodio) und kantonale Steueranreize nutzen. Ab 2026 «Grenzgänger-Mobilitätskarte» mit 30 % Rabatt auf Arcobaleno-Abos bei Grenzverkehrsentlastung (Plan Mobilität 2030).",
      fr:
        "Oui. Le réseau tessinois de parcs-relais offre 12 sites principaux à Mendrisio, Chiasso, Balerna, Bellinzone et Lugano [source : TI.ch mobilité]. Abonnement annuel CHF 480 à Mendrisio CFF, CHF 720 à Lugano Cornaredo. Plateforme officielle de covoiturage : Hitchhiker.ch (gratuit) et BlaBlaCar sur Como-Lugano et Varese-Lugano. L'employeur peut organiser des navettes (CSCS Manno, AlpTransit Bodio) et bénéficier d'incitations fiscales cantonales. Dès 2026 la « Carte mobilité frontalière » offre 30 % de rabais sur les abonnements Arcobaleno (plan Mobilité 2030).",
    },
    sources: [
      'https://www4.ti.ch/dt/dstm/mobilita/',
    ],
  },
  {
    id: 'trasporti-bollo-auto-italia',
    category: 'trasporti',
    question: {
      it: 'Devo pagare il bollo auto italiano se lavoro in Svizzera?',
      en: 'Do I pay Italian car tax if I work in Switzerland?',
      de: 'Muss ich die italienische Kfz-Steuer zahlen, wenn ich in der Schweiz arbeite?',
      fr: 'Dois-je payer la taxe auto italienne si je travaille en Suisse ?',
    },
    answer: {
      it:
        "Sì. Il frontaliere residente in Italia con auto immatricolata in Italia paga normalmente il bollo alla Regione di residenza, perché l'imposta segue la residenza anagrafica (art. 5 dlgs 504/1992) [fonte: Normattiva, dlgs 504/1992]. Nessuna esenzione frontaliera. Se l'auto è intestata a una società svizzera (auto aziendale) e il frontaliere la usa come fringe benefit, il bollo è pagato in Svizzera dal datore di lavoro e l'uso privato va tassato come prestazione in natura nel Lohnausweis (0,9% del valore mensile). L'auto aziendale con targa CH può circolare liberamente in Italia solo per spostamenti professionali; uso privato prolungato rischia contestazione per violazione art. 132 CdS italiano. Se l'azienda fornisce un'auto anche per i week-end, conviene richiedere l'immatricolazione provvisoria italiana.",
      en:
        "Yes. An Italian resident with an Italian-registered car pays the tax to their region of residence, as the tax follows registration (dlgs 504/1992 art. 5) [source: Normattiva, dlgs 504/1992]. No cross-border exemption. If the car belongs to a Swiss company (company car) used as fringe benefit, tax is paid in Switzerland by the employer and private use is taxed in-kind on the Lohnausweis (0.9% of value monthly). CH-plated company cars may circulate freely in Italy only for business; extended private use risks an art. 132 Italian Road Code infringement. For weekend private use, request provisional Italian registration.",
      de:
        "Ja. Der in Italien wohnhafte Grenzgänger mit italienisch immatrikuliertem Auto zahlt die Kfz-Steuer an seine Wohnregion (GD 504/1992 Art. 5) [Quelle: Normattiva, GD 504/1992]. Keine Grenzgängerbefreiung. Ist das Fahrzeug einer Schweizer Firma zugeteilt und wird als Fringe Benefit genutzt, zahlt der Arbeitgeber die Steuer in der Schweiz; private Nutzung wird als Sachleistung (0,9 %/Monat) im Lohnausweis besteuert. CH-Firmenwagen dürfen in Italien nur dienstlich fahren; längerer Privatgebrauch riskiert Verstoss gegen Art. 132 ital. StVG. Für Wochenendgebrauch provisorische italienische Immatrikulation empfohlen.",
      fr:
        "Oui. Le frontalier résident en Italie avec voiture immatriculée en Italie paie la taxe à sa région de résidence (décret 504/1992 art. 5) [source : Normattiva, décret 504/1992]. Aucune exonération frontalière. Si la voiture appartient à une société suisse (voiture de fonction) utilisée comme avantage, l'employeur paie la taxe suisse ; usage privé imposé en nature au Lohnausweis (0,9 % du prix/mois). Voiture de société CH circule librement en Italie pour usage professionnel ; usage privé prolongé viole l'art. 132 CdS italien. Pour un usage privé le week-end, demander une immatriculation italienne provisoire.",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:1992-12-30;504',
    ],
  },
  {
    id: 'trasporti-assicurazione-auto-frontaliere',
    category: 'trasporti',
    question: {
      it: 'Conviene assicurare l\'auto in Italia o in Svizzera?',
      en: 'Is it cheaper to insure the car in Italy or in Switzerland?',
      de: 'Lohnt sich die Autoversicherung in Italien oder in der Schweiz?',
      fr: 'Est-il plus avantageux d\'assurer la voiture en Italie ou en Suisse ?',
    },
    answer: {
      it:
        "L'auto segue l'immatricolazione: se la targa è italiana, l'assicurazione deve essere italiana (art. 122 Codice Assicurazioni, dlgs 209/2005) [fonte: Normattiva, dlgs 209/2005]. Il frontaliere non può stipulare una polizza svizzera su auto con targa italiana e viceversa. In Italia, le assicurazioni per frontalieri sono talvolta più care (15-30%) a causa della circolazione in Svizzera: conviene dichiarare l'uso frontaliero per evitare annullamento in caso di sinistro. Per le auto aziendali con targa CH l'assicurazione è svizzera (LCA 957.1). La copertura minima obbligatoria italiana è la RC ad CHF/EUR 7,5 mln, mentre in Svizzera è CHF 5 mln. La Carta Verde (IVASS) è valida per viaggi puntuali in Svizzera (fino a 90 giorni). Attenzione al furto: le auto italiane in Svizzera subiscono franchigie più alte.",
      en:
        "Insurance follows registration: with Italian plates you need Italian insurance (Insurance Code, dlgs 209/2005 art. 122) [source: Normattiva, dlgs 209/2005]. A cross-border worker cannot buy Swiss insurance on Italian-plated cars or vice versa. In Italy, cross-border policies can be 15-30% more expensive due to Swiss circulation: disclose cross-border use to avoid cancellation on claim. Company cars with Swiss plates carry Swiss insurance (LCA 957.1). Minimum mandatory liability is EUR 7.5M in Italy vs CHF 5M in Switzerland. The Green Card (IVASS) is valid for occasional trips (up to 90 days). Note: theft excess is higher for Italian cars in Switzerland.",
      de:
        "Die Versicherung folgt dem Kennzeichen: italienische Platte = italienische Versicherung (ital. Versicherungskodex, GD 209/2005 Art. 122) [Quelle: Normattiva, GD 209/2005]. Kein Grenzgänger kann eine Schweizer Versicherung auf ein italienisches Auto abschliessen und umgekehrt. In Italien sind Grenzgänger-Policen 15-30 % teurer wegen Schweiz-Fahrten: Grenzgebrauch angeben, sonst Vertragsaufhebung bei Schaden. Firmenwagen mit CH-Kennzeichen: Schweizer Versicherung (VVG 957.1). Mindestdeckung: 7,5 Mio. EUR in Italien, 5 Mio. CHF in der Schweiz. Grüne Karte (IVASS) gilt punktuell (bis 90 Tage). Diebstahl-Selbstbehalt höher für IT-Autos in CH.",
      fr:
        "L'assurance suit l'immatriculation : plaque italienne = assurance italienne (Code des assurances, décret 209/2005 art. 122) [source : Normattiva, décret 209/2005]. Aucun frontalier ne peut souscrire d'assurance suisse sur une voiture italienne et vice versa. En Italie, les polices frontaliers sont 15-30 % plus chères : déclarer l'usage frontalier pour éviter la nullité. Voitures de société à plaque CH : assurance suisse (LCA 957.1). Couverture min. : 7,5 M EUR Italie, 5 M CHF Suisse. Carte Verte (IVASS) valable 90 jours. Franchise vol plus élevée pour voitures IT en Suisse.",
    },
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2005-09-07;209',
    ],
  },
  {
    id: 'trasporti-arcobaleno-abbonamento-ticino',
    category: 'trasporti',
    question: {
      it: 'Che cos\'è l\'abbonamento Arcobaleno e dove vale?',
      en: 'What is the Arcobaleno pass and where is it valid?',
      de: 'Was ist das Arcobaleno-Abonnement und wo gilt es?',
      fr: 'Qu\'est-ce que l\'abonnement Arcobaleno et où est-il valable ?',
    },
    answer: {
      it:
        "Arcobaleno è la comunità tariffale integrata del Cantone Ticino e Moesano (Grigioni italiano) [fonte: arcobaleno.ch, comunicato tariffe 2025]. Permette di viaggiare su treni, bus, funicolari e battelli con un unico biglietto suddiviso in zone. Nel 2025 l'abbonamento annuale costa CHF 800 per 1 zona (es. Lugano città), CHF 1.370 per 2 zone, CHF 2.545 per la rete intera (Tutto Ticino). Per i frontalieri che arrivano in treno a Chiasso/Mendrisio e proseguono in zona Arcobaleno, l'abbonamento copre la tratta svizzera. Per giovani sotto i 26 anni esiste Binario 7 (CHF 490/anno tutta la rete). Il datore di lavoro può contribuire come indennità trasporto esentasse se giustificato. Arcobaleno è compatibile con AG e metà-prezzo FFS.",
      en:
        "Arcobaleno is the integrated tariff community of Canton Ticino and Moesano (Italian Grigioni) [source: arcobaleno.ch, 2025 tariffs]. It allows one ticket across trains, buses, funiculars and boats divided into zones. In 2025 the annual pass is CHF 800 for 1 zone (e.g. Lugano city), CHF 1,370 for 2 zones, CHF 2,545 for the full network (All Ticino). Cross-border workers arriving by train at Chiasso/Mendrisio and continuing in Arcobaleno can use it on the Swiss leg. Young people under 26 get Binario 7 (CHF 490/year entire network). The employer can reimburse as tax-free transport allowance if justified. Compatible with SBB GA and half-fare.",
      de:
        "Arcobaleno ist der integrierte Tarifverbund Tessin und Moesano (italienischsprachiges Graubünden) [Quelle: arcobaleno.ch Tarife 2025]. Ein Ticket für Bahn, Bus, Seilbahnen und Schiffe nach Zonen. 2025: Jahresabo CHF 800 für 1 Zone (z. B. Lugano Stadt), CHF 1'370 für 2 Zonen, CHF 2'545 Gesamtnetz (Tutto Ticino). Für Grenzgänger mit Zug bis Chiasso/Mendrisio und Weiterfahrt in der Zone Arcobaleno deckt das Abo die Schweizer Strecke. Jugendliche unter 26: Binario 7 (CHF 490/Jahr Gesamtnetz). Arbeitgeberbeitrag steuerfrei wenn belegt. Mit GA und Halbtax kombinierbar.",
      fr:
        "Arcobaleno est la communauté tarifaire intégrée du Tessin et du Moesano (Grisons italophones) [source : arcobaleno.ch tarifs 2025]. Un seul billet pour trains, bus, funiculaires et bateaux par zones. En 2025 abonnement annuel CHF 800 pour 1 zone (Lugano ville), CHF 1 370 pour 2 zones, CHF 2 545 pour tout le réseau. Pour les frontaliers arrivant en train à Chiasso/Mendrisio puis zone Arcobaleno, l'abo couvre la partie suisse. Jeunes <26 ans : Binario 7 (CHF 490/an, tout le réseau). Contribution employeur exonérée si justifiée. Compatible AG et demi-tarif CFF.",
    },
    sources: [
      'https://www.arcobaleno.ch/',
    ],
  },
  {
    id: 'trasporti-dogana-acquisto-auto-ch',
    category: 'trasporti',
    question: {
      it: 'Se compro un\'auto in Svizzera posso portarla in Italia?',
      en: 'If I buy a car in Switzerland can I bring it to Italy?',
      de: 'Wenn ich ein Auto in der Schweiz kaufe, kann ich es nach Italien bringen?',
      fr: 'Si j\'achète une voiture en Suisse, puis-je la ramener en Italie ?',
    },
    answer: {
      it:
        "Sì, ma con dogana. L'auto acquistata in Svizzera e trasferita in Italia è un'importazione soggetta a IVA italiana 22%, eventuale dazio 10% (Reg. UE 952/2013) e immatricolazione [fonte: Agenzia Dogane, sezione auto esteri]. Un'auto nuova (<6 mesi o <6.000 km) paga sempre IVA italiana anche se l'IVA svizzera è stata pagata. Un'auto usata UE-origine può essere esente da IVA dimostrando l'IVA già pagata. Occorre poi targa italiana (PRA), certificato di conformità (CoC), revisione, tassa di immatricolazione (IPT, regione-specifica, CHF equivalente ~EUR 150-800 a seconda della potenza). Il frontaliere può far entrare l'auto come «importazione di beni personali» con esenzione IVA se trasferisce la residenza (permesso C in Svizzera → AIRE + trasferimento in Italia).",
      en:
        "Yes, with customs. A car bought in Switzerland and moved to Italy is an import subject to 22% Italian VAT, possible 10% duty (EU Reg. 952/2013) and new registration [source: Agenzia Dogane, foreign cars section]. A new car (<6 months or <6,000 km) always pays Italian VAT even if Swiss VAT was paid. A used EU-origin car may be VAT-exempt if VAT was already paid. Italian plates (PRA), Certificate of Conformity (CoC), test, and registration tax (IPT, region-specific, ~EUR 150-800 by power) follow. A cross-border worker may bring the car as «personal-goods import» VAT-exempt on actual residence transfer (Swiss C permit → AIRE + move to Italy).",
      de:
        "Ja, mit Zoll. Ein in der Schweiz gekauftes Auto, nach Italien überführt: Einfuhr mit 22 % ital. MwSt, evtl. 10 % Zoll (EU-VO 952/2013) und Neuimmatrikulation [Quelle: Agenzia Dogane, Ausländische Fahrzeuge]. Neuwagen (<6 Mt. oder <6'000 km) zahlen in jedem Fall italienische MwSt. EU-Gebrauchtwagen MwSt-frei, sofern Belege. Italienisches Kennzeichen (PRA), Conformity-Zertifikat (CoC), TÜV, IPT-Steuer (regional, ~150-800 EUR). Grenzgänger kann als Umzugsgut mwstbefreit einführen bei echtem Wohnsitzwechsel (C-Bewilligung → AIRE + Umzug Italien).",
      fr:
        "Oui, avec douane. Voiture achetée en Suisse et ramenée en Italie : importation avec TVA italienne 22 %, éventuel droit 10 % (règl. UE 952/2013) et nouvelle immatriculation [source : Agenzia Dogane, véhicules étrangers]. Voiture neuve (<6 mois ou <6 000 km) : TVA italienne due même si TVA suisse payée. Voiture d'occasion UE : exonération TVA si TVA déjà payée. Plaque italienne (PRA), CoC, contrôle technique, taxe IPT (régionale, ~150-800 EUR). Le frontalier peut importer comme bien personnel, exonéré, s'il transfère la résidence (permis C → AIRE + déménagement).",
    },
    sources: [
      'https://www.adm.gov.it/portale/cittadini/automobili-e-veicoli',
    ],
  },
  {
    id: 'trasporti-valichi-attese-tempi',
    category: 'trasporti',
    question: {
      it: 'Quanto tempo si perde ai valichi di confine nel pendolarismo frontaliere?',
      en: 'How much time do you lose at border crossings in cross-border commuting?',
      de: 'Wie viel Zeit verliert man an den Grenzübergängen im Grenzgängerverkehr?',
      fr: 'Combien de temps perd-on aux passages frontaliers en tant que frontalier ?',
    },
    answer: {
      it:
        "I tempi medi di attesa ai valichi Ticino-Italia variano per orario e valico. Il Canton Ticino pubblica misurazioni in tempo reale su ti.ch/mobilita [fonte: TI.ch, mobilità]. I valichi principali: Chiasso Brogeda autostrada (>30.000 passaggi/giorno), Chiasso Strada, Ponte Tresa, Stabio (autostradale da 2021), Gaggiolo. Al mattino 06:00-08:00 le code medie sono 5-20 minuti a Brogeda verso CH, fino a 40 minuti in giorni di picco (lunedì e venerdì). Alla sera 17:00-19:00 code 10-30 minuti verso IT. Dal 2026 il Canton Ticino ha introdotto corsie riservate ai frontalieri (car-sharing con 3+ occupanti) a Stabio e Mendrisio, riducendo i tempi medi del 25%. Si raccomanda di evitare Brogeda in favore di valichi secondari.",
      en:
        "Average waiting times at Ticino-Italy crossings vary by time and location. Canton Ticino publishes real-time data on ti.ch/mobilita [source: TI.ch, mobility]. Main crossings: Chiasso Brogeda motorway (>30,000 passages/day), Chiasso street, Ponte Tresa, Stabio (motorway from 2021), Gaggiolo. In morning 06:00-08:00 average queues 5-20 min at Brogeda to CH, up to 40 min on peak days (Monday, Friday). Evening 17:00-19:00 10-30 min toward IT. From 2026 Canton Ticino has introduced dedicated lanes for carpool (3+ occupants) at Stabio and Mendrisio, cutting times by 25%. Avoid Brogeda when possible.",
      de:
        "Wartezeiten an den Tessin-Italien-Grenzen variieren nach Zeit und Ort. Kanton Tessin veröffentlicht Echtzeit-Daten auf ti.ch/mobilita [Quelle: TI.ch Mobilität]. Hauptübergänge: Chiasso Brogeda Autobahn (>30'000 Durchfahrten/Tag), Chiasso Strasse, Ponte Tresa, Stabio (seit 2021 Autobahn), Gaggiolo. Morgens 06-08 Uhr 5-20 Min. Warteschlangen Richtung CH, bis 40 Min. an Spitzentagen (Mo/Fr). Abends 17-19 Uhr 10-30 Min. Richtung IT. Ab 2026 Sonderspuren für Fahrgemeinschaften (3+ Personen) in Stabio und Mendrisio, Zeit -25 %. Brogeda vermeiden.",
      fr:
        "Les temps d'attente aux passages Tessin-Italie varient selon l'heure et le lieu. Le canton publie des données en temps réel sur ti.ch/mobilita [source : TI.ch mobilité]. Passages principaux : Chiasso Brogeda autoroute (>30 000 passages/jour), Chiasso rue, Ponte Tresa, Stabio (autoroute dès 2021), Gaggiolo. Matin 06-08 h : files 5-20 min à Brogeda vers CH, jusqu'à 40 min aux pics (lundi/vendredi). Soir 17-19 h : 10-30 min vers IT. Dès 2026 le canton a introduit des voies réservées au covoiturage (3+ occupants) à Stabio et Mendrisio, temps -25 %. Éviter Brogeda.",
    },
    relatedLinks: [
      {
        href: '/guida-frontaliere/traffico-valichi/',
        label: {
          it: 'Tempi di attesa ai valichi',
          en: 'Border crossing times',
          de: 'Wartezeiten an der Grenze',
          fr: 'Temps d\'attente aux passages',
        },
      },
    ],
    sources: [
      'https://www4.ti.ch/dt/dstm/',
    ],
  },
  {
    id: 'trasporti-costi-deduzione-fiscale',
    category: 'trasporti',
    question: {
      it: 'Posso dedurre fiscalmente i costi di trasporto casa-lavoro?',
      en: 'Can I deduct commuting costs from tax?',
      de: 'Kann ich Fahrtkosten zwischen Wohnort und Arbeit steuerlich absetzen?',
      fr: 'Puis-je déduire les frais de transport domicile-travail ?',
    },
    answer: {
      it:
        "In Svizzera la deduzione è limitata: l'art. 26 LIFD consente di dedurre le spese di trasporto necessarie fino a un massimo di CHF 3.200/anno per la federale (art. 26 cpv. 1 lett. a LIFD) [fonte: Fedlex LIFD]. In Ticino il massimo cantonale è CHF 10.000 (tariffa km CHF 0,70 o abbonamento effettivo). Per il frontaliere è applicata automaticamente come deduzione forfetaria solo se si richiede la procedura NOV; la tassazione alla fonte standard non include la deduzione. In Italia le spese di trasporto casa-lavoro non sono ordinariamente deducibili per dipendenti (art. 51 TUIR le include nel salario); eccezione per la quota deducibile pari alla «deduzione forfetaria sanitaria» CHF 3.000 del frontaliere (Legge 83/2023 art. 5). Conservare ricevute abbonamento e km (diario chilometrico).",
      en:
        "In Switzerland the deduction is capped: LIFD art. 26 allows necessary transport expenses up to CHF 3,200/year for federal tax (art. 26 para. 1 lit. a LIFD) [source: Fedlex LIFD]. Ticino cantonal maximum CHF 10,000 (CHF 0.70/km or actual pass). Cross-border workers get it only if requesting NOV procedure; standard withholding excludes it. In Italy commuting costs are not ordinarily deductible for employees (TUIR art. 51 includes them in salary); exception: the new cross-border worker's €3,000 flat healthcare deduction (Law 83/2023 art. 5). Keep pass receipts and mileage log.",
      de:
        "In der Schweiz Abzug begrenzt: DBG Art. 26 Abs. 1 Bst. a erlaubt notwendige Fahrtkosten bis CHF 3'200/Jahr für die direkte Bundessteuer [Quelle: Fedlex DBG]. Tessin kantonal max. CHF 10'000 (CHF 0,70/km oder effektives Abo). Für Grenzgänger automatisch nur bei NOV-Antrag; Quellensteuer schliesst den Abzug nicht ein. In Italien sind Fahrtkosten nicht abziehbar (TUIR Art. 51); Ausnahme: Gesundheitspauschale 3'000 € des neuen Grenzgängers (Gesetz 83/2023 Art. 5). Belege aufbewahren.",
      fr:
        "En Suisse la déduction est plafonnée : LIFD art. 26 al. 1 let. a admet les frais de transport nécessaires jusqu'à CHF 3 200/an pour l'IFD [source : Fedlex LIFD]. Maximum cantonal tessinois CHF 10 000 (CHF 0,70/km ou abo effectif). Pour le frontalier : seulement via la TOU ; l'impôt à la source standard ne l'inclut pas. En Italie les frais domicile-travail ne sont pas déductibles (TUIR art. 51) ; exception : déduction santé forfaitaire 3 000 € du nouveau frontalier (Loi 83/2023 art. 5). Conserver justificatifs d'abonnement et km.",
    },
    sources: [
      'https://www.fedlex.admin.ch/eli/cc/1991/1184_1184_1184/it',
    ],
  },
];
