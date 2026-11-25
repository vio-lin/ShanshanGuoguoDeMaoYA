#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「待办 / 任务 / 会议提醒」送到本地桌宠后台，并支持查询 / 更新 / 关闭 / 延期 / 删除。

默认走「待办」接口（/todos）；加 --legacy 走旧「提醒」接口（/reminders）。

用法（Claude Code 里让 Claude 执行即可，Claude 负责把自然语言拆成标题 + 时间）：

  # 新建待办（标题 + 可选内容 + 截止时间）
  python3 tools/add-reminder.py --text "给李四回邮件" --at "今天 15:00"
  python3 tools/add-reminder.py --text "版本发布" --content "打 tag、发 dmg、写 release notes" --at "明天 09:30" --priority 1

  # 查询
  python3 tools/add-reminder.py --list                 # 列出全部待办
  python3 tools/add-reminder.py --id <待办ID>          # 查询单条

  # 更新（只传需要变更的字段）
  python3 tools/add-reminder.py --id <待办ID> --update --text "改后的标题" --at "明天 10:00" --priority 2

  # 关闭 / 重新打开
  python3 tools/add-reminder.py --id <待办ID> --close
  python3 tools/add-reminder.py --id <待办ID> --reopen

  # 延期（分钟，会写入延期历史）
  python3 tools/add-reminder.py --id <待办ID> --postpone 60

  # 删除
  python3 tools/add-reminder.py --id <待办ID> --delete

--at 支持的格式：
  今天 HH:MM / 明天 HH:MM / HH:MM（今天）/ ISO 时间（如 2026-11-05T18:00:00+08:00）/
  YYYY-MM-DD HH:MM（按本机时区）

脚本解析出 ISO 时间后请求桌宠本地端点（默认 http://127.0.0.1:46231，
可用环境变量 PET_AGENT_PORT 覆盖端口）。桌宠到期会弹提醒，过期后每天继续提醒。
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_PATH = "todos"

PRIORITY_LABELS = {1: "P1 最高", 2: "P2 高", 3: "P3 中", 4: "P4 低", 5: "P5 最低"}


def base_url(port: str, path: str) -> str:
    return f"http://127.0.0.1:{port}/{path}"


def request(method: str, url: str, payload=None, timeout: float = 3.0):
    body = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        try:
            data = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            data = {"error": raw}
        return err.code, data


def parse_at(raw: str) -> dt.datetime:
    """解析 --at 为本地时区 datetime。"""
    s = raw.strip()
    now = dt.datetime.now().astimezone()
    iso_formats = (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
    )
    for fmt in iso_formats:
        try:
            parsed = dt.datetime.strptime(s, fmt)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=now.tzinfo)
            return parsed
        except ValueError:
            continue
    # 今天/明天 HH:MM
    for prefix, delta in (("今天", 0), ("明天", 1)):
        if s.startswith(prefix):
            rest = s[len(prefix):].strip().lstrip(" ")
            try:
                hm = dt.datetime.strptime(rest, "%H:%M").time()
            except ValueError:
                break
            base = (now + dt.timedelta(days=delta)).date()
            return dt.datetime.combine(base, hm, tzinfo=now.tzinfo)
    # 纯 HH:MM → 今天
    try:
        hm = dt.datetime.strptime(s, "%H:%M").time()
        return dt.datetime.combine(now.date(), hm, tzinfo=now.tzinfo)
    except ValueError:
        pass
    raise ValueError(
        f"无法解析时间：{raw!r}。支持：'今天 HH:MM' / '明天 HH:MM' / 'HH:MM' / ISO 时间"
    )


REPEAT_LABELS = {
    "hourly": "每小时",
    "daily": "每天",
    "weekdays": "工作日",
    "weekly": "每周",
}


def fmt_reminder(r: dict) -> str:
    lead = r.get("leadMinutes")
    lead_txt = f"，提前 {lead} 分钟" if lead else ""
    repeat_txt = f"，{REPEAT_LABELS[r['repeat']]}" if r.get("repeat") in REPEAT_LABELS else ""
    return f"[{r.get('id', '')}] {r.get('text', '')} @ {r.get('dueAt', '')}{lead_txt}{repeat_txt}"


