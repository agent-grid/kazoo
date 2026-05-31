# tb-hello-world — provenance

Ported from **Terminal-Bench** (laude-institute), legacy `task.yaml` format:
<https://github.com/laude-institute/terminal-bench/tree/main/original-tasks/hello-world>

## Upstream task (verbatim)
- **instruction:** `Create a file called /app/hello.txt. Write "Hello, world!" to it.`
- **oracle (`solution.sh`):** `echo "Hello, world!" > hello.txt`
- **verifier (`tests/test_outputs.py`):** two `pathlib` assertions — file exists, content equals `Hello, world!`.
- **scoring:** binary — all pytest tests pass ⇒ 1, else 0.

## What we changed for a host-only run
1. **No Docker.** TB builds `ghcr.io/laude-institute/t-bench/python-3-13` and runs the agent + tests inside it via tmux. We run the agent's own `bash`/`write_file` tools on the host, scoped to the per-run workspace (`artifacts/<runId>/workspace`).
2. **Path rewrite.** The test's hard-coded `/app` is read from `TBENCH_WORKDIR` (set to the run workspace by `verify.ts`). This is the only edit to the test; assertions are unchanged.
3. **Instruction** rephrased from `/app/hello.txt` to "hello.txt in the current working directory" because the agent's bash cwd *is* the workspace and the sandbox blocks absolute paths. Original instruction preserved in `scenario.json → expected_outcome.instruction_original`.
4. **Test deps.** TB's `run-tests.sh` installs `uv` + `pytest`. `verify.ts` prefers a system `pytest`, falling back to `uv run --no-project --with pytest pytest` so nothing is installed globally.

## Run it
```
bun run eval run scenarios/tb-hello-world --agent openai-realtime
```
