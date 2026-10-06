import type { SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work/app' }
const NOW = Date.parse('2026-10-06T12:00:00Z')
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. Summary: billing work.'
const ARCHIVE = '/home/u/.claude/compact-keeper/-work-app/sess-1/2026-10-06T12-00-00Z.md'
const PRESENTATION = { isFullscreen: true, columns: 120 }

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const TRANSCRIPT: SessionMessage[] = [
  user('/init'),
  user('Migrate the billing service to the new Stripe API'),
  {
    role: 'assistant',
    text: 'Done with the first file.',
    toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: '/work/app/billing.py', old_string: 'a', new_string: 'b' } }],
  },
  user('Keep the v1 webhooks working'),
]

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

type Answer = (e: SessionCompactInput) => SessionCompactResult

const compacted: Answer = () => ({ messages: [user(SUMMARY), { role: 'assistant', text: 'kept tail', toolUses: [] }] })

const world = (on: TestOn, answer: Answer = compacted, canWrite = true) => {
  const state = {
    compactions: [] as SessionCompactInput[],
    writes: [] as { path: string; text: string }[],
    toasts: [] as string[],
    commands: [] as string[],
  }

  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.messages', () => ({ value: TRANSCRIPT }))
  on('command.register', ($, e) => {
    state.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', ($, e) => {
    if (!canWrite) {
      return { deny: `EACCES: ${e.path}` }
    }

    state.writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('session.compact', ($, e) => {
    state.compactions.push(e)

    return answer(e)
  })

  return state
}

const textsOf = (result: SessionCompactResult): string[] => (result.messages ?? []).map(message => message.text)

describe('compact-keeper in a session', () => {
  test('the session start registers /keep and /kept', async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)

    expect(state.commands).toEqual(['keep', 'kept'])
  })

  test('a compaction passes our instructions after the user\'s and puts the card after the summary', async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)

    const result = await $.session.compact({ trigger: 'manual', instructions: 'focus on refunds', messages: TRANSCRIPT })
    const instructions = state.compactions[0]?.instructions ?? ''

    expect(instructions.startsWith('focus on refunds\n\nKeep these verbatim')).toBe(true)

    const texts = textsOf(result)

    expect(texts).toHaveLength(3)
    expect(texts[0]).toBe(SUMMARY)
    expect(texts[1]).toContain('[compact-keeper]')
    expect(texts[1]).toContain('## Goal\nMigrate the billing service to the new Stripe API')
    expect(texts[1]).toContain('- Keep the v1 webhooks working')
    expect(texts[1]).toContain('- /work/app/billing.py')
    expect(texts[1]).toContain(ARCHIVE)
    expect(texts[2]).toBe('kept tail')
    expect(result.messages?.[1]?.role).toBe('user')
    expect(state.toasts).toEqual(['compacted — kept goal, 2 prompts, 1 file · archive saved'])
  })

  test('the archive is the transcript before compaction, as markdown', async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)
    await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })

    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]?.path).toBe(ARCHIVE)
    expect(state.writes[0]?.text).toContain('- Compacted: 2026-10-06T12:00:00.000Z (auto)')
    expect(state.writes[0]?.text).toContain('## Assistant\n\nDone with the first file.\n\nTools:\n- Edit `/work/app/billing.py`')
  })

  test('a skipped compaction writes and adds nothing', async ($, on) => {
    const state = world(on, () => ({ skip: 'blocked by a PreCompact hook' }))
    await $.session.start(SESSION)

    const result = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })

    expect(result.skip).toBe('blocked by a PreCompact hook')
    expect(state.writes).toHaveLength(0)
    expect(state.toasts).toHaveLength(0)
  })

  test('a subagent\'s compaction is left alone', async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)

    const result = await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: TRANSCRIPT })

    expect(state.compactions[0]?.instructions).toBeUndefined()
    expect(textsOf(result)).toEqual([SUMMARY, 'kept tail'])
    expect(state.writes).toHaveLength(0)
  })

  test('a precompute gets the instructions but no card and no archive', async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)

    const result = await $.session.compact({ trigger: 'precompute', messages: TRANSCRIPT })

    expect(state.compactions[0]?.instructions).toContain('Keep these verbatim')
    expect(textsOf(result)).toEqual([SUMMARY, 'kept tail'])
    expect(state.writes).toHaveLength(0)
  })

  test('/keep pins a note that reaches the summarizer and the card; /keep clear removes it', async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)

    const pinned = await $.command.run({ command: 'keep', args: 'Never push to main', origin: { kind: 'composer' }, presentation: PRESENTATION })

    expect(pinned.text).toContain('Pinned (1 in this session): Never push to main')

    const result = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })

    expect(state.compactions[0]?.instructions).toContain('- Never push to main')
    expect(textsOf(result)[1]).toContain('## Notes the user pinned with /keep\n- Never push to main')
    expect(state.toasts[0]).toContain('1 note')

    const cleared = await $.command.run({ command: 'keep', args: 'clear', origin: { kind: 'composer' }, presentation: PRESENTATION })
    const listed = await $.command.run({ command: 'keep', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })

    expect(cleared.text).toBe('Cleared 1 pinned note.')
    expect(listed.text).toContain('No notes pinned yet.')
  })

  test('/kept shows the card it would keep and the archive folder', async ($, on) => {
    world(on)
    await $.session.start(SESSION)
    await $.command.run({ command: 'keep', args: 'Use uv, not pip', origin: { kind: 'composer' }, presentation: PRESENTATION })

    const shown = await $.command.run({ command: 'kept', args: '', origin: { kind: 'composer' }, presentation: PRESENTATION })

    expect(shown.text).toContain('## Goal\nMigrate the billing service')
    expect(shown.text).toContain('- Use uv, not pip')
    expect(shown.text).toContain('Archive folder: /home/u/.claude/compact-keeper/-work-app/sess-1/')
    expect(shown.text).not.toContain('[compact-keeper]')
  })

  test('with archive off nothing is written and the card names no file', { options: { archive: false, maxPrompts: 1 } }, async ($, on) => {
    const state = world(on)
    await $.session.start(SESSION)

    const result = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })

    expect(state.writes).toHaveLength(0)
    expect(textsOf(result)[1]).not.toContain('Full transcript before compaction')
    expect(textsOf(result)[1]).toContain('(last 1)')
    expect(state.toasts).toEqual(['compacted — kept goal, 1 prompt, 1 file'])
  })

  test('a failed write still compacts and says so', async ($, on) => {
    const state = world(on, compacted, false)
    await $.session.start(SESSION)

    const result = await $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })

    expect(textsOf(result)).toHaveLength(3)
    expect(state.toasts[0]).toContain('archive failed')
  })
})
