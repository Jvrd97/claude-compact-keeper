import type { SessionMessage } from 'claude-code'

export const CARD_MARKER = '[compact-keeper]'
export const SUMMARY_PREFIX = 'This session is being continued from a previous conversation'

const MAX_PROMPT_CHARS = 300
const MAX_GOAL_CHARS = 600
const MAX_NOTE_CHARS = 500
const MIN_GOAL_WORDS = 3
const MIN_GOAL_CHARS = 12
const MAX_TOOL_HINT_CHARS = 120
const MAX_SESSIONS_KEPT = 100

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TODO_TOOL = 'TodoWrite'

// Rows the engine writes on the user's side that the person never typed.
const ENGINE_ROW = /^<(command-[a-z]+|local-command-[a-z]+|system-reminder|task-notification|bash-[a-z]+|user-memory-input)>/
const INTERRUPTED = /^\[Request interrupted/

const SECTION = {
  goal: 'Goal',
  notes: 'Notes the user pinned with /keep',
  prompts: 'User prompts, oldest first',
  files: 'Files edited or created',
  todos: 'Open todos',
  archive: 'Full transcript before compaction',
} as const

export type Card = {
  goal: string | null
  notes: readonly string[]
  prompts: readonly string[]
  files: readonly string[]
  todos: readonly string[]
}

export type Carried = Omit<Card, 'notes'>

export type NoteBook = Record<string, { notes: string[]; at: number }>

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const isCard = (text: string): boolean => text.startsWith(CARD_MARKER)

/** A user row the person typed: not a tool result, an engine row, a summary or a card. */
export const isTypedPrompt = (message: SessionMessage): boolean => {
  if (message.role !== 'user' || (message.toolResults?.length ?? 0) > 0) {
    return false
  }

  const text = message.text.trim()

  return (
    text !== '' &&
    !ENGINE_ROW.test(text) &&
    !INTERRUPTED.test(text) &&
    !text.startsWith(SUMMARY_PREFIX) &&
    !isCard(text)
  )
}

const isSlashCommand = (text: string): boolean => /^\/[A-Za-z]/.test(text)

export const promptsOf = (messages: readonly SessionMessage[]): string[] =>
  messages
    .filter(isTypedPrompt)
    .map(message => message.text.trim())
    .filter(text => !isSlashCommand(text))
    .map(text => oneLine(text, MAX_PROMPT_CHARS))

/** The first prompt that states a task: no slash command, no "ok" or "go on". */
export const goalOf = (messages: readonly SessionMessage[]): string | null => {
  for (const message of messages) {
    if (!isTypedPrompt(message)) {
      continue
    }

    const text = message.text.trim()
    const words = text.split(/\s+/).length

    if (!isSlashCommand(text) && words >= MIN_GOAL_WORDS && text.length >= MIN_GOAL_CHARS) {
      return oneLine(text, MAX_GOAL_CHARS)
    }
  }

  return null
}

const pathOf = (input: Record<string, unknown>): string | null => {
  const path = input.file_path ?? input.notebook_path

  return typeof path === 'string' && path !== '' ? path : null
}

export const filesOf = (messages: readonly SessionMessage[]): string[] => {
  const files: string[] = []

  for (const message of messages) {
    for (const use of message.toolUses) {
      const path = FILE_TOOLS.has(use.tool) && use.isError !== true ? pathOf(use.input) : null

      if (path !== null && !files.includes(path)) {
        files.push(path)
      }
    }
  }

  return files
}

type Todo = { content: string; status: string }

const isTodo = (value: unknown): value is Todo =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { content?: unknown }).content === 'string' &&
  typeof (value as { status?: unknown }).status === 'string'

/** The open items of the last TodoWrite; null when the transcript has none. */
export const todosOf = (messages: readonly SessionMessage[]): string[] | null => {
  let last: unknown[] | null = null

  for (const message of messages) {
    for (const use of message.toolUses) {
      if (use.tool === TODO_TOOL && Array.isArray(use.input.todos)) {
        last = use.input.todos
      }
    }
  }

  if (last === null) {
    return null
  }

  return last
    .filter(isTodo)
    .filter(todo => todo.status !== 'completed')
    .map(todo => `[${todo.status}] ${oneLine(todo.content, MAX_PROMPT_CHARS)}`)
}

const sectionsOf = (text: string): Map<string, string[]> => {
  const sections = new Map<string, string[]>()
  let current: string[] | null = null

  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = []
      sections.set(line.slice(3).replace(/\s*\(.*\)$/, '').trim(), current)
    } else if (current !== null && line.trim() !== '') {
      current.push(line)
    }
  }

  return sections
}

