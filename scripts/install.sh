#!/bin/sh
# Installs Taste Profile into Spicetify and restarts Spotify.
# From a clone: sh scripts/install.sh
# From the web: curl -fsSL https://raw.githubusercontent.com/GZHN/taste-profile/main/scripts/install.sh | sh

set -eu

APP_NAME=taste-profile
ARCHIVE_URL=https://github.com/GZHN/taste-profile/archive/refs/heads/main.zip

die() {
  echo "Error: $*" >&2
  exit 1
}

resolve_app_dir() {
  root=$1
  for folder in dist app; do
    if [ -f "$root/$folder/index.js" ] && [ -f "$root/$folder/manifest.json" ]; then
      printf '%s\n' "$root/$folder"
      return 0
    fi
  done
  if [ -f "$root/index.js" ] && [ -f "$root/manifest.json" ]; then
    printf '%s\n' "$root"
    return 0
  fi
  return 1
}

if ! command -v spicetify >/dev/null 2>&1; then
  die "Spicetify is not installed or not on PATH. Install it from https://spicetify.app/ and run 'spicetify backup apply' once."
fi

echo "Installing Taste Profile..."

userdata=$(spicetify path userdata 2>/dev/null | tail -n 1 | tr -d '\r' || true)
userdata=${userdata#\"}
userdata=${userdata%\"}
if [ -z "$userdata" ]; then
  if [ -n "${APPDATA:-}" ]; then
    userdata="$APPDATA/spicetify"
  else
    userdata="${XDG_CONFIG_HOME:-$HOME/.config}/spicetify"
  fi
fi
if [ ! -d "$userdata" ]; then
  die "Could not find the Spicetify config folder. Run 'spicetify' once, then try this again."
fi

install_files() {
  src=$1
  for file in index.js manifest.json style.css; do
    if [ ! -f "$src/$file" ]; then
      die "Missing $file in $src"
    fi
  done

  mkdir -p "$userdata/CustomApps"
  dest=$(CDPATH= cd -- "$userdata/CustomApps" && pwd)/$APP_NAME
  src_real=$(CDPATH= cd -- "$src" && pwd)
  if [ "$src_real" = "$dest" ]; then
    return 0
  fi

  stage="$dest.installing"
  backup="$dest.bak"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp "$src/index.js" "$src/manifest.json" "$src/style.css" "$stage/"

  rm -rf "$backup"
  if [ -d "$dest" ]; then
    mv "$dest" "$backup"
  fi
  if mv "$stage" "$dest"; then
    rm -rf "$backup"
  else
    if [ -d "$backup" ] && [ ! -d "$dest" ]; then
      mv "$backup" "$dest"
    fi
    die "Could not replace the existing Taste Profile folder."
  fi
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || script_dir=""
tmp=""
cleanup() {
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT INT TERM

src=""
if [ -n "$script_dir" ]; then
  repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd) || repo_root=""
  if [ -n "$repo_root" ]; then
    src=$(resolve_app_dir "$repo_root" || true)
  fi
fi

if [ -n "$src" ]; then
  echo "Copying Taste Profile..."
  install_files "$src"
else
  command -v curl >/dev/null 2>&1 || die "curl is required to download Taste Profile."
  command -v unzip >/dev/null 2>&1 || die "unzip is required to download Taste Profile."
  echo "Downloading Taste Profile..."
  tmp=$(mktemp -d)
  if ! curl --fail --location --silent --show-error --output "$tmp/app.zip" "$ARCHIVE_URL"; then
    die "Could not download Taste Profile. Check your connection, or clone the repo and run sh scripts/install.sh"
  fi
  unzip -q "$tmp/app.zip" -d "$tmp/src"
  src=""
  for dir in "$tmp/src"/*; do
    if [ -d "$dir" ]; then
      found=$(resolve_app_dir "$dir" || true)
      if [ -n "$found" ]; then
        src=$found
        break
      fi
    fi
  done
  if [ -z "$src" ]; then
    die "The download did not contain Taste Profile (need dist/ from npm run build-local)."
  fi
  install_files "$src"
fi

if ! spicetify config custom_apps 2>/dev/null | tr -d '\r' | grep -F -x "$APP_NAME" >/dev/null 2>&1; then
  echo "Enabling Taste Profile..."
  spicetify config custom_apps "$APP_NAME"
fi

echo "Restarting Spotify..."
if ! spicetify apply; then
  die "Taste Profile is installed, but Spotify was not updated. If Spicetify has not been applied yet, run: spicetify backup apply"
fi

echo "Taste Profile is installed. Open it from the Spotify sidebar."
