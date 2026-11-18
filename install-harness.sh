#!/usr/bin/env bash
# install-harness.sh — FrontierHarness golden-checkpoint harness installer.
#
# Runs inside the build runtime at /work/harness (the cloned repo root) as the
# agent user. Installs dsh, wires the 14 harness packages into a custom `fh`
# profile that serves ACP, and pins the model route.
#
# Inputs (environment):
#   DSH_VERSION     dsh package version to install (default 0.2.2-rc.1)
#   PROVIDER_BASE   provider base URL          (default https://api.aijws.com/v1)
#   PROVIDER_ENV    env var holding the key    (default JWS_API_KEY)
#   PROVIDER_API    wire protocol              (default openai-responses)
#   MODEL_ID        model id                   (default deepseek-v4.1-flash)
#   CONTEXT_WINDOW  context length             (default 200000)
#   MAX_TOKENS      max output tokens          (default 65536)
#   EFFORT          reasoning effort           (default max)
set -euo pipefail

DSH_VERSION=${DSH_VERSION:-0.2.2-rc.1}
PROVIDER_BASE=${PROVIDER_BASE:-https://api.aijws.com/v1}
PROVIDER_ENV=${PROVIDER_ENV:-JWS_API_KEY}
PROVIDER_API=${PROVIDER_API:-openai-responses}
MODEL_ID=${MODEL_ID:-deepseek-v4.1-flash}
CONTEXT_WINDOW=${CONTEXT_WINDOW:-200000}
MAX_TOKENS=${MAX_TOKENS:-65536}
EFFORT=${EFFORT:-max}

HERE=$(cd "$(dirname "$0")" && pwd)
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

log() { printf '\n[install-harness] %s\n' "$*" >&2; }

log "node/npm"
command -v node >/dev/null || { echo "node missing" >&2; exit 1; }
node --version
npm --version

log "installing dsh@$DSH_VERSION"
npm install -g --ignore-scripts "@deepseek-ai/dsh@$DSH_VERSION"
DSH_ROOT=$(npm root -g)/@deepseek-ai/dsh
DSH_PKGS="$DSH_ROOT/node_modules/@deepseek-ai"
test -d "$DSH_PKGS" || { echo "dsh not installed at $DSH_ROOT" >&2; exit 1; }
dsh --version

log "resolving the harness checkout's dependencies"
# The packages import zod and dsh's own services by bare specifier, so both have to
# resolve from the checkout. dsh's copies are reused rather than reinstalled: a second
# copy of cordis would register a second service registry.
cd "$HERE"
[ -d node_modules/zod ] || npm install --ignore-scripts --no-audit --no-fund
mkdir -p node_modules/@deepseek-ai
for dep in dsh-llm dsh-tools dsh-compaction dsh-compaction-basic \
           dsh-compaction-tool-result-pruner dsh-session dsh-skill \
           cordis schemastery; do
  [ -d "$DSH_PKGS/$dep" ] || { echo "dsh package missing: $dep" >&2; exit 1; }
  ln -sfn "$DSH_PKGS/$dep" "node_modules/@deepseek-ai/$dep"
done

log "creating the fh profile"
# A custom profile is defined by package.json's dsh.profile.bundles. `acp` is a shipped
# template name that rejects user patches, so the profile is called `fh` and lists the
# same two bundles the acp template uses.
PROFILE_DIR="$HOME/.dsh/profiles/fh"
mkdir -p "$PROFILE_DIR/node_modules/@deepseek-ai"
cat > "$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-fh",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"]
    }
  }
}
JSON
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' \
  > "$PROFILE_DIR/pnpm-workspace.yaml"

# The profile resolves plugins from its own node_modules, so the checkout is linked in.
for pkg in "$HERE"/packages/*/; do
  base=$(basename "$pkg")
  ln -sfn "$pkg" "$PROFILE_DIR/node_modules/@deepseek-ai/$base"
done

cat > "$PROFILE_DIR/cordis.patch.yml" <<YAML
# Harness layer for the FrontierHarness evaluation: disables the two stock plugins the
# harness replaces, pins the model route, and appends the 14 packages.
- id: tool-skill
  disabled: true
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      harness:
        displayName: harness
        apiKeyEnv: ${PROVIDER_ENV}
        api: ${PROVIDER_API}
        baseURL: ${PROVIDER_BASE}
        models:
          - id: ${MODEL_ID}
            name: ${MODEL_ID}
            contextWindow: ${CONTEXT_WINDOW}
            maxTokens: ${MAX_TOKENS}
            reasoningEfforts:
              ${EFFORT}: ${EFFORT}
- id: agent-default-model
  config:
    provider: harness
    model: ${MODEL_ID}
- id: acp
  config:
    provider: harness
    model: ${MODEL_ID}
YAML

# One insert block keeps the 14 packages in a fixed order, which matters because
# several register on the same pipeline stages.
{
  echo "- insert:"
  for pkg in "$HERE"/packages/*/; do
    base=$(basename "$pkg")
    cat <<YAML
    - id: harness-${base#dsh-}
      name: '@deepseek-ai/${base}'
YAML
  done
} >> "$PROFILE_DIR/cordis.patch.yml"

log "verifying the composed profile"
dsh --profile fh --dump-config > /tmp/composed.yml
grep -q "id: harness-conduct" /tmp/composed.yml \
  || { echo "harness packages did not compose into the profile" >&2; exit 1; }
grep -q "provider: harness" /tmp/composed.yml \
  || { echo "model route did not compose into the profile" >&2; exit 1; }
printf '  composed %s rows\n' "$(grep -c '^- id:' /tmp/composed.yml)" >&2

log "smoke: ACP handshake, all 14 packages active"
handshake=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | timeout 180 dsh --profile fh 2>/tmp/handshake.err | head -1)
printf '%s' "$handshake" | grep -q '"agentInfo"' \
  || { echo "ACP handshake failed" >&2; cat /tmp/handshake.err >&2; exit 1; }
if grep -q 'entries did not activate' /tmp/handshake.err; then
  echo "some harness packages failed to activate:" >&2
  grep -E '^(harness-|[a-z-]+ \(@)' /tmp/handshake.err >&2
  exit 1
fi
printf '  ok, none skipped\n' >&2

log "done"
