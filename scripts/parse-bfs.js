const fs = require('fs');
const path = require('path');

// CONFIG
const INPUT_FILE = 'px-x-0302010000_108.px';
const OUTPUT_FILE = 'frontalieri-ticino.json';
const TARGET_CANTON_CODE = '21'; // Ticino

try {
  const filePath = path.join(__dirname, '..', INPUT_FILE);
  
  // BFS files are often encoded in ISO-8859-1 (latin1)
  const rawData = fs.readFileSync(filePath, 'latin1');

  console.log(`📂 Letto file: ${INPUT_FILE}`);

  // --- 1. PARSING HELPER FUNCTIONS ---
  
  // Estrae i valori di una chiave specifica VALUES("Key")
  const getValues = (key) => {
    // Regex per trovare VALUES("KEY")="Val1","Val2",...;
    // Gestisce multilinee e spazi
    const regex = new RegExp(`VALUES\\("${key}"\\)=([^;]+);`);
    const match = rawData.match(regex);
    if (!match) {
        // Fallback per chiavi senza quote nel nome (es. VALUES(Quartal))
        const regexAlt = new RegExp(`VALUES\\(${key}\\)=([^;]+);`);
        const matchAlt = rawData.match(regexAlt);
        if(!matchAlt) return [];
        return cleanList(matchAlt[1]);
    }
    return cleanList(match[1]);
  };

  const cleanList = (str) => {
    return str
      .replace(/\r\n/g, '') // Rimuove newline Windows
      .replace(/\n/g, '')   // Rimuove newline Unix
      .replace(/"/g, '')    // Rimuove virgolette
      .split(',')           // Divide per virgola
      .map(s => s.trim());  // Rimuove spazi extra
  };

  // --- 2. EXTRACT DIMENSIONS ---
  
  // Ordine tipico BFS: Arbeitskanton, Geschlecht, Wirtschaftssektor, Altersklasse, Quartal
  // Dobbiamo verificare l'ordine nell'header STUB e HEADING se volessimo essere generici al 100%,
  // ma per questo dataset specifico la struttura è standard.
  
  const cantons = getValues("Kanton Arbeitsort") || getValues("Arbeitskanton");
  const sexes = getValues("Geschlecht");
  const sectors = getValues("Wirtschaftssektor");
  const ages = getValues("Altersklasse");
  const quarters = getValues("Quartal"); // es. "2020Q1", "2020Q2"...

  console.log(`📊 Dimensioni rilevate:`);
  console.log(`   - Cantoni: ${cantons.length}`);
  console.log(`   - Sesso: ${sexes.length}`);
  console.log(`   - Settori: ${sectors.length}`);
  console.log(`   - Età: ${ages.length}`);
  console.log(`   - Trimestri: ${quarters.length}`);

  // --- 3. LOCATE DATA ---

  // Troviamo l'indice del Ticino
  const ticinoIndex = cantons.indexOf(TARGET_CANTON_CODE);
  if (ticinoIndex === -1) throw new Error(`Cantone ${TARGET_CANTON_CODE} non trovato nel file.`);

  // Calcolo dello "Stride" (Passo)
  // Il file è un array piatto. La gerarchia è l'ordine delle dimensioni.
  // Struttura appiattita: Canton -> Sex -> Sector -> Age -> Quarter
  
  const blockSizeQuarter = 1;
  const blockSizeAge = quarters.length * blockSizeQuarter;
  const blockSizeSector = ages.length * blockSizeAge;
  const blockSizeSex = sectors.length * blockSizeSector;
  const blockSizeCanton = sexes.length * blockSizeSex;

  // Vogliamo: Canton=TI(21), Sex=Total(0), Sector=Total(0), Age=Total(0)
  // Assumiamo che "0" (Totale) sia sempre il primo elemento (indice 0) negli array VALUES.
  // BFS standard: Totale è sempre prima delle sottocategorie.
  
  const targetSexIndex = 0;    // Totale
  const targetSectorIndex = 0; // Totale
  const targetAgeIndex = 0;    // Totale

  // Calcolo Indice di Partenza nell'array DATA
  const startIndex = 
    (ticinoIndex * blockSizeCanton) +
    (targetSexIndex * blockSizeSex) +
    (targetSectorIndex * blockSizeSector) +
    (targetAgeIndex * blockSizeAge);

  // --- 4. EXTRACT VALUES ---

  // Estraiamo il blocco DATA=...;
  const dataBlockMatch = rawData.match(/DATA=([^;]+);/);
  if (!dataBlockMatch) throw new Error("Blocco DATA non trovato.");

  // Pulizia e conversione in array di numeri
  // BFS usa spazi o newline per separare i numeri
  const allData = dataBlockMatch[1]
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
    .split(/\s+/)
    .map(Number);

  // Estraiamo solo i dati del Ticino per tutti i trimestri (slice)
  const ticinoValues = allData.slice(startIndex, startIndex + quarters.length);

  // --- 5. FORMAT FOR RECHARTS ---

  // Prendiamo gli ultimi 16 trimestri
  const result = ticinoValues.map((val, i) => {
    // Formatta "2023Q1" in "2023 Q1" per leggibilità
    const label = quarters[i].replace(/(\d{4})(Q\d)/, '$1 $2');
    return {
      year: label,
      frontalieri: Math.round(val)
    };
  }).slice(-16);

  // Scrittura File
  const outputPath = path.join(__dirname, '..', OUTPUT_FILE);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log(`✅ Successo! Dati salvati in: ${OUTPUT_FILE}`);
  console.log(`   Ultimo dato: ${result[result.length-1].year} -> ${result[result.length-1].frontalieri}`);

} catch (err) {
  console.error("❌ Errore:", err.message);
  process.exit(1);
}
