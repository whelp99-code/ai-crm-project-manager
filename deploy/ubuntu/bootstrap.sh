#!/usr/bin/env bash
set -Eeuo pipefail

TARGET="${1:-/home/jm/orca/projects/AI-CRM+PM}"
REPOSITORY="${REPOSITORY:-git@github.com:whelp99-code/ai-crm-project-manager.git}"
BRANCH="${BRANCH:-feat/cwos-v2.5-ai-managed-input}"
WORKER_NAME="AI-CRM+PM"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$(dirname "$TARGET")"

if [[ -d "$TARGET/.git" ]]; then
  cd "$TARGET"
  if [[ -n "$(git status --porcelain=v1)" ]]; then
    git stash push --include-untracked --message "pre-ubuntu-deploy-$STAMP"
    echo "Existing local changes were preserved in git stash."
  fi
  git fetch --prune origin "$BRANCH"
  git switch --force-create "$BRANCH" "origin/$BRANCH"
elif [[ -e "$TARGET" ]]; then
  echo "ERROR: $TARGET exists but is not a Git repository" >&2
  exit 2
else
  git clone --branch "$BRANCH" --single-branch "$REPOSITORY" "$TARGET"
  cd "$TARGET"
fi

mkdir -p .deployment
printf '%s\n' "$WORKER_NAME" > .deployment/worker-name
printf '%s\n' "$(git rev-parse HEAD)" > .deployment/source-commit

bash deploy/ubuntu/scripts/install.sh
