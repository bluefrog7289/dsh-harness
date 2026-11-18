"""Harbor agent adapter for dsh (DeepSeek Harness).

Installs dsh inside the task container, layers our 14 harness plugins on top of
it through a custom `fh` profile, and drives one task per container with the
headless CLI.

The plugin names and the model route live in the repository's
``install-harness.sh``, which this adapter runs during setup. Keeping them there
means the container and the golden checkpoint are provisioned from the same
source file, and the commit SHA recorded in the manifest is exactly what ran.
"""

from __future__ import annotations

import json
import shlex
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# The repository holding the harness layer and the installer.
HARNESS_REPO = "https://github.com/bluefrog7289/dsh-harness.git"
HARNESS_COMMIT = "ae2b96db1f9be026823109a3e42e4279d6b0b966"

# dsh 0.2.2 requires node >= 24.9; the tarball avoids depending on the
# distribution's packaged version, which is older on every supported image.
NODE_VERSION = "v24.11.1"

# dsh needs a config directory per task; a container holds exactly one task.
REMOTE_DSH_HOME = "/opt/dsh-home"
REMOTE_HARNESS = "/opt/harness"
# The egress proxy swaps this placeholder for the real key on requests to the
# provider host, so the container never holds the credential.
SECRET_STUB = "runta-secret-stub"


class DshHarness(BaseInstalledAgent):
    """Runs one task with dsh's headless profile over the fh harness layer."""

    def __init__(
        self,
        *args: Any,
        provider: str = "custom",
        provider_base: str = "https://api.aijws.com/v1",
        provider_env: str = "JWS_API_KEY",
        provider_api: str = "openai-responses",
        model_id: str = "deepseek-v4.1-flash",
        context_window: int = 200000,
        max_tokens: int = 65536,
        effort: str = "max",
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._provider = provider
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

    def get_version_command(self) -> str | None:
        # Reported in the trial lock so a result is traceable to a harness build.
        return f"{REMOTE_DSH_HOME}/bin/dsh --version"

    # ------------------------------------------------------------------ setup

    async def install(self, environment: BaseEnvironment) -> None:
        """Fetch the harness layer and install dsh inside the task container."""
        script = "\n".join(
            [
                "set -euo pipefail",
                f"export DSH_HOME={REMOTE_DSH_HOME}",
                # node: a tarball keeps the version fixed regardless of the image.
                "if ! command -v node >/dev/null 2>&1; then",
                f'  mkdir -p "{REMOTE_DSH_HOME}"',
                '  arch=$(uname -m)',
                '  case "$arch" in x86_64) a=x64;; aarch64) a=arm64;; *) echo "unsupported arch $arch" >&2; exit 1;; esac',
                f'  curl -fsSL "https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-linux-$a.tar.gz"'
                f' | tar -xz -C "{REMOTE_DSH_HOME}" --strip-components=1',
                f'  export PATH="{REMOTE_DSH_HOME}/bin:$PATH"',
                "fi",
                'command -v node >/dev/null 2>&1 || { echo "node missing" >&2; exit 1; }',
                # The 14 plugins and the profile definition come from the pinned commit.
                f'if [ -d "{REMOTE_HARNESS}/.git" ]; then',
                f'  git -C "{REMOTE_HARNESS}" reset --hard -q && git -C "{REMOTE_HARNESS}" clean -qdf',
                "else",
                f'  git clone -q "{HARNESS_REPO}" "{REMOTE_HARNESS}"',
                "fi",
                f'git -C "{REMOTE_HARNESS}" fetch -q origin {HARNESS_COMMIT} || true',
                f'git -C "{REMOTE_HARNESS}" checkout -q {HARNESS_COMMIT}',
                f'cd "{REMOTE_HARNESS}"',
                f'PATH="{REMOTE_DSH_HOME}/bin:$PATH" DSH_HOME={REMOTE_DSH_HOME} \\',
                f'  PROVIDER_BASE={shlex.quote(self._provider_base)} \\',
                f'  PROVIDER_ENV={shlex.quote(self._provider_env)} \\',
                f'  PROVIDER_API={shlex.quote(self._provider_api)} \\',
                f'  MODEL_ID={shlex.quote(self._model_id)} \\',
                f'  CONTEXT_WINDOW={self._context_window} \\',
                f'  MAX_TOKENS={self._max_tokens} \\',
                f'  EFFORT={shlex.quote(self._effort)} \\',
                f'  HOME={REMOTE_DSH_HOME} bash install-harness.sh',
            ]
        )
        await self.exec_as_root(
            environment,
            command=script,
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    # -------------------------------------------------------------------- run

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        # The endpoint key arrives as a stub: the runtime's egress proxy swaps it
        # for the real value on requests to the provider host.
        env = {
            self._provider_env: SECRET_STUB,
            "DSH_HOME": REMOTE_DSH_HOME,
            "PATH": f"{REMOTE_DSH_HOME}/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME": REMOTE_DSH_HOME,
        }
        output = EnvironmentPaths.agent_dir / "dsh.txt"
        events = EnvironmentPaths.agent_dir / "dsh-events.jsonl"

        await self.exec_as_agent(
            environment,
            command=(
                f"{REMOTE_DSH_HOME}/bin/dsh --profile fh --json "
                "--permission-mode danger-full-access --approval-policy never "
                f"{shlex.quote(instruction)} "
                f"2>&1 </dev/null | tee {events.as_posix()} > {output.as_posix()}"
            ),
            env=env,
            timeout_sec=None,
        )
        self._extract_usage(environment, events, context)

    # ---------------------------------------------------------------- helpers

    def _extract_usage(
        self, environment: BaseEnvironment, events: Any, context: AgentContext
    ) -> None:
        """Read token accounting out of the run's event stream, when present."""
        # dsh's --json projection carries per-turn usage on the final event; a run
        # that died early leaves nothing to read, which is not an error.
        try:
            result = environment.exec_sync(
                command=f"tail -n 200 {events.as_posix()} 2>/dev/null || true",
                user="agent",
            )
            for line in (result.stdout or "").splitlines():
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
                context.n_input_tokens = (
                    usage.get("input_tokens") or context.n_input_tokens
                )
                context.n_output_tokens = (
                    usage.get("output_tokens") or context.n_output_tokens
                )
                context.n_cache_tokens = (
                    usage.get("cache_read_tokens") or context.n_cache_tokens
                )
        except Exception:
            return
