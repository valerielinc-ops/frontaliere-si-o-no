# Residence locality suggestions

Derived from [GeoNames cities500](https://download.geonames.org/export/dump/),
countryInfo and admin1CodesASCII under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
GeoNames attribution is shown beside the residence field. Source input SHA-256,
generation time, country metadata and exact counts are in `manifest.json`.

The extract includes populated places with more than 500 inhabitants and seats
of administrative divisions down to PPLA4. It is **not an exhaustive registry
of municipalities**. Historical, abandoned and destroyed settlements are
excluded. Names preserve Unicode and are qualified by region when available.
The retired country codes AN and CS are excluded; XK remains available.

The interface loads only the selected country's catalogue, searches locally
and always permits manual town/postal-code entry, including when loading fails.
A suggestion is never evidence of residence, nationality or a work permit.

Regenerate from the repository root with:

```sh
python3 scripts/data/build-residence-localities.py
```

The builder streams public input into temporary files, validates minimum
coverage before replacing catalogues and downloads no candidate information.
