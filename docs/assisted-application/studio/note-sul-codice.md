# Note sul codice attuale (origin/main 7823f78481, 2026-10-02)

## Flusso
- Upload CV: PDF / DOC (OLE2) / DOCX (ZIP), verifica magic bytes (assistedApplicationCvCheck.js).
- Runner GH Actions (draft.mjs): readCvText (unpdf / OCR tesseract via apt / document.xml / antiword via apt) → Codex profile ∥ requirements → match → documents; tailored CV in parallelo.
- PDF lettera: buildCoverLetterPdf (runner) e RI-RENDER in Cloud Functions a ogni modifica del candidato
  (assistedApplicationReview.js:241, 512MiB/60s) e dell'owner (AutomationAdmin.js:198). → il motore della lettera DEVE girare in Functions (o la rigenerazione va spostata).
- CV adattato: solo runner (buildTailoredCvPdf), mai rigenerato dopo modifiche; il candidato sceglie tailored/original (radio), non può modificarlo.
- Invio email: allegati separati `CV_<stem>.<ext>`, `<Motivationsschreiben|Lettera...>_<stem>.pdf`, extra docs. Nessun dossier unico.
- functions deps: solo unpdf per i PDF; Node 22.

## Punti deboli
1. renderPdf: Helvetica Type1 NON incorporata, WinAnsi → ogni carattere fuori cp1252 diventa "?" (č ć đ ł ő ș ț ğ ı ...). Nome del candidato in testa a CV e lettera. Larghezze accentate approssimate a 556. Niente kerning, sillabazione, link, tag PDF/UA, PDF/A, /Lang.
2. CV adattato: niente dati personali svizzeri (data di nascita, nazionalità, permesso G/B, indirizzo) anche se il profilo li ha; profilo senza sezioni progetti/stage/Schnupperlehre/hobby/referenze/volontariato/patente → il CV adattato PERDE contenuti del CV originale (grave per apprendisti e IT). Prima pagina sempre stessa struttura (sommario+competenze) anche per un 15enne.
3. Nessun template per tipo (apprendista, primo impiego, qualificato, sanità, IT) né per regione (foto DE-CH).
4. Gate fatti CV adattato: buildFactIndex senza claimSources → tool NON controllati in headline/summary (solo numeri/email/url/telefono). Bullet e competenze hanno filtri propri (toolTokens/groundedInCv). DA VERIFICARE con test.
5. Gate fatti lettera: numeri accettati anche dall'annuncio (posting tra le sources) → "5 Jahre Erfahrung" dell'annuncio passa se il modello lo attribuisce al candidato. Tool invece solo da fonti del candidato. Gate solo lessicale: affermazioni qualitative ("ho guidato un team") non controllate.
6. ATS report: strutturale del tailored sempre alto per costruzione (cvMethod 'pdf'); copertura keyword misurata sul testo che il modello ha scritto apposta (Goodhart) → serve parser esterno + metriche di esito.
7. Lettera: layout non SN 010130 (posizioni finestra, data, spazio firma 22pt ≈ 8mm), niente "Beilagen/Annexes/Allegati", firma solo dattiloscritta, nessun template per tipo (apprendistato: scuola, stage, perché questo mestiere), nessun controllo in codice di lunghezza / ß→ss / formule regionali; prompt vieta "Hiermit bewerbe ich mich" (ok) ma FR richiede formule di cortesia lunghe.
8. letterSubject usa title con pensum ("80-100%") e forme "/a" ("Infermiere/a") non accordate al genere del candidato.
9. Pagina di revisione: lettera editabile come testo libero, CV non editabile; nessuna anteprima delle differenze tra CV originale e adattato (cosa è stato riscritto/scartato è visibile solo all'owner).
10. DOC: solo testo via antiword; nessuna conversione in DOCX.
