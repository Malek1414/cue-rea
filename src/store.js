// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

const DEFAULTS = {
  provider: 'local', // this build's reason to exist; switch in Settings
  smart: false,
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', local: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' },
    // Model names your local server answers to (llama-server: its --alias).
    local: { fast: 'qwen3.5-9b', smart: 'qwen3.5-9b' }
  },
  // Any OpenAI-compatible server: llama.cpp :8080/v1, Ollama :11434/v1, LM Studio :1234/v1.
  local: {
    baseUrl: 'http://localhost:8080/v1',
    vision: true,       // send screenshots; needs a vision model (llama-server --mmproj)
    maxImageWidth: 1280, // screenshots are downscaled to this width for local models
    sttBaseUrl: '',     // optional OpenAI-compatible /audio/transcriptions server for listening
    sttModel: 'whisper-1',
    autoStart: true,    // launch llama-server with cue (and stop it on quit) if nothing answers on Base URL
    server: {
      binary: '',       // empty = find llama-server (Homebrew, /usr/local, login-shell PATH)
      model: '~/models/pymaster/Qwen3.5-9B-Q4_K_M.gguf',
      mmproj: '~/models/pymaster/mmproj-F16.gguf', // vision projector; empty = text-only
      ctx: 8192
    }
  }
};

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function load() {
  if (data) return data;
  try { data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch { data = deepMerge(DEFAULTS, {}); }
  return data;
}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ } }

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; }
};
