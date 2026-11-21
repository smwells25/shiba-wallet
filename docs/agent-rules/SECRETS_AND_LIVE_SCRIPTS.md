# Agent rules — secrets and live test-network scripts

Read this before running any script under scripts/testnet, or anything
else that needs a key from the git-ignored .dev-wallet/ folder. Written
on 2026-11-20 from the phase records; other tasks do not need it.

## The rule

No agent opens, prints, copies or lists anything under .dev-wallet/,
except in the five ways below, or where the main session's brief
allows a named helper that reads it. Nothing read from it is ever printed,
logged, committed or put in a report.

1. The pre-commit secret scan reads it by itself when `git commit` runs.
   Commit with plain `git commit`, never with a hooks-path override.
2. A scripts/testnet script that signs with the dev mnemonic reads it by
   itself. Run it from the main checkout's root: a worktree has no
   .dev-wallet/.
3. A script whose header loads keys with `set -a; . .dev-wallet/env; set +a`
   (kernel-smoke.mjs, token-gas-smoke.mjs and ten others) is run
   exactly that way, inside ONE subshell that runs only that script and
   echoes no variable:

   ```
   ( set -a; . .dev-wallet/env; set +a; <the variables its header names> node scripts/testnet/<script>.mjs )
   ```

   Never source .dev-wallet/env into a shell that goes on to run anything
   else: the exported values change other scripts' live switches.
4. A script whose live mode takes a mnemonic file (an option ending in
   MNEMONIC_FILE, as lending-smoke.mjs has) is given one 0600 copy in the
   session scratchpad, never inside the repository, made without printing
   it (for example `install -m 600 .dev-wallet/mnemonic.txt <scratchpad>/m`)
   and deleted after the run. (`rm -P` is what the records used; on this
   macOS its manual says the flag has no effect, so it is a plain delete.)
   A script whose MNEMONIC_FILE option defaults to .dev-wallet/mnemonic.txt
   needs no copy: it falls under way 2.
5. `npm run test:live` (scripts/ci/run.mjs --mode live) leaves .dev-wallet
   visible to the keyed live suites, which read it themselves. The offline
   runner (`npm test`, `npm run test:app`, `npm run test:engine`) hides
   it; run directly in the main checkout, check-doge.mjs and
   check-indexer.mjs read it themselves, so run those two directly only
   in a worktree.

## Who may do it

The CTO (the main session) may do all five. A subagent runs a
scripts/testnet script or the live suites only when its brief names
them, and runs a script live only when the brief says live. A brief that
says to run a script live whose live mode needs a mnemonic file counts
as allowing the one copy in way 4.

## Before any live run

- Read the script's header for its live / dry-run switch. Some send live
  by default: kernel-smoke.mjs with BUNDLER_URL set is NOT a dry run
  (2026-11-07).
- Test networks only (AGENTS.md, Standing rules). Know the fund cap the
  brief or the script sets, and re-read every receipt on a second RPC.
- The scripts import code from the main checkout (app/src and the
  packages' dist): run them only when those files are unedited and the
  engine is built at HEAD (pass p23-build).
- Edit a secrets file by key name, never by the shape of a value (a
  replace by value shape once changed the wrong key, 2026-11-07).
- Never link .dev-wallet/ into a worktree: a symlink is not matched by
  the ignore rule (pass p23-build).
- The env.sh files under .local/helpers/ define redact and dump helpers
  that read .dev-wallet/env: do not source one or call those functions
  unless your brief says so.
- No mask is enough by itself: an API key inside a URL is neither hex nor
  uuid-shaped (a Settings dump printed one in pass p18e). Never dump or
  screenshot a screen while an endpoint, indexer or API-key field is open
  for editing (Edit fills it with the stored value). Never print a dump
  or screenshot that shows a recovery phrase or its quiz, and never
  capture one of the emulator's real wallet; a throwaway wallet's backup
  screen may be captured only into a 0700 folder and deleted after the
  pass. In anything kept, mask runs of 32 or more
  hex characters, uuid-shaped strings and the path of every URL.
