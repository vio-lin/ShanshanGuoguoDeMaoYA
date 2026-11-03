import http from 'node:http';
import type { AgentTaskEvent } from '../shared/contracts';
import { assertAgentTaskEvent, assertReminderInput } from '../shared/contracts';

/**
 * Agent Bridge：桌宠主进程内的轻量本地 HTTP 端点。
 *
 * 外部 agent（如 Claude Code 的 hooks）通过 curl POST 到
 * `http://127.0.0.1:<port>/agent-task` 推送 `AgentTaskEvent`，
 * 桌宠据此触发动作与任务泡泡；
 * `http://127.0.0.1:<port>/reminders` 则用于直接新增提醒/会议
 * （body `{text, dueAt}`），复用桌宠提醒系统到点提醒。
 *
 * 安全边界：
 * - 只监听 127.0.0.1 回环地址，不暴露到局域网；
 * - 只接受 POST /agent-task 与 POST /reminders，其余方法/路径一律 404；
 * - body 上限 64KB，payload 通过 assert* 白名单校验；
 * - 非回环来源（理论上不可能发生，防御性处理）返回 403。
 */

export const AGENT_BRIDGE_DEFAULT_PORT = 46231;
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface AgentBridge {
  port: number;
  close: () => Promise<void>;
}

export interface AgentBridgeHandlers {
  onAgentTask: (event: AgentTaskEvent) => void;
  onAddReminder: (input: { text: string; dueAt: string; leadMinutes?: number }) => void;
}

export function agentBridgePort(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.PET_AGENT_PORT;
  if (explicit !== undefined && explicit !== '') {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('PET_AGENT_PORT must be an integer TCP port between 1024 and 65535');
    }
    return port;
  }
  return AGENT_BRIDGE_DEFAULT_PORT;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function startAgentBridge(
  handlers: AgentBridgeHandlers,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentBridge> {
  const port = agentBridgePort(env);

  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    if (!LOOPBACK_ADDRESSES.has(remote)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const urlPath = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const route = urlPath === '/agent-task' ? 'agent-task' : urlPath === '/reminders' ? 'reminders' : null;
    if (!route) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        rejected = true;
        sendJson(res, 413, { error: 'payload-too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'invalid-json' });
        return;
      }
      try {
        if (route === 'agent-task') {
          assertAgentTaskEvent(payload);
        } else {
          assertReminderInput(payload);
        }
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid-payload' });
        return;
      }
      sendJson(res, 200, { ok: true });
      if (route === 'agent-task') {
        handlers.onAgentTask(payload as AgentTaskEvent);
      } else {
        handlers.onAddReminder(payload as { text: string; dueAt: string; leadMinutes?: number });
      }
    });
    req.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // server 未处于 listening 时 close 不会回调；此处 listen 已成功，无需兜底。
          }),
      });
    });
  });
}