def fmt_todo(t: dict) -> str:
    priority = t.get("priority", 3)
    status = "已关闭" if t.get("status") == "closed" else "进行中"
    content = f" — {t['content']}" if t.get("content") else ""
    postponements = t.get("postponements") or []
    postpone_txt = f"，延期 {len(postponements)} 次" if postponements else ""
    return (
        f"[{t.get('id', '')}] P{priority} {status} {t.get('title', '')}"
        f"{content} @ {t.get('dueAt', '')}{postpone_txt}"
    )


def fetch_list(url: str, key: str, fmt) -> int:
    status, data = request("GET", url)
    if status != 200 or not data.get("ok"):
        print(f"请求桌宠失败：{data}", file=sys.stderr)
        return 1
    items = data.get(key, [])
    if not items:
        print("暂无记录")
        return 0
    for item in items:
        print(fmt(item))
    return 0


def handle_todo(args, port: str) -> int:
    url = base_url(port, "todos")

    if args.list:
        return fetch_list(url, "todos", fmt_todo)

    if args.id:
        item_url = f"{url}/{args.id}"

        if args.delete:
            status, data = request("DELETE", item_url)
            if status != 200 or not data.get("ok"):
                print(f"删除失败：{data}", file=sys.stderr)
                return 1
            print(f"已删除待办：{args.id}")
            return 0

        if args.close or args.reopen:
            action = "close" if args.close else "reopen"
            status, data = request("POST", f"{item_url}/{action}")
            if status != 200 or not data.get("ok"):
                print(f"操作失败：{data}", file=sys.stderr)
                return 1
            print(f"已{'关闭' if args.close else '重新打开'}待办：{args.id}")
            return 0

        if args.postpone is not None:
            if not (1 <= args.postpone <= 720):
                print("错误：--postpone 需在 1~720 分钟之间", file=sys.stderr)
                return 2
            status, data = request("POST", f"{item_url}/postpone", {"minutes": args.postpone})
            if status != 200 or not data.get("ok"):
                print(f"延期失败：{data}", file=sys.stderr)
                return 1
            print(f"已延期 {args.postpone} 分钟：{fmt_todo(data.get('todo', {}))}")
            return 0

        if args.update:
            payload: dict = {}
            if args.text is not None:
                payload["title"] = args.text.strip()
            if args.content is not None:
                payload["content"] = args.content.strip()
            if args.at is not None:
                try:
                    payload["dueAt"] = parse_at(args.at).isoformat()
                except ValueError as err:
                    print(f"错误：{err}", file=sys.stderr)
                    return 2
            if args.priority is not None:
                payload["priority"] = args.priority
            if not payload:
                print("错误：--update 至少需要提供 --text / --content / --at / --priority 之一", file=sys.stderr)
                return 2
            status, data = request("PUT", item_url, payload)
            if status != 200 or not data.get("ok"):
                print(f"更新失败：{data}", file=sys.stderr)
                return 1
            print(f"已更新待办：{fmt_todo(data.get('todo', {}))}")
            return 0

        status, data = request("GET", item_url)
        if status != 200 or not data.get("ok"):
            print(f"查询失败：{data}", file=sys.stderr)
            return 1
        print(fmt_todo(data.get("todo", {})))
        return 0

    # 新建
    if not args.text or not args.at:
        print("错误：新建需要 --text 与 --at（或使用 --list / --id 查询、更新、关闭、延期、删除）", file=sys.stderr)
        return 2

    try:
        due = parse_at(args.at)
    except ValueError as err:
        print(f"错误：{err}", file=sys.stderr)
        return 2

    payload = {"title": args.text.strip(), "dueAt": due.isoformat()}
    if args.content:
        payload["content"] = args.content.strip()
    if args.priority is not None:
        payload["priority"] = args.priority
    status, data = request("POST", url, payload)
    if status != 200 or not data.get("ok"):
        print(f"桌宠返回失败：{data}", file=sys.stderr)
        return 1
    priority_txt = f"，{PRIORITY_LABELS[args.priority]}" if args.priority in PRIORITY_LABELS else ""
    print(f"已添加待办：{args.text.strip()} @ {due.isoformat()}{priority_txt}（{url}）")
    return 0


