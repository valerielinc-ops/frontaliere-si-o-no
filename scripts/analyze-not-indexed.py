#!/usr/bin/env python3
"""Analyze 'Crawled - currently not indexed' URLs from Google Search Console."""
import csv, os, sys

csv_path = '/Users/saggesel/Downloads/frontaliereticino.ch-Coverage-Drilldown-2026-03-06 (5)/Tabella.csv'
urls = []
with open(csv_path, 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        url = row['URL'].replace('https://www.frontaliereticino.ch', '')
        urls.append(url)

blog, jobs, tools = [], [], []
for u in urls:
    if any(s in u for s in ['articoli-frontaliere', 'cross-border-articles', 'grenzgaenger-artikel', 'articles-frontalier']):
        blog.append(u)
    elif any(s in u for s in ['cerca-lavoro-ticino', 'find-jobs-ticino', 'jobs-im-tessin', 'trouver-emploi-tessin']):
        jobs.append(u)
    else:
        tools.append(u)

print(f'Total: {len(urls)}, Blog: {len(blog)}, Jobs: {len(jobs)}, Tools: {len(tools)}')
print()

locales = {'it': 0, 'en': 0, 'de': 0, 'fr': 0}
for u in blog:
    if u.startswith('/en/'): locales['en'] += 1
    elif u.startswith('/de/'): locales['de'] += 1
    elif u.startswith('/fr/'): locales['fr'] += 1
    else: locales['it'] += 1
print(f'Blog by locale: {locales}')
print()
print('=== BLOG ===')
for u in blog: print(f'  {u}')
print()
print('=== JOBS ===')
for u in jobs: print(f'  {u}')
print()
print('=== TOOLS/OTHER ===')
for u in tools: print(f'  {u}')

# Check which exist in dist
print()
dist = 'dist'
print('=== EXISTENCE CHECK ===')
for u in urls:
    path = u.rstrip('/')
    dir_file = os.path.join(dist, path.lstrip('/'), 'index.html')
    flat_file = os.path.join(dist, path.lstrip('/') + '.html')
    has_dir = os.path.exists(dir_file)
    has_flat = os.path.exists(flat_file)
    size = os.path.getsize(dir_file) if has_dir else (os.path.getsize(flat_file) if has_flat else 0)
    status = 'EXISTS' if (has_dir or has_flat) else 'MISSING'
    print(f'  {status} ({size:>6}B) {u}')
