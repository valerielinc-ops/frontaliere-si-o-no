/**
 * Centralized border crossings data source.
 * Used by both TrafficAlerts and FrontierGuide components.
 * Source: Wikipedia + tabella valichi ufficiali Lombardia-Ticino 2026
 */

export interface WebcamRef {
 /** Localised display label, e.g. "A2 Chiasso-Brogeda direzione nord". */
 label: string;
 /** Direct URL to the JPEG/GIF frame (hotlink-friendly). */
 imageUrl: string;
 /** Human-readable source name for attribution, e.g. "Dipartimento del territorio – Canton Ticino". */
 sourceName: string;
 /** Public URL of the source page that hosts the webcam (attribution link). */
 sourceUrl: string;
 /** Refresh interval in ms — used by the inline JS cache-buster. Default 60_000. */
 refreshIntervalMs?: number;
 /** Optional explicit license note shown in <figcaption>. */
 license?: string;
 /**
  * Per-webcam override for the watchdog's MIN_WEBCAM_BYTES floor
  * (scripts/check-border-data-health.mjs). Some vendors legitimately serve a
  * much smaller real JPEG than the ~10KB Ticino-GIF default; without an
  * override the watchdog mis-flags them as broken (issue #3438).
  */
 minBytes?: number;
}

export interface BorderCrossing {
 name: string;
 italianSide: string;
 canton: string;
 province: string;
 lat: number;
 lng: number;
 type: 'autostrada' | 'statale' | 'locale';
 open24h: boolean;
 customsPresent: boolean;
 hours: string;
 avgWaitMorning: string;
 avgWaitEvening: string;
 trafficLevel: 'high' | 'medium' | 'low' | 'closed';
 peak: string;
 tips: string;
 /**
  * Whether BAZG (Swiss Federal Office of Customs and Border Security) publishes
  * authoritative waiting-time data for this crossing. When true, the traffic
  * scheduler should prefer BAZG over TomTom/Google derived estimates.
  * NOTE: BAZG public JSON endpoint not discoverable as of 2026-04; flag is
  * future-proofing and currently has no runtime effect (cascade not wired).
  */
 bazgCoverage?: boolean;
 /**
  * Hotlinkable public webcams covering the crossing. Source: Dipartimento del
  * territorio, Canton Ticino (https://www.ti.ch/webcam) — GIF snapshots
  * refreshed ~every 60s, Cache-Control: max-age=60. Verified hotlink-friendly
  * (200 OK with no Referer or cookies).
  */
 webcams?: WebcamRef[];
}

/**
 * Shared metadata for the Ticino Cantonal webcam feeds.
 * All feeds live under `https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/`.
 */
const TI_POLCA_SOURCE_NAME = 'Dipartimento del territorio – Canton Ticino';
const TI_POLCA_SOURCE_URL = 'https://www.ti.ch/webcam';

