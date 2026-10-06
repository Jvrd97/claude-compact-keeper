import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  archiveMarkdown,
  archiveRoot,
  buildCard,
  CARD_MARKER,
  cardText,
  filesOf,
  fileStamp,
  goalOf,
  notesIn,
  parseCard,
  projectSlug,
  promptsOf,
  readableText,
  summarizerInstructions,
  todosOf,
  toastText,
  withCard,
  withNotes,
} from '../hooks/logic'

const NOW = Date.parse('2026-10-06T12:00:00Z')

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const toolResult = (): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: 't', text: 'ok', isError: false }],
})

const use = (tool: string, input: Record<string, unknown>, isError = false): ToolUseSummary =>
  isError ? { tool_use_id: tool, tool, input, isError: true } : { tool_use_id: tool, tool, input }

const assistant = (text: string, ...toolUses: ToolUseSummary[]): SessionMessage => ({ role: 'assistant', text, toolUses })

const SESSION: SessionMessage[] = [
  user('<command-name>/model</command-name>\n<command-message>model</command-message>'),
  user('/init'),
  user('ok'),
  user('Migrate the billing service to the new Stripe API, keep the v1 webhooks working'),
  assistant('Reading the service.', use('Read', { file_path: '/repo/billing/api.py' })),
  toolResult(),
  assistant('', use('Edit', { file_path: '/repo/billing/api.py', old_string: 'a', new_string: 'b' })),
  toolResult(),
  user('<system-reminder>The date changed.</system-reminder>'),
  user('Do not touch   the\n tests folder'),
  assistant(
    '',
    use('Write', { file_path: '/repo/billing/stripe_v2.py', content: 'x' }),
    use('Edit', { file_path: '/repo/billing/api.py', old_string: 'b', new_string: 'c' }),
    use('Edit', { file_path: '/repo/missing.py', old_string: 'b', new_string: 'c' }, true),
    use('NotebookEdit', { notebook_path: '/repo/notes.ipynb', new_source: 'x' }),
  ),
  user('[Request interrupted by user]'),
  assistant(
    '',
    use('TodoWrite', {
      todos: [
        { content: 'Port charge flow', status: 'completed' },
        { content: 'Port refunds', status: 'in_progress' },
        { content: 'Update docs', status: 'pending' },
      ],
    }),
  ),
]

describe('reading the transcript', () => {
  test('the goal skips slash commands, engine rows and very short prompts', () => {
    expect(goalOf(SESSION)).toBe('Migrate the billing service to the new Stripe API, keep the v1 webhooks working')
  })

  test('no substantive prompt means no goal', () => {
    expect(goalOf([user('/compact'), user('yes'), user('go on')])).toBeNull()
  })

  test('prompts are the typed ones, whitespace folded, long ones cut', () => {
    const long = 'word '.repeat(200)

    expect(promptsOf(SESSION)).toEqual([
      'ok',
      'Migrate the billing service to the new Stripe API, keep the v1 webhooks working',
      'Do not touch the tests folder',
    ])
    expect(promptsOf([user(long)])[0]?.length).toBe(300)
    expect(promptsOf([user(long)])[0]?.endsWith('…')).toBe(true)
  })

  test('edited files are deduplicated, in first-touch order, failed edits and reads left out', () => {
    expect(filesOf(SESSION)).toEqual(['/repo/billing/api.py', '/repo/billing/stripe_v2.py', '/repo/notes.ipynb'])
  })

  test('the last todo list gives its open items; no list gives null', () => {
    expect(todosOf(SESSION)).toEqual(['[in_progress] Port refunds', '[pending] Update docs'])
    expect(todosOf([user('hello there friend')])).toBeNull()
  })
})