def handle_legacy_reminder(args, port: str) -> int:
    url = base_url(port, "reminders")

    if args.list:
        return fetch_list(url, "reminders", fmt_reminder)

    if args.id:
        item_url = f"{url}/{args.id}"

        if args.delete:
            status, data = request("DELETE", item_url)
            if status != 200 or not data.get("ok"):
                print(f"删除失败：{data}", file=sys.stderr)
                return 1
            print(f"已删除提醒：{args.id}")
            return 0

        if args.update:
            payload: dict = {}
            if args.text is not None:
                payload["text"] = args.text.strip()
            if args.at is not None:
                try:
                    payload["dueAt"] = parse_at(args.at).isoformat()
                except ValueError as err:
                    print(f"错误：{err}", file=sys.stderr)
                    return 2
            if args.lead is not None:
                payload["leadMinutes"] = args.lead
            if args.repeat is not None:
                payload["repeat"] = None if args.repeat == "none" else args.repeat
            if not payload:
                print("错误：--update 至少需要提供 --text / --at / --lead / --repeat 之一", file=sys.stderr)
                return 2
            status, data = request("PUT", item_url, payload)
            if status != 200 or not data.get("ok"):
                print(f"更新失败：{data}", file=sys.stderr)
                return 1
            print(f"已更新提醒：{fmt_reminder(data.get('reminder', {}))}")
            return 0

        status, data = request("GET", item_url)
        if status != 200 or not data.get("ok"):
            print(f"查询失败：{data}", file=sys.stderr)
            return 1
        print(fmt_reminder(data.get("reminder", {})))
        return 0

    if not args.text or not args.at:
        print("错误：新增需要 --text 与 --at（或使用 --list / --id 查询、更新、删除）", file=sys.stderr)
        return 2

    try:
        due = parse_at(args.at)
    except ValueError as err:
        print(f"错误：{err}", file=sys.stderr)
        return 2

    payload = {"text": args.text.strip(), "dueAt": due.isoformat()}
    if args.lead:
        payload["leadMinutes"] = args.lead
    if args.repeat and args.repeat != "none":
        payload["repeat"] = args.repeat
    status, data = request("POST", url, payload)
    if status != 200 or not data.get("ok"):
        print(f"桌宠返回失败：{data}", file=sys.stderr)
        return 1
    lead_txt = f"，提前 {args.lead} 分钟" if args.lead else ""
    repeat_txt = f"，{REPEAT_LABELS[args.repeat]}" if args.repeat and args.repeat != "none" else ""
    print(f"已添加提醒：{args.text.strip()} @ {due.isoformat()}{lead_txt}{repeat_txt}（{url}）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="把待办/提醒送到本地桌宠后台，支持查询/更新/关闭/延期/删除")
    parser.add_argument("--text", help="待办标题 / 旧提醒内容（新增、更新用）")
    parser.add_argument("--content", help="待办详细内容（可选）")
    parser.add_argument("--at", help="时间：今天 15:00 / 明天 09:30 / 15:00 / ISO")
    parser.add_argument("--priority", type=int, choices=[1, 2, 3, 4, 5], help="优先级 1=最高/红，5=最低/蓝；默认 3")
    parser.add_argument("--lead", type=int, default=None, help="（旧提醒）提前提醒分钟数")
    parser.add_argument(
        "--repeat",
        choices=["none", "hourly", "daily", "weekdays", "weekly"],
        default=None,
        help="（旧提醒）重复规则",
    )
    parser.add_argument("--id", help="已有记录 ID（查询/更新/关闭/延期/删除用）")
    parser.add_argument("--list", action="store_true", help="列出全部记录")
    parser.add_argument("--update", action="store_true", help="按 --id 更新")
    parser.add_argument("--delete", action="store_true", help="按 --id 删除")
    parser.add_argument("--close", action="store_true", help="按 --id 关闭待办")
    parser.add_argument("--reopen", action="store_true", help="按 --id 重新打开待办")
    parser.add_argument("--postpone", type=int, default=None, help="按 --id 延期 N 分钟（写入延期历史）")
    parser.add_argument("--legacy", action="store_true", help="走旧 /reminders 接口（默认 /todos）")
    parser.add_argument("--port", help="桌宠本地端口（默认读 PET_AGENT_PORT，再默认 46231）")
    args = parser.parse_args()

    if args.lead is not None and not (0 <= args.lead <= 1440):
        print(f"错误：--lead 需在 0~1440 之间（分钟），当前 {args.lead}", file=sys.stderr)
        return 2

    port = args.port or os.environ.get("PET_AGENT_PORT") or "46231"
    if args.legacy:
        return handle_legacy_reminder(args, port)
    return handle_todo(args, port)


if __name__ == "__main__":
    sys.exit(main())
