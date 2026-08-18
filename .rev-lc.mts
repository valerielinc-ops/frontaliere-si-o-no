import { resolveComuneCanton } from './scripts/lib/evergreen-topic-generator.mjs';
import { MUNICIPALITIES as SITE_M } from './data/municipalities';
import { MUNICIPALITIES as CORPUS_M } from '/Users/saggesel/Projects/frontaliere/frontaliere-articles/.claude/worktrees/evergreen-cap/generator/data/municipalities';
const S: any[] = SITE_M as any, C: any[] = CORPUS_M as any;
const lcNames = new Set(C.filter(m=>m.province==='LC').map(m=>m.name));
console.log('LC comuni (per corpus fix #211):', lcNames.size);
const siteGR = S.filter(m=>m?.name && resolveComuneCanton(m)==='Grigioni');
const siteGRsel = siteGR.filter(m=>typeof m.distanceKm==='number' && m.distanceKm<=30).sort((a,b)=>a.distanceKm-b.distanceKm);
console.log('site Grigioni bucket', siteGR.length, 'selected<=30', siteGRsel.length);
const misSel = siteGRsel.filter(m=>lcNames.has(m.name));
console.log('mislabeled-LC selected under NEW radius:', misSel.length);
const old25 = [...siteGR].sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,25);
console.log('mislabeled-LC selected under OLD cap(25):', old25.filter(m=>lcNames.has(m.name)).length);
console.log('examples new:', misSel.slice(0,8).map(m=>`${m.name} ${m.distanceKm}km`));
// how many of these keywords exist in the published file
import fs from 'node:fs';
const pub = JSON.parse(fs.readFileSync('./public/evergreen-comune-topics.json','utf-8'));
const kws = new Set(pub.topics.map((t:any)=>t.keyword));
console.log('published keywords asserting LC->Grigioni:', misSel.filter(m=>kws.has(`vivere a ${m.name} e lavorare in Grigioni da frontaliere`)).length);
