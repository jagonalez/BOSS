# BOSS plugins

A plugin adds a capability BOSS did not ship with. It is a directory, and an
agent can write one: ask BOSS for a task board, a timer, or a dashboard, and it
writes the files here and reloads them.

Plugins in this directory are examples BOSS bundles. On first run each one is
copied into your plugins directory (`plugins/` inside BOSS's application data),
where you can edit or delete it. A deleted example is not restored.

## Shape

```
tasks/
  plugin.json   # required: the manifest
  server.mjs    # optional: an MCP server providing this plugin's tools
  view.html     # optional: a page BOSS shows in a tab
  data/         # created by BOSS; your server's private storage
```

### plugin.json

```json
{
  "id": "tasks",
  "name": "Tasks",
  "version": "1.0.0",
  "description": "A task board.",
  "server": { "command": "node", "args": ["./server.mjs"] },
  "views": [{ "id": "board", "title": "Tasks", "entry": "view.html" }]
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
const result = await window.bossPlugin.call('add', { title: 'Something' })
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

`tasks/` is a complete worked example: a JSON-RPC server in about 150 lines and
a single-file view. Read it before writing your first plugin.

One thing that example gets right and is easy to get wrong: tool calls arrive
concurrently, so a server that reads and writes one file must serialize its
calls. `tasks/server.mjs` shows the pattern.
