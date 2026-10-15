#!/usr/bin/env node
/**
 * Real job-board scorer, isolated from rendering/network, at Chrome CPU 4x.
 * Supply a saved published /data/jobs-it-index.json to keep the corpus identical:
 * node scripts/perf/benchmark-personal-scoring.mjs --data tmp/jobs-it-index.json --out tmp/scoring
 * The two click paths run the synchronous and scheduled implementations against
 * the same scorer and synthetic history at its documented 100/50 entry caps.
 * This is a lab attribution experiment, not a full-board or field-INP result.
 */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (!option('--data')) throw new Error('Required: --data <saved jobs-it-index.json>');
const raw = await readFile(path.resolve(option('--data')));
const jobs = JSON.parse(raw);
const output = path.resolve(option('--out') || path.join(root, 'tmp/scoring-interactions'));
await mkdir(output, { recursive: true });
await build({
 stdin: { resolveDir: root, loader: 'js', contents: `
 import {createPersonalScorer,scorePersonalJobs,schedulePersonalJobScores} from './services/personalizationScoring';
 const jobs = await (await fetch('/jobs.json')).json();
 const behavior = {version:1,lastVisit:null,viewedJobs:jobs.slice(0,100).map(j=>({slug:j.slug,category:j.category,company:j.company,location:j.location,ts:0})),searches:jobs.slice(100,150).map(j=>({query:j.title,ts:0,resultCount:1})),filterUsage:{category:{},location:{},contract:{}},syncedAt:null};
 const previous = new Map();
 for(const canton of ['CH','TI']) for(const mode of ['sync','scheduled']) {
  const button=document.createElement('button'); button.textContent=canton+':'+mode; button.style='display:block;margin:20px;padding:16px';
  button.onclick=()=>{
   window.completed=null; const start=performance.now();
   const pool=canton==='CH'?jobs:jobs.filter(j=>j.canton==='TI');
   const scorer=createPersonalScorer(behavior,null,null);
   const done=scores=>{
    const signature=JSON.stringify([...scores].map(([job,score])=>[job.id,score.score,score.topSignal]));
    if(!previous.has(canton))previous.set(canton,signature);
    window.completed={canton,mode,count:pool.length,elapsed:performance.now()-start,identical:previous.get(canton)===signature};
   };
   if(mode==='sync')done(scorePersonalJobs(pool,scorer));else schedulePersonalJobScores(pool,scorer,done);
  };
  document.body.appendChild(button);
 }
 ` },
 bundle: true, format: 'esm', minify: true, sourcemap: true, outfile: path.join(output, 'entry.js'), alias: { '@': root },
});
const server = createServer(async (req, res) => {
 if (req.url === '/jobs.json') { res.setHeader('Content-Type','application/json'); res.end(raw); return; }
 if (req.url === '/entry.js') { res.setHeader('Content-Type','text/javascript'); res.end(await readFile(path.join(output,'entry.js'))); return; }
 res.setHeader('Content-Type','text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><script type="module" src="entry.js"></script>');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser = await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.addInitScript(()=>{
  window.events=[];window.tasks=[];
  new PerformanceObserver(l=>window.events.push(...l.getEntries().map(e=>({duration:e.duration,start:e.startTime,id:e.interactionId,name:e.name})))).observe({type:'event',durationThreshold:16,buffered:true});
  new PerformanceObserver(l=>window.tasks.push(...l.getEntries().map(e=>({duration:e.duration,start:e.startTime})))).observe({type:'longtask',buffered:true});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForSelector('button');
 await cdp.send('Tracing.start',{categories:'devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler',transferMode:'ReturnAsStream'});
 const records=[];
 for(const canton of ['CH','TI']) for(let i=0;i<5;i++) for(const mode of ['sync','scheduled']) {
  await page.evaluate(()=>{window.events=[];window.tasks=[];window.completed=null;window.actionStart=performance.now();});
  await page.getByRole('button',{name:canton+':'+mode,exact:true}).click();
  await page.waitForFunction(()=>window.completed!==null);
  await page.waitForTimeout(150);
  const row=await page.evaluate(()=>({...window.completed,events:window.events.filter(e=>e.start>=window.actionStart),tasks:window.tasks.filter(e=>e.start>=window.actionStart)}));
  if(!row.identical)throw new Error('Scheduled scores differ from synchronous scores');
  records.push(row);
 }
 const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
 await cdp.send('Tracing.end');const {stream}=await complete;let trace='';
 for(;;){const chunk=await cdp.send('IO.read',{handle:stream});trace+=chunk.data;if(chunk.eof)break;}
 await cdp.send('IO.close',{handle:stream});await writeFile(path.join(output,'trace.json'),trace);
 await writeFile(path.join(output,'measurements.json'),JSON.stringify({browser:browser.version(),cpuSlowdown:4,corpusCount:jobs.length,corpusSha256:createHash('sha256').update(raw).digest('hex'),scope:'isolated scoring click paths, synthetic capped history, no board rendering or third parties',records},null,2));
 console.log(JSON.stringify(records.map(r=>({canton:r.canton,mode:r.mode,count:r.count,maxEventMs:Math.max(0,...r.events.map(e=>e.duration)),maxTaskMs:Math.max(0,...r.tasks.map(e=>e.duration)),elapsedMs:Math.round(r.elapsed),identical:r.identical})),null,2));
} finally {
 await browser?.close();await new Promise(resolve=>server.close(resolve));
}
