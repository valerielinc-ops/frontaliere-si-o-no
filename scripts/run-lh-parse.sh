#!/bin/bash
cd /Users/saggesel/Projects/frontaliere-si-o-no
rm -f lighthouse-fresh.json
npx lighthouse http://localhost:4173 --output json --output-path lighthouse-fresh.json --chrome-flags='--headless=new --no-sandbox' --preset=perf --only-categories=performance,accessibility,best-practices,seo 2>/dev/null
echo "DONE:$?"
if [ -f lighthouse-fresh.json ]; then
  python3 -c '
import json
r=json.load(open("lighthouse-fresh.json"))
cats = r["categories"]
for k in ["performance","accessibility","best-practices","seo"]:
    if k in cats: print(f"{k}: {int(cats[k][\"score\"]*100)}")
a = r["audits"]
for m in ["first-contentful-paint","largest-contentful-paint","total-blocking-time","speed-index","interactive","cumulative-layout-shift"]:
    if m in a: print(f"  {m}: {a[m].get(\"displayValue\",\"?\")} (score={a[m].get(\"score\",\"?\")})")
'
fi
