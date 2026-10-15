// Tailored CV of the assisted application (study 2026-10-02, report-cv-lettera §4).
// Input: sys.inputs.data, the JSON of assistedApplicationCvDocument.js buildCvDocument().
// Layout measured for ATS readers: one real column; the dates on a line under the
// role, never in a date column (pdftotext reads a column apart); "Label: value" on
// one line; section titles in capitals in the text itself (OpenResume-style parsers
// find a section by a bold, all-capital line); no icons; embedded OFL font
// (Source Sans 3) so every Latin letter prints (č, ł, ș); smart quotes off so
// "CHF 80'000" keeps its apostrophe.
#let d = json(bytes(sys.inputs.data))
#let accent = rgb("#1f3a5f")

#set document(title: "CV " + d.name, author: d.name)
#set page(paper: "a4", margin: (x: 2cm, top: 1.8cm, bottom: 1.6cm))
#set text(font: "Source Sans 3", size: 10.2pt, lang: d.language, region: "ch", hyphenate: false)
#set smartquote(enabled: false)
#set par(leading: 0.55em, spacing: 0.7em, justify: false)

#let heading-line(title) = {
  v(0.9em)
  block(below: 0.45em, text(weight: "bold", size: 10.5pt, tracking: 0.04em, fill: accent, upper(title)))
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

// Header: name, headline, contact; the photo, when the candidate gave one, on the right.
#let photo = d.at("photo", default: none)
#grid(columns: if photo != none { (1fr, auto) } else { (1fr,) }, column-gutter: 0.6cm,
  {
    text(size: 21pt, weight: "bold", fill: accent, d.name)
    if d.headline != "" { linebreak(); text(size: 11pt, d.headline) }
    if d.contact.len() > 0 { v(0.3em); text(size: 9.8pt, d.contact.join("  ·  ")) }
  },
  ..if photo != none { (image(photo, width: 3cm),) } else { () },
)

#if d.personal.len() > 0 {
  heading-line(d.at("personalTitle", default: ""))
  pairs(d.personal)
}
#for s in d.sections {
  heading-line(s.title)
  if s.at("text", default: none) != none { s.text }
  if s.at("pairs", default: none) != none { pairs(s.pairs) }
  if s.at("list", default: none) != none { list(spacing: 0.45em, ..s.list) }
  for it in s.at("items", default: ()) { entry(it) }
}
