// Swiss application letter of the assisted application (study 2026-10-02, report-cv-lettera §5).
// Input: sys.inputs.data, the JSON of assistedApplicationAiDraftCore.js letterPdfBlocks().
// Measures of the KV Schweiz manual (SN 010130 is withdrawn): left margin 25 mm, right
// 20 mm, first line of the address about 52 mm from the top. The official templates of
// the cantonal career services put the address, the place and date and the signature
// on the left in German, on the right (117 mm from the edge) in French and Italian.
#let d = json(bytes(sys.inputs.data))
#let right-side = d.language == "fr" or d.language == "it"
#let col = if right-side { 117mm - 25mm } else { 0mm }

#set document(title: d.title, author: d.signature)
#set page(paper: "a4", margin: (left: 25mm, right: 20mm, top: 15mm, bottom: 18mm))
#set text(font: "Source Sans 3", size: 11pt, lang: d.language, region: "ch", hyphenate: false)
#set smartquote(enabled: false)
#set par(leading: 0.62em, spacing: 1.05em, justify: false)

// Sender (letterhead, at most 38 mm high).
#let sender = d.senderLines.filter(x => x != "")
#block(height: 31mm, {
  if sender.len() > 0 { text(weight: "bold", size: 12pt, sender.at(0)) }
  for line in sender.slice(calc.min(1, sender.len())) { linebreak(); line }
})
#v(6mm)
#pad(left: col, block(height: 32mm, d.recipientLines.filter(x => x != "").join(linebreak())))
#if d.placeDate != "" { pad(left: col, d.placeDate) }
#v(9mm)
#if d.subject != "" { text(weight: "bold", d.subject) }
#v(5mm)
#if d.salutation != "" { d.salutation }
#for p in d.paragraphs [
  #par(p)
]
#v(2mm)
#pad(left: col, {
  if d.closing != "" { d.closing }
  // About 16 mm for a handwritten or scanned signature.
  v(16mm)
  d.signature
})
#if d.enclosures.len() > 0 {
  v(8mm)
  text(size: 10pt, if d.enclosuresLabel != "" [#d.enclosuresLabel: #d.enclosures.join(", ")] else [#d.enclosures.join(", ")])
}
