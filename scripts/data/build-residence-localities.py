#!/usr/bin/env python3
"""Build lazy country catalogues from GeoNames' CC BY 4.0 cities500 extract.

No live geocoder, account or candidate data. Inputs are streamed to temporary
files; only locality names/regions are published. Run from the repository root.
The catalogue is a suggestion aid, never proof of residence or an exhaustive
municipal registry: manual entry must remain available.
"""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone

BASE = 'https://download.geonames.org/export/dump/'
MAX_DOWNLOAD = 32 * 1024 * 1024


def download(name, folder):
    target = folder / name
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(BASE + name, timeout=60) as response, target.open('wb') as output:
        while chunk := response.read(64 * 1024):
            total += len(chunk)
            if total > MAX_DOWNLOAD:
                raise ValueError('GeoNames input exceeds download budget')
            output.write(chunk)
            digest.update(chunk)
    return target, digest.hexdigest()


def country_rows(text):
    return {row[0]: row[4] for line in text.splitlines()
            if line and not line.startswith('#') and len(row := line.split('\t')) >= 5
            and len(row[0]) == 2 and row[0].isascii() and row[0].isalpha() and row[0].isupper()
            and row[0] not in {'AN', 'CS'}}


def locality_rows(lines, countries, regions):
    grouped = {code: set() for code in countries}
    for line in lines:
        row = line.rstrip('\r\n').split('\t')
        if len(row) != 19 or row[6] != 'P' or row[8] not in grouped:
            continue
        # Retired, destroyed and abandoned settlements are not residence suggestions.
        if row[7] in {'PPLH', 'PPLQ', 'PPLW'}:
            continue
        name = row[1].strip()
        if not name or len(name) > 200:
            continue
        region = regions.get(row[8] + '.' + row[10], '')
        label = name + (' (' + region + ')' if region and region != name else '')
        grouped[row[8]].add(label)
    return {code: sorted(labels, key=str.casefold) for code, labels in grouped.items()}


def build(output):
    hashes = {}
    with tempfile.TemporaryDirectory(prefix='residence-geonames-') as temporary:
        folder = Path(temporary)
        country_path, hashes['countryInfo.txt'] = download('countryInfo.txt', folder)
        countries = country_rows(country_path.read_text(encoding='utf-8'))
        region_path, hashes['admin1CodesASCII.txt'] = download('admin1CodesASCII.txt', folder)
        regions = {row[0]: row[1] for line in region_path.read_text(encoding='utf-8').splitlines()
                   if len(row := line.split('\t')) >= 2}
        archive, hashes['cities500.zip'] = download('cities500.zip', folder)
        with zipfile.ZipFile(archive) as source:
            member = source.getinfo('cities500.txt')
            if member.file_size > 128 * 1024 * 1024:
                raise ValueError('GeoNames extract exceeds read budget')
            with source.open(member) as raw:
                catalogues = locality_rows(io.TextIOWrapper(raw, encoding='utf-8'), countries, regions)
    count = sum(map(len, catalogues.values()))
    if len(countries) < 200 or count < 150_000:
        raise ValueError('Incomplete GeoNames extract; refusing to replace catalogue')
    output.mkdir(parents=True, exist_ok=True)
    for code, labels in catalogues.items():
        (output / (code + '.json')).write_text(json.dumps(labels, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    manifest = {'source': BASE, 'license': 'CC-BY-4.0', 'attribution': 'GeoNames',
                'generatedAt': datetime.now(timezone.utc).isoformat(), 'sha256': hashes,
                'countries': countries, 'counts': {code: len(values) for code, values in catalogues.items()}, 'total': count}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'countries': len(countries), 'localities': count}))


if __name__ == '__main__':
    build(Path('data/residence-localities'))
