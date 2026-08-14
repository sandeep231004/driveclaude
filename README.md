# driveclaude

**Codex supervises. Claude implements.**

Codex is good at understanding a repository, making a plan, setting acceptance
criteria, watching progress, and reviewing results. Claude Code is good at
doing the implementation. Most agent integrations connect them with a simple
handoff: Codex sends a task, waits for completion, and reviews the result.
driveclaude keeps Codex involved throughout the work and turns it into an
active supervisor:

~~~text
you → Codex → driveclaude MCP → persistent Claude Code session
        ↑                         │
        └── text · tools · results
~~~

Codex can watch Claude work, correct it mid-task, continue the same
conversation, and review the actual diff before reporting completion.

## Why it matters

| Delegation | driveclaude |
| --- | --- |
| Codex waits for a finished result | Codex watches each step |
| Corrections require another task | Corrections enter the live session |
| Context is reconstructed | One conversation stays live and resumable |
| Codex is a dispatcher | **Codex is the supervisor** |

This is not a replacement Claude client. To talk directly to Claude, use the
Claude CLI. driveclaude exists so **Codex can drive Claude**.

## Quick start

Requirements: Node.js 18+, Git, the logged-in
[Claude Code CLI](https://claude.com/claude-code), and
[Codex CLI](https://github.com/openai/codex).

### 1. Install

~~~bash
npm install -g driveclaude
driveclaude init-codex
~~~

### 2. Teach Codex the driving loop

Add this to **~/.codex/AGENTS.md**:

~~~markdown
## Driving Claude Code

You are the driver of a live Claude Code session, not a dispatcher. You plan,
type, watch, correct, and review. You do not write implementation code
yourself.

Loop:
1. Plan the change and state your acceptance criteria.
2. send({ cwd, message }) — brief Claude with the intent and constraints.
3. read({ cwd, since }) repeatedly and narrate what Claude is doing.
4. If it drifts, send() one short correction immediately.
5. When idle, diff({ cwd }) and review the actual work.
6. Correct again or report what you verified.

Keep one unanswered message in flight at a time. The session remembers the
conversation, so keep follow-ups short.
~~~

### 3. Restart Codex

**init-codex** adds the MCP server to **~/.codex/config.toml**. Codex reads
that file at startup.

### 4. Ask Codex for a change

> Add retry with backoff to the fetcher. Use Claude for implementation, watch
> it work, and review the final diff and tests.

Codex should plan, brief Claude, narrate progress, intervene when needed, and
verify the result.

> **Safety:** driveclaude starts Claude with approval prompts disabled. Use a
> branch or disposable repository until you are comfortable with the workflow.

## What Codex can do

| MCP tool | Purpose |
| --- | --- |
| **send(cwd, message, model?, fresh?)** | Start, continue, or steer Claude |
| **read(cwd, since?)** | Read new text, tool calls, errors, and results |
| **session(cwd)** | Inspect one live or remembered session |
| **sessions()** | List sessions across directories |
| **diff(cwd, stat?, path?)** | Review tracked and untracked work |
| **end(cwd)** | Stop the process while remembering the conversation |

MCP callers must provide an absolute **cwd**.

## Watch from another terminal

These commands observe or manage the sessions Codex is driving:

~~~bash
driveclaude status      # daemon status and log location
driveclaude sessions    # all live and remembered sessions
driveclaude session     # session for the current directory
driveclaude watch       # follow the current session
driveclaude diff        # inspect working-tree changes
driveclaude end         # stop this live session
driveclaude stop        # stop the daemon and all sessions
~~~

## Persistence

- One live Claude process is bound to each directory.
- The daemon survives Codex and terminal restarts.
- **end** stops the process but remembers its session ID; the next Codex
  **send** resumes it.
- **fresh: true** intentionally starts a new conversation.
- Completed conversation history is resumable after a daemon restart.
- In-flight work and unread steering messages are not durable.
- Event cursors reset after restart; earlier JSONL logs remain on disk.

To attach manually, first run **driveclaude end**, then use the resume command
shown by **driveclaude session**. Never attach a second Claude process while
driveclaude still has the session live.

## Security and local data

Claude runs with **--dangerously-skip-permissions**. This disables Claude
Code's tool-approval prompts; driveclaude does not provide an OS sandbox.
Codex supervision, branches, tests, and diff review are the guardrails.

Starting a session marks its directory trusted in **~/.claude.json** by setting
**hasTrustDialogAccepted: true**. Existing configuration is preserved,
writes are atomic, and malformed configuration is left untouched.

Runtime state lives in **~/.driveclaude**:

- **sessions.json** — remembered directories, session IDs, and models
- **logs/<session-id>.jsonl** — prompts and structured session events
- **daemon.log** — daemon output and errors
- **daemon.sock / daemon.pid** — runtime files

Logs are plain text and can contain prompts, replies, file or command targets,
errors, and costs. Treat them as sensitive. Logs are not rotated or deleted
automatically.

## Troubleshooting

- Run **driveclaude status**, then inspect **~/.driveclaude/daemon.log**.
- Confirm **claude** is on PATH and authenticated.
- If Claude exits, send through Codex again to resume the conversation.
- If the daemon is stale, run **driveclaude stop** and retry.
- **read** needs a live session; **send** creates or resumes one.

Built for macOS and Linux. Windows is not currently supported.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| **DRIVECLAUDE_MODEL** | **sonnet** | Model for new sessions |
| **DRIVECLAUDE_CLAUDE_BIN** | **claude** | Claude Code executable |
| **DRIVECLAUDE_HOME** | **~/.driveclaude** | State, logs, PID, and socket |

## Update or uninstall

~~~bash
driveclaude stop
npm install -g driveclaude@latest
~~~

~~~bash
driveclaude stop
npm uninstall -g driveclaude
~~~

Updating preserves remembered sessions. Uninstalling does not remove
**~/.driveclaude** or trust entries in **~/.claude.json**.

## Development

~~~bash
git clone https://github.com/sandeep231004/driveclaude.git
cd driveclaude
npm install
npm test
npm pack --dry-run
~~~

Tests cover configuration trust, fresh sessions, mid-task steering, daemon
restart, crash recovery, and conversation resumption using a scripted Claude
stand-in.

## Known limits

- One session per directory; avoid path aliases to the same working tree.
- Mid-task steering is best-effort and not durable across a process crash.
- **send** steers between Claude steps; it does not interrupt a running tool.
- Persistent stream-json sessions do not create Claude dashboard agent jobs.

## Unofficial

Not affiliated with or endorsed by Anthropic or OpenAI. “Claude” and “Codex”
are trademarks of their respective owners.

## License

MIT
