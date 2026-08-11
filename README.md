# codex-claude-bridge

Let **Codex** supervise **Claude Code**.

Codex plans and reviews. Claude Code implements. You only ever look at Codex.

```
   you  ──▶  Codex (supervisor)  ──MCP──▶  bridge  ──▶  Claude Code (implementer, sonnet)
                    ▲                                          │
                    └────────── progress · diffs · results ─────┘
```

Codex gets six tools. It sends an instruction to Claude exactly as a user would
type it, watches the work land, reads the diff, and sends corrections — all
without you leaving the Codex TUI.

## Why

Codex is good at planning and reviewing. Claude Code is good at grinding through
implementation. This wires the first to the second, so the expensive reasoning
happens once, at the top, and the cheap model does the typing.

The key detail: **it's one persistent Claude session per directory.** Turn one is
a full brief, turn five is "now handle the empty-input case" — Claude still
remembers everything. That's what makes Codex feel like it's driving a session
rather than firing off disconnected one-shot jobs.

## Install

```bash
npm install -g codex-claude-bridge
bridge init-codex          # registers the MCP server in ~/.codex/config.toml
```

Requires the [Claude Code](https://claude.com/claude-code) CLI (`claude`) on your
PATH and logged in, plus the [Codex CLI](https://github.com/openai/codex).

`init-codex` appends this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude]
command = "bridge"
args = ["mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

## The tools Codex sees

| Tool | What it does |
| --- | --- |
| `implement(cwd, task, model?, new_session?)` | Send an instruction to the persistent Claude session. Returns a `task_id` immediately. |
| `status(task_id, full?)` | Live progress — current tool, files written — then the final result. |
| `diff(cwd, stat?, path?)` | Working-tree diff vs HEAD plus untracked files, for review. |
| `cancel(task_id)` | Stop a running task. Edits already on disk stay. |
| `session(cwd, reset?)` | Inspect the bound session, or reset it for a clean slate. |
| `tasks(cwd?, limit?)` | Recent tasks, newest first. |

Delegation is **asynchronous**: `implement` returns in milliseconds, and Codex
polls `status` while Claude works. A twenty-minute task never trips a tool
timeout, and Codex can narrate progress to you as it goes.

Only **one turn at a time per directory** — a session can't take two
simultaneous turns, so a second `implement` on a busy directory is rejected with
a clear message rather than corrupting the conversation.

## Teaching Codex to supervise

The tools alone don't make Codex behave like a supervisor. Add this to
`~/.codex/AGENTS.md` (or a project `AGENTS.md`):

```markdown
## Delegating implementation to Claude Code

You are the supervisor. You plan, delegate, review, and correct. You do not
write implementation code yourself — the `claude` MCP server does that.

Loop:
1. Plan the change and state the acceptance criteria.
2. `implement({ cwd, task })` with a specific, self-contained instruction.
3. Poll `status({ task_id })` until it is no longer running. Tell me what it's
   doing while you wait.
4. `diff({ cwd })` and actually review the change against your criteria.
5. If it's wrong, `implement()` a correction — keep it short, the session
   remembers the earlier turns.
6. Report the finished change to me with what you verified.

Write the task like you're briefing a capable engineer: intent, constraints,
and how you'll judge it. Don't restate context from earlier turns in the same
session — Claude still has it.
```

## CLI

The same engine, driven by hand. Useful for debugging, or firing off a
delegation outside Codex.

```bash
bridge send "add retry with backoff to the fetcher"   # delegate and follow live
bridge send "now add tests" --model opus              # same session, different model
bridge status t1abc2def                               # progress or result
bridge session                                        # session id, turns, recent tasks
bridge session --reset                                # start fresh next time
bridge diff --stat                                    # review
bridge tasks                                          # history
bridge cancel t1abc2def
```

Flags: `--cwd <dir>`, `--model <name>`, `--new`, `--detach`, `--stat`,
`--reset`, `--full`.

Because the bridge owns the session UUID, you can always attach to the exact
session Codex has been driving:

```bash
claude --resume $(bridge session | awk '/^session/{print $2}')
```

## Autonomy

The implementer runs with `--dangerously-skip-permissions` in your actual
working copy — it writes files, runs tests, installs dependencies, with no
prompts. That's deliberate: a headless session has nobody to answer a permission
dialog, and the whole point is hands-off delegation.

Your guardrail is Codex's review plus git. Work on a branch. If you want harder
isolation, point `cwd` at a `git worktree`.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_MODEL` | `sonnet` | Default implementer model. |
| `BRIDGE_CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `BRIDGE_HOME` | `~/.bridge` | Where sessions, task records, and logs live. |

State layout:

```
~/.bridge/
  sessions.json      cwd -> { sessionId, turns, ... }
  tasks/<id>.json    task record
  tasks/<id>.log     raw stream-json from Claude Code
  tasks/<id>.err     stderr
```

Tasks are spawned **detached** with output redirected to those logs, so status
is read from disk. A delegated task survives Codex restarting, and the CLI and
the MCP server see exactly the same state.

## How it works

1. `implement` resolves the directory to a session. First turn mints a UUID and
   passes `--session-id`; every later turn passes `--resume <uuid>`.
2. It spawns `claude -p <task> --model sonnet --output-format stream-json
   --verbose --dangerously-skip-permissions`, detached, logging to disk.
3. `status` parses that stream-json log into a snapshot: assistant text, tool
   calls, files written, cost, and the final result — plus a liveness check on
   the pid so a crashed run surfaces as an error instead of hanging forever.

## License

MIT
