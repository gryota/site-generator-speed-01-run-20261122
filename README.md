# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/gryota/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/gryota/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in replacement for makefun-site 1.0.0 — the same output tree, byte for byte, in a fraction of the CPU time.

`solve.js` reimplements the reference generator from its stated behaviour: the same front matter rules, template dialect, Markdown subset, slug rule and build report. It is original code, written for speed: hand-rolled char-by-char scanners instead of per-line and per-character regexes, a per-case slug cache, bulk HTML escaping, and templates compiled once per case into plain JavaScript functions (with a tree-walking interpreter as fallback). `main.ts` is the harness driver: it reads every case from the input directory, answers each with `run`, and writes the answers out.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7mqjt4kw&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
