"""Pier agent adapter for dsh (DeepSeek Harness).

dsh is installed at image-build time, when the network is open, and then driven
inside the task container with the headless CLI. Runtime egress goes through
Pier's per-agent allowlist, which is the only reason a task with
``allow_internet = false`` can still reach its model provider: the task
environment stays sealed while the agent process gets a narrow, auditable path
to exactly one host.

The plugin set and model route live in the harness repository's
``install-harness.sh``. Installing from the pinned commit keeps the image, the
golden checkpoint, and the trial lock describing the same code.
"""

from __future__ import annotations

import base64
import json
import shlex

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

HARNESS_REPO = "https://github.com/bluefrog7289/dsh-harness.git"
HARNESS_COMMIT = "96362430ae7cf85cb07f3b4af5b4dee15ab827f8"
DSH_VERSION = "0.2.2-rc.1"
NODE_VERSION = "v24.11.1"

# One container per task, so a single config root is enough.
REMOTE_DSH_HOME = "/opt/dsh-home"
SECRET_STUB = "runta-secret-stub"

# The sandbox's egress proxy terminates TLS with its own CA. Build-time network
# calls leave through that proxy, so the CA has to exist inside the image before
# the first https request. The file lives on the machine pier runs on, which is
# the same machine whose proxy the build containers use.
EGRESS_CA_PATH = "/usr/local/share/ca-certificates/runta-egress.crt"


