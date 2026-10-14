import { createContentKeywordMatcher } from './contentKeywordMatcher.mjs';

// Explicit intent, rather than isolated words such as “offerte”, “franchigia”,
// “change” or “bank”. Semicolons separate aliases, never user-facing labels.
const phrases = [
  ['calculator', 'calcolatore stipendio;calcolatore fiscale;stipendio netto;stipendio lordo;imposta alla fonte;tassazione frontalieri', 'salary calculator;net salary;gross salary;withholding tax;cross border taxation', 'Lohnrechner;Nettolohn;Bruttolohn;Quellensteuer;Grenzgänger Besteuerung', 'calculateur salaire;salaire net;salaire brut;impôt à la source;fiscalité frontaliers'],
  ['exchange', 'cambio franco euro;cambio CHF EUR;tasso di cambio;conversione valuta', 'exchange rate;CHF EUR;currency conversion;Swiss franc euro', 'Wechselkurs;CHF EUR;Franken Euro;Währungsumrechnung', 'taux de change;CHF EUR;franc euro;conversion devises'],
  ['health', 'cassa malati;casse malati;assicurazione sanitaria;assicurazione malattia;LAMal;CMI', 'health insurance;LAMal;KVG', 'Krankenversicherung;Krankenkasse;KVG;LAMal', 'assurance maladie;caisse maladie;LAMal;CMU'],
  ['cost-of-living', 'costo della vita;caro vita;spese mensili', 'cost of living;monthly expenses', 'Lebenshaltungskosten;monatliche Ausgaben', 'coût de la vie;dépenses mensuelles'],
  ['pension', 'pensione;previdenza professionale;AVS;LPP;secondo pilastro', 'pension;retirement;AHV;AVS;LPP;second pillar', 'Rente;Altersvorsorge;AHV;BVG;zweite Säule', 'retraite;prévoyance professionnelle;AVS;LPP;deuxième pilier'],
  ['pillar3', 'terzo pilastro;pilastro 3a', 'third pillar;pillar 3a', 'dritte Säule;Säule 3a', 'troisième pilier;pilier 3a'],
  ['payslip', 'busta paga;cedolino', 'payslip;pay slip', 'Lohnabrechnung;Gehaltsabrechnung', 'fiche de paie;bulletin de salaire'],
  ['tax-return', 'dichiarazione dei redditi;credito imposta;modello 730;doppia imposizione', 'tax return;tax credit;double taxation', 'Steuererklärung;Steuergutschrift;Doppelbesteuerung', 'déclaration fiscale;crédit impôt;double imposition'],
  ['residency', 'cambio residenza;trasferire residenza', 'change residence;relocate to Switzerland', 'Wohnsitzwechsel;Umzug in die Schweiz', 'changement résidence;déménager en Suisse'],
  ['ristorni', 'ristorni fiscali', 'tax rebates;tax transfers', 'Steuerrückvergütung', 'rétrocessions fiscales'],
  ['unemployment', 'disoccupazione;NASPI;indennità disoccupazione', 'unemployment;unemployment benefit', 'Arbeitslosigkeit;Arbeitslosengeld', 'chômage;indemnité chômage'],
  ['job-board', 'offerte di lavoro;annunci di lavoro;cercare lavoro;trovare lavoro;lavorare in Svizzera;lavoro in Ticino', 'job vacancies;job offers;job search;find a job;work in Switzerland;jobs in Ticino', 'Stellenangebote;Jobsuche;Arbeit suchen;Arbeit in der Schweiz;Jobs im Tessin', 'offres emploi;offres de travail;chercher emploi;trouver emploi;travailler en Suisse;emploi au Tessin'],
  ['jobs-observatory', 'mercato del lavoro;tasso occupazione', 'job market;labour market;labor market;employment rate', 'Arbeitsmarkt;Beschäftigungsquote', 'marché du travail;taux emploi'],
  ['jobs', 'confronta offerte di lavoro;confronto stipendi', 'compare job offers;compare salaries', 'Jobangebote vergleichen;Löhne vergleichen', 'comparer offres emploi;comparer salaires'],
  ['companies', 'aziende che assumono;datori di lavoro', 'companies hiring;hiring employers', 'Firmen stellen ein;Arbeitgeber', 'entreprises recrutent;employeurs'],
  ['banks', 'conto bancario;conto corrente;confronta banche', 'bank account;compare banks', 'Bankkonto;Girokonto;Banken vergleichen', 'compte bancaire;comparer banques'],
  ['first-day', 'primo giorno di lavoro', 'first day at work', 'erster Arbeitstag', 'premier jour travail'],
  ['permits', 'permesso G;permesso B;permesso C;permesso di lavoro', 'G permit;B permit;C permit;work permit', 'G Bewilligung;B Bewilligung;C Bewilligung;Arbeitsbewilligung', 'permis G;permis B;permis C;permis travail'],
  ['border', 'traffico dogane;attese ai valichi;tempi di attesa;code ai valichi;valico di confine', 'border waiting times;border crossing;customs crossing', 'Wartezeit Grenze;Grenzübergang;Grenzwartezeiten', 'attente frontière;poste frontière;passage frontière'],
  ['calendar', 'scadenze fiscali;calendario fiscale', 'tax deadlines;tax calendar', 'Steuerfristen;Steuerkalender', 'échéances fiscales;calendrier fiscal'],
  ['whatif', 'cosa cambia se;what if', 'what if', 'was wäre wenn', 'que se passe si'],
  ['shopping', 'spesa transfrontaliera;prezzi spesa', 'cross border shopping;grocery prices', 'Einkaufstourismus;Lebensmittelpreise', 'achats transfrontaliers;prix courses'],
  ['transport', 'trasporti frontalieri;costo trasporti;abbonamento treno', 'commuter transport;transport costs;train pass', 'Pendlerverkehr;Transportkosten;Zugabonnement', 'transport frontaliers;coût transports;abonnement train'],
  ['salary-compare', 'stipendio medio;salario medio', 'average salary;salary statistics', 'Durchschnittslohn;Lohnstatistik', 'salaire moyen;statistiques salaires'],
  ['traffic-history', 'storico traffico;storico code', 'traffic history;historical queues', 'Verkehrsverlauf;Stauhistorie', 'historique trafic;historique files'],
  ['parental-leave', 'congedo parentale;congedo maternità;congedo paternità', 'parental leave;maternity leave;paternity leave', 'Elternurlaub;Mutterschaftsurlaub;Vaterschaftsurlaub', 'congé parental;congé maternité;congé paternité'],
  ['border-map', 'mappa valichi;mappa confine', 'border map;crossings map', 'Grenzkarte;Karte Grenzübergänge', 'carte frontière;carte passages'],
  ['municipalities', 'comuni di frontiera', 'border municipalities', 'Grenzgemeinden', 'communes frontalières'],
  ['car-transfer', 'immatricolare auto;importare auto', 'register car;import car', 'Auto anmelden;Auto importieren', 'immatriculer voiture;importer voiture'],
  ['car-cost', 'costo auto;costo pendolarismo', 'car costs;commuting costs', 'Autokosten;Pendelkosten', 'coût voiture;coût trajet'],
  ['permit-compare', 'permesso G vs B', 'G vs B permit', 'G oder B Bewilligung', 'permis G ou B'],
  ['renovation', 'ristrutturazione casa', 'home renovation', 'Hausrenovierung', 'rénovation maison'],
  ['mobile', 'telefonia mobile;roaming svizzera', 'mobile plans;Swiss roaming', 'Mobilfunktarife;Roaming Schweiz', 'forfaits mobiles;roaming suisse'],
  ['ral', 'confronta RAL;RAL netta', 'compare annual salary', 'Jahreslohn vergleichen', 'comparer salaire annuel'],
  ['nursery', 'asilo nido', 'childcare;nursery', 'Kinderbetreuung;Kinderkrippe', 'garde enfants;crèche'],
  ['living-ch', 'vivere in Svizzera', 'living in Switzerland', 'Leben in der Schweiz', 'vivre en Suisse'],
  ['living-it', 'vivere in Italia', 'living in Italy', 'Leben in Italien', 'vivre en Italie'],
  ['livability', 'qualità della vita', 'quality of life', 'Lebensqualität', 'qualité de vie'],
];

