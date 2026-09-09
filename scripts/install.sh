#!/bin/sh
# Install conclave: fetch a checkout, build its one native dependency, put `conclave` on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/miclip/conclave/v0.5.37/scripts/install.sh | sh
#
# NOT a zip of built artefacts. Node 24 strips types natively, so there is nothing to
# build except `node-pty` — which is a native module and has to be compiled against the
# Node that will run it. A prebuilt archive would be wrong on any machine whose Node
# differs from the one that made it, and would fail at the first pty spawn rather than at
# install time, which is the worst place to discover it.
#
# Idempotent: re-running installs the newer version BESIDE the one you are on and moves the
# symlink. Nothing already installed is rewritten (#250).
#
# ## The layout
#
#   ~/.local/share/conclave/            the repository, and only that -- no node_modules
#   ~/.local/share/conclave-releases/   one worktree per installed ref, each with its own deps
#   ~/.local/bin/conclave -> ~/.local/share/conclave-releases/v0.5.37/bin/conclave
#
# A version directory is named for its ref and never written again, so a run executing out of
# one is never disturbed by installing another. NOTHING IS EVER REMOVED HERE: old versions are
# kept on purpose, so a run that started on one can be read afterwards against the code that
# actually ran it. `scripts/release.sh --prune-install` is the deliberate operation that takes
# the disk back, and it keeps anything it cannot identify as a finished version. That is what lets an upgrade happen while a
# session is live: Node resolves the symlink to its real path at exec and resolves every later
# import against THAT, so the running process stays where it started and the next one follows
# the link.
#
# `scripts/release.sh` reaches the same directories by the same rule -- `conclave-releases`
# beside the repository, one directory per tag. The two have to agree or an upgrade would
# install beside itself instead of over itself, so both derive the path rather than spelling
# it out.

set -eu

REPO="${CONCLAVE_REPO:-https://github.com/miclip/conclave.git}"
PREFIX="${CONCLAVE_PREFIX:-$HOME/.local/share/conclave}"
BINDIR="${CONCLAVE_BINDIR:-$HOME/.local/bin}"

# The newest release tag, resolved at run time rather than baked in — so a release does not
# have to re-release this script to point at the release after it. Baking it in produces a
# script from v0.3.0 that installs v0.2.0, silently.
#
# `CONCLAVE_REF` overrides with any ref: a tag, a branch, a sha.
latest_release() {
  # RELEASES ONLY. `v*` is a refspec, not a version test: `v0.6.0-rc1` matches it, and the
  # numeric sort below reads its last field as `0-rc1` -> 0, so a pre-release tagged after the
  # newest release would be picked as the newest release and installed by anyone running the
  # one-line installer. Found while tightening `is_release_tag`, which is the same question
  # asked in the other place -- so it is asked here with the same function.
  #
  # Sorted by numeric field rather than `sort -V`, which BSD and busybox sort do not
  # reliably have. Without it v0.10.0 sorts below v0.2.0 and the newest release is skipped
  # the moment a minor version reaches double digits.
  git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null |
    sed 's#.*refs/tags/##' |
    while IFS= read -r tag; do is_release_tag "$tag" && echo "${tag#v}"; done |
    sort -t. -k1,1n -k2,2n -k3,3n |
    tail -1
}

die() { echo "conclave: $*" >&2; exit 1; }

# Where version directories live: beside the repository, in one named directory.
#
# Resolved with `pwd -P` rather than string-joined, because `scripts/release.sh` reaches this
# same directory from the other side -- through the repository behind an installed worktree --
# and gets a physical path. Two spellings of one directory are two directories to git, and the
# symptom would be a second `conclave-releases` that only one of the two scripts ever finds.
releases_root() {
  physical=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  echo "$(dirname "$physical")/conclave-releases"
}