export const borderCrossings: BorderCrossing[] = [
 // COMO - TICINO
 {
 name: 'Chiasso Centro (Ponte Chiasso)',
 italianSide: 'Como',
 canton: 'TI',
 province: 'CO',
 lat: 45.8326,
 lng: 9.0340,
 type: 'statale',
 open24h: true,
 customsPresent: true,
 hours: '24h',
 avgWaitMorning: '15-30 min',
 avgWaitEvening: '20-40 min',
 trafficLevel: 'high',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.chiassoCentro',
 webcams: [
  {
   label: 'A2 – Chiasso via Como (direzione sud)',
   imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/01.2S.gif',
   sourceName: TI_POLCA_SOURCE_NAME,
   sourceUrl: TI_POLCA_SOURCE_URL,
   refreshIntervalMs: 60000,
  },
 ],
 },
 {
 name: 'Chiasso-Brogeda',
 italianSide: 'Como',
 canton: 'TI',
 province: 'CO',
 lat: 45.8409,
 lng: 9.0376,
 type: 'autostrada',
 open24h: true,
 customsPresent: true,
 hours: '24h',
 avgWaitMorning: '8-15 min',
 avgWaitEvening: '12-25 min',
 trafficLevel: 'medium',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.chiassoBrogeda',
 bazgCoverage: true,
 webcams: [
 {
 label: 'A2 – Balerna (corridoio Chiasso-Mendrisio) direzione sud',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/03.3S.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 {
 label: 'A2 – Coldrerio (corridoio Chiasso-Mendrisio) direzione nord',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/04.4N.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 ],
 },
 {
 name: 'Chiasso-Strada',
 italianSide: 'Como',
 canton: 'TI',
 province: 'CO',
 lat: 45.8332,
 lng: 9.0374,
 type: 'statale',
 open24h: true,
 customsPresent: true,
 hours: '24h',
 avgWaitMorning: '10-18 min',
 avgWaitEvening: '15-25 min',
 trafficLevel: 'medium',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.chiassoStrada',
 webcams: [
  {
   label: 'A2 – Chiasso via Como (direzione sud)',
   imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/01.2S.gif',
   sourceName: TI_POLCA_SOURCE_NAME,
   sourceUrl: TI_POLCA_SOURCE_URL,
   refreshIntervalMs: 60000,
  },
 ],
 },
 {
 name: 'Maslianico-Pizzamiglio',
 italianSide: 'Maslianico',
 canton: 'TI',
 province: 'CO',
 lat: 45.8438,
 lng: 9.0386,
 type: 'locale',
 open24h: false,
 customsPresent: false,
 hours: '06:00-22:00',
 avgWaitMorning: '3-8 min',
 avgWaitEvening: '5-12 min',
 trafficLevel: 'low',
 peak: '7:30-8:30, 17:30-18:30',
 tips: 'border.tips.maslianicoPizzamiglio',
 },
 {
 name: 'Maslianico-Roggiana',
 italianSide: 'Maslianico',
 canton: 'TI',
 province: 'CO',
 lat: 45.8476,
 lng: 9.0446,
 type: 'locale',
 open24h: false,
 customsPresent: false,
 hours: 'border.hours.closed',
 avgWaitMorning: '---',
 avgWaitEvening: '---',
 trafficLevel: 'closed',
 peak: '---',
 tips: 'border.tips.maslianicoRoggiana',
 },
 {
 name: 'Bizzarone-Novazzano',
 italianSide: 'Bizzarone',
 canton: 'TI',
 province: 'CO',
 lat: 45.8401,
 lng: 8.9593,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '5-12 min',
 avgWaitEvening: '8-15 min',
 trafficLevel: 'low',
 peak: '7:30-8:30, 17:30-18:30',
 tips: 'border.tips.bizzaroneNovazzano',
 },
 {
 name: 'Ronago-Novazzano',
 italianSide: 'Ronago',
 canton: 'TI',
 province: 'CO',
 lat: 45.8362,
 lng: 8.9830,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '5-12 min',
 avgWaitEvening: '10-18 min',
 trafficLevel: 'low',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.ronagoNovazzano',
 },
 {
 name: 'Crociale dei Mulini',
 italianSide: 'Faloppio',
 canton: 'TI',
 province: 'CO',
 lat: 45.8340,
 lng: 8.9939,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '3-8 min',
 avgWaitEvening: '5-10 min',
 trafficLevel: 'low',
 peak: '7:30-8:30',
 tips: 'border.tips.crociale',
 },
 {
 name: 'Drezzo-Pedrinate',
 italianSide: 'Drezzo',
 canton: 'TI',
 province: 'CO',
 lat: 45.8206,
 lng: 9.0031,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-8 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.drezzoPedrinate',
 },
 {
 name: "Lanzo d'Intelvi-Arogno",
 italianSide: "Lanzo d'Intelvi",
 canton: 'TI',
 province: 'CO',
 lat: 45.9624,
 lng: 9.0091,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-8 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.lanzoArogno',
 webcams: [
 {
 // SkylineWebcams retired the hotlinkable snapshot endpoint (live5540.jpg
 // now returns a 200 with a static "404 Not Found" HTML stub cached since
 // 2021 — genuinely dead, not a monitor false-positive; verified 2026-07-05,
 // issue #3438). Replaced with the same underlying camera (id 5540) served
 // directly by its originating vendor, visioray — already trusted elsewhere
 // in this file for Zenna-Dirinella (same low-res JPEG class, see minBytes).
 label: "Lago di Lugano – vista da Lanzo d'Intelvi",
 imageUrl: 'https://weather-cams.visioray.com/snap/5540.jpg',
 sourceName: "Webcam Lago di Lugano – Lanzo d'Intelvi",
 sourceUrl: 'https://www.ilmeteo.it/webcam/Lanzo+d%27Intelvi',
 refreshIntervalMs: 300000,
 // Night/dusk frames from this camera compress below 4KB (watchdog read
 // 3763 bytes at 21:56 local on 2026-07-09 and flagged it broken — issue
 // #3877 — while daytime frames are ~6KB and the feed was alive the whole
 // time). Same low-light JPEG class as the Arzo thumbnail (issue #3438):
 // floor low enough for a dark-but-real frame, still above stub/error size.
 minBytes: 1500,
 },
 ],
 },
 {
 name: "Campione d'Italia-Bissone",
 italianSide: 'Campione (enclave)',
 canton: 'TI',
 province: 'CO',
 lat: 45.9618,
 lng: 8.9686,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-8 min',
 trafficLevel: 'low',
 peak: 'border.peak.alwaysCalm',
 tips: 'border.tips.campioneBissone',
 webcams: [
 {
 label: 'A2 – Melide-Bissone (ponte-diga) direzione sud',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/17.84S.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 {
 label: 'A2 – Maroggia (riva lago, corridoio Lugano-Chiasso) direzione sud',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/14.6S.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 ],
 },
 {
 name: 'Oria-Gandria',
 italianSide: 'Valsolda',
 canton: 'TI',
 province: 'CO',
 lat: 46.0168,
 lng: 9.0223,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-6 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.oriaGandria',
 bazgCoverage: true,
 webcams: [
 {
 label: 'Lago di Lugano – Gandria/Oria (Società Canottieri Ceresio)',
 imageUrl: 'https://www.scceresio.ch/webcam_files/image.jpg',
 sourceName: 'Società Canottieri Ceresio – Gandria-Castagnola',
 sourceUrl: 'https://www.scceresio.ch/webcam/',
 refreshIntervalMs: 60000,
 },
 ],
 },
 // VARESE - TICINO
 {
 name: 'Gaggiolo (Cantello-Stabio)',
 italianSide: 'Cantello',
 canton: 'TI',
 province: 'VA',
 lat: 45.8411,
 lng: 8.9134,
 type: 'statale',
 open24h: true,
 customsPresent: true,
 hours: '24h',
 avgWaitMorning: '10-20 min',
 avgWaitEvening: '15-30 min',
 trafficLevel: 'high',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.gaggiolo',
 bazgCoverage: true,
 webcams: [
 {
 label: 'A24 – Stabio direzione nord',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/02.0N.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 {
 label: 'A2 – Mendrisio-Stabio direzione sud',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/06.8S.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 // NOTE: 'A2 – Mendrisio (uscita Stabio) direzione nord' (07.2N.gif) was
 // removed 2026-07-03 (issue #3372) — upstream www4.ti.ch feed returns a
 // confirmed HTTP 404 (checked from multiple vantage points, with and
 // without cookies/Referer; not a transient cloud-IP block — still listed
 // on the ti.ch webcam gallery page but the underlying image is gone). No
 // replacement feed exists at this exact vantage point; 02.0N.gif and
 // 06.8S.gif above still cover this crossing.
 ],
 },
 {
 name: 'San Pietro (Clivio-Stabio)',
 italianSide: 'Clivio',
 canton: 'TI',
 province: 'VA',
 lat: 45.8595,
 lng: 8.9321,
 type: 'statale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '5-12 min',
 avgWaitEvening: '8-18 min',
 trafficLevel: 'medium',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.sanPietro',
 webcams: [
 {
 label: 'A24 – Stabio direzione nord',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/02.0N.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 {
 label: 'A2 – Mendrisio-Stabio direzione sud',
 imageUrl: 'https://www4.ti.ch/fileadmin/DT/temi/webcams/wct_immagini/06.8S.gif',
 sourceName: TI_POLCA_SOURCE_NAME,
 sourceUrl: TI_POLCA_SOURCE_URL,
 refreshIntervalMs: 60000,
 },
 ],
 },
 {
 name: 'Clivio-Ligornetto',
 italianSide: 'Clivio',
 canton: 'TI',
 province: 'VA',
 lat: 45.8638,
 lng: 8.9395,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '4-10 min',
 avgWaitEvening: '6-15 min',
 trafficLevel: 'low',
 peak: '7:30-8:30, 17:30-18:30',
 tips: 'border.tips.clivioLigornetto',
 },
 {
 name: 'Rodero-Stabio',
 italianSide: 'Rodero',
 canton: 'TI',
 province: 'VA',
 lat: 45.8334,
 lng: 8.9262,
 type: 'locale',
 open24h: false,
 customsPresent: false,
 hours: 'border.hours.pedestrianOnly',
 avgWaitMorning: '---',
 avgWaitEvening: '---',
 trafficLevel: 'closed',
 peak: '---',
 tips: 'border.tips.roderoStabio',
 webcams: [
 {
 label: 'Stabio – ROTOFIL fabrics SA (webcam meteo)',
 imageUrl: 'https://images-webcams.windy.com/80/1307708880/current/original/1307708880.jpg',
 sourceName: 'ROTOFIL fabrics SA',
 sourceUrl: 'https://rotofil.com/index.php/32/Webcam',
 refreshIntervalMs: 300000,
 },
 ],
 },
 {
 name: 'Saltrio-Arzo',
 italianSide: 'Saltrio',
 canton: 'TI',
 province: 'VA',
 lat: 45.8740,
 lng: 8.9336,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '3-8 min',
 avgWaitEvening: '5-12 min',
 trafficLevel: 'low',
 peak: '7:30-8:30',
 tips: 'border.tips.saltrioArzo',
 webcams: [
 {
 label: 'Arzo – Cappella San Carlo (webcam meteo)',
 imageUrl: 'https://www.webcam-4insiders.com/current/thumbnail/10557.jpg',
 sourceName: '4Insiders Weather Webcam',
 sourceUrl: 'https://www.4insiders.webcam/webcam/arzo/10557',
 refreshIntervalMs: 300000,
 // Vendor serves a real ~2.6-3.7KB JPEG thumbnail (verified 2026-07-05,
 // issue #3438) — below the ~10KB Ticino-GIF default floor.
 minBytes: 1500,
 },
 ],
 },
 {
 name: 'Ponte Tresa',
 italianSide: 'Lavena Ponte Tresa',
 canton: 'TI',
 province: 'VA',
 lat: 45.9670,
 lng: 8.8589,
 type: 'statale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '5-15 min',
 avgWaitEvening: '10-20 min',
 trafficLevel: 'medium',
 peak: '7:30-8:30, 17:30-18:30',
 tips: 'border.tips.ponteTresa',
 },
 {
 name: 'Porto Ceresio-Brusino',
 italianSide: 'Porto Ceresio',
 canton: 'TI',
 province: 'VA',
 lat: 45.9135,
 lng: 8.9042,
 type: 'locale',
 open24h: false,
 customsPresent: false,
 hours: '06:00-22:00',
 avgWaitMorning: '3-8 min',
 avgWaitEvening: '5-12 min',
 trafficLevel: 'low',
 peak: '7:30-8:30, 17:30-18:30',
 tips: 'border.tips.portoCeresioBrusino',
 },
 {
 name: 'Cremenaga-Ponte Cremenaga',
 italianSide: 'Cremenaga',
 canton: 'TI',
 province: 'VA',
 lat: 45.9907,
 lng: 8.8075,
 type: 'locale',
 open24h: false,
 customsPresent: false,
 hours: '06:00-20:00',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-8 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.cremenaga',
 },
 {
 name: 'Luino-Fornasette',
 italianSide: 'Luino',
 canton: 'TI',
 province: 'VA',
 lat: 45.9931,
 lng: 8.7878,
 type: 'statale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '4-10 min',
 avgWaitEvening: '6-15 min',
 trafficLevel: 'medium',
 peak: '7:30-8:30',
 tips: 'border.tips.luinoFornasette',
 webcams: [
 {
 label: 'Lago Maggiore – Cannero Riviera (sponda lombarda, area Luino)',
 imageUrl: 'https://lagomaggiorexperience.it/webcam/public/canneroriviera.jpg',
 sourceName: 'Lago Maggiore Experience',
 sourceUrl: 'https://lagomaggiorexperience.it/webcam/',
 refreshIntervalMs: 300000,
 },
 ],
 },
 {
 name: 'Zenna-Dirinella',
 italianSide: 'Zenna',
 canton: 'TI',
 province: 'VA',
 lat: 46.1040,
 lng: 8.7579,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-8 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.zennaDirinella',
 webcams: [
 {
 label: 'Maccagno con Pino e Veddasca – Lago Maggiore (stessa sponda di Zenna)',
 imageUrl: 'https://weather-cams.visioray.com/snap/3590.jpg',
 sourceName: 'Webcam Maccagno – Lago Maggiore',
 sourceUrl: 'https://www.ilmeteo.it/webcam/Maccagno',
 refreshIntervalMs: 300000,
 // Vendor serves a real ~6.6-8.9KB JPEG by day (verified 2026-07-05, issue
 // #3438) — below the ~10KB Ticino-GIF default floor. Same visioray camera
 // class as Lanzo d'Intelvi (snap/5540), whose night frames compressed to
 // ~3.7KB and tripped the 4KB floor (issue #3877 false-positive): use the
 // same dark-frame-safe floor for the whole class.
 minBytes: 1500,
 },
 ],
 },
 {
 name: 'Biegno-Indemini',
 italianSide: 'Curiglia con Monteviasco',
 canton: 'TI',
 province: 'VA',
 lat: 46.0955,
 lng: 8.8164,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-6 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.biegnoIndemini',
 webcams: [
 {
 label: 'Indemini – panorama verso Alpe Sciaga / Monte Tamaro',
 imageUrl: 'https://lunasole.ch/webcam/latest.jpg',
 sourceName: 'Webcam Indemini (lunasole.ch)',
 sourceUrl: 'https://lunasole.ch/webcam/',
 refreshIntervalMs: 60000,
 },
 ],
 },
 {
 name: 'Dumenza-Cassinone',
 italianSide: 'Dumenza',
 canton: 'TI',
 province: 'VA',
 lat: 46.0052,
 lng: 8.7921,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-6 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.dumenzaCassinone',
 webcams: [
 {
 label: 'Dumenza – webcam comunale',
 imageUrl: 'https://webcam.comune.dumenza.va.it/download.php?file=dumenza.jpg',
 sourceName: 'Comune di Dumenza',
 sourceUrl: 'https://webcam.comune.dumenza.va.it/',
 refreshIntervalMs: 300000,
 },
 ],
 },
 // VERBANIA - TICINO / VS
 {
 name: 'Piaggio Valmara (Cannobio-Brissago)',
 italianSide: 'Cannobio',
 canton: 'TI',
 province: 'VB',
 lat: 46.0905,
 lng: 8.7240,
 type: 'statale',
 open24h: true,
 customsPresent: true,
 hours: '24h',
 avgWaitMorning: '3-8 min',
 avgWaitEvening: '5-12 min',
 trafficLevel: 'low',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.piaggioValmara',
 webcams: [
 {
 label: 'Lago Maggiore – Cannobio Piazza Lago (verso Brissago)',
 imageUrl: 'https://comune.cannobio.vb.it/wp-content/themes/design-comuni-wordpress-theme-main-child/assets/img/webcam_piazzalago.webp',
 sourceName: 'Comune di Cannobio',
 sourceUrl: 'https://www.comune.cannobio.vb.it/webcam.asp',
 refreshIntervalMs: 60000,
 },
 ],
 },
 {
 name: 'Camedo (Re-Centovalli)',
 italianSide: 'Re (Olgia)',
 canton: 'TI',
 province: 'VB',
 lat: 46.1592,
 lng: 8.6312,
 type: 'locale',
 open24h: true,
 customsPresent: false,
 hours: '24h',
 avgWaitMorning: '2-5 min',
 avgWaitEvening: '3-8 min',
 trafficLevel: 'low',
 peak: 'border.peak.lowTraffic',
 tips: 'border.tips.camedoRe',
 webcams: [
 {
 label: 'Val Vigezzo – Santa Maria Maggiore (vallata italiana del valico)',
 imageUrl: 'https://webcamdtl.it/santamariamaggiore.jpg',
 sourceName: 'Distretto Turistico dei Laghi (webcamdtl.it)',
 sourceUrl: 'https://www.distrettolaghi.it/it/webcam',
 refreshIntervalMs: 300000,
 },
 {
 label: 'Val Vigezzo – Piana di Vigezzo',
 imageUrl: 'https://webcamdtl.it/pianavigezzo.jpg',
 sourceName: 'Distretto Turistico dei Laghi (webcamdtl.it)',
 sourceUrl: 'https://www.distrettolaghi.it/it/webcam',
 refreshIntervalMs: 300000,
 },
 ],
 },
 {
 name: 'Sempione (Iselle-Gondo)',
 italianSide: 'Trasquera (Iselle)',
 canton: 'VS',
 province: 'VB',
 lat: 46.2422,
 lng: 8.1430,
 type: 'statale',
 open24h: true,
 customsPresent: true,
 hours: '24h',
 avgWaitMorning: '5-12 min',
 avgWaitEvening: '8-15 min',
 trafficLevel: 'medium',
 peak: '7:00-8:30, 17:00-18:30',
 tips: 'border.tips.sempioneIselle',
 bazgCoverage: true,
 webcams: [
 {
 label: 'Simplon Dorf – villaggio (passo del Sempione)',
 imageUrl: 'https://gemeinde-simplon.ch/webcam/webcam/2.jpg',
 sourceName: 'Gemeinde Simplon Dorf',
 sourceUrl: 'https://gemeinde-simplon.ch/webcams/',
 refreshIntervalMs: 60000,
 },
 {
 label: 'Simplon Dorf – vista valle verso il passo',
 imageUrl: 'https://gemeinde-simplon.ch/webcam/webcam/3.jpg',
 sourceName: 'Gemeinde Simplon Dorf',
 sourceUrl: 'https://gemeinde-simplon.ch/webcams/',
 refreshIntervalMs: 60000,
 },
 ],
 },
];

// ── Computed averages overlay ────────────────────────────────────
//
// `data/border-wait-averages.json` is regenerated daily by
// `scripts/compute-border-wait-averages.mjs` from the rolling 30-day
// history aggregates. The numbers are TOTAL minutes (approach delay +
// checkpoint queue), matching the live "Ora" card metric.
//
// Editorial defaults above stay as fallback for crossings with no history
// yet, and as a sane baseline before the first compute run lands in
// `data/`.
import computedAverages from './border-wait-averages.json';

function slugifyName(name: string): string {
 return name
 .normalize('NFKD')
 .replace(/[̀-ͯ]/g, '')
 .replace(/\([^)]*\)/g, '')
 .replace(/[^a-zA-Z0-9]+/g, '-')
 .replace(/-+/g, '-')
 .replace(/^-|-$/g, '')
 .toLowerCase();
}

const computed = computedAverages as Record<string, { morning?: string; evening?: string }>;
for (const c of borderCrossings) {
 const slug = slugifyName(c.name);
 const entry = computed[slug];
 if (!entry) continue;
 if (entry.morning) c.avgWaitMorning = entry.morning;
 if (entry.evening) c.avgWaitEvening = entry.evening;
}