const itemsOf = (lines: readonly string[] | undefined): string[] =>
  (lines ?? []).filter(line => line.startsWith('- ')).map(line => line.slice(2))

/** Reads back a card this mod wrote, so a second compaction keeps what the first one kept. */
export const parseCard = (text: string): Carried | null => {
  if (!isCard(text)) {
    return null
  }

  const sections = sectionsOf(text)
  const goal = (sections.get(SECTION.goal) ?? []).join(' ').trim()

  return {
    goal: goal === '' ? null : goal,
    prompts: itemsOf(sections.get(SECTION.prompts)),
    files: itemsOf(sections.get(SECTION.files)),
    todos: itemsOf(sections.get(SECTION.todos)),
  }
}

export const lastCarried = (messages: readonly SessionMessage[]): Carried | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const carried = message?.role === 'user' ? parseCard(message.text.trim()) : null

    if (carried !== null) {
      return carried
    }
  }

  return null
}

const unique = (items: readonly string[]): string[] => [...new Set(items)]

/** What survives this compaction: the last card's contents plus what happened since. */
export const buildCard = (messages: readonly SessionMessage[], notes: readonly string[], maxPrompts: number): Card => {
  const carried = lastCarried(messages)
  const prompts = [...(carried?.prompts ?? []), ...promptsOf(messages)]

  return {
    goal: carried?.goal ?? goalOf(messages),
    notes,
    prompts: maxPrompts > 0 ? prompts.slice(-maxPrompts) : [],
    files: unique([...(carried?.files ?? []), ...filesOf(messages)]),
    todos: todosOf(messages) ?? [...(carried?.todos ?? [])],
  }
}

const listOf = (items: readonly string[]): string => items.map(item => `- ${item}`).join('\n')

export const cardText = (card: Card, archivePath: string | null): string => {
  const parts = [
    `${CARD_MARKER} What the user asked for before this compaction, kept word for word by the compact-keeper mod. Where it disagrees with the summary above, this card is right.`,
  ]

  if (card.goal !== null) {
    parts.push(`## ${SECTION.goal}\n${card.goal}`)
  }

  if (card.notes.length > 0) {
    parts.push(`## ${SECTION.notes}\n${listOf(card.notes)}`)
  }

  if (card.prompts.length > 0) {
    parts.push(`## ${SECTION.prompts} (last ${card.prompts.length})\n${listOf(card.prompts)}`)
  }

  if (card.files.length > 0) {
    parts.push(`## ${SECTION.files}\n${listOf(card.files)}`)
  }

  if (card.todos.length > 0) {
    parts.push(`## ${SECTION.todos}\n${listOf(card.todos)}`)
  }

  if (archivePath !== null) {
    parts.push(`## ${SECTION.archive}\n${archivePath}\nRead it when a detail is missing from the summary.`)
  }

  return parts.join('\n\n')
}

/** What /kept prints: the card as it stands now, without the marker that would make it read as a real card. */
export const previewText = (card: Card, folder: string | null, isArchiving: boolean): string => {
  const body = isEmptyCard(card) ? 'Nothing to keep yet: no goal, prompts, notes, files or todos.' : cardText(card, null).split('\n\n').slice(1).join('\n\n')
  const where = !isArchiving ? 'Archive: off' : folder === null ? 'Archive: no folder (HOME is not set)' : `Archive folder: ${folder}/`

  return `At the next compaction compact-keeper keeps:\n\n${body}\n\n${where}`
}

export const isEmptyCard = (card: Card): boolean =>
  card.goal === null && card.notes.length === 0 && card.prompts.length === 0 && card.files.length === 0 && card.todos.length === 0

const KEEP_INSTRUCTIONS =
  'Keep these verbatim, quoted rather than paraphrased: the user\'s goal; every constraint, preference and rule the user stated; decisions made and the reason for each; exact file paths, commands, identifiers and error messages; and the open work (unfinished tasks and the next step).'

export const summarizerInstructions = (existing: string | undefined, extra: string, notes: readonly string[]): string => {
  const pinned = notes.length > 0 ? `The user pinned these notes; keep each one word for word:\n${listOf(notes)}` : ''

  return [existing?.trim() ?? '', KEEP_INSTRUCTIONS, pinned, extra.trim()].filter(part => part !== '').join('\n\n')
}

