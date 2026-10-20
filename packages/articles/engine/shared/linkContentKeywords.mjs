import { matchContentLinks } from './contentLinkVocabulary.mjs';

/** Link prose with a shared article budget; preserve existing anchors, code and headings. */
export function linkContentKeywords(text, locale = 'it', { matcher = matchContentLinks, enabledIds, isEnabled = /** @type {(id: string) => boolean} */ (() => true), destinations = {}, maxLinks = 3, usedIds = new Set() } = {}) {
 if (!text) return text;

 // 1. Build a stripped copy (no * chars) with a position map back to the original
 const posMap = []; // posMap[strippedIdx] → originalIdx
 let stripped = '';
 for (let i = 0; i < text.length; i++) {
 if (text[i] !== '*') {
 posMap.push(i);
 stripped += text[i];
 }
 }

 // 2. Find all formatting spans (**bold** / *italic*) in the original text.
 // Delimiters must not cross a newline — otherwise a stray unpaired `*` (e.g. a
 // `* ` list bullet marker on one line) pairs with an unrelated `*` many lines
 // later, producing a bogus span thousands of characters long that then inflates
 // an unrelated keyword-link match in step 4.
 const fmtSpans = [];
 const fmtRe = /(\*\*([^\n]+?)\*\*)|(\*([^*\n]+?)\*)/g;
 let fm;
 while ((fm = fmtRe.exec(text)) !== null) {
 fmtSpans.push([fm.index, fm.index + fm[0].length]);
 }

 // 3. Detect pre-existing [text](nav:action)/[text](https://...)/[text](/path) links so
 // we skip those regions — otherwise a keyword match landing inside an already-linked
 // phrase (e.g. "offerte di lavoro" inside "[offerte di lavoro in Ticino](/cerca-lavoro-ticino/)")
 // gets wrapped again, nesting a [word](nav:action) inside the existing brackets and
 // corrupting the markdown.
 const existingLinkSpans = [];
 const existingTargets = new Set();
 const usedActions = usedIds;
 const navLinkRe = /\[([^\]]+)\]\(nav:([a-z0-9\-]+)\)/g;
 let nlm;
 while ((nlm = navLinkRe.exec(text)) !== null) {
 existingLinkSpans.push([nlm.index, nlm.index + nlm[0].length]);
 usedActions.add(nlm[2]); // mark action as already linked
 }
 const urlLinkRe = /\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g;
 let ulm;
 while ((ulm = urlLinkRe.exec(text)) !== null) {
 existingLinkSpans.push([ulm.index, ulm.index + ulm[0].length]);
 existingTargets.add(ulm[0].slice(ulm[0].lastIndexOf("](") + 2, -1));
 for (const [id, destination] of Object.entries(destinations)) {
   if (ulm[0].endsWith(`](${destination})`)) usedActions.add(id);
 }
 }
 // Code, headings and HTML remain literal, including attributes and URLs.
 const htmlProtectedRe = /<(a|code|pre|script|style|h[1-6])\b[^>]*>[\s\S]*?<\/\1>/gi;
 for (const m of text.matchAll(htmlProtectedRe)) existingLinkSpans.push([m.index, m.index + m[0].length]);
 const protectedRe = /```[\s\S]*?```|`[^`\n]+`|^\s*#{1,6}\s+.*$|^[ \t]*[*-][ \t]+(?:\*\*[^*\n]+\*\*|[^:\n]{1,40}):[^\n]*$|<[^>]+>/gm;
 for (const protectedMatch of text.matchAll(protectedRe)) {
 existingLinkSpans.push([protectedMatch.index, protectedMatch.index + protectedMatch[0].length]);
 }

 // 4. Match keyword patterns against the stripped text
 const matches = [];

 for (const m of matcher(stripped, locale)) {
 const action = m.id;
 if (usedActions.has(action)) continue;
 if (enabledIds && !enabledIds.includes(action)) continue;
 if (!isEnabled(action)) continue;
 if (usedActions.size >= maxLinks) break;
 const sStart = m.start;
 const sEnd = m.end;

 // Map stripped range → original range
 let origStart = posMap[sStart];
 let origEnd = sEnd < posMap.length ? posMap[sEnd] : text.length;

 // Skip if this match falls inside a pre-existing nav link
 if (existingLinkSpans.some(([ls, le]) => origStart >= ls && origEnd <= le)) continue;

 // Expand to include any partially-overlapped formatting spans (** / *)
 for (const [fs, fe] of fmtSpans) {
 if (origStart < fe && origEnd > fs) {
 origStart = Math.min(origStart, fs);
 origEnd = Math.max(origEnd, fe);
 }
 }

 // Link text = original segment with all * stripped
 const linkText = text.slice(origStart, origEnd).replace(/\*/g, '');

 // Avoid overlapping matches (including pre-existing links)
 if (matches.some(prev => origStart < prev.origEnd && origEnd > prev.origStart)) continue;
 if (existingLinkSpans.some(([ls, le]) => origStart < le && origEnd > ls)) continue;

 const target = destinations[action] || m.target;
 if (target && (!/^\/(?!\/)/.test(target) || /[\s<>"'()]/.test(target) || existingTargets.has(target))) continue;
 matches.push({ origStart, origEnd, action, linkText, target });
 usedActions.add(action);
 }

 // 5. Apply replacements in reverse order so positions stay valid
 matches.sort((a, b) => b.origStart - a.origStart);
 let result = text;
 for (const m of matches) {
 result = result.slice(0, m.origStart) + `[${m.linkText}](${m.target || `nav:${m.action}`})` + result.slice(m.origEnd);
 }
 return result;
}

