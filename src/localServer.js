// Starts and stops llama.cpp's llama-server for the Local provider, so the packaged
// app works without a terminal. It only ever stops a server it started itself:
// if something already answers on the Base URL (Ollama, LM Studio, a server from
// `npm run local-model`), cue just uses it.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const SERVER_DEFAULTS = {
  binary: '',   // empty = find llama-server on disk / PATH
  model: '~/models/pymaster/Qwen3.5-9B-Q4_K_M.gguf',
  mmproj: '~/models/pymaster/mmproj-F16.gguf',
  ctx: 8192
};

const PID_FILE = () => path.join(app.getPath('userData'), 'llama-server.pid');
const LOG_FILE = () => path.join(app.getPath('userData'), 'llama-server.log');

let child = null;        // ChildProcess we spawned this run
let ownedPid = null;     // pid we own (spawned now, or adopted from a previous run's pid file)
let runningKey = null;   // config the owned server was started with
let state = 'idle';      // idle | starting | ready | external | error | off
let message = '';
let modelLabel = '';
let readyWaiters = [];

const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// "Qwen3.5-9B-Q4_K_M.gguf" -> "Qwen3.5-9B (Q4_K_M)"
function labelFor(model, mmproj) {
  const base = path.basename(model || '', '.gguf');
  const m = /^(.*?)[-.](I?Q\d[\w]*|F16|BF16|F32)$/i.exec(base);
  return (m ? m[1] + ' (' + m[2] + ')' : base) + (mmproj ? ' + vision' : '');
}

function findBinary(configured) {
  const candidates = [configured, '/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'].filter(Boolean).map(expand);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    // GUI apps don't inherit the shell PATH; ask a login shell.
    return execFileSync('/bin/zsh', ['-lc', 'command -v llama-server'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch { return null; }
}

// Only a Base URL on this machine can be served by a process we start.
function localPort(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)) return null;
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return null; }
}

function config(settings) {
  const local = settings.local || {};
  const srv = { ...SERVER_DEFAULTS, ...(local.server || {}) };
  const model = expand(srv.model);
  const mmproj = srv.mmproj && fs.existsSync(expand(srv.mmproj)) ? expand(srv.mmproj) : '';
  const port = localPort(local.baseUrl || 'http://localhost:8080/v1');
  const alias = ((settings.models || {}).local || {}).fast || 'local';
  return { want: settings.provider === 'local' && local.autoStart !== false, port, model, mmproj, ctx: srv.ctx, binary: srv.binary, alias };
}

const keyOf = (c) => JSON.stringify([c.port, c.model, c.mmproj, c.ctx, c.binary]);

async function answers(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/v1/models', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function settle(ok) { const w = readyWaiters; readyWaiters = []; w.forEach((r) => r(ok)); }

function setState(s, msg, notify) {
  state = s; message = msg || '';
  if (notify && msg) notify(msg);
  if (s === 'ready' || s === 'external') settle(true);
  if (s === 'error' || s === 'off' || s === 'idle') settle(false);
}

function readPid() { try { return JSON.parse(fs.readFileSync(PID_FILE(), 'utf8')); } catch { return null; } }
function writePid(pid, key) { try { fs.writeFileSync(PID_FILE(), JSON.stringify({ pid, key })); } catch { /* ignore */ } }
function clearPid() { try { fs.unlinkSync(PID_FILE()); } catch { /* ignore */ } }

function logTail() {
  try { return fs.readFileSync(LOG_FILE(), 'utf8').trim().split('\n').slice(-3).join(' | ').slice(-300); } catch { return ''; }
}

async function waitHealthy(port, pid, notify) {
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    if (ownedPid !== pid) return; // stopped or replaced meanwhile
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        setState('ready', 'Local model ready: ' + modelLabel + ' (' + Math.round((Date.now() - t0) / 1000) + 's)', notify);
        return;
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  setState('error', 'Local model did not become ready in 5 minutes. Log: ' + LOG_FILE(), notify);
}

function start(c, notify) {
  const bin = findBinary(c.binary);
  if (!bin) return setState('error', 'Can\'t auto-start the local model: llama-server not found (brew install llama.cpp, or set its path in Settings).', notify);
  if (!c.model || !fs.existsSync(c.model)) return setState('error', 'Can\'t auto-start the local model: model file not found: ' + c.model, notify);

  const args = ['-m', c.model, '--alias', c.alias, '--host', '127.0.0.1', '--port', String(c.port),
    '-c', String(c.ctx), '-ngl', '99', '--jinja', '-np', '1', '--reasoning', 'off'];
  if (c.mmproj) args.push('--mmproj', c.mmproj, '--image-max-tokens', '1024');
  else args.push('--no-mmproj');

  const log = fs.openSync(LOG_FILE(), 'w');
  child = spawn(bin, args, { stdio: ['ignore', log, log] });
  fs.closeSync(log);
  ownedPid = child.pid;
  runningKey = keyOf(c);
  modelLabel = labelFor(c.model, c.mmproj);
  writePid(child.pid, runningKey);
  setState('starting', 'Starting local model: ' + modelLabel + '…', notify);

  const pid = child.pid;
  child.on('exit', (code, signal) => {
    if (ownedPid !== pid) return; // stopped on purpose, or already replaced by a restart
    child = null; ownedPid = null; runningKey = null; clearPid();
    setState('error', 'Local model stopped (' + (signal || 'exit ' + code) + '). ' + (logTail() || 'Log: ' + LOG_FILE()), notify);
  });
  waitHealthy(c.port, child.pid, notify);
}

function stop() {
  const pid = ownedPid;
  child = null; ownedPid = null; runningKey = null;
  clearPid();
  if (pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

// Bring the server in line with settings. Safe to call on every settings change.
async function sync(settings, notify) {
  const c = config(settings);
  modelLabel = labelFor(c.model, c.mmproj);

  // Adopt a server a previous run of cue started (e.g. after a crash).
  if (!ownedPid) {
    const saved = readPid();
    if (saved && alive(saved.pid) && (await answers(c.port))) {
      ownedPid = saved.pid; runningKey = saved.key;
      setState('ready', 'Local model ready: ' + modelLabel, notify);
    }
    else if (saved) clearPid();
  }

  if (!c.want || !c.port) {
    if (ownedPid) { stop(); setState('off', 'Stopped the local model.', notify); }
    else setState('off', '');
    return;
  }
  if (ownedPid && runningKey === keyOf(c)) return;
  if (ownedPid) { stop(); notify && notify('Restarting the local model with the new settings…'); await new Promise((r) => setTimeout(r, 800)); }
  if (await answers(c.port)) return setState('external', 'Using the model server already running on port ' + c.port + '.', notify);
  start(c, notify);
}

// Resolves true once a server answers (ours or someone else's), false on failure/timeout.
function whenReady(timeoutMs) {
  if (state === 'ready' || state === 'external') return Promise.resolve(true);
  if (state !== 'starting') return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => { readyWaiters = readyWaiters.filter((r) => r !== done); resolve(false); }, timeoutMs);
    const done = (ok) => { clearTimeout(t); resolve(ok); };
    readyWaiters.push(done);
  });
}

function status() { return { state, message, model: modelLabel, owned: !!ownedPid, log: LOG_FILE() }; }

module.exports = { sync, stop, whenReady, status, labelFor, SERVER_DEFAULTS };
