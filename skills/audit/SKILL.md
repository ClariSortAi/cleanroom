---
name: audit
description: Audit the plugins, MCP servers and skills loaded in this project, switch off the irrelevant ones for this project only, ask about borderline ones four at a time, and report measured token savings. Arguments - restore, --dry-run, --fast.
argument-hint: "[--dry-run] [--fast] [restore]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" *), Bash(node --version), Read, Glob, Grep, AskUserQuestion
---

# Cleanroom audit

Trim this project's always-on context. Classify every switchable plugin, MCP server and skill against this project, switch off the clearly irrelevant ones, ask the user about the borderline ones four per AskUserQuestion call, then report the measured savings.

All changes go to `<project>/.claude/settings.local.json` (this project only, reversible) and take effect in the next session. User-scope changes happen only in Step 7, only after the user says yes.

## CLI

Run every command from the project root, exactly as written below (same quoting, `node` first), with the Bash tool if you have it, otherwise PowerShell. `<project>` = the absolute current working directory. Run `node --version` as its own command.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" inventory --project "<project>" [--fast]
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" apply     --project "<project>" --inv <id> --disable S3,M2,P1
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" forecast  --project "<project>" --inv <id> --disable S3,M2,P1
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" restore   --project "<project>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" apply     --project "<project>" --inv <id> --disable S5,P2 --scope user
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanroom.mjs" restore   --project "<project>" --scope user
```

- Measurements run headless `claude -p` with `/context`, a local command: no model call, no billed tokens.
- `inventory` takes 1-3 minutes (each plugin and MCP server is measured alone). Use a 600000 ms tool timeout. With `--fast` it takes about 25 s and estimates plugin/MCP cost instead.
- Refs (`P#` plugin, `M#` MCP server, `S#` skill) and `<id>` come from the inventory report header. Run `inventory` once per audit; a new inventory renumbers every ref. Pass refs comma-separated, no spaces.
- `forecast` takes 25-50 s; use a 300000 ms tool timeout.

## Arguments: `$ARGUMENTS`

- Contains `restore`: run `restore`. If the inventory or the user mentions user-scope changes, also offer `restore --scope user`. Show the output, stop.
- Contains `--dry-run`: never run `apply`. Classify, ask, then `forecast` only, and label the summary "dry run, nothing changed". Skip the Step 7 question; show the guidance only.
- Contains `--fast`: pass `--fast` to `inventory`.

## Step 1: Inventory

- Check `node --version`. If Node is missing or older than 18, tell the user the audit needs Node 18+ and stop.
- Tell the user the inventory takes 1-3 minutes, then run `inventory`.
- If Warnings say MCP servers were still connecting, run `inventory` once more with `--wait 45` (keep `--fast` if it was set) and use that report and its id.
- Read the entire report, including the `Skill listing:` header line and `Account-wide signals`. If earlier cleanroom changes are active, mention the matching `restore` command.
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
- `Skill listing: FULL`: still put clear-mismatch skills in `remove` (they crowd the listing). For a borderline skill, default to `keep`; put it in `ask` only if it could trigger wrongly during work in this project (its description matches tasks this project does but it serves another purpose).
- Token size never decides relevance. It only orders the questions.
- Between `remove` and `ask`, pick `ask`.

## Step 3: Switch off the `remove` set

- Show a compact table: ref, kind, name, tokens saved, one-line reason. For skills while the listing is full, write `0 (frees listing room)` in the tokens column. Group by kind if more than 15 rows.
- Unless `--dry-run`, run `apply --inv <id> --disable <remove refs>` at once. Do not ask first: the user chose auto-removal for clear mismatches, and `restore` undoes it.
- If `remove` is empty, say so in one line.

## Step 4: Ask about the `ask` set, four at a time

- Order: plugins and MCP servers first (largest tokens first), then skills.
- Send AskUserQuestion with 4 questions per call (fewer only in the last batch). Repeat until every `ask` ref has been asked.
- Before each call, print one line: `Batch N of M`.
- One question per item, `multiSelect: false`:
  - `header`: item name, at most 12 characters (strip `anthropic-skills:`, `claude.ai `, and `@marketplace`).
  - Plugin or MCP server, or a skill when the listing fits:
    - `question`: `<Kind> <name> (~N tokens per request): <what it does, one clause>. <why it might or might not matter here>. Switch it off for this project?`
    - `Switch off` description: `Saves ~N tokens per request in this project. /cleanroom:audit restore undoes it.`
  - Skill while `Skill listing: FULL`:
    - `question`: `Skill <name>: <what it does, one clause>. <how it could trigger wrongly here>. Switch it off for this project? (No token saving: the skill listing is full.)`
    - `Switch off` description: `Frees description room for the other skills; no token saving. /cleanroom:audit restore undoes it.`
  - `Keep` description: the most plausible use in this project.
  - Put your recommendation first with ` (Recommended)` appended to its label. While the listing is full, recommend `Keep` for skills unless wrong triggering is likely.