# The repository behind a checkout, as one absolute physical path.
#
# THE SAME NORMALISATION `scripts/release.sh` APPLIES, and it has to be: this value goes into
# the ownership record, and release.sh compares what it computes against what this wrote. Two
# spellings of one directory would make every install look like somebody else's work.
common_dir() {
  d=$(cd "$1" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$d" in /*) ;; *) d="$1/$d" ;; esac
  (cd "$d" 2>/dev/null && pwd -P) || return 1
}

# A release tag, exactly.
#
# `v[0-9]*.[0-9]*.[0-9]*` was a glob, not a version test -- `*` matches anything, so
# `v1.2.3-rc1` and `v9x.9y.9z` both passed it and would have been given a bare version
# directory that `release.sh` then refuses to recognise as a version. Same expression in both
# scripts, for the same reason the record format is: they have to agree on what a release is.
is_release_tag() {
  printf '%s' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}

# ---------------------------------------------------------------------------------------
# The ownership record: what says an installer made a directory (#250).
#
# A clean detached worktree of the right repository, under the releases root, named for a
# release tag and checked out at it, is one `git worktree add` away for any person with a
# terminal -- and is not an install. So the two programs that make installs write down that
# they did, out of the worktree, under `<root>/.installed/`.
#
# DUPLICATED FROM `scripts/release.sh` rather than shared, because this script is fetched from
# a URL and piped to `sh`: there is no sibling file to source. What keeps the two from drifting
# is a test that installs with this script and reuses with that one -- a disagreement in either
# spelling shows up as a refusal to reuse, not as a silent acceptance.
#
# Four fields, all compared: the directory's physical path, the repository's common dir, the
# ref, and the commit it pointed at. A record matching three of them is a record for something
# else.
# ---------------------------------------------------------------------------------------
installed_record() { echo "$1/.installed/$2.rec"; }

installed_record_field() {
  sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1
}

write_installed_record() {
  rec_root="$1"; rec_name="$2"; rec_dir="$3"; rec_repo="$4"; rec_ref="$5"; rec_commit="$6"
  mkdir -p "$rec_root/.installed"
  rec_file=$(installed_record "$rec_root" "$rec_name")
  printf 'path=%s\nrepo=%s\nref=%s\ncommit=%s\n' \
    "$rec_dir" "$rec_repo" "$rec_ref" "$rec_commit" > "$rec_file.tmp.$$"
  mv -f "$rec_file.tmp.$$" "$rec_file"
}

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

# The checkout's own git directory, absolute. Equal to `common_dir` for exactly one checkout of
# a repository -- the main one -- which is how a clone is told from a worktree of it.
git_dir_of() {
  d=$(cd "$1" 2>/dev/null && git rev-parse --git-dir 2>/dev/null) || return 1
  case "$d" in /*) ;; *) d="$1/$d" ;; esac
  (cd "$d" 2>/dev/null && pwd -P) || return 1
}

# READINESS, a second marker written only at the far end.
#
# The record says who made the directory; it is written the moment the worktree exists, before
# `npm install` has run. An install killed in between leaves an owned directory with a PARTIAL
# `node_modules`, and a next run that decided by `[ -d node_modules ]` would skip provisioning
# and put a half-installed tree on PATH. `node-pty` is compiled here, so "partial" can mean a
# native module that is present and does not load.
#
# Same shape as `scripts/release.sh`, duplicated for the same reason the record format is: this
# file is fetched from a URL and piped to `sh`, with no sibling to source.
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

# Whether the checkout is still what its record describes. Ownership is about who created it;
# this is about what has happened since, and neither answers the other.
checkout_unchanged() {
  chk_dir="$1"; chk_repo="$2"; chk_commit="$3"
  [ "$(common_dir "$chk_dir" 2>/dev/null)" = "$chk_repo" ] || return 1
  [ "$(git_dir_of "$chk_dir" 2>/dev/null)" != "$chk_repo" ] || return 1
  # In an `if`, not `&& return 1`: an AND-list that ends non-zero is fatal under `set -e`.
  if git -C "$chk_dir" symbolic-ref -q HEAD >/dev/null 2>&1; then return 1; fi
  [ "$(git -C "$chk_dir" rev-parse --verify --quiet HEAD 2>/dev/null)" = "$chk_commit" ] || return 1
  [ -z "$(git -C "$chk_dir" status --porcelain 2>/dev/null)" ] || return 1
  return 0
}

# The directory a ref installs into.
#
# A RELEASE TAG IS USED VERBATIM, because `release.sh` names version directories by tag. If
# these two disagreed by so much as a prefix, an upgrade would build a second copy of a version
# already on disk and the symlink would start pointing at whichever script ran last.
#
# Anything else -- a branch, a sha, a pre-release tag -- is not a version, so it gets a
# filesystem-safe spelling of the ref PINNED TO THE COMMIT. `main` moves; a directory named for
# a moving ref is a directory whose contents nobody can name afterwards, and reusing it would
# hand back a stale install that looks current. The commit makes each one its own directory,
# and `tr` covers the refs that are not path segments at all -- `feature/x` is one directory
# name here, not two.
dir_for_ref() {
  if is_release_tag "$1"; then echo "$1"; return 0; fi
  safe=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-')
  echo "$safe-$(printf '%s' "$2" | cut -c1-12)"
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node 24 or newer is required (not found)"
command -v npm >/dev/null 2>&1 || die "npm is required"

# Checked BEFORE anything is written. Conclave runs its TypeScript directly, so an older
# Node does not fail with a version message — it fails on the first type annotation it
# reads, which reads as a corrupt download.
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || die "node 24 or newer is required (found $(node -v))"

if [ -n "${CONCLAVE_REF:-}" ]; then
  REF="$CONCLAVE_REF"
else
  version=$(latest_release)
  [ -n "$version" ] || die "no released version found at $REPO (set CONCLAVE_REF to install anyway)"
  REF="v$version"
fi
echo "conclave: installing $REF"

# The repository, which is now BACKING STORE and nothing else. Its working tree is never what
# anybody runs, so it is not checked out to the ref -- the worktree below is. A shallow clone
# still serves: `git worktree add` needs the commit's tree, which `--depth 1` and a later
# `fetch <ref>` both bring, and the repository stays shallow afterwards. Measured on a
# `file://` clone, because `--depth` is SILENTLY IGNORED for a local path clone and a fixture
# that used one would prove nothing about shallowness.
if [ -d "$PREFIX/.git" ]; then
  echo "conclave: updating the repository at $PREFIX"
  git -C "$PREFIX" fetch --quiet origin "$REF"
  COMMIT=$(git -C "$PREFIX" rev-parse FETCH_HEAD)
else
  echo "conclave: cloning into $PREFIX"
  mkdir -p "$(dirname "$PREFIX")"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$PREFIX"
  COMMIT=$(git -C "$PREFIX" rev-parse HEAD)
fi

RELEASES=$(releases_root "$PREFIX") || die "cannot resolve $PREFIX"
REPO_ID=$(common_dir "$PREFIX") || die "cannot resolve the repository at $PREFIX"
NAME=$(dir_for_ref "$REF" "$COMMIT")
WORKTREE="$RELEASES/$NAME"

# CREATED, never rewritten. A directory that is already there is one an earlier install
# finished, and reusing it is what makes re-running cheap; what it is never allowed to be is
# `git checkout` over something a live process is importing from.
if [ -d "$WORKTREE" ]; then
  # AND IT MUST BE ONE OF OURS. A directory that merely looks like this install is one no
  # installer has an account of, and reusing it would put whatever is inside it on PATH under
  # the name of a release. Nothing here adopts a directory it cannot account for: the operator
  # moves it aside, or nothing happens.
  if ! installed_record_matches "$RELEASES" "$NAME" "$WORKTREE" "$REPO_ID" "$REF" "$COMMIT"; then
    die "$WORKTREE already exists and is not one this installer made.
  There is no ownership record for it under $RELEASES/.installed, or the one there describes
  something else. Move it aside and re-run. Nothing was changed, and $BINDIR/conclave still
  points where it did."
  fi
  # AND IT MUST STILL BE WHAT THE RECORD DESCRIBES. Ownership is about who created it; what has
  # happened since is a different question, and a directory moved to another commit, put on a
  # branch or edited is not the version its name claims -- and is the one that would go on PATH.
  if ! checkout_unchanged "$WORKTREE" "$REPO_ID" "$COMMIT"; then
    die "$WORKTREE is no longer the checkout its record describes.
  It has been moved to another commit, put on a branch, edited, or is no longer a worktree of
  the repository at $PREFIX. Move it aside and re-run. Nothing was changed, and
  $BINDIR/conclave still points where it did."
  fi
  echo "conclave: reusing $WORKTREE"
else
  echo "conclave: unpacking $REF into $WORKTREE"
  mkdir -p "$RELEASES"
  # `--detach` so the directory owns no branch: a version is a commit, and a worktree holding
  # a branch is something an operator later finds in `git worktree list` and cannot tell from
  # their own work.
  git -C "$PREFIX" -c advice.detachedHead=false worktree add --detach --quiet "$WORKTREE" "$COMMIT"
  # Recorded as soon as it exists, so an install interrupted before the symlink moves is
  # resumable rather than a directory the next run refuses to touch.
  write_installed_record "$RELEASES" "$NAME" "$WORKTREE" "$REPO_ID" "$REF" "$COMMIT"
fi

# DECIDED BY READINESS, not by `node_modules` existing. A directory that never reached the end
# is rebuilt from nothing rather than topped up: npm cannot tell a tree it half-wrote from a
# complete one either.
if installed_is_ready "$RELEASES" "$NAME" "$COMMIT"; then
  echo "conclave: $WORKTREE is provisioned and verified"
else
  if [ -d "$WORKTREE/node_modules" ]; then
    echo "conclave: $WORKTREE was never finished — discarding its partial dependencies"
    rm -rf "$WORKTREE/node_modules"
  fi
  echo "conclave: installing dependencies (compiles node-pty)"
  ( cd "$WORKTREE" && npm install --omit=dev --silent )
fi
chmod +x "$WORKTREE/bin/conclave.ts" "$WORKTREE/bin/conclave"

# PROVED BEFORE ANYTHING ON PATH POINTS AT IT. Run out of the new directory directly, because
# PATH still resolves to whatever was installed before -- which is exactly the property that
# makes a failure here harmless rather than an install that took the command away.
version=$(node "$WORKTREE/bin/conclave.ts" --version 2>/dev/null | head -1) || version=""
# The readiness marker goes on any failure here, so the next run rebuilds rather than trusting a
# directory that has just failed to answer for itself.
if [ -z "$version" ]; then
  rm -f "$(installed_ready "$RELEASES" "$NAME")"
  die "$WORKTREE does not answer --version — leaving $BINDIR/conclave alone"
fi
if is_release_tag "$REF"; then
  case "$version" in
    *"${REF#v}"*) ;;
    *)
      rm -f "$(installed_ready "$RELEASES" "$NAME")"
      die "$WORKTREE reports '$version', expected $REF — leaving $BINDIR/conclave alone"
      ;;
  esac
fi
# READY, and not a moment earlier: dependencies are in and the directory has answered out of its
# own path. Everything before this is recoverable by re-running; this says re-running is done.
mark_installed_ready "$RELEASES" "$NAME" "$COMMIT"

mkdir -p "$BINDIR"
# A symlink is what this replaces. Anything else on PATH under that name is somebody's own
# wrapper or a real binary, and replacing it would destroy something this script did not make.
if [ -e "$BINDIR/conclave" ] && [ ! -L "$BINDIR/conclave" ]; then
  die "$BINDIR/conclave is not a symlink — this installs the link, not the file"
fi
# SWITCHED BY RENAME, not by `ln -sf` at the live name. `ln -sf` unlinks first and creates
# second: between the two there is no `conclave` on PATH at all, and a shell that looks in that
# window gets "command not found" for an install that is fine. A temporary link plus `mv` is one
# rename(2) -- it either happened or it did not, and re-running over a working install never
# takes the command away, not even for an instant.
#
# Symlink rather than copy, so `conclave` follows the version this script selected.
# AT THE LAUNCHER, not at `conclave.ts`. A symlink straight to the source makes the kernel exec
# `node <the symlink>`, so `ps` records a path that the next install moves -- and everything that
# asks which version a live process is running reads that line. `bin/conclave` resolves itself to
# its own version directory first, so the command line stays true for the life of the process.
ln -sfn "$WORKTREE/bin/conclave" "$BINDIR/conclave.tmp.$$"
mv -f "$BINDIR/conclave.tmp.$$" "$BINDIR/conclave"

echo "conclave: installed $version at $BINDIR/conclave -> $WORKTREE"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  # Said rather than fixed. Editing someone's shell profile from a piped script is a
  # larger liberty than installing the program they asked for.
  *) echo "conclave: add $BINDIR to your PATH to run it by name" ;;
esac
