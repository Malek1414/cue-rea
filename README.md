# cue (rea)

A rebuilt copy of **cue 0.1.0** (`/Applications/cue.app`, GPL-3.0-or-later): a macOS overlay that sends your screen, mic and system audio to an LLM. The code was taken from the shipped app (it ships unpacked in `Contents/Resources/app`) after an REA analysis. On top of that, this build adds a **Local** provider. It lets you point cue at a model running on your own Mac.

## Quick start

```sh
npm install
npm run local-model   # llama-server: Qwen3.5-9B + vision projector on http://127.0.0.1:8080/v1
npm start             # in a second terminal
```

Local is the default provider. Open Settings (`⋯` or `⌘,`) → **Local** → **Test connection**. You should see `Connected · qwen3.5-9b`.

`npm run start:debug` turns off content protection, so the window shows up in screenshots and screen shares.

## The local endpoint

Local works with **any OpenAI-compatible server**. Settings → Local:

| Field | What it does |
|---|---|
| Base URL | The server's `/v1` root. `/chat/completions` and `/models` are called under it. |
| API key | Optional. It's sent as `Bearer <key>` (most local servers ignore it). |
| Screenshots | Whether to attach the screen to Assist/Ask/LeetCode. This needs a vision model. If the model rejects the image, cue retries once without it and tells you. |
| Fast / Smart models | The model names the server answers to. Fast is used with Smart off and gets 700 max tokens; Smart is used with Smart on and gets 1400. |
| STT URL / model | Optional. A local `/audio/transcriptions` server for the listening features. If set, it's tried before the OpenAI and Gemini keys. |

Common Base URLs:

- **llama.cpp** `llama-server`: `http://localhost:8080/v1`. The model name is its `--alias`.
- **Ollama**: `http://localhost:11434/v1`. The model name is the tag, e.g. `qwen2.5vl:7b`.
- **LM Studio**: `http://localhost:1234/v1`
- **vLLM**: `http://localhost:8000/v1`

The local path also handles a few things for you:
- It strips `<think>…</think>` blocks from reasoning models, even when a tag is split across stream chunks.
- It downscales screenshots to 1280 px wide (`local.maxImageWidth`).
- It makes a fresh connection per request. llama-server drops idle keep-alive sockets, which otherwise fails every second request with `ECONNRESET`.
- It gives a plain message when the server is down.

### `npm run local-model`

This runs `scripts/start-local-model.sh`. Override it with environment variables:

```sh
CUE_MODEL=~/models/other.gguf CUE_MMPROJ= CUE_PORT=8081 CUE_ALIAS=other CUE_CTX=8192 npm run local-model
```

`CUE_MMPROJ=` (empty) runs text-only. In that case, untick Screenshots in Settings. The script binds to 127.0.0.1, runs one slot (`-np 1`, since cue sends one request at a time), and turns reasoning off so answers start streaming immediately.

### Local speech-to-text (not tested here)

Any server that serves the OpenAI `/v1/audio/transcriptions` route works, for example:

- whisper.cpp: `whisper-server -m ggml-base.en.bin --port 8178 --inference-path /v1/audio/transcriptions` → STT URL `http://localhost:8178/v1`
- speaches (faster-whisper): STT URL `http://localhost:8000/v1`, STT model e.g. `Systran/faster-whisper-base.en`

## Speed on this Mac

These numbers are from an Apple M2 with 24 GB RAM, Qwen3.5-9B Q4_K_M, and about 14 GB of swap already in use:
- A typed question without a screenshot answered in about 13 s.
- A question with a 1280 px screenshot took about 45 s to the first token. Encoding the image alone took about 28 s.

Most of that is memory pressure: generation ran at about 3 tokens a second, where this chip normally gets 12–15. To make it faster, free some RAM, use a smaller vision model, or untick Screenshots.

## Running next to the original cue

Both apps register ⌘↵, ⌘H and ⌘⇧X. If the original cue already holds them, this build shows a status line saying so. Quit the original cue while you use this one. Settings are stored separately: `~/Library/Application Support/cue (rea)/cue-data.json`.

## Tests

```sh
npm test                                         # mock OpenAI-compatible server, 9 tests
CUE_LIVE_URL=http://127.0.0.1:8080/v1 npm test   # also runs one live request against your model
```

## License

GPL-3.0-or-later, the same as upstream cue. See `LICENSE`. The changes from upstream are in git history (the first commit is the unmodified 0.1.0 source).
