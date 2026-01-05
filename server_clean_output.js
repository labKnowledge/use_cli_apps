
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const ANSI_REGEX = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()#][0-9A-Za-z]|[\x00-\x1F\x7F]/g;
const stripAnsi = s => s.replace(ANSI_REGEX, '');

wss.on('connection', ws => {
  const child = spawn('qwen'); // if PATH mismatch: spawn('/absolute/path/to/qwen')

  child.stdout.on('data', chunk => {
    const raw = chunk.toString();
    const plain = stripAnsi(raw);
    ws.send(JSON.stringify({ type: 'stdout', data: plain }));
  });

  child.stderr.on('data', chunk => {
    const raw = chunk.toString();
    const plain = stripAnsi(raw);
    ws.send(JSON.stringify({ type: 'stderr', data: plain }));
  });

  child.on('close', code => ws.close(1000, `exit:${code}`));
  ws.on('message', msg => child.stdin.write(msg + '\n'));
  ws.on('close', () => child.kill('SIGTERM'));
});

server.listen(3444, () => console.log('WS on ws://localhost:3444'));
