# cc-rename

Auto-names every **[Claude Code](https://claude.com/claude-code)** session from its own
conversation — so you never run `/rename` by hand again.

```
before:   ~/projects/api   (unnamed session)
after:    ~/projects/api   fix-webhook-retry
```

It's a single zero-dependency `UserPromptSubmit` hook. On your first prompt it coins a short
kebab-case title and sets it as the session title — exactly what `/rename` does manually.

## How it works

Claude Code lets a `UserPromptSubmit` hook rename the current session by returning:

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "sessionTitle": "my-title" } }
```

The live title on a running pane is held in Claude Code's **memory**. The only thing that
updates it is a hook emitting `sessionTitle`, and the only such hook that fires during a live
session is `UserPromptSubmit`. A background process can write the roster file but **cannot**
touch the live pane's label. So to rename after the **first** prompt, the hook produces the
title itself, on that fire:

1. **Gate A** — if the session already has a `custom-title` (a manual `/rename` *or* our own
   applied rename), it does nothing. This respects your manual names.
2. On the **first** prompt with real context, the hook generates a 2–4 word title **inline**
   with `claude -p --model haiku` (your **subscription**, not the API) and emits it as
   `sessionTitle`. The pane renames immediately. The naming text is seeded from the `prompt`
   field of the hook payload, since `UserPromptSubmit` fires *before* the prompt reaches the
   transcript.
3. It marks the session `applied` and best-effort writes the roster `name` (so the `/resume`
   list shows it too). Renames **at most once**; never clobbers a manual rename.

This blocks your **first** prompt for a few seconds (while `claude -p` runs) — once per session;
afterwards the hook is instant. If inline generation is slow (it's capped under the hook
timeout) or fails, the hook falls back to a **detached background worker** that caches the name,
and the **next** prompt emits it — so the rename still lands, just one prompt later, and a
slow/cold `claude -p` never breaks your prompt.

Each open window names **itself** from **its own** context; there is no shared/static name, so
one window never renames another. Per-session cache lives in `~/.claude/.cc-rename/`.

### Why per-session, and why those two gates

A global hook runs in **every** open session simultaneously. A naive version that sets a
static or shared title will clobber unrelated windows. cc-rename generates the name from each
session's own `transcript_path`, and the `custom-title` gate guarantees it fires at most once
per session and never overrides a name you set yourself.

### Anti-recursion

The name is produced by spawning `claude -p`, which is itself a Claude session that fires
`UserPromptSubmit` hooks. cc-rename spawns that child with `CC_RENAME_CHILD=1` and exits
immediately whenever it sees that flag, so a child can never spawn a grandchild. Gate B (a
fresh headless session has zero assistant turns) is a second, independent guard.

## Install

Requires Node ≥ 16 and the `claude` CLI on your `PATH`.

```powershell
git clone https://github.com/wpt888/cc-rename.git
cd cc-rename
./install.ps1
```

`install.ps1` backs up `~/.claude/settings.json`, then adds a hook group under
`hooks.UserPromptSubmit` pointing at `auto-rename.js`. It's idempotent (re-running replaces
its own entry, never duplicates) and leaves your other hooks untouched. **Start a new Claude
Code session to activate.**

### Manual install

Add this group to `hooks.UserPromptSubmit` in `~/.claude/settings.json` (keep any existing
groups):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node \"C:/path/to/cc-rename/auto-rename.js\"", "timeout": 30 }
        ]
      }
    ]
  }
}
```

## Uninstall

```powershell
./install.ps1 -Uninstall
```

(or delete the cc-rename group from `hooks.UserPromptSubmit` by hand).

## Notes & tuning

- **Cost** — name generation uses `claude -p --model haiku` on your Max/Pro subscription, not
  the metered API.
- **Latency** — your **first** prompt is held a few seconds while `claude -p` generates the
  name (this is what lets the rename land on that first prompt). It happens once per session;
  every later prompt is instant. If generation runs long, it's capped under the hook timeout and
  falls back to a background worker that applies the name on your next prompt.
- **Debug** — set `CC_RENAME_DEBUG=1` to append a trace to `~/.claude/cc-rename.log`.
- **Safety** — on any failure (model error, timeout, empty output) the hook stays silent and
  exits 0; it never breaks your prompt and simply retries on a later one. A dead background
  worker (`pending` >90 s) auto-restarts generation.

## License

MIT — see [LICENSE](LICENSE).
