# driveclaude

**Codex supervises. Claude implements.**

Codex is good at understanding a repository, making a plan, setting acceptance
criteria, watching progress, and reviewing results. Claude Code is good at
doing the implementation. Most agent integrations connect them with a simple
handoff: Codex sends a task, waits for completion, and reviews the result.
**driveclaude** keeps Codex involved throughout the work and turns it into an
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
2. send({ cwd, message }) — brief Claude and keep the returned session ID.
3. read({ sessionId, since }) repeatedly and narrate what Claude is doing.
4. If it drifts, send({ sessionId, message }) one short correction immediately.
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
| **send(cwd?, message, sessionId?, model?, fresh?)** | Start, continue, or steer Claude |
| **adopt(cwd, sessionId, model?)** | Resume an existing conversation under driveclaude |
| **read(sessionId?, cwd?, since?)** | Read new text, tool calls, errors, and results |
| **session(sessionId?, cwd?)** | Inspect one live or remembered session |
| **sessions()** | List sessions across directories |
| **diff(cwd, stat?, path?)** | Review tracked and untracked work |
| **end(sessionId?, cwd?)** | Stop the process while remembering the conversation |

The first **send** needs an absolute **cwd**. It returns a **sessionId**; Codex
should keep using that ID for later sends and reads. A cwd remains a convenient
selector while it has exactly one live session.

## Watch from another terminal

These commands observe or manage the sessions Codex is driving:

~~~bash
driveclaude status      # daemon status and log location
driveclaude sessions    # all live and remembered sessions
driveclaude session <id> # status for one session
driveclaude watch <id>   # live view of one session (ctrl-c to stop)
driveclaude adopt <id>   # resume an existing conversation under driveclaude
driveclaude diff         # inspect working-tree changes
driveclaude end <id>     # stop one live session
driveclaude stop         # stop the daemon and all sessions
~~~

IDs may be full UUIDs or the unique eight-character prefixes printed by
**driveclaude sessions**. If a project has only one live session, omitting the
ID still selects it by the current directory.

**watch** is the window into a session someone else is driving. It replays the
conversation, then stays connected and streams each message, tool call, and
turn as it happens, with a live status line showing state, turns, elapsed time
and cost. Going idle is not the end — the supervisor can send again at any
moment — so it keeps watching until you stop it.

### Interactive, background, and driveclaude sessions

A Claude **session ID identifies conversation history**. It is not an address
for attaching to a running process.

- A normal interactive Claude session belongs to the terminal that launched
  it; that terminal owns its input and output.
- A Claude background agent belongs to Claude Code's agent manager and can
  appear in Claude's background-agent UI.
- A driveclaude session runs through Claude's programmatic **-p stream-json**
  mode. Driveclaude owns its input/output so Codex can send, read, and correct
  it continuously.

Because driveclaude's process is not a Claude-managed background agent, it does
not appear as an attachable job in **claude agents**. Running
**claude --resume &lt;id&gt;** does not attach to it: it starts another process with
the same conversation history. That new Claude TUI therefore sits idle while
Codex continues driving the original driveclaude process. Use
**driveclaude watch &lt;id&gt;** for the live view.

## Hand over a session already in progress

Claude is often already working in a terminal — part-way through a refactor,
carrying all of that context. Meanwhile the real thinking about where the work
should go has been happening somewhere else: a long design discussion with
Codex, which knows the constraints and has the better view of what to do next.

**adopt** puts the two together. It preserves the conversation ID and history,
then starts a new programmatic Claude process that Codex can drive. It adopts
the conversation—not the original terminal process.

1. Ask the running session for its ID with **/status**, then exit it. Do not
   resume a second copy after handover; **--resume** continues history in a new
   process rather than attaching to driveclaude's live stream.
2. Hand it over, from that directory:

   ~~~bash
   driveclaude adopt 0b9c1f42-5d38-4a7e-9c61-3f2ab8e40d15
   ~~~

Or have Codex call **adopt({ cwd, sessionId })** directly.

From then on **send**, **read**, and **diff** behave exactly as they do for a
session driveclaude started itself, with the conversation history intact.

Adoption fails immediately, and changes nothing, if no transcript matches the
session ID, if that session belongs to a different directory, or if that exact
session is already controlled by driveclaude.

## Persistence

- Every process is identified by its Claude session ID; several may share one
  directory.
- The daemon survives Codex and terminal restarts.
- **end** stops the process but remembers its session ID; the next Codex
  **send** resumes it.
- **fresh: true** starts another conversation without killing existing sessions
  in that directory.
- **adopt** resumes a conversation started outside driveclaude in a new
  driveclaude-controlled process and remembers it like any other.
- Completed conversation history is resumable after a daemon restart.
- In-flight work and unread steering messages are not durable.
- Event cursors reset after restart; earlier JSONL logs remain on disk.

To return control to the native Claude TUI, first run **driveclaude end &lt;id&gt;**,
then run **claude --resume &lt;full-session-id&gt;**. This is another handoff: it
starts a new interactive process with the preserved history. It is not a live
attachment to the stopped driveclaude process.

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

Built and tested on macOS and Linux.

Windows support is **experimental and not yet verified on a Windows machine**.
The platform-specific pieces are in place — the daemon listens on a named pipe
instead of a Unix socket, and `claude` is launched through the shell because it
is a `.cmd` shim — but nothing has been exercised end to end there yet. WSL
remains the reliable route until someone confirms a native run. Reports
welcome.

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

Tests cover configuration trust, multiple same-directory sessions, registry
migration, fresh sessions, mid-task steering, daemon restart, crash recovery,
conversation resumption, and adopting an existing Claude conversation, using a
scripted Claude stand-in.

## Known limits

- A cwd-only command is rejected when multiple live sessions share that cwd;
  pass the session ID so driveclaude never guesses.
- Mid-task steering is best-effort and not durable across a process crash.
- **adopt** cannot detect another writer on the same conversation. Exit the
  original interactive process before adoption and watch through driveclaude.
- **send** steers between Claude steps; it does not interrupt a running tool.
- Persistent stream-json sessions do not create Claude dashboard agent jobs.

## Unofficial

Not affiliated with or endorsed by Anthropic or OpenAI. “Claude” and “Codex”
are trademarks of their respective owners.

## License

MIT
