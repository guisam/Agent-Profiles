---
title: "Biome adoption: config, line endings, CI"
author: Samson
date: 2026-10-22
branch: chore-add-biome
cost: { minutes: 5, tokens: 56751 }
touches:
  - ".gitattributes"
  - ".github/workflows/ci.yml"
  - CONTRIBUTING.md
  - biome.json
  - package-lock.json
  - package.json
  - tsconfig.json
  - src/visualizer/index.html
---

## Decided
- Biome 2.6.2 pinned exactly; default formatter style (tabs, 80 cols, double quotes) chosen by the user over matching the old dense style.
- `npm run lint` is now `biome lint`; the old tsc lint flags (noUnusedLocals etc.) moved into tsconfig.json so `typecheck` still enforces them.
- CI runs `npx biome ci` only on ubuntu-latest (same result on every OS).
- biome.json `files.includes` covers src, bin, scripts, test, root *.json; excludes src/visualizer/index.html.

## Tried and ruled out
- Matching the existing style via wide lineWidth: rejected by user preference.

## Watch out
- Local Windows clones use core.autocrlf=true; without `.gitattributes` (`* text=auto eol=lf`) Biome's lf lineEnding flags every file as unformatted.
- The reformat commit is huge (~77 files); keep it separate and list its SHA in .git-blame-ignore-revs.
- Initial lint: 17 noControlCharactersInRegex + 17 useIterableCallbackReturn errors need case-by-case review, not blanket ignores. `npm test` takes >10 minutes.
