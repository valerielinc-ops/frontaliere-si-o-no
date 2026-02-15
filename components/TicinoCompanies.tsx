import React, { useState, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Building2, Users, Search, SlidersHorizontal, ArrowUpDown, MapPin, ExternalLink, Filter, ChevronDown, Globe, Briefcase, Map, List } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';

interface Company {
  name: string;
  sector: string;
  employees: number;
  city: string;
  coordinates: [number, number];
  website?: string;
  description: string;
  logo?: string;
}

const SECTORS = [
  'Tutti',
  'Finanza & Banking',
  'Tecnologia & IT',
  'Farmaceutico & Chimico',
  'Lusso & Moda',
  'Alimentare',
  'Assicurazioni',
  'Consulenza',
  'Logistica',
  'Energia',
  'Altro',
] as const;

const companies: Company[] = [
  // Finanza & Banking
  { name: 'UBS', sector: 'Finanza & Banking', employees: 2500, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://www.ubs.com', description: 'Banca globale, sede regionale Ticino' },
  { name: 'Banca dello Stato del Canton Ticino', sector: 'Finanza & Banking', employees: 850, city: 'Bellinzona', coordinates: [46.1946, 9.0236], website: 'https://www.bancastato.ch', description: 'Banca cantonale ticinese' },
  { name: 'BSI (ora EFG)', sector: 'Finanza & Banking', employees: 600, city: 'Lugano', coordinates: [46.0050, 8.9480], website: 'https://www.efginternational.com', description: 'Private banking e gestione patrimoniale' },
  { name: 'Cornèr Banca', sector: 'Finanza & Banking', employees: 500, city: 'Lugano', coordinates: [46.0020, 8.9530], website: 'https://www.corner.ch', description: 'Banca privata, carte di credito, trading' },
  { name: 'Banca Raiffeisen', sector: 'Finanza & Banking', employees: 400, city: 'Lugano', coordinates: [46.0055, 8.9550], description: 'Banca cooperativa, rete capillare' },
  { name: 'Julius Baer', sector: 'Finanza & Banking', employees: 300, city: 'Lugano', coordinates: [46.0042, 8.9525], website: 'https://www.juliusbaer.com', description: 'Wealth management, private banking internazionale' },
  { name: 'Credit Suisse (ora UBS)', sector: 'Finanza & Banking', employees: 450, city: 'Lugano', coordinates: [46.0035, 8.9505], website: 'https://www.ubs.com', description: 'Ex sede CS, ora integrata in UBS' },
  { name: 'PostFinance', sector: 'Finanza & Banking', employees: 200, city: 'Bellinzona', coordinates: [46.1950, 9.0220], website: 'https://www.postfinance.ch', description: 'Servizi finanziari postali, pagamenti' },
  { name: 'Banca Migros', sector: 'Finanza & Banking', employees: 150, city: 'Lugano', coordinates: [46.0048, 8.9540], website: 'https://www.bancamigros.ch', description: 'Banca retail cooperativa, ipoteche' },
  { name: 'BancaStato Advisory', sector: 'Finanza & Banking', employees: 120, city: 'Lugano', coordinates: [46.0025, 8.9515], description: 'Consulenza finanziaria e gestione portafogli' },
  { name: 'Piguet Galland', sector: 'Finanza & Banking', employees: 80, city: 'Lugano', coordinates: [46.0032, 8.9495], website: 'https://www.pfrpartners.ch', description: 'Private banking, gestione patrimoniale' },

  // Tecnologia & IT
  { name: 'Swiss IT Security', sector: 'Tecnologia & IT', employees: 200, city: 'Manno', coordinates: [46.0340, 8.9210], description: 'Cybersecurity e servizi IT' },
  { name: 'Doodle (parte)', sector: 'Tecnologia & IT', employees: 80, city: 'Lugano', coordinates: [46.0045, 8.9520], website: 'https://doodle.com', description: 'Pianificazione meeting e scheduling' },
  { name: 'Novalung / USI Hub', sector: 'Tecnologia & IT', employees: 150, city: 'Lugano', coordinates: [46.0100, 8.9600], description: 'Startup e innovazione tech USI campus' },
  { name: 'TIO SA', sector: 'Tecnologia & IT', employees: 120, city: 'Muzzano', coordinates: [45.9920, 8.9220], website: 'https://www.tio.ch', description: 'Media digitale, notizie online' },
  { name: 'SUPSI / DTI', sector: 'Tecnologia & IT', employees: 400, city: 'Manno', coordinates: [46.0350, 8.9200], website: 'https://www.supsi.ch', description: 'Scuola universitaria, dipartimento tecnologie innovative' },
  { name: 'Ated ICT Ticino', sector: 'Tecnologia & IT', employees: 50, city: 'Lugano', coordinates: [46.0065, 8.9510], website: 'https://www.ated.ch', description: 'Associazione ticinese evoluzione digitale' },
  { name: 'ti&m', sector: 'Tecnologia & IT', employees: 100, city: 'Lugano', coordinates: [46.0070, 8.9540], website: 'https://www.ti8m.ch', description: 'Software engineering, sviluppo web & mobile' },
  { name: 'InvestGlass', sector: 'Tecnologia & IT', employees: 40, city: 'Lugano', coordinates: [46.0028, 8.9490], website: 'https://www.investglass.com', description: 'CRM fintech per wealth management' },
  { name: 'Quantumvis', sector: 'Tecnologia & IT', employees: 30, city: 'Manno', coordinates: [46.0330, 8.9230], description: 'Soluzioni AI e machine learning per industria' },

  // Farmaceutico & Chimico
  { name: 'Helsinn', sector: 'Farmaceutico & Chimico', employees: 700, city: 'Lugano', coordinates: [46.0180, 8.9480], website: 'https://www.helsinn.com', description: 'Farmaceutica, oncologia e cure palliative' },
  { name: 'IBSA Institut Biochimique', sector: 'Farmaceutico & Chimico', employees: 500, city: 'Lugano', coordinates: [46.0150, 8.9420], website: 'https://www.ibsa.ch', description: 'Farmaceutica, dermatologia, endocrinologia, fertilità' },
  { name: 'Zambon', sector: 'Farmaceutico & Chimico', employees: 200, city: 'Cadempino', coordinates: [46.0380, 8.9350], website: 'https://www.zambon.com', description: 'Farmaceutica, prodotti respiratori' },
  { name: 'Humabs BioMed (Vir)', sector: 'Farmaceutico & Chimico', employees: 150, city: 'Bellinzona', coordinates: [46.1900, 9.0200], description: 'Biotech, anticorpi monoclonali' },
  { name: 'Istituto di Ricerca in Biomedicina (IRB)', sector: 'Farmaceutico & Chimico', employees: 180, city: 'Bellinzona', coordinates: [46.1910, 9.0180], website: 'https://www.irb.usi.ch', description: 'Ricerca immunologia e biologia cellulare' },
  { name: 'Laboratorio cantonale', sector: 'Farmaceutico & Chimico', employees: 100, city: 'Bellinzona', coordinates: [46.1930, 9.0210], description: 'Controllo qualità alimenti e acque' },
  { name: 'Sintetica', sector: 'Farmaceutico & Chimico', employees: 250, city: 'Mendrisio', coordinates: [45.8700, 8.9820], website: 'https://www.sintetica.com', description: 'Anestetici locali iniettabili, produzione sterile' },
  { name: 'Doppel Farmaceutici', sector: 'Farmaceutico & Chimico', employees: 80, city: 'Lugano', coordinates: [46.0110, 8.9450], description: 'Distribuzione farmaceutica, integratori' },

  // Lusso & Moda
  { name: 'VF International (The North Face, Timberland)', sector: 'Lusso & Moda', employees: 1200, city: 'Stabio', coordinates: [45.8520, 8.9350], website: 'https://www.vfc.com', description: 'Abbigliamento sportivo e outdoor, sede EMEA' },
  { name: 'Hugo Boss Ticino', sector: 'Lusso & Moda', employees: 350, city: 'Coldrerio', coordinates: [45.8490, 9.0050], website: 'https://www.hugoboss.com', description: 'Moda di lusso, logistica regionale' },
  { name: 'Guess Europe', sector: 'Lusso & Moda', employees: 300, city: 'Lugano', coordinates: [46.0060, 8.9490], website: 'https://www.guess.eu', description: 'Moda, sede europea' },
  { name: 'Bally', sector: 'Lusso & Moda', employees: 400, city: 'Caslano', coordinates: [45.9670, 8.8720], website: 'https://www.bally.com', description: 'Calzature e accessori di lusso, sede storica svizzera' },
  { name: 'Philipp Plein', sector: 'Lusso & Moda', employees: 200, city: 'Lugano', coordinates: [46.0080, 8.9560], website: 'https://www.plein.com', description: 'Moda di lusso, sede internazionale' },
  { name: 'Diesel (OTB)', sector: 'Lusso & Moda', employees: 150, city: 'Stabio', coordinates: [45.8530, 8.9340], website: 'https://www.diesel.com', description: 'Moda casual, logistica distribuzione' },
  { name: 'Ermenegildo Zegna (logistica)', sector: 'Lusso & Moda', employees: 180, city: 'Stabio', coordinates: [45.8510, 8.9360], website: 'https://www.zegna.com', description: 'Lusso maschile, centro logistico' },
  { name: 'Bulgari (logistica)', sector: 'Lusso & Moda', employees: 120, city: 'Mendrisio', coordinates: [45.8710, 8.9810], website: 'https://www.bulgari.com', description: 'Gioielleria di lusso LVMH, hub logistico' },
  { name: 'Bottega Veneta (logistica)', sector: 'Lusso & Moda', employees: 100, city: 'Mendrisio', coordinates: [45.8690, 8.9830], website: 'https://www.bottegaveneta.com', description: 'Pelletteria di lusso Kering, distribuzione' },

  // Alimentare
  { name: 'Rapelli', sector: 'Alimentare', employees: 400, city: 'Stabio', coordinates: [45.8540, 8.9310], website: 'https://www.rapelli.ch', description: 'Salumi e prodotti carnei svizzeri' },
  { name: 'Chocolat Stella', sector: 'Alimentare', employees: 120, city: 'Giubiasco', coordinates: [46.1740, 9.0050], website: 'https://www.chocolat-stella.ch', description: 'Cioccolato svizzero artigianale dal 1930' },
  { name: 'Migros Ticino', sector: 'Alimentare', employees: 2200, city: 'S. Antonino', coordinates: [46.1530, 8.9700], website: 'https://www.migros.ch', description: 'Grande distribuzione, supermercati e centri commerciali' },
  { name: 'Coop Ticino', sector: 'Alimentare', employees: 1800, city: 'Mezzovico', coordinates: [46.0900, 8.9550], website: 'https://www.coop.ch', description: 'Grande distribuzione, sede regionale' },
  { name: 'Aldi Suisse (logistica)', sector: 'Alimentare', employees: 300, city: 'Cadenazzo', coordinates: [46.1490, 8.9460], website: 'https://www.aldi-suisse.ch', description: 'Discount alimentare, centro distribuzione' },
  { name: 'Caffè Chicco d\'Oro', sector: 'Alimentare', employees: 100, city: 'Balerna', coordinates: [45.8530, 9.0140], website: 'https://www.chiccodoro.ch', description: 'Torrefazione caffè svizzero premium' },

  // Assicurazioni
  { name: 'Generali Svizzera', sector: 'Assicurazioni', employees: 350, city: 'Lugano', coordinates: [46.0030, 8.9560], website: 'https://www.generali.ch', description: 'Assicurazioni vita e danni' },
  { name: 'Zurich Insurance (sede Ticino)', sector: 'Assicurazioni', employees: 200, city: 'Lugano', coordinates: [46.0045, 8.9535], website: 'https://www.zurich.ch', description: 'Assicurazioni generali, sede regionale' },
  { name: 'Helvetia (sede Ticino)', sector: 'Assicurazioni', employees: 150, city: 'Lugano', coordinates: [46.0038, 8.9545], website: 'https://www.helvetia.ch', description: 'Assicurazioni e previdenza' },
  { name: 'CSS Assicurazione', sector: 'Assicurazioni', employees: 100, city: 'Bellinzona', coordinates: [46.1960, 9.0240], website: 'https://www.css.ch', description: 'Assicurazione malattia, sede regionale' },
  { name: 'SUVA (sede Ticino)', sector: 'Assicurazioni', employees: 180, city: 'Bellinzona', coordinates: [46.1940, 9.0230], website: 'https://www.suva.ch', description: 'Assicurazione infortuni, sede regionale' },

  // Logistica
  { name: 'Planzer', sector: 'Logistica', employees: 250, city: 'Cadenazzo', coordinates: [46.1500, 8.9480], website: 'https://www.planzer.ch', description: 'Trasporti e logistica' },
  { name: 'Posta Svizzera Centro Regionale', sector: 'Logistica', employees: 600, city: 'Cadenazzo', coordinates: [46.1520, 8.9500], description: 'Centro pacchi e logistica' },
  { name: 'FFS Officine (Ferrovie Federali)', sector: 'Logistica', employees: 800, city: 'Bellinzona', coordinates: [46.1980, 9.0250], website: 'https://www.sbb.ch', description: 'Officine di manutenzione treni, centro industriale' },
  { name: 'DHL Express Ticino', sector: 'Logistica', employees: 100, city: 'Mezzovico', coordinates: [46.0910, 8.9540], website: 'https://www.dhl.ch', description: 'Spedizioni espresse internazionali' },
  { name: 'Kuehne + Nagel', sector: 'Logistica', employees: 120, city: 'Chiasso', coordinates: [45.8350, 9.0280], website: 'https://www.kuehne-nagel.com', description: 'Logistica internazionale, spedizioni doganali' },
  { name: 'Gondrand', sector: 'Logistica', employees: 80, city: 'Chiasso', coordinates: [45.8360, 9.0260], description: 'Spedizioni internazionali, sdoganamento' },

  // Consulenza
  { name: 'Deloitte Ticino', sector: 'Consulenza', employees: 150, city: 'Lugano', coordinates: [46.0070, 8.9530], website: 'https://www.deloitte.ch', description: 'Audit, consulenza, tax' },
  { name: 'KPMG Lugano', sector: 'Consulenza', employees: 100, city: 'Lugano', coordinates: [46.0040, 8.9570], website: 'https://www.kpmg.ch', description: 'Revisione e consulenza aziendale' },
  { name: 'PwC Lugano', sector: 'Consulenza', employees: 130, city: 'Lugano', coordinates: [46.0052, 8.9555], website: 'https://www.pwc.ch', description: 'Revisione, fiscalità, consulenza strategica' },
  { name: 'EY Lugano', sector: 'Consulenza', employees: 80, city: 'Lugano', coordinates: [46.0058, 8.9515], website: 'https://www.ey.com', description: 'Audit, advisory, tax e transaction' },
  { name: 'BDO Ticino', sector: 'Consulenza', employees: 60, city: 'Lugano', coordinates: [46.0046, 8.9522], website: 'https://www.bdo.ch', description: 'Audit, fiduciaria, consulenza PMI' },

  // Energia
  { name: 'AET (Azienda Elettrica Ticinese)', sector: 'Energia', employees: 300, city: 'Bellinzona', coordinates: [46.1965, 9.0215], website: 'https://www.aet.ch', description: 'Produzione e distribuzione energia elettrica' },
  { name: 'AIL (Aziende Industriali Lugano)', sector: 'Energia', employees: 250, city: 'Lugano', coordinates: [46.0015, 8.9500], website: 'https://www.ail.ch', description: 'Gas, acqua, energia per Lugano e regione' },
  { name: 'SES (Società Elettrica Sopracenerina)', sector: 'Energia', employees: 120, city: 'Locarno', coordinates: [46.1700, 8.7980], website: 'https://www.ses.ch', description: 'Distribuzione energia elettrica Sopraceneri' },

  // Altro - Industria & Manifattura
  { name: 'Mikron Group', sector: 'Altro', employees: 300, city: 'Agno', coordinates: [45.9950, 8.9010], website: 'https://www.mikron.com', description: 'Automazione industriale e precision manufacturing' },
  { name: 'Swatch Group Assembly', sector: 'Lusso & Moda', employees: 250, city: 'Manno', coordinates: [46.0335, 8.9220], website: 'https://www.swatchgroup.com', description: 'Assemblaggio orologi, componentistica orologiera' },
  { name: 'ETA SA (Swatch Group)', sector: 'Lusso & Moda', employees: 180, city: 'Stabio', coordinates: [45.8545, 8.9380], website: 'https://www.eta.ch', description: 'Produzione movimenti orologieri, calibri meccanici e quarzo' },
  { name: 'Swiss Timing (Swatch Group)', sector: 'Tecnologia & IT', employees: 100, city: 'Corgémont', coordinates: [45.8550, 8.9320], website: 'https://www.swisstiming.com', description: 'Cronometraggio sportivo ufficiale, Olimpiadi e Formula 1' },
  { name: 'Nivarox (Swatch Group)', sector: 'Lusso & Moda', employees: 80, city: 'Stabio', coordinates: [45.8555, 8.9370], website: 'https://www.swatchgroup.com', description: 'Produzione spirali e componenti di precisione per orologi' },
  { name: 'Comadur (Swatch Group)', sector: 'Lusso & Moda', employees: 60, city: 'Stabio', coordinates: [45.8535, 8.9390], website: 'https://www.swatchgroup.com', description: 'Materiali high-tech: zaffiro, ceramica e carburo di tungsteno per orologi' },
  { name: 'Ente Ospedaliero Cantonale (EOC)', sector: 'Altro', employees: 5000, city: 'Bellinzona', coordinates: [46.1955, 9.0225], website: 'https://www.eoc.ch', description: 'Ospedali pubblici ticinesi, maggior datore di lavoro cantonale' },
  { name: 'Gruppo Fidinam', sector: 'Altro', employees: 350, city: 'Lugano', coordinates: [46.0062, 8.9508], website: 'https://www.fidinam.ch', description: 'Fiduciaria, fiscalità internazionale, corporate services' },
  { name: 'Tamedia / 20 Minuti', sector: 'Altro', employees: 100, city: 'Lugano', coordinates: [46.0055, 8.9500], website: 'https://www.20min.ch', description: 'Media, editoria digitale, notizie gratuite' },
  { name: 'RSI (Radiotelevisione Svizzera)', sector: 'Altro', employees: 800, city: 'Lugano-Besso', coordinates: [46.0130, 8.9430], website: 'https://www.rsi.ch', description: 'Servizio pubblico radiotelevisivo in lingua italiana' },
  { name: 'USI (Università della Svizzera Italiana)', sector: 'Altro', employees: 600, city: 'Lugano', coordinates: [46.0105, 8.9610], website: 'https://www.usi.ch', description: 'Università pubblica, informatica, economia, comunicazione' },
  { name: 'Amministrazione cantonale TI', sector: 'Altro', employees: 3500, city: 'Bellinzona', coordinates: [46.1942, 9.0228], website: 'https://www.ti.ch', description: 'Amministrazione pubblica del Canton Ticino' },
  { name: 'Città di Lugano', sector: 'Altro', employees: 1500, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://www.lugano.ch', description: 'Amministrazione comunale, servizi pubblici' },
  { name: 'ABB Svizzera (sede Ticino)', sector: 'Altro', employees: 180, city: 'Manno', coordinates: [46.0325, 8.9215], website: 'https://www.abb.ch', description: 'Tecnologie energetiche e automazione industriale' },
  { name: 'Benteler (Argor-Heraeus)', sector: 'Altro', employees: 220, city: 'Mendrisio', coordinates: [45.8720, 8.9800], website: 'https://www.argor.com', description: 'Raffinazione metalli preziosi, certificazione' },
  { name: 'Interroll', sector: 'Altro', employees: 350, city: 'S. Antonino', coordinates: [46.1540, 8.9710], website: 'https://www.interroll.com', description: 'Intralogistica, rulli e convogliatori industriali' },
  { name: 'Medacta International', sector: 'Altro', employees: 600, city: 'Castel S. Pietro', coordinates: [45.8600, 9.0080], website: 'https://www.medacta.com', description: 'Dispositivi medici ortopedici, protesi articolari' },
  { name: 'Precicast SA', sector: 'Altro', employees: 250, city: 'Novazzano', coordinates: [45.8470, 8.9780], website: 'https://www.precicast.com', description: 'Microfusione di precisione per aeronautica' },
  { name: 'Ferriere Cattaneo', sector: 'Altro', employees: 150, city: 'Giubiasco', coordinates: [46.1720, 9.0060], website: 'https://www.ferrierecattaneo.ch', description: 'Costruzioni metalliche, carpenteria' },
  { name: 'Riri Group', sector: 'Altro', employees: 200, city: 'Mendrisio', coordinates: [45.8680, 8.9840], website: 'https://www.ririgroup.com', description: 'Chiusure lampo e bottoni di lusso per fashion' },
  { name: 'Ticino Turismo', sector: 'Altro', employees: 50, city: 'Bellinzona', coordinates: [46.1935, 9.0232], website: 'https://www.ticino.ch', description: 'Promozione turistica del Canton Ticino' },
  { name: 'TILO (Treni Regionali Ticino Lombardia)', sector: 'Logistica', employees: 200, city: 'Chiasso', coordinates: [45.8340, 9.0290], website: 'https://www.tilo.ch', description: 'Treni regionali transfrontalieri TI-Lombardia' },
  { name: 'Hupac', sector: 'Logistica', employees: 700, city: 'Chiasso', coordinates: [45.8330, 9.0270], website: 'https://www.hupac.com', description: 'Trasporto intermodale ferroviario internazionale' },

  // Industria & Manifattura aggiuntive
  { name: 'PAMP SA', sector: 'Altro', employees: 300, city: 'Castel S. Pietro', coordinates: [45.8580, 9.0100], website: 'https://www.pamp.com', description: 'Raffineria metalli preziosi, lingotti oro e argento certificati LBMA' },
  { name: 'Gucci (logistica)', sector: 'Lusso & Moda', employees: 150, city: 'Stabio', coordinates: [45.8525, 8.9355], website: 'https://www.gucci.com', description: 'Centro logistico e distribuzione moda di lusso Kering' },
  { name: 'Moncler (logistica)', sector: 'Lusso & Moda', employees: 100, city: 'Stabio', coordinates: [45.8515, 8.9345], website: 'https://www.moncler.com', description: 'Abbigliamento luxury outerwear, hub logistico' },
  { name: 'Giorgio Armani Operations', sector: 'Lusso & Moda', employees: 200, city: 'Mendrisio', coordinates: [45.8695, 8.9815], website: 'https://www.armani.com', description: 'Operazioni e logistica moda lusso italiana' },
  { name: 'Globus / Magazine zum Globus', sector: 'Lusso & Moda', employees: 100, city: 'Lugano', coordinates: [46.0033, 8.9508], website: 'https://www.globus.ch', description: 'Grande magazzino di lusso svizzero' },
  { name: 'Manor', sector: 'Alimentare', employees: 250, city: 'Lugano', coordinates: [46.0040, 8.9550], website: 'https://www.manor.ch', description: 'Grande magazzino e supermercato, sede regionale' },
  { name: 'Lidl Svizzera (logistica)', sector: 'Alimentare', employees: 200, city: 'Bioggio', coordinates: [46.0100, 8.9050], website: 'https://www.lidl.ch', description: 'Discount alimentare, centro distribuzione regionale' },
  { name: 'Cardis Sotheby\'s International Realty', sector: 'Consulenza', employees: 50, city: 'Lugano', coordinates: [46.0030, 8.9520], website: 'https://www.cardis.ch', description: 'Immobiliare di lusso, proprietà esclusive Ticino' },
  { name: 'Bentley Lugano (Auto di lusso)', sector: 'Lusso & Moda', employees: 30, city: 'Noranco', coordinates: [45.9980, 8.9480], description: 'Concessionaria auto di lusso, servizi premium' },
  { name: 'Swisscom (sede Ticino)', sector: 'Tecnologia & IT', employees: 200, city: 'Bellinzona', coordinates: [46.1938, 9.0222], website: 'https://www.swisscom.ch', description: 'Telecomunicazioni, rete mobile e fibra ottica' },
  { name: 'Sunrise (sede Ticino)', sector: 'Tecnologia & IT', employees: 80, city: 'Lugano', coordinates: [46.0050, 8.9530], website: 'https://www.sunrise.ch', description: 'Telecomunicazioni e servizi internet' },
  { name: 'Carlo Benteler (Turck Duotec)', sector: 'Tecnologia & IT', employees: 150, city: 'Novazzano', coordinates: [45.8480, 8.9770], website: 'https://www.turck-duotec.com', description: 'Microelettronica e sensori industriali' },
  { name: 'Emmi Svizzera (Latteria Lugano)', sector: 'Alimentare', employees: 80, city: 'Lugano', coordinates: [46.0020, 8.9470], website: 'https://www.emmi.com', description: 'Latticini e formaggi svizzeri di qualità' },

  // Startup & Tech - Blockchain, Crypto, Fintech
  { name: 'Tether (USDT)', sector: 'Tecnologia & IT', employees: 80, city: 'Lugano', coordinates: [46.0039, 8.9518], website: 'https://tether.to', description: 'Stablecoin più usata al mondo, sede operativa a Lugano' },
  { name: 'Bitcoin Suisse', sector: 'Finanza & Banking', employees: 50, city: 'Lugano', coordinates: [46.0043, 8.9528], website: 'https://www.bitcoinsuisse.com', description: 'Broker crypto e servizi blockchain per istituzionali' },
  { name: 'Polygon Labs (sede Lugano)', sector: 'Tecnologia & IT', employees: 30, city: 'Lugano', coordinates: [46.0047, 8.9505], website: 'https://polygon.technology', description: 'Infrastruttura blockchain Layer 2 per Ethereum' },
  { name: 'Plan₿ Forum Lugano', sector: 'Tecnologia & IT', employees: 20, city: 'Lugano', coordinates: [46.0035, 8.9510], website: 'https://planb.lugano.ch', description: 'Hub Bitcoin, pagamenti crypto nella città di Lugano' },
  { name: 'Fetch.ai (sede CH)', sector: 'Tecnologia & IT', employees: 25, city: 'Lugano', coordinates: [46.0050, 8.9495], website: 'https://fetch.ai', description: 'AI decentralizzata e agenti autonomi blockchain' },
  { name: 'Lykke', sector: 'Tecnologia & IT', employees: 40, city: 'Lugano', coordinates: [46.0042, 8.9530], website: 'https://www.lykke.com', description: 'Exchange crypto e piattaforma trading' },

  // Biotech & Medtech
  { name: 'ADC Therapeutics', sector: 'Farmaceutico & Chimico', employees: 120, city: 'Lugano', coordinates: [46.0060, 8.9500], website: 'https://www.adctherapeutics.com', description: 'Biotecnologia oncologica, anticorpi coniugati (Nasdaq: ADCT)' },
  { name: 'STA Pharmaceutical (WuXi)', sector: 'Farmaceutico & Chimico', employees: 100, city: 'Lugano', coordinates: [46.0055, 8.9510], website: 'https://www.wuxiapptec.com', description: 'Sviluppo e produzione farmaceutica su contratto' },

  // Startup innovative
  { name: 'NetComm Suisse', sector: 'Tecnologia & IT', employees: 15, city: 'Lugano', coordinates: [46.0045, 8.9550], website: 'https://www.netcommsuisse.ch', description: 'Associazione e-commerce e digital transformation svizzera' },
  { name: 'Artificialy', sector: 'Tecnologia & IT', employees: 20, city: 'Manno', coordinates: [46.0342, 8.9215], website: 'https://www.artificialy.com', description: 'Startup AI, automazione processi industriali' },
  { name: 'Supercomputing Systems (sede TI)', sector: 'Tecnologia & IT', employees: 30, city: 'Manno', coordinates: [46.0348, 8.9205], description: 'Soluzioni embedded e software ad alte prestazioni' },
  { name: 'Varnish Software (sede TI)', sector: 'Tecnologia & IT', employees: 15, city: 'Lugano', coordinates: [46.0058, 8.9522], description: 'Content delivery, web performance e edge computing' },
  { name: 'Nexthink (sede TI)', sector: 'Tecnologia & IT', employees: 25, city: 'Lugano', coordinates: [46.0062, 8.9535], website: 'https://www.nexthink.com', description: 'Digital employee experience, monitoraggio IT aziendale' },

  // Industria & Manifattura
  { name: 'Tenconi SA', sector: 'Altro', employees: 80, city: 'Lugano', coordinates: [46.0025, 8.9485], website: 'https://www.tenconi.ch', description: 'Costruzioni, edilizia e immobiliare Ticino' },
  { name: 'Benteler International', sector: 'Altro', employees: 180, city: 'Mendrisio', coordinates: [45.8705, 8.9825], website: 'https://www.benteler.com', description: 'Componenti automotive e acciaio, sede regionale' },
  { name: 'Quadroni SA', sector: 'Altro', employees: 60, city: 'Giubiasco', coordinates: [46.1730, 9.0040], description: 'Packaging industriale e soluzioni logistiche' },

  // Gaming & Entertainment
  { name: 'Playlogic', sector: 'Tecnologia & IT', employees: 15, city: 'Lugano', coordinates: [46.0068, 8.9545], description: 'Sviluppo videogiochi e app interattive' },

  // Nuove startup e scaleup
  { name: 'SARDI Innovation', sector: 'Tecnologia & IT', employees: 10, city: 'Manno', coordinates: [46.0345, 8.9225], description: 'Smart augmented reality per industria e chirurgia' },
  { name: 'Cellestia Biotech', sector: 'Farmaceutico & Chimico', employees: 15, city: 'Bellinzona', coordinates: [46.1905, 9.0190], description: 'Biotech oncologica, terapie innovative contro il cancro' },
  { name: 'Wyss Zurich (polo TI)', sector: 'Farmaceutico & Chimico', employees: 20, city: 'Bellinzona', coordinates: [46.1915, 9.0195], description: 'Centro ricerca traslazionale e medicina rigenerativa' },
  { name: 'Tecnopolo Ticino', sector: 'Tecnologia & IT', employees: 10, city: 'Manno', coordinates: [46.0338, 8.9218], website: 'https://www.tecnopolo.ch', description: 'Incubatore startup, hub innovazione SUPSI-USI' },
  { name: 'Kendrion (sede Ticino)', sector: 'Altro', employees: 90, city: 'Stabio', coordinates: [45.8518, 8.9365], website: 'https://www.kendrion.com', description: 'Componenti elettromagnetici per automotive e industria' },
  { name: 'Glas Trösch (sede TI)', sector: 'Altro', employees: 70, city: 'Bodio', coordinates: [46.3500, 8.9130], website: 'https://www.glastroesch.ch', description: 'Lavorazione vetro industriale e isolante' },
  { name: 'Agire Invest', sector: 'Finanza & Banking', employees: 10, city: 'Manno', coordinates: [46.0355, 8.9195], website: 'https://www.agire.ch', description: 'Fondazione per innovazione tecnologica in Ticino' },
];

const SECTOR_COLORS: Record<string, string> = {
  'Finanza & Banking': '#2563eb',
  'Tecnologia & IT': '#7c3aed',
  'Farmaceutico & Chimico': '#059669',
  'Lusso & Moda': '#dc2626',
  'Alimentare': '#d97706',
  'Assicurazioni': '#0891b2',
  'Consulenza': '#4f46e5',
  'Logistica': '#64748b',
  'Energia': '#16a34a',
  'Altro': '#6b7280',
};

const SECTOR_ICONS: Record<string, string> = {
  'Finanza & Banking': '🏦',
  'Tecnologia & IT': '💻',
  'Farmaceutico & Chimico': '💊',
  'Lusso & Moda': '👜',
  'Alimentare': '🍕',
  'Assicurazioni': '🛡️',
  'Consulenza': '📊',
  'Logistica': '📦',
  'Energia': '⚡',
  'Altro': '🏭',
};

const createCompanyIcon = (sector: string, employees: number) => {
  const color = SECTOR_COLORS[sector] || '#6b7280';
  const icon = SECTOR_ICONS[sector] || '🏢';
  const size = employees > 1000 ? 44 : employees > 500 ? 38 : employees > 200 ? 32 : 28;
  return L.divIcon({
    className: 'company-marker',
    html: `
      <div style="
        width: ${size}px; height: ${size}px;
        background: ${color};
        border: 3px solid white;
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 0 2px ${color}30;
        display: flex; align-items: center; justify-content: center;
        font-size: ${size > 36 ? 18 : 14}px;
        font-family: system-ui;
      ">${icon}</div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2 - 4],
  });
};

type SortKey = 'employees' | 'name' | 'city';

const TicinoCompanies: React.FC = () => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSector, setSelectedSector] = useState('Tutti');
  const [sortBy, setSortBy] = useState<SortKey>('employees');
  const [sortDesc, setSortDesc] = useState(true);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [minEmployees, setMinEmployees] = useState(0);

  const filtered = useMemo(() => {
    let result = companies.filter(c => {
      const matchSearch = !searchQuery || 
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.sector.toLowerCase().includes(searchQuery.toLowerCase());
      const matchSector = selectedSector === 'Tutti' || c.sector === selectedSector;
      const matchEmployees = c.employees >= minEmployees;
      return matchSearch && matchSector && matchEmployees;
    });

    result.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'employees') cmp = a.employees - b.employees;
      else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'city') cmp = a.city.localeCompare(b.city);
      return sortDesc ? -cmp : cmp;
    });

    return result;
  }, [searchQuery, selectedSector, sortBy, sortDesc, minEmployees]);

  const totalEmployees = useMemo(() => filtered.reduce((sum, c) => sum + c.employees, 0), [filtered]);
  const mapCenter: [number, number] = [46.02, 8.96];

  // Get company favicon from website domain
  const getCompanyLogo = (company: Company) => {
    if (company.logo) return company.logo;
    if (company.website) {
      try {
        const domain = new URL(company.website).hostname;
        return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      } catch { return null; }
    }
    return null;
  };

  return (
    <div className="space-y-6 animate-fade-in overflow-x-hidden">
      <style>{`
        .company-marker { background: none !important; border: none !important; }
      `}</style>

      {/* Header */}
      <div className="bg-gradient-to-br from-violet-600 via-purple-600 to-fuchsia-600 rounded-2xl sm:rounded-3xl p-4 sm:p-8 text-white shadow-2xl">
        <div className="flex items-center gap-3 sm:gap-4 mb-4">
          <div className="p-2 sm:p-3 bg-white/20 rounded-xl sm:rounded-2xl backdrop-blur-sm flex-shrink-0">
            <Building2 size={28} className="sm:w-8 sm:h-8" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-3xl font-extrabold">{t('companies.title') || 'Aziende in Ticino'}</h1>
            <p className="text-purple-100 mt-1 text-sm sm:text-base">{t('companies.subtitle') || 'Mappa interattiva delle principali società con filtri per settore e dimensione'}</p>
          </div>
        </div>
        <div className="flex gap-3 sm:gap-4 mt-4">
          <div className="bg-white/20 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 flex-1 min-w-0">
            <div className="text-purple-100 text-[10px] sm:text-xs font-bold uppercase">{t('companies.totalCompanies') || 'Aziende'}</div>
            <div className="text-xl sm:text-2xl font-extrabold">{filtered.length}</div>
          </div>
          <div className="bg-white/20 backdrop-blur-sm rounded-xl px-3 sm:px-4 py-2 flex-1 min-w-0">
            <div className="text-purple-100 text-[10px] sm:text-xs font-bold uppercase">{t('companies.totalEmployees') || 'Dipendenti'}</div>
            <div className="text-xl sm:text-2xl font-extrabold">{totalEmployees.toLocaleString('it-IT')}</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-3 sm:p-4 border border-slate-200 dark:border-slate-700 space-y-3 overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 sm:gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-0 w-full sm:min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('companies.search') || 'Cerca azienda, città, settore...'}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          {/* Sector filter */}
          <div className="relative">
            <select
              value={selectedSector}
              onChange={(e) => setSelectedSector(e.target.value)}
              className="appearance-none pl-3 pr-8 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-violet-500 cursor-pointer"
            >
              {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>

          {/* View toggle */}
          <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
            <button onClick={() => setViewMode('map')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'map' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300'}`}>
              <Map size={14} /> {t('traffic.mapView') || 'Mappa'}
            </button>
            <button onClick={() => setViewMode('list')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${viewMode === 'list' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300'}`}>
              <List size={14} /> {t('traffic.listView') || 'Lista'}
            </button>
          </div>
        </div>

        {/* Employee filter + sort */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 text-sm">
            <Users size={14} className="text-slate-500 flex-shrink-0" />
            <span className="text-slate-600 dark:text-slate-400 font-medium whitespace-nowrap text-xs sm:text-sm">{t('companies.minEmployees')}:</span>
            <input type="range" min={0} max={1000} step={50} value={minEmployees}
              onChange={(e) => setMinEmployees(Number(e.target.value))}
              className="w-full sm:w-32 accent-violet-600" />
            <span className="font-bold text-violet-600 w-10">{minEmployees}</span>
          </div>
          <div className="flex items-center gap-2 sm:ml-auto">
            <ArrowUpDown size={14} className="text-slate-500" />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="appearance-none px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:outline-none">
              <option value="employees">{t('companies.totalEmployees')}</option>
              <option value="name">{t('companies.sortName')}</option>
              <option value="city">{t('companies.sortCity')}</option>
            </select>
            <button onClick={() => setSortDesc(!sortDesc)} className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              {sortDesc ? '↓' : '↑'}
            </button>
          </div>
        </div>
      </div>

      {/* MAP VIEW */}
      {viewMode === 'map' && (
        <div className="rounded-2xl overflow-hidden border-2 border-slate-200 dark:border-slate-700 shadow-lg">
          <MapContainer center={mapCenter} zoom={10} style={{ height: 'min(550px, 70vh)', width: '100%' }} scrollWheelZoom={true}>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filtered.map((company) => (
              <Marker key={company.name} position={company.coordinates} icon={createCompanyIcon(company.sector, company.employees)}>
                <Popup maxWidth={300}>
                  <div style={{ padding: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      {company.website ? (
                        <img src={`https://www.google.com/s2/favicons?domain=${new URL(company.website).hostname}&sz=32`} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'contain' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      ) : (
                        <span style={{ fontSize: '24px' }}>{SECTOR_ICONS[company.sector] || '🏢'}</span>
                      )}
                      <div>
                        <h3 style={{ fontWeight: 800, fontSize: '16px', margin: 0, color: '#1e293b' }}>{company.name}</h3>
                        <span style={{ fontSize: '12px', color: SECTOR_COLORS[company.sector], fontWeight: 600 }}>{company.sector}</span>
                      </div>
                    </div>
                    <p style={{ fontSize: '13px', color: '#475569', margin: '0 0 8px' }}>{company.description}</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#94a3b8' }}>{t('companies.totalEmployees')}</span>
                        <span style={{ fontWeight: 700 }}>{company.employees.toLocaleString('it-IT')}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#94a3b8' }}>{t('companies.sortCity')}</span>
                        <span style={{ fontWeight: 700 }}>{company.city}</span>
                      </div>
                    </div>
                    {company.website && (
                      <a href={company.website} target="_blank" rel="noopener noreferrer"
                        style={{ marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', width: '100%', padding: '8px', backgroundColor: '#7c3aed', color: 'white', borderRadius: '8px', fontSize: '13px', fontWeight: 700, textDecoration: 'none' }}>
                        {t('companies.visitWebsite')}
                      </a>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>

          {/* Legend */}
          <div className="flex items-center justify-center gap-3 py-3 bg-white dark:bg-slate-800 text-xs text-slate-500 flex-wrap px-4">
            {Object.entries(SECTOR_ICONS).slice(0, 6).map(([sector, icon]) => (
              <button key={sector} onClick={() => setSelectedSector(sector === selectedSector ? 'Tutti' : sector)}
                className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${selectedSector === sector ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 font-bold' : 'hover:bg-slate-100 dark:hover:bg-slate-700'}`}>
                <span>{icon}</span> {sector.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* LIST VIEW */}
      {viewMode === 'list' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {filtered.map((company) => (
            <div key={company.name} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 sm:p-5 hover:shadow-md transition-all min-w-0 overflow-hidden">
              <div className="flex items-start gap-3 mb-3">
                {getCompanyLogo(company) ? (
                  <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center overflow-hidden flex-shrink-0 border border-slate-200 dark:border-slate-600">
                    <img src={getCompanyLogo(company)!} alt={company.name} className="w-6 h-6 object-contain" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.innerHTML = `<span class="text-xl">${SECTOR_ICONS[company.sector] || '🏢'}</span>`; }} />
                  </div>
                ) : (
                  <div className="text-2xl">{SECTOR_ICONS[company.sector] || '🏢'}</div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-slate-800 dark:text-slate-100 truncate">{company.name}</h3>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${SECTOR_COLORS[company.sector]}15`, color: SECTOR_COLORS[company.sector] }}>
                    {company.sector}
                  </span>
                </div>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">{company.description}</p>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
                  <Users size={14} />
                  <span className="font-bold">{company.employees.toLocaleString('it-IT')}</span>
                </div>
                <div className="flex items-center gap-1.5 text-slate-500">
                  <MapPin size={14} />
                  <span>{company.city}</span>
                </div>
              </div>
              {company.website && (
                <a href={company.website} target="_blank" rel="noopener noreferrer"
                  className="mt-3 flex items-center justify-center gap-1.5 w-full py-2 bg-violet-600 text-white rounded-lg text-xs font-bold hover:bg-violet-700 transition-colors no-underline">
                  <Globe size={12} />
                  {t('companies.visitWebsite')}
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          <Building2 size={48} className="mx-auto mb-3 opacity-50" />
          <p className="font-bold">{t('companies.noResults')}</p>
          <p className="text-sm">{t('companies.tryModifyFilters')}</p>
        </div>
      )}
    </div>
  );
};

export default TicinoCompanies;
