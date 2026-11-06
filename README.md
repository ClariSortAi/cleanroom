# cleanroom

A Claude Code plugin that checks which plugins, MCP servers and skills are loaded in a project, switches off the ones that have nothing to do with that project, and tells you how many tokens that saves.

Every switched-on skill, MCP server and plugin adds text to every request: skill descriptions, server instructions, tool names. If you install things for one project, they ride along into all the others. cleanroom trims that per project and leaves your global setup alone.

## Install

In Claude Code:

```
/plugin marketplace add ClariSortAi/cleanroom
/plugin install cleanroom@cleanroom
```

Then run `/reload-plugins` or restart Claude Code.

Requirements: Claude Code 2.1 or later with its Bash tool. macOS and Linux have it out of the box; on Windows it comes from Git for Windows.

The plugin costs nothing until you run it. Its skill is user-invoked only, so its description never enters the context.

## Usage

Open Claude Code in the project you want to clean up, then run:

```
/cleanroom:audit              full audit (about a minute of measuring, then questions)
/cleanroom:audit --dry-run    classify, ask and forecast, but change no settings
/cleanroom:audit restore      undo every change cleanroom made in this project
```

A first run with `--dry-run` shows what it would do without touching your settings.

## What it does

1. Measures the current context with Claude Code's own `/context` report and lists every switchable plugin, MCP server and skill with an estimated token cost.
2. Reads the project (manifests, file types, CLAUDE.md, README, recent commits) and sorts each item into remove, ask or keep.
3. Lists the items that clearly belong to another domain. These get switched off without a question.
4. Asks about the borderline items four at a time, largest first, with a recommendation on each.
5. Measures the plan before writing anything, then writes the switches and prints a summary: tokens saved per request and per 50-request session, a before/after table by category, and what it could not touch.

Changes take effect the next time you start Claude Code in that project.

cleanroom is a single skill with no scripts. Claude runs the measuring commands and edits the settings file itself, so an audit shows two shell commands and two file edits (the settings file and its undo log), each with a permission prompt.

## How it measures

Claude starts `claude -p` in the background and sends it `/context`. That is a local command, so no model call is made and no tokens are billed, and the output includes a check that proves it. The run waits 20 seconds before asking, so stdio MCP servers have time to connect, and 45 if some were still connecting.

The first run gives a cost estimate for each item, read from the `/context` tables. To check the plan, Claude runs `/context` twice more with the proposed switches passed as a temporary `--settings` file: once with everything, once without the skills. The before and after totals in the summary come from those runs. Nothing is written to your settings while forecasting.

Some costs don't show up directly in `/context`. Here is how cleanroom handles them:

- Deferred MCP tools are listed by name in every request, but `/context` does not count that list. cleanroom estimates it from the tool names (about one token per three characters) and adds it to the savings. A server with 207 tools adds about 2,300 tokens this way.
- Skill descriptions share a fixed budget (about 1.5% of the context window). With many skills installed, some are listed by name only, and the listing is full. Switching a skill off then saves no tokens, because the remaining skills expand into the freed space. cleanroom detects a full listing, reports each skill's saving as 0, and asks about a borderline skill only when it could trigger wrongly in your project. It still switches off clear mismatches, because they crowd the listing and push out descriptions you do want. The summary splits the saving into plugins and MCP servers versus skills.
- The skill listing is counted partly under Skills and partly under System tools in `/context`, and it moves between the two as skills are removed. The summary shows them as one row.
- Per-item numbers are estimates. MCP server instructions and plugin hooks aren't split per item, so they only show up in the measured total.

## What it changes

Switches go into one file, `<project>/.claude/settings.local.json`:

| Item | Setting |
|---|---|
| Skill or command | `"skillOverrides": { "<name>": "off" }` |
| Plugin | `"enabledPlugins": { "<name>@<marketplace>": false }` |
| MCP server (any scope, including claude.ai connectors) | `"deniedMcpServers": [{ "serverName": "<name>" }]` |

Each change is logged in `<project>/.claude/cleanroom/undo.json`, a folder that keeps itself out of git. `restore` reverts exactly the logged keys. If you edited one of them by hand after the audit, restore leaves your value in place.

