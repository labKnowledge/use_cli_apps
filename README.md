# Building a Node.js server that uses a CLI **TUI** as a backend

This guide walks you end‑to‑end through creating a Node.js server that runs an interactive CLI/TUI (Text User Interface) app as its backend, and streams the app’s output to clients over **WebSockets**. We’ll cover:

*   ✅ Architecture & data flow
*   ✅ **PTY** (pseudo‑terminal): what it is, why you need it, and how we use it here
*   ✅ **ANSI escape codes** on TUIs: what they are and how to handle them
*   ✅ Using **`node-pty`** to run the TUI correctly
*   ✅ Using **`strip-ansi`** (or regex) to get **clean text**
*   ✅ WebSocket server & client examples
*   ✅ Filtering TUI “noise” (spinners, banners, prompts)
*   ✅ Reliability, performance, and production tips
*   ✅ Testing with `wscat` and browser clients

> **Use case**: You want to treat a CLI TUI (e.g., `qwen`) as a “model endpoint” and expose it as a web service. Clients connect, send prompts, and receive model output—without needing a terminal.

***

## 1) Architecture overview

**Goal**: Bridge an interactive CLI app to web clients.

    [Browser/Client]  <--WS-->  [Node.js Server]  <-->  [CLI TUI in PTY]
               input ---------------------------------> stdin (PTY)
               stdout/stderr (ANSI) <------------------ output (PTY)

*   **WebSocket (WS)**: bi‑directional transport between browser/clients and your server.
*   **PTY (pseudo-terminal)**: lets the CLI believe it’s running in a **real terminal**, so it behaves correctly (colors, prompts, streaming).
*   **ANSI**: terminal control codes embedded in CLI output (colors, cursor moves, spinners). You may want to **render** them (terminal UI) or **strip** them (plain text).

***

## 2) Why a PTY (pseudo‑terminal) is essential

Many interactive CLIs behave differently when connected to a terminal versus plain pipes:

*   When attached to a terminal, programs detect `isatty(stdin/stdout)` and enable **line editing**, **color**, **progress UI**, **interactive prompts**, etc.
*   When run via `child_process.spawn` with pipes (no TTY), some REPL‑like tools **exit early**, **buffer weirdly**, or suppress rich UI.

A **PTY** provides a virtual terminal device the process attaches to, so the app behaves exactly as it does in your shell.

### How `node-pty` works (high level)

*   On Linux/macOS it uses `forkpty`/`openpty` under the hood.
*   On Windows it uses **ConPTY** (Windows 10+) or **winpty** on older systems.
*   In Node.js, you get a PTY object with:
    *   `onData(callback)` for output
    *   `write(data)` to send input
    *   `resize(cols, rows)` to adjust terminal size
    *   `kill()` to terminate

We’ll use `node-pty` to spawn the CLI TUI and stream its output in real time.

***

## 3) ANSI escape codes (what they are & handling)

**ANSI** escape sequences start with `ESC` (ASCII 27, `\x1b`) and control terminals:

*   **Colors**: e.g., `\x1b[31m` (red), `\x1b[0m` (reset)
*   **Cursor movement**: `\x1b[2K` (erase line), `\x1b[1A` (move cursor up)
*   **Spinners & UI redraws**: lines prefixed with braille chars `⠋⠙⠹…` plus updates
*   **OSC** (Operating System Command): window titles `\x1b]2;title\x07`
*   **Box/Rule lines**: UI decorations (`─────────────────…`)

**Options when serving ANSI output:**

*   **Render ANSI** on the **client** using a terminal emulator (e.g., **xterm.js**) → users see the rich TUI like in a shell.
*   **Strip ANSI** on the **server** (e.g., with **`strip-ansi`**) → users receive **plain text** only (good for chat logs, JSON APIs).

***

## 4) Project setup

```bash
mkdir tui-bridge && cd tui-bridge
npm init -y

# Core deps
npm i express ws node-pty

# Optional: for plain text mode (strip ANSI control codes)
npm i strip-ansi

# Handy for CLI testing
npm i -g wscat
```

> If you prefer ES modules, add `"type": "module"` to `package.json`.\
> If you keep CommonJS, use `.cjs` and `require()`.

***

## 5) Server: PTY + ANSI preserved (for terminal‑capable clients)

This version streams **raw ANSI**. Ideal if your client renders ANSI (e.g., xterm.js).

**`server-pty.cjs` (CommonJS)**

