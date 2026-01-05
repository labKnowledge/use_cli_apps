
// ws-pty-server.cjs
const { WebSocketServer } = require('ws');
const http = require('http');
const express = require('express');
const os = require('os');
const pty = require('node-pty');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true }));

wss.on('connection', ws => {
  // Spawn qwen in a PTY (no shell needed unless you prefer)
  const p = pty.spawn('qwen', [], {
    name: 'xterm-color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env
  });

  // PTY → WS
  p.onData(data => {
    ws.send(JSON.stringify({ type: 'stdout', data })); // qwen often prints everything to stdout stream in PTY
  });

  p.onExit(({ exitCode, signal }) => {
    ws.close(1000, `exit:${exitCode ?? 0}`);
  });

  // WS → PTY
  ws.on('message', msg => {
    // Send input and a newline to submit
    p.write(msg.toString() + '\r');
  });

  ws.on('close', () => {
    try { p.kill('SIGTERM'); } catch {}
  });
});

server.listen(3444, () => console.log('WS PTY server on ws://localhost:3444'));
