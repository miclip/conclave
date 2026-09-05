#!/bin/sh
# Cut a release, and leave the CLI the operator actually runs on the version just cut.
#
#   scripts/release.sh 0.5.12          # bump, tag, push, then update the install checkout
#   scripts/release.sh --install-only  # move an existing install to the newest tag
#   scripts/release.sh 0.5.12 --dry-run
#
# The install step is the reason this exists (#182). Tagging, packaging and the notes were
# already automatic; the thing anyone runs was not, so v0.5.11 shipped while `conclave
# --version` reported v0.5.10 and ten issues' worth of fixes were reachable by nobody.
#
# ## Why it REFUSES rather than waits
#
# `~/.local/bin/conclave` points at SOURCE: `node <dir>/bin/conclave.ts`. Node resolves
# modules lazily, so a checkout under a live process does not swap a binary that is already
# loaded -- it swaps the files that process has NOT IMPORTED YET. A session that later
# reaches a rotation path or a lazy adapter import would read that module from the new
# commit while the rest of it is the old one.
#
# A run half on one version is worse than the lag this script is fixing: it behaves like no
# released version and records one while executing two. So a live process is a refusal, and
# the refusal names it.

set -eu

DRY=0
INSTALL_ONLY=0
FORCE=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --install-only) INSTALL_ONLY=1 ;;
    # Only for a checkout whose live process is known to be finished. It does not make the
    # hazard above untrue; it asserts the operator has checked.
    --force) FORCE=1 ;;
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
  bin=$(command -v conclave 2>/dev/null || true)
  [ -n "$bin" ] || return 1
  # -f resolves the whole chain; the fallback covers systems whose readlink does not.
  target=$(readlink -f "$bin" 2>/dev/null || readlink "$bin" 2>/dev/null || echo "$bin")
  # <dir>/bin/conclave.ts -> <dir>
  dirname "$(dirname "$target")"
}

# Live processes running FROM that checkout, if any.
#
# Matched on the command line rather than on open file handles, and that is deliberate: the
# hazard is a module the process has not read yet, so it holds no handle on the file now.
# `lsof` answers "what is being read right now" when the question is "what could be read
# next".
#
# TWO PATTERNS, because a run started through the installed CLI never names the checkout (#230).
# `~/.local/bin/conclave` is a symlink into it, and the SYMLINK's own path is what lands in argv:
#
#     node /Users/x/.local/bin/conclave session --advisor codex ...
#
# So `pgrep -f "<checkout>"` returned nothing while three such runs were live, and this guard --
# the one protecting against a checkout swapped under a live process -- would have let all three
# through. Observed while cutting v0.5.22, not reasoned about.
in_use() {
  { pgrep -f "$1" 2>/dev/null || true; [ -n "${2:-}" ] && { pgrep -f "$2" 2>/dev/null || true; }; } | sort -u
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

refuse_if_in_use() {
  dir="$1"
  pids=$(in_use "$dir" "${2:-}")
  [ -n "$pids" ] || return 0
  if [ "$FORCE" = 1 ]; then
    say "WARNING: processes are live in $dir and --force was given"
  else
    say "refusing to update $dir — processes are running from it:"
    for p in $pids; do
      echo "    pid $p: $(ps -o command= -p "$p" 2>/dev/null | cut -c1-100)"
    done
    echo "  A checkout swapped under a live run changes the modules it has not imported yet," >&2
    echo "  which produces a run that is half one version and half another. Wait for it to" >&2
    echo "  finish, or pass --force if you know the process is finished." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------------------
# Move the install checkout to a tag, reinstalling only if the release moved a dependency.
# ---------------------------------------------------------------------------------------
update_install() {
  tag="$1"
  dir=$(install_dir) || { say "no \`conclave\` on PATH — nothing to update"; return 0; }
  # Asked of git, not guessed from the filesystem. A first version tested `-d "$dir/.git"`
  # and reported the real install as "not a git checkout": conclave-stable is a linked
  # WORKTREE, so its `.git` is a 72-byte file pointing at the shared repository, not a
  # directory. The check said no and the script exited 0, which is the failure mode this
  # whole issue is about -- a release step that reports success and does nothing.
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || {
    say "install at $dir is not a git checkout — leaving it alone"
    return 0
  }
  say "install checkout: $dir"

  # A dirty install checkout is somebody's edit, and a checkout would discard it. Refused
  # rather than stashed: this script has no business deciding what to do with work it did
  # not make.
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    say "refusing: $dir has uncommitted changes"
    exit 1
  fi
  # The checkout path AND the symlink that resolves into it -- see `in_use`.
  refuse_if_in_use "$dir" "$(command -v conclave 2>/dev/null || true)"

  before=$(git -C "$dir" rev-parse --short HEAD)
  run "git -C '$dir' fetch origin --tags --quiet"
  # Whether the release moved a dependency. A plain checkout is enough when it did not --
  # v0.5.11 changed only the version string -- and leaves node_modules disagreeing with the
  # source when it did.
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
  run "git -C '$dir' checkout '$tag' --quiet"
  if [ "$deps_changed" = 1 ]; then
    say "the release moved a dependency — reinstalling"
    run "cd '$dir' && npm ci --silent"
  fi

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
}

# ---------------------------------------------------------------------------------------
if [ "$INSTALL_ONLY" = 1 ]; then
  latest=$(git tag --sort=-v:refname | head -1)
  say "newest tag: $latest"
  update_install "$latest"
  exit 0
fi

[ -n "$VERSION" ] || { echo "usage: release.sh <version> [--dry-run] [--force] | --install-only" >&2; exit 2; }
TAG="v$VERSION"

# The release preconditions, in the order that fails cheapest first.
[ -z "$(git status --porcelain)" ] || { say "refusing: the tree has uncommitted changes"; exit 1; }
[ "$(git branch --show-current)" = "main" ] || { say "refusing: not on main"; exit 1; }
git fetch origin --quiet
[ "$(git rev-list --count HEAD..origin/main)" = "0" ] || { say "refusing: behind origin/main"; exit 1; }
git rev-parse "$TAG" >/dev/null 2>&1 && { say "refusing: $TAG already exists"; exit 1; }

# A run in flight owns a branch this tag would collide with, and its participants are
# writing to the tree being tagged.
if [ -n "$(conclave_runs)" ]; then
  say "refusing: a run is in flight — wait for it to finish and merge"
  for p in $(conclave_runs); do
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
