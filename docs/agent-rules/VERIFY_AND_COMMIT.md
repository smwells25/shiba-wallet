# Agent rules — verifying, committing, worktrees and the scratchpad

Read this before verifying a slice, committing, pushing, creating a
worktree, or keeping files that must survive in the scratchpad. Moved
verbatim from the standing rules of AGENTS.md on 2026-11-20; other tasks
do not need it.

## Later rules (read first; they supersede the older text below)

Collected on 2026-11-20 from the phase records, each with the date it
was learned:

- Worktrees are APFS clones made by `.local/helpers/mkwt.sh <name> [ref]`
  (set SHIBA_SCRATCHPAD to the session's scratchpad folder). The
  symlink-farm worktree described below is retired (2026-10-20), and in a
  clone worktree the runner's bundle step passes, so --skip-bundle is
  only a time saver.
- "Recorded here" below means AGENTS.md (a summary of at most five
  lines) and docs/phases/phase-NN.md (the full record).
- Check CI with `.local/helpers/ci-check.sh <commit> [poll-seconds]`
  (git-ignored; it reads the public GitHub API). This Mac has no `gh`
  binary.
- Touch the scratchpad at the START of every day's work; an idle gap of
  three days loses everything under /private/tmp (2026-10-25, 2026-11-15).
- A patch cut against an older base must be re-applied on the current
  HEAD before its runner result means anything: check the apply exit
  code and the suite count, not only "ALL GREEN" (2026-11-09).
- A worktree that takes a patch touching packages/ must rebuild its
  engine dist (`npm run build`) before running app suites (2026-11-08).
- Run check-screen-protection, check-devmode and check-readiness on any
  docs change too: they pin sentences in the docs (2026-10-14).
- A fixture recorded from zone-dependent output is recorded under
  TZ=UTC; CI runs in UTC (2026-10-27).
- When agents share a working tree, stage hunks or a verified patch
  (`git apply --cached`), never whole files (2026-10-19).

## The original standing rules (verbatim)

- Every slice is verified by the CTO in an isolated worktree with the
  offline runner before it is pushed, then recorded here, then CI is
  checked. When several agents work in the main checkout at once, a
  slice's commit must stage shared registries (scripts/ci/suites.mjs,
  readiness ids, check-readiness expectations) from a FILTERED copy that
  holds only the lines whose files are in that commit; the verify run
  and the commit must use the same snapshot of the diff (2026-10-10: a
  registration added by another agent between the verify run and the
  commit broke CI with "lists scripts that do not exist").
  When a record is appended from a shell heredoc, quote the delimiter
  (<<'EOF') and substitute the commit hash afterwards: an unquoted
  heredoc executed a backticked example command and blanked a sentence
  (2026-10-11). The verify worktree must resolve @shiba-wallet/* to ITS OWN
  packages: its app/node_modules is a real directory of symlinks into
  the main checkout's app/node_modules except @shiba-wallet, whose
  entries point at the worktree's packages (lesson of 2026-10-09: with
  a plain symlinked app/node_modules the app checks ran against the
  main checkout's dist, i.e. whatever another agent was building).
  A VERIFY RUN IS VALID ONLY IF ITS APPLY STEP SUCCEEDED: before the
  checkout run `git reset --hard` AND `git clean -fd -e node_modules`
  (an untracked file from a previous apply blocks the checkout and the
  runner then silently tests the OLD tree — 2026-10-14, twice: the
  printed counts equalled HEAD's), print the checkout and apply exit
  codes and the changed-file count, and compare the touched suites'
  counts with the agent's report before trusting ALL GREEN.
  RUN THE WORKTREE RUNNER WITH --skip-bundle IN A SYMLINK-FARM WORKTREE
  (SUPERSEDED IN PART 2026-10-28: in an APFS-clone worktree made by
  .local/helpers/mkwt.sh the bundle step PASSES — pass p23-build ran the
  runner with it, 2,318 modules — so --skip-bundle there is a time saver,
  not a necessity): the expo-export bundle
  smoke test passes only in the main checkout (Metro follows the
  worktree's node_modules symlinks only into folders it watches, and
  the worktree's workspace root is itself — 2026-10-18: "Unable to
  resolve module expo" after an hour of cache and Watchman theories);
  the bundle step is covered by `npm test` in the main checkout and by
  CI.
- THE SESSION SCRATCHPAD LIVES UNDER /private/tmp, WHICH macOS CLEANS
  DAILY (files not touched for three days are deleted around 00:00
  local time): on 2026-10-14 it deleted 269–270 tracked files and the
  .git link of BOTH the Metro worktree wt-app and the verify worktree
  wt-verify (restored with `git ls-files -d -z | xargs -0 git checkout
  --` after recreating the `gitdir:` file), and the phase-15 page
  builder. Before every verify or Metro run, check `git worktree list`
  for "prunable" and `git ls-files -d`; keep helpers that must survive
  in the git-ignored .local/ folder of the main checkout (.local/fu
  holds the shareable-page builder and its base, .local/helpers the
  co-signer helper and the emulator / dev-build scripts), never only
  in the scratchpad; `find <scratchpad> -type f -exec touch {} +`
  buys three more days for the rest (the JDK, Gradle caches and
  node_modules clones).
