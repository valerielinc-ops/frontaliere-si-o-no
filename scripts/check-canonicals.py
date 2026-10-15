#!/usr/bin/env python3
"""Check canonical tags for the 26 URLs flagged as 'alternative page with proper canonical'."""
import os, re

base = "dist"
urls = [
    "?p",
    "?q={search_term_string}",
    "tasse-e-pensione/dichiarazione-redditi/",
    "fr/impots-et-retraite/ristornes-fiscaux/",
    "en/cross-border-articles/cross-border-tax-returns-clash-ticino-lombardy-health-tax/",
    "fr/articles-frontalier/taxe-sante-tensions-augmentent-ticino/",
    "en/taxes-and-pension/tax-return-guide/",
    "en/taxes-and-pension/tax-refunds/",
    "guida-frontaliere/tempi-attesa-dogana/clivio-ligornetto/",
    "guida-frontaliere/tempi-attesa-dogana/san-pietro/",
    "articoli-frontaliere/mostra-nakba-giubiasco-riflessione-culturale-ticino/",
    "calcola-stipendio/stipendio-netto-60000-chf-residenza-oltre-20km/",
    "articoli-frontaliere/franco-forte-effetti-stipendio-frontalieri/",
    "articoli-frontaliere/mostra-daniela-rebuzzi-caslano-arte-ticino/",
    "fr/plan-du-site/",
    "glossario-frontaliere/nuovo-accordo-2024/",
    "articoli-frontaliere/accordi-ue-svizzera-firma-vicina-cosa-cambia-frontalieri/",
    "articoli-frontaliere/frontaliere-nuovo-accordo-fiscale-2026-simulazione/",
    "de/beratung/",
    "calcola-stipendio/stipendio-netto-60000-chf/",
    "articoli-frontaliere/tassa-salute-aumentano-tensioni-ticino/",
    "articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-mozione-ticino/",
    "articoli-frontaliere/supsi-daniela-willi-piezzi-direttrice-dipartimento-formazione/",
    "calcola-stipendio/stipendio-netto-80000-chf-nuovo-frontaliere-2026/",
    "articoli-frontaliere/",
    "statistiche/",
]

for url in urls:
    if url.startswith("?"):
        idx = os.path.join(base, "index.html")
        if os.path.exists(idx):
            html = open(idx).read()
            canon = re.search(r'<link rel="canonical" href="([^"]*)"', html)
            print(f"QP  /?{url[1:]:60s} canon: {canon.group(1) if canon else 'NONE'}")
        continue

    path = url.rstrip("/")
    idx_file = os.path.join(base, path, "index.html")
    flat_file = os.path.join(base, path + ".html")

    if os.path.exists(idx_file):
        html = open(idx_file).read()
        canon = re.search(r'<link rel="canonical" href="([^"]*)"', html)
        canon_val = canon.group(1) if canon else "NONE"
        expected = f"https://frontaliereticino.ch/{url}"
        if canon_val == expected or canon_val == expected.rstrip("/"):
            status = "SELF-REF"
        else:
            status = f"POINTS-TO: {canon_val}"
        print(f"DIR {url:60s} {status}")
    elif os.path.exists(flat_file):
        html = open(flat_file).read()
        canon = re.search(r'<link rel="canonical" href="([^"]*)"', html)
        canon_val = canon.group(1) if canon else "NONE"
        print(f"FLT {url:60s} POINTS-TO: {canon_val}")
    else:
        print(f"404 {url:60s} NO STATIC PAGE (falls to SPA index.html)")