```js
const { WebSocketServer } = require('ws');
const http = require('http');
const express = require('express');
const pty = require('node-pty');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true, pid: process.pid }));

wss.on('connection', ws => {
  // Spawn your TUI (use absolute path if Node’s PATH differs from your shell)
  const p = pty.spawn('qwen', [], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
  });

  // PTY -> WS (raw ANSI)
  p.onData(data => {
    ws.send(JSON.stringify({ type: 'stdout', data }));
  });

  // Lifecycle
  p.onExit(({ exitCode }) => {
    ws.close(1000, `exit:${exitCode ?? 0}`);
  });

  // WS -> PTY
  ws.on('message', msg => {
    p.write(msg.toString() + '\r'); // send input + Enter
  });

  ws.on('close', () => {
    try { p.kill('SIGTERM'); } catch {}
  });
});

server.listen(3444, () => {
  console.log('WS+PTY server on ws://localhost:3444 (ANSI preserved)');
});
```

**Client idea**: use xterm.js in the browser to render ANSI beautifully.

***

## 6) Server: PTY + strip ANSI (clean plain text)

If you want **clean text** (no spinners/colors), strip control codes before sending.

**Important**: Recent `strip-ansi` versions are **ESM-only**. In CommonJS, access the **default export**:

```js
const stripAnsi = require('strip-ansi').default;
// or use dynamic import:
// const { default: stripAnsi } = await import('strip-ansi');
```

**`server-clean.cjs` (CommonJS)**

```js
const { WebSocketServer } = require('ws');
const http = require('http');
const express = require('express');
const pty = require('node-pty');
const stripAnsi = require('strip-ansi').default;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true, pid: process.pid }));

// Filtering helpers (heuristics for Qwen-like TUI)
const SPINNER_PREFIXES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const isSpinnerLine = (line) => SPINNER_PREFIXES.some(p => line.startsWith(p + ' '));
const isRulerLine   = (line) => line.trim().startsWith('────────────────');
const isPromptHint  = (line) => /Type your message or @path\/to\/file/i.test(line);
const isWorkspaceFooter = (line) => /\bno sandbox\b.*\bcoder-model\b/i.test(line);
const isStatusVerb  = (line) =>
  /(Initializing|Counting electrons|Defragmenting memories|Just a moment|finding the right meme)/i.test(line);
const isAssistantLine = (line) => line.trim().startsWith('✦ ');

const isDecorative = (line) =>
  isSpinnerLine(line) ||
  isRulerLine(line) ||
  isPromptHint(line) ||
  isWorkspaceFooter(line) ||
  isStatusVerb(line) ||
  /^\s*$/.test(line);

const normalize = (chunk) => stripAnsi(chunk).replace(/\r/g, '');

wss.on('connection', ws => {
  const p = pty.spawn('qwen', [], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
  });

  let buffer = [];
  let flushTimer = null;

  const flush = () => {
    if (!buffer.length) return;
    const payload = buffer.join('\n');
    buffer = [];
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stdout', data: payload }));
    }
  };

  // Small delay to coalesce spinner redraw frames
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 150);
  };

  p.onData(data => {
    const text = normalize(data);
    const lines = text.split('\n');

    for (const line of lines) {
      if (isDecorative(line)) continue;

      if (isAssistantLine(line)) {
        const msg = line.replace(/^✦\s+/, '').trimEnd();
        if (msg) buffer.push(msg);
        continue;
      }

      const cleaned = line.trimEnd();
      if (cleaned.length) buffer.push(cleaned);
    }

    scheduleFlush();
  });

  p.onExit(({ exitCode }) => {
    flush();
    ws.close(1000, `exit:${exitCode ?? 0}`);
  });

  ws.on('message', msg => p.write(msg.toString() + '\r'));
  ws.on('close', () => {
    try { p.kill('SIGTERM'); } catch {}
    if (flushTimer) clearTimeout(flushTimer);
  });
});

server.listen(3444, () => {
  console.log('WS+PTY (ANSI stripped + filtered) on ws://localhost:3444');
});
```

> Prefer **no dependency**? Use a regex fallback:
>
> ```js
> const ANSI_REGEX =
>   /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()#][0-9A-Za-z]|[\x00-\x1F\x7F]/g;
> const stripAnsi = s => s.replace(ANSI_REGEX, '');
> ```

***

## 7) Clients

### A) `wscat` (quick test)

```bash
node server-clean.cjs
wscat -c ws://localhost:3444
> hello
# Expect clean messages like:
# {"type":"stdout","data":"Hello! How can I assist you today?"}
```

### B) Node client (simple)

```js
// client.js (ESM)
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:3444');

ws.on('open', () => {
  ws.send('Hello!');
});
ws.on('message', data => {
  const msg = JSON.parse(data.toString());
  console.log(`[${msg.type}]`, msg.data);
});
ws.on('close', (c, r) => console.log('closed', c, r.toString()));
ws.on('error', err => console.error('error', err));
```

### C) Browser client: **xterm.js** (render ANSI)

If you used the **ANSI preserved** server, render rich TUI in the browser:



