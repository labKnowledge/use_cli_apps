
// server_clean.cjs
const { WebSocketServer } = require('ws');
const http = require('http');
const express = require('express');
const pty = require('node-pty');
const stripAnsi = require('strip-ansi').default; // <-- ESM default export

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true, pid: process.pid }));

wss.on('connection', ws => {
  const p = pty.spawn('qwen', [], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
  });

  // PTY -> WS (strip ANSI)
  p.onData(data => {
    const plain = stripAnsi(data);
    ws.send(JSON.stringify({ type: 'stdout', data: plain }));
  });

  p.onExit(({ exitCode }) => {
    ws.close(1000, `exit:${exitCode ?? 0}`);
  });

  // WS -> PTY
  ws.on('message', msg => {
    p.write(msg.toString() + '\r');
  });

  ws.on('close', () => {
    try { p.kill('SIGTERM'); } catch {}
  });
});

server.listen(3444, () => {
  console.log('WS+PTY server on ws://localhost:3444 (ANSI stripped, CommonJS)');
});
