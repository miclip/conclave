#!/bin/sh
# Install conclave: fetch a checkout, build its one native dependency, put `conclave` on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/miclip/conclave/v0.5.8/scripts/install.sh | sh
#
# NOT a zip of built artefacts. Node 24 strips types natively, so there is nothing to
# build except `node-pty` — which is a native module and has to be compiled against the
# Node that will run it. A prebuilt archive would be wrong on any machine whose Node
# differs from the one that made it, and would fail at the first pty spawn rather than at
# install time, which is the worst place to discover it.
#
# Idempotent: re-running updates an existing install in place rather than refusing.

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
  # Sorted by numeric field rather than `sort -V`, which BSD and busybox sort do not
  # reliably have. Without it v0.10.0 sorts below v0.2.0 and the newest release is skipped
  # the moment a minor version reaches double digits.
  git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null |
    sed 's#.*refs/tags/v##' |
    sort -t. -k1,1n -k2,2n -k3,3n |
    tail -1
}

die() { echo "conclave: $*" >&2; exit 1; }

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

if [ -d "$PREFIX/.git" ]; then
  echo "conclave: updating $PREFIX"
  git -C "$PREFIX" fetch --quiet origin "$REF"
  git -C "$PREFIX" checkout --quiet FETCH_HEAD
else
  echo "conclave: cloning into $PREFIX"
  mkdir -p "$(dirname "$PREFIX")"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$PREFIX"
fi

echo "conclave: installing dependencies (compiles node-pty)"
( cd "$PREFIX" && npm install --omit=dev --silent )

mkdir -p "$BINDIR"
# Symlink rather than copy, so `conclave` follows the checkout this script updates. Node
# resolves the link to its real path before choosing a loader, which is what lets a file
# named `conclave` still be treated as TypeScript.
ln -sf "$PREFIX/bin/conclave.ts" "$BINDIR/conclave"
chmod +x "$PREFIX/bin/conclave.ts"

echo "conclave: installed $("$BINDIR/conclave" --version) at $BINDIR/conclave"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  # Said rather than fixed. Editing someone's shell profile from a piped script is a
  # larger liberty than installing the program they asked for.
  *) echo "conclave: add $BINDIR to your PATH to run it by name" ;;
esac
