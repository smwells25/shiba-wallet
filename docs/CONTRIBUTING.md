# Contributing

This repository is public. Two rules matter more than any other:

1. **No secret is ever committed.** API keys, project ids for paid
   services, recovery phrases and private keys live only in the git-ignored
   `.dev-wallet/` directory or in the app's runtime settings. A pre-commit
   hook and a CI step enforce this (see below).
2. **Everything stays green.** `npm test` must pass before a change is
   committed; CI runs the same command on every push and pull request.

## Toolchain

Node.js 24 (the team uses 24.21.0 via nvm). If your shell still resolves an
older Node first, put Node 24 on PATH before running anything:

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
```

The engine packages are npm workspaces at the repository root. The Expo app
in `app/` is deliberately not a workspace member and has its own lockfile;
it consumes the engine through `file:` dependencies (see `app/README.md`).
Install both trees:

```sh
npm ci                 # repository root: engine packages and their tools
(cd app && npm ci)     # the app's own dependency tree
```

`npm ci` in `app/` works before the engine is built: the `file:`
dependencies are installed as symbolic links (`app/node_modules/@shiba-wallet/core
-> ../../../packages/core`), and the test runner builds the engine before
any app step uses it. CI installs both trees with `--ignore-scripts`, and
the full test run passes that way from a fresh checkout.

## One-time setup: the pre-commit secret scan

Enable the committed hooks once per clone:

```sh
git config core.hooksPath scripts/githooks
# or: npm run hooks:install
```

From then on every `git commit` runs `scripts/githooks/secret-scan.mjs`
over the staged version of each added or modified file and refuses the
commit when it finds:

| Rule | What it matches |
|---|---|
| `alchemy-key` | An Alchemy-style key in a URL path: `/v2/<key>` or `/nft/v3/<key>` (20 or more key characters) |
| `zerodev-project` | A UUID inside an `rpc.zerodev.app` URL, or assigned to `ZERODEV_PROJECT_ID` |
| `nownodes-key` | A key assigned to `NOWNODES_KEY`, sent as an `api-key` value, or a UUID on a line that mentions NOWNodes |
| `mnemonic` | 12 or more consecutive words from the BIP-39 English wordlist, in any letter case; phrases with a valid checksum are named as such |
| `private-key` | `0x` plus 64 hex digits shortly after a word such as key, priv or secret |
| `dev-wallet` | Any value stored in your local `.dev-wallet/` (also the main checkout's when you commit from a linked worktree), or a staged file inside `.dev-wallet/` |

The scanner never prints a value it found, only a shortened form, so its
output is safe to paste into an issue or a CI log.

Accepted values are listed, each with its reason, at the top of
`scripts/githooks/secret-scan.mjs`:

- `REOWN_PROJECT_ID`: the WalletConnect / Reown project id is a public client
  identifier that the app ships on purpose.
- BIP-39 phrases whose entropy is a single repeated byte, such as
  `abandon … about`. These are the published BIP-39 test vectors the tests
  use; they can never protect funds.
- Two synthetic private keys used by offline engine tests.

If the hook flags a value that is genuinely public, add it to that allow
list with a reason in the same commit, so a reviewer sees it. Do not use
`git commit --no-verify` to get around a finding; CI scans the whole tree
again and will fail.

To scan the whole committed tree yourself:

```sh
npm run secret-scan    # node scripts/githooks/secret-scan.mjs --tree HEAD
```

The hook needs `node` (version 14 or later works) and the root
`node_modules` (it reads the BIP-39 wordlist from `@scure/bip39`). If either
is missing it refuses the commit instead of skipping the scan.

## Running the tests

| Command | What it runs |
|---|---|
| `npm test` | Everything, offline: engine build and vitest (five packages), every offline app suite, `expo lint` with zero warnings allowed, the app's `tsc --noEmit`, and `expo export --platform android` as a bundle smoke test. This is what CI runs. |
| `npm run test:live` | The same plus the live suites and live sections (read-only requests to public endpoints, and to keyed endpoints when `.dev-wallet/env` provides the keys). Developer machines only. |
| `npm run test:engine` | Engine build and vitest only. |
| `npm run test:app` | Engine build and the app script suites only. |
| `npm run lint` | Engine build and `expo lint`. |
| `npm run typecheck` | Engine build (which type-checks the engine sources) and the app's `tsc --noEmit`. |
| `npm run bundle` | Engine build and the Android bundle export. |

All of these call `scripts/ci/run.mjs`; pass extra options after `--`, for
example `npm test -- --skip-bundle --verbose`. Options:

- `--mode offline|live` (default offline)
- `--only engine,app,lint,typecheck,bundle` (the engine build always runs
  first)
- `--skip-bundle`, or `SHIBA_CI_SKIP_BUNDLE=1`, to leave out the export
- `--verbose` to stream every step's output
- `--logs-dir <dir>` to keep each step's full output somewhere specific
  (by default a new directory under the system temp directory, printed at
  the start and end of the run)

The runner prints one line per step with its pass and fail counts and
duration, then a summary. A step fails when its process exits non-zero, when
it prints a summary with a non-zero failure count, when an app suite that
should print `N passed, M failed` prints no such line, or when it exceeds its
timeout (its whole process group is then killed, so the runner never hangs;
`SHIBA_CI_TIMEOUT_SCALE=2` doubles every timeout on a slow machine).

### Offline mode

In offline mode the engine tests and app suites run with
`scripts/ci/offline-guard.mjs` preloaded. It refuses every network
connection except loopback, and it makes the `.dev-wallet/` directory look
absent. A suite that only reads `.dev-wallet/env` to decide whether to run
its live section (check-doge, check-indexer) therefore behaves on a
developer machine exactly as it does in CI. The runner reports how many
network attempts and `.dev-wallet` reads it blocked for each step, and a
step that attempted any network connection fails, even if the suite itself
tolerated the refusal.

### Adding an app suite

Every `.mjs` file in `app/scripts/` must be listed in `scripts/ci/suites.mjs`
with its kind (`offline`, `flag-live`, `env-live`, `live` or `helper`); the
runner refuses to start otherwise, so a new suite cannot silently miss CI. A
new suite should end with the line `N passed, M failed` (optionally prefixed
with its name) and exit non-zero when anything failed, and any live section
should run only behind `--live`.

`check-tokens.mjs` is currently classified `live`: it has an offline section
followed by an unconditional live section, so it runs only in live mode
until that section is moved behind `--live`.
