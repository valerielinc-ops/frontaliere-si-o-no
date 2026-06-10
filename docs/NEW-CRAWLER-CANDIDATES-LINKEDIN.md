# Nuovi crawler — candidati LinkedIn (Switzerland, on-site)

Fonte: LinkedIn Jobs, `geoId=106693272` (Switzerland), filtro **f_WT=1 (solo on-site)**, 2026-06-10.
Metodo: (1) aggregazione frequenza società su ~1000 job on-site recenti (40 pagine); (2) conteggio job on-site per società candidato (keyword search, proxy volume hiring).

Vincoli applicati:
- ❌ già nel sistema (386 crawler-slug esistenti, `data/jobs[/expired]/by-crawler/*` + `crawler-companies-auto.json`)
- ❌ aggregatori / staffing / job-board (Randstad, Adecco, Gi Group, OK JOB, Asoag, swisselect, JobCourier, Jörg Lienert…)
- ❌ pubblica amministrazione / gov (Amministrazione federale, Kantone, Etat de Vaud, fedpol…)
- ✅ solo società single-employer, lavori in sede

## TOP 10 selezionati (per volume job on-site CH)

| # | Società | Job on-site CH (LinkedIn) | Settore | Careers (da confermare al build) |
|---|---------|--------------------------:|---------|----------------------------------|
| 1 | **Stadler Rail** | 170 | Manifattura treni (TG/SG) | stadlerrail.com/.../jobs |
| 2 | **SBB CFF FFS** | 160 | Ferrovie (società AG, operativo on-site) | company.sbb.ch/.../jobs |
| 3 | **Rolex** | 126 | Orologeria (GE) | careers.rolex.com |
| 4 | **Emil Frey** | 90 | Automotive retail (nazionale) | emilfrey.ch/jobs |
| 5 | **Emmi** | 64 | Food/latticini | group.emmi.com career (SuccessFactors) |
| 6 | **Implenia** | 62 | Costruzioni | jobs.implenia.com |
| 7 | **Globus** | 58 | Retail grandi magazzini | globus.ch jobs |
| 8 | **Liebherr** | 52 | Macchinari/gru | liebherr.com/.../career |
| 9 | **Decathlon** | 29 | Retail sport | decathlon.ch joinus |
| 10 | **Sika** | 28 | Chimica/edilizia (SuccessFactors) | sika.com/career |

## Alternati (prossima ondata)

Givaudan 28 · Cartier 23 · IKEA 24 · Geberit 18 · BKW 16 · Hermès 16 · Hilti 15 · Audemars Piguet 14 · Sonova 13 · Straumann 10 · Patek Philippe 10 · Barry Callebaut 6.

## Note
- Migrol "980" scartato (read sospetto/falso match).
- Bell Food, Helvetia, Kuehne+Nagel: conteggio vuoto/basso su LinkedIn → bassa presenza, deprioritizzati.
- SBB: società AG (non amministrazione pubblica), grande workforce operativa on-site → incluso; swap con Givaudan se si preferisce escludere quasi-statali.
- Conteggi = proxy LinkedIn; il volume crawlabile reale va misurato sul careers-site al momento del build.
