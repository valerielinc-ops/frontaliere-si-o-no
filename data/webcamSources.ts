/**
 * Registry of official/third-party entities that operate the webcam feeds
 * referenced by `sourceUrl` in `data/borderCrossings.ts`. One entry per
 * distinct `sourceUrl` currently in use — see tests/webcamSources.test.ts
 * for the by-construction coverage check.
 */

export type WebcamAccessMethod = 'hotlink';

export type WebcamSourceStatus = 'active' | 'inactive';

export interface WebcamSource {
 /** Stable kebab-case identifier, not shown in UI. */
 id: string;
 /** Human-readable name of the entity operating the webcam(s). */
 entityName: string;
 /** Public page hosting the webcam(s) — matches a `sourceUrl` in borderCrossings.ts. */
 officialUrl: string;
 /** How the image is retrieved. All current sources are hotlinked JPEG/GIF frames. */
 accessMethod: WebcamAccessMethod;
 /** ISO date (YYYY-MM-DD) terms/license were last reviewed by a human. Unset = not yet reviewed. */
 termsReviewedAt?: string;
 /** License/usage note, when documented by the source. Unset = not documented. */
 license?: string;
 /** Whether the source is currently referenced by an active borderCrossings webcam entry. */
 status: WebcamSourceStatus;
}

export const WEBCAM_SOURCES: WebcamSource[] = [
 {
  id: 'ti-dipartimento-territorio',
  entityName: 'Dipartimento del territorio – Canton Ticino',
  officialUrl: 'https://www.ti.ch/webcam',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'ilmeteo-lanzo-intelvi',
  entityName: "Webcam Lago di Lugano – Lanzo d'Intelvi",
  officialUrl: 'https://www.ilmeteo.it/webcam/Lanzo+d%27Intelvi',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'scceresio-gandria-castagnola',
  entityName: 'Società Canottieri Ceresio – Gandria-Castagnola',
  officialUrl: 'https://www.scceresio.ch/webcam/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'rotofil-sa',
  entityName: 'ROTOFIL fabrics SA',
  officialUrl: 'https://rotofil.com/index.php/32/Webcam',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: '4insiders-arzo',
  entityName: '4Insiders Weather Webcam',
  officialUrl: 'https://www.4insiders.webcam/webcam/arzo/10557',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'lago-maggiore-experience',
  entityName: 'Lago Maggiore Experience',
  officialUrl: 'https://lagomaggiorexperience.it/webcam/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'ilmeteo-maccagno',
  entityName: 'Webcam Maccagno – Lago Maggiore',
  officialUrl: 'https://www.ilmeteo.it/webcam/Maccagno',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'lunasole-indemini',
  entityName: 'Webcam Indemini (lunasole.ch)',
  officialUrl: 'https://lunasole.ch/webcam/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'comune-dumenza',
  entityName: 'Comune di Dumenza',
  officialUrl: 'https://webcam.comune.dumenza.va.it/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'comune-cannobio',
  entityName: 'Comune di Cannobio',
  officialUrl: 'https://www.comune.cannobio.vb.it/webcam.asp',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'distretto-turistico-laghi',
  entityName: 'Distretto Turistico dei Laghi (webcamdtl.it)',
  officialUrl: 'https://www.distrettolaghi.it/it/webcam',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'gemeinde-simplon',
  entityName: 'Gemeinde Simplon Dorf',
  officialUrl: 'https://gemeinde-simplon.ch/webcams/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'panomax-montespluga',
  entityName: 'Panomax – Dogana di Montespluga',
  officialUrl: 'https://montespluga.panomax.com/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'alpenrose-umbrail',
  entityName: 'Hotel Alpenrose – Umbrail (Val Müstair)',
  officialUrl: 'https://alpenrose-umbrail.ch/',
  accessMethod: 'hotlink',
  status: 'active',
 },
 {
  id: 'letunnel-gran-san-bernardo',
  entityName: 'Le Tunnel – operatore Traforo del Gran San Bernardo',
  officialUrl: 'https://letunnel.com/en/meteo/webcam/',
  accessMethod: 'hotlink',
  status: 'active',
 },
];