A denied MCP server can't be switched back on from the `/mcp` menu in that project. Use `restore`, or delete its entry from `deniedMcpServers`.

## Switching things off everywhere

If an audit switches off a lot, or sibling repos in the same parent folder already switch off the same items, the summary adds a "Switch these off everywhere" section. It lists the items that look irrelevant across your whole account and how to switch each kind off once instead of repo by repo:

| Item | Off everywhere | Back on in one repo |
|---|---|---|
| Plugin | `"enabledPlugins": { "<id>": false }` in `~/.claude/settings.json` | `"<id>": true` in that repo's `.claude/settings.local.json` |
| Skill | `"skillOverrides": { "<name>": "off" }` in `~/.claude/settings.json` | `"<name>": "on"` in that repo's `.claude/settings.local.json` |
| User-scope MCP server | `claude mcp remove <name> --scope user` (save `claude mcp get <name>` first) | `claude mcp add ... --scope local` in that repo |
| claude.ai connector | a `deniedMcpServers` entry in `~/.claude/settings.json`, or `"disableClaudeAiConnectors": true` for all of them | not possible: deny lists merge across scopes |

For plugins and skills, the audit can make the change for you if you say yes. It edits `~/.claude/settings.json`, logs the change in `~/.claude/cleanroom/user-undo.json`, and `/cleanroom:audit restore` offers to undo it. MCP servers and connectors stay manual, because a user-level deny can't be lifted for a single repo and moving a server between scopes means re-adding its config.

## What it never touches

- Built-in skills and agents.
- Custom agents. Claude Code has no per-project switch that removes an agent from context, so the summary only lists their cost.
- Memory files (CLAUDE.md, auto memory). The summary flags any over 5,000 tokens.
- Plugins loaded with `--plugin-dir`.
- Items declared for the project itself (project skills, `.mcp.json` and local-scope servers, plugins enabled in project settings). The audit can ask about these, but never removes them on its own.
- Anything in an empty project. With no signals to judge by, it only asks.

## Data and privacy

cleanroom has no code of its own. It is a set of instructions that Claude follows with its normal tools, and it sends nothing anywhere. `/context` is answered locally, so the measuring runs send nothing to a model. Each run does start Claude Code, which connects to your configured MCP servers the same way any session in that project would.

Claude reads:

- From this project: the file list, manifests, CLAUDE.md (or AGENTS.md), the README, the last 12 commit subjects, and `.claude/settings.json` and `.claude/settings.local.json`.
- The same two settings files in sibling folders of the project (for example `C:\Dev\*` for `C:\Dev\myapp`), to spot items you already switch off elsewhere. Only the switched-off keys reach the conversation.
- The `SKILL.md` descriptions of your installed skills and the manifests of your installed plugins.
- The `/context` output and the list of MCP servers and plugins that the headless run reports. These show server and tool names, not server configuration.

It writes:

- `<project>/.claude/settings.local.json`, with the switches.
- `<project>/.claude/cleanroom/`, with the measurement output, forecast settings and undo log. You can delete the folder at any time, but `restore` needs the undo log.
- `~/.claude/settings.json` and `~/.claude/cleanroom/user-undo.json`, only after you say yes to switching items off everywhere.

What Claude reads goes into your Claude Code conversation, like any other file it reads during a session.

## Things to know

- The measuring runs start Claude Code headlessly in your project, so they load the project's hooks and `.mcp.json` servers, the same as opening a session there. Run the audit only in projects you trust.
- The runs can't use `claude -p --bare`, which is the usual advice for scripted calls, because bare mode skips the plugins and skills being measured. Each run uses default permission mode instead, and the audit stops if `/context` ever reaches the model.
- The skill pre-approves only Read, Glob and Grep. Every shell command and file edit asks for permission, and the edits go through Claude Code's Write and Edit tools, so each prompt shows the diff. Claude Code always asks before changing files under `.claude/`, even in accept-edits mode.
- Claude does the classification and the arithmetic in your session. It errs toward asking, and `restore` undoes everything.

## Development

```
claude plugin validate .      manifest and skill checks
claude --plugin-dir .         load this checkout in a session
```

The whole plugin is `skills/audit/SKILL.md`. Versions up to 0.2.1 ran a Node script, which is still in the git history.

## License

MIT
