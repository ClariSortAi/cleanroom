---
name: audit
description: Audit the plugins, MCP servers and skills loaded in this project, switch off the irrelevant ones for this project only, ask about borderline ones four at a time, and report measured token savings. Arguments - restore, --dry-run, --fast.
argument-hint: "[--dry-run] [--fast] [restore]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" *), Bash(node --version), Read, Glob, Grep, AskUserQuestion
---

# Cleanroom audit

Trim this project's always-on context. Classify every switchable plugin, MCP server and skill against this project, switch off the clearly irrelevant ones, ask the user about the borderline ones four per AskUserQuestion call, then report the measured savings.

All changes go to `<project>/.claude/settings.local.json` (this project only, reversible) and take effect in the next session.

## CLI

Run every command from the project root, exactly as written below (same quoting, `node` first), with the Bash tool if you have it, otherwise PowerShell. `<project>` = the absolute current working directory. Run `node --version` as its own command.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" inventory --project "<project>" [--fast]
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" apply     --project "<project>" --inv <id> --disable S3,M2,P1
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" forecast  --project "<project>" --inv <id> --disable S3,M2,P1
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" restore   --project "<project>"
```

- Measurements run headless `claude -p` with `/context`, a local command: no model call, no billed tokens.
- `inventory` takes 1-3 minutes (each plugin and MCP server is measured alone). Use a 600000 ms tool timeout. With `--fast` it takes about 25 s and estimates plugin/MCP cost instead.
- Refs (`P#` plugin, `M#` MCP server, `S#` skill) and `<id>` come from the inventory report header. Run `inventory` once per audit; a new inventory renumbers every ref. Pass refs comma-separated, no spaces.
- `forecast` takes about 25 s; use a 300000 ms tool timeout.

## Arguments: `$ARGUMENTS`

- Contains `restore`: run `restore`, show its output, stop.
- Contains `--dry-run`: never run `apply`. Classify, ask, then `forecast` only, and label the summary "dry run, nothing changed".
- Contains `--fast`: pass `--fast` to `inventory`.

## Step 1: Inventory

- Check `node --version`. If Node is missing or older than 18, tell the user the audit needs Node 18+ and stop.
- Tell the user the inventory takes 1-3 minutes, then run `inventory`.
- Read the entire report. If the report says earlier cleanroom changes are active, mention that `/cleanroom:audit restore` undoes them.
- If project signals are thin (no manifest, no CLAUDE.md, no README), read up to 5 more files that reveal what the project is before classifying.

## Step 2: Classify every candidate

Put each ref in exactly one bucket.

- `remove`: serves a different domain or workflow than this project, with no plausible use during work here. Examples: video-editing skills in a backend API repo; a CRM connector in a firmware repo; cloud-provider skills for a provider the project does not use.
- `ask`: could plausibly help, is general-purpose, or you are not sure.
- `keep`: a concrete project signal ties it to this work (a dependency, file type, CLAUDE.md instruction, commit subject, folder). Note the signal.

Rules:
- Never put an `ask-only` ref in `remove`.
- Report says `EMPTY PROJECT`: put nothing in `remove`; tell the user why; offer only `ask` items.
- Keep or ask, never remove, anything the user's CLAUDE.md files or memory reference (a named skill, tool, or workflow). Check the memory-file paths listed in the report when in doubt.
- Keep general dev tools that fit any code repo (code review, git, docs lookup) unless the project clearly is not code.
- A failed or zero-tool MCP server still belongs in a bucket by relevance; note its status.
- Token size never decides relevance. It only orders the questions.
- Between `remove` and `ask`, pick `ask`.

## Step 3: Switch off the `remove` set

- Show a compact table: ref, kind, name, ~tokens, one-line reason. Group by kind if more than 15 rows.
- Unless `--dry-run`, run `apply --inv <id> --disable <remove refs>` at once. Do not ask first: the user chose auto-removal for clear mismatches, and `restore` undoes it.
- If `remove` is empty, say so in one line.

## Step 4: Ask about the `ask` set, four at a time

- Sort the `ask` refs by tokens, largest first.
- Send AskUserQuestion with 4 questions per call (fewer only in the last batch). Repeat until every `ask` ref has been asked.
- Before each call, print one line: `Batch N of M`.
- One question per item, `multiSelect: false`:
  - `header`: item name, at most 12 characters (strip `anthropic-skills:`, `claude.ai `, and `@marketplace`).
  - `question`: `<Kind> <name> (~N tokens per request): <what it does, one clause>. <why it might or might not matter here>. Switch it off for this project?`
  - options, your recommendation first with ` (Recommended)` appended to its label:
    - `Switch off`: description `Saves ~N tokens per request in this project. /cleanroom:audit restore undoes it.`
    - `Keep`: description = the most plausible use in this project.
- Free-text ("Other") answers: act on clear intent; otherwise keep.
- If the user dismisses a batch, stop asking and keep everything not yet answered.
- Collect answers across batches. Do not apply between batches.

## Step 5: Apply the user's choices

- Unless `--dry-run`, run `apply --inv <id> --disable <refs answered Switch off>`. Skip if none.

## Step 6: Forecast and summary

- Run `forecast --inv <id> --disable <every ref switched off: remove set + user choices>`. In a dry run, use the refs that would have been switched off. If nothing was switched off, skip the forecast and say the harness already fits this project.
- If the forecast reports that the skill listing is still at its budget, say plainly that removing skills improved the remaining skill descriptions rather than saving tokens, and quote the name-only counts.
- Present the summary in this order:
  1. Headline: `~X fewer always-on tokens per request (Y%)` and the per-session figure from the forecast.
  2. Table of switched-off items: ref, kind, name, ~tokens, `auto` or `you chose`.
  3. Kept after asking: names only, one line.
  4. Kept as relevant: names with the signal, one line each, at most 10 (then `+N more`).
  5. Category before/after table from the forecast.
  6. Not switchable per project (built-in skills, agents, memory files, inline plugins) with their token counts, as one short list. If a memory file is over 5k tokens, say it is the next biggest lever.
  7. Next steps: restart Claude Code in this project to apply; `/cleanroom:audit restore` to undo; any `.gitignore` note from `apply`.
- Quote numbers from the forecast output; never invent or round them further.
