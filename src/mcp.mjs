import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { request } from './client.mjs'
import { DEFAULT_MODEL } from './state.mjs'
import { formatDiff, formatEvents, formatInfo, formatList } from './format.mjs'
import { diff } from './git.mjs'

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (e) => ({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true })

// Read from the package rather than repeating it here: this is the version MCP
// clients display, and a hand-maintained copy silently went stale at 0.1.0.
const { version } = createRequire(import.meta.url)('../package.json')

export function createServer() {
  const server = new McpServer({ name: 'driveclaude', version })

  server.registerTool(
    'send',
    {
      title: 'Type a message into the live Claude Code session',
      description:
        'You are the user of a live Claude Code session. This types a message into it, exactly as a person would. ' +
        'Returns immediately — it never waits for Claude to finish.\n\n' +
        'You can send at ANY time, including while Claude is mid-task: the message is queued, and Claude picks it ' +
        'up between steps without stopping or losing context. That is how you steer work in flight ' +
        '("actually, use the existing retry helper instead").\n\n' +
        'The session is persistent, so keep messages short and conversational — Claude remembers everything ' +
        'said before. Keep the returned session ID and pass it to later send/read calls; cwd alone is ambiguous ' +
        'when multiple sessions share a project. After sending, use read() to watch what happens.\n\n' +
        'Keep only one unanswered message in flight at a time; queue depth is best-effort and not durable.',
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe('Directory for a new session. Optional when sessionId selects an existing session.'),
        sessionId: z
          .string()
          .optional()
          .describe('Existing session to continue. Required when multiple live sessions share the cwd.'),
        message: z.string().describe('What to say to Claude.'),
        model: z
          .string()
          .optional()
          .describe(`Model, only used when starting a new session. Default: ${DEFAULT_MODEL}.`),
        fresh: z
          .boolean()
          .optional()
          .describe('Start a brand-new session alongside any existing sessions in this directory.'),
      },
    },
    async ({ cwd, sessionId, message, model, fresh }) => {
      try {
        const snap = await request('send', { cwd, sessionId, message, model, fresh })
        const note = snap.queued
          ? 'Queued while Claude was mid-task — it will pick this up between steps.'
          : 'Delivered; Claude is starting on it.'
        return text(
          `${note}\nsession ${snap.sessionId} · ${snap.status}\nRead with sessionId=${snap.sessionId} and since=${snap.cursorBefore} to watch.`,
        )
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'adopt',
    {
      title: 'Adopt an existing Claude conversation',
      description:
        'Resumes a Claude conversation that was started outside driveclaude — for example an interactive ' +
        '`claude` session someone was running by hand, already partway through work. The original process must ' +
        'be exited first. Adoption preserves the session ID and history but starts a new `claude -p` process; ' +
        'it does not attach to the original terminal. After adopting, send/read/' +
        'session/diff control it exactly like any driveclaude-created session, and the conversation history is ' +
        'preserved.\n\n' +
        'Requires the session ID of that conversation (from `/status` inside it, or the terminal) and the exact ' +
        'directory it was running in. Fails immediately, without side effects, if no matching Claude transcript ' +
        'exists for that ID and directory.\n\n' +
        'Do not run `claude --resume` on the same ID while driveclaude controls it: resume starts a second process, ' +
        'not a live viewer. Multiple driveclaude sessions may work in the same directory; use the returned ' +
        'session ID for later calls.',
      inputSchema: {
        cwd: z.string().describe('Absolute path to the directory the existing session was running in.'),
        sessionId: z.string().describe('The session ID of the existing Claude conversation to adopt.'),
        model: z.string().optional().describe(`Model to resume it with. Default: ${DEFAULT_MODEL}.`),
      },
    },
    async ({ cwd, sessionId, model }) => {
      try {
        const snap = await request('adopt', { cwd, sessionId, model })
        return text(`Adopted; Claude is running.\nsession ${snap.sessionId} · ${snap.status}\nRead with sessionId=${snap.sessionId} and since=0 to watch.`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'read',
    {
      title: 'Watch the session',
      description:
        'Everything that happened in the session since a cursor: what Claude said, each tool it ran, files it ' +
        'wrote, failures, and turn completions. Returns a new cursor — pass it next time to get only what is new.\n\n' +
        'Start with since=0 to see the whole session. Poll this while Claude is working, and tell the user what ' +
        'you see. If Claude is heading the wrong way, send() a correction immediately rather than waiting.',
      inputSchema: {
        cwd: z.string().optional().describe('Directory selector; only unambiguous with one live session.'),
        sessionId: z.string().optional().describe('Preferred selector for the exact session to read.'),
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Cursor from the previous read. Omit or 0 for the full session.'),
      },
    },
    async ({ cwd, sessionId, since }) => {
      try {
        return text(formatEvents(await request('read', { cwd, sessionId, since: since || 0 })))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'session',
    {
      title: 'Session status',
      description:
        'Whether a live session exists for a directory, its id, how long it has been alive, and what it has ' +
        'written. Sessions survive you restarting — a remembered session resumes on the next send().',
      inputSchema: {
        cwd: z.string().optional(),
        sessionId: z.string().optional().describe('Preferred selector for the exact session.'),
      },
    },
    async ({ cwd, sessionId }) => {
      try {
        return text(formatInfo(await request('info', { cwd, sessionId })))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'sessions',
    {
      title: 'List all sessions',
      description: 'Every live session across directories, plus remembered ones that will resume on next use.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(formatList(await request('list', {})))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'end',
    {
      title: 'Close the session',
      description:
        'Shut the live Claude process down cleanly. Files it wrote stay on disk, and the conversation is ' +
        'remembered — the next send() resumes it. Use this to stop a session that has gone badly wrong.',
      inputSchema: {
        cwd: z.string().optional(),
        sessionId: z.string().optional().describe('Preferred selector for the exact session to close.'),
      },
    },
    async ({ cwd, sessionId }) => {
      try {
        const r = await request('end', { cwd, sessionId })
        return text(r.ended ? `session ended for ${r.cwd}` : `no live session for ${r.cwd}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'diff',
    {
      title: 'Review the working tree',
      description:
        'Git diff vs HEAD plus untracked files. Use this to review what actually landed on disk before ' +
        'accepting the work or sending a correction.',
      inputSchema: {
        cwd: z.string(),
        stat: z.boolean().optional().describe('Summary only instead of the full patch.'),
        path: z.string().optional().describe('Limit to a pathspec.'),
      },
    },
    async ({ cwd, stat, path }) => {
      try {
        return text(formatDiff(diff(cwd, { stat, pathspec: path })))
      } catch (e) {
        return fail(e)
      }
    },
  )

  return server
}

export async function runStdioServer() {
  await createServer().connect(new StdioServerTransport())
}
