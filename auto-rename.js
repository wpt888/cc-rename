#!/usr/bin/env node
'use strict';

/*
 * cc-rename — auto-names each Claude Code session from its own conversation.
 *
 * This is a `UserPromptSubmit` hook. On the first prompt it reads the session's
 * own context and sets a short kebab-case title via
 *   { hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle } }
 * exactly what `/rename` does by hand, but automatic and per-session.
 *
 * WHY THE HOOK GENERATES THE NAME INLINE. The live title shown on a running pane
 * is held in Claude Code's MEMORY. The only channel that updates it is a hook
 * emitting `sessionTitle` — and the only such hook that fires during a live
 * session is `UserPromptSubmit`. An external process (e.g. a background worker)
 * can write the roster file `~/.claude/sessions/<pid>.json`, which updates the
 * /resume list, but it CANNOT touch the live pane's label. So to rename after the
 * very FIRST prompt, the hook must produce the title itself, that fire.
 *
 * Flow:
 *   - On the first prompt with real context, the hook generates the name inline
 *     with `claude -p --model haiku` (your SUBSCRIPTION, not the API) and emits it
 *     as `sessionTitle`. The pane renames immediately. The naming text is seeded
 *     from the `prompt` field of the hook's stdin payload, because UserPromptSubmit
 *     fires BEFORE the prompt is written to the transcript. This blocks the first
 *     prompt for a few seconds — ONCE per session; afterwards the hook is instant.
 *   - Fallback: if inline generation is too slow (it's capped under the hook
 *     timeout) or fails, the hook spawns a DETACHED worker that caches the name in
 *     the background; the NEXT prompt's hook emits it. So the rename still lands,
 *     just one prompt later, and a slow/cold `claude -p` never breaks your prompt.
 *   - Either path also writes the roster `name` (best-effort, guarded to only fill
 *     an empty name) so the /resume list shows it too, across CC versions.
 *
 * Safety / one-shot:
 *   Gate A — if the transcript already has a `custom-title` entry (a manual
 *            /rename OR our own applied rename) we never touch it again.
 *   Cache  — once we emit a title we mark the cache `applied` and stop, so we
 *            rename at most once per session even before CC writes custom-title.
 *
 * Anti-recursion: naming spawns `claude -p`, itself a Claude session that fires
 * UserPromptSubmit hooks. We run that child with CC_RENAME_CHILD=1 and the hook
 * bails instantly on that flag, so a naming child can never spawn a grandchild —
 * whether the parent is the inline hook or the detached worker.
 *
 * Zero dependencies. Debug: set CC_RENAME_DEBUG=1 to trace to ~/.claude/cc-rename.log.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'cc-rename.log');
// Debug activates via env OR a flag file (the flag works inside the live hook,
// where setting an env var is awkward): touch ~/.claude/.cc-rename-debug
const DEBUG =
  process.env.CC_RENAME_DEBUG === '1' || fs.existsSync(path.join(HOME, '.claude', '.cc-rename-debug'));
const CACHE_DIR = path.join(HOME, '.claude', '.cc-rename');
const PENDING_STALE_MS = 90 * 1000; // a worker that hasn't finished in 90s is dead; retry.
// Synchronous in-hook generation budget. The hook is configured with a 30s
// timeout; we cap `claude -p` well below that so a slow/cold run still leaves time
// to fall back to the detached worker before CC kills the hook — and so the first
// prompt never blocks for an unreasonable stretch. This blocks the FIRST prompt
// only (then the session is `applied`/`pending` and the hook stays instant).
const SYNC_GEN_TIMEOUT_MS = 15 * 1000;

function log(...parts) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch (_) {
    /* never let logging break the hook */
  }
}

// ---- stdin ------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

// ---- transcript analysis ----------------------------------------------------

// Pull plain text out of a message `content` that may be a string or an array
// of content blocks ({ type, text }, thinking, tool_result, etc.). Only real
// text blocks contribute — thinking/tool blocks have no `text` and are ignored.
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