### D) Browser client: plain chat view

If you used the **ANSI stripped** server, show clean text:



***

## 8) Handling TUI “noise” & getting what you want

TUIs redraw frequently (spinners, progress, prompt lines). To get **meaningful content**:

*   **Strip ANSI** → removes colors/cursor moves; still leaves **status lines**.
*   **Filter lines** by **heuristics**:
    *   Drop spinner frames (prefix `⠋⠙⠹…`).
    *   Drop decorative rulers (`─────────────────…`).
    *   Drop workspace footer (“no sandbox”, “coder-model (99%)”).
    *   Drop prompt hints (“Type your message…”).
    *   Keep lines starting with **`✦`** or other content prefixes; remove the marker and emit as assistant text.
*   **Coalesce/buffer** output for 100–250ms to group partials into one message (reduces flicker).
*   **Debounce** (e.g., 600ms of idle time) to emit only the **final** answer for each turn.

> Every TUI differs; start with the heuristics above, then refine for your CLI’s exact format.

***

## 9) Reliability & production tips

*   **Absolute path** to CLI: Node’s `PATH` may differ from your interactive shell (e.g., `/usr/local/bin`). Use `which qwen`, then:
    ```js
    const p = pty.spawn('/usr/local/bin/qwen', [], { /* ... */ });
    ```
*   **Backpressure**: WS can congest—monitor `ws.bufferedAmount`. Consider batching output or pausing UI updates (not trivial with PTY; buffering is easiest).
*   **Lifecycle**:
    *   Kill the child on WS close: `p.kill('SIGTERM')`; optionally hard kill after a delay.
    *   Map exit codes to clean WS closure reasons.
*   **Health checks**: add `/health` route to verify server status.
*   **Logging**: log stderr, exit codes, durations. Add request IDs for tracing.
*   **Security**:
    *   Validate inputs; your server sends user text into a CLI. Avoid commands that could write files or run shell code unless you sandbox.
    *   Rate limit / auth for multi‑tenant usage.
*   **Concurrency**:
    *   One PTY per WS connection (isolated sessions).
    *   For heavy workloads, use a job queue (BullMQ/Redis) and stream results back; or provision multiple worker processes.
*   **Windows/macOS/Linux**:
    *   `node-pty` uses ConPTY on modern Windows; ensure a recent OS.
    *   Some CLIs behave differently; tune `cols/rows` to avoid wrapping issues.

***

## 10) CommonJS vs ESM notes (for `strip-ansi`)

*   `strip-ansi` is **ESM-only** now:
    *   **CommonJS**: `const stripAnsi = require('strip-ansi').default;`
    *   **ESM**: `import stripAnsi from 'strip-ansi';`
    *   **CommonJS + dynamic import**:
        ```js
        (async () => {
          const { default: stripAnsi } = await import('strip-ansi');
        })();
        ```

If you see:

    TypeError: stripAnsi is not a function

you’re likely using `require('strip-ansi')` without `.default`.

***

## 11) Testing workflow

1.  **Start** your server (clean or ANSI‑preserved).
    ```bash
    node server-clean.cjs
    # or:
    node server-pty.cjs
    ```
2.  **Connect** with `wscat`:
    ```bash
    wscat -c ws://localhost:3444
    > hello
    ```
3.  **Observe output**: clean text vs raw ANSI.
4.  If no output or `exit:1`, check:
    *   PATH mismatch (use absolute path)
    *   CLI arguments required?
    *   Does CLI crash without a TTY? (You’re using PTY here, so you’re good.)

***

## 12) Variants (SSE & JSON mode)

*   **Server-Sent Events (SSE)**: simple one‑way streaming (server → client). Good for browser clients that don’t need to send data during streaming.
*   **JSON mode** (if your CLI supports it): Some CLIs can output structured JSON. Prefer this where available—it avoids ANSI and TUI parsing entirely.

***

## 13) Putting it all together

*   Use **`node-pty`** to run the CLI in a real terminal context.
*   Decide whether to **preserve** ANSI (rich terminal experience) or **strip** ANSI (plain text).
*   Add **filters** to remove TUI noise and extract meaningful content.
*   Stream over **WebSockets**, batch/throttle to avoid flicker.
*   Harden for production: path handling, backpressure, lifecycle, security, and logging.

***

### Need a tailored template, Remy?

If you share:

*   Which CLI & typical prompts,
*   Whether you want **rich TUI** (xterm.js) or **clean chat**,
*   Your deployment OS (Linux/Windows/macOS),
*   Any special requirements (auth, rate limit, job queue),

I’ll draft a production‑ready repo layout for you—`server`, `clients` (terminal and web), Dockerfile, and tests—so you can plug in your CLI and ship.
