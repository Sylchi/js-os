#!/usr/bin/env node
// Native fetch() coverage.
//
// Boots a loopback HTTP server, runs a generated kz script through ./kzero,
// and checks the response-object members and error paths. The server binds an
// ephemeral port so the test is independent of anything else on the machine.
//
//   node tests/fetch_test.mjs

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const kzero = path.resolve(here, '..', 'kzero');
const tmp = `/tmp/opencode/reg_fetch_test_${process.pid}.kz`;
const tlsDir = `/tmp/opencode/reg_fetch_tls_${process.pid}`;
const tlsKey = path.join(tlsDir, 'key.pem');
const tlsCert = path.join(tlsDir, 'cert.pem');

// A throwaway self-signed certificate lets the HTTPS path be exercised without
// public network access. Verification diagnostics are discarded by the runtime,
// so the handshake still completes.
fs.mkdirSync(tlsDir, { recursive: true });
const cert = spawnSync('openssl', [
  'req', '-x509', '-newkey', 'ec',
  '-pkeyopt', 'ec_paramgen_curve:prime256v1',
  '-keyout', tlsKey, '-out', tlsCert,
  '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
], { stdio: 'ignore' });
if (cert.status !== 0) {
  console.error('✗ fetch_test (openssl is required for the HTTPS half)');
  process.exit(1);
}

const handle = (req, res) => {
  if (req.url === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Test': 'yes' });
    res.end('hello world');
  } else if (req.url === '/binary') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 3, 0xff, 65]));
  } else if (req.url === '/empty') {
    res.writeHead(204);
    res.end();
  } else if (req.url === '/missing') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('nope');
  } else if (req.url === '/cookie') {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': ['session=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'],
    });
    res.end('cookie-body');
  } else if (req.url === '/redir-abs') {
    res.writeHead(302, { Location: `http://127.0.0.1:${req.socket.localPort}/hello` });
    res.end('abs');
  } else if (req.url === '/redir-rel') {
    res.writeHead(302, { Location: '/hello' });
    res.end('rel');
  } else if (req.url === '/redir-scheme') {
    res.writeHead(302, { Location: `//127.0.0.1:${req.socket.localPort}/hello` });
    res.end('scheme');
  } else if (req.url === '/redir-loop') {
    res.writeHead(302, { Location: '/redir-loop' });
    res.end('loop');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('root');
  }
};

const server = http.createServer(handle);
const tlsServer = https.createServer(
  { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) },
  handle,
);

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const tlsPort = tlsServer.address().port;

const source = `
let r = fetch("http://127.0.0.1:${port}/hello");
console.log(r.status);
console.log(r.body);
console.log(r.ok);
console.log(r.length);
console.log(r.body.length);
console.log(r.text);

let u = "http://127.0.0.1:${port}/hello";
let v = fetch(u);
console.log(v.status + ":" + v.body);

let m = fetch("http://127.0.0.1:${port}/missing");
console.log(m.status);
console.log(m.ok);
console.log(m.body);

let e = fetch("http://127.0.0.1:${port}/empty");
console.log(e.status);
console.log(e.ok);
console.log(e.body.length);

let b = fetch("http://127.0.0.1:${port}/binary");
console.log(b.status);
console.log(b.body.length);

let ra = fetch("http://127.0.0.1:${port}/redir-abs");
console.log(ra.status);
console.log(ra.body);
let rr = fetch("http://127.0.0.1:${port}/redir-rel");
console.log(rr.status);
console.log(rr.body);
let rs = fetch("http://127.0.0.1:${port}/redir-scheme");
console.log(rs.status);
console.log(rs.body);
let rl = fetch("http://127.0.0.1:${port}/redir-loop");
console.log(rl.status);
console.log(rl.body);

let t = fetch("https://127.0.0.1:${tlsPort}/hello");
console.log(t.status);
console.log(t.body);
let tr = fetch("https://127.0.0.1:${tlsPort}/redir-rel");
console.log(tr.status);
console.log(tr.body);

fetch("http://127.0.0.1:${port}/hello").then(r => { console.log(r.status); console.log(r.body); });
console.log(fetch("http://127.0.0.1:${port}/hello").then(r => r.status));
fetch("http://127.0.0.1:${port}/hello").then(r => r.status).then(s => { console.log(s + 1); });
let tc = fetch("http://127.0.0.1:${port}/hello").then(r => r.body);
console.log(tc);
console.log(fetch("http://127.0.0.1:${port}/hello").then(r => { return r.body.length; }));
fetch("http://127.0.0.1:${port}/hello").then(() => { console.log("no-arg"); });
fetch("http://127.0.0.1:${port}/hello").then((a, b) => { console.log(a.status); console.log(b); });
function show(x) { console.log(x.status); }
fetch("http://127.0.0.1:${port}/missing").then(show);
let ci = 0;
while (ci < 3) {
  fetch("http://127.0.0.1:${port}/hello").then(r => { console.log(r.status); });
  ci = ci + 1;
}
fetch("ftp://example.com/").then(r => { console.log(r); });

console.log(fetch("ftp://example.com/"));
console.log(fetch(123));
`;