// The first `user` entry is frequently NOT the user's intent — it's an injected
// wrapper (slash-command caveats, system reminders, command stdout). Strip those
// blocks so the title reflects the real request, not boilerplate. What survives
// for a slash command (e.g. the /goal name + args) is genuine signal, so we keep
// tag *contents* and only drop the noise blocks and the tags themselves.
function cleanUserText(text) {
  let s = String(text);
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ');
  s = s.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ');
  s = s.replace(/<\/?[a-z][a-z0-9-]*>/gi, ' '); // drop remaining tags, keep their text
  return s.replace(/\s+/g, ' ').trim();
}

// Scan the JSONL transcript once and return the few facts we need.
function analyzeTranscript(transcriptPath) {
  const out = {
    hasCustomTitle: false,
    assistantCount: 0,
    firstUserText: '',
    firstAssistantText: '',
  };

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (e) {
    log('cannot read transcript', transcriptPath, e && e.message);
    return out;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'custom-title') {
      out.hasCustomTitle = true;
      continue;
    }

    if (obj.type === 'user') {
      // Keep scanning until we find a user turn with substantive intent (not a
      // pure caveat/reminder wrapper). 12 chars filters out empty/noise turns.
      if (!out.firstUserText) {
        const text = cleanUserText(extractText(obj.message && obj.message.content));
        if (text.length >= 12) out.firstUserText = text;
      }
    } else if (obj.type === 'assistant') {
      out.assistantCount += 1;
      if (!out.firstAssistantText) {
        const text = extractText(obj.message && obj.message.content).replace(/\s+/g, ' ').trim();
        if (text) out.firstAssistantText = text;
      }
    }
  }

  return out;
}

// ---- name generation (runs only in the detached worker) ---------------------

function buildPrompt(userText, assistantText) {
  const u = userText.slice(0, 1500);
  const a = assistantText.slice(0, 800);
  return [
    'You are naming a Claude Code coding session for a sidebar list.',
    'Read the start of the conversation and produce a short, specific title.',
    '',
    'Rules:',
    '- Output ONLY the title, nothing else (no quotes, no explanation, no trailing period).',
    '- 2 to 4 words, kebab-case (lowercase words joined by single hyphens).',
    '- Describe the concrete task or topic, not generic words like "session", "chat" or "help".',
    '- Examples: fix-login-redirect, add-csv-export, refactor-auth-flow, debug-imap-sync',
    '',
    '--- conversation start ---',
    'USER: ' + u,
    assistantText ? 'ASSISTANT: ' + a : '',
    '--- end ---',
    '',
    'Title:',
  ]
    .filter(Boolean)
    .join('\n');
}

// Normalize whatever the model returns into a safe kebab-case slug ('' if none).
function sanitize(raw) {
  let s = String(raw).replace(/^﻿/, '').trim();
  s = (s.split(/\r?\n/).find((l) => l.trim()) || '').trim();
  s = s.toLowerCase();
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  const words = s.split('-').filter(Boolean).slice(0, 5);
  s = words.join('-');
  if (s.length > 50) s = s.slice(0, 50).replace(/-+$/g, '');
  return s;
}

function generateName(userText, assistantText, timeoutMs) {
  const prompt = buildPrompt(userText, assistantText);

  let res;
  try {
    res = spawnSync('claude', ['-p', '--model', 'haiku'], {
      input: prompt,
      encoding: 'utf8',
      timeout: timeoutMs || 60000, // detached worker: generous. Hook (sync): bounded.
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      // shell:true is required on Windows to invoke claude.cmd (Node refuses to
      // spawn .cmd/.bat without it). The prompt goes via stdin, so there are no
      // user-controlled argv tokens to quote — only static literals.
      shell: true,
      env: Object.assign({}, process.env, { CC_RENAME_CHILD: '1' }),
    });
  } catch (e) {
    log('spawn threw', e && e.message);
    return '';
  }

  if (res.error) {
    log('spawn error', res.error.message);
    return '';
  }
  if (res.status !== 0) {
    log('claude exit', res.status, String(res.stderr || '').slice(0, 200));
    return '';
  }

  return sanitize(res.stdout || '');
}

