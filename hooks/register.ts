import type { EngineInterface, Register, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

import {
  archiveFolder,
  archiveMarkdown,
  archiveRoot,
  buildCard,
  cardText,
  cleanNote,
  fileStamp,
  isEmptyCard,
  notesIn,
  previewText,
  summarizerInstructions,
  toastText,
  withCard,
  withNotes,
} from './logic'

const KEEP = 'keep'
const KEPT = 'kept'
const CLEAR = 'clear'
const TOAST_MS = 8_000
const DEFAULT_MAX_PROMPTS = 20

type Settings = { archive: boolean; archiveDir: string; maxPrompts: number; extra: string }

type Next = (e: SessionCompactInput) => Promise<SessionCompactResult>

type Archived = { status: 'saved'; path: string } | { status: 'failed' | 'off' }

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function notesOf($: EngineInterface, sessionId: string): Promise<string[]> {
  return notesIn(await $.store.get('notes'), sessionId)
}

async function saveNotes($: EngineInterface, sessionId: string, notes: readonly string[]): Promise<void> {
  const book = await $.store.get('notes')
  await $.store.set('notes', withNotes(book, sessionId, notes, await $.clock.now()))
}

async function folderOf($: EngineInterface, settings: Settings, sessionId: string): Promise<string | null> {
  const root = archiveRoot(settings.archiveDir, await $.env.get('HOME'))

  return root === null ? null : archiveFolder(root, await $.session.cwd(), sessionId)
}

async function saveArchive(
  $: EngineInterface,
  e: SessionCompactInput,
  settings: Settings,
  sessionId: string,
): Promise<Archived> {
  if (!settings.archive) {
    return { status: 'off' }
  }

  const folder = await folderOf($, settings, sessionId)

  if (folder === null) {
    $.ui.log('compact-keeper: no HOME and no archiveDir, so the transcript was not archived', { to: 'debug' })

    return { status: 'failed' }
  }

  const at = await $.clock.now()
  const path = `${folder}/${fileStamp(at)}.md`
  const text = archiveMarkdown(e.messages, { sessionId, cwd: await $.session.cwd(), at, trigger: e.trigger })

  try {
    await $.fs.write(path, text)

    return { status: 'saved', path }
  } catch (error) {
    $.ui.log(`compact-keeper: archive not written to ${path}: ${reasonOf(error)}`)

    return { status: 'failed' }
  }
}

async function compact($: EngineInterface, e: SessionCompactInput, next: Next, settings: Settings): Promise<SessionCompactResult> {
  const sessionId = await $.session.id()
  const notes = await notesOf($, sessionId)
  const instructions = summarizerInstructions(e.instructions, settings.extra, notes)

  // A precompute installs nothing: only its summary is kept for later, so it gets the instructions alone.
  if (e.trigger === 'precompute') {
    return next({ ...e, instructions })
  }

  const card = buildCard(e.messages, notes, settings.maxPrompts)
  const result = await next({ ...e, instructions })

  if (result.skip !== undefined) {
    return result
  }

  const archived = await saveArchive($, e, settings, sessionId)
  const archivePath = archived.status === 'saved' ? archived.path : null
  $.ui.toast(toastText(card, archived.status), { timeoutMs: TOAST_MS })

  if (isEmptyCard(card) && archivePath === null) {
    return result
  }

  // The card rides in the compacted conversation itself: a row appended from this hook would land
  // before the compact boundary and be dropped with the rest of the old transcript.
  const row: SessionMessage = { role: 'user', text: cardText(card, archivePath), toolUses: [] }

  return { ...result, messages: withCard(result.messages, row) }
}

async function keep($: EngineInterface, args: string): Promise<string> {
  const sessionId = await $.session.id()
  const notes = await notesOf($, sessionId)
  const note = args.trim()

  if (note === '') {
    const list = notes.length === 0 ? 'No notes pinned yet.' : notes.map(item => `- ${item}`).join('\n')

    return `${list}\n\nUsage: /keep <note> pins a note that survives compaction; /keep clear removes them all.`
  }

  if (note === CLEAR) {
    await saveNotes($, sessionId, [])

    return `Cleared ${notes.length} pinned note${notes.length === 1 ? '' : 's'}.`
  }

  const cleaned = cleanNote(note)
  const nextNotes = notes.includes(cleaned) ? notes : [...notes, cleaned]
  await saveNotes($, sessionId, nextNotes)

  return `Pinned (${nextNotes.length} in this session): ${cleaned}\nIt goes into the summary instructions and the card after every compaction.`
}

async function kept($: EngineInterface, settings: Settings): Promise<string> {
  const sessionId = await $.session.id()
  const card = buildCard(await $.session.messages(), await notesOf($, sessionId), settings.maxPrompts)
  const folder = settings.archive ? await folderOf($, settings, sessionId) : null

  return previewText(card, folder, settings.archive)
}

export const register: Register = (on, options) => {
  const maxPrompts = Number(options.maxPrompts ?? DEFAULT_MAX_PROMPTS)
  const settings: Settings = {
    archive: options.archive !== false,
    archiveDir: String(options.archiveDir ?? ''),
    maxPrompts: Number.isFinite(maxPrompts) ? Math.max(0, Math.floor(maxPrompts)) : DEFAULT_MAX_PROMPTS,
    extra: String(options.instructions ?? ''),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: KEEP, description: 'Pin a note that survives compaction (/keep clear removes all)', argumentHint: '<note> | clear' })
    await $.command.register({ name: KEPT, description: 'Show what compact-keeper will keep at the next compaction' })

    return next(e)
  })

  on('session.compact', ($, e, next) => (e.agentId === undefined ? compact($, e, next, settings) : next(e)))

  on('command.run', { command: KEEP }, async ($, e) => ({ text: await keep($, e.args) }))

  on('command.run', { command: KEPT }, async $ => ({ text: await kept($, settings) }))
}
