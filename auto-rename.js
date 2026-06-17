#!/usr/bin/env node
'use strict';

/*
 * cc-rename — auto-names each Claude Code session.
 *
 * This is a `UserPromptSubmit` hook. On every prompt it reads the session's own
 * transcript and, once there is real conversation context, asks a fast model to
 * coin a short kebab-case title, then returns it via
 *   { hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle } }
 * which Claude Code uses to rename the session — exactly what `/rename` does by
 * hand, but automatic and per-session.
 *
 * Two mandatory gates keep it safe and one-shot:
 *   Gate A — if the transcript already contains a `custom-title` entry (a manual
 *            /rename OR our own prior rename) we never touch it again. This makes
 *            the hook self-disabling after the first success and respects the user.
 *   Gate B — only act once at least one assistant response exists, so the title
 *            is generated from meaningful context (and a brand-new headless child
 *            session — see anti-recursion below — has none, so it self-skips).
 *
 * Anti-recursion: the name is produced by spawning `claude -p --model haiku`,
 * which is itself a Claude session that fires UserPromptSubmit hooks. We spawn it
 * with CC_RENAME_CHILD=1 and bail immediately when we see that flag, so the child
 * can never spawn a grandchild. Gate B is a second, independent guard.
 *
 * Zero dependencies. Reads stdin JSON (the hook contract), writes JSON to stdout
 * only when it actually sets a title; otherwise it stays silent and exits 0 so it
 * never injects spurious context or breaks the prompt.
 *
 * Debug: set CC_RENAME_DEBUG=1 to append a trace to ~/.claude/cc-rename.log.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEBUG = process.env.CC_RENAME_DEBUG === '1';
const LOG_PATH = path.join(os.homedir(), '.claude', 'cc-rename.log');

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
// of content blocks ({ type, text }, tool_result, etc.).
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

// Scan the JSONL transcript once and return the few facts the gates need.
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
      if (!out.firstUserText) {
        const text = extractText(obj.message && obj.message.content).trim();
        if (text) out.firstUserText = text;
      }
    } else if (obj.type === 'assistant') {
      out.assistantCount += 1;
      if (!out.firstAssistantText) {
        const text = extractText(obj.message && obj.message.content).trim();
        if (text) out.firstAssistantText = text;
      }
    }
  }

  return out;
}

// ---- name generation --------------------------------------------------------

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

// Normalize whatever the model returns into a safe kebab-case slug.
// Returns '' when nothing usable remains (caller then stays silent and retries
// on the next prompt, since no custom-title has been written yet).
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
      timeout: 25000,
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

// ---- main -------------------------------------------------------------------

function main() {
  // Anti-recursion: a name-generating child must never rename anything itself.
  if (process.env.CC_RENAME_CHILD === '1') return;

  let data = {};
  try {
    data = JSON.parse(readStdin().replace(/^﻿/, '') || '{}');
  } catch (_) {
    data = {};
  }

  const transcriptPath = data.transcript_path;
  if (!transcriptPath) {
    log('no transcript_path; skip');
    return;
  }

  const info = analyzeTranscript(transcriptPath);

  // Gate A — already named (manual /rename or our own prior rename): never touch.
  if (info.hasCustomTitle) {
    log('gate A: already has custom-title; skip');
    return;
  }

  // Gate B — need at least one assistant response for meaningful context.
  if (info.assistantCount < 1) {
    log('gate B: no assistant context yet; skip');
    return;
  }

  if (!info.firstUserText) {
    log('no user text found; skip');
    return;
  }

  const name = generateName(info.firstUserText, info.firstAssistantText);
  if (!name) {
    log('empty name; skip (will retry next prompt)');
    return;
  }

  log('setting sessionTitle:', name);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        sessionTitle: name,
      },
    })
  );
}

main();
