import test from 'node:test';
import assert from 'node:assert/strict';
import { HeldWebSocketFrames } from './held-websocket-frames.mjs';

function frame(opcode, text, wide = 0) {
  const body = Buffer.from(text), header = Buffer.alloc(wide === 127 ? 10 : wide === 126 ? 4 : 2);
  header[0] = 128 | opcode; header[1] = wide || body.length;
  if (wide === 126) header.writeUInt16BE(body.length, 2);
  if (wide === 127) header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}
test('任意TCP分片保留原数据，暂停数据但立即转发真实撤销close并丢弃旧帧', () => {
  const sent = [], gate = new HeldWebSocketFrames(bytes => sent.push(bytes));
  const data = frame(1, 'private test output'), ping = frame(9, 'ping');
  for (const byte of data) gate.push(Buffer.from([byte]), true);
  assert.equal(gate.heldBytes, data.length); assert.equal(sent.length, 0);
  gate.push(ping, true); assert.deepEqual(sent, [ping]);
  const close = frame(8, Buffer.concat([Buffer.from([15, 163]), Buffer.from('device_revoked')]));
  gate.push(close, true); gate.resume();
  assert.deepEqual(sent, [ping, close]); assert.equal(gate.heldBytes, 0); assert.equal(gate.droppedBytes, data.length);
});
test('扩展长度、多个帧与继续转发逐字节一致，超限拒绝', () => {
  const sent = [], gate = new HeldWebSocketFrames(bytes => sent.push(bytes));
  const first = frame(2, '中文'.repeat(200), 126), second = frame(1, 'hello', 127);
  gate.push(Buffer.concat([first, second]), true); assert.equal(sent.length, 0);
  gate.resume(); assert.deepEqual(Buffer.concat(sent), Buffer.concat([first, second]));
  assert.throws(() => new HeldWebSocketFrames(() => {}, 10).push(frame(1, 'x'.repeat(20)), true), /limit/);
});

test('后续响应先通过，释放暂缓响应时保持两者原始字节', () => {
  const sent = [], gate = new HeldWebSocketFrames(bytes => sent.push(bytes));
  const oldReply = frame(1, 'old response'), newReply = frame(1, 'new response');
  gate.push(oldReply, true);
  gate.push(newReply, false);
  assert.deepEqual(sent, [newReply]); assert.equal(gate.heldBytes, oldReply.length);
  gate.resume();
  assert.deepEqual(sent, [newReply, oldReply]); assert.equal(gate.heldBytes, 0);
});
