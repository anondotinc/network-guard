// Synthetic loopback fixtures only. No Tor, VPN, public RPC or browser settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const binary = process.argv[2] ?? fileURLToPath(new URL('../.build/debug/anon-network-helper', import.meta.url));
const origin = 'chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/';
const rpcBody = JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 });
function frame(value) {
  const data = Buffer.from(JSON.stringify(value)), prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(data.length); return Buffer.concat([prefix, data]);
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function close(server) { return new Promise(resolve => server.close(resolve)); }
function call(proxyPort, url, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [origin], { env: { PATH: '/usr/bin:/bin', NO_PROXY: '*', ALL_PROXY: 'http://127.0.0.1:1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const id = randomUUID(); let buffered = Buffer.alloc(0), negotiated = false, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Native proxy fixture timed out')), 6000);
    child.on('error', error => finish(error));
    child.on('exit', () => { if (!settled) finish(new Error('Native proxy exited before a reply')); });
    child.stdin.on('error', error => finish(error));
    child.stdout.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE()) {
        const count = buffered.readUInt32LE();
        const value = JSON.parse(buffered.subarray(4, count + 4)); buffered = buffered.subarray(count + 4);
        if (!negotiated) {
          assert.deepEqual(value, { v: 7, id, ok: true, method: 'rpcCapabilities' }); negotiated = true;
          child.stdin.write(frame({ v: 7, id, method: 'rpc', host: '127.0.0.1', port: proxyPort,
            url, body: Buffer.from(rpcBody).toString('base64'), headers: { 'content-type': 'application/json' }, ...extra }));
        } else { assert.equal(value.id, id); finish(null, value); }
      }
    });
    child.stdin.write(frame({ v: 7, id, method: 'rpcCapabilities' }));
  });
}
function socksFixture({ refuse = false, status = 200, body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}', headers = '' } = {}) {
  const destinations = [], requests = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0), stage = 'hello';
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (stage === 'hello') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        assert.equal(buffer[0], 5); assert.ok(buffer.subarray(2, 2 + buffer[1]).includes(0));
        buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 0])); stage = 'connect';
      }
      if (stage === 'connect') {
        if (buffer.length < 5) return;
        const type = buffer[3], length = type === 3 ? buffer[4] : type === 1 ? 4 : 16, start = type === 3 ? 5 : 4;
        if (buffer.length < start + length + 2) return;
        assert.equal(buffer[1], 1);
        destinations.push({ type, host: type === 3 ? buffer.subarray(start, start + length).toString() : [...buffer.subarray(start, start + length)].join('.'), port: buffer.readUInt16BE(start + length) });
        buffer = buffer.subarray(start + length + 2);
        socket.write(Buffer.from([5, refuse ? 5 : 0, 0, 1, 127, 0, 0, 1, 0, 1]));
        if (refuse) { socket.end(); stage = 'done'; return; }
        stage = 'http';
      }
      if (stage === 'http') {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        const head = buffer.subarray(0, end).toString(), length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (buffer.length < end + 4 + length) return;
        requests.push({ head, body: buffer.subarray(end + 4, end + 4 + length).toString() });
        stage = 'done';
        socket.end(`HTTP/1.1 ${status} Test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${headers}\r\n${body}`);
      }
    });
  });
  return { server, destinations, requests, dispose: async () => { for (const socket of sockets) socket.destroy(); await close(server); } };
}

test('native SOCKS5 transport: remote DNS, no local bypass, no fallback or redirects', async t => {
  let directRequests = 0;
  const destination = http.createServer((_, res) => { directRequests++; res.end('DIRECT'); });
  const directPort = await listen(destination);
  try {
    await t.test('unresolvable hostname reaches SOCKS as a domain; environment NO_PROXY cannot bypass it', async () => {
      const fixture = socksFixture(), port = await listen(fixture.server);
      try {
        const result = await call(port, 'http://synthetic-rpc.invalid:8545/');
        assert.equal(result.ok, true); assert.equal(result.status, 200);
        assert.equal(JSON.parse(Buffer.from(result.body, 'base64')).result, '0x1');
        assert.deepEqual(fixture.destinations, [{ type: 3, host: 'synthetic-rpc.invalid', port: 8545 }]);
        assert.equal(fixture.requests[0].body, rpcBody);
      } finally { await fixture.dispose(); }
    });
    await t.test('proxy refusal never retries a reachable loopback RPC directly', async () => {
      const fixture = socksFixture({ refuse: true }), port = await listen(fixture.server);
      try {
        assert.equal((await call(port, `http://127.0.0.1:${directPort}/`)).ok, false);
        assert.equal(fixture.destinations.length, 1); assert.equal(directRequests, 0);
      } finally { await fixture.dispose(); }
    });
    await t.test('onion hostnames also reach the proxy without local resolution', async () => {
      const fixture = socksFixture(), port = await listen(fixture.server), onion = `${'a'.repeat(56)}.onion`;
      try {
        assert.equal((await call(port, `http://${onion}/`)).ok, true);
        assert.deepEqual(fixture.destinations, [{ type: 3, host: onion, port: 80 }]);
      } finally { await fixture.dispose(); }
    });
    await t.test('proxy unavailable never retries a reachable RPC directly', async () => {
      const temporary = net.createServer(), unused = await listen(temporary); await close(temporary);
      assert.equal((await call(unused, `http://127.0.0.1:${directPort}/`)).ok, false);
      assert.equal(directRequests, 0);
    });
    await t.test('redirect response is rejected without contacting its destination', async () => {
      const fixture = socksFixture({ status: 302, headers: `Location: http://127.0.0.1:${directPort}/\r\n` }), port = await listen(fixture.server);
      try { assert.equal((await call(port, 'http://node.invalid/')).ok, false); assert.equal(directRequests, 0); }
      finally { await fixture.dispose(); }
    });
    await t.test('oversized responses and config-injection headers fail', async () => {
      const fixture = socksFixture({ body: 'x'.repeat(262145) }), port = await listen(fixture.server);
      try {
        assert.equal((await call(port, 'http://node.invalid/')).ok, false);
        const result = await call(port, 'http://node.invalid/', { headers: { 'x-api-key': 'key\nproxy = ""' } });
        assert.equal(result.error, 'invalidRequest'); assert.equal(fixture.destinations.length, 1);
      } finally { await fixture.dispose(); }
    });
  } finally { await close(destination); }
});