const cookieTmp = `/tmp/opencode/reg_fetch_cookie_${process.pid}.kz`;
const cookieSource = `
fetch("http://127.0.0.1:${port}/cookie").then(c => {
  console.log(c.status);
  console.log(c.body);
  console.log(c.headers);
});
`;

fs.writeFileSync(tmp, source);
fs.writeFileSync(cookieTmp, cookieSource);

// spawn() keeps the event loop alive so the loopback server can answer while
// kzero runs; spawnSync() would deadlock waiting on requests it cannot serve.
const runKz = (file) => new Promise((resolve) => {
  const child = spawn(kzero, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.on('close', (status, signal) => {
    clearTimeout(timer);
    resolve({ status, signal, stdout, stderr });
  });
});

const result = await runKz(tmp);
const cookieResult = await runKz(cookieTmp);
server.close();
tlsServer.close();

const expected = [
  '200',
  'hello world',
  '1',
  '11',
  '11',
  'hello world',
  '200:hello world',
  '404',
  '0',
  'nope',
  '204',
  '1',
  '0',
  '200',
  '6',
  '200',
  'hello world',
  '200',
  'hello world',
  '200',
  'hello world',
  '302',
  'loop',
  '200',
  'hello world',
  '200',
  'hello world',
  '200',
  'hello world',
  '200',
  '201',
  'hello world',
  '11',
  'no-arg',
  '200',
  '0',
  '404',
  '200',
  '200',
  '200',
  '0',
  '0',
  '0',
].join('\n');

const norm = (s) => (s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
const actual = norm(result.stdout);
const cookieOut = norm(cookieResult.stdout);
const cookieLower = cookieOut.toLowerCase();
const cookiesOk = cookieResult.status === 0
  && cookieOut.startsWith('200\ncookie-body\n')
  && cookieLower.includes('set-cookie: session=abc123; path=/; httponly')
  && cookieLower.includes('set-cookie: theme=dark; path=/');
const ok = result.status === 0 && actual === expected && cookiesOk;

console.log(ok ? '✓ fetch_test' : '✗ fetch_test');
if (!ok) {
  console.log(`  exit: ${result.status}`);
  if (result.signal) console.log(`  signal: ${result.signal}`);
  if (result.stderr) console.log(`  stderr: ${result.stderr.split('\n')[0]}`);
  if (actual !== expected) {
    console.log('  output mismatch:');
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
  if (!cookiesOk) {
    console.log(`  cookie exit: ${cookieResult.status}`);
    if (cookieResult.signal) console.log(`  cookie signal: ${cookieResult.signal}`);
    console.log(`  cookie output: ${JSON.stringify(cookieOut)}`);
  }
}
process.exit(ok ? 0 : 1);
