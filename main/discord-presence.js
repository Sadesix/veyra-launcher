const net = require('node:net');
const { randomUUID } = require('node:crypto');

const CLIENT_ID = '1557568278769967145';
function frame(opcode, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(opcode); head.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([head, bytes]);
}

// Local Discord RPC. Activity names come from the registered application's name.
class DiscordPresence {
  constructor({ clientId = CLIENT_ID, onStatus = () => {}, connect = options => net.createConnection(options), retryMs = 30000, throttleMs = 5000 } = {}) {
    this.clientId = clientId; this.onStatus = onStatus; this.connect = connect;
    this.retryMs = retryMs; this.throttleMs = throttleMs;
    this.status = 'disabled'; this.enabled = false; this.disposed = false;
    this.activity = null; this.sent = ''; this.lastSent = 0; this.generation = 0;
  }
  setStatus(value) { if (this.status !== value) { this.status = value; this.onStatus(value); } }
  configure(enabled) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.disconnect(true);
    if (enabled) this.open(); else this.setStatus('disabled');
  }
  update(activity) {
    this.activity = activity;
    this.flush();
  }
  disconnect(clear = false) {
    this.generation++;
    clearTimeout(this.retryTimer); clearTimeout(this.handshakeTimer); clearTimeout(this.sendTimer);
    if (clear && this.ready && this.socket && !this.socket.destroyed) this.socket.end(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: randomUUID() }));
    else this.socket?.destroy();
    this.socket = null; this.ready = false; this.sent = ''; this.lastSent = 0;
  }
  retry(status = 'waiting') {
    this.disconnect();
    if (!this.enabled || this.disposed) return;
    this.setStatus(status);
    this.retryTimer = setTimeout(() => this.open(), this.retryMs); this.retryTimer.unref?.();
  }
  open(index = 0) {
    if (!this.enabled || this.disposed) return;
    if (index >= 10) return this.retry();
    this.setStatus('connecting');
    const generation = ++this.generation;
    const socket = this.connect({ path: '\\\\?\\pipe\\discord-ipc-' + index });
    this.socket = socket;
    let input = Buffer.alloc(0), connected = false, finished = false;
    const failure = () => {
      if (finished || generation !== this.generation) return;
      finished = true; clearTimeout(this.handshakeTimer); socket.destroy(); this.ready = false;
      if (connected) this.retry(); else this.open(index + 1);
    };
    socket.on('error', failure); socket.on('close', failure);
    this.handshakeTimer = setTimeout(failure, 8000); this.handshakeTimer.unref?.();
    socket.on('connect', () => { connected = true; socket.write(frame(0, { v: 1, client_id: this.clientId })); });
    socket.on('data', bytes => {
      if (generation !== this.generation) return;
      input = Buffer.concat([input, bytes]);
      while (input.length >= 8) {
        const opcode = input.readUInt32LE(0), size = input.readUInt32LE(4);
        if (size > 65536) return failure();
        if (input.length < size + 8) break;
        const data = input.subarray(8, size + 8); input = input.subarray(size + 8);
        if (opcode === 3) { socket.write(frame(4, data)); continue; }
        if (opcode === 2) return failure();
        if (opcode !== 1) continue;
        let value; try { value = JSON.parse(data.toString('utf8')); } catch { return failure(); }
        if (value.evt === 'READY') {
          clearTimeout(this.handshakeTimer); this.ready = true; this.flush();
        } else if (value.evt === 'ERROR') {
          this.retry('error'); return;
        } else if (value.cmd === 'SET_ACTIVITY' && value.nonce === this.nonce) this.setStatus('connected');
      }
    });
  }
  flush() {
    if (!this.enabled || !this.ready || !this.socket || !this.activity) return;
    const signature = JSON.stringify(this.activity);
    if (signature === this.sent) return;
    clearTimeout(this.sendTimer);
    const delay = this.throttleMs - (Date.now() - this.lastSent);
    if (delay > 0) {
      this.sendTimer = setTimeout(() => this.flush(), delay); this.sendTimer.unref?.(); return;
    }
    this.nonce = randomUUID();
    this.socket.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.activity }, nonce: this.nonce }));
    this.sent = signature; this.lastSent = Date.now();
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.enabled = false; this.disconnect(true); this.setStatus('disabled'); }
}
module.exports = { DiscordPresence, frame, CLIENT_ID };
