# compact-keeper

A Claude Code mod that makes compaction keep what matters: your goal, your own words, the files touched and the open work, plus a full markdown copy of the conversation before it was compacted.

```
compacted — kept goal, 1 note, 14 prompts, 6 files · archive saved
```

Right after the summary, the model reads a card like this:

```
[compact-keeper] What the user asked for before this compaction, kept word for word ...

## Goal
Migrate the billing service to the new Stripe API, keep the v1 webhooks working

## Notes the user pinned with /keep
- Never push to main

## User prompts, oldest first (last 14)
- Do not touch the tests folder
- ...

## Files edited or created
- /repo/billing/api.py
- /repo/billing/stripe_v2.py

## Open todos
- [in_progress] Port refunds

## Full transcript before compaction
/Users/you/.claude/compact-keeper/-Users-you-repo/<session-id>/2026-10-06T12-00-00Z.md
Read it when a detail is missing from the summary.
```

## Why

After a compaction Claude "forgets everything": the summary drops the goal, the constraints you set, the decisions and the file paths, and the conversation before it can't be viewed again.

- GitHub: [#17428](https://github.com/anthropics/claude-code/issues/17428), [#27242](https://github.com/anthropics/claude-code/issues/27242) and [#7530](https://github.com/anthropics/claude-code/issues/7530), together about 811 👍 and 996 comments.
- Reddit: [compacting a 900k session](https://www.reddit.com/r/ClaudeAI/comments/1v9bq96/) (1.1k upvotes) and [a second thread](https://www.reddit.com/r/ClaudeAI/comments/1r06z4r/).
- Hacker News: [the discussion](https://news.ycombinator.com/item?id=46426624).

Existing fixes work around compaction rather than inside it: claude-mem keeps memory across sessions, which is a different job, and PreCompact shell hooks can only run a script beside it. This mod hooks the compaction itself (`session.compact`), so it can change what the summarizer is told and what the compacted conversation holds.

## What it does

| Where | What |
|---|---|
| Summarizer instructions | Appends a paragraph asking it to keep the goal, constraints, decisions, file paths, commands and open work verbatim, plus your pinned notes. Text you typed after `/compact` stays first |
| Card after the summary | Goal (your first prompt that states a task), pinned notes, your last 20 prompts, files edited or created, the open items of the last todo list, the archive path |
| Archive | The conversation before compaction as markdown: each message's role and text, and the tools it called |
| `/keep <note>` | Pins a note for this session. It goes into the summarizer instructions and the card at every compaction |
| `/keep clear` | Removes this session's notes. `/keep` alone lists them |
| `/kept` | Prints the card as it would be now and the archive folder |
| Toast | `compacted — kept goal, 14 prompts, 6 files · archive saved` |

A second compaction reads the previous card back, so the goal, the prompts and the files from before the first compaction carry on.

## Install

You need Claude Code with mods (function hooks). It was tested on 2.1.285.

From the marketplace in this repo:

```
/plugin marketplace add Jvrd97/claude-compact-keeper
/plugin install compact-keeper@compact-keeper
```

Or straight from disk, for one session:

```bash
git clone https://github.com/Jvrd97/claude-compact-keeper.git
claude --plugin-dir ./claude-compact-keeper
```

## Settings

Change them in `/config` under the plugin, or in `settings.json` under `pluginConfigs`:

| Field | Default | Meaning |
|---|---|---|
| `archive` | `true` | Write the markdown archive at each compaction |
| `archiveDir` | empty | Archive root; `~` is your home. Empty means `~/.claude/compact-keeper` |
| `maxPrompts` | `20` | How many of your latest prompts the card carries; `0` keeps none |
| `instructions` | empty | Extra text for the summarizer, added after the mod's own paragraph |

## How it works

- `session.compact` fires for `/compact`, for auto-compaction and for a precompute. The mod acts only on the main conversation: a subagent's compaction (`agentId` set) passes through untouched.
- Before the summary runs, the mod builds the card from the messages being compacted and adds its instructions. A precompute gets the instructions only, because it installs nothing.
- After the summary succeeds, the mod writes the archive and puts the card into the compacted conversation right after the summary message. A skipped compaction (a PreCompact hook blocked it) gets no archive, no card and no toast.
- Pinned notes live in the plugin's own store (`$.store`, a JSON file under your Claude Code config folder), keyed by session id, so they survive `--continue` and `--resume`. The store keeps the 100 most recent sessions.
- Archives go to `<archive root>/<project slug>/<session id>/<time>.md`. The mod writes nowhere else and makes no network calls.

The card is part of the compacted conversation, not a hidden reminder: it shows in the transcript as a user message. A row appended through `$.session.append` from inside the hook lands before the compact boundary and is dropped with the old messages, which is why the mod hands the card up with the compaction's own result.

What it can't do:

- Force the summarizer to obey. The instructions make it more likely to keep your words; the card is the part that is guaranteed.
- Pick the goal perfectly. It is the first typed prompt with at least 3 words and 12 characters that is not a slash command. If your first prompt was small talk, the goal is wrong; `/keep` the real one.
- See tool results in the archive. It keeps text and the tool calls (name and target, for example the file path or the command), not what the tools returned.
- Track todos from task tools other than `TodoWrite`.
- Bring back a compaction that happened before the mod was installed.

## Develop

Inside Claude Code run `/plugin-types .claude/types` once: it writes the API types `tsc` reads. Then:

```bash
tsc -p .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

## По-русски

После сжатия контекста Claude теряет цель, ограничения, решения и пути к файлам, а историю до сжатия не посмотреть. Мод чинит это изнутри самого сжатия:

- просит модель-суммаризатор сохранить цель, ограничения, решения и пути дословно;
- сразу после саммари кладёт карточку: цель, ваши последние 20 промптов, заметки из `/keep`, изменённые файлы и открытые задачи;
- сохраняет всю переписку до сжатия в markdown в `~/.claude/compact-keeper/`.

`/keep <заметка>` закрепляет заметку на сессию, `/kept` показывает, что сохранится.

## License

MIT
