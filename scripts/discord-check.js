const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DiscordPresence, frame, CLIENT_ID } = require('../main/discord-presence');

async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw new Error('RPC test timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function main() {
  const endpoint = process.platform === 'win32' ? '\\\\?\\pipe\\veyra-discord-check-' + randomUUID() : '/tmp/veyra-discord-check-' + randomUUID();
  const frames = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 8 && bytes.length >= 8 + bytes.readUInt32LE(4)) {
        const opcode = bytes.readUInt32LE(0), length = bytes.readUInt32LE(4), payload = JSON.parse(bytes.subarray(8, 8 + length).toString()); bytes = bytes.subarray(8 + length);
        frames.push({ opcode, payload });
        if (opcode === 0) {
          const ready = frame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } });
          socket.write(ready.subarray(0, 5)); setTimeout(() => { socket.write(ready.subarray(5)); socket.write(frame(3, { ping: true })); }, 10);
        } else if (opcode === 1) socket.write(frame(1, { cmd: 'SET_ACTIVITY', nonce: payload.nonce, data: payload.args.activity }));
      }
    });
  });
  server.listen(endpoint); await once(server, 'listening');
  const attempts = [];
  const rpc = new DiscordPresence({ retryMs: 30, throttleMs: 30, connect: options => { attempts.push(options.path); return net.createConnection({ path: endpoint }); } });
  try {
    rpc.update({ type: 0, details: 'В библиотеке сборок', state: 'Готовится к приключению' }); rpc.configure(true);
    await until(() => rpc.status === 'connected' && frames.some(item => item.opcode === 4));
    assert.equal(frames[0].payload.client_id, CLIENT_ID); assert.equal(CLIENT_ID, '1557568278769967145'); assert.equal(frames[0].payload.v, 1);
    assert.equal(attempts[0], '\\\\?\\pipe\\discord-ipc-0');
    let updates = frames.filter(item => item.opcode === 1); assert.equal(updates[0].payload.args.pid, process.pid);
    rpc.update({ type: 0, details: 'Играет в Minecraft 1.21.8', state: 'Aurora · Fabric', timestamps: { start: 1234567890 } });
    await until(() => frames.filter(item => item.opcode === 1).length === 2);
    updates = frames.filter(item => item.opcode === 1); assert.equal(updates[1].payload.args.activity.timestamps.start, 1234567890);
    rpc.update(rpc.activity); await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(frames.filter(item => item.opcode === 1).length, 2);
    for (const socket of sockets) socket.destroy(); await until(() => attempts.length > 1 && rpc.status === 'connected');
    rpc.configure(false); await until(() => frames.some(item => item.opcode === 1 && item.payload.args.activity === null)); assert.equal(rpc.status, 'disabled');
    assert.doesNotMatch(JSON.stringify(frames), /accessToken|playerName|directory|refreshToken/);
    process.stdout.write('OK: real local pipe, Application ID, fragmented handshake, ping/pong, accepted activity, game timestamp, deduplication, reconnect and clearing on disable.\n');
  } finally { rpc.dispose(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