// ---- per-session cache ------------------------------------------------------

function cacheFileFor(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, safe + '.json');
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCache(file, obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
    return true;
  } catch (e) {
    log('cache write failed', e && e.message);
    return false;
  }
}

function removeCache(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* already gone */
  }
}

// ---- roster apply (best-effort early rename, no 2nd prompt needed) -----------

// Claude Code keeps a per-process "roster" file at ~/.claude/sessions/<pid>.json
// whose `name` field is the title shown in the session list/tab. The hook's
// official apply path emits `sessionTitle` on the NEXT prompt; that's durable
// (CC also writes a `custom-title` transcript entry) but it needs a 2nd prompt.
// To make the rename land after the FIRST prompt, the detached worker also
// writes `name` straight into the roster here — a read-merge-write that keeps
// every existing field and only fills `name` when it's empty (never clobbering a
// manual /rename). This is purely additive: if CC ignores external roster writes
// on a given version, the fire-2 sessionTitle path still applies the same name.
function applyToRoster(sessionId, name) {
  const dir = path.join(HOME, '.claude', 'sessions');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    log('roster dir unreadable', e && e.message);
    return false;
  }

  for (const f of files) {
    const full = path.join(dir, f);
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (_) {
      continue; // skip unreadable/partial roster files
    }
    if (!obj || obj.sessionId !== sessionId) continue;

    if (obj.name) {
      log('roster already named (', obj.name, '); not clobbering', f);
      return false; // manual rename or already applied — leave it.
    }

    obj.name = name; // merge: every other field is preserved.
    try {
      fs.writeFileSync(full, JSON.stringify(obj));
      log('roster applied name:', name, 'to', f, 'for', sessionId);
      return true;
    } catch (e) {
      log('roster write failed', f, e && e.message);
      return false;
    }
  }

  log('no roster file matched sessionId', sessionId);
  return false;
}

// ---- detached worker: generate the name and cache it ------------------------

function runGenerator(sessionId, transcriptPath) {
  const file = cacheFileFor(sessionId);
  const info = analyzeTranscript(transcriptPath);
  const cache = readCache(file);
  // Seed captured by the hook at fire time (the prompt the user just typed).
  // UserPromptSubmit fires BEFORE the prompt is in the transcript, so on the
  // first prompt this seed is the only text we have to name from.
  const seed = (cache && cache.seedPrompt) || '';

  if (info.hasCustomTitle) {
    // User renamed (or we already did) while we were starting — stand down.
    removeCache(file);
    return;
  }

  const userText = info.firstUserText || seed;
  if (!userText) {
    removeCache(file); // nothing to name yet; let a later fire restart us.
    return;
  }

  const name = generateName(userText, info.firstAssistantText);
  if (name) {
    writeCache(file, { status: 'ready', name: name, ts: Date.now() });
    log('worker cached name:', name, 'for', sessionId);
    // Best-effort early apply so the rename lands after the FIRST prompt. The
    // cache stays `ready` (not `applied`) on purpose: the next-prompt hook still
    // emits sessionTitle, which writes the durable custom-title transcript entry.
    applyToRoster(sessionId, name);
  } else {
    removeCache(file); // failed; a later fire will restart generation.
    log('worker produced no name for', sessionId);
  }
}

// Launch the worker fully detached so the hook returns instantly.
function spawnWorker(sessionId, transcriptPath) {
  try {
    const child = spawn(process.execPath, [__filename, '--generate', sessionId, transcriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (e) {
    log('failed to spawn worker', e && e.message);
    return false;
  }
}

// ---- hook mode --------------------------------------------------------------

// Tell Claude Code to set the live session title. This is the ONLY channel that
// updates the in-memory title shown on a running pane — an external roster write
// updates the /resume list but not the live label. Marks the cache `applied` so
// we never rename twice, and best-effort fills the roster for cross-version cover.
function applyName(file, sessionId, name) {
  writeCache(file, { status: 'applied', name: name, ts: Date.now() });
  applyToRoster(sessionId, name);
  log('emitting sessionTitle:', name);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        sessionTitle: name,
      },
    })
  );
}

