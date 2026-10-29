# cue (rea)

A rebuilt copy of **cue 0.1.0** (`/Applications/cue.app`, GPL-3.0-or-later): a macOS overlay that sends your screen, mic and system audio to an LLM. The code was taken from the shipped app (it ships unpacked in `Contents/Resources/app`) after an REA analysis. On top of that, this build adds a **Local** provider. It lets you point cue at a model running on your own Mac.

## Install

```sh
npm install
npm run install-app   # builds dist/cue (rea)-darwin-arm64/cue (rea).app, signs it ad-hoc, copies it to /Applications
```

Then open **cue (rea)** from `/Applications`. It runs as a menu-bar-style overlay with no Dock icon, like the original. Press ⌘K to hide it and ⌘K again to bring it back; it keeps running (and listening, if you started capture) while hidden. Quit it with ⌘⇧X.

## Moving it

Drag the top pill to move cue. You can grab it anywhere, buttons included: a press that doesn't move still clicks the button. Double-click the ⋮⋮ grip at the pill's right end to put it back at the top center. cue remembers where you left it, in `~/Library/Application Support/cue (rea)/window-pos.json`.

While the panel is open, the whole panel stays on screen. Once you hide it (Hide), the pill alone can go anywhere, up into the menu bar next to the notch if you like. Showing the panel again pulls cue back just far enough for it to fit.

## The local model starts with the app

When Local is the provider and nothing answers on the Base URL yet, cue starts **llama.cpp's `llama-server`** itself. It stops the server again when you quit. The default model is:

- **Qwen3.5-9B**, file `~/models/pymaster/Qwen3.5-9B-Q4_K_M.gguf`, compressed to about 4.5 bits per weight (5.7 GB)
- plus its vision projector `~/models/pymaster/mmproj-F16.gguf` (0.9 GB), which lets it read screenshots

On launch, a status line reads `Starting local model: Qwen3.5-9B (Q4_K_M) + vision…`, then `Local model ready`. Settings → Local shows the same model and its state. If you ask something while the model is still loading, the answer starts as soon as it's ready.

Settings → Local → **Auto-start / Model file / Vision file** changes this. A change restarts the server. Leave Vision file empty to run text-only.

How cue handles a server it didn't start:
- If something is already serving the Base URL (Ollama, LM Studio, or `npm run local-model`), cue uses it and never stops it.
- The server's log is at `~/Library/Application Support/cue (rea)/llama-server.log`.
- If cue crashes, it adopts its leftover server on the next launch.

## Run from source

```sh
npm start             # auto-starts the model the same way
npm run local-model   # or run the server yourself in a terminal (cue will then just use it)
```

Open Settings (`⋯` or `⌘,`) → **Local** → **Test connection**. You should see `Connected · qwen3.5-9b`.

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

## macOS permissions

The packaged app is a separate app to macOS (`com.cue.overlay.rea`). The first time you use them, it asks for **Microphone** and **Screen Recording** access. The app is signed ad-hoc, so every rebuild counts as a new app, and you may have to grant both again after `npm run install-app`.

## Running next to the original cue

Both apps register ⌘↵, ⌘H and ⌘⇧X (this build also registers ⌘K). If the original cue already holds them, this build shows a status line saying so. Quit the original cue while you use this one. Settings are stored separately: `~/Library/Application Support/cue (rea)/cue-data.json`.

## Tests

```sh
npm test                                         # mock OpenAI-compatible server, 9 tests
CUE_LIVE_URL=http://127.0.0.1:8080/v1 npm test   # also runs one live request against your model
```

## License

GPL-3.0-or-later, the same as upstream cue. See `LICENSE`. The changes from upstream are in git history (the first commit is the unmodified 0.1.0 source).
