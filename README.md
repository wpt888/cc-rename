# cc-rename

Auto-names every **[Claude Code](https://claude.com/claude-code)** session from its own
conversation — so you never run `/rename` by hand again.

```
before:   ~/projects/api   (unnamed session)
after:    ~/projects/api   fix-webhook-retry
```

It's a single zero-dependency `UserPromptSubmit` hook. A few seconds into a session — once
there's real context — it coins a short kebab-case title and sets it as the session title,
exactly what `/rename` does manually.

## How it works

Claude Code lets a `UserPromptSubmit` hook rename the current session by returning:

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "sessionTitle": "my-title" } }
```

It is **non-blocking** — a `UserPromptSubmit` hook blocks the user's prompt until it returns,
so it must be fast. Generating a name with `claude -p` takes several seconds (and can exceed
the hook timeout on a cold start), so cc-rename never does it inline. Instead it splits the
work across two prompts:

1. Reads **this session's own** transcript (`transcript_path` from the hook payload).
2. **Gate A** — if the transcript already has a `custom-title` entry (a manual `/rename`
   *or* our own applied rename), it does nothing. This respects your manual names.
3. The **first** time the session has real context, it writes a `pending` marker and spawns a
   **detached background worker** that runs `claude -p --model haiku` (your **subscription**,
   not the API) and caches a 2–4 word kebab-case title. The hook returns immediately, with no
   output — your prompt is never blocked (measured ~60–90 ms).
4. On the **next** prompt, the hook finds the cached name and returns it as the `sessionTitle`
   instantly, then marks the session `applied` so it renames **at most once**.

So the rename lands one prompt after the first — with zero blocking and no dependency on
`claude -p` beating a timeout. Each open window names **itself** from **its own** transcript;
there is no shared/static name, so one window never renames another. Per-session cache lives in
`~/.claude/.cc-rename/`.

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
- **Latency** — the hook itself is always near-instant (~60–90 ms); the slow `claude -p` runs
  in a detached background process, so your prompt is never blocked. The rename appears one
  prompt after the first.
- **Debug** — set `CC_RENAME_DEBUG=1` to append a trace to `~/.claude/cc-rename.log`.
- **Safety** — on any failure (model error, timeout, empty output) the hook stays silent and
  exits 0; it never breaks your prompt and simply retries on a later one. A dead background
  worker (`pending` >90 s) auto-restarts generation.

## License

MIT — see [LICENSE](LICENSE).
