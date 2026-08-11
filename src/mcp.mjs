import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  DEFAULT_MODEL,
  cancelTask,
  diff,
  inspectTask,
  listTaskRecords,
  resetSession,
  sessionInfo,
  startTask,
} from './runner.mjs'
import { formatDiff, formatSession, formatStatus, formatTasks } from './format.mjs'

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (e) => ({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true })

export function createServer() {
  const server = new McpServer({ name: 'claude-bridge', version: '0.1.0' })

  server.registerTool(
    'implement',
    {
      title: 'Delegate a task to Claude Code',
      description:
        'Send an instruction to the persistent Claude Code session for a directory, exactly as a user would type it into Claude Code. ' +
        'Claude keeps full context across calls, so follow-ups can be short ("now handle the empty-input case"). ' +
        'Returns immediately with a task_id — poll status() to watch progress and collect the result. ' +
        'One turn at a time per directory: wait for the current task to finish before sending the next.',
      inputSchema: {
        cwd: z.string().describe('Absolute path to the repository or directory to work in.'),
        task: z
          .string()
          .describe(
            'The instruction for Claude. Be specific about intent and acceptance criteria; ' +
              'Claude already remembers earlier turns in this session.',
          ),
        model: z
          .string()
          .optional()
          .describe(`Model alias for the implementer. Default: ${DEFAULT_MODEL}.`),
        new_session: z
          .boolean()
          .optional()
          .describe('Start a fresh session, discarding prior context for this directory.'),
      },
    },
    async ({ cwd, task, model, new_session }) => {
      try {
        const t = startTask({ cwd, prompt: task, model, newSession: new_session })
        return text(
          [
            `started task ${t.id}`,
            `session ${t.sessionId}${t.resumed ? ' (resumed)' : ' (new)'} · model ${t.model}`,
            `cwd ${t.cwd}`,
            '',
            `Poll with status({ task_id: "${t.id}" }) — a real task takes minutes, so check in ~30s.`,
          ].join('\n'),
        )
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'status',
    {
      title: 'Check a delegated task',
      description:
        'Progress or final result for a task: what Claude is doing right now, which files it has written, ' +
        'and its closing message once finished. Call repeatedly while status is "running".',
      inputSchema: {
        task_id: z.string().describe('The id returned by implement().'),
        full: z
          .boolean()
          .optional()
          .describe("Include Claude's final message even while the task is still running."),
      },
    },
    async ({ task_id, full }) => {
      const snap = inspectTask(task_id)
      if (!snap) return fail(new Error(`unknown task_id: ${task_id}`))
      return text(formatStatus(snap, { full }))
    },
  )

  server.registerTool(
    'diff',
    {
      title: 'Review the working-tree diff',
      description:
        'Git diff of the working tree against HEAD, plus untracked files. Use this to review what the ' +
        'implementer actually changed before accepting it or sending corrections.',
      inputSchema: {
        cwd: z.string().describe('Absolute path to the repository.'),
        stat: z.boolean().optional().describe('Summary only (--stat) instead of the full patch.'),
        path: z.string().optional().describe('Limit the diff to a pathspec.'),
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

  server.registerTool(
    'cancel',
    {
      title: 'Stop a running task',
      description:
        'Terminate a running delegated task. The session survives — edits already written stay on disk.',
      inputSchema: { task_id: z.string() },
    },
    async ({ task_id }) => {
      try {
        const t = cancelTask(task_id)
        return text(t.cancelled ? `cancelled ${t.id}` : `task ${t.id} was already ${t.status}`)
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'session',
    {
      title: 'Inspect or reset the implementer session',
      description:
        'Show the Claude session bound to a directory (its id, turn count, recent tasks), or reset it ' +
        'so the next implement() starts from a clean slate.',
      inputSchema: {
        cwd: z.string(),
        reset: z.boolean().optional().describe('Forget the session for this directory.'),
      },
    },
    async ({ cwd, reset }) => {
      try {
        if (reset) {
          const r = resetSession(cwd)
          return text(`session cleared for ${r.cwd} — next implement() starts fresh.`)
        }
        return text(formatSession(sessionInfo(cwd)))
      } catch (e) {
        return fail(e)
      }
    },
  )

  server.registerTool(
    'tasks',
    {
      title: 'List recent tasks',
      description: 'Recent delegated tasks with their status, newest first.',
      inputSchema: {
        cwd: z.string().optional().describe('Filter to one directory.'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ cwd, limit }) => text(formatTasks(listTaskRecords({ cwd, limit: limit || 20 }))),
  )

  return server
}

export async function runStdioServer() {
  const server = createServer()
  await server.connect(new StdioServerTransport())
}
