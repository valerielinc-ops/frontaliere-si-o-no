import React, { useState, useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Building2, Users, Search, SlidersHorizontal, ArrowUpDown, MapPin, ExternalLink, Filter, ChevronDown, Globe, Briefcase } from 'lucide-react';
import { useLocale, useTranslation, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { buildPath } from '@/services/router';
import { resolveCompanyWebsiteHost } from '@/services/jobDataNormalization';
import { reportCaughtError } from '@/services/errorReporter';
import extraCompaniesData from '@/data/ticino-companies-extra.json';
import crawlerCompaniesData from '@/data/crawler-companies-auto.json';
import ProviderLogo from '@/components/shared/ProviderLogo';

const companyDomain = (website: string) =>
 website ? new URL(website).hostname.replace(/^www\./, '') : '';


interface Company {
 name: string;
 sector: string;
 employees: number;
 city: string;
 coordinates: [number, number];
 website?: string;
 careersUrl?: string;
 description: string;
 logo?: string;
}

interface JobListingLite {
 company?: string;
 companyKey?: string;
 companyDomain?: string;
 url?: string;
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
 { name: 'Board International', sector: 'Tecnologia & IT', employees: 300, city: 'Chiasso', coordinates: [45.8333, 9.0319], website: 'https://www.board.com', careersUrl: 'https://www.board.com/open-positions?locations%5B%5D=56', description: 'Intelligent Planning Platform con hub prodotto, design e engineering a Chiasso.' },
 { name: 'Skyguide', sector: 'Logistica', employees: 120, city: 'Lugano Agno', coordinates: [46.0047, 8.9105], website: 'https://www.skyguide.ch', careersUrl: 'https://jobs.skyguide.ch/search/?createNewAlert=false&q=&locationsearch=&optionsFacetsDD_department=&optionsFacetsDD_location=Lugano+Agno%2C+CH', description: 'Servizi di navigazione aerea e formazione per controllori del traffico aereo con opportunità aperte a Locarno e Lugano Agno.' },
 { name: 'Avaloq', sector: 'Tecnologia & IT', employees: 700, city: 'Bioggio', coordinates: [46.0148, 8.9111], website: 'https://www.avaloq.com', careersUrl: 'https://www.avaloq.com/careers/job-openings', description: 'Wealth management technology e core banking software con sede operativa ticinese a Bioggio e numerose posizioni tra engineering, operations e apprendistati.' },
 { name: 'GOLINE SA', sector: 'Tecnologia & IT', employees: 40, city: 'Stabio', coordinates: [45.8517, 8.9347], website: 'https://www.goline.ch', careersUrl: 'https://www.goline.ch/opportunities/', description: 'Software house ticinese specializzata in sviluppo web full stack, integrazioni backend e soluzioni digitali operative con sede a Stabio.' },
 { name: 'ti&m', sector: 'Tecnologia & IT', employees: 100, city: 'Lugano', coordinates: [46.0070, 8.9540], website: 'https://www.ti8m.ch', description: 'Software engineering, sviluppo web & mobile' },
 { name: 'InvestGlass', sector: 'Tecnologia & IT', employees: 40, city: 'Lugano', coordinates: [46.0028, 8.9490], website: 'https://www.investglass.com', description: 'CRM fintech per wealth management' },
 { name: 'Quantumvis', sector: 'Tecnologia & IT', employees: 30, city: 'Manno', coordinates: [46.0330, 8.9230], description: 'Soluzioni AI e machine learning per industria' },
 { name: 'Delvitech SA', sector: 'Tecnologia & IT', employees: 80, city: 'Mendrisio', coordinates: [45.8698, 8.9860], website: 'https://legacy.delvi.tech', careersUrl: 'https://legacy.delvi.tech/career/', description: 'Automated Optical Inspection con AI per elettronica e manifattura avanzata, con headquarters a Mendrisio.' },
 { name: 'Fincons Group', sector: 'Tecnologia & IT', employees: 300, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://www.finconsgroup.com', careersUrl: 'https://ita.finconsgroup.com/culture-and-careers/job-offers/sedi/lugano.kl', description: 'Consulenza IT, system integration e software engineering con hub di recruiting e delivery a Lugano.' },
 { name: 'Zucchetti Switzerland SA', sector: 'Tecnologia & IT', employees: 120, city: 'Mendrisio', coordinates: [45.8695, 8.9848], website: 'https://www.zucchetti.com', careersUrl: 'https://www.zucchetti.com/de/careers.html', description: 'Software aziendale, ERP, HR e soluzioni POS con team di sviluppo e prodotto a Mendrisio.' },

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
 { name: 'Guess Europe Sagl', sector: 'Lusso & Moda', employees: 300, city: 'Bioggio', coordinates: [46.0139, 8.9119], website: 'https://www.guess.eu', careersUrl: 'https://www.guess.eu/it-ch/career-page.html', description: 'Moda e lifestyle, hub Ticino tra Bioggio e Stabio' },
 { name: 'ALTEN Switzerland', sector: 'IT & Engineering Consulting', employees: 450, city: 'Chiasso', coordinates: [45.8320, 9.0312], website: 'https://www.alten.ch', careersUrl: 'https://www.alten.ch/career/jobs/?pagenum=1&per_page=100', description: 'Consulenza IT e ingegneristica con hiring office indicato a Chiasso per le vacancy tecnologiche in Ticino' },
 { name: 'Damiani Group', sector: 'Lusso & Moda', employees: 220, city: 'Mendrisio', coordinates: [45.8714, 8.9863], website: 'https://www.damianigroup.com', careersUrl: 'https://careers.damianigroup.com/search/?locale=it_IT', description: 'Alta gioielleria e customer operations con base a Mendrisio per il gruppo Damiani' },
 { name: 'Bally', sector: 'Lusso & Moda', employees: 400, city: 'Caslano', coordinates: [45.9670, 8.8720], website: 'https://www.bally.com', description: 'Calzature e accessori di lusso, sede storica svizzera' },
 { name: 'Philipp Plein', sector: 'Lusso & Moda', employees: 200, city: 'Lugano', coordinates: [46.0080, 8.9560], website: 'https://www.plein.com', description: 'Moda di lusso, sede internazionale' },
 { name: 'Diesel (OTB)', sector: 'Lusso & Moda', employees: 150, city: 'Stabio', coordinates: [45.8530, 8.9340], website: 'https://www.diesel.com', description: 'Moda casual, logistica distribuzione' },
 { name: 'Ermenegildo Zegna (logistica)', sector: 'Lusso & Moda', employees: 180, city: 'Stabio', coordinates: [45.8510, 8.9360], website: 'https://www.zegna.com', careersUrl: 'https://careers.zegnagroup.com/?FreeSearch=&Location=177940409', description: 'Lusso maschile, centro logistico' },
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
 { name: 'Posta Svizzera Centro Regionale', sector: 'Logistica', employees: 600, city: 'Cadenazzo', coordinates: [46.1520, 8.9500], careersUrl: 'https://www.post.ch/en/jobs/jobs?canton=1085914&jobsCategory=professionals&workload-maximum=1&workload-minimum=0', description: 'Centro pacchi e logistica' },
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
 { name: 'LWP Ledermann Wieting & Partners', sector: 'Consulenza', employees: 35, city: 'Lugano', coordinates: [46.0061, 8.9518], website: 'https://www.lwphr.ch', careersUrl: 'https://www.lwphr.ch/opportunita-opportunities.html', description: 'Executive search, recruiting e consulenza HR con base a Lugano e portale opportunità Ticino in PDF' },
 { name: 'TSMG', sector: 'Tecnologia & IT', employees: 250, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://tsmg.co', careersUrl: 'https://jobs.lever.co/tsmg', description: 'Field data collection, speech data e progetti AI con ruoli operativi in Ticino e Grigioni.' },

 // Energia
 { name: 'AET (Azienda Elettrica Ticinese)', sector: 'Energia', employees: 300, city: 'Bellinzona', coordinates: [46.1965, 9.0215], website: 'https://www.aet.ch', description: 'Produzione e distribuzione energia elettrica' },
 { name: 'AIL (Aziende Industriali Lugano)', sector: 'Energia', employees: 250, city: 'Lugano', coordinates: [46.0015, 8.9500], website: 'https://www.ail.ch', description: 'Gas, acqua, energia per Lugano e regione' },
 { name: 'Ariston Group', sector: 'Energia', employees: 120, city: 'Bedano', coordinates: [46.0440, 8.9228], website: 'https://www.aristongroup.com', careersUrl: 'https://careers.aristongroup.com/search/?createNewAlert=false&q=&optionsFacetsDD_country=CH&optionsFacetsDD_department=&optionsFacetsDD_shifttype=&optionsFacetsDD_customfield2=', description: 'Soluzioni per riscaldamento e comfort termico con service center ELCO a Bedano' },
 { name: 'Artisa Group', sector: 'Altro', employees: 120, city: 'Manno', coordinates: [46.0297, 8.9189], website: 'https://artisagroup.com', careersUrl: 'https://artisagroup.com/carriera', description: 'Gruppo immobiliare, architettura e real estate con opportunità aperte tra Lugano e Manno.' },
 { name: 'Bosch Thermotechnik AG', sector: 'Energia', employees: 90, city: 'Rivera', coordinates: [46.1248, 8.9237], website: 'https://www.bosch.ch', careersUrl: 'https://jobs.bosch.com/en/?country=ch', description: 'Assistenza tecnica e soluzioni termotecniche Bosch/Buderus con sede operativa a Rivera per il Ticino' },
 { name: 'RUAG AG', sector: 'Altro', employees: 140, city: 'Lodrino', coordinates: [46.3004, 8.9924], website: 'https://www.ruag.ch', careersUrl: 'https://www.ruag.ch/en/working-us/job-portal?f%5B0%5D=job_facet_workplace%3A310', description: 'Tecnologie aerospaziali e manutenzione con opportunità tecniche e apprendistati presso il sito RUAG di Lodrino.' },
 { name: 'Rittmeyer AG', sector: 'Energia', employees: 80, city: 'Camorino', coordinates: [46.1633, 9.0227], website: 'https://www.rittmeyer.com', careersUrl: 'https://karriere.rittmeyer.com/offene-stellen/?suche=&location=23&country=1', description: 'Automazione, misurazione e controllo per reti idriche ed energetiche con presenza operativa in Ticino' },
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
 { name: 'The Living Circle', sector: 'Lusso & Moda', employees: 350, city: 'Ascona', coordinates: [46.1549, 8.7741], website: 'https://www.thelivingcircle.ch', careersUrl: 'https://jobs.thelivingcircle.ch/#jobs:location=%5B%22Ascona%22%5D', description: 'Gruppo hospitality di lusso con Castello del Sole, Cantina alla Maggia e attività alberghiere ed enogastronomiche ad Ascona.' },
 { name: 'Globus / Magazine zum Globus', sector: 'Lusso & Moda', employees: 100, city: 'Lugano', coordinates: [46.0033, 8.9508], website: 'https://www.globus.ch', description: 'Grande magazzino di lusso svizzero' },
 { name: 'Manor', sector: 'Alimentare', employees: 250, city: 'Lugano', coordinates: [46.0040, 8.9550], website: 'https://www.manor.ch', description: 'Grande magazzino e supermercato, sede regionale' },
 { name: 'Lidl Svizzera', sector: 'Alimentare', employees: 200, city: 'Bioggio', coordinates: [46.0100, 8.9050], website: 'https://www.lidl.ch', description: 'Discount alimentare, centro distribuzione regionale' },
 { name: 'lastminute.com', sector: 'Tecnologia & IT', employees: 250, city: 'Chiasso', coordinates: [45.8342, 9.0314], website: 'https://corporate.lastminute.com', description: 'Travel-tech e prenotazioni digitali, hub prodotto e engineering a Chiasso' },
 { name: 'Cardis Sotheby\'s International Realty', sector: 'Consulenza', employees: 50, city: 'Lugano', coordinates: [46.0030, 8.9520], website: 'https://www.cardis.ch', description: 'Immobiliare di lusso, proprietà esclusive Ticino' },
 { name: 'Bentley Lugano (Auto di lusso)', sector: 'Lusso & Moda', employees: 30, city: 'Noranco', coordinates: [45.9980, 8.9480], description: 'Concessionaria auto di lusso, servizi premium' },
 { name: 'Swisscom (sede Ticino)', sector: 'Tecnologia & IT', employees: 200, city: 'Bellinzona', coordinates: [46.1938, 9.0222], website: 'https://www.swisscom.ch', description: 'Telecomunicazioni, rete mobile e fibra ottica' },
 { name: 'Sunrise Communications AG', sector: 'Tecnologia & IT', employees: 80, city: 'Manno', coordinates: [46.0300, 8.9200], website: 'https://careers.sunrise.ch/it/it/search-results', description: 'Telecomunicazioni, mobile, fibra e servizi digitali in Svizzera' },
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
 // Nuove aziende — Ticino
 { name: 'Pini Group SA', sector: 'Altro', employees: 700, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://www.pinigroup.com', description: 'Ingegneria infrastrutturale, tunnel, ponti e grandi opere' },
 { name: 'Prada Group', sector: 'Lusso & Moda', employees: 200, city: 'Mendrisio', coordinates: [45.8750, 8.9800], website: 'https://www.pradagroup.com', careersUrl: 'https://jobs.pradagroup.com/search/?q=&locationsearch=switzerland', description: 'Moda e lusso, outlet FoxTown e uffici regionali' },
 { name: 'Salt Mobile SA', sector: 'Tecnologia & IT', employees: 150, city: 'Lugano', coordinates: [46.0037, 8.9500], website: 'https://www.salt.ch', careersUrl: 'https://www.salt.ch/it/about-us/careers', description: 'Terzo operatore mobile svizzero, rete e servizi digitali' },
 { name: 'Mabetex Group', sector: 'Altro', employees: 300, city: 'Lugano', coordinates: [46.0037, 8.9511], website: 'https://www.mabetex.com', description: 'Gruppo costruzioni ed engineering internazionale' },
 { name: 'Otis SA', sector: 'Altro', employees: 200, city: 'Ticino', coordinates: [46.0037, 8.9500], website: 'https://www.otis.com', careersUrl: 'https://otis.wd5.myworkdayjobs.com/REC_Ext_Gateway', description: 'Leader mondiale ascensori, scale mobili e manutenzione' },
 { name: 'Unilabs', sector: 'Farmaceutico & Chimico', employees: 60, city: 'Manno', coordinates: [46.0300, 8.9200], website: 'https://www.unilabs.com', description: 'Diagnostica di laboratorio medico, analisi cliniche' },
 // Nuove aziende — Grigioni
 { name: 'Läderach (Schweiz) AG', sector: 'Alimentare', employees: 1000, city: 'Ennenda', coordinates: [46.8508, 9.5319], website: 'https://www.laderach.com', careersUrl: 'https://laderach.career.softgarden.de/jobs/', description: 'Cioccolato svizzero premium, produzione e retail' },
 { name: 'Hilcona AG (Bell Food Group)', sector: 'Alimentare', employees: 500, city: 'Landquart', coordinates: [46.9686, 9.5520], website: 'https://www.hilcona.com', careersUrl: 'https://career.bellfoodgroup.com/de/offene-stellen', description: 'Alimentare convenience, produzione e logistica' },
 { name: 'CEDES AG', sector: 'Tecnologia & IT', employees: 200, city: 'Landquart', coordinates: [46.9668, 9.5481], website: 'https://www.cedes.com', careersUrl: 'https://www.cedes.com/en/career/jobs/', description: 'Sensori industriali e di sicurezza, elettronica ottica' },
 { name: 'Davos Klosters Bergbahnen AG', sector: 'Altro', employees: 300, city: 'Davos', coordinates: [46.8027, 9.8360], website: 'https://www.davosklostersmountains.ch', careersUrl: 'https://www.davosklostersmountains.ch/de/mountains/stellenangebote/jobs-berge', description: 'Impianti di risalita, infrastrutture turistiche e gastronomia' },
];

type ExternalCompanyRaw = {
 name?: string;
 sector?: string;
 employees?: number;
 city?: string;
 website?: string;
 description?: string;
 coordinates?: [number, number];
};

const FALLBACK_COORDS: [number, number] = [46.0037, 8.9511];

const normalizeTextKey = (value: string) =>
 value
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .trim();

const slugify = (value: string) =>
 normalizeTextKey(value).replace(/\s+/g, '-').slice(0, 200);

const canonicalCompanyRouteSlug = (companyName: string, votedSlug = '') => {
 const key = normalizeTextKey(companyName);
 const candidate = String(votedSlug || '').trim();
 if (key.includes('lidl') || candidate === 'lidl' || candidate.startsWith('lidl-')) return 'lidl';
 return candidate || slugify(companyName);
};

const inferSector = (name: string, website = ''): string => {
 const source = `${name} ${website}`.toLowerCase();
 if (/(bank|banca|finance|wealth|credit|ubs|raiffeisen|migros|allianz|axa|zurich)/.test(source)) return 'Finanza & Banking';
 if (/(software|tech|digital|it|cloud|ai|cyber|avaloq|nozomi)/.test(source)) return 'Tecnologia & IT';
 if (/(pharma|biotech|med|clinic|health|bio)/.test(source)) return 'Farmaceutico & Chimico';
 if (/(fashion|lux|watch|swatch|gucci|boss|moda|retail)/.test(source)) return 'Lusso & Moda';
 if (/(logistic|transport|cargo|rail|posta|hupac)/.test(source)) return 'Logistica';
 if (/(energy|elettric|power|aet|ail|ses)/.test(source)) return 'Energia';
 return 'Altro';
};

const cityCoordsMap: Record<string, [number, number]> = companies.reduce((acc, company) => {
 const key = normalizeTextKey(company.city);
 if (!acc[key]) acc[key] = company.coordinates;
 return acc;
}, {} as Record<string, [number, number]>);

const toCompany = (raw: ExternalCompanyRaw): Company | null => {
 const name = String(raw?.name || '').trim();
 if (!name) return null;
 const city = String(raw?.city || 'Lugano').trim();
 const cityKey = normalizeTextKey(city);
 const sector = String(raw?.sector || inferSector(name, raw?.website || '')).trim();
 const employees = Number.isFinite(raw?.employees) && Number(raw?.employees) > 0 ? Number(raw?.employees) : 50;
 const coordinates =
 Array.isArray(raw?.coordinates) && raw.coordinates.length === 2
 ? raw.coordinates
 : cityCoordsMap[cityKey] || FALLBACK_COORDS;
 const website = raw?.website ? String(raw.website).trim() : undefined;
 const description =
 String(raw?.description || '').trim() ||
 `${name} è un'azienda con presenza in Ticino.`;

 return { name, sector, employees, city, coordinates, website, description };
};

const externalCompaniesRaw: ExternalCompanyRaw[] = [
 ...((extraCompaniesData as ExternalCompanyRaw[]) || []),
];
const externalCompanies = externalCompaniesRaw.map(toCompany).filter(Boolean) as Company[];

const crawlerCompaniesRaw: ExternalCompanyRaw[] = [
 ...((crawlerCompaniesData as ExternalCompanyRaw[]) || []),
];
const crawlerCompanies = crawlerCompaniesRaw.map(toCompany).filter(Boolean) as Company[];

const allCompanies: Company[] = (() => {
 // Order matters: hardcoded first (richest data), then manual extra, then auto-generated.
 // Deduplication keeps the first occurrence, so richer entries win.
 const merged = [...companies, ...externalCompanies, ...crawlerCompanies];
 const seen = new Set<string>();
 const deduped: Company[] = [];
 for (const company of merged) {
 const nameKey = normalizeTextKey(company.name);
 const cityKey = normalizeTextKey(company.city);
 const hostKey = (() => {
 try {
 return company.website ? new URL(company.website).hostname.replace(/^www\./, '').toLowerCase() : '';
 } catch {
 return '';
 }
 })();
 const dedupeKey = hostKey ? `host:${hostKey}` : `${nameKey}|${cityKey}`;
 if (seen.has(dedupeKey)) continue;
 seen.add(dedupeKey);
 deduped.push(company);
 }
 return deduped;
})();

type CompanyMatchEntry = {
 key: string;
 nameKey: string;
 tokenSet: Set<string>;
};

type CompanyMatchers = {
 byName: Map<string, string>;
 byBag: Map<string, string[]>;
 byHost: Map<string, string[]>;
 entries: Map<string, CompanyMatchEntry>;
};

function normalizeDomainHost(value: string): string {
 const raw = String(value || '').trim().toLowerCase();
 if (!raw) return '';
 const withoutProtocol = raw.replace(/^https?:\/\//, '');
 return withoutProtocol.split('/')[0].replace(/^www\./, '').trim();
}

function tokenizeCompany(value: string): string[] {
 return normalizeTextKey(value)
 .split(' ')
 .map((x) => x.trim())
 .filter((x) => x.length >= 2);
}

function bagCompanyKey(value: string): string {
 const uniq = [...new Set(tokenizeCompany(value))].sort();
 return uniq.join(' ').trim();
}

function collectCompanyAliases(name: string): string[] {
 const raw = String(name || '').trim();
 const out = new Set<string>();
 if (!raw) return [];

 const push = (value: string) => {
 const normalized = normalizeTextKey(value);
 if (normalized) out.add(normalized);
 };

 push(raw);
 push(raw.replace(/\([^)]*\)/g, ' '));
 push(raw.replace(/[-–—/]/g, ' '));
 push(raw.replace(/\b(?:sede|ora)\b[\s\S]*$/i, ' '));

 const acronymMatches = [...raw.matchAll(/\(([A-Za-z0-9]{2,12})\)/g)];
 for (const match of acronymMatches) {
 push(match[1]);
 }

 return [...out];
}

function buildCompanyMatchers(list: Company[]): CompanyMatchers {
 const byName = new Map<string, string>();
 const byBag = new Map<string, string[]>();
 const byHost = new Map<string, string[]>();
 const entries = new Map<string, CompanyMatchEntry>();

 for (const company of list) {
 const key = normalizeTextKey(company.name);
 if (!key) continue;

 const aliases = collectCompanyAliases(company.name);
 const nameKey = normalizeTextKey(company.name);
 const tokenSet = new Set(tokenizeCompany(company.name));
 entries.set(key, { key, nameKey, tokenSet });

 for (const alias of aliases) {
 if (!byName.has(alias)) byName.set(alias, key);
 const bag = bagCompanyKey(alias);
 if (!bag) continue;
 const current = byBag.get(bag) || [];
 if (!current.includes(key)) current.push(key);
 byBag.set(bag, current);
 }

 const host = normalizeDomainHost(company.website || '');
 if (host) {
 const current = byHost.get(host) || [];
 if (!current.includes(key)) current.push(key);
 byHost.set(host, current);
 }
 }

 return { byName, byBag, byHost, entries };
}

const COMPANY_MATCHERS = buildCompanyMatchers(allCompanies);

function scoreJobToCompanyName(jobNameKey: string, entry: CompanyMatchEntry | undefined): number {
 if (!jobNameKey || !entry) return 0;
 if (jobNameKey === entry.nameKey) return 1000;
 if (jobNameKey.includes(entry.nameKey) || entry.nameKey.includes(jobNameKey)) return 900;

 const jobTokens = tokenizeCompany(jobNameKey);
 if (jobTokens.length === 0) return 0;
 let overlap = 0;
 for (const token of jobTokens) {
 if (entry.tokenSet.has(token)) overlap += 1;
 }
 if (overlap === 0) return 0;
 return overlap * 10 + (entry.tokenSet.size > 0 ? overlap / entry.tokenSet.size : 0);
}

function pickBestCompanyKey(jobNameKey: string, candidates: string[], matchers: CompanyMatchers): string {
 if (candidates.length === 0) return '';
 if (candidates.length === 1) return candidates[0];

 let bestKey = '';
 let bestScore = -1;
 for (const key of candidates) {
 const score = scoreJobToCompanyName(jobNameKey, matchers.entries.get(key));
 if (score > bestScore) {
 bestScore = score;
 bestKey = key;
 }
 }
 return bestScore > 0 ? bestKey : '';
}

function resolveCompanyCountKey(job: JobListingLite, matchers: CompanyMatchers): string {
 const jobNameKey = normalizeTextKey(String(job.company || ''));
 if (jobNameKey) {
 const direct = matchers.byName.get(jobNameKey);
 if (direct) return direct;

 const bag = bagCompanyKey(jobNameKey);
 if (bag) {
 const bagCandidates = matchers.byBag.get(bag) || [];
 const picked = pickBestCompanyKey(jobNameKey, bagCandidates, matchers);
 if (picked) return picked;
 }
 }

 const resolvedHost = normalizeDomainHost(
 resolveCompanyWebsiteHost({
 company: job.company,
 companyKey: job.companyKey,
 companyDomain: job.companyDomain,
 url: job.url,
 })
 );
 if (!resolvedHost) return '';

 let hostCandidates = matchers.byHost.get(resolvedHost) || [];
 if (hostCandidates.length === 0) {
 for (const [hostKey, companyKeys] of matchers.byHost.entries()) {
 if (
 resolvedHost === hostKey ||
 resolvedHost.endsWith(`.${hostKey}`) ||
 hostKey.endsWith(`.${resolvedHost}`)
 ) {
 hostCandidates = companyKeys;
 break;
 }
 }
 }

 if (hostCandidates.length === 1) return hostCandidates[0];
 return pickBestCompanyKey(jobNameKey, hostCandidates, matchers);
}

const SECTOR_COLORS: Record<string, string> = {
 'Finanza & Banking': '#533afd',
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

const createCompanyIcon = (sector: string, employees: number, isHovered = false) => {
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
 box-shadow: ${isHovered ? `0 4px 16px rgba(0,0,0,0.5), 0 0 0 4px ${color}` : `0 2px 8px rgba(0,0,0,0.3), 0 0 0 2px ${color}30`};
 display: flex; align-items: center; justify-content: center;
 font-size: ${size > 36 ? 18 : 14}px;
 font-family: system-ui;
 transform: ${isHovered ? 'scale(1.25)' : 'scale(1)'};
 transition: transform 0.2s, box-shadow 0.2s;
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
 const [locale] = useLocale();
 const [searchQuery, setSearchQuery] = useState('');
 const [selectedSector, setSelectedSector] = useState('Tutti');
 const [sortBy, setSortBy] = useState<SortKey>('employees');
 const [sortDesc, setSortDesc] = useState(true);
 const [minEmployees, setMinEmployees] = useState(0);
 const [onlyWithPublishedJobs, setOnlyWithPublishedJobs] = useState(false);
 const [hoveredCompany, setHoveredCompany] = useState<string | null>(null);
 const [jobsByCompany, setJobsByCompany] = useState<Record<string, number>>({});
 const [jobsRouteSlugByCompany, setJobsRouteSlugByCompany] = useState<Record<string, string>>({});

 useEffect(() => {
 let cancelled = false;
 fetch(`/data/jobs-${locale}.json?fresh=${Date.now()}`, { cache: 'no-store' })
 .then((res) => {
 if (!res.ok) throw new Error(`${res.status}`);
 return res.json();
 })
 .catch(() => fetch(`/data/jobs.json?fresh=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()))
 .then((data: JobListingLite[]) => {
 if (cancelled || !Array.isArray(data)) return;
 const counts: Record<string, number> = {};
 const slugVotes: Record<string, Record<string, number>> = {};
 for (const job of data) {
 const key = resolveCompanyCountKey(job, COMPANY_MATCHERS);
 if (!key) continue;
 counts[key] = (counts[key] || 0) + 1;
 const slug = slugify(String(job.company || ''));
 if (slug) {
 if (!slugVotes[key]) slugVotes[key] = {};
 slugVotes[key][slug] = (slugVotes[key][slug] || 0) + 1;
 }
 }
 const routeSlugByCompany: Record<string, string> = {};
 for (const [key, votes] of Object.entries(slugVotes)) {
 const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
 if (best) routeSlugByCompany[key] = best;
 }
 setJobsByCompany(counts);
 setJobsRouteSlugByCompany(routeSlugByCompany);
 })
 .catch((e) => {
 reportCaughtError(e, 'ticinoCompanies.loadJobs');
 if (!cancelled) {
 setJobsByCompany({});
 setJobsRouteSlugByCompany({});
 }
 });
 return () => {
 cancelled = true;
 };
 }, []);

 const companyRoutePrefix = locale === 'en' ? 'company' : locale === 'de' ? 'unternehmen' : locale === 'fr' ? 'entreprise' : 'azienda';

 const companyJobsHref = (companyName: string) => {
 const base = buildPath({ activeTab: 'job-board' as any }, locale).replace(/\/$/, '');
 const companyKey = normalizeTextKey(companyName);
 const votedSlug = jobsRouteSlugByCompany[companyKey] || '';
 const targetSlug = canonicalCompanyRouteSlug(companyName, votedSlug);
 return `${base}/${companyRoutePrefix}-${targetSlug}`;
 };

 const companyJobsCount = (companyName: string) => jobsByCompany[normalizeTextKey(companyName)] || 0;

 useEffect(() => {
 if (typeof document === 'undefined') return;
 const organizations = allCompanies.map((company, index) => ({
 '@type': 'ListItem',
 position: index + 1,
 item: {
 '@type': 'Organization',
 name: company.name,
 url: company.website || undefined,
 description: company.description,
 address: {
 '@type': 'PostalAddress',
 addressLocality: company.city,
 addressRegion: 'TI',
 addressCountry: 'CH',
 },
 numberOfEmployees: {
 '@type': 'QuantitativeValue',
 value: company.employees,
 },
 },
 }));

 const ld = {
 '@context': 'https://schema.org',
 '@type': 'CollectionPage',
 name: t('companies.title', getCantonI18nParams()) || 'Aziende in Ticino',
 description:
 t('companies.subtitle') ||
 'Mappa interattiva delle principali società con filtri per settore e dimensione',
 inLanguage: document.documentElement.lang || 'it',
 url: `${window.location.origin}${window.location.pathname}`,
 mainEntity: {
 '@type': 'ItemList',
 numberOfItems: organizations.length,
 itemListElement: organizations,
 },
 };

 const scriptId = 'ticino-companies-structured-data';
 const old = document.getElementById(scriptId);
 if (old) old.remove();
 const script = document.createElement('script');
 script.type = 'application/ld+json';
 script.id = scriptId;
 script.text = JSON.stringify(ld);
 document.head.appendChild(script);

 return () => {
 const current = document.getElementById(scriptId);
 if (current) current.remove();
 };
 }, [t]);

 const filtered = useMemo(() => {
 let result = allCompanies.filter(c => {
 const matchSearch = !searchQuery || 
 c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
 c.city.toLowerCase().includes(searchQuery.toLowerCase()) ||
 c.sector.toLowerCase().includes(searchQuery.toLowerCase());
 const matchSector = selectedSector === 'Tutti' || c.sector === selectedSector;
 const matchEmployees = c.employees >= minEmployees;
 const matchPublishedJobs = !onlyWithPublishedJobs || companyJobsCount(c.name) > 0;
 return matchSearch && matchSector && matchEmployees && matchPublishedJobs;
 });

 result.sort((a, b) => {
 let cmp = 0;
 if (sortBy === 'employees') cmp = a.employees - b.employees;
 else if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
 else if (sortBy === 'city') cmp = a.city.localeCompare(b.city);
 return sortDesc ? -cmp : cmp;
 });

 return result;
 }, [searchQuery, selectedSector, sortBy, sortDesc, minEmployees, onlyWithPublishedJobs, jobsByCompany]);

 const totalEmployees = useMemo(() => filtered.reduce((sum, c) => sum + c.employees, 0), [filtered]);
 const mapCenter: [number, number] = [46.02, 8.96];

 return (
 <div className="space-y-6 animate-fade-in overflow-x-hidden">
 <style>{`
 .company-marker { background: none !important; border: none !important; }
 `}</style>

 {/* Header */}
 <div className="bg-info rounded-2xl sm:rounded-3xl p-4 sm:p-8 text-on-accent shadow-2xl">
 <div className="flex items-center gap-3 sm:gap-4 mb-4">
 <div className="p-2 sm:p-3 bg-on-accent/20 rounded-xl sm:rounded-2xl flex-shrink-0">
 <Building2 size={28} className="sm:w-8 sm:h-8" />
 </div>
 <div className="min-w-0">
 <h1 className="text-xl sm:text-3xl font-extrabold font-display">{t('companies.title', getCantonI18nParams()) || 'Aziende in Ticino'}</h1>
 <p className="text-info mt-1 text-sm sm:text-base">{t('companies.subtitle') || 'Mappa interattiva delle principali società con filtri per settore e dimensione'}</p>
 </div>
 </div>
 <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-on-accent mt-4">
 <div><span className="text-lg font-semibold">{filtered.length}</span> <span className="text-sm text-on-accent/80">{t('companies.totalCompanies') || 'Aziende'}</span></div>
 <div><span className="text-lg font-semibold">{totalEmployees.toLocaleString('it-IT')}</span> <span className="text-sm text-on-accent/80">{t('companies.totalEmployees') || 'Dipendenti'}</span></div>
 </div>
 </div>

 {/* Filters */}
 <div className="bg-surface rounded-xl p-3 sm:p-4 border border-edge space-y-3 overflow-hidden">
 <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 sm:gap-3">
 {/* Search */}
 <div className="relative flex-1 min-w-0 w-full sm:min-w-[200px]">
 <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
 <input
 type="text"
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 placeholder={t('companies.search') || 'Cerca azienda, città, settore...'}
 aria-label={t('companies.search') || 'Cerca azienda, città, settore'}
 className="w-full pl-10 pr-4 py-2 bg-surface-alt border border-edge rounded-lg text-base focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
 />
 </div>

 {/* Sector filter */}
 <div className="relative">
 <select
 value={selectedSector}
 onChange={(e) => setSelectedSector(e.target.value)}
 aria-label="Filtra per settore"
 className="appearance-none pl-3 pr-8 py-2 bg-surface-alt border border-edge rounded-lg text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer"
 >
 {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
 </select>
 <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
 </div>

 <button
 type="button"
 onClick={() => {
 const next = !onlyWithPublishedJobs;
 setOnlyWithPublishedJobs(next);
 Analytics.trackUIInteraction(
 'companies',
 'filters',
 'toggle_published_jobs',
 next ? 'on' : 'off'
 );
 }}
 className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-semibold transition-colors ${
 onlyWithPublishedJobs
 ? 'bg-accent-subtle border-accent-border text-accent'
 : 'bg-surface-alt border-edge text-subtle hover:bg-surface-raised'
 }`}
 aria-pressed={onlyWithPublishedJobs}
 aria-label={t('companies.filterPublishedJobs')}
 >
 <Briefcase size={14} />
 <span>{t('companies.filterPublishedJobs')}</span>
 </button>
 </div>

 {/* Employee filter + sort */}
 <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 sm:gap-3">
 <div className="flex items-center gap-2 text-sm">
 <Users size={14} className="text-muted flex-shrink-0" />
 <span className="text-subtle font-medium whitespace-nowrap text-xs sm:text-sm">{t('companies.minEmployees')}:</span>
 <input type="range" min={0} max={1000} step={50} value={minEmployees}
 onChange={(e) => setMinEmployees(Number(e.target.value))}
 aria-label={t('companies.minEmployees') || 'Dipendenti minimi'}
 className="w-full sm:w-32 accent-accent" />
 <span className="font-bold text-accent w-10">{minEmployees}</span>
 </div>
 <div className="flex items-center gap-2 sm:ml-auto">
 <ArrowUpDown size={14} className="text-muted" />
 <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}
 aria-label={t('companies.sortBy') || 'Ordina per'}
 className="appearance-none px-3 py-1.5 bg-surface-alt border border-edge rounded-lg text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
 <option value="employees">{t('companies.totalEmployees')}</option>
 <option value="name">{t('companies.sortName')}</option>
 <option value="city">{t('companies.sortCity')}</option>
 </select>
 <button onClick={() => setSortDesc(!sortDesc)} aria-label={sortDesc ? (t('companies.sortAscending') || 'Ordine crescente') : (t('companies.sortDescending') || 'Ordine decrescente')} className="min-w-[44px] min-h-[44px] p-2.5 rounded-lg bg-surface-raised text-subtle hover:bg-surface-raised transition-colors">
 {sortDesc ? '↓' : '↑'}
 </button>
 </div>
 </div>
 </div>

 {/* SIDE-BY-SIDE: List left, Map right (stacked on mobile) */}
 <div className="flex flex-col lg:flex-row gap-4 lg:gap-5">
 {/* LIST (left) */}
 <div className="w-full lg:w-[45%] xl:w-[40%] lg:max-h-[calc(100vh-120px)] lg:overflow-y-auto lg:overflow-x-hidden space-y-3 pr-0 lg:pr-1 scrollbar-thin">
 {filtered.length === 0 ? (
 <div className="text-center py-12 text-muted">
 <Building2 size={48} className="mx-auto mb-3 opacity-50" />
 <p className="font-bold">{t('companies.noResults')}</p>
 <p className="text-sm">{t('companies.tryModifyFilters')}</p>
 </div>
 ) : (
 filtered.map((company) => (
 <div
 key={company.name}
 className={`bg-surface rounded-xl border p-4 hover:shadow-md transition-[color,background-color,border-color,box-shadow] min-w-0 overflow-hidden cursor-pointer ${
 hoveredCompany === company.name
 ? 'border-accent-border shadow-md ring-2 ring-accent-border'
 : 'border-edge'
 }`}
 onMouseEnter={() => setHoveredCompany(company.name)}
 onMouseLeave={() => setHoveredCompany(null)}
 >
 <div className="flex items-start gap-3 mb-2">
 {company.website ? (
 <div className="w-9 h-9 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden flex-shrink-0 border border-edge">
 <ProviderLogo domain={companyDomain(company.website)} name={company.name} size={22} className="w-[22px] h-[22px] object-contain" />
 </div>
 ) : (
 <div className="text-xl flex-shrink-0">{SECTOR_ICONS[company.sector] || '🏢'}</div>
 )}
 <div className="flex-1 min-w-0">
 <h3 className="font-bold text-sm text-strong truncate">{company.name}</h3>
 <span className="text-xs font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${SECTOR_COLORS[company.sector]}15`, color: SECTOR_COLORS[company.sector] }}>
 {company.sector}
 </span>
 </div>
 </div>
 <p className="text-sm text-subtle mb-2 line-clamp-2">{company.description}</p>
 <div className="flex items-center justify-between text-xs">
 <div className="flex items-center gap-1 text-subtle">
 <Users size={12} />
 <span className="font-bold">{company.employees.toLocaleString('it-IT')}</span>
 </div>
 <div className="flex items-center gap-1 text-muted">
 <MapPin size={12} />
 <span>{company.city}</span>
 </div>
 {company.website && (
 <a href={company.website} target="_blank" rel="noopener noreferrer"
 className="flex items-center gap-1 text-accent hover:text-accent font-semibold no-underline">
 <Globe size={12} />
 <span className="hidden sm:inline">Web</span>
 </a>
 )}
 </div>
 {companyJobsCount(company.name) > 0 && (
 <a
 href={companyJobsHref(company.name)}
 className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-info-subtle to-success-subtle border border-info-border text-info text-xs font-bold hover:from-info-subtle hover:to-success-subtle transition-colors"
 onClick={() => Analytics.trackSelectContent('companies_open_jobs_by_company', company.name)}
 >
 <Briefcase size={12} />
 <span>
 {companyJobsCount(company.name) === 1
 ? t('companies.jobsPublishedSingle', { count: companyJobsCount(company.name) })
 : t('companies.jobsPublishedPlural', { count: companyJobsCount(company.name) })}
 </span>
 </a>
 )}
 </div>
 ))
 )}
 </div>

 {/* MAP (right) */}
 <div className="w-full lg:w-[55%] xl:w-[60%] lg:sticky lg:top-4 lg:self-start">
 <div className="rounded-2xl overflow-hidden border-2 border-edge shadow-lg" tabIndex={0} aria-label="Mappa aziende in Ticino">
 <MapContainer center={mapCenter} zoom={10} style={{ height: 'min(600px, 70vh)', width: '100%' }} scrollWheelZoom={true}>
 <TileLayer
 attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
 url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
 />
 {filtered.map((company) => (
 <Marker key={company.name} position={company.coordinates} icon={createCompanyIcon(company.sector, company.employees, hoveredCompany === company.name)}>
 <Popup maxWidth={300}>
 <div className="p-1">
 <div className="flex items-center gap-2 mb-2">
 {company.website ? (
 <ProviderLogo domain={companyDomain(company.website)} name={company.name} size={28} />
 ) : (
 <span className="text-2xl">{SECTOR_ICONS[company.sector] || '🏢'}</span>
 )}
 <div>
 <h3 className="font-bold text-base m-0 text-strong">{company.name}</h3>
 <span className="text-xs font-semibold" style={{ color: SECTOR_COLORS[company.sector] }}>{company.sector}</span>
 </div>
 </div>
 <p className="text-[13px] text-subtle mt-0 mb-2">{company.description}</p>
 <div className="flex flex-col gap-1 text-[13px]">
 <div className="flex justify-between">
 <span className="text-muted">{t('companies.totalEmployees')}</span>
 <span className="font-bold text-strong">{company.employees.toLocaleString('it-IT')}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('companies.sortCity')}</span>
 <span className="font-bold text-strong">{company.city}</span>
 </div>
 </div>
 {companyJobsCount(company.name) > 0 && (
 <a
 href={companyJobsHref(company.name)}
 onClick={() => Analytics.trackSelectContent('companies_map_open_jobs_by_company', company.name)}
 className="mt-2.5 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-accent-subtle border border-accent-border text-accent text-xs font-bold no-underline"
 >
 <Briefcase size={12} />
 <span>
 {companyJobsCount(company.name) === 1
 ? t('companies.jobsPublishedSingle', { count: companyJobsCount(company.name) })
 : t('companies.jobsPublishedPlural', { count: companyJobsCount(company.name) })}
 </span>
 </a>
 )}
 {company.website && (
 <a href={company.website} target="_blank" rel="noopener noreferrer"
 className="mt-3 flex items-center justify-center gap-1.5 w-full p-2 bg-accent text-on-accent rounded-lg text-[13px] font-bold no-underline hover:bg-accent-hover">
 {t('companies.visitWebsite')}
 </a>
 )}
 </div>
 </Popup>
 </Marker>
 ))}
 </MapContainer>

 {/* Legend */}
 <div className="flex items-center justify-center gap-2 py-2.5 bg-surface text-xs text-muted flex-wrap px-3">
 {Object.entries(SECTOR_ICONS).slice(0, 6).map(([sector, icon]) => (
 <button key={sector} onClick={() => setSelectedSector(sector === selectedSector ? 'Tutti' : sector)}
 className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors ${selectedSector === sector ? 'bg-accent-subtle text-accent font-bold' : 'hover:bg-surface-raised'}`}>
 <span>{icon}</span> {sector.split(' ')[0]}
 </button>
 ))}
 </div>
 </div>
 </div>
 </div>
 </div>
 );
};

export default TicinoCompanies;
