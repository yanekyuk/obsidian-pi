# Pi Harness for Obsidian

A chat panel for the [pi coding agent](https://github.com/earendil-works/pi) inside Obsidian. pi runs in the background with your vault as its working directory; the panel is built from Obsidian's own components and theme variables, so it looks like part of the app in any theme.

Desktop only: the plugin starts `pi` as a child process. Developed and used on macOS; Linux should work the same way; Windows is untested. This is a community project, not affiliated with pi's authors or with Obsidian.

## Before you install

This plugin puts a coding agent in your vault. Read this first.

- **pi acts without asking.** It can run shell commands and read, change or delete any file your user account can, in the vault and outside it. That is how pi works in a terminal too; the plugin adds no confirmation step. Text pi reads (a note, a web page it fetched) can contain instructions that steer it, so treat it like any other program you give your shell to. For a read-only agent, put `--tools read,grep,find,ls` in Settings → Extra arguments. Keep backups of your vault.
- **Your notes leave your machine.** Whatever pi reads, plus the active note and selection when the note chip is on, is sent to the model provider you configured in pi. The plugin itself sends nothing anywhere and has no telemetry.
- **Network use.** pi talks to your model provider and to whatever its tools reach (web search and fetch, MCP servers). The plugin makes two kinds of requests of its own: a local MCP `initialize` to the HTTP servers listed in the vault's `.mcp.json`, to warn you when one is down, and, only if you opt in, `pi install` / `pi update`, which download packages from npm and GitHub.
- **Code from npm and GitHub, only if you say yes.** The panel works best with six third-party pi extensions and Steph Ango's Obsidian skills. The first time they are missing, the panel asks whether to install them; daily `pi update --all` is a separate switch that is off by default. Both are under Settings → Extensions.
- **Files outside the vault.** pi keeps sessions under `~/.pi/agent/sessions`; "Move to trash" in the session list moves such a file to the system trash. Choosing an advisor model writes `~/.config/rpiv-advisor/advisor.json`. To find `pi` when Obsidian was started from the Dock, the plugin asks your login shell for its `PATH`.

## What it does

- Streams replies as Obsidian Markdown. Wikilinks in replies are clickable and show hover previews.
- Markdown renders everywhere the model's words appear, not only in replies: question cards (options, descriptions), the task list, queued messages, side questions and the answers shown on question cards. Links in those places work too.
- Shows thinking and tool calls as collapsible blocks. Edits render as diffs. A file path on a card has an open button: vault files open in Obsidian (Cmd-click for a new tab), anything else opens in the system's default app. Image paths also get a button that shows the picture inside the card, and pictures a tool returns appear under its output.
- Shares the active note and your selection with pi. Click the note chip in the composer to turn that off for a message.
- Paste or drop images into the composer. They are scaled to 2000px at most, the bound pi uses for images it reads itself, and show up in the transcript.
- `/` completes pi commands, prompt templates and skills. `@` completes notes as wikilinks.
- While pi is working, Enter (or the send button) steers: pi reads the message before its next step. Alt+Enter (or the queue button that appears beside send) queues it for when pi has finished. Waiting messages are listed above the composer as **Next** and **After**; the ↶ button on the list takes them back into the editor, and Esc stops pi and does the same.
- Messages sent while pi is compacting are held and go out when compaction ends, in order. pi itself refuses prompts during compaction; its terminal UI holds them the same way.
- Switch model and thinking level from the composer. The context reading beside them has a compact button; `/compact` does the same, and `/compact <what to keep>` steers the summary.
- `/reload`, or the ↻ button (in the toolbar, and on each row of the tab list), reloads extensions, skills, prompt templates, context files and settings without losing the conversation. pi's own `/reload` exists only in its terminal UI and RPC has no command for it, so the panel restarts pi on the same session, which picks up the same things. It acts on the tab on screen and waits if pi is working there.
- Questions from pi extensions are answered in a card above the composer, not in a popup. Notifications and widgets show up in the panel too. The footer status text extensions write for pi's terminal ("MCP: 1 server enabled") is left out; the line above the composer only says what pi is doing.
- Connects the vault's MCP servers when pi starts. pi's MCP adapter is lazy, so a fresh pi lists them as "disconnected (0 tools)" until something uses one; the panel runs `/mcp reconnect <name>` for each HTTP server in the vault's `.mcp.json` that is up. Turn it off under Settings → Extensions.
- Output from extension commands (`/mcp`, `/todos`) appears in the transcript under the command you typed, instead of in a toast. Only short one-line remarks stay toasts. This output is not part of the session, so it is gone after a reload.
- Warns when an HTTP MCP server in the vault's `.mcp.json` is unavailable, such as the one from the Vault as MCP plugin. pi's MCP adapter connects lazily and reports "enabled" either way, so the panel sends each server a real MCP `initialize` when pi starts and at most every 30 seconds as runs begin. Click the warning to check again.

## Sessions

The toolbar at the top of the panel shows the session name, with buttons for a new session, the session list and a menu. The clock button opens the session list for the vault: search it, move with the arrow keys, Enter to open. Right-click a session (or use its `…` button) to open it in a new tab, rename, duplicate or move it to the system trash. Unnamed sessions are listed by their first prompt. Rename the session on screen from the `⋮` menu.

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

Starting something new never interrupts pi. **New session** (`+`) and opening a session from the list reuse the tab on screen when it is idle, and open a tab beside it when pi is busy there or waiting for an answer. **New tab** (in the tab list, the `⋮` menu or the command palette) always keeps the current conversation open. Closing a tab stops its pi; the conversation stays in the session list. Obsidian's workspace layout brings the tabs back after a restart.

A session file only ever belongs to one tab: opening a session that another tab holds takes you to that tab, because two pi processes writing one file would corrupt it. The plugin can't see pi running in a terminal, so avoid having the same session open in both at once. **Open another chat panel** (command palette) adds a second panel with tabs of its own, for two conversations side by side.

These are pi's normal session files for the vault directory, so a conversation started here can be resumed in a terminal with `pi --resume`, and the other way round. Renaming goes through pi, which only names the session it has loaded, so renaming another session opens it first. pi does not allow clearing a name over RPC.

## pi extensions the panel is built around

The panel is built around six extensions from [rpiv](https://github.com/juicesharp/rpiv-mono). When some are missing, the panel asks once whether to install them. If you agree, the plugin checks `pi list` before pi starts and installs what is missing with `pi install npm:@juicesharp/<name>` (user scope, `~/.pi/agent/npm`, the same copies a terminal pi uses). A copy installed from a local folder or git counts as installed. Without them pi still works; the panel just has less to show. If you also turn on **Keep pi up to date**, once a day the plugin runs `pi update --all`, which updates pi itself and every installed package, not only these six. It waits until pi is idle in every tab, because the update replaces pi's files. When something changed you get a toast listing the new versions; click it to reload pi in the idle tabs, or use `/reload` or the ↻ button later. A running pi keeps the old code until then. Both switches are under Settings → Extensions, where you can also see what is installed and update on demand. Being offline only produces a notice; pi still starts.

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

The panel is made for the [Obsidian skills](https://github.com/kepano/obsidian-skills) by Steph Ango. They are his work, so the plugin does not carry a copy: when pi has started and none of them are loaded, the plugin installs them from his repository with `pi install git:github.com/kepano/obsidian-skills` (part of the same one-time question as the extensions). `pi update --all` keeps them current along with everything else, and the update toast names the new commit. Obsidian skills that pi already finds, for example in the vault's `.pi/skills`, count, and then nothing is installed.

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

Requires [pi](https://github.com/earendil-works/pi) on your machine (`pi --version`) with a provider logged in.

**From Obsidian:** Settings → Community plugins → Browse, search for "Pi Harness", install and enable. Until the plugin is listed there, [BRAT](https://github.com/TfTHacker/obsidian42-brat) installs it from this repository's releases.

The launcher for Obsidian's CLI travels inside `main.js` (Obsidian only downloads `main.js`, `manifest.json` and `styles.css`) and is written into the plugin's folder when it loads.

**From source:**

```bash
npm install
npm run build
npm run install:vault            # the vault Obsidian has open, or: -- /path/to/vault
```

Then enable **Pi Harness** under Settings → Community plugins, and open it from the π ribbon icon or the command **Pi Harness: Open chat**.

## Development

```bash
npm run dev         # rebuild on change
npm run test:rpc    # check the pi integration without Obsidian (add `-- --prompt` for the live checks: streaming, sessions, images; two small model calls)
```

Layout: `src/requirements.ts` manages the required extensions, `src/view/toolRenderers.ts` holds the per-tool cards, `src/rpc` is the JSONL client for `pi --mode rpc`, `src/view` is the panel, `src/env.ts` recovers the login shell's `PATH` (apps started from the Dock don't get it), and `src/prompt.ts` holds the system prompt and the active-note context block.
