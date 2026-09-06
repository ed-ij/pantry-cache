#!/usr/bin/env bash
#
# setup-mac.sh — put a fresh Mac in a state where this project can be built,
# tested and run.
#
# Safe to re-run: everything is checked before it is installed, and whatever is
# already present is left alone.
#
#   bash tools/setup-mac.sh            install whatever is missing
#   bash tools/setup-mac.sh --check    report what is missing, install nothing
#   bash tools/setup-mac.sh --no-gh    skip the optional GitHub CLI
#
# GitHub credentials are handled by Git Credential Manager: OAuth in a browser,
# token in the login Keychain, no personal access token to type or store.
#
# The project has no npm dependencies — every script imports only node:
# builtins — so there is no `npm install` step, here or afterwards. Node is
# needed to *run* the scripts, and git because build.mjs stamps each build with
# the commit and branch it was cut from.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_NODE_MAJOR=18

CHECK_ONLY=""
WANT_GH="1"

while [ $# -gt 0 ]; do
  case "$1" in
    --check)   CHECK_ONLY="1" ;;
    --no-gh)   WANT_GH="" ;;
    -h|--help) awk 'NR==1 && /^#!/ {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)         printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

say()  { printf '\n%s\n' "${B}==> $*${N}"; }
ok()   { printf '    %s %s\n' "${G}✓${N}" "$*"; }
info() { printf '    %s %s\n' "${D}·${N}" "$*"; }
warn() { printf '    %s %s\n' "${Y}!${N}" "$*"; }
die()  { printf '    %s %s\n' "${R}✗${N}" "$*" >&2; exit 1; }

MISSING=""
note_missing() { MISSING="${MISSING}${MISSING:+, }$1"; }

# --- 0. the machine ---------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS; this is $(uname -s)."

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) BREW_PREFIX="/opt/homebrew" ;;
  *)     BREW_PREFIX="/usr/local" ;;
esac

say "Machine"
ok "macOS $(sw_vers -productVersion) on $ARCH"
[ -n "$CHECK_ONLY" ] && warn "--check: reporting only, nothing will be installed"

# --- 1. Xcode Command Line Tools --------------------------------------------
# Homebrew needs these, and so does anything that compiles.

say "Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  ok "installed at $(xcode-select -p)"
elif [ -n "$CHECK_ONLY" ]; then
  warn "not installed"; note_missing "Command Line Tools"
else
  info "a system dialog will open — click Install and let it finish"
  xcode-select --install >/dev/null 2>&1 || true
  printf '    waiting'
  until xcode-select -p >/dev/null 2>&1; do printf '.'; sleep 10; done
  printf '\n'
  ok "installed at $(xcode-select -p)"
fi

# --- 2. Homebrew ------------------------------------------------------------

say "Homebrew"
if ! command -v brew >/dev/null 2>&1 && [ -x "$BREW_PREFIX/bin/brew" ]; then
  eval "$("$BREW_PREFIX/bin/brew" shellenv)"   # installed, just not on PATH yet
fi

if command -v brew >/dev/null 2>&1; then
  ok "$(brew --version | head -1)"
elif [ -n "$CHECK_ONLY" ]; then
  warn "not installed"; note_missing "Homebrew"
else
  info "installing from https://brew.sh (it will ask for your password)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$("$BREW_PREFIX/bin/brew" shellenv)"
  ok "$(brew --version | head -1)"
fi

# Make brew available in future login shells.
if command -v brew >/dev/null 2>&1 && [ -z "$CHECK_ONLY" ]; then
  SHELLENV_LINE="eval \"\$($BREW_PREFIX/bin/brew shellenv)\""
  if ! grep -qsF "$BREW_PREFIX/bin/brew shellenv" "$HOME/.zprofile"; then
    printf '\n# Homebrew\n%s\n' "$SHELLENV_LINE" >> "$HOME/.zprofile"
    info "added brew to ~/.zprofile for future shells"
  fi
fi

brew_install() {  # brew_install <formula> <human name>
  local formula="$1" name="$2"
  if [ -n "$CHECK_ONLY" ]; then warn "$name is missing"; note_missing "$name"; return 0; fi
  command -v brew >/dev/null 2>&1 || die "Homebrew is needed to install $name."
  info "brew install $formula"
  brew install "$formula"
}

# --- 3. git -----------------------------------------------------------------
# Apple's Command Line Tools ship a git that is perfectly good for this project,
# so an existing one is left alone rather than shadowed by a second copy.

