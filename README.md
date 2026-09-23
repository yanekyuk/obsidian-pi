# Pi Harness for Obsidian

A chat panel for the [pi coding agent](https://github.com/earendil-works/pi) inside Obsidian. pi runs in the background with your vault as its working directory; the panel is built from Obsidian's own components and theme variables, so it looks like part of the app in any theme.

Desktop only: the plugin starts `pi` as a child process. Developed and used on macOS; Linux should work the same way; Windows is untested. This is a community project, not affiliated with pi's authors or with Obsidian.

## Before you install

This plugin puts a coding agent in your vault. Read this first.

- **pi acts without asking.** It can run shell commands and read, change or delete any file your user account can, in the vault and outside it. That is how pi works in a terminal too; the plugin adds no confirmation step. Text pi reads (a note, a web page it fetched) can contain instructions that steer it, so treat it like any other program you give your shell to. For a read-only agent, put `--tools read,grep,find,ls` in Settings → Extra arguments. Keep backups of your vault.
- **Your notes leave your machine.** Whatever pi reads, plus the active note and selection when the note chip is on, is sent to the model provider you configured in pi. Pi Harness has no telemetry and does not send note content independently of pi.
- **Network use.** pi talks to your model provider and to whatever its tools reach (web search and fetch, MCP servers). The plugin also sends a local MCP `initialize` request to HTTP servers listed in the vault's `.mcp.json`, only to warn you when one is down.
- **Third-party Pi packages are manual.** The panel works best with six extensions from rpiv, `pi-mcp-adapter`, and Steph Ango's Obsidian skills. Pi Harness reports when they are missing, but never installs, removes, or updates Pi or its packages. Review and manage them yourself in a terminal.
- **The web viewer, only if you switch it on.** pi can then open, read and operate pages in Obsidian's web viewer, where you may be logged in to sites. See [Web viewer](#web-viewer).
- **Files outside the vault.** The panel's pi keeps its config in `~/.pi/harness`, with links to your pi logins in `~/.pi/agent`. pi keeps sessions under `~/.pi/agent/sessions`; "Move to trash" in the session list moves such a file to the system trash. Choosing an advisor model writes `~/.config/rpiv-advisor/advisor.json`. To find `pi` when Obsidian was started from the Dock, the plugin asks your login shell for its `PATH`.

## What it does

- Streams replies as Obsidian Markdown. Wikilinks in replies are clickable and show hover previews.
- Markdown renders everywhere the model's words appear, not only in replies: question cards (options, descriptions), the task list, queued messages, side questions and the answers shown on question cards. Links in those places work too.
- Shows thinking and tool calls as collapsible blocks. Edits render as diffs, and an edit or write pi made can be undone from its card (and redone), as long as the file hasn't changed since. The panel keeps the before and after versions in memory only; Obsidian's File Recovery is there for the rest. A file path on a card has an open button: vault files open in Obsidian (Cmd-click for a new tab), anything else opens in the system's default app. Image paths also get a button that shows the picture inside the card, and pictures a tool returns appear under its output.
- Shares the active note and your selection with pi. Click the note chip in the composer to turn that off for a message.
- Puts replies back into the vault. Hovering a reply shows four buttons: copy it as Markdown, insert it into the open note at the cursor (in place of the selection, if there is one), append it to the open note, or make a new note from it. A new note is named after the reply's top heading or first line and created where Obsidian puts new notes.
- Edit a message you sent and run the conversation again from there. Hover the message and click the pencil; Enter sends, Esc cancels. The message goes out with the note context and images it had, and pi stops first if it is still working. pi can only branch into a new session file over RPC (its `/fork`), so the tab carries on in the branch and the conversation as it was stays in the session list. A note linked to the session keeps pointing at the original.
- Paste or drop images into the composer. They are scaled to 2000px at most, the bound pi uses for images it reads itself, and show up in the transcript.
- `/` completes pi commands, prompt templates and skills. `[[` or `@` completes notes as wikilinks, and notes dragged from the file explorer or search results land in the message as wikilinks too.
- While pi is working, Enter (or the send button) steers: pi reads the message before its next step. Alt+Enter (or the queue button that appears beside send) queues it for when pi has finished. Waiting messages are listed above the composer as **Next** and **After**; the ↶ button on the list takes them back into the editor, and Esc stops pi and does the same.
- Messages sent while pi is compacting are held and go out when compaction ends, in order. pi itself refuses prompts during compaction; its terminal UI holds them the same way.
- Switch model and thinking level from the composer. The model picker works like pi's own: it opens on your scoped models (`enabledModels` in pi's settings) with all models a click or Tab away, and remembers which view you used. A scoped model pi can't use right now is listed as not available, which usually means its provider comes from a package that isn't installed for the panel's pi. The context reading beside them has a compact button; `/compact` does the same, and `/compact <what to keep>` steers the summary.
- `/reload`, or the ↻ button (in the toolbar, and on each row of the tab list), reloads extensions, skills, prompt templates, context files and settings without losing the conversation. pi's own `/reload` exists only in its terminal UI and RPC has no command for it, so the panel restarts pi on the same session, which picks up the same things. It acts on the tab on screen and waits if pi is working there.
- Questions from pi extensions are answered in a card above the composer, not in a popup. Notifications and widgets show up in the panel too. The footer status text extensions write for pi's terminal ("MCP: 1 server enabled") is left out; the line above the composer only says what pi is doing.
- Connects the vault's MCP servers when pi starts. pi's MCP adapter is lazy, so a fresh pi lists them as "disconnected (0 tools)" until something uses one; the panel runs `/mcp reconnect <name>` for each HTTP server in the vault's `.mcp.json` that is up. Turn it off under Settings → Extensions.
- Output from extension commands (`/mcp`, `/todos`) appears in the transcript under the command you typed, instead of in a toast. Only short one-line remarks stay toasts. This output is not part of the session, so it is gone after a reload.
- Warns when an HTTP MCP server in the vault's `.mcp.json` is unavailable, such as the one from the Vault as MCP plugin. pi's MCP adapter connects lazily and reports "enabled" either way, so the panel sends each server a real MCP `initialize` when pi starts and at most every 30 seconds as runs begin. Click the warning to check again.

