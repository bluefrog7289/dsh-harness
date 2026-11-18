#!/usr/bin/env bash
# install-harness.sh — FrontierHarness golden-checkpoint harness installer.
#
# Runs inside the build runtime at /work/harness (the cloned repo root) as the
# agent user. Installs dsh, wires the 14 harness packages into a custom `fh`
# profile that boots the headless app, and pins the model route.
#
# Inputs (environment):
#   DSH_VERSION     dsh package version to install (default 0.2.2-rc.1)
#   PROVIDER_BASE   provider base URL          (default https://ai.noxbin.com/v1)
#   PROVIDER_ENV    env var holding the key    (default EGG_API_KEY)
#   PROVIDER_API    wire protocol              (default openai-responses)
#   MODEL_ID        model id                   (default deepseek-v4.1-flash)
#   CONTEXT_WINDOW  context length             (default 200000)
#   MAX_TOKENS      max output tokens          (default 65536)
#   EFFORT          reasoning effort           (default max)
#   PROVIDER_UA     User-Agent to send         (default a browser string)
set -euo pipefail

DSH_VERSION=${DSH_VERSION:-0.2.2-rc.1}
PROVIDER_BASE=${PROVIDER_BASE:-https://ai.noxbin.com/v1}
PROVIDER_ENV=${PROVIDER_ENV:-EGG_API_KEY}
PROVIDER_API=${PROVIDER_API:-openai-responses}
MODEL_ID=${MODEL_ID:-deepseek-v4.1-flash}
CONTEXT_WINDOW=${CONTEXT_WINDOW:-200000}
MAX_TOKENS=${MAX_TOKENS:-65536}
EFFORT=${EFFORT:-max}
# The provider sits behind Cloudflare, whose browser-integrity rule rejects a
# `node` User-Agent with error 1010 before the request ever reaches the API.
PROVIDER_UA=${PROVIDER_UA:-Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36}

HERE=$(cd "$(dirname "$0")" && pwd)
# The runner uploads this script to /work and invokes it after cd'ing into the clone,
# so the script's own directory is not necessarily the repo root.
if [ ! -d "$HERE/packages" ] && [ -d "$PWD/packages" ]; then
  HERE=$PWD
fi
[ -d "$HERE/packages" ] || { echo "repo root not found (no packages/ under $HERE or $PWD)" >&2; exit 1; }
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

log() { printf '\n[install-harness] %s\n' "$*" >&2; }

log "node/npm"
# The build image ships no node. dsh 0.2.2 requires node >= 24.9, and a tarball
# install avoids depending on whichever distro package version the image happens to have.
# A previous run may have installed node without leaving it on PATH.
if ! command -v node >/dev/null && [ -d "$HOME/.local/node/bin" ]; then
  export PATH="$HOME/.local/node/bin:$PATH"
fi
if ! command -v node >/dev/null; then
  NODE_VERSION=${NODE_VERSION:-v24.11.1}
  arch=$(uname -m); case "$arch" in x86_64) a=x64;; aarch64) a=arm64;; *) echo "unsupported arch $arch" >&2; exit 1;; esac
  # curl is installed by the adapter where apt exists; git needs it too, so it is
  # always present by the time this runs.
  mkdir -p "$HOME/.local"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$a.tar.gz" \
    | tar -xz -C "$HOME/.local"
  ln -sfn "$HOME/.local/node-$NODE_VERSION-linux-$a" "$HOME/.local/node"
  export PATH="$HOME/.local/node/bin:$PATH"
fi
command -v node >/dev/null || { echo "node missing after install" >&2; exit 1; }
node --version
npm --version

# Node ships its own CA store and ignores the system bundle, so a sandbox that
# terminates TLS has to be named explicitly. Harmless when the file is absent
# (no proxy in the path).
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f /usr/local/share/ca-certificates/runta-egress.crt ]; then
  export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/runta-egress.crt
