# Third-party notices

This repository includes third-party material that stays under its own licence: the code adapted from MIT projects,
the agent prompts and skills, the web assets, the fonts, the machine-learning model and the data listed below, with
their copyright notices. The licence texts are reproduced in this file, in [`LICENSES/`](LICENSES/) and next to the
fonts. Everything else created by or for Frontaliere Ticino is covered by [`LICENSE.md`](LICENSE.md); third-party
open data, job postings, company logos and images belong to their owners (see `LICENSE.md`).

## Code adapted from MIT projects

Parts of the assisted application ("candidatura assistita") are adapted from the
open-source projects below. Each is distributed under the MIT License; its
copyright notice and permission notice are reproduced here as the license
requires.

| Project | Used in |
|---|---|
| [career-ops](https://github.com/career-ops-hq/career-ops) | `functions/src/assistedApplicationTailoredCv.js`, `assistedApplicationAts.js`, `assistedApplicationAiFactCheck.js`, `assistedApplicationAiPrompts.js` (requirements, documents), `assistedApplicationLegitimacy.js`, `assistedApplicationFollowup.js`, `assistedApplicationInterviewPrep.js`, `lib/toolVocabulary.js` (skill vocabulary); `scripts/assisted-application/lib/liveness.mjs` (posting-liveness classifier, ported from `liveness-core.mjs`, with Italian and Swiss German patterns added) |
| [Reactive Resume](https://github.com/reactive-resume/reactive-resume) | `functions/src/assistedApplicationAiPrompts.js` (CV extraction rules), `lib/toolVocabulary.js` (tool aliases) |
| [hiring-agent](https://github.com/interviewstreet/hiring-agent) | `functions/src/assistedApplicationAiPrompts.js` (fairness rule of the match) |

## career-ops

MIT License

Copyright (c) 2026 Santiago Fernández de Valderrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Reactive Resume

MIT License

Copyright (c) 2026 Amruth Pillai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## hiring-agent

MIT License

Copyright (c) 2025 HackerRank

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Acknowledgements (no code included)

The portal runner's form reading and filling (`scripts/assisted-application/lib/portal/fields.mjs`,
`scripts/assisted-application/lib/portal/fill.mjs` and the generated
`scripts/assisted-application/extension/runner-fields.js`) follow techniques used by
[OfferOS](https://github.com/averatec0773/offeros) (Apache-2.0, Copyright 2026 averatec0773):
label resolution from `label[for]`, ARIA attributes and the wrapping `<label>`, popups found
through `aria-controls`/`aria-owns`, and Workday-style listbox buttons. The code is our own; no
OfferOS source is reproduced (compared with the upstream files on 2026-10-03).

`functions/src/lib/cvPeriod.js` reads the dates of a CV in the CV's own language, an idea taken from
[Reactive Resume](https://github.com/reactive-resume/reactive-resume)'s `ats/period.ts` (MIT); the code is our own.

## Fonts (SIL Open Font License 1.1)

| Font | Files | Copyright |
|---|---|---|
| Source Sans 3 | `functions/assets/fonts/` (PDFs of the assisted application) | Copyright 2010-2022 Adobe, with Reserved Font Name 'Source' |
| Inter | `public/fonts/inter-latin.woff2` | Copyright 2016 The Inter Project Authors |
| Space Grotesk | `public/fonts/space-grotesk-latin.woff2` | Copyright 2020 The Space Grotesk Project Authors |
| Roboto | `public/fonts/Roboto-Regular.ttf`, `public/fonts/Roboto-Bold.ttf` | Copyright 2011 The Roboto Project Authors |

The licence text ships next to the files: `functions/assets/fonts/OFL.txt` and `public/fonts/OFL.txt`. The fonts may
not be sold on their own and stay under the OFL wherever they are embedded or served.

## Apache License 2.0

| Project | Files | Copyright |
|---|---|---|
| [Prebid.js](https://github.com/prebid/Prebid.js) | `public/assets/prebid.js` (a build of 11.23.0-pre with the modules listed in its header) | Copyright 2017 PREBID.ORG, INC |
| [impeccable](https://github.com/pbakaus/impeccable) (agent skill, v3.9.1) | `.github/skills/impeccable/`, except `scripts/modern-screenshot.umd.js` | Copyright 2025–2026 Paul Bakaus |

The licence text is in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt), and next to the served bundle in
`public/assets/prebid.js.LICENSE.txt`. Prebid.js publishes no NOTICE file. impeccable added a `NOTICE.md` after
v3.9.1, the version included here; it concerns `reference/ios.md` and `reference/android.md`, which are not in this
repository (checked on 2026-10-03).

## MIT-licensed files included as they are

| Project | Files | Copyright |
|---|---|---|
| [superpowers](https://github.com/obra/superpowers) | `.github/prompts/*.prompt.md` (agent prompts adapted from its skills) | Copyright (c) 2025 Jesse Vincent |
| [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `.github/prompts/ui-ux-pro-max/` | Copyright (c) 2024 Next Level Builder |
| [modern-screenshot](https://github.com/qq15725/modern-screenshot) | `.github/skills/impeccable/scripts/modern-screenshot.umd.js` | Copyright (c) 2021-present wxm |
| [Fun Hooks](https://github.com/snapwich/fun-hooks) | bundled inside `public/assets/prebid.js` | Copyright Rich Snapp |

### superpowers

https://github.com/obra/superpowers

```
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### UI UX Pro Max

https://github.com/nextlevelbuilder/ui-ux-pro-max-skill

```
MIT License

Copyright (c) 2024 Next Level Builder

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### modern-screenshot

https://github.com/qq15725/modern-screenshot

```
The MIT License (MIT)

Copyright (c) 2021-present wxm

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Fun Hooks

https://github.com/snapwich/fun-hooks

```
Copyright Rich Snapp

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Machine-learning model (GNU Affero General Public License 3.0)

| Model | File | Licence | Source |
|---|---|---|---|
| YOLOv8n by [Ultralytics](https://github.com/ultralytics/ultralytics) | `scripts/models/yolov8n.onnx` | AGPL-3.0 | ONNX export of `yolov8n.pt`, from the Hugging Face repository `SpotLab/YOLOv8Detection` at revision `3005c6751fb19cdeb6b10c066185908faf66a097` |

`scripts/analyze-webcam-frame.mjs` uses the model, unmodified, to count vehicles in the frames of the border webcams.
The licence text is in [`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt); the model's source is the Ultralytics
repository linked above, and `scripts/download-yolo-model.mjs` records how the file was obtained and its SHA-256.

## Data

| Dataset | File | Licence |
|---|---|---|
| [NameDatabases](https://github.com/smashew/NameDatabases), first names | `scripts/lib/first-names.json` | The Unlicense (public-domain dedication) |