- Never state a token saving for a skill while the listing is full.
- Free-text ("Other") answers: act on clear intent; otherwise keep.
- If the user dismisses a batch, stop asking and keep everything not yet answered.
- Collect answers across batches. Do not apply between batches.

## Step 5: Apply the user's choices

- Unless `--dry-run`, run `apply --inv <id> --disable <refs answered Switch off>`. Skip if none.

## Step 6: Forecast and summary

- Run `forecast --inv <id> --disable <every ref switched off: remove set + user choices>`. In a dry run, use the refs that would have been switched off. If nothing was switched off, skip the forecast and say the harness already fits this project.
- Present the summary in this order:
  1. Headline: `~X fewer always-on tokens per request (Y%)`, then the forecast's split: from plugins/MCP servers, from skills. Then the per-session figure.
  2. If skills were switched off and the forecast says the listing is still at its budget: one sentence saying the skills saved no tokens but restored descriptions, with the name-only counts.
  3. Table of switched-off items: ref, kind, name, tokens saved, `auto` or `you chose`. Skills while the listing is full: `0 (frees listing room)`. Never list per-skill token savings in that case.
  4. Kept after asking: names only, one line.
  5. Kept as relevant: names with the signal, one line each, at most 10 (then `+N more`).
  6. Category before/after table from the forecast, as printed (the skill listing is one merged row).
  7. Not switchable per project (built-in skills, agents, memory files, inline plugins) with their token counts, as one short list. If a memory file is over 5k tokens, say it is the next biggest lever.
  8. Next steps: restart Claude Code in this project to apply; `/cleanroom:audit restore` to undo; any `.gitignore` note from `apply`.
- Quote numbers from the forecast output; never invent or round them further.

## Step 7: Switch these off everywhere (only when triggered)

Trigger if any of these hold:
- 10 or more items switched off in this audit (auto + chosen).
- `Account-wide signals` shows 10 or more items already switched off in this repo's settings files.
- Any candidate is marked `off in N other repos` with N >= 2.

When triggered, add a `Switch these off everywhere` section to the summary:
- List items that look irrelevant across the whole account: items off in 2+ other repos, plus items tied to one client, product or domain that most repos would not use. Leave out items that fit some of the user's repos (judge from the CLAUDE.md and memory files in the report). One line each: name, kind, why.
- Give the method for each kind present, exactly as below:
  - Plugin: `"enabledPlugins": { "<name>@<marketplace>": false }` in `~/.claude/settings.json`. A repo that needs it sets `true` in its own `.claude/settings.local.json`; the higher scope wins.
  - Skill (user or claude.ai synced): `"skillOverrides": { "<name>": "off" }` in `~/.claude/settings.json`. A repo that needs it sets `"<name>": "on"` in its own `.claude/settings.local.json`. For synced skills there is also `"syncClaudeAiSkills": false` in `~/.claude/settings.json`, which stops syncing all claude.ai skills into Claude Code.
  - User-scope MCP server: run `claude mcp get <name>` and save its config first, then `claude mcp remove <name> --scope user`, then `claude mcp add ... --scope local` (or `--scope project`) in each repo that uses it. Do not suggest a user-level `deniedMcpServers` entry for it: deny lists merge across scopes, so no repo could turn it back on.
  - claude.ai connector: keep switching it off per project (what cleanroom already does). If the user never uses it in Claude Code, a user-level `"deniedMcpServers": [{ "serverName": "claude.ai <Name>" }]` blocks it everywhere with no per-repo exception; `"disableClaudeAiConnectors": true` blocks every connector. Disconnecting it on claude.ai also changes claude.ai itself.
- Unless `--dry-run`, ask one AskUserQuestion: `Switch the listed plugins and skills off for every project now? (MCP servers and connectors stay manual.)` Options: `Yes, user scope` (description: `Writes ~/.claude/settings.json; /cleanroom:audit restore offers --scope user to undo`) and `No, I'll do it myself` (description: `Nothing changes; the steps above stay in the summary`). Do not mark either as recommended.
- On yes: run `apply --inv <id> --disable <plugin and skill refs from the list> --scope user`, show its output, and remind the user how a repo turns an item back on.