fi

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
# A custom profile is defined by package.json's dsh.profile.bundles. The evaluation
# drives dsh one task at a time and reads its event stream, which is the `headless`
# app, so the profile lists the headless bundles rather than the acp ones.
# dsh resolves the profile under $DSH_HOME when that is set, and under ~/.dsh otherwise;
# the profile has to be written where dsh will look for it.
DSH_ROOT=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR="$DSH_ROOT/profiles/fh"
mkdir -p "$PROFILE_DIR/node_modules/@deepseek-ai"
cat > "$PROFILE_DIR/package.json" <<'JSON'
{
  "name": "dsh-profile-fh",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
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
# Harness layer for the FrontierHarness evaluation.
#
# tool-result-pruner is the stock 每步裁剪器 and it stays on: the harness relies on it
# rather than reimplementing it. Its stock threshold (8192 chars) is close to the size of
# a typical tool result here, so it almost never fired; 2048/1024/512 keeps a readable
# head and tail while actually reclaiming the middle of large dumps.
#
# tool-skill is off because every task in this evaluation is self-contained.
- id: tool-skill
  disabled: true
- id: tool-result-pruner
  config:
    thresholdChars: 2048
    headChars: 1024
    tailChars: 512
- id: llm-pi-ai
  config:
    providers:
      harness:
        displayName: harness
        apiKeyEnv: ${PROVIDER_ENV}
        api: ${PROVIDER_API}
        baseURL: ${PROVIDER_BASE}
        headers:
          User-Agent: "${PROVIDER_UA}"
        # The route default effort. reasoningEfforts on the model only declares which
        # levels exist; it does not select one. dsh drops a per-agent reasoningEffort
        # whenever the model declares reasoningEfforts (adapterDefaults), so the route
        # field is the one that actually reaches the wire.
        reasoning: ${EFFORT}
        # Without a policy dsh does not retry at all (llm-retry returns early when no
        # provider carries one), so a single upstream hiccup loses the whole turn.
        retryPolicy:
          mode: normal
          maxRetries: 3
          retryableCodes:
            - EMPTY_RESPONSE
            - RATE_LIMIT
            - SERVER
            - TIMEOUT
            - TRANSPORT
          backoff:
            initialDelayMs: 2000
            maxDelayMs: 30000
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
YAML

# One insert block keeps the 14 packages in a fixed order, which matters because
# several register on the same pipeline stages.
{
  echo "- insert:"
  for pkg in "$HERE"/packages/*/; do
    base=$(basename "$pkg")
    printf "    - id: harness-%s\n      name: '@deepseek-ai/%s'\n" "${base#dsh-}" "$base"
  done
} >> "$PROFILE_DIR/cordis.patch.yml"

log "verifying the composed profile"
dsh --profile fh --dump-config > /tmp/composed.yml
grep -q "id: harness-conduct" /tmp/composed.yml \
  || { echo "harness packages did not compose into the profile" >&2; exit 1; }
grep -q "provider: harness" /tmp/composed.yml \
  || { echo "model route did not compose into the profile" >&2; exit 1; }
printf '  composed %s rows\n' "$(grep -c '^- id:' /tmp/composed.yml)" >&2

log "smoke: boot the profile, all 14 packages active"
# Booting the app's plugin tree is what proves the composition; --help reaches the
# headless app's own parser and exits, so no provider key is needed at build time.
timeout 180 dsh --profile fh --help >/tmp/smoke.out 2>/tmp/smoke.err || true
grep -q -- '--permission-mode' /tmp/smoke.out \
  || { echo "the fh profile did not boot the headless app:" >&2; tail -20 /tmp/smoke.out /tmp/smoke.err >&2; exit 1; }
if grep -q 'entries did not activate' /tmp/smoke.err; then
  echo "some harness packages failed to activate:" >&2
  grep -E '^(harness-|[a-z-]+ \(@)' /tmp/smoke.err >&2
  exit 1
fi
printf '  ok, headless app booted\n' >&2

log "done"
