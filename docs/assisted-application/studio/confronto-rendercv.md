# RenderCV al posto del template nostro? Confronto misurato

Data: 2 ottobre 2026. Solo lettura ed esperimenti locali usa e getta, con dati **sintetici** (i tre CV dello studio).
Cartella di lavoro: `la cartella di lavoro dello studio/research/rcv/` (d'ora in poi `rcv/`). GitHub interrogato solo tramite lo shim `gh`.
Codice letto: wheel `rendercv 2.8` nel venv dello studio. Il `lib.typ` del wheel coincide con `main`: git blob `284c5799…` per entrambi (`gh api …/contents/src/rendercv/renderer/rendercv_typst/lib.typ` e `git hash-object`), e coincide anche con quello scaricato da Typst Universe (verificato con `diff`).

---

## Risposta netta

**Teniamo il template nostro (`ch-cv-inline.typ`). Da RenderCV prendiamo solo idee locali.**

- **RenderCV CLI: no.** Raggiunge 9/9 solo con template di voce personalizzati e titoli di sezione scritti in MAIUSCOLO dal nostro codice (configurazione K5). Però:
  - richiede Python 3.12 o superiore, typst-py, pydantic e Jinja, mentre le Functions girano su `nodejs22`;
  - la pipeline Markdown altera il testo del modello: un bullet con « - » diventa 3 bullet, `<tag>` sparisce, `*x*` diventa corsivo (§3.4).
- **Pacchetto Typst `rendercv` 0.3.0 dentro Node: funziona, ma non serve.** Compilato con typst.ts senza Python (configurazione T1) arriva alla **parità esatta** con il nostro template su tutte le metriche:
  - 9/9 su pdf.js, pdftotext e pdftotext -layout;
  - 51/51 fatti;
  - 0 caratteri Private Use;
  - nome, email ed esperienze FR corretti in OpenResume.

  Non migliora però nessuna metrica. Costa 764 righe di terze parti più l'import di fontawesome, e funziona solo neutralizzando la funzione principale del pacchetto, cioè la colonna delle date (larghezza 0 cm). Resta un piano B documentato se in futuro serviranno più stili grafici.
- **Nessun tema predefinito è ATS-safe.** Tutti e 9 i temi mettono la data in una colonna separata, a destra o a sinistra. `small_caps` non produce maiuscole nel testo estratto.

---

## 1. Cosa c'è nel repository (verificato)

| Elemento | Dove | Cosa contiene |
|---|---|---|
| Pacchetto Typst | `src/rendercv/renderer/rendercv_typst/lib.typ` (764 righe, 27,9 KB), `typst.toml` (`version = "0.3.0"`, `license = "MIT"`, `compiler = "0.14.0"`), `LICENSE` («Copyright (c) 2025 Sina Atalay»), più `examples/*.typ` e `template/main.typ` | Funzione `rendercv()` con circa 80 parametri. Componenti: `headline`, `connections` (va a capo senza separatori orfani), `regular-entry` ed `education-entry` (griglia colonna principale + colonna data), `summary`, `link`, 8 stili per i titoli di sezione, RTL. Importa `@preview/fontawesome:0.6.0` (riga 1) anche quando le icone sono spente. |
| Template Jinja → Typst | `renderer/templater/templates/typst/{Preamble,Header,SectionBeginning,SectionEnding}.j2.typ`, `entries/*.j2.typ` (9 tipi) | Generano il `.typ` che chiama il pacchetto: `#show: rendercv.with(...)`, `= Nome`, `#connections(...)`, `#regular-entry([colonna principale], [data e luogo], main-column-second-row: [...])`. |
| Temi | `schema/models/design/classic_theme.py` più `other_themes/*.yaml` | 9 temi: classic, ember, engineeringclassic, engineeringresumes, harvard, ink, moderncv, opal, sb2nov. |
| Lingue | `schema/models/locale/other_locales/*.yaml` (21 file, più l'inglese nel codice) | DE, FR e IT traducono **solo**: `last_updated`, `month`/`months`, `year`/`years`, `present` («gegenwärtig», «présent», «presente»), `degree_with_area` («DEGREE in AREA», «DEGREE en AREA»), 12 abbreviazioni e 12 nomi dei mesi (FR e IT con l'iniziale maiuscola: «Octobre», «Ottobre»). **I titoli di sezione non sono tradotti**: la PR #742 «Add section_labels to locale» è aperta dal 30-04-2026. |
| Schema | `schema.json`; pydantic in `schema/models/cv/*.py` | Vedi la tabella sotto. |

**Vincoli dello schema**, verificati nel codice e con YAML di prova in `rcv/schema-tests/`:

| Campo | Regola | Prova |
|---|---|---|
| Date | `date` accetta testo libero; `start_date` ed `end_date` vogliono `YYYY-MM-DD`, `YYYY-MM` o `YYYY`, più `present` | `entry_with_date.py`, `entry_with_complex_fields.py`. Con `single_date: MONTH_IN_TWO_DIGITS.YEAR` e `language: italian` esce «03.2021 – presente»; con `locale.present: oggi` esce «03.2021 – oggi» (`dates.typ`, `dates_override.typ`). |
| Telefono | `pydantic_extra_types.PhoneNumber`: obbligatorio il prefisso internazionale | `phone.yaml` con «079 555 01 23» viene rifiutato: «This is not a valid phone number». |
| Sezioni | Un solo tipo di voce per sezione, dedotto dalla prima voce | `mixed.yaml` (esperienza più testo libero) viene rifiutato: «RenderCV detected the entry type of this section to be ExperienceEnt…». |
| Titoli di sezione | La chiave YAML diventa il titolo; se contiene spazi o maiuscole resta com'è | `section.py`, `dictionary_key_to_proper_section_title`. Il titolo MAIUSCOLO lo può quindi decidere il nostro codice. |
| Foto | Path relativo al YAML oppure URL | `cv.py`, campo `photo`. |
| Email | `pydantic.EmailStr` | `cv.py`. |

## 2. Opzioni di design per un layout ATS-safe

- **Date in linea:** nessun tema le prevede. Tutti hanno `date_and_location_column` non vuota: `DATE` oppure `LOCATION\nDATE`, in colonna destra; in `moderncv` la colonna è a sinistra. Si ottengono **solo con template personalizzati**:

  ```yaml
  templates:
    experience_entry:
      main_column: "**POSITION**, COMPANY\nDATE · LOCATION\nSUMMARY\nHIGHLIGHTS"
      date_and_location_column: ""
  entries:
    date_and_location_width: 0cm
    short_second_row: false
  ```

  Questa è la base di K4, K5 e T1.
- **Icone:** con `header.connections.show_icons: false` i caratteri Private Use scendono da 3 (U+F3C5, U+F0E0, U+F095 in DE e FR) a 0, e OpenResume legge l'email pulita.
- **Maiuscole:** `typography.small_caps.section_titles: true` (temi ink, opal, ember) usa `smallcaps()`, e il testo estratto resta «Expérience professionnelle» (`schema-tests/ink_nurse.pdf`). Non esiste un'opzione «uppercase»: servono chiavi di sezione già in MAIUSCOLO (K5) oppure `upper()` nel Typst (T1).
- **Sillabazione:** l'allineamento predefinito `justified` attiva la sillabazione e pdf.js spezza le parole:
  - «Au↵gust 2027» in harvard e «Franzö↵sisch» in moderncv: un fatto perso in ciascuno;
  - rimedio: `typography.alignment: left` oppure `justified-with-no-hyphenation`.
- **Link:** senza `display_urls_instead_of_usernames: true` LinkedIn e GitHub mostrano solo lo username. In K1, K2 e K3 mancano quindi i fatti `linkedin.com/in/…` e `github.com/…`.

## 3. Esperimento

**Script:**
- `rcv/make.py` copia i tre YAML dello studio e varia il blocco `design`. Solo K5 e K6 cambiano anche le chiavi di sezione in MAIUSCOLO.
- `rcv/measure.mjs`, `rcv/openresume-batch.sh` e `rcv/gen-rcv.mjs` (T1) misurano e generano.

**Metriche:**
- coppie data↔ruolo, con la stessa regola di `ats-order.mjs`;
- fatti, come in `facts.mjs`;
- caratteri Private Use (PUA) in pdf.js e pdftotext;
- parser OpenResume locale, avviato con `loc`.

**Dati «allineati».** I YAML originali dello studio differiscono dal JSON del template nostro in due punti:
- infermiera: posizione «Infirmière» con «médecine interne» nel datore, mentre nel JSON è «Infirmière en médecine interne»;
- sviluppatore: «inglese C1, tedesco B1» in minuscolo.

Così la coppia 09.2019 dell'infermiera fallisce in **tutte** le configurazioni RenderCV per ragioni di dati, e mancano 2 fatti. La tabella principale usa i dati allineati al JSON (`ALIGN` in `make.py`) per confrontare solo il layout. La riga sotto la tabella riporta i dati originali, con il solo blocco `design` variato.

### 3.1 Tabella (dati allineati; somma sui 3 candidati IT, FR, DE)

| Config | Cosa | pdf.js | pdftotext | -layout | Fatti | PUA | OpenResume: nome | email | esperienze FR |
|---|---|---|---|---|---|---|---|---|---|
| K0 originale | classic (DE, FR) e sb2nov (IT) dello studio | 7/9 | **0/9** | 6/9 | 51/51 | **3 glifi** (DE, FR) | 3/3 | **1/3** (icona `` attaccata) | 0/2 |
| K1 | classic senza icone | 6/9 | **0/9** | 6/9 | 49/51 | 0 | 3/3 | 3/3 | 0/2 |
| K2 | harvard | 9/9 | 4/9 | 7/9 | 48/51 | 0 | 3/3 | 2/3 (DE «bewerbung7f3k») | 0/2 |
| K3 | moderncv senza icone (date a sinistra) | 9/9 | 9/9 | 9/9 | 48/51 | 0 | **1/3** | 2/3 | 0/2 |
| K6 | moderncv, allineamento `left`, URL visibili, titoli MAIUSCOLI | 9/9 | 9/9 | 9/9 | 51/51 | 0 | **1/3** (DE: «PERSÖNLICHE ANGABEN») | 3/3 | **0/2** |
| K4 | classic con date in linea (solo `design`) | **9/9** | **9/9** | **9/9** | **51/51** | 0 | 3/3 | 3/3 | **0/2** (titoli non riconosciuti) |
| **K5** | K4 più chiavi di sezione MAIUSCOLE | **9/9** | **9/9** | **9/9** | **51/51** | **0** | **3/3** | **3/3** | **2/2** |
| **T1** | pacchetto Typst in Node (typst.ts), JSON nostro, `upper()` | **9/9** | **9/9** | **9/9** | **51/51** | **0** | **3/3** | **3/3** | **2/2** |
| RIF | `ch-cv-inline.typ` (template nostro) | 9/9 | 9/9 | 9/9 | 51/51 | 0 | 3/3 | 3/3 | 2/2 |

Prove: `rcv/measure.txt` (riepilogo in fondo) e `rcv/openresume-results.txt`. Pagine: 1, 1, 1 per tutte le configurazioni, compresa T1 dopo aver stretto margini e spaziature. Con i default di RenderCV (margini 0,7 in, nome 30 pt) l'apprendista andava su 2 pagine.

**Con i dati originali** (solo `design` variato):

| Config | pdf.js | pdftotext | -layout | Fatti |
|---|---|---|---|---|
| K0 | 7/9 | 0/9 | 5/9 | 49/51 |
| K4 e K5 | 8/9 | 8/9 | 8/9 | 49/51 |

K0 riproduce esattamente la riga RenderCV del report. In K4 e K5 l'unico errore è la coppia 09.2019 dell'infermiera, dovuta ai dati.

### 3.2 Cosa mostrano i numeri

1. **Sì, esiste una configurazione RenderCV a 9/9 su tutti gli estrattori: K5, e T1 per il pacchetto.** Servono tre cose insieme:
   - template di voce personalizzati (data e luogo in linea, colonna di 0 cm);
   - niente icone;
   - titoli MAIUSCOLI scritti dal nostro codice.

   Con il solo `design` (K4) l'ordine è perfetto, ma OpenResume non riconosce «Expérience professionnelle» e trova 0 esperienze FR su 2.
2. **Il look tabellare con date a sinistra (K3 e K6) passa il test delle coppie ma non è ATS-safe:**
   - in pdftotext la prima data di ogni sezione esce **prima** del titolo di sezione, in 3 candidati su 3 (es. IT: titolo a carattere 319, «03/2021» a 303);
   - OpenResume perde il nome in 2 candidati su 3 e le esperienze FR.

   La metrica a coppie da sola sovrastima questo layout. Aggiungere il controllo «titolo di sezione prima della prima data».
3. **harvard (K2)**, l'unico tema predefinito con l'aspetto più «pulito», resta a 4/9 su pdftotext.

### 3.3 Bug e limiti del templating RenderCV emersi

- **Asterischi letterali nel PDF.** `**DEGREE_WITH_AREA**` con il titolo di studio (DEGREE) assente produce «Diplôme d'État d'infirmier\*︎\*︎» nel PDF (`rcv/bugs/degree_with_area_bold_nurse_fr.{typ,pdf}`). La rimozione dei segnaposto lascia orfani i `**`. Ho evitato il problema con `DEGREE_WITH_AREA, **INSTITUTION**`.
- **Simbolo invisibile dopo l'asterisco.** Un `*` letterale nel testo diventa `#sym.ast.basic`, che pdftotext estrae come `*` seguito da U+FE0E (`schema-tests/escaping.pdf`).

### 3.4 Il testo del modello passa da un parser Markdown

Prova in `schema-tests/escaping.yaml` → `.pdf`:

| Input (bullet) | Esce |
|---|---|
| «Planung - Umsetzung - Test von 3 Projekten» | **3 bullet**: `process_highlights` sostituisce « - » con un sotto-bullet |
| «Text mit \*Sternchen\* und \`Code\` und \<tag\>» | «Text mit *Sternchen* und Code und» (**«\<tag\>» sparisce**) |
| «C# … snake_case … $100 … @team» | corretto (escape di `#`, `_`, `$`, `@`) |

Lo stesso testo passato come stringa Typst (`#"…"`) al pacchetto in T1 esce **identico, carattere per carattere** (`schema-tests/escaping-t1.pdf`). Per un flusso con un gate sui fatti, il testo che entra nel PDF deve essere quello controllato: le alterazioni silenziose di RenderCV CLI non vanno bene.

## 4. Pacchetto Typst dentro Node (typst.ts), senza Python

Prove in `rcv/gen-rcv.mjs` e `rcv/universe/compile.mjs`.

| Variante | Come risolve `@preview/rendercv` | Prima compilazione | Successive | Memoria (RSS) |
|---|---|---|---|---|
| T1 vendorizzato | `lib.typ` copiato in `vendor/rendercv/`, import di fontawesome riscritto su `vendor/fontawesome/` (copiato dalla cache esistente) | create 128 ms; 61 ms (apprendista con foto); 17 e 15 ms per gli altri | 1-2 ms | 72-75 MB |
| T1 stub | come sopra, ma `#let fa-icon(..args) = none` | create 68 ms; 25 ms | 1-2 ms | 61-64 MB |
| Universe | `.typ` generato da RenderCV (K5) compilato così com'è; typst.ts scarica il pacchetto da packages.typst.org (136 KB) | **425 ms** (download compreso) | 2 ms | non misurata |
| RenderCV CLI (Python) | pacchetto incluso nel wheel | **1,3-6,7 s per CV** (mediana 2,2 s su 39 esecuzioni, processo Python avviato ogni volta) | n/d | n/d |
| RIF template nostro (studio) | n/d | 120 ms | 1-6 ms | 63 MB |

**Dettagli verificati:**
- **Stub di fontawesome.** Il PDF compilato con lo stub è **identico byte per byte** a quello con fontawesome vero (`cmp`, `nurse_fr.pdf`). Con le icone spente, fontawesome è peso morto.
- **Versione del compilatore.** typst.ts 0.7.0 include Typst **0.14.2** (campo `Creator` del PDF), compatibile con `compiler = "0.14.0"`. RenderCV CLI usa typst-py 0.15.0. Il testo `-layout` del PDF Universe è identico a quello del CLI (`diff` vuoto).
- **Input atteso dal pacchetto.** È il `.typ` di `rendercv_output`:
  - preambolo `#show: rendercv.with(…)` con circa 80 parametri;
  - `= Nome`, `#headline`, `#connections`;
  - per ogni sezione `== Titolo` seguito da `#regular-entry(...)` o da paragrafi.

  I titoli e le voci vanno emessi **al livello superiore** del documento, perché `group-sections` scorre `doc.children`.

  In T1 lo genero in JS (92 righe con le etichette DE/FR/IT) dai JSON dello studio. Tutti i testi entrano come stringhe Typst, quindi non serve alcun escaping del markup.
- **Cache.** In `~/Library/Caches/typst/packages/preview/` c'era già `fontawesome/0.6.0`, creato alle 11:35 dallo studio precedente, non da me. Il mio test Universe ha creato `rendercv/0.3.0` e **l'ho cancellato**; la cache è tornata allo stato iniziale. `~/Library/Application Support/typst` non esiste.

**Dipendenza da Python e Jinja nel nostro flusso:**
- **RenderCV CLI:** sì. Richiede Python 3.12 o superiore, `jinja2`, `markdown`, `phonenumbers`, `pydantic[email]`, `ruamel-yaml`, più typst-py (64 MB) e rendercv-fonts (61 MB) (`METADATA` del wheel). Le Functions sono `nodejs22` (`functions/package.json` e `firebase.json` del sito): servirebbe un secondo runtime, oppure il CV solo nel runner.
- **Pacchetto Typst con typst.ts:** **no.** Bastano `lib.typ` vendorizzato più lo stub (circa 28 KB) e lo stesso addon nativo già previsto nel piano (46 MB per darwin-x64; build linux su Functions **non verificata**, come nel report).

## 5. Lettera

**RenderCV non genera lettere.**
- Il wheel non contiene template di lettera: solo `Header`, `Preamble`, `Section*` ed `entries/*`.
- `grep -ri cover` nel pacchetto non trova nulla di pertinente.
- La ricerca `gh api "search/issues?q=repo:rendercv/rendercv+cover+letter"` dà 5 risultati:
  - #12 (2024): spostata nelle Discussions;
  - PR #13 (2024), #241 (2024) e #672 (2026): tutte chiuse **senza merge** (`merged: false`);
  - #771: non pertinente.
- Il maintainer, sulla #672, il 24-02-2026: «adding cover letter support would broaden the package's scope quite a lot … I'm not very keen on adding cover letter support right now».
- Non c'è roadmap: non ho trovato issue o milestone aperte sulle lettere. La lettera resta comunque su `ch-letter.typ` nostro.

## 6. Qualità e manutenzione

| Aspetto | Dato | Prova |
|---|---|---|
| Test | 58 file `.py` in `tests/`; snapshot di riferimento in `tests/renderer/testdata/test_typst` (18) e `test_pdf_png` (27) | `research/rendercv_tree.txt` |
| CI | Matrice ubuntu, windows e macos × Python 3.12, 3.13 e 3.14, coverage con soglia smokeshow 90 | `.github/workflows/test.yaml` via `gh api` |
| Stato della CI | Ultimo push su `main` verde il 25-03-2026. Le ultime 8 run su PR (18-23 settembre 2026) sono tutte `failure`; nella run 35908930840 falliscono i 9 job della matrice e il pre-commit. Causa **non verificata**. | `gh run list --workflow test.yaml` |
| Release | v2.0 (07-01-2025) … v2.8 (21-03-2026): 9 release in 14 mesi, poi **nessuna da 195 giorni**. `main` ha 52 commit non rilasciati (tra cui «Fix placeholder removal eating provided placeholders…» e fontawesome incluso nel wheel). Pacchetto Typst: 0.1.0 (05-12-2025), 0.2.0 (16-02-2026), 0.3.0 (20-03-2026). | `gh api …/releases`, `compare/v2.8...main`, `CHANGELOG.md` |
| Attività | Ultimo commit su `main` il 25-03-2026. 0 PR mergiate dopo il 26-03-2026; 42 PR e 53 issue aperte. | `gh api …/commits`, `search/issues` |
| Bus factor | `sinaatalay` ha 1600 commit su 1764 dei primi 10 contributori (**91%**). Il secondo umano ne ha 31. «I don't work on RenderCV full-time» (#672). | `gh api …/contributors?per_page=10` |
| Dichiarazioni ATS | Issue #769, aperta: «Generated PDFs don't actually target PDF/UA-1, despite `ats_compatibility.md`'s compliance claim». Le nostre misure: i temi predefiniti fanno 0-4/9 su pdftotext. | `search/issues … ATS` |

## 7. Cosa riusare

| Cosa (file RenderCV) | Uso nel piano | Fase | Effort | Obblighi MIT |
|---|---|---|---|---|
| Idea: chiavi o etichette di sezione decise dal codice e in MAIUSCOLO; data e luogo in linea; niente icone; `alignment: left` (niente sillabazione); URL visibili | Già nelle regole del report; aggiungere ai test CI il controllo «titolo di sezione prima della prima data» e il test della sillabazione | 2 | 0,5 giorni | Nessuno (solo idee) |
| `lib.typ` → `connections()`, circa 60 righe: contatti che vanno a capo senza separatori orfani | Da riscrivere nel nostro header: oggi uniamo con «·» e a capo il separatore può restare a fine riga (**non verificato** sul nostro template) | 2 | 0,5 giorni | Se copiamo il codice: tenere copyright e licenza MIT (Sina Atalay 2025) nel file o in `THIRD_PARTY_NOTICES` |
| `other_locales/{german,french,italian}.yaml` → `month_names` | Data della lettera («2. Oktober 2026», «le 2 octobre 2026», «2 ottobre 2026»): Typst non localizza i mesi. Correzioni: **minuscole** in FR e IT; «present» → «heute», «aujourd'hui», «oggi» | 0 (c), poi 2 | 0,1 giorni | Nessuno di fatto: sono 36 parole, non codice. Citazione facoltativa. |
| Idea dallo schema: telefono validato in E.164 (`phonenumbers`) e date rigorose `YYYY-MM` più `present`, rese dal codice con un modello per lingua (`date_range`, `single_date`) | Campi del profilo con validazione in Node (es. `libphonenumber-js`, MIT, **non valutata**); date normalizzate e rese «MM.YYYY» dal codice, mai dal modello | 1 | 0,5-1 giorni | Nessuno (solo idee) |
| Idea dai test: snapshot `.typ` e PDF per tema in `tests/renderer/testdata` | Fixture sintetiche con PDF e testo estratto in CI (già nel piano) | 2 | Incluso | Nessuno |
| **Piano B:** `lib.typ` 0.3.0 vendorizzato più lo stub di fontawesome più il generatore JS (`rcv/gen-rcv.mjs`) | Al posto di `ch-cv-inline.typ`, solo se servono più stili (8 tipi di titoli, RTL, temi) | 2 | +1-1,5 giorni, più una nuova verifica a ogni aggiornamento | Copia di `LICENSE` (MIT, Sina Atalay 2025) accanto al file. Con fontawesome vero, anche la sua `LICENSE` (MIT, duskmoon314 2023); con lo stub, nessuna. Il repo del sito non ha licenza (decisione aperta 7 del report): MIT è compatibile purché le note restino. |
| RenderCV CLI, temi, `markdown_parser` | **Non riusare** | n/d | n/d | n/d |

## 8. Rischi

**Riusando il pacchetto Typst (piano B):**
1. **API giovane.** Tre versioni in 4 mesi (0.1 → 0.3), con nuovi parametri (`entries-degree-width` dalla 0.2.0).
2. **Compilatore vincolato.** `compiler = "0.14.0"`; il passaggio di typst.ts a Typst 0.15 o successivi non è verificato.
3. **Dipendenza da un trucco.** La colonna data a 0 cm sfrutta un dettaglio interno di `regular-entry` (`grid(columns: (1fr, width))`).
4. **Grouping fragile.** I titoli vanno emessi al livello superiore: generare con un ciclo `#for` in Typst romperebbe `group-sections` (dedotto dal codice, **non provato**).
5. **fontawesome.** Va vendorizzato o sostituito con lo stub, altrimenti il primo avvio scarica da Universe: 425 ms e rete richiesta nelle Functions.

**Riusando RenderCV CLI:**
1. **Doppio runtime** (Python e Node) e 1,3-6,7 s per CV.
2. **Testo del modello alterato** prima del PDF (§3.4).
3. **Telefono:** i numeri nazionali vengono rifiutati.
4. **Templating fragile:** il bug di `**DEGREE_WITH_AREA**`.
5. **Sezioni:** un solo tipo di voce per sezione.
6. **Nessuna lettera:** servirebbe comunque un secondo motore.
7. **Manutenzione:** bus factor di circa 1, nessuna release da 6 mesi, CI delle PR rossa.

**In ogni caso:**
- la metrica a coppie data↔titolo non vede la data prima del titolo di sezione (K3 e K6): va affiancata da un controllo strutturale;
- il parser OpenResume è AGPL e localizzato a mano, quindi va usato solo in locale.

## Riproducibilità

```bash
J=la cartella di lavoro dello studio
# RenderCV CLI, 13 configurazioni × 3 CV (circa 1 minuto ogni 6 configurazioni su questo Mac)
cd $J/research/rcv && ../../tools/venv/bin/python make.py
# Pacchetto Typst in Node (T1); "stub" = fontawesome sostituito da uno stub
node gen-rcv.mjs && node gen-rcv.mjs stub
# Metriche: ordine data↔ruolo, fatti, PUA
cd $J/tools/node && XPDF=$J/tools/xpdf-tools-mac-4.06/bin64 node ../../research/rcv/measure.mjs
# Parser OpenResume (path dei PDF come argomenti)
$J/research/rcv/openresume-batch.sh <pdf…>
```

File prodotti in `rcv/`:
- `runs/<config>/<cv>.{yaml,typ,pdf}`;
- `measure.txt` e `openresume-results.txt`;
- `png/` (anteprime);
- `schema-tests/` (date, telefono, sezioni miste, escaping, ink);
- `bugs/`;
- `vendor/` (`lib.typ`, LICENSE, fontawesome, stub);
- `universe/` (prova di download; la cache è stata cancellata).

**Limiti:**
- 3 CV sintetici;
- tempi misurati su un MacBook Pro 2017 a 2 core, con carico variabile (OpenResume in background durante alcune esecuzioni);
- il parser OpenResume è localizzato dallo studio;
- typst.ts sulle Cloud Functions non è verificato;
- la causa dei fallimenti nella CI di RenderCV non è verificata.
