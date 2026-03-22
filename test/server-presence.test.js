import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const WAIT = 4000;

function waitFor(ws, predicate, timeout = WAIT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for websocket message'));
    }, timeout);
    const onMessage = raw => {
      const msg = JSON.parse(String(raw));
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before expected message'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

test('server broadcasts presence snapshot, peer-up/down, and relays control messages', async () => {
  const port = 32109;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await once(proc.stdout, 'data');

    const fpA = 'a'.repeat(64);
    const fpB = 'b'.repeat(64);

    const a = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(a, 'open');
    a.send(JSON.stringify({ type:'announce', from:fpA, nick:'alpha' }));
    await waitFor(a, msg => msg.type === 'ice-config');
    const snapA = await waitFor(a, msg => msg.type === 'presence-snapshot');
    assert.deepEqual(snapA.peers, []);

    const b = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(b, 'open');
    b.send(JSON.stringify({ type:'announce', from:fpB, nick:'bravo' }));
    await waitFor(b, msg => msg.type === 'ice-config');
    const snapB = await waitFor(b, msg => msg.type === 'presence-snapshot');
    assert.equal(snapB.peers.length, 1);
    assert.equal(snapB.peers[0].fingerprint, fpA);

    const peerUp = await waitFor(a, msg => msg.type === 'peer-up');
    assert.equal(peerUp.fingerprint, fpB);
    assert.equal(peerUp.nick, 'bravo');

    a.send(JSON.stringify({ type:'call-state', to:fpB, state:'reconnecting', sessionId:'circle', sessionKind:'circle' }));
    const relayed = await waitFor(b, msg => msg.type === 'call-state');
    assert.equal(relayed.from, fpA);
    assert.equal(relayed.state, 'reconnecting');

    b.close();
    const peerDown = await waitFor(a, msg => msg.type === 'peer-down');
    assert.equal(peerDown.fingerprint, fpB);

    a.close();
  } finally {
    proc.kill('SIGTERM');
    await once(proc, 'exit');
  }
});
