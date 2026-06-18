#!/usr/bin/env node
'use strict';

/*
 * cc-rename — auto-names each Claude Code session from its own conversation.
 *
 * This is a `UserPromptSubmit` hook. On every prompt it reads the session's own
 * transcript and, once there is real context, sets a short kebab-case title via
 *   { hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle } }
 * exactly what `/rename` does by hand, but automatic and per-session.
 *
 * NON-BLOCKING by design. A UserPromptSubmit hook BLOCKS the user's prompt until
 * it returns, so it must be fast. Generating a name with `claude -p` takes
 * several seconds (and can exceed the hook timeout on a cold start), so we never
 * do it inline. Instead:
 *
 *   - The hook is a sub-100ms cache read/write. It returns immediately.
 *   - The first time a session has context, the hook spawns a DETACHED worker
 *     (this same file with `--generate`) that runs `claude -p --model haiku` in
 *     the background and writes the name to a per-session cache file. The hook
 *     returns with no output that fire.
 *   - When the worker finishes (~15-20s later) it ALSO writes the name straight
 *     into the session's roster file (~/.claude/sessions/<pid>.json `name`), which
 *     CC reflects in the live UI. So the rename lands after the FIRST prompt — no
 *     second prompt needed. It's a read-merge-write, guarded to only fill an empty
 *     `name`, so a manual /rename is never clobbered.
 *   - On the next prompt, the hook also emits the cached name as the sessionTitle.
 *     This is the durable layer: it writes a `custom-title` transcript entry (the
 *     roster write does not) and marks the session applied, so the rename is
 *     permanent and fires at most once. Zero blocking, no `claude -p` timeout race.
 *
 * Safety / one-shot:
 *   Gate A — if the transcript already has a `custom-title` entry (a manual
 *            /rename OR our own applied rename) we never touch it again.
 *   Cache  — once we emit a title we mark the cache `applied` and stop, so we
 *            rename at most once per session even before CC writes custom-title.
 *
 * Anti-recursion: the worker spawns `claude -p`, itself a Claude session that
 * fires UserPromptSubmit hooks. The worker runs claude with CC_RENAME_CHILD=1
 * and the hook bails instantly on that flag, so a child can never spawn a
 * grandchild.
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

function generateName(userText, assistantText) {
  const prompt = buildPrompt(userText, assistantText);

  let res;
  try {
    res = spawnSync('claude', ['-p', '--model', 'haiku'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 60000, // generous: we're detached, nothing is waiting on us.
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
    // Emit instantly and mark applied so we rename at most once.
    writeCache(file, { status: 'applied', name: cache.name, ts: Date.now() });
    log('emitting sessionTitle:', cache.name);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          sessionTitle: cache.name,
        },
      })
    );
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

  // Store the seed so the detached worker can name from it even if the transcript
  // write is still racing behind us.
  writeCache(file, { status: 'pending', ts: Date.now(), seedPrompt: seed });
  spawnWorker(sessionId, transcriptPath);
  log('started detached generation for', sessionId, '(seeded from', info.firstUserText ? 'transcript)' : 'stdin prompt)');
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