describe('the card', () => {
  test('it holds the goal, notes, prompts, files and todos, and reads back', () => {
    const card = buildCard(SESSION, ['Never push to main'], 20)
    const text = cardText(card, '/home/u/.claude/compact-keeper/x/s/t.md')

    expect(text.startsWith(CARD_MARKER)).toBe(true)
    expect(text).toContain('## Goal\nMigrate the billing service')
    expect(text).toContain('- Never push to main')
    expect(text).toContain('## User prompts, oldest first (last 3)')
    expect(text).toContain('- /repo/billing/stripe_v2.py')
    expect(text).toContain('- [pending] Update docs')
    expect(text).toContain('/home/u/.claude/compact-keeper/x/s/t.md')

    expect(parseCard(text)).toEqual({
      goal: card.goal,
      prompts: [...card.prompts],
      files: [...card.files],
      todos: [...card.todos],
    })
  })

  test('a second compaction keeps the first card and adds what came after', () => {
    const first = cardText(buildCard(SESSION, [], 20), null)
    const later: SessionMessage[] = [
      user(`${'This session is being continued from a previous conversation'} that ran out of context.`),
      user(first),
      user('Now add retries to the webhook handler'),
      assistant('', use('Edit', { file_path: '/repo/billing/webhooks.py', old_string: 'a', new_string: 'b' })),
    ]
    const card = buildCard(later, [], 20)

    expect(card.goal).toBe('Migrate the billing service to the new Stripe API, keep the v1 webhooks working')
    expect(card.prompts.at(-1)).toBe('Now add retries to the webhook handler')
    expect(card.prompts).toHaveLength(4)
    expect(card.files).toEqual(['/repo/billing/api.py', '/repo/billing/stripe_v2.py', '/repo/notes.ipynb', '/repo/billing/webhooks.py'])
    expect(card.todos).toEqual(['[in_progress] Port refunds', '[pending] Update docs'])
  })

  test('maxPrompts keeps the latest ones, and 0 keeps none', () => {
    expect(buildCard(SESSION, [], 2).prompts).toEqual([
      'Migrate the billing service to the new Stripe API, keep the v1 webhooks working',
      'Do not touch the tests folder',
    ])
    expect(buildCard(SESSION, [], 0).prompts).toEqual([])
  })

  test('text that is not a card does not parse as one', () => {
    expect(parseCard('## Goal\nsomething')).toBeNull()
  })

  test('the card goes right after the summary, or first without one', () => {
    const card = user('CARD')
    const summary = user('This session is being continued from a previous conversation that ran out of context.')

    expect(withCard([summary, assistant('kept')], card).map(message => message.text)).toEqual([summary.text, 'CARD', 'kept'])
    expect(withCard([assistant('kept')], card).map(message => message.text)).toEqual(['CARD', 'kept'])
  })

  test('the toast names what was kept and the archive', () => {
    const card = buildCard(SESSION, [], 20)

    expect(toastText(card, 'saved')).toBe('compacted — kept goal, 3 prompts, 3 files · archive saved')
    expect(toastText({ ...card, goal: null, notes: ['x'], files: ['a'] }, 'off')).toBe('compacted — kept 1 note, 3 prompts, 1 file')
  })
})

describe('summarizer instructions', () => {
  test('ours follow the ones already given, then the notes, then the user extra', () => {
    const text = summarizerInstructions('focus on the auth bug', 'Answer in English.', ['Never push to main'])

    expect(text.startsWith('focus on the auth bug\n\nKeep these verbatim')).toBe(true)
    expect(text).toContain('- Never push to main')
    expect(text.endsWith('Answer in English.')).toBe(true)
  })

  test('with nothing given there is only the mod\'s own paragraph', () => {
    expect(summarizerInstructions(undefined, '  ', []).startsWith('Keep these verbatim')).toBe(true)
    expect(summarizerInstructions(undefined, '', [])).not.toContain('\n\n')
  })
})

describe('the archive', () => {
  test('paths: default under HOME, ~ expanded, absolute kept, none without HOME', () => {
    expect(archiveRoot('', '/home/u')).toBe('/home/u/.claude/compact-keeper')
    expect(archiveRoot('~/notes/compactions/', '/home/u')).toBe('/home/u/notes/compactions')
    expect(archiveRoot('/data/keep', undefined)).toBe('/data/keep')
    expect(archiveRoot('', undefined)).toBeNull()
    expect(projectSlug('/Users/me/my app')).toBe('-Users-me-my-app')
    expect(fileStamp(NOW)).toBe('2026-10-06T12-00-00Z')
  })

  test('markdown has a header, one section per message, text and tool names, no empty rows', () => {
    const text = archiveMarkdown(SESSION, { sessionId: 's1', cwd: '/repo', at: NOW, trigger: 'auto' })

    expect(text.startsWith('# Transcript before compaction\n\n- Session: s1\n- Project: /repo\n- Compacted: 2026-10-06T12:00:00.000Z (auto)')).toBe(true)
    expect(text).toContain('## User\n\nMigrate the billing service')
    expect(text).toContain('## Assistant\n\nReading the service.\n\nTools:\n- Read `/repo/billing/api.py`')
    expect(text).toContain('- Edit `/repo/missing.py` (error)')
    expect(text).toContain('- TodoWrite')
    expect(text).toContain('## User\n\n`/model`')
    expect(text.match(/^## /gm)?.length).toBe(11)
  })

  test('engine rows read as the command typed and its output; the caveat is dropped', () => {
    const command = '<command-name>/keep</command-name>\n  <command-message>keep</command-message>\n  <command-args>smoke note</command-args>'

    expect(readableText(command)).toBe('`/keep smoke note`')
    expect(readableText('<local-command-stdout>Compacted</local-command-stdout>')).toBe('Command output:\n\nCompacted')
    expect(readableText('<local-command-caveat>The command below was run directly</local-command-caveat>')).toBe('')
    expect(readableText('plain <b>html</b> prompt')).toBe('plain <b>html</b> prompt')
  })
})

describe('the note book', () => {
  test('notes are kept per session, an empty list drops the session, old sessions are pruned', () => {
    let book = withNotes(undefined, 'a', ['one'], 1)
    book = withNotes(book, 'b', ['two'], 2)

    expect(notesIn(book, 'a')).toEqual(['one'])
    expect(notesIn(withNotes(book, 'a', [], 3), 'a')).toEqual([])
    expect(notesIn('junk', 'a')).toEqual([])

    for (let index = 0; index < 120; index += 1) {
      book = withNotes(book, `s${index}`, ['n'], 10 + index)
    }

    expect(Object.keys(book)).toHaveLength(100)
    expect(notesIn(book, 'a')).toEqual([])
    expect(notesIn(book, 's119')).toEqual(['n'])
  })
})
