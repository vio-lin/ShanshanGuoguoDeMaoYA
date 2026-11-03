import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { agentBridgePort, startAgentBridge, AGENT_BRIDGE_DEFAULT_PORT } from '../../src/main/agent-bridge';
import { assertAgentTaskEvent, assertReminderInput } from '../../src/shared/contracts';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('agentBridgePort defaults and explicit values', () => {
  assert.equal(agentBridgePort({}), AGENT_BRIDGE_DEFAULT_PORT);
  assert.equal(agentBridgePort({ PET_AGENT_PORT: '' }), AGENT_BRIDGE_DEFAULT_PORT);
  assert.equal(agentBridgePort({ PET_AGENT_PORT: '47001' }), 47001);
  assert.throws(() => agentBridgePort({ PET_AGENT_PORT: '900' }), /between 1024 and 65535/);
  assert.throws(() => agentBridgePort({ PET_AGENT_PORT: 'not-a-port' }), /between 1024 and 65535/);
});

test('assertAgentTaskEvent accepts a valid event', () => {
  const event = { kind: 'need-input', text: '请确认执行', source: 'claude-code', sessionId: 's1', ts: new Date().toISOString() };
  assert.doesNotThrow(() => assertAgentTaskEvent(event));
});

test('assertAgentTaskEvent rejects invalid events', () => {
  assert.throws(() => assertAgentTaskEvent(null), /Invalid agent task event/);
  assert.throws(() => assertAgentTaskEvent({ kind: 'unknown', text: 'x' }), /Invalid agent task kind/);
  assert.throws(() => assertAgentTaskEvent({ kind: 'task-complete', text: '' }), /Invalid agent task text/);
  assert.throws(() => assertAgentTaskEvent({ kind: 'task-complete', text: 'x'.repeat(501) }), /Invalid agent task text/);
  assert.throws(() => assertAgentTaskEvent({ kind: 'task-complete', text: 'x', source: 's'.repeat(65) }), /Invalid agent task source/);
  assert.throws(() => assertAgentTaskEvent({ kind: 'task-complete', text: 'x', sessionId: 's'.repeat(201) }), /Invalid agent task sessionId/);
  assert.throws(() => assertAgentTaskEvent({ kind: 'task-complete', text: 'x', ts: 'not-a-date' }), /Invalid agent task ts/);
});

test('assertReminderInput accepts a valid reminder', () => {
  assert.doesNotThrow(() => assertReminderInput({ text: '会议', dueAt: '2026-11-03T15:00:00+08:00' }));
  assert.doesNotThrow(() => assertReminderInput({ text: '会议', dueAt: '2026-11-03T15:00:00+08:00', leadMinutes: 5 }));
});

test('assertReminderInput rejects invalid reminders', () => {
  assert.throws(() => assertReminderInput(null), /Invalid reminder input/);
  assert.throws(() => assertReminderInput({ text: 42, dueAt: 'x' }), /Invalid reminder text/);
  assert.throws(() => assertReminderInput({ text: 'x'.repeat(501), dueAt: 'x' }), /Invalid reminder text/);
  assert.throws(() => assertReminderInput({ text: '会议', dueAt: 'not-a-date' }), /Invalid reminder dueAt/);
  assert.throws(() => assertReminderInput({ text: '会议', dueAt: '2026-11-03T15:00:00+08:00', leadMinutes: -1 }), /Invalid reminder leadMinutes/);
  assert.throws(() => assertReminderInput({ text: '会议', dueAt: '2026-11-03T15:00:00+08:00', leadMinutes: 1441 }), /Invalid reminder leadMinutes/);
  assert.throws(() => assertReminderInput({ text: '会议', dueAt: '2026-11-03T15:00:00+08:00', leadMinutes: 2.5 }), /Invalid reminder leadMinutes/);
});

test('agent bridge accepts a valid POST and forwards the event', async () => {
  const port = await freePort();
  const received: unknown[] = [];
  const bridge = await startAgentBridge({ onAgentTask: (event) => received.push(event), onAddReminder: () => undefined }, { PET_AGENT_PORT: String(port) });
  try {
    const event = { kind: 'task-complete', text: '构建完成', source: 'claude-code', sessionId: 'abc' };
    const res = await postJson(port, '/agent-task', event);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], event);
  } finally {
    await bridge.close();
  }
});

test('agent bridge accepts POST /reminders and forwards the reminder', async () => {
  const port = await freePort();
  const received: unknown[] = [];
  const bridge = await startAgentBridge({ onAgentTask: () => undefined, onAddReminder: (input) => received.push(input) }, { PET_AGENT_PORT: String(port) });
  try {
    const reminder = { text: '今天下午 3 点有个会议', dueAt: '2026-11-03T15:00:00+08:00' };
    const res = await postJson(port, '/reminders', reminder);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], reminder);

    // 可选 leadMinutes 按原样透传
    const leadReminder = { text: '提前 5 分钟提醒的会议', dueAt: '2026-11-03T15:00:00+08:00', leadMinutes: 5 };
    const leadRes = await postJson(port, '/reminders', leadReminder);
    assert.equal(leadRes.status, 200);
    assert.equal(received.length, 2);
    assert.deepEqual(received[1], leadReminder);

    // leadMinutes 非法 → 400
    const badLead = await postJson(port, '/reminders', { text: '会议', dueAt: '2026-11-03T15:00:00+08:00', leadMinutes: -1 });
    assert.equal(badLead.status, 400);
    const invalid = await postJson(port, '/reminders', { text: '会议', dueAt: 'not-a-date' });
    assert.equal(invalid.status, 400);
    const wrongPath = await postJson(port, '/reminder', { text: '会议', dueAt: '2026-11-03T15:00:00+08:00' });
    assert.equal(wrongPath.status, 404);
  } finally {
    await bridge.close();
  }
});

test('agent bridge rejects invalid payloads', async () => {
  const port = await freePort();
  const received: unknown[] = [];
  const bridge = await startAgentBridge({ onAgentTask: (event) => received.push(event), onAddReminder: () => undefined }, { PET_AGENT_PORT: String(port) });
  try {
    const invalidKind = await postJson(port, '/agent-task', { kind: 'wat', text: 'x' });
    assert.equal(invalidKind.status, 400);
    const notJson = await postJson(port, '/agent-task', '{not json');
    assert.equal(notJson.status, 400);
    const wrongPath = await postJson(port, '/other', { kind: 'task-complete', text: 'x' });
    assert.equal(wrongPath.status, 404);
    const wrongMethod = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/agent-task', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(wrongMethod, 404);
    assert.equal(received.length, 0);
  } finally {
    await bridge.close();
  }
});

test('agent bridge caps the request body', async () => {
  const port = await freePort();
  const received: unknown[] = [];
  const bridge = await startAgentBridge({ onAgentTask: (event) => received.push(event), onAddReminder: () => undefined }, { PET_AGENT_PORT: String(port) });
  try {
    const huge = JSON.stringify({ kind: 'task-complete', text: 'x'.repeat(70 * 1024) });
    const res = await postJson(port, '/agent-task', huge);
    assert.equal(res.status, 413);
    assert.equal(received.length, 0);
  } finally {
    await bridge.close();
  }
});
