# driveclaude

**Codex drives. Claude types.**

Codex doesn't submit jobs to Claude Code. Codex *drives* it — typing into a live
session, watching it work, cutting in mid-task when it drifts, and carrying on.
Exactly what a person does, except the person is an agent.

```
   you  ──▶  Codex  ──MCP──▶  driveclaude daemon  ──▶  live Claude Code session
                 ▲                                            │
                 └──────── text · tool calls · results ────────┘
```

You watch Codex. Codex watches Claude.

## Why this is different

Task delegation — send a job, wait, collect a result — treats Claude Code as a
subprocess: one process per task, dead the moment it answers, replaying
history from scratch next time.

`driveclaude` instead keeps **one Claude process alive** with its stdin held
open. That single fact changes what's possible:

This persistent stream-json session is intentional and is the default
backend: it gives Codex structured, incremental visibility into Claude's
text, tool calls, failures, costs, and turn completion, while allowing
follow-up messages at any step boundary. It does not create `claude agents`
dashboard jobs.

|  | task delegation | driveclaude |
| --- | --- | --- |
| process | one per task, dies after | one live session, stays open |
| mid-task message | impossible — must kill and restart | **absorbed between steps** |
| context | replayed from history each time | **held live in the process, resumable across restarts** |
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

Result: `red.txt: COLD`, the rest `WARM`. Claude finished its current step,
took the new instruction on board, and kept going — no lost context, no
restart.

## Prerequisites

- **Node.js 18+** — driveclaude is a Node CLI (`engines.node >= 18`).
- **Git** — needed for `diff`, and generally assumed since the guidance below
  is to run Claude on a branch. Directories that aren't git repos still work
  for everything except `diff`.
