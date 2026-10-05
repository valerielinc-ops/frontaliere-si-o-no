# Studio: CV e lettera della candidatura assistita

Data 2 ottobre 2026. Codice letto su `origin/main` del sito (`7823f78481`).
Lo studio non ha modificato il repository; le fasi che ne sono seguite sono nel §9.
Tutti i CV, le lettere e gli annunci usati sono **sintetici e inventati**;
nessun ordine, nessun dato di Firestore o di Storage è stato letto.

Il codice cita questo documento come «report-cv-lettera §N». I percorsi `tmp/…`
indicano la cartella di lavoro dello studio (prototipi, PDF generati, strumenti):
non è archiviata, restano qui i numeri misurati e il modo per rifarli (Appendice).
Le decisioni prese sui punti del §7 sono in [`decisioni.md`](decisioni.md).

Fonti di supporto prodotte nel lavoro, archiviate in questa cartella:
- [`progetti.md`](studio/progetti.md): 40 progetti valutati, con licenze verificate via `gh` e i registry.
- [`convenzioni-svizzere.md`](studio/convenzioni-svizzere.md): convenzioni svizzere per CV e lettera, con fonti classificate T1/T2/T3.
- [`note-sul-codice.md`](studio/note-sul-codice.md): note sul codice com'era il 2 ottobre 2026.

---

## 1. Raccomandazione

1. **CV: rigenerarlo da template.** L'in-place regge solo su DOCX e DOC; su PDF rompe font e ordine di lettura (e richiede AGPL); sui PDF scansionati è impossibile.
2. **Template Typst** compilato in Node con typst.ts (Apache-2.0, 120 ms, 63 MB), a una colonna «in linea» con titoli maiuscoli: l'unico layout da 9/9 su tutti gli estrattori. Varianti per tipo (apprendista, primo impiego, qualificato, sanità, IT) e per regione.
3. **Lettera: stesso motore, layout svizzero per lingua** (DE a sinistra, FR e IT a destra, allegati elencati). Formule, oggetto e allegati li costruisce il codice; il modello scrive solo i paragrafi.
4. **Prima dei layout, chiudere le falle del gate sui fatti**: oggi passano Kubernetes e AWS inventati, numeri presi dall'annuncio e datori o titoli inventati. Il gate proposto dà il verdetto giusto in 13 casi su 17, quello attuale in 8; la versione rifinita (§5, §8) copre anche gli altri quattro.
5. **Subito, a costo minimo: font Unicode incorporato** con pdf-lib e fontkit (MIT, 119 ms, anche nelle Functions). Oggi «Kovačević» esce come «Kova?evi?» e il parser ATS prende il titolo per il nome.

### Perché cambiare: cosa mostra oggi il codice

Misure riproducibili con `tmp/proto/baseline/baseline.mjs`, che importa i moduli reali di `origin/main`:

| Problema | Prova |
|---|---|
| Caratteri fuori cp1252 resi come «?» (č ć đ ł ș ț ğ ı …) | `pdftotext` sul CV adattato e sulla lettera: «Luka Kova?evi?». `pdffonts`: Helvetica Type 1 **non incorporata**. OpenResume estrae come nome «Lernender Informatiker EFZ Applikationsentwicklung», cioè il titolo. |
| Il CV adattato perde fatti del CV originale | Apprendista: 11/20 fatti chiave ritrovati. Mancano nome, indirizzo, data di nascita, nazionalità, genitori, hobby, referenze e disponibilità. Infermiera: mancano «Permis G» e «Préavis». IT: mancano i progetti e GitHub (`tmp/proto/facts-recall.txt`). La causa è lo schema: `PROFILE_SCHEMA` non ha sezioni per progetti, stage, hobby, referenze e test attitudinali, e `tailoredCvBlocks` non stampa i dati personali. |
| Un unico layout per tutti | Un quindicenne riceve «Kurzprofil / Kernkompetenzen / Berufserfahrung» e come titolo «Lernender Informatiker EFZ…», un ruolo che non ha ancora (`tmp/proto/baseline/out/apprentice_de-tailored-cv.pdf`). |
| Il gate del CV adattato non controlla gli strumenti in titolo e sommario | `checkTailoredCvFacts` chiama `buildFactIndex` senza `claimSources`, quindi `checkGeneratedFacts` salta il controllo degli strumenti. Il sommario «uso quotidiano di Kubernetes e AWS» passa con `ok: true`. |
| `toolTokens` non vede gli strumenti scritti con sola maiuscola iniziale | Il bullet «Deploy su Kubernetes…» resta nel CV adattato con `rewritten: true`. Falso negativo opposto: «Git», presente nel CV, viene scartato (parola di meno di 4 lettere, non ha la forma di uno strumento). |
| La lettera accetta numeri presi dall'annuncio | «Ho guidato un team di 5 sviluppatori» passa `checkDraftFacts`, perché il «5» compare nell'annuncio («almeno 5 anni»). |
| La copertura ATS premia l'invenzione | Copertura del CV originale contro quello adattato: 50→58, 79→93, 78→**100**. Il 100 include Kubernetes e AWS inventati. La metrica non può essere l'obiettivo. |
| Lettera non conforme alle convenzioni svizzere | Mancano gli allegati (Beilagen/Annexes/Allegati). Lo spazio per la firma è di 22 pt (circa 8 mm). FR e IT hanno lo stesso layout del DE. «ß→ss» è solo nel prompt. «81 %» va a capo tra numero e simbolo. |
| Il PDF della lettera viene rigenerato nelle Functions | `assistedApplicationReview.js:241` (512 MiB, 60 s) e `assistedApplicationAutomationAdmin.js:198` rigenerano la lettera a ogni modifica. Qualsiasi nuovo motore per la lettera deve quindi girare anche nelle Cloud Functions. |

---

## 2. Progetti valutati

Licenze e date verificate via `gh repo view`, `gh api …/license`, `gh api …/commits?per_page=1`, npm e PyPI. Le prove comando per comando sono in [`progetti.md`](studio/progetti.md).

**Premessa sulla licenza:** `valerielinc-ops/frontaliere-si-o-no` è pubblico ma **senza licenza** (`licenseInfo: null`, nessun file LICENSE). Integrare codice AGPL significherebbe concedere a chiunque, concorrenti compresi, una licenza AGPL sul programma che lo incorpora. Il nodo non è la segretezza, ma che si tratta di una decisione di licensing.

