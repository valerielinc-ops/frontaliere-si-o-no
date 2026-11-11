// Bilingual Swiss ATS CV Template (IT / DE)
// Ottimizzato per candidati frontalieri e posizioni bilingui (Ticino, Grigioni, Zurigo, Berna).
// Input: sys.inputs.data, JSON conforme a assistedApplicationCvDocument.js buildCvDocument().

#let d = json(bytes(sys.inputs.data))
#let accent = rgb("#1f3a5f")

#set document(title: "CV " + d.name, author: d.name)
#set page(paper: "a4", margin: (x: 2cm, top: 1.8cm, bottom: 1.6cm))
#set text(font: "Source Sans 3", size: 10.2pt, lang: d.at("language", default: "it"), region: "ch", hyphenate: false)
#set smartquote(enabled: false)
#set par(leading: 0.55em, spacing: 0.7em, justify: false)

#let translate-title(title) = {
  let t = lower(title)
  if "esperienza" in t {
    upper("Esperienza professionale / Berufserfahrung")
  } else if "istruzione" in t or "formazione" in t or "ausbildung" in t {
    upper("Istruzione & Formazione / Ausbildung")
  } else if "lingu" in t or "sprach" in t {
    upper("Competenze linguistiche / Sprachkenntnisse")
  } else if "competenz" in t or "kenntnis" in t or "skill" in t {
    upper("Competenze & Tecnologie / Kenntnisse & IT-Skills")
  } else if "personal" in t or "angaben" in t {
    upper("Dati personali & Permesso / Persönliche Angaben")
  } else {
    upper(title)
  }
}

#let heading-line(title) = {
  v(0.9em)
  block(below: 0.45em, text(weight: "bold", size: 10.5pt, tracking: 0.04em, fill: accent, translate-title(title)))
  line(length: 100%, stroke: 0.5pt + accent)
}

#let field(it, key) = it.at(key, default: "")
#let entry(it) = {
  block(above: 0.8em, below: 0.5em, {
    if field(it, "title") != "" { text(weight: "bold", it.title) }
    if field(it, "org") != "" { if field(it, "title") != "" [, ] ; it.org }
    let meta = (field(it, "date"), field(it, "place")).filter(x => x != "")
    if meta.len() > 0 { linebreak(); text(size: 9.4pt, fill: luma(70), meta.join(" · ")) }
    if field(it, "text") != "" { linebreak(); it.text }
  })
  let bullets = it.at("bullets", default: ())
  if bullets.len() > 0 { list(indent: 0.15cm, spacing: 0.45em, ..bullets) }
}
#let pairs(items) = for p in items {
  block(above: 0.45em, below: 0em, if p.at(1) != "" [#text(weight: "bold", p.at(0)): #p.at(1)] else [#text(weight: "bold", p.at(0))])
}

// Header: name, headline, contact; photo optional on the right
#let photo = d.at("photo", default: none)
#grid(columns: if photo != none { (1fr, auto) } else { (1fr,) }, column-gutter: 0.6cm,
  {
    text(size: 21pt, weight: "bold", fill: accent, d.name)
    if d.at("headline", default: "") != "" { linebreak(); text(size: 11pt, d.headline) }
    if d.at("contact", default: ()).len() > 0 { v(0.3em); text(size: 9.8pt, d.contact.join("  ·  ")) }
  },
  ..if photo != none { (image(photo, width: 3cm),) } else { () },
)

#if d.at("personal", default: ()).len() > 0 {
  heading-line(d.at("personalTitle", default: "Dati personali"))
  pairs(d.personal)
}

#for s in d.at("sections", default: ()) {
  heading-line(s.title)
  if s.at("text", default: none) != none { s.text }
  if s.at("pairs", default: none) != none { pairs(s.pairs) }
  if s.at("list", default: none) != none { list(spacing: 0.45em, ..s.list) }
  for it in s.at("items", default: ()) { entry(it) }
}
