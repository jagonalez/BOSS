# BOSS plugins

A plugin adds a capability BOSS did not ship with. It is a directory, and an
agent can write one: ask BOSS for a task board, a timer, or a dashboard, and it
writes the files here and reloads them.

Plugins in this directory are examples BOSS bundles. On first run each one is
copied into your plugins directory (`plugins/` inside BOSS's application data),
where you can edit or delete it. A deleted example is not restored.

## Shape

```
hello/
  plugin.json   # required: the manifest
  server.mjs    # optional: an MCP server providing this plugin's tools
  view.html     # optional: a page BOSS shows in a tab
  data/         # created by BOSS; your server's private storage
```

### plugin.json

```json
{
  "id": "hello",
  "name": "Hello, plugin",
  "version": "1.0.0",
  "description": "The smallest working plugin.",
  "server": { "command": "node", "args": ["./server.mjs"] },
  "views": [{ "id": "demo", "title": "Hello, plugin", "entry": "view.html" }]
}
```

- `id` must equal the directory name. Lowercase letters, digits and dashes.
- `server` is a stdio MCP server. A relative `command` or `arg` resolves against
  the plugin directory.
- `views` each become a tab you can open from a pane's add menu.

Both `server` and `views` are optional. A plugin with only a server adds tools;
a plugin with only a view draws something.

## The one rule

**A view reaches its data only by calling its own plugin's tools.**

```js
const result = await window.bossPlugin.call('greet', { name: 'Jeremy' })
```

`window.bossPlugin.call(tool, args)` is the whole API a view gets. There is no
filesystem, no network, no Node, and no way to name another plugin — BOSS reads
which plugin is calling from the page's own URL, not from the message.

This is what makes a generated plugin safe to load. It also means the agent and
the view share one data path, so what BOSS can do and what you can see never
drift apart. Put every piece of state behind a tool.

The call returns the parsed object your tool produced, or its text when the
result is not JSON. It rejects when the tool reports an error.

## Environment your server gets

| Variable | Meaning |
| --- | --- |
| `BOSS_PLUGIN_DIR` | The plugin's own directory |
| `BOSS_PLUGIN_DATA_DIR` | A private directory for its state, created by BOSS |

Write state to `BOSS_PLUGIN_DATA_DIR`. It is not served to the view, so a page
cannot read around your tools.

## Global or per project — your choice

BOSS adds a `project` field to the arguments of **every** tool call:

```json
{ "project": { "projectId": "project_9f2c…", "projectPath": "/Users/you/dev/app" } }
```

It comes from BOSS, not from the caller, and it is set last — so the agent and
your view always see the same project, and neither can pass one of its own.
`projectId` is `"global"` when no project is open, and it is always safe to use
as a directory name.

**Ignore it and your plugin is global.** Installed once, same state everywhere,
like an MCP connection. That is the right shape for a plugin that talks to an
external service.

**Use it and your plugin is per project.** One line:

```js
const dir = join(process.env.BOSS_PLUGIN_DATA_DIR, args.project.projectId)
```

A task board, a notes pane, anything tied to the code in front of you wants
this. Do not try to derive the project yourself — a view has no way to know it,
so the two halves of your plugin would disagree.

One gotcha: if your tool schema sets `additionalProperties: false`, it will
reject the injected `project`. Use `true`, or declare the field.

## Agent tools

| Tool | Use |
| --- | --- |
| `boss_plugin_list` | What is installed, with each plugin's tools and views |
| `boss_plugin_create` | Make the directory and write `plugin.json` |
| `boss_plugin_reload` | Start a plugin just written or edited |

A plugin's own tools reach the agent as `plugin_<id>_<tool>`.

## Writing one

1. Call `boss_plugin_create` with the manifest. It returns the directory.
2. Write `server.mjs` and `view.html` into it.
3. Call `boss_plugin_reload`.
4. Open the view from a pane's add menu, under Plugins.

`hello/` is a complete worked example: a JSON-RPC server and a single-file view,
each around 130 lines. It stores nothing, so it shows the wiring without the
distraction of state. Read it before writing your first plugin, and copy it as
your starting point.

Two things to know once you do add storage:

- **Serialize your writes.** Tool calls arrive concurrently, so a server that
  reads and writes one file will lose data unless calls are queued. A promise
  chain around the read-modify-write is enough.
- **Decide global or per project** before you write the first file, using the
  `project` field described above. Changing your mind later means migrating
  whatever you already stored.