def _egress_ca_b64() -> str | None:
    try:
        with open(EGRESS_CA_PATH, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    return base64.b64encode(raw).decode() if raw else None


class DshHarnessAgent(BaseAgent):
    """Runs one task with dsh's headless profile over the fh harness layer."""

    def __init__(
        self,
        *args,
        provider_base: str = "https://api.aijws.com/v1",
        provider_env: str = "JWS_API_KEY",
        provider_api: str = "openai-responses",
        model_id: str = "deepseek-v4.1-flash",
        context_window: int = 200000,
        max_tokens: int = 65536,
        effort: str = "max",
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._provider_base = provider_base
        self._provider_env = provider_env
        self._provider_api = provider_api
        self._model_id = model_id
        self._context_window = context_window
        self._max_tokens = max_tokens
        self._effort = effort

    @staticmethod
    def name() -> str:
        return "dsh-harness"

    def version(self) -> str | None:
        return DSH_VERSION

    # ------------------------------------------------------------------ build

    def install_spec(self) -> AgentInstallSpec:
        """Install node and dsh, then bake the fh profile into the image."""
        env = {
            "DSH_HOME": REMOTE_DSH_HOME,
            "PROVIDER_BASE": self._provider_base,
            "PROVIDER_ENV": self._provider_env,
            "PROVIDER_API": self._provider_api,
            "MODEL_ID": self._model_id,
            "CONTEXT_WINDOW": str(self._context_window),
            "MAX_TOKENS": str(self._max_tokens),
            "EFFORT": self._effort,
        }
        run = "\n".join(
            [
                "set -euo pipefail",
                "export DEBIAN_FRONTEND=noninteractive",
                # The sandbox's egress proxy MITMs TLS. Trust its CA first, or every
                # https call during the build dies on certificate verification.
                'if [ -n "${EGRESS_CA_B64:-}" ]; then',
                '  echo "$EGRESS_CA_B64" | base64 -d > /usr/local/share/ca-certificates/runta-egress.crt',
                "  update-ca-certificates >/dev/null 2>&1 || true",
                "fi",
                # Task images are deliberately minimal: the regex-log image ships no
                # python, curl, git or node. apt is available at build time.
                "apt-get update -qq",
                "apt-get install -y -qq --no-install-recommends"
                " ca-certificates curl git xz-utils",
                f"mkdir -p {REMOTE_DSH_HOME}",
                'arch=$(uname -m)',
                'case "$arch" in x86_64) a=x64;; aarch64) a=arm64;; *) echo "unsupported arch $arch" >&2; exit 1;; esac',
                f'curl -fsSL "https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-linux-$a.tar.gz"'
                f' | tar -xz -C {REMOTE_DSH_HOME} --strip-components=1',
                f'export PATH="{REMOTE_DSH_HOME}/bin:$PATH"',
                # The harness layer comes from the pinned commit, not a branch.
                f'git clone -q {HARNESS_REPO} /opt/harness',
                f'git -C /opt/harness checkout -q {HARNESS_COMMIT}',
                'cd /opt/harness',
                'HOME=' + REMOTE_DSH_HOME + ' bash install-harness.sh',
            ]
        )
        ca = _egress_ca_b64()
        if ca:
            env["EGRESS_CA_B64"] = ca
        return AgentInstallSpec(
            agent_name=self.name(),
            version=DSH_VERSION,
            steps=[InstallStep(run=run, user="root", env=env)],
            verification_command=f"{REMOTE_DSH_HOME}/bin/dsh --version",
        )

    # -------------------------------------------------------------------- run

    def network_allowlist(self) -> NetworkAllowlist:
        # Exactly the one host the model route talks to; nothing else is opened,
        # so a no-network task stays sealed apart from its own LLM calls.
        host = self._provider_base.split("://", 1)[-1].split("/", 1)[0]
        return NetworkAllowlist(domains=[host])

    async def setup(self, environment: BaseEnvironment) -> None:
        # The profile is baked into the image at build time; a task container only
        # needs the config root to exist and be writable by the agent user, plus a
        # trusted copy of the egress CA for the runtime model calls.
        lines = [
            f"mkdir -p {REMOTE_DSH_HOME} && chown -R $(id -u):$(id -g) {REMOTE_DSH_HOME}",
            f"export DSH_HOME={REMOTE_DSH_HOME}",
        ]
        ca = _egress_ca_b64()
        if ca:
            lines.append(
                f"if [ ! -f /usr/local/share/ca-certificates/runta-egress.crt ]; then "
                f"echo {ca} | base64 -d > /usr/local/share/ca-certificates/runta-egress.crt && "
                f"(update-ca-certificates >/dev/null 2>&1 || true); fi"
            )
        await environment.exec(command="\n".join(lines))

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Agent logs land on a host directory that the trial mounts at /logs, so the
        # command writes to the in-container path and the usage reader reads the host
        # path the mount points at.
        events_name = "dsh-events.jsonl"
        output_name = "dsh.txt"

        # The key is a stub: Pier's egress proxy replaces it on the way out, so the
        # container never holds the real credential.
        cmd = (
            f"export {self._provider_env}={SECRET_STUB}\n"
            f'export DSH_HOME={REMOTE_DSH_HOME}\n'
            f'export PATH="{REMOTE_DSH_HOME}/bin:/usr/local/bin:/usr/bin:/bin"\n'
            f"mkdir -p /logs/agent\n"
            f'{REMOTE_DSH_HOME}/bin/dsh --profile fh --json '
            "--permission-mode danger-full-access --approval-policy never "
            f"{shlex.quote(instruction)} 2>&1 </dev/null "
            f"| tee /logs/agent/{events_name} "
            f"> /logs/agent/{output_name}"
        )
        await environment.exec(command=cmd, timeout_sec=None)

        self._read_usage(self.logs_dir / events_name, context)

    # ---------------------------------------------------------------- helpers

    def _read_usage(self, events_path, context: AgentContext) -> None:
        """Pull token accounting out of the run's event stream when it is there."""
        # A run that died before the first turn leaves no usage; that is not an
        # error, and the trial records zeroes exactly as any crashed agent would.
        try:
            text = events_path.read_text(errors="replace")
        except OSError:
            return
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            usage = event.get("usage") or {}
            if not usage:
                continue
            if usage.get("input_tokens"):
                context.n_input_tokens = usage["input_tokens"]
            if usage.get("output_tokens"):
                context.n_output_tokens = usage["output_tokens"]
            if usage.get("cache_read_tokens"):
                context.n_cache_tokens = usage["cache_read_tokens"]