- **[Claude Code](https://claude.com/claude-code) CLI**, on your `PATH` and
  already logged in — driveclaude spawns it directly (`claude` by default;
  override with `DRIVECLAUDE_CLAUDE_BIN`).
- **[Codex CLI](https://github.com/openai/codex)** — only needed if Codex is
  the one driving. The `driveclaude` CLI itself works standalone without it.

## Install

```bash
npm install -g driveclaude
```

Installing from source instead? See "Development" below.

## Quick start

**1. Verify the core loop, without Codex involved yet.**

> **Before you run this:** Claude's own approval prompts are disabled (see
> "Security & permissions" below) — it can edit files and run commands the
> moment it starts. Use a scratch repo or branch for this first run.

```bash
cd /path/to/a/project
driveclaude send "say hello, then list the files in this directory"
```

The first run starts the background daemon automatically, spawns a live
`claude` process, and streams its output as it works. If you see Claude's
reply followed by a line starting with `── turn complete`, the daemon and
the Claude Code CLI are both working end to end.

```bash
driveclaude session   # status of that session, plus a manual-attach command
driveclaude diff      # confirms git integration (nothing to show yet)
driveclaude end       # close it — the conversation is remembered
```

**2. Register driveclaude with Codex.**

```bash
driveclaude init-codex
```

This adds an `[mcp_servers.claude]` block to `~/.codex/config.toml` — but
only if that block isn't already there. If one already exists, `init-codex`
leaves it exactly as-is (it does not update or merge it); edit the file by
hand if you need to change it. Then add the instructions from "Teaching
Codex to drive" below to `~/.codex/AGENTS.md`.

Restart Codex (or start it fresh) after running this — it reads
`config.toml` at startup, so an already-running Codex process won't pick up
the new MCP server.

**3. Verify Codex can drive it.** Start `codex` in a project and ask it to
make a small change. While it's working, in another terminal:

```bash
driveclaude sessions   # the session Codex just started, live
driveclaude watch      # follow along yourself
```

If you see Codex's session there and `watch` shows the same activity Codex is
narrating, the whole chain — Codex → MCP → daemon → Claude — is wired up.

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
   end — the message is picked up between steps.
5. When idle, diff({ cwd }) and review against your criteria.
6. Correct with another short send(), or report the finished work to me.

The session remembers everything. Keep messages short and conversational —
never restate earlier context. Keep one unanswered message in flight at a time.
```

## MCP tools

| Tool | What it does |
| --- | --- |
| `send(cwd, message, model?, fresh?)` | Type into the live session. Returns instantly. Accepted **any time**, including mid-task — Claude picks it up at its next step boundary. |
| `read(cwd, since?)` | Everything since a cursor: Claude's words, every tool call, files written, failures, turn completions. Returns a new cursor. |
| `session(cwd)` | Is a session live, how long, what it has written, and (if one exists) an attach-by-hand command. |
| `sessions()` | Every session across every directory — live and remembered. |
| `end(cwd)` | Close the session cleanly. The conversation is remembered and resumes on next `send`. |
| `diff(cwd, stat?, path?)` | Working-tree diff vs HEAD — how Codex reviews what actually landed. |

`send` and `read` are the loop. Everything else is occasional.

`cwd` must be an **absolute path**. It's resolved inside the long-lived
daemon process, not wherever the calling agent happens to be running — a
relative path resolves against the wrong directory.

## CLI

The same engine by hand.

```bash
driveclaude send "add retry with backoff to the fetcher"   # send, then watch
driveclaude send "actually use the existing helper"        # works mid-task too
driveclaude watch                                          # follow the live session
driveclaude read --since 42                                # replay from a cursor
driveclaude session                                        # status of this directory
driveclaude sessions                                       # every session, everywhere
driveclaude diff --stat                                    # review
driveclaude end                                            # close the session
driveclaude status                                         # is the daemon running?
driveclaude stop                                           # stop the daemon and all sessions
driveclaude daemon                                         # run the daemon in the foreground
```

Flags: `--cwd <dir>` (default: current directory), `--model <name>` (new
sessions only), `--fresh` (abandon the existing conversation and start over),
`--since <n>`, `--stat`, `--no-follow` (`send`: don't watch afterwards).

For the CLI, `--cwd` is resolved against your actual current directory before
it's sent to the daemon, so relative paths work as expected.

## The daemon

Sessions live in a background daemon, not inside the MCP server — because
Codex kills its MCP subprocess on exit, and a session that dies with your
terminal isn't a session you can come back to. The daemon starts
automatically on first use and outlives Codex, your terminal, and this CLI.

Mechanically:

1. `send` asks the daemon for the session bound to that directory, starting
   one if needed: `claude -p --input-format stream-json --output-format
   stream-json --verbose --dangerously-skip-permissions --model <model>
   --session-id <id>` (or `--resume <id>` for a remembered conversation),
   stdin held open.
2. Your message is written straight to that stdin as a JSON user message.
   Claude takes it whenever it reaches a step boundary.
3. Claude's stream-json output is parsed into numbered events (text,
   thinking, tool calls, failures, results), kept in memory (last 5000 per
   session) and appended to `~/.driveclaude/logs/<session-id>.jsonl`.
4. `read` returns events after your cursor, so polling is cheap and only ever
   returns what's new.

### What's actually persisted

- **Durable across a daemon restart or crash:** the session id and model
  (written to `~/.driveclaude/sessions.json` as soon as a session starts),
  and Claude's own history of *completed, acknowledged* turns, which its
  `--resume` flag reloads. This is exercised in the test suite by killing the
  daemon mid-conversation, restarting it, and confirming the same
  conversation resumes.
- **Not guaranteed, even on Claude's side:** anything in flight at the moment
  of a crash — a tool call that hadn't finished, or a steering message
  Claude's CLI hadn't yet read off stdin — may not be recoverable when the
  session resumes. Don't rely on in-progress work surviving a crash; treat
  "durable" as covering the conversation up to the last completed turn only.
- **Reset on restart, but not lost:** driveclaude's own in-memory event log
  and cursor. A daemon restart zeroes them even though the Claude
  conversation itself resumes — old events stay in the `.jsonl` file on disk
  (see "Storage, logs & cleanup"), but `read` won't replay them, and sequence
  numbers restart from 1 in that same file (they're only unique within one
  daemon's uptime).
- **Not a real queue:** there is no in-memory buffer of pending messages.
  `send` writes directly to the live process's stdin the instant it's called.
  If Claude is mid-turn, its own CLI absorbs that stdin line and folds it
  into the response as steering (that's what "queued" means in the output).
  If the process dies before it reads that line, the message is lost
  silently — there's nothing left to recover. Keep one unanswered message in
  flight at a time; queue depth is best-effort and not a guarantee. See
  [anthropics/claude-code#78338](https://github.com/anthropics/claude-code/issues/78338).

### Attaching by hand

`driveclaude session` ends with an attach command whenever a live or
remembered session exists for that directory (nothing to attach to if
neither does):

```bash
driveclaude session
# ... attach by hand: claude --resume <session-id>
claude --resume <session-id>
```

or in one line:

```bash
claude --resume $(driveclaude session | grep 'attach by hand' | awk '{print $NF}')
```

Only attach by hand when there's **no live driveclaude session** for that
directory — check with `driveclaude session` first, and run `driveclaude end`
if it shows one live. Two processes writing to the same conversation at once
is not supported.

## Security & permissions

Claude runs with `--dangerously-skip-permissions` in your real working copy.
This disables Claude Code's own interactive tool-approval prompts — the
per-action "allow this Bash command / this Edit / this Write?" dialog you'd
normally see. It is not an OS-level sandbox — driveclaude doesn't provide
one. With approval prompts off, Claude edits files, runs shell commands, and
installs things immediately, because a headless session has nobody to click
"allow."

This is **supervised autonomy, not unattended automation** — something is
expected to be watching. Your guardrails are Codex (or you, via the CLI)
watching in real time over `send`/`read`, the ability to correct mid-task or
`end` a session that's gone wrong, and ordinary git hygiene: work on a
branch, review with `diff` before merging.

Starting a session also marks that directory as trusted in your real
`~/.claude.json` (`hasTrustDialogAccepted: true`), because
`--dangerously-skip-permissions` never shows the interactive trust dialog
itself — left unfixed, a human later running plain `claude` there would hit
that prompt unexpectedly. The write only ever touches that one field: other
config keys and other projects' entries are preserved, the file is written
atomically (temp file + rename), and a config that exists but fails to parse
is left untouched rather than risked. One side effect: after driveclaude has
touched a directory, `claude` run there by hand skips the trust dialog too.

## Storage, logs & cleanup

Everything lives under `~/.driveclaude` (override with `DRIVECLAUDE_HOME`):

| Path | What it is |
| --- | --- |
| `daemon.sock` | Unix domain socket the CLI and MCP server talk to |
| `daemon.pid` | PID of the running daemon |
| `daemon.log` | daemon stdout/stderr — first place to look when something won't start |
| `sessions.json` | `cwd → { sessionId, model }`, so a restart resumes the right conversation |
| `logs/<session-id>.jsonl` | every event for that session, one JSON object per line |

**These logs are sensitive.** `daemon.log` and every `logs/*.jsonl` file can
contain full prompts, Claude's replies, file paths and shell command
targets, error text, and per-turn costs — effectively your conversation
history in plain text. Treat `~/.driveclaude` like any other directory of
credentials or private chat logs: don't commit it, sync it somewhere public,
or share it without checking what's inside first.

Nothing here is rotated or capped on disk. In memory each session keeps only
its last 5000 events, but a session's `.jsonl` file is never truncated,
rotated, or cleaned up automatically — it keeps growing for as long as the
session is used, and the file itself is never deleted, including after
`end` or `fresh`, only when you remove it by hand. To reclaim space:
`driveclaude stop`, then `rm -rf ~/.driveclaude`. That forgets every
remembered session (the next `send` in
each directory starts a brand-new conversation) but does not touch Claude's
own conversation storage, and does not undo the trust entries driveclaude
added to `~/.claude.json` — remove those by hand if you want them gone too.

## Supported platforms

Built for macOS and Linux; there's no automated cross-platform testing (no
CI), so treat that as the assumed rather than verified target. The daemon
listens on a Unix domain socket file (`~/.driveclaude/daemon.sock`); Windows
isn't supported and would likely need changes to that transport.

## Troubleshooting

- **`driveclaude status`** — is the daemon running, and where its log is
  (`~/.driveclaude/daemon.log`). Check that log first for anything that won't
  start.
- **`daemon failed to start`** — usually the `claude` binary isn't on `PATH`,
  or `DRIVECLAUDE_CLAUDE_BIN` points at something that doesn't exist. Check
  `daemon.log`.
- **`no live session for <cwd> — send a message to start one`** — only
  `read` requires a session to already exist; `send` is what creates one.
  The other commands don't need one: `session` reports live, remembered, or
  none without erroring; `diff` works independently as long as `cwd` is a
  git repo; `end` just prints `no live session for <cwd>` if there's nothing
  to close.
- **`session is not running`** from `send` — the Claude process exited and
  hasn't been replaced yet. This normally self-heals: the *next* `send`
  resumes the same conversation. If it keeps happening, check `daemon.log`.
- **`cwd does not exist or is not a directory`** — the path must already
  exist; driveclaude never creates one for you.
- **Stuck daemon / stale socket** — `driveclaude stop`, then retry. If that
  hangs, find and kill the PID in `~/.driveclaude/daemon.pid` yourself.

## Updating & uninstalling

Stop the daemon *before* updating. It runs detached and keeps whatever code
it already loaded — replacing the installed package doesn't affect an
already-running daemon, so if you skip this you can end up running commands
against a stale daemon without realizing it:

```bash
driveclaude stop
npm install -g driveclaude@latest
```

The next `driveclaude` command starts a fresh daemon on the new version.
Remembered sessions, and Claude's own conversation history, survive the
restart.

To uninstall, stop the daemon first (same reason as above — it runs detached
from the CLI, so removing the package while it's alive just leaves an
orphaned background process still running):

```bash
driveclaude stop
npm uninstall -g driveclaude
```

`~/.driveclaude` and the trust entries in `~/.claude.json` aren't removed
automatically — see "Storage, logs & cleanup" and "Security & permissions"
above.

## Development

```bash
git clone https://github.com/sandeep231004/driveclaude.git
cd driveclaude
npm install
npm link           # run your local checkout as the `driveclaude` command
npm test           # runs against a fake `claude` binary — no network, no real Claude process
npm pack --dry-run # preview exactly what a release would ship, without publishing
```

`npm test` covers three things end to end against a real daemon and a
scripted stand-in for `claude`: the `~/.claude.json` trust mutation, `fresh`
correctly replacing a live session, and the full persistent-session
lifecycle (mid-task queueing, daemon restart, crash recovery, all resuming
the same conversation id).

`npm pack --dry-run` lists every file that would be included in the
published tarball (per the `files` field in `package.json`) — run it before
a release to catch anything missing or unintentionally included.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `DRIVECLAUDE_MODEL` | `sonnet` | Model for new sessions. |
| `DRIVECLAUDE_CLAUDE_BIN` | `claude` | Path to the Claude Code binary. |
| `DRIVECLAUDE_HOME` | `~/.driveclaude` | Sessions, event logs, daemon socket. |

## Known limits

- **The mid-task queue isn't durable.** See "What's actually persisted"
  above — messages go straight to the live process's stdin, with nothing
  held back to recover if it dies first.
- **No mid-turn interrupt.** `send` never cuts Claude off (deliberate). To
  stop something badly wrong, `end` the session — the conversation resumes
  on the next `send`.
- **One session per directory.** Two sessions in one working copy would
  fight over the same files.

## Unofficial

Not affiliated with or endorsed by Anthropic or OpenAI. "Claude" and "Codex"
are trademarks of their respective owners.

## License

MIT
