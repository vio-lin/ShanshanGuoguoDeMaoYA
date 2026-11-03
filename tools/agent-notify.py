#!/usr/bin/env python3
"""Claude Code hook 转发器：把 Claude 需要输入/会话结束事件转发给桌宠本地端点。

用法（在 ~/.claude/settings.json 或项目 .claude/settings.json 的 hooks 中引用）：
  {
    "hooks": {
      "Notification": [
        { "type": "command", "command": "python3 /绝对路径/本文件 --kind need-input" }
      ],
      "SessionEnd": [
        { "type": "command", "command": "python3 /绝对路径/本文件 --kind task-complete --text \"Claude 会话已结束\"" }
      ]
    }
  }

hook 的 stdin 是一行 JSON（session_id / transcript_path / message 等）。
脚本把它转换成桌宠的 AgentTaskEvent 并 POST 到 127.0.0.1:<port>/agent-task。
桌宠未运行或端口不对时静默失败，不影响 Claude 流程。

调试日志：每次调用都追加写入 LOG_PATH（默认 ~/.claude/agent-notify.log，
可用环境变量 PET_AGENT_LOG 覆盖），记录运行时刻、stdin 原文（截断）、
解析出的文案和 POST 结果/失败原因，便于排查“桌宠没收到消息”的问题。
"""
import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime

PORT = os.environ.get("PET_AGENT_PORT", "46231")
URL = f"http://127.0.0.1:{PORT}/agent-task"
LOG_PATH = os.environ.get("PET_AGENT_LOG", os.path.expanduser("~/.claude/agent-notify.log"))


def log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fp:
            fp.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
    except Exception:
        pass  # 日志失败绝不影响 hook 流程


def extract_text(data: dict) -> str:
    msg = data.get("message")
    if isinstance(msg, dict):
        specific = msg.get("hookSpecificOutput") or {}
        for key in ("request_text", "question", "text", "message"):
            value = specific.get(key) or msg.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""
    if isinstance(msg, str) and msg.strip():
        return msg.strip()
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["need-input", "task-complete"], default="need-input")
    parser.add_argument("--text", default="")
    args = parser.parse_args()
    log(f"invoke kind={args.kind} argv={sys.argv[1:]}")

    raw = sys.stdin.read().strip()
    log(f"stdin={raw[:500] if raw else '(empty)'}")
    data: dict = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                data = parsed
            else:
                log("stdin parsed but not a dict")
        except json.JSONDecodeError as exc:
            data = {}
            log(f"stdin not JSON: {exc}")

    text = args.text.strip() or extract_text(data)
    # Claude 系统英文文案转中文，桌面泡泡里更好读
    text = (
        text.replace("Claude needs your permission", "Claude 需要你的确认")
        .replace("Claude needs your input", "Claude 需要你的输入")
        .replace("Claude is waiting for your input", "Claude 正在等你输入")
        .replace("Claude is waiting for your response", "Claude 正在等你回复")
        .replace("Claude is finished", "Claude 已完成")
    )
    if not text:
        text = "Claude 需要你的输入" if args.kind == "need-input" else "Claude 会话已结束"
    text = text[:400]

    session_id = data.get("session_id") or ""
    event: dict = {"kind": args.kind, "text": text, "source": "claude-code"}
    if isinstance(session_id, str) and session_id:
        event["sessionId"] = session_id[:200]
    log(f"event={json.dumps(event, ensure_ascii=False)[:400]}")

    body = json.dumps(event, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            log(f"POST {URL} -> {resp.status} {resp.read().decode('utf-8', 'replace')[:100]}")
    except Exception as exc:
        log(f"POST {URL} FAILED: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