function runHook() {
  let data = {};
  try {
    data = JSON.parse(readStdin().replace(/^﻿/, '') || '{}');
  } catch (_) {
    data = {};
  }

  if (DEBUG) log('hook fired; stdin keys = [' + Object.keys(data).join(', ') + ']');

  // Field names defensively: Claude Code has used snake_case; accept variants.
  const transcriptPath = data.transcript_path || data.transcriptPath;
  const sessionId = data.session_id || data.sessionId;
  if (!transcriptPath || !sessionId) {
    log('missing transcript_path or session_id; skip. keys=[' + Object.keys(data).join(', ') + ']');
    return;
  }

  const info = analyzeTranscript(transcriptPath);

  // Gate A — already named (manual /rename or our own applied rename): never touch.
  if (info.hasCustomTitle) {
    log('gate A: already has custom-title; skip');
    return;
  }

  const file = cacheFileFor(sessionId);
  const cache = readCache(file);

  if (cache && cache.status === 'applied') {
    log('already applied this session; skip');
    return;
  }

  if (cache && cache.status === 'ready' && cache.name) {
    // A prior detached worker finished — emit instantly (no blocking this fire).
    applyName(file, sessionId, cache.name);
    return;
  }

  if (cache && cache.status === 'pending') {
    if (Date.now() - (cache.ts || 0) < PENDING_STALE_MS) {
      log('generation pending; wait');
      return;
    }
    log('stale pending; restarting generation');
    // fall through to restart
  }

  // Seed from the just-typed prompt (stdin) when the transcript has no user text
  // yet. UserPromptSubmit fires BEFORE the prompt is appended to the transcript,
  // so on the FIRST prompt info.firstUserText is empty — without this seed,
  // generation wouldn't start until the SECOND prompt and a single-prompt session
  // would never get named.
  const stdinSeed = cleanUserText(extractText(data.prompt));
  const seed = info.firstUserText || (stdinSeed.length >= 12 ? stdinSeed : '');

  // No usable text yet: wait for a later fire.
  if (!seed) {
    log('no substantive user text yet; wait');
    return;
  }

  // Claim the slot BEFORE the (multi-second, blocking) inline generation. If the
  // user fires another prompt while this one is still generating, that fire sees
  // `pending` and waits instead of launching a second redundant `claude -p`. The
  // seed is stored so the detached worker can name from it if we fall back.
  writeCache(file, { status: 'pending', ts: Date.now(), seedPrompt: seed });

  // Synchronous-first: try to generate the name inline and apply it THIS fire, so
  // the rename lands after the very first prompt (the live pane title can only be
  // set via this hook's sessionTitle output — no external process can update it).
  // This blocks the first prompt for a few seconds, once per session. If it's too
  // slow or fails, fall back to the non-blocking detached worker so the rename
  // still lands on the next prompt.
  log('synchronous generation for', sessionId, '(seeded from', info.firstUserText ? 'transcript)' : 'stdin prompt)');
  const name = generateName(seed, info.firstAssistantText, SYNC_GEN_TIMEOUT_MS);
  if (name) {
    applyName(file, sessionId, name);
    return;
  }

  // Inline generation didn't make it — hand off to the detached worker. The
  // `pending` marker is already written above; the worker caches a `ready` name
  // and the next prompt's hook emits it.
  log('inline generation missed; falling back to detached worker for', sessionId);
  spawnWorker(sessionId, transcriptPath);
}

// ---- entry ------------------------------------------------------------------

function main() {
  // Detached worker mode: `node auto-rename.js --generate <sessionId> <transcript>`.
  const gi = process.argv.indexOf('--generate');
  if (gi !== -1) {
    runGenerator(process.argv[gi + 1], process.argv[gi + 2]);
    return;
  }

  // Hook mode. Anti-recursion: a name-generating child must never rename anything.
  if (process.env.CC_RENAME_CHILD === '1') return;

  runHook();
}

main();