export const CONTENT_LINK_ENTRIES = phrases.map(([id, it, en, de, fr]) => ({
  id, aliases: Object.fromEntries(Object.entries({ it, en, de, fr }).map(([locale, text]) => [locale, text.split(';')])),
}));

const combinations = {
  'fuel-petrol': { it: [[['prezzo', 'prezzi', 'costo'], ['benzina']]], en: [[['price', 'prices', 'cost'], ['petrol', 'gasoline']]], de: [[['Preis', 'Preise'], ['Benzin']]], fr: [[['prix', 'coût'], ['essence']]] },
  'fuel-diesel': { it: [[['prezzo', 'prezzi', 'costo'], ['diesel', 'gasolio']]], en: [[['price', 'prices', 'cost'], ['diesel']]], de: [[['Preis', 'Preise'], ['Diesel']]], fr: [[['prix', 'coût'], ['diesel', 'gasoil', 'gazole']]] },
  border: { it: [[['code', 'attese', 'traffico'], ['valico', 'valichi', 'dogana', 'dogane', 'confine']]], en: [[['waiting', 'queue', 'traffic'], ['border', 'customs']]], de: [[['Stau', 'Wartezeit', 'Verkehr'], ['Grenze', 'Zoll']]], fr: [[['attente', 'bouchons', 'trafic'], ['frontière', 'douane']]] },
  exchange: { it: [[['cambio', 'conversione'], ['franco', 'franchi', 'CHF'], ['euro', 'EUR']]], en: [[['exchange', 'convert'], ['franc', 'CHF'], ['euro', 'EUR']]], de: [[['Wechselkurs', 'Umrechnung'], ['Franken', 'CHF'], ['Euro', 'EUR']]], fr: [[['change', 'conversion'], ['franc', 'CHF'], ['euro', 'EUR']]] },
  calculator: { it: [[['calcolatore', 'calcolo'], ['stipendio', 'salario']]], en: [[['calculator', 'calculate'], ['salary', 'pay']]], de: [[['Rechner', 'berechnen'], ['Lohn', 'Gehalt']]], fr: [[['calculateur', 'calcul'], ['salaire', 'revenu']]] },
  'job-board': { it: [[['offerte', 'annunci', 'posti'], ['lavoro', 'impiego']]], en: [[['jobs', 'job'], ['offers', 'vacancies', 'search']]], de: [[['Arbeit', 'Jobs', 'Stellen'], ['suchen', 'Angebote']]], fr: [[['offres', 'chercher', 'recherche'], ['emploi', 'travail']]] },
};
CONTENT_LINK_ENTRIES.push(
  { id: 'fuel-petrol', aliases: { it: ['prezzi benzina'], en: ['petrol prices', 'gasoline prices'], de: ['Benzinpreis', 'Benzinpreise'], fr: ['prix essence'] } },
  { id: 'fuel-diesel', aliases: { it: ['prezzi diesel', 'prezzi gasolio'], en: ['diesel prices'], de: ['Dieselpreis', 'Dieselpreise'], fr: ['prix gasoil', 'prix diesel'] } },
);
for (const entry of CONTENT_LINK_ENTRIES) entry.combinations = combinations[entry.id] || {};
export const matchContentLinks = createContentKeywordMatcher(CONTENT_LINK_ENTRIES);
