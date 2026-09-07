#!/bin/sh
# Cut a release, and leave the CLI the operator actually runs on the version just cut.
#
#   scripts/release.sh 0.5.12           # bump, tag, push, then update the install checkout
#   scripts/release.sh --install-only   # move an existing install to the newest tag
#   scripts/release.sh --prune-install  # remove superseded version directories, on request
#
# `--force` is GONE (#254), not merely unused. It existed for exactly one refusal -- the
# migration guard -- and that guard was removed because the operation it protected declines on
# its own. A flag still parsed here would be accepted from an operator reaching for it out of
# habit and would change nothing; refused as an unknown flag, it says so.
#   scripts/release.sh 0.5.12 --dry-run
#
# The install step is the reason this exists (#182). Tagging, packaging and the notes were
# already automatic; the thing anyone runs was not, so v0.5.11 shipped while `conclave
# --version` reported v0.5.10 and ten issues' worth of fixes were reachable by nobody.
#
# ## Why it no longer waits for anybody (#250)
#
# `~/.local/bin/conclave` points at SOURCE, through `bin/conclave`: `node <dir>/bin/conclave.ts`.
# Node resolves
# modules lazily, so REWRITING a checkout under a live process does not swap a binary that is
# already loaded -- it swaps the files that process has NOT IMPORTED YET. A session that later
# reaches a rotation path or a lazy adapter import would read that module from the new commit
# while the rest of it is the old one. A run half on one version is worse than the lag this
# script was written to fix: it behaves like no released version and records one while
# executing two.
#
# That hazard is a property of REWRITING ONE DIRECTORY, not of releasing. It is the layout that
# forced the refusal, so the layout changed. Each tag gets its own worktree, and the PATH
# symlink is repointed at the new one:
#
#   conclave-releases/v0.5.29/  a live run exec'd from here and keeps importing from here
#   conclave-releases/v0.5.30/  built beside it; nothing else is touched
#   ~/.local/bin/conclave -> conclave-releases/v0.5.30/bin/conclave
#
# Node resolves the symlink to its real path at exec and resolves every later import against
# THAT path, so a process started before the swap never sees the new directory. Measured rather
# than reasoned: a lazy `import()` fired after the symlink moved still loaded the old file.
#
# So an ordinary install refuses nobody. ONE refusal survives, for the MIGRATION off the single
# `conclave-stable` checkout, and it is not the old refusal wearing a new name. A version
# directory is safe because its name pins its contents -- nothing will ever write `v0.5.29/`
# again. `conclave-stable` has no such promise: once the symlink leaves it, it is an ordinary
# worktree that somebody may reuse or remove, so migrating out from under a live run strands
# that run in the one directory this scheme stops protecting. That refusal is the ONLY thing
# standing between a live run and the delete at the end of the migration, which is why it is
# written inline where the migration happens rather than in a general-sounding guard.
#
# ## Retention, and why pruning is a separate word an operator has to type
#
# NOTHING IS EVER REMOVED BY A RELEASE OR AN INSTALL. Old versions accumulate, and that is the
# feature: a run that started on v0.5.28 can be read afterwards against the code that actually
# ran it, and disk is cheaper than that evidence. The one exception is the legacy checkout the
# migration replaces, which is removed because it is the directory the new layout cannot keep
# promises about -- and only after the new one is proved and on PATH.
#
# `--prune-install` is the deliberate operation, and every rule it applies is a reason to KEEP:
#
#   the active install                  never a candidate
#   immediate children of the root      nothing nested, nothing outside it
#   named exactly for a release tag     and checked out at that tag's commit
#   a worktree of THIS repository       not a clone, not somebody else's
#   detached                            a branch is somebody's work whatever it is named
#   clean                               uncommitted work is not this script's to discard
#   nothing running from it             the resolved-script test, per candidate
#
# It uses `git worktree remove` per directory, never `git worktree prune` and never `--force`.
# The blanket form decides for itself what is stale, which is the one decision that must not be
# delegated when the operation is a delete; and `--force` exists precisely to override the
# checks above. Anything that fails a rule is reported and kept, so a prune that removes nothing
# is a normal outcome and says why.

set -eu

DRY=0
INSTALL_ONLY=0
LEGACY_LIVE_BEFORE=""
PRUNE_INSTALL=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --install-only) INSTALL_ONLY=1 ;;
    --prune-install) PRUNE_INSTALL=1 ;;
    # Only reaches the migration refusal now, which is the only one left. It does not make the
    # hazard above untrue; it asserts the operator has checked. It does NOT reach the prune:
    # every check there is a reason to keep a directory, and there is no version of "I have
    # checked" that makes deleting one anyway the right answer.
    -*) echo "release: unknown flag $arg" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done

say() { echo "release: $*"; }
run() { if [ "$DRY" = 1 ]; then echo "  would run: $*"; else eval "$@"; fi; }

# ---------------------------------------------------------------------------------------
# Where the installed CLI lives, resolved rather than assumed.
#
# From the symlink on PATH, because that is the thing whose version is wrong when this goes
# wrong. Hardcoding a path would be a second place for the two to drift.
# ---------------------------------------------------------------------------------------
install_dir() {
  bin=$(install_link) || return 1
  # -f resolves the whole chain; the fallback covers systems whose readlink does not.
  target=$(readlink -f "$bin" 2>/dev/null || readlink "$bin" 2>/dev/null || echo "$bin")
  # <dir>/bin/conclave -> <dir>
  dirname "$(dirname "$target")"
}

# The PATH entry ITSELF, unresolved -- which is the thing the install now moves.
#
# `install_dir` resolves the link to find the checkout behind it; this one deliberately stops
# at the link, because repointing it is the whole install step. Two functions rather than one
# with a flag: the difference between "where does this point" and "what is the pointer" is
# exactly the distinction #250 turns on, and collapsing them is how it would get lost.
install_link() {
  bin=$(command -v conclave 2>/dev/null || true)
  [ -n "$bin" ] || return 1
  echo "$bin"
}

