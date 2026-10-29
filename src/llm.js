// LLM factory — OpenAI / Anthropic / Gemini / Local behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken, onNotice }) -> Promise<fullText>
//
// "local" is any OpenAI-compatible server (llama.cpp llama-server, Ollama, LM Studio,
// vLLM, LocalAI ...). It reuses the OpenAI path with a custom baseURL.

const DEFAULT_LOCAL_URL = 'http://localhost:8080/v1';

// Local servers (llama-server included) close idle keep-alive sockets, and the SDK's
// shared agent then reuses a dead one: every other request fails with ECONNRESET.
// A fresh connection per request costs nothing on localhost.
let localAgents = null;
function localAgent(baseURL) {
  if (!localAgents) localAgents = { http: new (require('http').Agent)({ keepAlive: false }), https: new (require('https').Agent)({ keepAlive: false }) };
  return /^https:/i.test(baseURL) ? localAgents.https : localAgents.http;
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

function localBaseUrl(settings) {
  const url = ((settings.local && settings.local.baseUrl) || DEFAULT_LOCAL_URL).trim();
  return url.replace(/\/+$/, '');
}

async function streamOpenAI({ apiKey, baseURL, httpAgent, maxRetries, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL, httpAgent, maxRetries });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

// Reasoning models served without reasoning extraction put <think>…</think> in the
// content stream. Drop it so the overlay only shows the answer. Tags can be split
// across chunks, so hold back a tail that could be the start of a tag.
function thinkFilter(onToken) {
  const OPEN = '<think>', CLOSE = '</think>';
  let buf = '', inThink = false;
  const partialTail = (s, tag) => {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
    return 0;
  };
  return {
    push(t) {
      buf += t;
      for (;;) {
        if (inThink) {
          const j = buf.indexOf(CLOSE);
          if (j === -1) { buf = buf.slice(buf.length - partialTail(buf, CLOSE)); return; }
          buf = buf.slice(j + CLOSE.length).replace(/^\s+/, '');
          inThink = false;
        } else {
          const i = buf.indexOf(OPEN);
          if (i === -1) {
            const keep = partialTail(buf, OPEN);
            const out = buf.slice(0, buf.length - keep);
            buf = buf.slice(buf.length - keep);
            if (out) onToken(out);
            return;
          }
          if (i > 0) onToken(buf.slice(0, i));
          buf = buf.slice(i + OPEN.length);
          inThink = true;
        }
      }
    },
    flush() { if (!inThink && buf) onToken(buf); buf = ''; }
  };
}

function localError(e, baseURL) {
  const cause = e && (e.cause || {});
  const code = (e && e.code) || cause.code;
  const msg = (e && e.message) || String(e);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return new Error('Can\'t reach the local model at ' + baseURL + '. Start it (npm run local-model) or fix the Base URL in Settings.');
  }
  if (/Connection error|fetch failed/i.test(msg)) {
    return new Error('Lost the connection to the local model at ' + baseURL + (code ? ' (' + code + ')' : '') + '. Check the server log.');
  }
  return e;
}

function looksLikeImageRejection(e) {
  const msg = ((e && e.message) || '').toLowerCase();
  return /image|multimodal|mmproj|vision|image_url/.test(msg);
}

async function streamLocal(args) {
  const { baseURL, imageDataUrl, onToken, onNotice } = args;
  let emitted = false;
  const run = async (img) => {
    const filter = thinkFilter((t) => { emitted = true; onToken(t); });
    // No SDK retries: a refused local connection won't fix itself in a few seconds.
    const full = await streamOpenAI({ ...args, httpAgent: localAgent(baseURL), maxRetries: 0, imageDataUrl: img, onToken: (t) => filter.push(t) });
    filter.flush();
    return full.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  };
  try {
    return await run(imageDataUrl);
  } catch (e) {
    // Text-only models reject image parts. Retry once without the screenshot.
    if (imageDataUrl && !emitted && looksLikeImageRejection(e)) {
      if (onNotice) onNotice('Local model rejected the screenshot — answering from text only. Load a vision model (e.g. with --mmproj) or turn off "Send screenshots" in Settings.');
      try { return await run(null); } catch (e2) { throw localError(e2, baseURL); }
    }
    throw localError(e, baseURL);
  }
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const stream = await ai.models.generateContentStream({
    model, contents, config: { systemInstruction: system, maxOutputTokens: maxTokens }
  });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }
  return full;
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  const isLocal = provider === 'local';
  // Local servers usually ignore the key, but the OpenAI SDK refuses an empty one.
  const apiKey = isLocal ? (keys.local || 'local') : keys[provider];
  const baseURL = isLocal ? localBaseUrl(settings) : undefined;
  const tier = settings.smart ? 'smart' : 'fast';
  const model = ((settings.models || {})[provider] || {})[tier];
  const maxTokens = settings.smart ? 1400 : 700;
  const vision = !isLocal || !settings.local || settings.local.vision !== false;

  return {
    provider, model, apiKey, baseURL, vision,
    ready: !!apiKey && !!model,
    async stream(params) {
      const args = { apiKey, baseURL, model, maxTokens, ...params };
      if (!vision) args.imageDataUrl = null;
      if (provider === 'openai') return streamOpenAI(args);
      if (provider === 'anthropic') return streamAnthropic(args);
      if (provider === 'gemini') return streamGemini(args);
      if (provider === 'local') return streamLocal(args);
      throw new Error('unknown provider: ' + provider);
    }
  };
}

// GET {baseUrl}/models on the local server. Used by the Settings "Test" button.
async function probeLocal(settings) {
  const baseUrl = localBaseUrl(settings);
  const key = (settings.apiKeys && settings.apiKeys.local) || '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(baseUrl + '/models', {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: ctl.signal
    });
    if (!res.ok) return { ok: false, baseUrl, message: 'HTTP ' + res.status + ' from ' + baseUrl + '/models' };
    const body = await res.json();
    const models = ((body && body.data) || []).map((m) => m.id).filter(Boolean);
    return { ok: true, baseUrl, models };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timed out' : ((e && e.cause && e.cause.code) || (e && e.message) || String(e));
    return { ok: false, baseUrl, message: 'Can\'t reach ' + baseUrl + ' (' + msg + ')' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createLLM, probeLocal, thinkFilter, DEFAULT_LOCAL_URL };
