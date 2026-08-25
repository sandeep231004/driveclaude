import { spawnSync } from 'node:child_process'
import { resolveCwd } from './state.mjs'

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return r.error || r.status !== 0 ? null : r.stdout
}

export function diff(cwd, { stat = false, pathspec } = {}) {
  const dir = resolveCwd(cwd)
  if (git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') {
    return { cwd: dir, gitRepo: false, text: '' }
  }
  const args = ['--no-pager', 'diff', 'HEAD']
  if (stat) args.push('--stat')
  if (pathspec) args.push('--', pathspec)
  const untrackedArgs = ['ls-files', '--others', '--exclude-standard']
  if (pathspec) untrackedArgs.push('--', pathspec)
  return {
    cwd: dir,
    gitRepo: true,
    text: git(dir, args) ?? '',
    untracked: (git(dir, untrackedArgs) ?? '')
      .split('\n')
      .filter(Boolean),
  }
}
