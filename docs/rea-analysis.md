# REA analysis of /Applications/cue.app (2026-10-29)

The full evidence is in `~/rea-runs/cue-20261029-123427/`. `session-with-trace.json` there is the complete exported session, about 117 MB.

## Bundle
- `com.cue.overlay` 0.1.0. Electron 33.2.1, arm64, needs macOS 11 or later.
- Signed ad-hoc: no team, no hardened runtime, no timestamp.
- The app code ships **unpacked** in `Contents/Resources/app`, with no `app.asar`. That's why `analyze_app` found no JavaScript runtime candidates.
- Electron fuses are left loose:
  - RunAsNode, `NODE_OPTIONS` and `--inspect` are all enabled.
  - ASAR integrity checking and OnlyLoadAppFromAsar are disabled.
  - Cookie encryption is off.
  - GrantFileProtocolExtraPrivileges is on.

## JavaScript application graph (`analyze_javascript_application`)
- 1 BrowserWindow with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: false`.
- 1 preload, which exposes `window.cue` (11 members) through contextBridge.
- 10 literal IPC channels. Every one of them pairs a preload sender with a main-process handler:
  - `invoke`: `settings:get`, `settings:set`, `capture:toggle`, `capture:state`
  - `send`: `ask`, `mic:pcm`, `system:pcm`, `mouse:ignore`, `open-pane`, `log`
- Messages from main to renderer go through one wrapper, `send(channel, data)`, whose channel name is dynamic, so REA couldn't resolve it statically. From the source, the channels are `llm:start`, `llm:token`, `llm:done`, `llm:error`, `status`, `transcript` and `capture:state`. The preload only forwards those.
- REA found no checks on who sent an IPC message. `open-pane` passes any URL to `shell.openExternal`.

## Feature trace (`trace_application_feature`, seed: channel `ask`, both directions)
- The only direct edges are preload `ask(payload)` → `ipcRenderer.send('ask')` → `ipcMain.on('ask')` → `runFeature(mode, text)`. Beyond that, the trace follows containment edges into nearly the whole graph (9,399 nodes), as REA's docs warn a two-way trace will.
- The flow, confirmed against the source:
  1. `runFeature` looks up the mode in `MODES[mode]` (`src/prompts.js`).
  2. It calls `createLLM(settings)` (`src/llm.js`).
  3. If the mode needs the screen, it calls `captureScreenshot()` (`src/screen.js`, desktopCapturer, PNG data URL).
  4. It calls `llm.stream({ system, turns, imageDataUrl, onToken })` and sends `llm:token` per token, then `llm:done`.
- So a new provider only needs one more branch in `createLLM().stream()`. That's where `local` plugs in.