say "git"
if command -v git >/dev/null 2>&1; then
  ok "$(git --version)"
  case "$(command -v git)" in
    /usr/bin/git) info "Apple's copy, from the Command Line Tools — fine for this project" ;;
  esac
else
  brew_install git "git"
  command -v git >/dev/null 2>&1 && ok "$(git --version)"
fi

# --- 4. Node and npm --------------------------------------------------------
# The one thing this project genuinely cannot run without.

say "Node.js"
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  ok "$(node -v) at $(command -v node)"
elif command -v node >/dev/null 2>&1; then
  warn "$(node -v) is older than the v$MIN_NODE_MAJOR this project expects"
  brew_install node "a newer Node.js"
else
  brew_install node "Node.js"
fi

if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)"
  if command -v npm >/dev/null 2>&1; then
    ok "npm v$(npm -v)"
  else
    warn "npm is missing even though node is present — try: brew reinstall node"
  fi
fi

# --- 5. Git Credential Manager ----------------------------------------------
# origin is an https GitHub remote, so pushing needs credentials. GCM does the
# OAuth handshake in a browser and keeps the resulting token in the login
# Keychain: no personal access token is ever typed, pasted, or left on disk in
# the clear, and it can be revoked from GitHub without touching this machine.
#
# The wrinkle on macOS: the Command Line Tools ship a *system* gitconfig setting
# credential.helper=osxkeychain, and git reads system config before global. So
# installing GCM is not enough — the helper list has to be reset, or osxkeychain
# keeps being asked first.

say "Git Credential Manager"

gcm_path() {
  local p
  p="$(command -v git-credential-manager 2>/dev/null || true)"
  [ -n "$p" ] && { printf '%s' "$p"; return 0; }
  for p in /usr/local/share/gcm-core/git-credential-manager \
           /usr/local/bin/git-credential-manager \
           "$BREW_PREFIX/bin/git-credential-manager"; do
    [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

# git tries helpers in config order, and an empty value clears every helper
# named before it. This reproduces that so the list below is the real one.
effective_helpers() {
  git config --get-all credential.helper 2>/dev/null | awk '
    $0 == "" { n = 0; next }
    { h[++n] = $0 }
    END { for (i = 1; i <= n; i++) print h[i] }'
}

GCM=""
if GCM="$(gcm_path)"; then
  ok "$("$GCM" --version 2>/dev/null | head -1) at $GCM"
elif [ -n "$CHECK_ONLY" ]; then
  warn "not installed"; note_missing "Git Credential Manager"
else
  command -v brew >/dev/null 2>&1 || die "Homebrew is needed to install Git Credential Manager."
  info "brew install --cask git-credential-manager"
  info "this one is a .pkg, so it will ask for your admin password"
  brew install --cask git-credential-manager
  GCM="$(gcm_path)" || die "installed, but the git-credential-manager binary was not found on PATH."
  ok "$("$GCM" --version 2>/dev/null | head -1) at $GCM"
fi

if [ -n "$GCM" ] && [ -z "$CHECK_ONLY" ]; then
  "$GCM" configure >/dev/null 2>&1 || warn "\`git-credential-manager configure\` reported a problem"

  if [ "$(effective_helpers | head -1)" != "$GCM" ]; then
    # An empty entry in the global config clears the inherited osxkeychain;
    # GCM then follows it as the only helper that answers.
    git config --global --unset-all credential.helper 2>/dev/null || true
    git config --global --add credential.helper ""
    git config --global --add credential.helper "$GCM"
    info "reset the helper list so GCM is asked before the CLT's osxkeychain"
  fi

  git config --global credential.credentialStore keychain

  if [ "$(effective_helpers | head -1)" = "$GCM" ]; then
    ok "GCM answers first; tokens live in the login Keychain"
  else
    warn "something still answers before GCM:"
    effective_helpers | sed 's/^/      /'
  fi
  info "nothing to authenticate now — the first push opens a browser to sign in"
elif [ -n "$GCM" ]; then
  info "effective helper order today:"
  effective_helpers | sed 's/^/      /'
fi

# --- 6. GitHub CLI (optional) -----------------------------------------------
# Useful for pull requests and issues, but it must not take over credentials:
# when `gh auth login` offers to "authenticate Git with your GitHub
# credentials", decline it and leave that to GCM.

if [ -n "$WANT_GH" ]; then
  say "GitHub CLI (optional)"
  if command -v gh >/dev/null 2>&1; then
    ok "$(gh --version | head -1)"
    if gh auth status >/dev/null 2>&1; then
      ok "signed in"
    else
      info "not signed in — run: gh auth login"
    fi
  else
    brew_install gh "GitHub CLI"
    command -v gh >/dev/null 2>&1 && info "installed — run: gh auth login when you want it"
  fi

  GH_HELPER="$(git config --global --get-all 'credential.https://github.com.helper' 2>/dev/null || true)"
  case "$GH_HELPER" in
    *gh*)
      warn "gh has registered itself as a credential helper for github.com"
      info "it will answer before GCM. Undo with:"
      info "git config --global --unset-all 'credential.https://github.com.helper'" ;;
    *)
      info "say no when gh offers to authenticate Git for you — that is GCM's job" ;;
  esac