## Sessions

A note can own a session. **Open pi for this note** (command palette, or the note's right-click menu) opens the session linked to the note, or starts one and writes its file name into the note's `pi-session` property. The panel's `⋮` menu links or unlinks the tab on screen by hand. Only the session's file name is stored, so the link is worth the same on another machine that has the session. **Export conversation to a note** (`⋮` menu or command) writes what was said, with tool calls as one-line asides and without thinking or tool output, into a new note that carries the same `pi-session` property.

While the panel is closed or out of sight, the status bar shows what pi is doing (working, or waiting for an answer); clicking it goes to that tab.

`obsidian://pi-harness?prompt=…` opens the panel with the words in the composer of a new tab, from Shortcuts, Raycast or a link; add `&send=1` to send them, `&note=Folder/Note` to open pi for that note first, or use `?session=<file name>` to open a session.

The toolbar at the top of the panel shows the session name, with buttons for a new session, the session list and a menu. The clock button opens the session list for the vault: search it, move with the arrow keys, Enter to open. Right-click a session (or use its `…` button) to rename, duplicate or move it to the system trash. Unnamed sessions are listed by their first prompt. Rename the session on screen from the `⋮` menu.

### Tabs

The panel can hold several conversations at once. Click the session name to see the open tabs, switch between them, close one, or open a new one. Every tab runs its own pi process on its own session, and a tab that isn't on screen keeps working.

| Mark | Meaning |
|---|---|
| spinner | pi is working (the line below it shows the current task or tool) |
| question mark | pi asked something and is waiting for your answer |
| dot | pi finished while you were in another tab |
| warning triangle | pi stopped unexpectedly |
| moon | restored from the last Obsidian session; its pi starts when you open the tab |

The most pressing of these marks for the tabs you are *not* looking at is also shown beside the session name, so you can tell without opening the list. A question from a background tab also raises a toast; click it to go there.

Every conversation keeps its tab. **New session** (`+`), **New tab** and opening a session from the list all open a tab of their own; the only tab that gets reused is an empty one. Closing a tab stops its pi; the conversation stays in the session list. Obsidian's workspace layout brings the tabs back after a restart.

A session file only ever belongs to one tab: opening a session that another tab holds takes you to that tab, because two pi processes writing one file would corrupt it. The plugin can't see pi running in a terminal, so avoid having the same session open in both at once. **Open another chat panel** (command palette) adds a second panel with tabs of its own, for two conversations side by side.

These are pi's normal session files for the vault directory, so a conversation started here can be resumed in a terminal with `pi --resume`, and the other way round. Renaming goes through pi, which only names the session it has loaded, so renaming another session opens it first. pi does not allow clearing a name over RPC.

## Obsidian tools

pi's usual tools see the vault as files. Some things only the running app knows, and **Settings → Let pi use Obsidian** (on by default) gives pi tools for them:

| Tool | What it does |
| --- | --- |
| `obsidian_note_info` | A note's properties, aliases, tags, headings, the notes it links to, links that point nowhere, and the notes that link to it, straight from Obsidian's metadata cache. |
| `obsidian_tags` | The vault's tags with counts, or the notes carrying one tag. Nested tags count for their parents. |
| `obsidian_set_properties` | Sets or removes properties through Obsidian, which keeps the YAML well-formed and the rest of the note untouched. |
| `obsidian_open` | Shows you a note, optionally at a heading. |
| `obsidian_commands` | Lists the command palette: core commands and those of your plugins, with ids. |
| `obsidian_run_command` | Runs a command by id, as if you had picked it from the palette. |

Running commands is gated by **Commands pi may run**, one id pattern per line (`editor:*`, `app:reload`, or `*` for everything). The list starts empty: pi can see the palette but run nothing until you say so. The other tools only read, except `obsidian_set_properties`, which does what pi could already do by editing the file, only more carefully.

## Web viewer

Obsidian can open web pages in a tab (the Web viewer core plugin). With **Settings → Let pi use the web viewer** switched on, pi can drive it, and you watch it happen:

| Tool | What it does |
| --- | --- |
| `browser_open` | Opens an address in a web viewer tab and waits for it to load. The tab comes to the front of its pane; the keyboard stays in the chat. |
| `browser_read` | The visible text of the page, or of one element, optionally with its links. Without a page of its own, pi reads the web viewer tab you have open. |
| `browser_click` | Clicks by CSS selector, or by the visible text of a link or button, and waits for any navigation. |
| `browser_type` | Types into a field, optionally submitting. |
| `browser_screenshot` | A picture of what the tab shows, which also appears on the tool card. |
| `browser_eval` | Runs JavaScript in the page and returns the result. |

It is off by default, for a reason: the web viewer keeps you logged in to sites, so pi acts there as you, and a page pi reads can contain text written to steer it. Switch it on when you want it.

How it works, for these and the Obsidian tools above: each set is a small pi extension that ships inside the plugin. pi is a child process and the web viewer lives inside Obsidian, so a tool call crosses over on the channel the two already share, a dialog request that the panel recognises and answers itself. No port is opened and nothing else on the machine can reach it.

## Separate from your terminal pi

The panel's pi has a config folder of its own, `~/.pi/harness`, so what you set up for pi in the terminal stays out of your vault unless you want it there. Pi Harness does not populate or update that profile. What crosses over from `~/.pi/agent` is decided under **Settings → Inheritance**, one switch each:

| Switch | Default | What it does |
| --- | --- | --- |
| Logins | on | Links `auth.json`. pi rewrites this file when it refreshes a token, so a link keeps both on the same tokens where a copy would go stale. |
| Custom models | on | Links `models.json`. |
| Default model and settings | on | Copies default provider, model and thinking level, enabled models, compaction and shell prefix, once. Never the package list. After that the panel's pi keeps its own settings. |
| Session history | on | Keeps the vault's sessions in the folder your terminal pi uses, so the history is one list. |
| Vault trust | on | Carries your decision to trust this vault (or a folder above it) in pi. |
| MCP logins | on | Links `mcp-oauth/`, the logins of MCP servers that use OAuth. |
| MCP servers | off | Servers from your global MCP files (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, pi's own `mcp.json`). Off, pi's MCP adapter reads the vault's `.mcp.json` and nothing else. |
| Skills | off | Skills in `~/.agents/skills` and `~/.pi/agent/skills`. pi finds the first of these whatever its config folder is, so the panel names the skills pi may load (installed packages, the vault's `.pi/skills` and `.agents/skills`, the folders in the plugin settings) instead of letting it look. |
| Local extensions | off | Links `extensions/`. |
| Subagents | off | Links `agents/`, for an extension that uses them. |
| Prompt templates | off | Links `prompts/`. |

Switching something off removes the link the plugin made and never touches your own files. Packages you installed with `pi install` are not inherited one by one.

**What the vault has in its own `.pi` folder is not inheritance and still loads**, once you have trusted the vault in pi. That is the place for anything you want in the panel regardless of which Pi profile it uses, such as a login provider. Install it yourself from a terminal opened in the vault folder:

```bash
pi install -l npm:pi-claude-oauth-adapter
```

Logins that depend on a provider package (the credentials are in `auth.json`, but the provider comes from a package) only show up in the panel once that package is installed this way.

Turn **Keep the panel's pi separate** off to have the panel use `~/.pi/agent` as it is, like the terminal does.

## pi extensions the panel is built around

The panel is built around six extensions from [rpiv](https://github.com/juicesharp/rpiv-mono). [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter) makes pi read a vault's `.mcp.json` and provides `/mcp`. Pi Harness runs `pi list` to identify missing packages, but it never installs, removes, or updates them. A copy installed from a local folder or git counts as installed. Without these packages pi still works; the panel just has fewer integrations.

For the full set of integrations, open a terminal in the vault root, review the sources, and run:

```bash
pi install -l npm:@juicesharp/rpiv-advisor
pi install -l npm:@juicesharp/rpiv-args
pi install -l npm:@juicesharp/rpiv-ask-user-question
pi install -l npm:@juicesharp/rpiv-btw
pi install -l npm:@juicesharp/rpiv-todo
pi install -l npm:@juicesharp/rpiv-web-tools
pi install -l npm:pi-mcp-adapter
pi install -l git:github.com/kepano/obsidian-skills
```

These are vault-local installs, so they work whether Pi Harness uses `~/.pi/harness` or shares your terminal Pi profile. Manage updates yourself with Pi's CLI outside Obsidian, then reload pi in the panel with `/reload` or ↻.

**Settings → Extensions → Packages** lists package entries from the panel's Pi profile and the vault's `.pi` folder:

- A switch turns a package off without removing it. It is pi's own kind of off (what `pi config` does): the entry in `settings.json` gets an empty list for every kind of resource, so nothing of it loads. Switching it on again brings back the filters the entry had before.
- Pi Harness has no install, remove, or update buttons. It shows exact terminal commands for recommended packages that are missing.
- Reload pi (↻) to apply a load-filter change. With separation switched off, your terminal Pi's package list is shown read-only.

| Extension | In the panel |
| --- | --- |
| `rpiv-todo` | A live task list pinned above the composer with progress, rebuilt from the session when you reopen it. Each call is a one-line card ("Add tests → in progress"). The clear button hides completed and cancelled tasks from the panel and remembers that per session; the list itself belongs to the extension and only the model can change it, so the model still sees them. |
| `rpiv-ask-user-question` | A question card: header, option rows with descriptions and previews (keys 1–9 pick one), real checkboxes for multi-select, Esc to dismiss. The answers are shown on the tool card afterwards. |
| `rpiv-web-tools` | `web_search` lists its results as links; `web_fetch` shows the page title. |
| `rpiv-advisor` | The advice renders as Markdown on its card, labelled with the advisor model. `/advisor` (or **Set advisor model** in the menu) opens a model and effort picker. |
| `rpiv-btw` | `/btw <question>` answers in a side card without adding anything to the conversation. |
| `rpiv-args` | Nothing to show: it expands `$1`-style arguments in skills before the prompt is sent, which works as is. |

Two of these needed more than styling. `/advisor` and `/btw` draw terminal overlays, which pi cannot show to an RPC client: over RPC `/advisor` does nothing and `/btw` never returns. The panel therefore handles both commands itself. The advisor picker writes the same config file the extension reads (`~/.config/rpiv-advisor/advisor.json`) and restarts pi on the current session so it takes effect. `/btw` runs a separate one-off pi on a temporary fork of the session, with no tools, using the current model; the session file itself is not touched. Unlike the extension's own `/btw`, earlier side questions are remembered per chat tab only, not across sessions.

## Skills

The panel is made for the [Obsidian skills](https://github.com/kepano/obsidian-skills) by Steph Ango. They are his work, so the plugin does not carry a copy. If pi starts without any of them, Pi Harness shows the manual vault-local command `pi install -l git:github.com/kepano/obsidian-skills`. Obsidian skills that pi already finds, for example in the vault's `.pi/skills`, count, so no package is required in that case. Install and update the skills yourself outside Obsidian.

| Skill | For |
| --- | --- |
| `obsidian-markdown` | Wikilinks, embeds, callouts, properties |
| `obsidian-bases` | `.base` files |
| `json-canvas` | `.canvas` files |
| `obsidian-cli` | Driving the running Obsidian app (needs the CLI enabled in Settings → General) |
| `defuddle` | Reading web pages as clean Markdown |

The `obsidian-cli` skill calls an `obsidian` command. The plugin ships its own small launcher for Obsidian's CLI and puts it last on pi's `PATH`, so an `obsidian` command you already have wins.

pi also finds the vault's own skills in `.pi/skills` and `.agents/skills`, and reads `AGENTS.md` / `CLAUDE.md`, once you have trusted the vault in pi. If two skills share a name, pi keeps the first it finds and logs a warning; nothing breaks. Add other folders, such as `.claude/skills`, in the plugin settings.

## Install

Requires [pi](https://github.com/earendil-works/pi) on your machine (`pi --version`) with a provider logged in. For all panel integrations, install the [recommended Pi packages](#pi-extensions-the-panel-is-built-around) manually from the vault root; Pi Harness itself does not install or update dependencies.

**From Obsidian:** Settings → Community plugins → Browse, search for "Pi Harness", install and enable. Until the plugin is listed there, [BRAT](https://github.com/TfTHacker/obsidian42-brat) installs it from this repository's releases.

The launcher for Obsidian's CLI travels inside `main.js` (Obsidian only downloads `main.js`, `manifest.json` and `styles.css`) and is written into the plugin's folder when it loads.

**From source:**

```bash
npm install
npm run build
npm run install:vault            # the vault Obsidian has open, or: -- /path/to/vault
```

The plugin's settings are under Obsidian's Settings → Pi Harness, and one click away from the panel's `⋮` menu → Settings.

Then enable **Pi Harness** under Settings → Community plugins, and open it from the π ribbon icon or the command **Pi Harness: Open chat**.

## Development

```bash
npm run dev         # rebuild on change
npm run test:rpc    # check the pi integration without Obsidian (add `-- --prompt` for the live checks: streaming, sessions, images; two small model calls)
```

Layout: `src/requirements.ts` inspects recommended packages and owns their manual setup commands, `src/view/toolRenderers.ts` holds the per-tool cards, `src/rpc` is the JSONL client for `pi --mode rpc`, `src/view` is the panel, `src/env.ts` recovers the login shell's `PATH` (apps started from the Dock don't get it), and `src/prompt.ts` holds the system prompt and the active-note context block.