/** Puts the card right after the compaction's summary, or first when there is none. */
export const withCard = (messages: readonly SessionMessage[], card: SessionMessage): SessionMessage[] => {
  const summary = messages.findIndex(message => message.role === 'user' && message.text.trimStart().startsWith(SUMMARY_PREFIX))
  const at = summary === -1 ? 0 : summary + 1

  return [...messages.slice(0, at), card, ...messages.slice(at)]
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

export const toastText = (card: Card, archive: 'saved' | 'failed' | 'off'): string => {
  const kept = [
    card.goal === null ? null : 'goal',
    card.notes.length > 0 ? plural(card.notes.length, 'note') : null,
    plural(card.prompts.length, 'prompt'),
    plural(card.files.length, 'file'),
  ].filter((part): part is string => part !== null)
  const tail = archive === 'off' ? '' : ` · archive ${archive}`

  return `compacted — kept ${kept.join(', ')}${tail}`
}

export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export const fileStamp = (now: number): string => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')

/** The archive root: the setting with ~ expanded, or ~/.claude/compact-keeper; null without a home. */
export const archiveRoot = (setting: string, home: string | undefined): string | null => {
  const trimmed = setting.trim().replace(/\/+$/, '')

  if (trimmed !== '' && !trimmed.startsWith('~')) {
    return trimmed
  }

  if (home === undefined || home === '') {
    return null
  }

  return trimmed === '' ? `${home}/.claude/compact-keeper` : `${home}${trimmed.slice(1)}`
}

export const archiveFolder = (root: string, cwd: string, sessionId: string): string => `${root}/${projectSlug(cwd)}/${sessionId}`

const toolHint = (input: Record<string, unknown>): string => {
  const target = input.file_path ?? input.notebook_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description

  return typeof target === 'string' && target !== '' ? ` \`${oneLine(target, MAX_TOOL_HINT_CHARS)}\`` : ''
}

const tagged = (text: string, tag: string): string | null => {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)

  return found?.[1]?.trim() ?? null
}

/** Engine rows read as what they stand for: a slash command as typed, its output as text, the caveat dropped. */
export const readableText = (text: string): string => {
  const name = tagged(text, 'command-name')

  if (name !== null) {
    const args = tagged(text, 'command-args') ?? ''

    return `\`${name}${args === '' ? '' : ` ${args}`}\``
  }

  const output = tagged(text, 'local-command-stdout')

  if (output !== null) {
    return `Command output:\n\n${output}`
  }

  return text.startsWith('<local-command-caveat>') ? '' : text
}

export type ArchiveMeta = { sessionId: string; cwd: string; at: number; trigger: string }

export const archiveMarkdown = (messages: readonly SessionMessage[], meta: ArchiveMeta): string => {
  const head = [
    '# Transcript before compaction',
    '',
    `- Session: ${meta.sessionId}`,
    `- Project: ${meta.cwd}`,
    `- Compacted: ${new Date(meta.at).toISOString()} (${meta.trigger})`,
    `- Messages: ${messages.length}`,
  ]
  const body: string[] = []

  for (const message of messages) {
    const text = readableText(message.text.trim())
    const tools = message.toolUses.map(use => `- ${use.tool}${toolHint(use.input)}${use.isError === true ? ' (error)' : ''}`)

    if (text === '' && tools.length === 0) {
      continue
    }

    body.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`)

    if (text !== '') {
      body.push(text)
    }

    if (tools.length > 0) {
      body.push(`Tools:\n${tools.join('\n')}`)
    }
  }

  return [...head, '', '---', '', body.join('\n\n'), ''].join('\n')
}

export const cleanNote = (text: string): string => oneLine(text, MAX_NOTE_CHARS)

export const notesIn = (book: unknown, sessionId: string): string[] => {
  const entry = typeof book === 'object' && book !== null ? (book as NoteBook)[sessionId] : undefined

  return Array.isArray(entry?.notes) ? entry.notes.filter(note => typeof note === 'string') : []
}

/** Sets one session's notes and drops the oldest sessions past the cap, so the store stays small. */
export const withNotes = (book: unknown, sessionId: string, notes: readonly string[], at: number): NoteBook => {
  const current: NoteBook = typeof book === 'object' && book !== null ? { ...(book as NoteBook) } : {}

  if (notes.length === 0) {
    delete current[sessionId]
  } else {
    current[sessionId] = { notes: [...notes], at }
  }

  const newest = Object.entries(current)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_SESSIONS_KEPT)

  return Object.fromEntries(newest)
}