fi

# --- 7. git identity --------------------------------------------------------
# Commits made without this are awkward to fix afterwards, so ask now.

say "git identity"
GIT_NAME="$(git config --global user.name  || true)"
GIT_EMAIL="$(git config --global user.email || true)"

if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
  ok "$GIT_NAME <$GIT_EMAIL>"
elif [ -n "$CHECK_ONLY" ] || [ ! -t 0 ]; then
  warn "not set. Set it with:"
  info "git config --global user.name  \"Your Name\""
  info "git config --global user.email \"you@example.com\""
else
  warn "not set on this machine — commits need a name and an email"
  if [ -z "$GIT_NAME" ]; then
    printf '    name  (blank to skip): '; read -r reply
    [ -n "$reply" ] && git config --global user.name "$reply"
  fi
  if [ -z "$GIT_EMAIL" ]; then
    printf '    email (blank to skip): '; read -r reply
    [ -n "$reply" ] && git config --global user.email "$reply"
  fi
  GIT_NAME="$(git config --global user.name || true)"
  GIT_EMAIL="$(git config --global user.email || true)"
  if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
    ok "$GIT_NAME <$GIT_EMAIL>"
  else
    warn "skipped — set it before your first commit"
  fi
fi

# --- 8. commit checks -------------------------------------------------------

say "Commit checks"
if [ -n "$CHECK_ONLY" ]; then
  HOOKS="$( cd "$REPO_ROOT" && git config core.hooksPath || true )"
  if [ "$HOOKS" = "tools/hooks" ]; then
    ok "core.hooksPath = tools/hooks"
  else
    warn "commit checks are not installed"
    info "run this script without --check to point git at tools/hooks"
  fi
elif [ -d "$REPO_ROOT/tools/hooks" ]; then
  # Hooks under .git/ are per-machine and untracked, so they are exactly the
  # thing a move to a new laptop loses. core.hooksPath points git at the ones
  # in the repository instead; see tools/hooks/pre-commit for what they ask.
  ( cd "$REPO_ROOT" && git config core.hooksPath tools/hooks )
  chmod +x "$REPO_ROOT"/tools/hooks/* 2>/dev/null || true
  ok "core.hooksPath = tools/hooks"
else
  warn "tools/hooks not found — skipped"
fi

# --- 9. prove it works ------------------------------------------------------

say "Project dependencies"
ok "none — every script imports only node: builtins, so there is no npm install"

if [ -n "$CHECK_ONLY" ]; then
  say "Summary"
  if [ -n "$MISSING" ]; then
    warn "missing: $MISSING"
    info "run this script without --check to install them"
    exit 1
  fi
  ok "everything this project needs is already installed"
  exit 0
fi

say "Checking the toolchain against the project"
cd "$REPO_ROOT"

info "npm run build"
# Into a scratch directory, not dist/: this is proving the toolchain works, and
# a build stamps itself with the time and commit, so building in place would
# leave a fresh checkout dirty before anybody had touched it.
if PANTRY_DIST="$(mktemp -d)/dist" npm run build >/tmp/freezer-setup-build.log 2>&1; then
  ok "build ran clean"
else
  tail -20 /tmp/freezer-setup-build.log >&2
  die "build failed — output above, full log in /tmp/freezer-setup-build.log"
fi

info "npm test"
if npm test >/tmp/freezer-setup-test.log 2>&1; then
  ok "smoke tests and contrast check passed"
else
  tail -20 /tmp/freezer-setup-test.log >&2
  die "tests failed — output above, full log in /tmp/freezer-setup-test.log"
fi

# --- 10. what next -----------------------------------------------------------

say "Ready"
cat <<'NEXT'
    npm run dev        the dev server, then open http://localhost:5178
    npm run build      write dist/ for pasting into Apps Script
    npm test           smoke tests + contrast check
    npm run release    cut a release

    Open a new terminal (or run: exec zsh) so PATH changes take effect.
NEXT

printf '    %s\n' "The first push to origin opens a browser; the token then lives in your Keychain."
