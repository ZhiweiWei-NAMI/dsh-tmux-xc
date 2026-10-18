#!/bin/sh
# Dev only: link the DSH peer packages from a local DSH install into ./node_modules so unit/integration
# tests can import them. Usage: scripts/dev-link.sh [<path to @deepseek-ai/dsh package dir>]
set -eu
DSH=${1:-$(dirname "$(readlink -f "$(command -v dsh)")")/..}
NM="$DSH/node_modules"
mkdir -p node_modules/@deepseek-ai
for p in dsh-storage-domain dsh-tools schemastery dsh-storage dsh-storage-json; do
  [ -e "$NM/@deepseek-ai/$p" ] && ln -sfn "$NM/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
[ -e "$NM/zod" ] && ln -sfn "$NM/zod" node_modules/zod
ls -la node_modules node_modules/@deepseek-ai