| Progetto | Licenza | Attività | Stack | Cosa riusare | Verdetto |
|---|---|---|---|---|---|
| [RenderCV](https://github.com/rendercv/rendercv) | MIT | Ultimo commit 2026-03-25, v2.8; 17,7k ★ | Python, Jinja2, Typst | Pacchetto Typst `rendercv` 0.3.0 (MIT) e file di lingua de/fr/it. **Testato**: Unicode ok, foto ok, ma le date in colonna destra hanno ordine di lettura 0/3 con pdftotext raw e l'icona si attacca all'email nel parser. | Solo idee (layout misurati, nomi dei mesi); il pacchetto Typst è il piano B. Vedi §8 |
| [Typst](https://github.com/typst/typst) e [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) | Apache-2.0 | v0.15.1 (2026-07); typst.ts v0.7.0 | Rust; addon NAPI precompilato | Motore di rendering in-process (Node), **testato**: 120 ms, 63 MB | **Riusare** |
| [brilliant-cv](https://github.com/yunanwg/brilliant-CV) (Typst) | Apache-2.0 | 2026-10-01, v4.1.1 | Typst | CV più lettera multilingua con foto: struttura e lettera | Riusare idee e parti |
| [modern-cv](https://github.com/ptsouchlos/modern-cv) (Typst) | MIT (più Font Awesome CC BY/OFL) | 2026-09-01, 0.10.0 | Typst | `lang.toml` de/fr/it e lettera | Solo idee (usa icone) |
| [basic-resume](https://github.com/stuxf/basic-resume) (Typst) | Unlicense | 2026-03-28 | Typst | Impostazione minimale e ATS | Idee |
| [letter-pro](https://github.com/Sematre/typst-letter-pro), [lttr](https://github.com/pascal-huber/typst-letter-template) | MIT | 2025-03 / 2025-01 | Typst | Impaginazione lettera (DIN 5008; finestra C5 svizzera a destra o a sinistra) | Adattare le misure |
| KOMA-Script `scrlttr2` con `SN.lco` / `SNleft.lco` (CTAN) | LPPL-1.3c | 3.49.2 (2026-02-02) | LaTeX | Solo come **riferimento di misura** per la lettera svizzera (le misure non coincidono con KV Schweiz) | Riferimento |
| [Awesome-CV](https://github.com/posquit0/Awesome-CV), [moderncv](https://github.com/moderncv/moderncv) | LPPL-1.3c | 2026-09 | LaTeX | Testo estratto «sporco» (nomi dei glifi delle icone); richiede TeX | Solo idee |
| [JSON Resume](https://github.com/jsonresume/jsonresume.org) (schema) | MIT | Monorepo 2026-09-09 | JSON Schema | Schema come formato di scambio, eventualmente | Riusare lo schema, se serve |
| Temi JSON Resume: [even](https://github.com/rbardini/jsonresume-theme-even) MIT, [stackoverflow](https://github.com/phoinixi/jsonresume-theme-stackoverflow) MIT, elegant (MIT solo nel package.json), kendall MIT | vedi sopra | even 2025-11; stackoverflow 2026-05; elegant e kendall fermi al 2021 | HTML, richiede browser | **Testato even**: `lang="en"` e titoli inglesi fissi anche con contenuti in italiano | Scartare (stackoverflow al massimo come idea i18n) |
| [Reactive Resume](https://github.com/reactive-resume/reactive-resume) | MIT | 2026-09-30, v5.3.2; 43,7k ★ | TS, @react-pdf, docx | Import PDF/DOCX, schema con foto e lettera, export DOCX, ATS checker | Adattare singoli moduli |
| [OpenResume](https://github.com/xitanggg/open-resume) | **AGPL-3.0** | 2024-10-29, nessuna release | Next.js, pdf.js | Algoritmo del parser (righe → sezioni → punteggio per feature). **Usato solo in locale come banco di prova ATS** | Solo idee |
| [Resume-Matcher](https://github.com/srbhr/Resume-Matcher) | Apache-2.0 | 2026-09-29, v1.3.0 | FastAPI, Next.js, Playwright | Regole di veridicità, modifiche ancorate, numeri legati al ruolo, tetto onesto (lettera solo en/es/zh/ja) | Solo idee, riscritte in JS. Vedi §8 |
| [career-ops](https://github.com/career-ops-hq/career-ops) | MIT | 2026-10-02, v1.35.0 | Node, Playwright | Già fonte del nostro codice: modalità «cover», «JD gate», `verify-cv-facts`, template ATS | Adattare (già in uso) |
| AIHawk ([feder-cr/…](https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk), ora `invisible_playwright_mcp`) | Originale AGPL; MIT dal 2026-09-02 ma senza il generatore di documenti | Repo riconvertito | Python, Selenium | Nulla: il generatore di documenti è stato rimosso, i fork restano AGPL | **Scartare** |
| [docxtemplater](https://github.com/open-xml-templating/docxtemplater) | MIT o GPLv3, a scelta | 2026-09-21 | JS | Riempimento di DOCX a segnaposto; la foto richiede il modulo Image a pagamento | Riusare solo se serve DOCX in uscita |
| [docx](https://github.com/dolanmiu/docx) (dolanmiu) | MIT | 2026-10-02 | TS | Generazione di DOCX e `patcher` | Riusare per un eventuale DOCX in uscita |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | BSD-2 | 2026-09-26 | JS | Lettura DOCX (già nelle dipendenze del sito) | Riusare |
| [python-docx](https://github.com/python-openxml/python-docx) | MIT | 2025-06 | Python | **Usato nel prototipo in-place** | Solo con backend Python |
| [pdf-lib](https://github.com/Hopding/pdf-lib) e fork [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) | MIT | Originale fermo al 2021; fork 2026-09 | TS | **Testato**: font incorporato e Unicode ok; la sovrapposizione su un PDF esistente lascia il testo vecchio | Riusare (fork) per Unicode; scartare per l'in-place |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | **AGPL-3.0** o commerciale Artifex | 2026-09-30 | Python/C | Unico strumento che sostituisce davvero il testo di un PDF. **Testato**: risultato insufficiente comunque (§3) | Scartare |
| [pikepdf](https://github.com/pikepdf/pikepdf) | MPL-2.0 | 2026-10-01 | Python/qpdf | Struttura del PDF, non il testo | Non serve |
| [pdf.js](https://github.com/mozilla/pdf.js) / [unpdf](https://github.com/unjs/unpdf) | Apache-2.0 / MIT | 2026-10 / 2026-08 | JS | Estrazione del testo (già in uso) | Riusare |
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | v7.0.0 | WASM | OCR in Node, **testato** (§3) | Opzionale |
| [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | MPL-2.0, ma richiede Ghostscript (AGPL o commerciale) | 2026-09-28 | Python | Aggiunta di un livello di testo ai PDF scansionati | Scartare (per Ghostscript) |
| [pandoc](https://github.com/jgm/pandoc) | GPL-2.0+ | 2026-10-02 | Haskell | Non necessario | Scartare |
| LibreOffice (headless) | MPL-2.0 | 26.8.0 | Binario | **Testato**: DOC→DOCX e DOCX→PDF | Solo nel runner, solo se si fa in-place |
| [word-extractor](https://www.npmjs.com/package/word-extractor) | MIT | npm | JS | **Testato**: testo da DOC, caselle di testo comprese, senza binari | Alternativa ad antiword |

---

## 3. Modifica in-place (strada 1)

Prototipi in `tmp/proto/inplace/`:
- `make_docx.py`: tre DOCX sintetici con strutture tipiche (tabella con foto, paragrafi con stili, due colonne con casella di testo).
- `patch_docx.py`: inventario dei paragrafi e patch con blocchi.
- `pdf_inplace.py`: PyMuPDF.
- `overlay.mjs` (in `tmp/tools/node`): pdf-lib.

### Fattibilità per formato

| Formato | Fattibile? | Qualità misurata | Rischi principali |
|---|---|---|---|
| **DOCX** | **Sì**, con limiti | Stili, font, bullet, tabelle e foto **identici**. Cambiano solo i paragrafi toccati: 4,1% dei pixel su D1 (zona 33-88% della pagina), 3,4% su D2, 0,6% su D3. Numero di pagine invariato in tutti i casi, compresa la variante «lunga». Run spezzati (stile rsid di Word) gestiti. Le operazioni sui paragrafi bloccati vengono **rifiutate**: «Senior Full-Stack Engineer», «Lernender Informatiker EFZ». | (1) **Segmentazione fragile**: nella prima versione il titolo del ruolo in grassetto dentro la tabella è stato scambiato per un'intestazione e i bullet risultavano bloccati; serve una classificazione dei paragrafi fatta dal modello e verificata dal codice. (2) Il grassetto inline va perso quando si riscrive un paragrafo misto (D2: «référente douleur»). (3) **Il layout originale resta**, con i suoi difetti ATS: in D1 tabellare pdftotext legge le date staccate dai ruoli («03/2021 – oggi 09/2019 – 02/2021», poi i ruoli); in D3 il parser prende «Lebenslauf» come nome, perché quello vero è in una casella di testo. (4) Non si possono aggiungere sezioni assenti (D3 non ha un «Kurzprofil»). (5) Se il PDF lo rendiamo noi, i font mancanti vengono sostituiti (Georgia → Linux Libertine o Frank Ruhl, Calibri → Carlito): va consegnato il **DOCX**. (6) Nei DOCX reali ci sono `mc:AlternateContent` (caselle duplicate), campi, revisioni e SmartArt, che i miei DOCX sintetici non hanno: il tasso di successo reale è **non misurato**. |
| **DOC** | Sì, tramite conversione | LibreOffice headless DOC→DOCX: 5,2 s per due file su questo Mac a 2 core; differenza dopo il giro DOCX→DOC→DOCX dello 0,86% e dello 0,12% dei pixel. Poi si procede come per il DOCX. `word-extractor` (MIT) legge il testo, caselle comprese. | Il .doc di prova è stato scritto da LibreOffice, non da Word 97: la fedeltà su DOC reali **non è misurata**. LibreOffice pesa circa 300 MB: solo nel runner, installato al bisogno come oggi antiword. |
| **PDF testuale** | **No** (qualità inaccettabile) | Il font subset incorporato ha 67 glifi e **nessuno** dei 39 caratteri del nuovo testo: il sommario sparisce. Con Helvetica il testo entra solo scendendo da 10,5 a **9 pt**, con un font diverso a vista. Con il font completo della stessa famiglia (caso migliore, possibile solo con font open) entra, ma l'interlinea si stringe e il grassetto si perde. **pdf.js legge il sommario modificato all'85% del testo invece che al 18%**, dopo «Langues». Sovrapposizione con pdf-lib: il testo vecchio resta sotto e l'estrattore produce «IInnffiirmrmièièrere…». | Licenza AGPL (PyMuPDF); font subset e commerciali; reflow impossibile; ordine di lettura rotto; testo nascosto, che gli ATS possono leggere come keyword stuffing. |
| **PDF scansionato** | **No** | Nessun testo da modificare. OCR con tesseract.js (ita+deu+fra+eng, come il runner): 96-98% delle parole ritrovate, 2,6-5,3 s a pagina. Però **«ÉLODIE MARCHETTI» (titolo a 18 pt) non viene letto**, «Kovačević» diventa «Kovacevié» o «Kovacevic» (la «č» non è nei set di caratteri), l'email esce come «elodie. m@example.fr» e il testo bianco su fondo scuro come rumore («vw LA»). | Nome e contatti vanno presi **dall'ordine**, come fa già `candidateIdentity`, mai dall'OCR. Il CV va rigenerato da template. |

### Quando ricadere sul template

Sempre per PDF (testuali o scansionati), e sempre se:
- il DOCX ha caselle di testo, più colonne o contenuto in intestazione o piè di pagina;
- la classificazione dei paragrafi non è certa;
- una modifica cambia il numero di pagine;
- il candidato è un apprendista e mancano sezioni da aggiungere.

Il gate sui fatti resta **identico**: il testo generato è l'insieme dei paragrafi sostituiti o inseriti (`tmp/proto/baseline/gate-inplace.mjs`, 3 patch su 3 accettate). Il blocco dei paragrafi «fatto» (date, datori, titoli) è il secondo livello: il gonfiamento del titolo l'ha fermato il blocco, non il gate.

**Giudizio:** l'in-place ha senso solo come **opzione DOCX** per chi tiene al proprio layout, da valutare con un test A/B dopo il template. Non conviene come strada principale: copre solo una parte dei formati in ingresso e conserva i difetti ATS del layout originale.

---

## 4. Template proposti (strada 2)

Prototipi in `tmp/proto/templates/`:
- `typst/ch-cv-inline.typ`: **raccomandato**;
- `typst/ch-cv.typ` (griglia) e `ch-cv-linear.typ` (rientro sporgente): varianti scartate;
- `rendercv/*.yaml`: confronto con RenderCV;
- `jsonresume/`: tema «even».

### Risultati ATS (gli stessi tre candidati in tutti gli output)

Data accanto al ruolo giusto nel testo estratto (`tmp/proto/ats-order.txt`); su ogni riga, una voce per candidato (IT, FR, DE):

| Output | pdf.js | pdftotext | pdftotext -layout |
|---|---|---|---|
| `renderPdf` attuale | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 | 3/3, 3/3, 3/3 |
| RenderCV (classic / sb2nov) | 3/3, 2/3, 2/3 | **0/3, 0/3, 0/3** | 3/3, 2/3, **0/3** |
| Typst CH a griglia (date a sinistra) | 3/3 ×3 | 2/3 ×3 | 2/3, 2/3, 3/3 |
| **Typst CH in linea** | **3/3 ×3** | **3/3 ×3** | **3/3 ×3** |
| DOCX originali (LibreOffice) | 3/3 ×3 | 2/3, 2/3, 3/3 | 2/3, 3/3, 3/3 |

Parser OpenResume, solo in locale e con le parole chiave dei titoli tradotte in DE/FR/IT (`tmp/proto/openresume-results.txt`):
- **Typst in linea con titoli maiuscoli**: nome corretto (anche «Kovačević» ed «Élodie»), email corretta, 2 esperienze trovate su 2 in tutte e tre le lingue.
- **Senza maiuscole**: la sezione FR «Expérience professionnelle» non viene riconosciuta, perché la regola di riserva vuole `^[A-Z]` e «É» non passa.
- **RenderCV**: l'icona si attacca all'email (`candidature-…`).
- **`renderPdf` attuale**: per l'apprendista il nome estratto è il titolo, a causa dei «?».

Fatti del CV originale ritrovati nel PDF (`tmp/proto/facts-recall.txt`):

| Candidato | Template Typst | `renderPdf` attuale |
|---|---|---|
| Apprendista | **20/20** | 11/20 |
| Infermiera | **15/15** | 13/15 |
| Sviluppatore | **16/16** | 13/16 |

**Regole di layout dedotte dalle misure:**
- una sola colonna vera;
- date e luogo su una riga sotto il titolo del ruolo, non in colonna;
- coppie scritte «Etichetta: valore» sulla stessa riga;
- titoli di sezione in grassetto **MAIUSCOLO** nel testo (`upper()` di Typst);
- nessuna icona;
- font OFL incorporato (Source Sans 3);
- foto come immagine senza testo, nell'intestazione.

L'aspetto «tabellare» svizzero (date a sinistra) costa punti con i parser che segmentano per colonne: le misure vanno contro l'abitudine delle guide SECO e BIZ. La variante in linea è il compromesso. Se il proprietario vuole il look tabellare, serve una seconda versione «ATS» da caricare nei portali, come suggeriscono BIZ Bern e SBB (decisione aperta 6).

### Template per tipo e regione

Convenzioni dalle fonti, con sigle del registro in `swiss-conventions.md`:
- **Foto**: consueta in DE-CH (presente nei 3 esempi SDBB); facoltativa in FR e IT («Photo éventuelle», «Ev. foto»); mai obbligatoria.
- **Dati personali**: data di nascita e nazionalità; permesso solo per i non svizzeri.
- **Lingue**: madrelingua per prima; livelli QCER per gli adulti; «Schulkenntnisse» o «connaissances scolaires» per gli apprendisti.
- **Lunghezza**: 1 pagina per gli apprendisti, 2 al massimo per i qualificati.
- **Forma**: niente «ß», niente data né firma sul CV, niente Europass in Ticino.

| Tipo | Sezioni, in ordine | Foto (default) | Dati personali | Note |
|---|---|---|---|---|
| **Apprendista** (CFC/EFZ/AFP, 14-16 anni) | Persönliche Angaben / Données personnelles / Dati personali (nascita, nazionalità, permesso; genitori facoltativi, solo DE) → Scuola (attuale per prima) → Schnupperlehren / stages d'orientation / stage di orientamento (data, durata, mansioni) → Lavoretti → Test attitudinali (Multicheck, Basic-Check, EVA, GRI) → Conoscenze → Lingue → Tempo libero e impegni → Referenze (docente o orientatore con telefono, previo consenso) | DE: sì; FR e IT: chiesta al candidato | Completi (SDBB) | Titolo «Berufswunsch: …», cioè l'obiettivo e non un ruolo; nessun «Kurzprofil». Pagelle e test vanno come allegati, uno per tipo. |
| **Primo impiego** | Profilo breve → Formazione (con voto o tesi se presenti nel CV) → Stage ed esperienze → Progetti → Competenze → Lingue → Interessi | Come qualificato | Come qualificato | Formazione prima dell'esperienza. |
| **Qualificato** | Profilo → Esperienza (antichronologica) → Formazione → Formazione continua e certificati → Competenze → Lingue (QCER) → Referenze («auf Anfrage» / «sur demande» / «su richiesta») | DE: proposta; FR: proposta; IT: no | Nazionalità e permesso (G, B, C); stato civile no, salvo scelta del candidato | 2 pagine al massimo. |
| **Sanità** | Come qualificato, più «Riconoscimento e registrazione» (CRS/SRK con anno, MEBEKO, NAREG/GLN **solo se nel CV**) subito dopo la formazione | come sopra | come sopra | Il riconoscimento è spesso un requisito critico: va messo in evidenza. |
| **IT** | Come qualificato, più «Progetti» (link GitHub e portfolio) e competenze raggruppate (linguaggi, framework, dati e infrastruttura) | come sopra | come sopra | Link come testo visibile, non come icone. |

**Regola sulla foto proposta:** caricamento facoltativo sulla pagina di revisione, con un default per regione: proposta in DE-CH, chiesta in FR, nessuna in IT. Non la si estrae mai dal CV originale. Il codice dei CV rigenerati non la inventa né la ritaglia. Va decisa la conservazione nel quadro di `assistedApplicationRetention.js` (decisione aperta 2).

**Esempi visivi (PDF di prova):**
- Template raccomandato: `tmp/proto/templates/typst/out-inline/apprentice_de.pdf`, `nurse_fr.pdf`, `developer_it.pdf` (`triptych.png` per la vista d'insieme).
- Varianti scartate: `tmp/proto/templates/typst/out/*.pdf` (griglia), `out-linear/*.pdf`, `tmp/proto/templates/rendercv/out/*.pdf`.
- Stato attuale: `tmp/proto/baseline/out/*-tailored-cv.pdf`.

**Architettura invariata nel punto chiave:** il modello scrive solo un JSON di testo (titolo, sommario, competenze, bullet), come oggi in `TAILORED_CV_SCHEMA`. Il codice compone il JSON del documento copiando i fatti dal profilo; Typst lo impagina (`sys.inputs.data`). Il gate resta sul testo scritto dal modello.

---

## 5. Lettera

Prototipo in `tmp/proto/templates/typst/ch-letter.typ`, con dati in `letter_*.json`.

Risultati in `tmp/proto/templates/typst/out-letters/`:
- `letter_apprentice_de.pdf`, `letter_nurse_fr.pdf`, `letter_developer_it.pdf`;
- le stesse compilate in Node con typst.ts: `*.typstts.pdf`.

Tutte stanno in una pagina e il testo è estraibile.

### Formato

- **Norma**: la SN 010130 è citata ovunque ma il catalogo SNV la dà come **ritirata** (edizioni 1981, 2010 e 2011). La pagina dell'edizione 2016 risponde 404 e il testo è a pagamento: non si può dichiarare la conformità. Uso le misure pratiche di KV Schweiz: margine sinistro 26-30 mm, destro 15-20 mm, prima riga dell'indirizzo a 52 mm dall'alto, indirizzo a 26 mm (sinistra) o 117 mm (destra) dal bordo. Le misure KOMA `SN.lco` e `briefli` non coincidono: se la lettera dovrà andare in busta a finestra va verificata la specifica della Posta (non verificato).
- **DE**: indirizzo, luogo e data, chiusura a sinistra. «Winterthur, 2. Oktober 2026». Oggetto in grassetto senza «Betreff». «Sehr geehrte Frau Beispiel» **senza virgola** e frase seguente con la maiuscola. «Freundliche Grüsse» senza virgola. «Beilagen: …». Niente «ß».
- **FR**: indirizzo, luogo e data, chiusura e firma a destra (tabulazione a circa 9 cm). «Annemasse, le 2 octobre 2026». «Madame, Monsieur,». Chiusura «Je vous prie d'agréer, Madame, Monsieur, mes meilleures salutations.» oppure «Meilleures salutations» per gli apprendisti. «Annexes: …».
- **IT**: indirizzo a destra, con «Spettabile» e «c.a. signora …». «Gentile signora Esempio,» e prima riga **minuscola**; «Gentili signore, egregi signori» se non c'è nome. «Cordiali saluti», non «Distinti saluti», che nelle fonti CH non compare. «Allegati: …».
- **Firma**: circa 16 mm di spazio più nome dattiloscritto. Una firma scansionata è facoltativa: le fonti divergono (DE «digitale Unterschrift», FR «signature manuscrite» anche scansionata, jobs.ch e jobup.ch «non serve online»).
- **Tecnica**: spazio indivisibile prima di «%» e nelle cifre con apostrofo («CHF 80'000»). In DE, `ß→ss` applicato **in codice**, non solo nel prompt. In Typst va impostato `#set smartquote(enabled: false)` in CV e lettera: di default «CHF 80'000» diventa «80′000», con U+2032 (simbolo di primo), e «l'» diventa «l’». Verificato in `tmp/proto/smartquote/`.

### Struttura e template per tipo

Il codice sceglie la struttura; il modello riempie i paragrafi.

| Tipo | Paragrafi | Regole di testo |
|---|---|---|
| Apprendista | (1) professione e azienda, con il motivo concreto (spesso lo Schnupperlehre); (2) cosa ha fatto e imparato negli stage o nei test, con i numeri del CV; (3) qualità dimostrate da hobby o lavoretti; (4) disponibilità a uno stage di selezione o a un colloquio | Frasi brevi, registro adatto a un quindicenne ma con il «Sie»; mai competenze professionali che non ha; «Weshalb gerade dieser Betrieb?» (SDBB) |
| Primo impiego | (1) ruolo e perché questa azienda; (2) formazione e progetti mappati sui requisiti; (3) stage; (4) chiusura | Nessuna durata calcolata |
| Qualificato | (1) ruolo e un elemento specifico dell'annuncio; (2-3) 2-4 prove mappate sui requisiti «met/partial»; (4) disponibilità e permesso solo se dichiarati; chiusura diretta | Niente «Hiermit bewerbe ich mich», «Mit Interesse habe ich gelesen», «würde» (BIZ Bern, SECO, jobs.ch) |
| Sanità | Come qualificato; il riconoscimento CRS e la registrazione nel primo o secondo paragrafo se presenti | |
| IT | Come qualificato; un progetto concreto con link solo se nel CV | |

### Migliorare il testo restando nel gate

1. **Il gate proposto** (§6, fase 0) blocca i numeri che vengono solo dall'annuncio e gli strumenti o nomi propri «eco dell'annuncio». Test in `tmp/proto/baseline/gate-proposed.mjs` (output in `out/gate-proposed.txt`):

   | Caso | Gate attuale | Gate proposto |
   |---|---|---|
   | 3 lettere buone (DE, FR, IT) | ok | ok |
   | «team di **5** sviluppatori» (5 solo nell'annuncio) | ok ✗ | BLOCCA `number:5` |
   | Sommario del CV adattato con «Kubernetes e AWS» | ok ✗ | BLOCCA `tool:AWS`, `posting_echo:Kubernetes` |
   | Bullet «Deploy su Kubernetes» | ok ✗ | BLOCCA `posting_echo:Kubernetes` |
   | «plus de **3** ans d'expérience» (3 solo nell'annuncio) | ok ✗ | BLOCCA `number:3` |
   | «à 80 %» (pensum dal titolo dell'ordine) | ok | ok |
   | «gute Noten in **Mathematik**» (solo nell'annuncio) | ok ✗ | BLOCCA `posting_echo:Mathematik` |
   | «Python und **JavaScript**» | BLOCCA | BLOCCA |
   | «presso **Initech** come **Head of Engineering**» (datore e titolo inventati; aggiunto nel confronto con career-ops) | ok ✗ | ok ✗ |
   | «pur non avendo i **5** anni richiesti» (requisito citato onestamente) | ok | BLOCCA ✗ |

   Conteggio corretto: sui 10 casi dello studio il gate attuale ne giudica bene **5** (non 4: «à 80 %» passa, come deve) e il proposto 10. Su tutti i 17 casi del confronto (`tmp/research/co/exp/gates-out.txt`) il risultato è 8 contro 13, mentre career-ops upstream ne giudica bene 7, perché riconosce strumenti e conteggi solo in inglese.

   **Gate rifinito** dopo il confronto (§8):
   - l'eco dell'annuncio **blocca** solo i token con forma da strumento o presenti in un **vocabolario chiuso con alias**: base `skill-extract.mjs` di career-ops (190 voci) più `jd/aliases.ts` di Reactive Resume (circa 175 alias, k8s→Kubernetes), estesi con Git, Excel e i termini svizzeri EFZ, CFC, CRS, SRK, GLN;
   - le altre parole maiuscole vengono solo **segnalate**: su 7 frasi di prova erano falsi positivi come «Semester», «Profil», «Cerchiamo»;
   - eccezione «**requisito citato**» per i numeri dell'annuncio in frasi con negazione o citazione (pur non avendo, ohne, sans; richiesti, verlangt, requis);
   - controllo dei **datori e dei titoli** nominati nella lettera contro il profilo;
   - **numeri legati al ruolo** per il CV adattato (idea di Resume-Matcher): un «40%» spostato su un altro ruolo viene bloccato.

   Il campione resta piccolo: prima del rilascio va misurato il tasso di falsi positivi su un corpus sintetico DE/FR/IT più ampio. L'eco dell'annuncio non va applicato a `whyCompany`, che parla del datore.

2. **Più contesto e meno libertà**: al prompt della lettera vanno passati il tipo di candidatura e il layout della lingua. La lunghezza (200-320 parole) va controllata **in codice**, come già si fa per altri limiti.
3. **Formule e oggetto in codice**: saluto (dal `contactPerson`), chiusura, oggetto (con la forma di genere scelta dal candidato al posto di «Infermiere/a») e allegati (da `requiredDocuments` più CV) non li scrive il modello. Toglie al modello la parte in cui sbaglia di più per lingua e regione, senza nuovi fatti.
4. **Elenco degli allegati** generato dai documenti realmente caricati, così la lettera non promette allegati assenti.

**Dove gira:** la lettera viene rigenerata nelle Functions. Ci sono due opzioni:
- **typst.ts nelle Functions**: in locale 120 ms per la prima lettera, poi 1-6 ms, 63 MB di memoria; pacchetto nativo di circa 46 MB (build darwin-x64; esiste `linux-x64-gnu`). Su Cloud Functions **non è verificato**: va fatto un deploy di prova.
- **Riserva**: pdf-lib con fontkit (MIT, puro JS), 119 ms, che riproduce lo stesso layout in codice.

---

## 6. Piano di implementazione a fasi (solo proposta)

Gli esperimenti passano da **Firebase Remote Config** con default locale sicuro (regola del workspace), non da PostHog.

| Fase | Cosa | File da toccare (sito) | Dipendenze nuove | Dove gira | Effort | Rischi e come misurare |
|---|---|---|---|---|---|---|
| **0. Correttivi** (subito) | (a) Gate: `claimSources` nel CV adattato; numeri solo da fonti del candidato e dalla riga d'ordine, con eccezione «requisito citato»; eco dell'annuncio che blocca solo con vocabolario chiuso con alias (career-ops e Reactive Resume) e altrimenti segnala; datori e titoli della lettera controllati sul profilo; numeri del CV adattato legati al proprio ruolo (Resume-Matcher); «Git» e simili ammessi se presenti nel CV (`|| mentionsTool`). (b) Font OFL incorporato in `renderPdf` (pdf-lib con fontkit) per CV e lettera. (c) Formule della lettera per lingua, allegati, spazio firma, indirizzo a destra per FR e IT, `ß→ss`, spazi indivisibili, conteggio parole e frasi vietate DE/FR/IT in codice, con esito passa/segnala/blocca. (d) File `THIRD_PARTY_NOTICES` con il testo MIT di career-ops e di Reactive Resume, da cui il codice attuale deriva già | `assistedApplicationAiFactCheck.js`, `assistedApplicationTailoredCv.js` (`checkTailoredCvFacts`, `groundedInCv`), `assistedApplicationAiDraftCore.js` (`checkDraftFacts`, `letterPdfBlocks`), `assistedApplicationAiDocuments.js` (`renderPdf`, `buildCoverLetterPdf`), `assistedApplicationAiPrompts.js`, nuovo file dati del vocabolario, più i test esistenti | `@cantoo/pdf-lib` o `pdf-lib`, `@pdf-lib/fontkit` (MIT); Source Sans 3 (OFL, 2 TTF, circa 0,6 MB) | Runner e Functions | 4-6 giorni | Rischio: falsi positivi del gate (oggi il gate della lettera **segnala** all'operatore, quello del CV **scarta** il CV adattato). Misura: test sintetici per falsi positivi e negativi; quota di CV adattati scartati per `fact_check_failed` prima e dopo. |
| **1. Profilo più ricco** | Nuovi campi in `PROFILE_SCHEMA`: tipo di candidatura (apprendista, primo impiego, qualificato; regola in codice più indizio del modello), scuola, Schnupperlehre o stage, test attitudinali, progetti, interessi, referenze, patente, riconoscimenti (CRS/SRK, MEBEKO, GLN). Il CV adattato stampa dati personali e permesso. Si aggiungono: le quattro regole mancanti del prompt di estrazione di Reactive Resume (intestazioni, filigrane e piè di pagina, revisioni DOCX, tabelle); il parser dei periodi DE/FR/IT (`packages/resume/src/ats/period.ts`, da correggere per «seit», «ab» e `’`), così le date le formatta il codice e mai il modello; il controllo dell'`headline` contro i ruoli del profilo (career-ops); domande al candidato sui requisiti mancanti invece di inventare (Resume-Matcher) | `assistedApplicationAiPrompts.js` (schema e prompt), `assistedApplicationAiDraftCore.js` (`sanitizeProfile`), `assistedApplicationTailoredCv.js` | nessuna | Runner | 2-3 giorni | Rischio: estrazione meno precisa con uno schema più lungo. Misura: richiamo dei fatti (come `facts.mjs`) su un corpus sintetico per tipo. |
| **2. Template Typst** | Template CV in linea con titoli maiuscoli e varianti per tipo e regione; template lettera per lingua; renderer typst.ts al posto di `renderPdf` per il CV adattato (runner) e per la lettera (runner e Functions); flag RC `assisted_cv_template` (default: renderer attuale) | nuovi `functions/src/templates/ch-cv.typ`, `ch-letter.typ`, `functions/fonts/`; `assistedApplicationTailoredCv.js`, `assistedApplicationAiDocuments.js`, `assistedApplicationReview.js`, `assistedApplicationAutomationAdmin.js`, `scripts/assisted-application/lib/draft.mjs` | `@myriaddreamin/typst-ts-node-compiler` (Apache-2.0, addon nativo di circa 46 MB) | Runner e Functions | 6-8 giorni | Rischi: dimensione del deploy e cold start nelle Functions (non verificato), da provare con un deploy di prova; in alternativa la lettera si rigenera nel runner o con pdf-lib. In Typst: `smartquote` disattivato. Misura, con un **banco di prova CI senza AGPL**: il checker `ats-pdf` di Reactive Resume (MIT, copiato in tooling e fissato a un commit, con alias DE/FR/IT, regola «? dentro una parola» e controllo del nome atteso) più le nostre asserzioni (ordine data↔ruolo con pdf.js e pdftotext, «titolo di sezione prima della prima data», richiamo dei fatti al 100%, una pagina per gli apprendisti e due al massimo per gli altri). Le regole di layout ATS vanno tenute come dati, come fa career-ops con `templates/ats-rules.yml`. |
| **3. Foto e dossier** | Caricamento facoltativo della foto sulla pagina di revisione (default per regione); un solo PDF «dossier» per le email dei qualificati (SECO: 5 pagine e 2 MB al massimo); file separati per i portali (SBB) e per gli apprendisti (SDBB) | `AssistedApplicationReview.tsx`, `assistedApplicationReview.js`, `storage.rules`, `assistedApplicationRetention.js`, `scripts/assisted-application/lib/submit.mjs` | pdf-lib per unire i PDF | Functions e runner | 3-4 giorni | Rischi: privacy e conservazione della foto; dimensione degli allegati. Misura: tasso di caricamento della foto; nessun rifiuto per dimensione. |
| **4. Revisione del CV da parte del candidato** | Mostrare cosa cambia rispetto al CV originale (righe riscritte e scartate) e permettere di modificare sommario e bullet, con gate e nuova compilazione. Modello di Resume-Matcher: ogni bullet riscritto dichiara la riga del CV da cui deriva e il requisito a cui risponde (modifiche ancorate), il codice applica solo le modifiche il cui testo originale coincide alla lettera; il candidato accetta o rifiuta **per riga** (Resume-Matcher lo fa solo in blocco); il server rifà il gate prima di ricompilare | `AssistedApplicationReview.tsx`, `assistedApplicationCandidateEdits.js`, `assistedApplicationReview.js` | nessuna (usa la fase 2) | Functions | 3-5 giorni | Misura: quota di candidati che scelgono il CV adattato rispetto all'originale; tasso di modifica. |
| **5. In-place DOCX** (opzionale) | Solo DOCX (DOC dopo conversione con LibreOffice nel runner): il modello classifica i paragrafi, il codice blocca date, datori e titoli; patch su sommario, bullet e competenze; ricaduta sul template se compaiono caselle, colonne o un cambio di pagine | nuovo modulo in `scripts/assisted-application/lib/`; scelta del candidato a tre opzioni | Libreria XML (`@xmldom/xmldom`, MIT) oppure python-docx (MIT); LibreOffice nel runner (circa 300 MB, apt al bisogno) | Runner | 4-6 giorni | Solo dopo l'A/B della fase 2, e solo se i candidati chiedono il proprio layout. Misura: tasso di ricaduta sul template; differenza in pixel fuori dalle zone modificate. |

**Come misurare il miglioramento:**
- **ATS**, regressione in CI: ordine di lettura e richiamo dei fatti su PDF sintetici, con pdf.js (lo stesso estrattore del prodotto) e pdftotext. Un parser strutturale va **reimplementato da zero** prendendo solo le idee di OpenResume, non il codice (AGPL). La copertura delle parole chiave va riportata ma **non usata come obiettivo**: oggi premia l'invenzione (78→100), e lo stesso fanno lo score di Resume-Matcher e quello di Reactive Resume (0,50 con Kubernetes e AWS inventati, 0,40 senza). Al suo posto si usa il **tetto onesto**, idea di Resume-Matcher che lì è calcolata ma non usata: i termini dell'annuncio sostenuti dal CV. Obiettivo: copertura vicina al tetto e **zero termini oltre il tetto**, che nell'esperimento segnala esattamente le 3 invenzioni e nessun caso legittimo.
- **Esito**, A/B con Remote Config (`assisted_cv_template`, `assisted_letter_template`) e Analytics:
  - quota di candidati che tengono il CV adattato;
  - quota di lettere modificate dal candidato e quanto vengono modificate;
  - **tasso di risposta dei datori** entro 21 giorni dall'invio, già classificato in `assistedApplicationInbound.js` (`INBOUND_CATEGORIES`: `interview_invite`, `assessment`, `documents_request`, `offer`, `rejection`; `auto_acknowledgement` va escluso dal numeratore).
- Il volume è basso (servizio da 0,99 €): la regola di decisione va fissata prima, per esempio un intervallo bayesiano sul tasso di inviti. Per qualche mese, prima delle conclusioni, contano soprattutto le misure di qualità.

---

## 7. Decisioni aperte per il proprietario

1. **Strada del CV**: template rigenerato come default (raccomandato) e in-place DOCX solo come opzione futura? Oppure niente in-place?
2. **Foto**: permettere il caricamento di una foto, con quali default per regione e quale conservazione?
3. **Dati personali**: mettere di default data di nascita, nazionalità e permesso, come da prassi svizzera? Come scrivere lo stato del frontaliere che **non ha ancora** il permesso G, che si rilascia con il contratto? Nessuna fonte lo indica.
4. **Formato consegnato**: solo PDF, oppure anche il DOCX per il candidato? SDBB consiglia di conservare CV e lettera in Word; servirebbe `docx` (MIT).
5. **Allegati**: un unico PDF dossier per le email dei qualificati, file separati per portali e apprendisti?
6. **Layout**: solo la versione «in linea» (ottimale per ATS), oppure anche una «tabellare» svizzera per il dossier più quella ATS per i portali?
7. **Licenza del repo**: oggi nessuna. Decidere prima di integrare codice di terzi (MIT e Apache chiedono di conservare le note). Confermare l'esclusione di AGPL (PyMuPDF, OpenResume, fork AIHawk). **Già adesso** `origin/main` contiene codice e frasi di prompt derivati da career-ops e Reactive Resume (MIT), ma senza il loro testo di licenza: l'attribuzione c'è solo nei commenti. Un file `THIRD_PARTY_NOTICES` va aggiunto comunque (fase 0, punto d).
8. **Gate**: se l'«eco dell'annuncio» deve **bloccare** o solo **segnalare**, con un comportamento diverso per CV adattato e lettera.
9. **Rigenerazione della lettera**: typst.ts nelle Cloud Functions (deploy di prova da fare) oppure spostare la rigenerazione nel runner (più lenta per il candidato)?
10. **Firma**: solo nome dattiloscritto, oppure caricamento facoltativo di una firma scansionata?
11. **Formule IT e FR**: confermare «Gentili signore, egregi signori» e «Cordiali saluti» (fonti SDBB e Lugano); in FR, «Meilleures salutations» per gli apprendisti e formula lunga per i qualificati?

---

## 8. Confronto approfondito: Reactive Resume, career-ops, RenderCV, Resume-Matcher

Quattro analisi dedicate, fatte il 2 ottobre 2026 via `gh` e con esperimenti locali sui nostri PDF e testi sintetici. I report completi sono in:
- [`confronto-reactive-resume.md`](studio/confronto-reactive-resume.md);
- [`confronto-career-ops.md`](studio/confronto-career-ops.md);
- [`confronto-rendercv.md`](studio/confronto-rendercv.md);
- [`confronto-resume-matcher.md`](studio/confronto-resume-matcher.md).

Script e output grezzi sono nelle rispettive cartelle `exp/`.

### Sintesi

| | Reactive Resume | career-ops | RenderCV | Resume-Matcher |
|---|---|---|---|---|
| Licenza | MIT | MIT | MIT | Apache-2.0 (senza NOTICE) |
| Stato | commit `b53c43c` 2026-09-30, v5.3.2 | `81053f97` 2026-10-02, v1.35.0 | v2.8 del 2026-03-21, nessuna release da 195 giorni; 91% dei commit di un solo autore; ultime 8 run CI delle PR fallite | `9c05e423` 2026-09-29, v1.3.0; quasi tutto il lavoro di un solo autore |
| Cosa fa che noi non facciamo | Checker ATS sul file PDF (font incorporati, icone, testo nascosto, Type 3, punti elenco); parser dei periodi; circa 175 alias di strumenti | Vocabolario chiuso di 190 strumenti con alias; eccezione per il requisito citato (#3917); controllo datore e titolo (solo inglese); regole ATS come dati | Pacchetto Typst con lingue | Modifiche ancorate al testo originale con 4 controlli in codice; numeri legati al proprio ruolo; tetto onesto delle keyword; schermata barrato/nuovo |
| Cosa fa peggio di noi | Nessun adattamento all'annuncio né controllo dei fatti; schema senza campi svizzeri; titoli generici (nessuna variante `-CH`) | Gate e lingue tarati sull'inglese (7/17 sui nostri casi); bug sugli strumenti dopo «Node.js»; le modalità it/de/fr ignorano la Svizzera («Nessun visto richiesto (cittadino UE)» è sbagliato per il permesso G) | Date in colonna in tutti i 9 temi; il Markdown altera il testo («-» diventa bullet, `*x*` corsivo); niente lettera, e il maintainer non la vuole | Aggiunge **di proposito** le skill dell'annuncio assenti dal CV; score ATS solo keyword; lettera di 100-150 parole senza controlli, niente DE/IT; accetta o rifiuta solo in blocco |
| Verdetto | **Adattare parti** (checker, alias, periodi, regole del prompt) | **Riprendere ciò che abbiamo perso nel port** e il vocabolario | **Solo idee**; il pacchetto Typst resta piano B | **Solo idee**, riscritte in JS |

### Esperimenti chiave

1. **Checker ATS di Reactive Resume sui nostri 12 PDF** (7-81 ms per file, gira con `unpdf`):

   | PDF | Così com'è | Con alias DE/FR/IT |
   |---|---|---|
   | Typst «in linea» (apprendista, infermiera, sviluppatore) | 99 / 100 / 60 | 99 / 100 / 97 |
   | `renderPdf` attuale | 98 / 98 / 60 | 98 / 98 / 95 |
   | RenderCV | 91 / 60 / 60 | 89 / 60 / 97 |
   | D1, D2, D3 (LibreOffice) | 60 / 60 / 60 | 86 / 92 / 93 |

   - **Il 60 è un falso blocker**: il checker scambia l'italiano tecnico per inglese.
   - **Due punti ciechi**: non vede il nome «Kova?evi?» (98 al renderer attuale) né le due colonne di D3.
   - **Conclusione**: va bene come base del banco di prova CI senza AGPL, ma solo insieme alle nostre asserzioni su ordine di lettura, fatti e nome atteso.

2. **RenderCV ATS-safe:**
   - **Nessun tema**: i 9 temi tengono tutti le date in colonna.
   - **Con template delle voci riscritti** («date in linea») e titoli MAIUSCOLI generati dal nostro codice arriva a 9/9 su tutti gli estrattori. Così fanno K5 (riga di comando) e T1 (pacchetto Typst in Node: 25-61 ms, poi 1-2 ms).
   - **Confronto con il nostro template**: sono gli stessi numeri di `ch-cv-inline.typ` (57 righe), con 764 righe di terze parti in più.
   - **Decisione**: resta il nostro template; RenderCV è il piano B se servissero più stili grafici (1-1,5 giorni).

3. **Gate sui fatti, 17 casi** (`co/exp/gates-out.txt`):

   | Gate | Casi dello studio | Sonde nuove | Totale |
   |---|---|---|---|
   | career-ops upstream | 3/10 | 4/7 | 7/17 |
   | Nostro attuale | 5/10 | 3/7 | 8/17 |
   | Nostro proposto | 10/10 | 3/7 | 13/17 |

   - Le falle (a), (b) e (c) **non sono correzioni upstream che ci siamo persi**, ma deviazioni nate nel nostro port. Upstream controlla sempre gli strumenti e non usa mai l'annuncio come fonte.
   - Le quattro sonde ancora sbagliate (datore e titolo inventati, requisito citato) le copre il gate rifinito del §5.

4. **Resume-Matcher contro il nostro gate, sullo stesso caso** (`rm/exp/`):
   - Resume-Matcher blocca i numeri spostati da un ruolo all'altro («40%», «400 clienti»); noi no.
   - Il nostro gate scarta le skill aggiunte; Resume-Matcher le lascia passare per scelta.
   - I due approcci sono **complementari**: il gate rifinito li combina.

### Elementi da prendere, per fase

| Elemento | Fonte (file) | Fase | Effort | Obblighi |
|---|---|---|---|---|
| Strumenti sempre controllati, annuncio mai fonte di numeri | career-ops `verify-cv-facts.mjs` (comportamento, non codice) | 0 | incluso | nessuno (idea) |
| Vocabolario chiuso con alias, esteso con termini svizzeri | career-ops `skill-extract.mjs` (190 voci) e Reactive Resume `packages/resume/src/ats-pdf/jd/aliases.ts` | 0 | 1 g | testo MIT di entrambi (sono dati copiati) |
| Eccezione «requisito citato» in it/de/fr | career-ops #3917 (solo inglese) | 0 | 0,5-1 g | nessuno (riscritta) |
| Datori e titoli della lettera contro il profilo | career-ops (estrazione solo inglese) | 0 | 0,5-1 g | nessuno (riscritta) |
| Numeri legati al ruolo e contati | Resume-Matcher `improver.py` | 0 | 0,5-1 g | nessuno (riscritta) |
| `groundedInCv` con `|| mentionsTool` («Git») | career-ops | 0 | 1 h | nessuno |
| Frasi vietate e conteggio parole DE/FR/IT, esito a tre livelli | career-ops `cover.md` più liste nostre | 0 | 0,5 g | nessuno |
| `THIRD_PARTY_NOTICES` per il codice già portato | — | 0 | 0,25 g | obbligo MIT già in essere |
| Quattro regole del prompt di estrazione | Reactive Resume `parser-system.md` | 1 | 0,25 g | MIT se copiate alla lettera |
| Parser dei periodi DE/FR/IT; date formattate in codice | Reactive Resume `packages/resume/src/ats/period.ts` | 1 | 0,5-1 g | MIT |
| Controllo dell'`headline` contro i ruoli | career-ops `cv-title-check.mjs` | 1 | 0,5 g | MIT se copiato |
| Domande sui requisiti mancanti (unico modo onesto di alzare la copertura) | Resume-Matcher | 1 | 1-2 g | nessuno (idea) |
| Checker ATS sul PDF copiato e fissato a un commit, con alias e regole nostre | Reactive Resume `packages/resume/src/ats-pdf/` (dipende solo da `wink-porter2-stemmer`, MIT) | 2 (CI) | 1,5-2 g | MIT, in una cartella di tooling |
| Controllo «titolo di sezione prima della prima data» | Misura di RenderCV | 2 (CI) | 0,5 g | nessuno |
| Regole ATS come dati; due pagine al massimo, una per gli apprendisti; `smartquote` disattivato | career-ops `templates/ats-rules.yml`; misure nostre | 2 | 0,5-1 g | nessuno |
| Nomi dei mesi (minuscoli in FR e IT) | RenderCV `other_locales` | 0 e 2 | 0,1 g | nessuno (36 parole) |
| Modifiche ancorate con accetta o rifiuta per riga, gate lato server prima di ricompilare | Resume-Matcher | 4 | 2-3 g | nessuno (idea) |
| Corpus di prova DE/FR/IT con coppie buona/sbagliata di proposito; giudice LLM fuori dalla CI | Resume-Matcher (casi), career-ops (forme da tradurre) | misura | 1-2 g | nessuno |

### Cosa non prendere

- **Reactive Resume:**
  - lo schema dati come base, perché mancano nascita, permesso, scuola, test e riconoscimenti, e le date sono testo libero;
  - l'export PDF (react-pdf con font scaricati da Google Fonts durante il rendering) e l'export DOCX (richiede il `DOMParser` del browser, non include la foto).
- **career-ops:**
  - il template della lettera (inglese, senza destinatario né allegati), la lettera con bullet e ricerca web, il limite di 350-420 parole;
  - le modalità it/de/fr senza regole svizzere;
  - la pipeline Chromium.
- **RenderCV:** la riga di comando Python (Python 3.12 contro `nodejs22`, 1,3-6,7 s per CV, Markdown che altera i fatti).
- **Resume-Matcher:**
  - l'aggiunta delle skill dell'annuncio e l'inserimento keyword in tutte le sezioni;
  - lo score composito;
  - i template stampati con Chromium;
  - la conferma tutto-o-niente.

**Cambia il piano?** Sì, ma solo nel dettaglio:
- la fase 0 sale da 2-3 a 4-6 giorni, perché il gate rifinito combina tre fonti;
- la fase 2 sale da 4-6 a 6-8 giorni, perché si aggiunge il banco di prova CI senza AGPL basato sul checker di Reactive Resume;
- la fase 4 ha ora un modello concreto (modifiche ancorate).

La raccomandazione di fondo (template Typst nostro, gate prima dei layout, font Unicode subito) esce rafforzata: nessuno dei quattro repo offre un'alternativa migliore su lingue svizzere, lettera o veridicità.

---

## 9. Stato dell'implementazione (2 ottobre 2026)

Tutte le fasi del §6 sono implementate nel repository `frontaliere-si-o-no`, una PR per fase in sequenza.

| Fase | PR | Stato |
|---|---|---|
| 0. Gate sui fatti, convenzioni della lettera, notices | #10919 | Mergiata |
| 1. Profilo più ricco, tipo di candidatura | #10934 | Mergiata (review: profilo riletto se precedente alla fase 1, riconoscimento nel primo impiego, «IT» maiuscolo) |
| 2. Renderer Typst, CI ATS, tetto onesto | #10949 | Mergiata (review: costo misurato con `bench-pdf-renderer.mjs`, foto con nome unico, renderer salvato, font non risolto = errore) |
| 3. Foto facoltativa, dossier in un PDF | #10958 | Mergiata (foto mantenuta al round successivo; dossier mai a un apprendista, qualunque forma abbia il tipo) |
| 4. Revisione del CV riga per riga, novità 3.98.0 | #10961 | Mergiata (scelte legate al loro round) |
| 5. DOCX in-place (interruttore spento) | #10972 | Mergiata (review: nessun paragrafo con tabulazione viene riscritto, un'ancora ambigua lascia fuori la riga, un file con le pagine non contate da LibreOffice non viene mai offerto né inviato) |

Differenze rispetto al piano della fase 5:

- **Classificazione dei paragrafi.** Non serve una chiamata al modello: la fa l'ancora della fase 4 (ogni riga indica il punto che riscrive), verificata in codice sul testo del paragrafo.
- **Pagine.** Si ricade sul template quando le pagine aumentano, o quando non si possono contare: senza LibreOffice nel runner, e nelle Cloud Functions dopo scelte riga per riga che cambiano il file. Su D1 una riga più corta riporta in pagina 1 la sezione «Progetti» (da 2 a 1 pagina), e questo va bene.
- **Etichette.** La riga delle competenze con l'etichetta in grassetto («Tecniche:») viene riordinata lasciando l'etichetta com'è.

Prova con LibreOffice 26.8 sui DOCX sintetici:

| DOCX | Esito |
|---|---|
| D1 | 6 righe riscritte, layout identico |
| D2 | Solo le competenze cambiano; profilo con grassetto in linea, data nella riga e righe troppo lunghe restano come nel CV |
| D3 | Ricaduta sul template (casella di testo) |

### Chiusura dei punti aperti (3–4 ottobre 2026)

Le decisioni sui punti del §7 e sugli interruttori sono in [`decisioni.md`](decisioni.md), con le fonti verificate in [`fonti/`](fonti/). PR mergiate in `frontaliere-si-o-no`:

| PR | Cosa |
|---|---|
| #11199 | Via dalla root due screenshot di una console; la root ignora le immagini |
| #11221 | Le pagine della candidatura assistita non entrano nel session replay |
| #11242 | Gli interruttori Remote Config restano leggibili nei log; strumento `rc-switches.mjs`; parametri creati in produzione (typst, separate, off) |
| #11254 | Licenza «tutti i diritti riservati», Termini allineati, note complete sul materiale di terzi |
| #11260 | Autoverifica di Typst nelle Cloud Functions visibile al proprietario (esito in produzione: ok) |
| #11259 | La foto tolta non resta nel CV che parte; i convertitori non vedono i segreti del job |
| #11413 | Lo studio, le fonti verificate e il registro delle decisioni in questa cartella |
| #11425 | Gate dei fatti: una lacuna onesta solo in una frase chiusa; i contatti del CV non sostengono più cifre; la conferma del proprietario vale per i segnali che ha visto |
| #11450 | Lettera ed e-mail con le formule delle fonti svizzere verificate, nelle quattro lingue |
| #11463 | Coda, suggerimenti e avvisi del proprietario allineati a WhatsApp e al profilo «poor» |
| #11488 | Permesso, nazionalità e data di nascita come li indica il candidato, mai un permesso «da richiedere»; CV rifatto a ogni correzione |
| #11505 | Confezione dell'invio secondo le fonti (lettera e CV separati per difetto) e registro dei file partiti, anche per un invio incerto |
| #11539 | Dopo l'invio i documenti partiti restano al candidato nella pagina della candidatura, con una copia Word di lettera e CV; su WhatsApp sceglie il candidato quale CV mandare; il link dell'e-mail dura fino alla cancellazione |
| #11574 | Per un ordine con il consenso al talent pool il link dell'e-mail «candidatura inviata» vale fino a fine consenso: il server lo rifiuta alla revoca o alla cancellazione (regola pronta; il consenso non è ancora raccolto) |

Crediti delle copertine prese da Wikimedia Commons ([`decisioni.md`](decisioni.md) §15), nei due repository:

| PR | Repository | Cosa |
|---|---|---|
| #11430 | sito | Il motore legge i record di credito: ImageObject con autore e licenza, credito in fondo all'articolo |
| nanakokyobashi-rgb/frontaliere-articles#2110 | corpus | Il generatore registra autore e licenza alla scelta della copertina; file dei crediti per la SPA; gate sui contenuti |
| nanakokyobashi-rgb/frontaliere-articles#2120 | corpus | 1 470 record, 1 643 dati strutturati senza la rivendicazione del sito, 9 copertine sostituite |
| #11507 | sito | Credito nella SPA e nelle 44 pagine scritte a mano; re-render completo delle pagine del motore |
| nanakokyobashi-rgb/frontaliere-articles#2129 | corpus | Rivalidazione mensile in sola lettura (prova a secco: 0 problemi) |
| nanakokyobashi-rgb/frontaliere-articles#2133 | corpus | 55 copertine con ritratti, insegne o funzionari sostituite da foto Commons senza persone |

## Appendice: riproducibilità e limiti

- **Strumenti** in `tmp/tools/`, senza toccare il sistema:
  - venv `uv` con rendercv 2.8, typst 0.15, python-docx, PyMuPDF (solo test), pypdfium2, pdfplumber;
  - npm con pdf-lib, @pdf-lib/fontkit, unpdf, tesseract.js 7, word-extractor, typst-ts-node-compiler 0.7.0, docx, docxtemplater;
  - LibreOffice 26.8 estratto dal DMG;
  - xpdf 4.06 (`pdftotext`, `pdffonts`);
  - sorgenti del parser OpenResume scaricati via `gh api`, solo per test locale.
- **Script principali**:
  - `tmp/proto/baseline/baseline.mjs`: codice reale su dati sintetici;
  - `tmp/proto/baseline/gate-proposed.mjs`: gate attuale contro quello proposto;
  - `tmp/proto/inplace/{make_docx,patch_docx,pdf_inplace}.py`;
  - `tmp/tools/node/{ocr2,ats-order,facts,typstts,pdflib-font}.mjs`;
  - `tmp/tools/openresume/run.mts`;
  - `tmp/proto/templates/typst/{build,build_letters}.py`.
- **Limiti delle prove**:
  - i DOCX sintetici sono più puliti di quelli reali (mancano campi, revisioni, `AlternateContent`, SmartArt);
  - il DOC è stato prodotto da LibreOffice;
  - le scansioni sono simulate (rasterizzazione, rotazione di 1,3°, rumore, JPEG);
  - il parser OpenResume è stato «localizzato» da me nelle parole chiave dei titoli;
  - i payload del modello sono scritti a mano: non ho chiamato Codex;
  - i tempi sono misurati su un MacBook Pro 2017 a 2 core, non sul runner né sulle Functions;
  - typst.ts su Cloud Functions non è verificato.
