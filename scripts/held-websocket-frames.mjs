/** 本机故障注入专用：保存完整服务器数据帧，控制帧始终原样通过。 */
export class HeldWebSocketFrames {
  pending = Buffer.alloc(0);
  held = [];
  heldBytes = 0;
  droppedBytes = 0;
  constructor(send, limit = 512 * 1024) { this.send = send; this.limit = limit; }
  push(bytes, paused) {
    this.pending = Buffer.concat([this.pending, bytes]);
    if (this.pending.length > this.limit) throw Error('Test frame limit exceeded');
    while (this.pending.length >= 2) {
      const data = this.pending, size = data[1] & 127;
      // ws 生产网关未启用压缩；服务器到客户端的帧不使用 mask。
      if (data[1] & 128 || data[0] & 112) throw Error('Unexpected server frame');
      let header = 2, length = size;
      if (size === 126) { if (data.length < 4) return; header = 4; length = data.readUInt16BE(2); }
      if (size === 127) {
        if (data.length < 10) return;
        header = 10; const wide = data.readBigUInt64BE(2);
        if (wide > BigInt(this.limit)) throw Error('Test frame limit exceeded');
        length = Number(wide);
      }
      if (header + length > this.limit) throw Error('Test frame limit exceeded');
      if (data.length < header + length) return;
      const frame = data.subarray(0, header + length); this.pending = data.subarray(header + length);
      const opcode = frame[0] & 15;
      if (opcode === 8) this.drop();
      if (paused && [0, 1, 2].includes(opcode)) {
        if (this.heldBytes + frame.length > this.limit) throw Error('Test hold limit exceeded');
        this.held.push(frame); this.heldBytes += frame.length;
      } else this.send(frame);
    }
  }
  resume() { for (const frame of this.held) this.send(frame); this.held = []; this.heldBytes = 0; }
  drop() { this.droppedBytes += this.heldBytes; this.held = []; this.heldBytes = 0; }
}
