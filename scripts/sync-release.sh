#!/bin/sh
# Sync this package into the public Marketplace clone (build dist/ + copy files).
# From the package root:
#   sh scripts/sync-release.sh
#   sh scripts/sync-release.sh --push -m "Bump UI copy"
#   npm run sync-release:sh

set -eu

SKIP_BUILD=0
PUSH=0
MESSAGE=""
RELEASE_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --push) PUSH=1 ;;
    -m|--message)
      shift
      MESSAGE=${1:-}
      ;;
    --release-dir)
      shift
      RELEASE_DIR=${1:-}
      ;;
    -h|--help)
      echo "Usage: sh scripts/sync-release.sh [--skip-build] [--push] [-m msg] [--release-dir path]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -z "$RELEASE_DIR" ]; then
  RELEASE_DIR=$(CDPATH= cd -- "$PACKAGE_ROOT/../../../taste-profile" && pwd)
fi

if [ ! -f "$PACKAGE_ROOT/package.json" ]; then
  echo "Error: package root not found: $PACKAGE_ROOT" >&2
  exit 1
fi
if [ ! -d "$RELEASE_DIR/.git" ]; then
  echo "Error: release clone not found: $RELEASE_DIR" >&2
  echo "Clone: git clone https://github.com/GZHN/taste-profile.git \"$RELEASE_DIR\"" >&2
  exit 1
fi

cd "$PACKAGE_ROOT"

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "Building dist/..."
  npm run build-local
fi

echo "Syncing $PACKAGE_ROOT -> $RELEASE_DIR"

# Remove previously synced dirs/files we manage (keep .git)
for name in assets dist scripts src README.md manifest.json package.json package-lock.json tsconfig.json .gitattributes .markdownlint.json; do
  rm -rf "$RELEASE_DIR/$name"
done

for name in assets dist scripts src README.md manifest.json package.json package-lock.json tsconfig.json .gitattributes .markdownlint.json; do
  if [ -e "$PACKAGE_ROOT/$name" ]; then
    cp -R "$PACKAGE_ROOT/$name" "$RELEASE_DIR/$name"
  fi
done

cat > "$RELEASE_DIR/.gitignore" <<'EOF'
node_modules/
.tmp-revert/
*.log
.DS_Store
Thumbs.db
*.tsbuildinfo
EOF

for name in dist/index.js dist/manifest.json dist/style.css manifest.json README.md; do
  if [ ! -e "$RELEASE_DIR/$name" ]; then
    echo "Error: missing after sync: $name" >&2
    exit 1
  fi
done

echo "Sync complete."

if [ "$PUSH" -eq 0 ]; then
  cat <<EOF

Next (in release repo):
  cd "$RELEASE_DIR"
  git status
  git add -A
  git commit -m "Describe the update"
  git push
  # optional: gh release create vX.Y.Z
EOF
  exit 0
fi

if [ -z "$MESSAGE" ]; then
  MESSAGE="Update Taste Profile $(date '+%Y-%m-%d %H:%M')"
fi

cd "$RELEASE_DIR"
git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit in release repo."
  exit 0
fi
git commit -m "$MESSAGE"
git push
echo "Pushed to origin."
