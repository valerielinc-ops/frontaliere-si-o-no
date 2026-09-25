export type DialectCategory = 'saluti' | 'espressioni' | 'proverbi' | 'cibo' | 'lavoro' | 'natura';

export interface DialectEntry {
 key: string;
 category: DialectCategory;
}

// Sources used for newly added phrases:
// - Vocabolario dei dialetti della Svizzera italiana (VSI): https://www4.ti.ch/decs/dcsu/ac/vsi
// - Corriere del Ticino (uso comune di espressioni ticinesi): https://www.cdt.ch/societa/
export const DIALECT_ENTRIES: DialectEntry[] = [
 { key: 'ciau', category: 'saluti' },
 { key: 'bundi', category: 'saluti' },
 { key: 'bunaSira', category: 'saluti' },
 { key: 'comeTeStee', category: 'saluti' },
 { key: 'ades', category: 'saluti' },
 { key: 'staBen', category: 'saluti' },
 { key: 'grassie', category: 'saluti' },
 { key: 'scüsa', category: 'saluti' },
 { key: 'aDoman', category: 'saluti' },
 { key: 'bunDi', category: 'saluti' },

 { key: 'mingaMal', category: 'espressioni' },
 { key: 'lassaSta', category: 'espressioni' },
 { key: 'faNagot', category: 'espressioni' },
 { key: 'propriInscì', category: 'espressioni' },
 { key: 'daiMò', category: 'espressioni' },
 { key: 'vaLa', category: 'espressioni' },
 { key: 'cheScossera', category: 'espressioni' },
 { key: 'semperInGir', category: 'espressioni' },
 { key: 'lèGnanca', category: 'espressioni' },
 { key: 'mangiaPolenta', category: 'espressioni' },
 { key: 'tacatAlTram', category: 'espressioni' },
 { key: 'sbassaLaCresta', category: 'espressioni' },
 { key: 'capiNaMazza', category: 'espressioni' },
 { key: 'süDaCo', category: 'espressioni' },

 { key: 'chiVaPian', category: 'proverbi' },
 { key: 'leMingaTutt', category: 'proverbi' },
 { key: 'meiTard', category: 'proverbi' },
 { key: 'acquaInBocca', category: 'proverbi' },
 { key: 'gallinaCanta', category: 'proverbi' },
 { key: 'chiDormPesca', category: 'proverbi' },
 { key: 'tantVaTanin', category: 'proverbi' },
 { key: 'mogaPian', category: 'proverbi' },
 { key: 'laFameLaBrüta', category: 'proverbi' },
 { key: 'chiGaTrop', category: 'proverbi' },

 { key: 'paniscia', category: 'cibo' },
 { key: 'luganighetta', category: 'cibo' },
 { key: 'merlüsc', category: 'cibo' },
 { key: 'tortaDaPan', category: 'cibo' },
 { key: 'polentaBrüsca', category: 'cibo' },
 { key: 'minestrun', category: 'cibo' },
 { key: 'gazzösa', category: 'cibo' },
 { key: 'cicitt', category: 'cibo' },
 { key: 'formaggella', category: 'cibo' },
 { key: 'brasàa', category: 'cibo' },

 { key: 'laorà', category: 'lavoro' },
 { key: 'elPatron', category: 'lavoro' },
 { key: 'laBòtega', category: 'lavoro' },
 { key: 'elMes', category: 'lavoro' },
 { key: 'truàSü', category: 'lavoro' },
 { key: 'laFabrica', category: 'lavoro' },
 { key: 'faSüLeOr', category: 'lavoro' },
 { key: 'elPaga', category: 'lavoro' },
 { key: 'laDesDüra', category: 'lavoro' },
 { key: 'andàACà', category: 'lavoro' },

 { key: 'tiraGiò', category: 'natura' },
 { key: 'elLac', category: 'natura' },
 { key: 'laMuntagna', category: 'natura' },
 { key: 'faFreed', category: 'natura' },
 { key: 'nebiun', category: 'natura' },
 { key: 'tiraVent', category: 'natura' },
 { key: 'elBòsch', category: 'natura' },
 { key: 'laPiòva', category: 'natura' },
 { key: 'laSulana', category: 'natura' },
 { key: 'elFium', category: 'natura' },
];

const EPOCH = new Date('2025-01-06').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

export function getDialectPhraseOfDay(now: number = Date.now()): DialectEntry {
 const dayIndex = Math.floor((now - EPOCH) / DAY_MS) % DIALECT_ENTRIES.length;
 return DIALECT_ENTRIES[(dayIndex + DIALECT_ENTRIES.length) % DIALECT_ENTRIES.length];
}
