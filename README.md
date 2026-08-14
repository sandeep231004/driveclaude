# driveclaude

**Codex drives. Claude types.**

Codex doesn't submit jobs to Claude Code. Codex *drives* it — typing into a live
session, watching it work, cutting in mid-task when it drifts, and carrying on.
Exactly what a person does, except the person is an agent.

```
   you  ──▶  Codex  ──MCP──▶  driveclaude daemon  ──▶  live Claude Code session
                 ▲                                            │
                 └────────── everything it says and does ──────┘
```

You watch Codex. Codex watches Claude.

## Why this is different

Every other Codex↔Claude bridge does **task delegation**: send a task, wait,
collect a result. Each turn is a fresh process; the supervisor is a dispatcher
standing outside the room.

`driveclaude` keeps **one Claude process alive** with its stdin held open. That
single fact changes what's possible:

This persistent stream-JSON session is intentional and is the default backend:
it gives Codex structured, incremental visibility into Claude's text, tool
calls, failures, costs, and turn completion while allowing follow-up messages
at any step boundary. It does not create `claude agents` dashboard jobs.

|  | task delegation | driveclaude |
| --- | --- | --- |
| process | one per task, dies after | one live session, stays open |
| mid-task message | impossible — must kill and restart | **queued, absorbed between steps** |
| context | replayed from history each time | never left |
| supervisor is | a dispatcher | **the driver of the session** |

### Steering work in flight

This is the whole point. Codex sends a correction *while Claude is working* —
nothing is interrupted, nothing restarts:

```
you › Create red/green/blue/gold.txt, each containing COLD.
  · Write red.txt
you › Change of plan — files not yet written must contain WARM.   [queued mid-task]
  · Read red.txt
claude: Got it — red.txt stays COLD (already written), the remaining three will be WARM.
  · Write green.txt
```

Result: `red.txt: COLD`, the rest `WARM`. Claude finished its current step, took
the new instruction on board, and kept going — no lost context, no restart.

## Install

```bash
npm install -g driveclaude
driveclaude init-codex
```

Needs the [Claude Code](https://claude.com/claude-code) CLI on your PATH and
logged in, plus the [Codex CLI](https://github.com/openai/codex).

## The tools Codex gets

| Tool | What it does |
| --- | --- |
| `send(cwd, message, model?, fresh?)` | Type into the live session. Returns instantly. Accepted **any time**, including mid-task — then it's queued. |
| `read(cwd, since?)` | Everything since a cursor: Claude's words, every tool call, files written, failures, turn completions. Returns a new cursor. |
| `session(cwd)` | Is a session live, how long, what has it written. |
| `sessions()` | Every session across every directory. |
| `end(cwd)` | Close the session cleanly. The conversation is remembered and resumes on next `send`. |
| `diff(cwd, stat?, path?)` | Working-tree diff vs HEAD — how Codex reviews what actually landed. |

`send` and `read` are the loop. Everything else is occasional.

## The daemon

Sessions live in a background daemon, not inside the MCP server — because Codex
kills its MCP subprocess on exit, and a session that dies with your terminal
isn't a session you can come back to.

So: **quit Codex, reopen it, and Claude is still there** — still mid-task, queue
intact, full context. Verified by killing the MCP server mid-task and attaching a
new one; the queued correction was still picked up and applied.

The daemon starts automatically on first use.

```bash
driveclaude status    # is it running?
driveclaude stop      # stop it and all sessions
```

If the daemon does die, nothing is lost permanently — session ids are persisted,
and the next `send` resumes the same conversation.

## Teaching Codex to drive

Put this in `~/.codex/AGENTS.md`:

```markdown
## Driving Claude Code

You are the driver of a live Claude Code session, not a dispatcher. You plan,
type, watch, correct, and review. You do not write implementation code
yourself.

Loop:
1. Plan the change and state your acceptance criteria.
2. send({ cwd, message }) — brief it like a capable engineer.
3. read({ cwd, since }) repeatedly while it works. Narrate what you see to me.
4. The moment it looks wrong, send() a correction. Do NOT wait for the turn to
   end — the message queues and Claude picks it up between steps.
5. When idle, diff({ cwd }) and review against your criteria.
6. Correct with another short send(), or report the finished work to me.

The session remembers everything. Keep messages short and conversational —
never restate earlier context. Keep one unanswered message in flight at a time.
```

## CLI

The same engine by hand.

```bash
driveclaude send "add retry with backoff to the fetcher"   # send, then watch
driveclaude send "actually use the existing helper"        # works mid-task too
driveclaude watch                                          # follow the live session
driveclaude read --since 42                                # replay from a cursor
driveclaude session                                        # status
driveclaude diff --stat                                    # review
driveclaude end                                            # close the session
```

Flags: `--cwd <dir>`, `--model <name>`, `--fresh`, `--since <n>`, `--stat`,
`--no-follow`.

You can always attach to the exact session Codex is driving:

```bash
claude --resume $(driveclaude session | awk '/^session/{print $2}')
```

## Autonomy

Claude runs with `--dangerously-skip-permissions` in your real working copy — it
writes, runs tests, installs things, without prompting. Headless sessions have
nobody to answer a permission dialog, and the point is hands-off delegation.

Your guardrails are Codex watching in real time, the ability to correct mid-task,
and git. Work on a branch.

## Known limits

- **The queue is in-memory.** If the Claude process dies, queued messages are
  gone silently. Keep one unanswered message in flight — the daemon reports
  queue depth as best-effort, not a guarantee. See
  [anthropics/claude-code#78338](https://github.com/anthropics/claude-code/issues/78338).
- **No mid-turn interrupt.** `send` always queues and never cuts Claude off
  (deliberate). To stop something badly wrong, `end` the session — the
  conversation resumes on the next `send`.
- **One session per directory.** Two sessions in one working copy would fight
  over the same files.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `DRIVECLAUDE_MODEL` | `sonnet` | Model for new sessions. |
| `DRIVECLAUDE_CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `DRIVECLAUDE_HOME` | `~/.driveclaude` | Sessions, event logs, daemon socket. |

## How it works

1. `send` asks the daemon for the session bound to that directory, starting one
   if needed — `claude -p --input-format stream-json --output-format stream-json
   --verbose --dangerously-skip-permissions`, stdin held open.
2. Your message is written to that stdin as a JSON user message. Claude takes it
   whenever it reaches a step boundary.
3. Claude's stream-json output is parsed into numbered events (text, thinking,
   tool calls, failures, results) kept in memory and appended to
   `~/.driveclaude/logs/<session>.jsonl`.
4. `read` returns events after your cursor, so Codex polls cheaply and only ever
   sees what's new.

## Unofficial

Not affiliated with or endorsed by Anthropic or OpenAI. "Claude" and "Codex" are
trademarks of their respective owners.

## License

MIT
