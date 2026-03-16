#!/bin/bash
cd /Users/saggesel/Projects/frontaliere-si-o-no
npx lighthouse http://localhost:4173 \
  --output json \
  --output-path lighthouse-fresh.json \
  --chrome-flags="--headless=new --no-sandbox" \
  --preset=perf \
  --only-categories=performance,accessibility,best-practices,seo \
  2>/dev/null
echo "LIGHTHOUSE_EXIT:$?"
