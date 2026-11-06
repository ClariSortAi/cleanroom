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

Requirements: Claude Code 2.1 or later, and Node 18 or later on your PATH.

The plugin costs nothing until you run it. Its skill is user-invoked only, so its description never enters the context.

## Usage

Open Claude Code in the project you want to clean up, then run:

```
/cleanroom:audit              full audit (1 to 3 minutes of measuring, then questions)
/cleanroom:audit --dry-run    classify, ask and forecast, but change nothing
/cleanroom:audit --fast       estimate plugin and MCP costs instead of measuring each one
/cleanroom:audit restore      undo every change cleanroom made in this project
```

A first run with `--dry-run` shows what it would do without touching anything.

## What it does

1. Measures the current context with Claude Code's own `/context` report and lists every switchable plugin, MCP server and skill with its token cost.
2. Reads the project (manifests, file types, CLAUDE.md, README, recent commits) and sorts each item into remove, ask or keep.
3. Switches off the items that clearly belong to another domain, without asking.
4. Asks about the borderline items four at a time, largest first, with a recommendation on each.
5. Measures the result and prints a summary: tokens saved per request and per 50-request session, a before/after table by category, and what it could not touch.

Changes take effect the next time you start Claude Code in that project.

## How it measures

cleanroom runs `claude -p` in the background and sends it `/context`. That is a local command, so no model call is made and no tokens are billed. It waits 20 seconds before asking, so stdio MCP servers have time to connect.

To forecast a plan, it passes the proposed switches as a temporary `--settings` file. Nothing is written while forecasting. Each plugin and MCP server is also measured alone, which is why the full inventory takes a minute or more.

Two things `/context` does not show directly, and how cleanroom handles them:

- Deferred MCP tools are listed by name in every request, but `/context` does not count that list. cleanroom estimates it from the tool names and reports it on a separate line. A server with 207 tools adds about 2,300 tokens this way.
- Skill descriptions share a fixed budget (about 1.5% of the context window). With many skills installed, most are listed by name only. Switching off skills then saves few tokens, because the remaining skills expand into the freed space. The forecast says when this happens and reports how many skills went from name-only back to a full description.

## What it changes

Everything goes into one file, `<project>/.claude/settings.local.json`:

| Item | Setting |
|---|---|
| Skill or command | `"skillOverrides": { "<name>": "off" }` |
| Plugin | `"enabledPlugins": { "<name>@<marketplace>": false }` |
| MCP server (any scope, including claude.ai connectors) | `"deniedMcpServers": [{ "serverName": "<name>" }]` |

Each change is logged under `~/.claude/cleanroom/<project>/undo.json`. `restore` reverts exactly those keys. If you edited one of them by hand after the audit, restore leaves your value in place.

A denied MCP server can't be switched back on from the `/mcp` menu in that project. Use `restore`, or delete its entry from `deniedMcpServers`.

## What it never touches

- Built-in skills and agents.
- Custom agents. Claude Code has no per-project switch that removes an agent from context, so the summary only lists their cost.
- Memory files (CLAUDE.md, auto memory). The summary flags any over 5,000 tokens.
- Plugins loaded with `--plugin-dir`.
- Items declared for the project itself (project skills, `.mcp.json` servers, plugins enabled in project settings). The audit can ask about these, but never removes them on its own.
- Anything in an empty project. With no signals to judge by, it only asks.

## Things to know

- The measuring runs start Claude Code headlessly in your project, so they load the project's hooks and `.mcp.json` servers, the same as opening a session there. Run the audit only in projects you trust. Pass `--no-hooks` to the CLI to skip hooks (plugin hook costs are then not counted).
- The runs can't use `claude -p --bare`, which is the usual advice for scripted calls, because bare mode skips the plugins and skills being measured. Each run uses default permission mode instead and stops if `/context` ever reaches the model.
- The inventory connects to your MCP servers once per measurement, the same way a normal session does.
- While the audit runs, the skill pre-approves only `node --version` and its own script. Anything else asks for permission as usual.
- Classification is done by the model in your session. It errs toward asking, and `restore` undoes everything.

## Development

```
npm test                      unit tests (node:test, no dependencies)
claude plugin validate .      manifest and skill checks
claude --plugin-dir .         load this checkout in a session
node scripts/cleanroom.mjs inventory --project <dir> --fast
```

The CLI has four commands: `inventory`, `forecast`, `apply` and `restore`. `forecast` and `apply` need the `--inv <id>` printed in the inventory header, because refs like `S12` are renumbered on every inventory.

Set `CLEANROOM_CLAUDE_BIN` if `claude` is not on your PATH.

## License

MIT