# Where version directories live: one directory, beside the repository they come from.
#
#   ~/workspace/conclave/           the repository
#   ~/workspace/conclave-releases/  every installed version, one worktree each
#   ~/workspace/conclave-stable/    the legacy single install, until it is migrated
#
# Derived from the shared git directory rather than hardcoded, so an install made by
# `scripts/install.sh` (a clone under ~/.local/share) and this machine's install (a linked
# worktree under ~/workspace) each land beside themselves rather than in a guess about where
# somebody keeps their checkouts.
#
# ONE named directory, for a reason measured on this machine: `git worktree list` already
# prints twenty entries here, and whatever prunes versions later has to tell a release's
# worktree from somebody's branch. A path prefix decides that without asking anything else.
releases_root() {
  common=$(common_dir "$1") || return 1
  main=$(cd "$common/.." 2>/dev/null && pwd -P) || return 1
  echo "$(dirname "$main")/conclave-releases"
}

# The repository behind a checkout, as one absolute physical path.
#
# Two worktrees of the same repository answer identically and a separate clone does not, which
# is what "the same repository" means everywhere below. `--git-common-dir` is relative in a main
# checkout (`.git`) and absolute in a linked worktree, so both spellings are normalised -- the
# install is a worktree, a fresh `scripts/install.sh` clone is not, and a comparison between the
# two spellings of one directory would say they were different repositories.
common_dir() {
  d=$(cd "$1" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$d" in /*) ;; *) d="$1/$d" ;; esac
  (cd "$d" 2>/dev/null && pwd -P) || return 1
}

# The checkout's OWN git directory, absolute.
#
# Equal to `common_dir` for exactly one checkout of a repository: the main one. That is the
# distinction that keeps `git worktree remove` from ever being pointed at a clone -- it cannot
# remove one, and asking it to would be asking to delete the repository itself.
git_dir_of() {
  d=$(cd "$1" 2>/dev/null && git rev-parse --git-dir 2>/dev/null) || return 1
  case "$d" in /*) ;; *) d="$1/$d" ;; esac
  (cd "$d" 2>/dev/null && pwd -P) || return 1
}

# A release tag, exactly.
#
# This used to be the shell pattern `v[0-9]*.[0-9]*.[0-9]*`, which is a GLOB and not a version
# test. `*` matches anything, including dots and slashes, so all of these passed it:
#
#   v1.2.3-rc1      a pre-release, which is not a version this script installs
#   v9x.9y.9z       three fields none of which are numbers after the first digit
#   v1.2.3.4.5      any number of extra fields
#
# The name is the whole claim a directory makes about itself before anything else is asked of
# it, so the test for it has to be the exact one: `v`, then three dot-separated decimal fields
# with no leading zeros, and then the end of the string. `grep -E` because /bin/sh has no
# regular expressions of its own and a longer glob would only be a longer approximation.
is_release_tag() {
  printf '%s' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}

# ---------------------------------------------------------------------------------------
# The ownership record: what says this installer made a directory (#250).
#
# Every other rule the prune applies is about what a directory LOOKS like, and a human can
# reproduce all of them in one command:
#
#     git worktree add --detach ~/workspace/conclave-releases/v0.5.28 v0.5.28
#
# That is a clean, detached worktree of this repository, under the releases root, named exactly
# for a release tag and checked out at it. It passes every identity check, and it is somebody
# else's directory. Looking like an install is not being one, so the scripts that make installs
# write down that they did.
#
# OUT OF THE WORKTREE, under `<root>/.installed/`. Anything inside the version directory is
# inside a git checkout: `git status` would report it, `git worktree remove` would refuse over
# it, and a person building a worktree by hand could copy one in without understanding what they
# were asserting. A hidden sibling is written by exactly two programs and read by three, and it
# is skipped by the `"$root"/*` scan for free because the glob does not match a leading dot.
#
# It binds FOUR things, and a record matching three of them is a record for something else:
#
#   path    the directory's physical path -- a record moved or copied to another name is void
#   repo    the repository's common dir  -- another clone's worktree cannot borrow one
#   ref     the tag or ref installed
#   commit  what that ref pointed at when it was installed
#
# THE SAME FORMAT IS WRITTEN BY `scripts/install.sh`, which cannot source this file: it is
# fetched and piped to `sh` from a URL, with no sibling to read. So the format is duplicated,
# and the duplication is pinned by a test that installs with one script and reuses with the
# other -- if the two spellings drifted, that reuse would be refused rather than silently
# accepted.
# ---------------------------------------------------------------------------------------
installed_record() { echo "$1/.installed/$2.rec"; }

installed_record_field() {
  # The first line with this key, anchored, so a value containing `repo=` cannot be read as a
  # second key.
  sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1
}

# Written by rename, for the same reason the PATH symlink is: a half-written record describes a
# directory nothing will reuse and nothing will prune, which is a stuck install rather than a
# wrong one -- but there is no reason to accept either.
write_installed_record() {
  rec_root="$1"; rec_name="$2"; rec_dir="$3"; rec_repo="$4"; rec_ref="$5"; rec_commit="$6"
  mkdir -p "$rec_root/.installed"
  rec_file=$(installed_record "$rec_root" "$rec_name")
  printf 'path=%s\nrepo=%s\nref=%s\ncommit=%s\n' \
    "$rec_dir" "$rec_repo" "$rec_ref" "$rec_commit" > "$rec_file.tmp.$$"
  mv -f "$rec_file.tmp.$$" "$rec_file"
}

# Whether a record exists and describes exactly this directory. NOTHING IS ADOPTED: an absent
# record and a wrong one get the same answer, because "it looks like one of ours" is the belief
# this whole mechanism exists to stop acting on.
installed_record_matches() {
  rec_root="$1"; rec_name="$2"; rec_dir="$3"; rec_repo="$4"; rec_ref="$5"; rec_commit="$6"
  rec_file=$(installed_record "$rec_root" "$rec_name")
  [ -f "$rec_file" ] || return 1
  [ "$(installed_record_field "$rec_file" path)" = "$rec_dir" ] || return 1
  [ "$(installed_record_field "$rec_file" repo)" = "$rec_repo" ] || return 1
  [ "$(installed_record_field "$rec_file" ref)" = "$rec_ref" ] || return 1
  [ "$(installed_record_field "$rec_file" commit)" = "$rec_commit" ] || return 1
  return 0
}

# ---------------------------------------------------------------------------------------
# Readiness: a SECOND marker, and the reason it is not a field in the record.
#
# The record answers "who made this directory". It cannot answer "is this directory finished",
# because it is written the moment the worktree exists -- before `npm ci`, before anything has
# been run out of it. An install that dies in between leaves a directory that is owned, has a
# partial `node_modules`, and passes every ownership check there is. The old shape then skipped
# provisioning because `node_modules` existed, and put that on PATH.
#
# Two files rather than one field, because they answer at different times and a single file
# rewritten twice would put ownership at risk of a torn write on the second pass. The pair is
# ordered: ownership at creation, readiness only after dependencies are provisioned AND the
# directory has answered `--version` out of its own path.
#
# The marker carries the commit, so a `.ready` copied from another directory certifies nothing.
# ---------------------------------------------------------------------------------------
installed_ready() { echo "$1/.installed/$2.ready"; }

mark_installed_ready() {
  rdy_file=$(installed_ready "$1" "$2")
  mkdir -p "$1/.installed"
  printf 'commit=%s\n' "$3" > "$rdy_file.tmp.$$"
  mv -f "$rdy_file.tmp.$$" "$rdy_file"
}

installed_is_ready() {
  rdy_file=$(installed_ready "$1" "$2")
  [ -f "$rdy_file" ] || return 1
  [ "$(installed_record_field "$rdy_file" commit)" = "$3" ] || return 1
  return 0
}

# Whether the checkout is STILL what its record describes.
#
# The record says who made the directory and what was put in it. It cannot say what has happened
# since: a worktree can be checked out to another commit, put on a branch, edited, or replaced
# by a directory of the same name, none of which touches the file the record lives in. So reuse
# asks both questions, and this is the second one -- same repository, a linked worktree of it,
# detached, on the recorded commit, and clean.
checkout_unchanged() {
  chk_dir="$1"; chk_repo="$2"; chk_commit="$3"
  [ "$(common_dir "$chk_dir" 2>/dev/null)" = "$chk_repo" ] || return 1
  [ "$(git_dir_of "$chk_dir" 2>/dev/null)" != "$chk_repo" ] || return 1
  # In an `if`, not `&& return 1`: an AND-list that ends non-zero is fatal under `set -e`, so
  # the natural spelling of this line would abort the script on the ordinary case.
  if git -C "$chk_dir" symbolic-ref -q HEAD >/dev/null 2>&1; then return 1; fi
  [ "$(git -C "$chk_dir" rev-parse --verify --quiet HEAD 2>/dev/null)" = "$chk_commit" ] || return 1
  [ -z "$(git -C "$chk_dir" status --porcelain 2>/dev/null)" ] || return 1
  return 0
}

# Repoint the PATH entry, without a moment where it is missing.
#
# `ln -sfn` aimed straight at the live name unlinks first and creates second: between the two
# there is no `conclave` on PATH at all, and a shell that looks in that window gets "command
# not found" for a release that is fine. A temporary link plus `mv` is one `rename(2)`, which
# either happened or did not.
point_link() {
  tmp="$1.tmp.$$"
  ln -sfn "$2" "$tmp"
  mv -f "$tmp" "$1"
}

# node_modules for a new version directory, when the release moved no dependency.
#
# `cp -c` asks APFS to clone the tree rather than copy it: 95M of node_modules becomes metadata
# and no data blocks until something writes. It is a macOS spelling that GNU cp rejects, so a
# plain recursive copy is the fallback -- and the partial tree from a failed clone is removed
# first, because `cp -R src dst` with `dst` already a directory copies INTO it and would leave
# `node_modules/node_modules`.
clone_modules() {
  if cp -c -R "$1/node_modules" "$2/node_modules" 2>/dev/null; then return 0; fi
  rm -rf "$2/node_modules"
  cp -R "$1/node_modules" "$2/node_modules"
}

# Live conclave runs whose executable RESOLVES INTO that checkout.
#
# Matched on the command line rather than on open file handles, and that is deliberate: the
# hazard is a module the process has not read yet, so it holds no handle on the file now.
# `lsof` answers "what is being read right now" when the question is "what could be read
# next".
#
# WHAT IT ASKS CHANGED (#245). It used to ask whether a command line CONTAINED the checkout
# path, or the path of whatever `command -v conclave` resolves to. Two patterns, both
# substring tests, and each wrong in a different direction:
#
#   FALSE POSITIVE. Any process merely NAMING the directory matched. Cutting v0.5.26, the
#   guard refused because of `zsh -c ... cd <checkout> && git describe` -- a shell checking
#   the install, not running from it. The tag was pushed and the install was not; the release
#   sat half-done until `--install-only` finished it. The principle that would have prevented
#   it is stated twenty lines below, for the other guard: require an invocation, not a mention.
#
#   FAIL OPEN, which is worse and was found by measuring rather than by it happening. A run
#   is caught by the symlink pattern only when `command -v conclave` resolves to the same path
#   the run was launched through. Started by absolute path from inside the checkout, from a
#   copied install, from a second symlink, or by an operator with a different PATH, and it
#   matched NEITHER pattern -- so the guard reported the checkout free while a session was
#   live from it. A false positive announces itself; this does not.
#
# Both were the same mistake: asking what a command line SAYS when the question is which
# checkout a process is RUNNING. So this asks the second question directly -- take the runs
# `conclave_runs` already identifies (which requires an invocation), pull the script each was
# launched with, resolve it, and keep the ones that land under this checkout. Symlinks are
# resolved by the resolver rather than guessed at, so how conclave was installed stops
# mattering.
in_use() {
  dir=$(cd "$1" 2>/dev/null && pwd -P) || return 0
  for pid in $(conclave_runs); do
    # NOT named `argv`: that is a special variable in zsh, aliased to the positional
    # parameters, and zsh does not word-split an unquoted expansion either -- so a reader who
    # sources these functions into an interactive zsh to try them gets an empty result and a
    # guard that appears to find nothing. This script runs under /bin/sh, where the splitting
    # below is correct; the name avoids handing someone a silent failure at the prompt.
    cmdline=$(ps -o command= -p "$pid" 2>/dev/null) || continue
    # The token that IS the program: `node /path/to/conclave session ...`. Taken from argv
    # rather than from `comm`, which reports `node` -- the shebang resolves before exec, so the
    # interpreter is what the kernel records and the script is only ever an argument.
    script=$(printf '%s\n' $cmdline | awk '/\/conclave(\.ts)?$/ { print; exit }')
    [ -n "$script" ] || continue
    real=$(resolve "$script") || continue
    case "$real" in "$dir"/*) echo "$pid" ;; esac
  done
}

# A path with every symlink resolved, or nothing.
#
# `realpath` and `readlink -f` are both present on current macOS and on Linux; neither is on
# every macOS this might run on. Returning nothing when neither exists makes `in_use` find no
# runs, so the guard would let a swap through -- which is why the caller treats an unresolvable
# script as "cannot say" and the ONE case that must not be silent, an install with no resolver
# at all, is refused up front rather than quietly passed.
resolve() {
  if command -v realpath >/dev/null 2>&1; then realpath "$1" 2>/dev/null
  elif command -v readlink >/dev/null 2>&1; then readlink -f "$1" 2>/dev/null
  else return 1
  fi
}

# Live conclave RUNS, however they were started.
#
# `conclave session` and `conclave.ts session` are the same thing wearing two spellings, and the
# guard below used to know only the second. The optional `.ts` covers both; requiring a
# subcommand keeps it from matching this script, whose own path contains "conclave".
#
# Own pid excluded for the reason it always should be: a pattern that matches the process asking
# the question answers "yes" forever, which is how a wait loop in this session's own history
# spun for thirty-two minutes against nothing.
conclave_runs() {
  # Matched on `/conclave session`, WITH THE SLASH, and what that buys was measured rather than
  # assumed -- an earlier version of this comment claimed the wrong reason for it.
  #
  # A real run always carries a resolved path, because the shebang resolves before exec:
  #
  #     node /Users/x/.local/bin/conclave session ...      matches
  #     node /repo/bin/conclave.ts session ...             matches
  #     /bin/sh -c conclave session --advisor codex        does NOT
  #
  # The third is a launcher naming the command it is about to start, not a run. Counting it
  # would refuse a release for a shell, and the run it starts appears as its own process a
  # moment later anyway.
  #
  # The wider hazard this shape guards against is a pattern that matches the process asking the
  # question. That is what made a wait loop in this project's own history spin for thirty-two
  # minutes against nothing, and requiring an invocation rather than a mention is what keeps a
  # command line that merely discusses conclave from counting as one.
  ps -eo pid=,command= 2>/dev/null | awk '$0 ~ /\/conclave(\.ts)? (session|relay)([ ]|$)/ { print $1 }'
}

# The one refusal left, and it belongs to the MIGRATION -- the name says so, because the general
# guard it replaces is gone and must not be reconstructible from a leftover name.
#
# `refuse_if_in_use` was deleted rather than renamed. It existed because the install rewrote the
# directory runs were executing from; since #250 no install rewrites anything, so a general
# "is anybody in this install?" guard describes a policy this script no longer has. A function
# with that name sitting in the file is a claim a reader would take as current, and the one
# thing worse than a missing guard is a guard nobody re-checks the reason for.
#
# `refuse_if_legacy_in_use` is gone for the same reason, one release later (#254). It refused the
# migration up front because "the migration ends by deleting `conclave-stable`" -- and that
# sentence is only true when nothing is running from it. `retire_legacy` asks the liveness
# question itself and KEEPS the directory when the answer is yes, which it has to: a run can
# start during the worktree add, so the check at the end is the one that actually decides.
# Refusing up front could not make that safer. It could only refuse earlier, and what it bought
# with the earliness was a migration that waited for a moment when nothing on the machine was
# running -- observed not to arrive for four days on the layout this replaced.
#
# What the migration does before that point touches nothing a live run depends on: it adds a new
# worktree, reads `node_modules` to clone it, and moves a symlink that only affects processes
# started afterwards. A run keeps executing the same bytes at the same path, hooks included.

# Remove the checkout the migration moved off, once it is no longer the install.
#
# Every branch here KEEPS, and says why. This is the ONLY place the liveness question decides
# anything for the migration (#254): the migration is a worktree add and an npm install, which is
# long enough for a run to have started, and the operation on this side of it
# is a delete rather than a swap.
#
# `git worktree remove` without `--force`, so git refuses a tree with anything in it that this
# script did not put there -- a second opinion on the cleanliness check, from the program that
# owns the answer.
remove_migrated_from() {
  legacy="$1"
  from="$2"
  # No resolver check here, and that is measured rather than assumed. Without realpath and
  # readlink, `install_dir` cannot follow the PATH symlink at all: it falls back to the link's own
  # path, `git rev-parse` fails on it, and `update_install` returns having said "not a git
  # checkout — leaving it alone". Nothing reaches this function, so a fail-closed branch here
  # would be a guard that cannot fire -- and one of those is a claim a reader trusts and nobody
  # re-checks. The protection is real; it just lives upstream and is pinned as such (#254).
  its=$(common_dir "$legacy") || { say "keeping $legacy — cannot resolve the repository behind it"; return 0; }
  own=$(git_dir_of "$legacy") || { say "keeping $legacy — cannot resolve its git directory"; return 0; }
  if [ "$own" = "$its" ]; then
    say "keeping $legacy — it is the repository itself, not a worktree of it"
    return 0
  fi
  if [ -n "$(git -C "$legacy" status --porcelain 2>/dev/null)" ]; then
    say "keeping $legacy — it has uncommitted changes"
    return 0
  fi
  # BOTH samples, because they answer different questions (#256). The pre-swap one sees runs whose
  # argv is the old symlink -- every run that predates the launcher. The post-swap one sees runs
  # started during the migration, which is a worktree add and a node_modules clone long enough for
  # that to happen. Neither is a superset of the other, and the code took only the second.
  #
  # The pre-swap sample is NOT re-checked for liveness. A first version filtered it with `kill -0`,
  # so a run that finished mid-migration stopped counting -- correct, and untestable without racing
  # the script's own timing. An untestable branch on the operation that deletes is worth less than
  # the tidiness it buys: keeping is the safe answer, this file's every other branch keeps, and the
  # cost of keeping one directory too long is a `git worktree remove` the message already prints.
  pids=$(printf '%s %s' "$LEGACY_LIVE_BEFORE" "$(in_use "$legacy")" | tr ' ' '\n' | grep -v '^$' | sort -u)
  if [ -n "$pids" ]; then
    say "keeping $legacy — a run started in it while the migration was running."
    say "  Nothing retires it later; remove it by hand once these are done: git worktree remove $legacy"
    for p in $pids; do
      echo "    pid $p: $(ps -o command= -p "$p" 2>/dev/null | cut -c1-100)"
    done
    return 0
  fi
  say "removing the checkout the install migrated from: $legacy"
  run "git -C '$from' worktree remove '$legacy'"
}

# ---------------------------------------------------------------------------------------
# Put a tag on PATH: build its own directory, then move the symlink onto it (#250).
#
# Nothing that already exists is rewritten, which is why this no longer has to ask whether
# anybody is running. The old shape moved ONE checkout to the tag and then asked whether the
# answer was right; if it was not, the install was already broken with nothing to fall back
# to. Here the new version is a separate directory until it has been proved, and the PATH
# entry keeps pointing at a version that works until the last step.
# ---------------------------------------------------------------------------------------
update_install() {
  tag="$1"
  link=$(install_link) || { say "no \`conclave\` on PATH — nothing to update"; return 0; }
  dir=$(install_dir) || { say "no \`conclave\` on PATH — nothing to update"; return 0; }
  # A symlink is what this replaces and what `scripts/install.sh` creates. Anything else on
  # PATH is somebody's own wrapper or a real binary, and `mv` over it would destroy it.
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    say "refusing: $link is not a symlink — this install replaces the link, not the file"
    exit 1
  fi
  # Asked of git, not guessed from the filesystem. A first version tested `-d "$dir/.git"`
  # and reported the real install as "not a git checkout": conclave-stable is a linked
  # WORKTREE, so its `.git` is a 72-byte file pointing at the shared repository, not a
  # directory. The check said no and the script exited 0, which is the failure mode this
  # whole issue is about -- a release step that reports success and does nothing.
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || {
    say "install at $dir is not a git checkout — leaving it alone"
    return 0
  }
  root=$(releases_root "$dir") || {
    say "cannot find the repository behind $dir — leaving it alone"
    return 0
  }
  new="$root/$tag"
  say "install checkout: $dir"
  say "version directory: $new"

  # MIGRATION is the install whose current directory is not already a version directory, and
  # it is the only one that still refuses for a live run. The reason is not the old one -- this
  # writes nothing to $dir either. It is that `$root/<tag>` is safe because its name pins its
  # contents, and `conclave-stable` has no such promise: the moment the symlink leaves it, it
  # is an ordinary worktree somebody may reuse or remove. Migrating out from under a live run
  # strands that run in the one directory this scheme stops protecting.
  case "$dir" in
    "$root"/*) migrating=0 ;;
    *) migrating=1 ;;
  esac

  if [ "$migrating" = 1 ]; then
    say "migrating the single install at $dir into $root"
    # A dirty install checkout is somebody's edit. It no longer risks being discarded -- nothing
    # is checked out here any more -- but it is still the tree whose node_modules is about to be
    # cloned into the first version directory, and a lockfile with uncommitted edits gives that
    # directory a dependency tree matching no commit.
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      say "refusing: $dir has uncommitted changes"
      exit 1
    fi
    # Said before the work rather than discovered after it (#254). And said accurately: the
    # retirement below runs only on a migrating install, so once the symlink has moved this
    # directory is never revisited. A checkout kept here is kept for good until somebody removes
    # it, and telling the operator to "re-run later" would be false.
    # Sampled HERE and kept, because this is the last moment the question can be answered
    # correctly (#256). `in_use` resolves a run's argv, and a run that predates `bin/conclave` has
    # the PATH symlink in its argv -- so once the symlink is moved onto the new version, resolving
    # it answers with the NEW version and the run disappears from the very check meant to protect
    # it. The migration is the one moment when every live run predates the launcher, so this is
    # not an edge case: it is the normal case, exactly once, on the operation that deletes.
    LEGACY_LIVE_BEFORE=$(in_use "$dir")
    if [ -n "$LEGACY_LIVE_BEFORE" ]; then
      say "$dir has live runs — the migration will keep it, and nothing will retire it later:"
      say "  once those runs finish, remove it with: git worktree remove $dir"
    fi
  fi

  before=$(git -C "$dir" rev-parse --short HEAD)
  run "git -C '$dir' fetch origin --tags --quiet"
  # Whether the release moved a dependency. Unchanged in what it asks and unchanged in why --
  # it now decides whether the new directory can CLONE node_modules from the old one rather
  # than whether to reinstall in place, which is what makes retaining versions affordable at
  # 95M a copy.
  #
  # Asked by CONTENT, not by counting lines. A first version counted changed lines and treated
  # more than two as a dependency move -- reasoning that two lines is the version string on both
  # sides. `package-lock.json` carries the version TWICE, at the root and under `packages[""]`,
  # so a pure version bump is four lines and every release reinstalled for nothing. Measured on
  # v0.5.12, which reported "the release moved a dependency" for a diff that was four version
  # lines and nothing else.
  #
  # So: strip the version lines, and if anything is left, something really moved.
  deps_changed=0
  if [ "$DRY" = 0 ]; then
    other=$(git -C "$dir" diff "$before" "$tag" -- package-lock.json 2>/dev/null \
      | grep -E '^[-+][^-+]' \
      | grep -vE '^[-+][[:space:]]*"version":' \
      | head -1)
    [ -n "$other" ] && deps_changed=1
  fi

  # What the ownership record for this directory would have to say. Read once, so the reuse
  # check below and the record written on creation cannot describe different things.
  repo=$(common_dir "$dir") || { say "cannot resolve the repository behind $dir"; exit 1; }
  want=$(git -C "$dir" rev-parse --verify --quiet "refs/tags/$tag^{commit}" 2>/dev/null) || want=""

  # The directory is CREATED, never rewritten. `--detach` so it owns no branch: a version is a
  # tag, and a worktree holding a branch is the kind of thing an operator later finds in
  # `git worktree list` and cannot tell from their own work.
  if [ -d "$new" ]; then
    # AND IT MUST BE OURS. A directory that merely looks like an install of this tag is one this
    # script has no account of: reusing it would put whatever is in it on PATH, and the operator
    # would have no way to tell that from an install. Refused rather than adopted -- adopting is
    # exactly the guess this record exists to stop.
    if ! installed_record_matches "$root" "$tag" "$new" "$repo" "$tag" "$want"; then
      say "refusing: $new already exists and is not one this installer made"
      echo "  There is no ownership record for it under $root/.installed, or the one there" >&2
      echo "  describes something else. Move it aside and re-run; nothing here will adopt a" >&2
      echo "  directory it cannot account for, and nothing on PATH will be pointed at one." >&2
      exit 1
    fi
    # AND IT MUST STILL BE WHAT THE RECORD DESCRIBES. Ownership is about who created it; this is
    # about what has happened since, and neither answers the other. A recorded directory checked
    # out to another commit, put on a branch, or edited is not the version its name claims, and
    # it is the version that would go on PATH.
    if ! checkout_unchanged "$new" "$repo" "$want"; then
      say "refusing: $new is no longer the checkout its record describes"
      echo "  It has been moved to another commit, put on a branch, edited, or is no longer a" >&2
      echo "  worktree of this repository. Move it aside and re-run." >&2
      exit 1
    fi
    say "$new already exists — reusing it"
  else
    run "mkdir -p '$root'"
    run "git -C '$dir' worktree add --detach --quiet '$new' '$tag'"
    # Recorded as soon as it exists, so an install interrupted between here and the symlink is
    # resumable rather than a directory the next run refuses to touch. NOT marked ready: that
    # happens at the far end, after there is something worth being ready.
    run "write_installed_record '$root' '$tag' '$new' '$repo' '$tag' '$want'"
  fi

  # DEPENDENCIES ARE DECIDED BY READINESS, NOT BY `node_modules` EXISTING. A `npm ci` killed
  # part-way leaves a directory that has one, and the old test skipped provisioning on the
  # strength of it and put a half-installed tree on PATH. An owned directory that never reached
  # the end is rebuilt from nothing -- discarded rather than topped up, because npm has no way
  # to tell a partial tree from a complete one either.
  if installed_is_ready "$root" "$tag" "$want" && [ "$DRY" = 0 ]; then
    say "$new is provisioned and verified — leaving its dependencies alone"
  else
    if [ -d "$new/node_modules" ]; then
      say "$new was never finished — discarding its partial dependencies"
      run "rm -rf '$new/node_modules'"
    fi
    if [ "$deps_changed" = 0 ] && [ -d "$dir/node_modules" ]; then
      say "dependencies are unchanged — cloning node_modules from $dir"
      run "clone_modules '$dir' '$new'"
    else
      say "the release moved a dependency — installing into $new"
      run "cd '$new' && npm ci --silent"
    fi
  fi

  # PROVED BEFORE IT IS POINTED AT. Run out of the new directory directly rather than through
  # PATH, because PATH still resolves to the old version at this point -- which is exactly the
  # property that makes a failure here harmless.
  if [ "$DRY" = 0 ]; then
    built=$(node "$new/bin/conclave.ts" --version 2>/dev/null | head -1 || echo "(no answer)")
    case "$built" in
      *"${tag#v}"*) say "$new reports $built" ;;
      *)
        # The readiness marker goes, so the next run rebuilds rather than trusting a directory
        # that has just failed to answer for itself.
        rm -f "$(installed_ready "$root" "$tag")"
        say "MISMATCH: $new reports '$built', expected $tag — leaving the install where it is"
        exit 1
        ;;
    esac
    # READY, and not a moment earlier: dependencies are in and the directory has answered out of
    # its own path. Everything before this point is recoverable by re-running; this is the line
    # that says re-running has nothing left to do.
    mark_installed_ready "$root" "$tag" "$want"
  fi

  # AT THE LAUNCHER, not at `conclave.ts`. A symlink straight to the source makes the kernel
  # exec `node <the symlink>`, so `ps` carries a path that later installs MOVE -- and every
  # question about which version a live process is running is asked of that line. `bin/conclave`
  # resolves itself first, so the command line names the version directory and keeps naming it.
  run "point_link '$link' '$new/bin/conclave'"

  # Verified, not assumed. The whole failure this script exists for is a release that
  # reported success while the CLI stayed where it was.
  if [ "$DRY" = 0 ]; then
    got=$(conclave --version 2>/dev/null | head -1 || echo "(no answer)")
    say "conclave --version -> $got"
    case "$got" in
      *"${tag#v}"*) say "install is on $tag" ;;
      *) say "MISMATCH: expected $tag, got '$got'"; exit 1 ;;
    esac
  fi

  # LAST, and only for a migration. Everything above had to succeed first: the worktree built,
  # its dependencies installed, its version proved out of its own directory, the symlink renamed
  # onto it and the answer read back through PATH. Only now is $dir no longer the install, and
  # only now is removing it something other than taking the CLI away with nothing to fall back
  # to. An ordinary install removes nothing, ever -- old versions are kept on purpose, and
  # `--prune-install` is the separate operation an operator types when they want the disk back.
  if [ "$migrating" = 1 ]; then
    remove_migrated_from "$dir" "$new"
  fi
}

# ---------------------------------------------------------------------------------------
# Remove superseded version directories. Only when asked, and only what it can identify.
#
# The shape is the opposite of a garbage collector: there is no rule here that decides a
# directory is stale. There are seven rules that decide a directory is NOT this script's to
# remove, and anything that trips one is reported and kept. A prune that removes nothing is a
# normal outcome, and the operator can read which rule stopped each candidate.
#
# Nothing recurses. Only the immediate children of the releases root are looked at, so a
# directory nested inside a version -- `node_modules`, somebody's notes -- is never a candidate,
# and neither is anything outside the root however it is reached.
# ---------------------------------------------------------------------------------------
prune_install() {
  active=$(install_dir) || { say "no \`conclave\` on PATH — nothing to prune"; return 0; }
  git -C "$active" rev-parse --git-dir >/dev/null 2>&1 || {
    say "the install at $active is not a git checkout — nothing here is this script's to remove"
    return 0
  }
  root=$(releases_root "$active") || { say "cannot find the repository behind $active"; return 0; }
  case "$active" in
    "$root"/*) ;;
    *)
      say "the install at $active is not under $root — migrate it first: scripts/release.sh --install-only"
      return 0
      ;;
  esac
  [ -d "$root" ] || { say "no versions directory at $root — nothing to prune"; return 0; }

  # FAIL CLOSED, and unlike the migration guard `--force` does not cover it. Without a resolver
  # `in_use` cannot tell which checkout a run belongs to and answers "none", which reads as
  # "nothing is live". A swap made on that answer is recoverable by re-running; a delete is not,
  # so the missing input is refused rather than assumed away.
  if ! command -v realpath >/dev/null 2>&1 && ! command -v readlink >/dev/null 2>&1; then
    say "refusing to prune — neither realpath nor readlink is available, so a live version"
    echo "  cannot be told from a finished one. Install either." >&2
    exit 1
  fi
  repo=$(common_dir "$active") || {
    say "refusing to prune — cannot resolve the repository behind $active"
    exit 1
  }

  say "pruning versions under $root"
  say "keeping the active install: $active"
  for entry in "$root"/*; do
    [ -d "$entry" ] || continue
    name=$(basename "$entry")
    # Resolved before anything is asked of it, and kept if it cannot be. Every later comparison
    # is between physical paths, and a path that will not resolve is one this script cannot say
    # anything true about.
    dir=$(cd "$entry" 2>/dev/null && pwd -P) || { say "  keeping $name — its path cannot be resolved"; continue; }
    [ "$dir" != "$active" ] || continue

    # A RELEASE TAG BY NAME. The name is the whole claim a version directory makes about itself,
    # so it has to look like one before anything else is asked.
    is_release_tag "$name" || { say "  keeping $name — not named for a release tag"; continue; }
    # THE SAME REPOSITORY, asked of git rather than assumed from the path. A worktree of another
    # clone can sit under this root -- and `git worktree remove` run from here would refuse it
    # anyway, which is exactly why the answer is worth having before the attempt.
    its=$(common_dir "$dir") || { say "  keeping $name — cannot resolve the repository behind it"; continue; }
    [ "$its" = "$repo" ] || { say "  keeping $name — it belongs to another repository"; continue; }
    # A LINKED worktree, not the repository itself.
    own=$(git_dir_of "$dir") || { say "  keeping $name — cannot resolve its git directory"; continue; }
    [ "$own" != "$its" ] || { say "  keeping $name — it is the repository itself, not a worktree of it"; continue; }
    # DETACHED. A worktree holding a branch is somebody's work whatever its directory is called.
    if branch=$(git -C "$dir" symbolic-ref -q HEAD 2>/dev/null); then
      say "  keeping $name — it holds ${branch#refs/heads/}, so it is somebody's branch"
      continue
    fi
    # AND ACTUALLY AT THAT TAG. A directory called `v0.5.29` sitting on some other commit is not
    # the version it claims to be, and a name is not evidence.
    tagged=$(git -C "$active" rev-parse --verify --quiet "refs/tags/$name^{commit}" 2>/dev/null) || tagged=""
    [ -n "$tagged" ] || { say "  keeping $name — no release tag of that name in this repository"; continue; }
    head=$(git -C "$dir" rev-parse --verify --quiet HEAD 2>/dev/null) || head=""
    [ "$head" = "$tagged" ] || { say "  keeping $name — it is not checked out at $name"; continue; }
    # CLEAN. Uncommitted work is not this script's to discard, and `git worktree remove` will
    # say so too -- that second opinion is the reason `--force` is never passed.
    [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ] || { say "  keeping $name — it has uncommitted changes"; continue; }
    # AND ONE OF OURS. Every check above is about what the directory looks like, and a person
    # can satisfy all of them with a single `git worktree add`. This is the only one that asks
    # whether an installer made it, and it is required rather than preferred: no record and a
    # record that does not match get the same answer, because the alternative is deciding on a
    # resemblance that a human reproduces by accident.
    installed_record_matches "$root" "$name" "$dir" "$repo" "$name" "$tagged" || {
      say "  keeping $name — no ownership record says this installer made it"
      continue
    }
    # AND NOBODY IS RUNNING FROM IT. The same resolved-script test the migration uses: take the
    # runs `conclave_runs` identifies, resolve the script each was launched with, and keep the
    # ones that land in this directory.
    pids=$(in_use "$dir")
    if [ -n "$pids" ]; then
      say "  keeping $name — processes are running from it:"
      for p in $pids; do
        echo "    pid $p: $(ps -o command= -p "$p" 2>/dev/null | cut -c1-100)"
      done
      continue
    fi

    say "  removing $name"
    rec_of=$(installed_record "$root" "$name")
    if [ "$DRY" = 1 ]; then
      # A dry run has to leave BOTH the worktrees and the records exactly as it found them, or
      # "what would this do" is itself a thing that did something.
      echo "  would run: mv $rec_of $rec_of.removing"
      echo "  would run: git -C $active worktree remove $dir"
      echo "  would run: rm -f $rec_of.removing $(installed_ready "$root" "$name")"
      continue
    fi
    # THE RECORD IS INVALIDATED FIRST, and the order is the whole point.
    #
    # Removing the directory and then the record leaves a window in which a valid record exists
    # for a directory that does not -- and the next thing to appear at that path, a worktree
    # somebody adds by hand, is then vouched for by a record nobody wrote for it. A kill signal
    # in that window is not exotic: `git worktree remove` on a large tree is the slowest thing
    # here. Moved aside rather than deleted, so an ordinary refusal from git can be undone; the
    # name it moves to is not the name records are read from, so it certifies nothing while it
    # sits there. A crash between the two leaves an orphan directory nothing will adopt, which
    # is the safe side of this trade.
    mv -f "$rec_of" "$rec_of.removing"
    # Per directory, and never `git worktree prune`: the blanket form decides for itself what is
    # stale, which is the one decision that must not be delegated when the operation is a delete.
    if git -C "$active" worktree remove "$dir"; then
      rm -f "$rec_of.removing" "$(installed_ready "$root" "$name")"
    else
      mv -f "$rec_of.removing" "$rec_of"
      say "  keeping $name — git refused to remove it, so its record is put back"
    fi
  done
}

# ---------------------------------------------------------------------------------------
if [ "$PRUNE_INSTALL" = 1 ]; then
  # Said rather than silently preferred. `release.sh 0.5.30 --prune-install` reads like one
  # operation and is two, and guessing which was meant would either skip a release or delete
  # directories somebody was only cutting a tag.
  [ -z "$VERSION" ] || { echo "release: --prune-install cuts no release; drop the version" >&2; exit 2; }
  [ "$INSTALL_ONLY" = 0 ] || { echo "release: --prune-install and --install-only are two operations; run them one at a time" >&2; exit 2; }
  prune_install
  exit 0
fi

if [ "$INSTALL_ONLY" = 1 ]; then
  # THE NEWEST RELEASE, not the newest tag. `--sort=-v:refname` puts `v0.6.0-rc1` above
  # `v0.5.29`, so an unfiltered `head -1` installs a pre-release -- found when the same
  # looseness was tightened in `scripts/install.sh`, which is the other half of the same
  # question and now asks it with the same function.
  latest=$(git tag --sort=-v:refname | while IFS= read -r t; do is_release_tag "$t" && echo "$t"; done | head -1)
  [ -n "$latest" ] || { say "no release tag in this repository — nothing to install"; exit 1; }
  say "newest release: $latest"
  update_install "$latest"
  exit 0
fi

[ -n "$VERSION" ] || { echo "usage: release.sh <version> [--dry-run] | --install-only | --prune-install" >&2; exit 2; }
TAG="v$VERSION"

# The release preconditions, in the order that fails cheapest first.
[ -z "$(git status --porcelain)" ] || { say "refusing: the tree has uncommitted changes"; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { say "refusing: not on main"; exit 1; }
git fetch origin --quiet
[ "$(git rev-list --count HEAD..origin/main)" = "0" ] || { say "refusing: behind origin/main"; exit 1; }
git rev-parse "$TAG" >/dev/null 2>&1 && { say "refusing: $TAG already exists"; exit 1; }

# Runs working in THIS repository, which is the only kind the tag guard is about (#249).
#
# `conclave_runs` is machine-wide, and the callers that still want it that way are the migration
# and the prune -- every run on this machine executes from `conclave-stable`
# until that migration happens, wherever those runs are working. Tagging is a different
# question. A session working in another project owns no branch here and writes nothing to this
# tree, and blocking a release on one holds up the repo-local 90% of the work for a reason that
# does not apply to it.
#
#   tag / bump      protects this repo's branch and tree     -> this repo
#   the migration   protects runs stranded in the old install -> machine-wide, once
#
# Ordinary installs scope to nothing at all now: they create a directory and move a symlink, so
# there is no run they can reach (#250).
#
# A run whose cwd cannot be read is treated as local and refuses. Waiting costs an operator some
# time; tagging a tree somebody is writing to costs a bad release.
#
# That fail-safe is NOT covered by a test, and is recorded as a choice rather than dressed up as
# a guarantee: producing an unreadable cwd means running this without `lsof` on PATH, and
# building a PATH that lacks it while keeping git, ps and awk is more fixture than the branch is
# worth. Mutation confirms the rest of the function; this line is reasoned.
runs_here() {
  here=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  for p in $(conclave_runs); do
    cwd=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)
    if [ -z "$cwd" ]; then echo "$p"; continue; fi
    case "$cwd" in "$here" | "$here"/*) echo "$p" ;; esac
  done
}

# A run in flight owns a branch this tag would collide with, and its participants are
# writing to the tree being tagged.
#
# NOT ON A DRY RUN (#248). Neither half of that reason applies when nothing is written: `run()`
# prints instead of executing, and every mutating step below is already gated on `DRY`. Refusing
# anyway made a dry run impossible on a busy machine -- which is the machine an operator most
# wants to ask "what would this do" from -- and it made `#182 a dry run executes nothing` pass
# with the script doing nothing at all, because HEAD, the tree and a non-empty stderr are exactly
# what a refusal also produces.
if [ "$DRY" = 0 ] && [ -n "$(runs_here)" ]; then
  say "refusing: a run is in flight in this repository — wait for it to finish and merge"
  for p in $(runs_here); do
    echo "    pid $p: $(ps -o command= -p "$p" 2>/dev/null | cut -c1-100)" >&2
  done
  exit 1
fi

say "verifying before $TAG"
run "npm run test"
run "npm run typecheck"
run "npm run conformance"

# Every place the version is written. Missing one produces an install script that fetches
# the previous release, silently.
say "bumping to $VERSION"
CURRENT=$(node -e "console.log(require('./package.json').version)")
# Dots escaped, because they are regex wildcards: an unescaped `0.5.11` also matches
# `0X5Y11`, and package-lock.json is exactly the kind of file where something would.
CURRENT_RE=$(printf '%s' "$CURRENT" | sed 's/\./\\./g')
for f in package.json package-lock.json README.md scripts/install.sh; do
  # `-i.bak` rather than BSD's `-i ''`: the empty-argument form is a GNU sed error, so the
  # bare macOS spelling would fail on Linux. The suffixed form is what both accept.
  run "sed -i.bak 's/$CURRENT_RE/$VERSION/g' '$f' && rm -f '$f.bak'"
done
if [ "$DRY" = 0 ] && grep -rn "$CURRENT" package.json package-lock.json README.md scripts/install.sh >/dev/null 2>&1; then
  say "a reference to $CURRENT survived the bump — stopping"
  exit 1
fi

run "git add -A"
run "git commit -q -m '$TAG'"
run "git tag '$TAG'"
run "git push origin main"
run "git push origin '$TAG'"
say "pushed $TAG — the release workflow packages the archives"
say "notes are written by hand: gh release edit $TAG --notes-file <file>"

update_install "$TAG"
