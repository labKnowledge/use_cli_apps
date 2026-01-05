
// server_clean.cjs
const { WebSocketServer } = require('ws');
const http = require('http');
const express = require('express');
const pty = require('node-pty');
// ESM-only package: grab default
const stripAnsi = require('strip-ansi').default;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true, pid: process.pid }));

// --- Filtering helpers --- //
const SPINNER_PREFIXES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const isSpinnerLine = (line) => SPINNER_PREFIXES.some(p => line.startsWith(p + ' '));
const isRulerLine   = (line) => line.trim().startsWith('────────────────');
const isPromptHint  = (line) => /Type your message or @path\/to\/file/i.test(line);
const isWorkspaceFooter = (line) =>
  /\.\.\/?media\/.*\bno sandbox\b.*\bcoder-model\b/i.test(line) || // your path line
  /\bno sandbox\b.*\bcoder-model\b/i.test(line);
const isFeelingLucky = (line) => /I'?m Feeling Lucky/i.test(line);
const isStatusVerb   = (line) =>
  /(Initializing|Counting electrons|Defragmenting memories|Just a moment|finding the right meme)/i.test(line);

// Assistant content is often prefixed with ✦
const isAssistantLine = (line) => line.trim().startsWith('✦ ');

// Any other “decorative” lines to drop:
const isDecorative = (line) =>
  isSpinnerLine(line) ||
  isRulerLine(line) ||
  isPromptHint(line) ||
  isWorkspaceFooter(line) ||
  isFeelingLucky(line) ||
  isStatusVerb(line) ||
  // Empty or whitespace-only
  /^\s*$/.test(line);

// Normalize lines (strip ANSI and trim trailing spaces)
const normalize = (chunk) => stripAnsi(chunk).replace(/\r/g, '');

wss.on('connection', ws => {
  const p = pty.spawn('qwen', [], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
  });

  // We’ll buffer cleaned lines and flush periodically to avoid sending every frame.
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

  const scheduleFlush = () => {
    if (flushTimer) return;
    // Flush after small delay to coalesce bursts (spinner frames)
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 150); // tune 100–250ms
  };

  p.onData(data => {
    const text = normalize(data);

    // Split incoming data into lines
    const lines = text.split('\n');

    for (let raw of lines) {
      const line = raw; // already stripped of ANSI in normalize()

      // Filter decorative/noise lines
      if (isDecorative(line)) continue;

      // If the line looks like assistant content (✦ ...), strip the marker and keep the message
      if (isAssistantLine(line)) {
        const msg = line.replace(/^✦\s+/, '').trimEnd();
        if (msg) buffer.push(msg);
        continue;
      }

      // Otherwise, keep non-empty lines that aren’t UI noise
      const cleaned = line.trimEnd();
      if (cleaned.length) buffer.push(cleaned);
    }

    // Schedule a flush so we don’t spam the socket for every incoming frame
    scheduleFlush();
  });

  p.onExit(({ exitCode }) => {
    flush(); // send anything left
    ws.close(1000, `exit:${exitCode ?? 0}`);
  });

  ws.on('message', msg => {
    // Forward input → PTY (add Enter)
    p.write(msg.toString() + '\r');
  });

  ws.on('close', () => {
    try { p.kill('SIGTERM'); } catch {}
    if (flushTimer) clearTimeout(flushTimer);
  });
});

server.listen(3444, () => {
  console.log('WS+PTY (ANSI stripped + filtered) on ws://localhost:3444');
});
