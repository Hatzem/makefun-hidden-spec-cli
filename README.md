# mend

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hatzem/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hatzem/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of files:
unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits. It matches lines at three tiers
(exact, trailing whitespace stripped, both ends stripped), writes files atomically, and refuses unsafe paths.

## Run it

```
node main.ts [options] [PATCH]
```

Node 22, standard library alone. `SPEC.md` is the whole specification. `--check` previews without writing,
`--strict` matches exact lines only. In a trial the last lines of `main.ts` hand over to `runner.ts`
when `MAKEFUN_ENV_URL` is set.

## Practice score

100 of 100 practice checks pass (practice score 1000): unified 30/30, search-replace 20/20, V4A 20/20,
JSON 15/15, CLI 15/15. Verified deterministic across two full runs.

```
node check.ts ../program/generator/practice.json
```
