#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「任务/会议提醒」送到本地桌宠后台，并支持查询 / 更新 / 删除已有提醒。

用法（Claude Code 里让 Claude 执行即可，Claude 负责把自然语言拆成 text + 时间）：

  # 新增
  python3 tools/add-reminder.py --text "今天下午 3 点有个会议" --at "今天 15:00"
  python3 tools/add-reminder.py --text "明天 9:30 站会" --at "明天 09:30"
  python3 tools/add-reminder.py --text "发版" --at "2026-11-05T18:00:00+08:00"

  # 查询
  python3 tools/add-reminder.py --list                 # 列出全部提醒
  python3 tools/add-reminder.py --id <提醒ID>          # 查询单条

  # 更新（只传需要变更的字段；--lead 传 0 表示取消提前提醒）
  python3 tools/add-reminder.py --id <提醒ID> --update --text "改后的内容" --at "明天 10:00" --lead 5

  # 删除
  python3 tools/add-reminder.py --id <提醒ID> --delete

--at 支持的格式：
  今天 HH:MM / 明天 HH:MM / HH:MM（今天）/ ISO 时间（如 2026-11-05T18:00:00+08:00）/
  YYYY-MM-DD HH:MM（按本机时区）

脚本解析出 ISO 时间后请求桌宠本地端点（默认 http://127.0.0.1:46231，
可用环境变量 PET_AGENT_PORT 覆盖端口）。桌宠到点会弹提醒 + 猫做动作。
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request


def base_url(port: str) -> str:
    return f"http://127.0.0.1:{port}/reminders"


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


def fmt_reminder(r: dict) -> str:
    lead = r.get("leadMinutes")
    lead_txt = f"，提前 {lead} 分钟" if lead else ""
    return f"[{r.get('id', '')}] {r.get('text', '')} @ {r.get('dueAt', '')}{lead_txt}"


def main() -> int:
    parser = argparse.ArgumentParser(description="把会议/任务提醒送到本地桌宠后台，支持查询/更新/删除")
    parser.add_argument("--text", help="提醒内容（新增/更新用）")
    parser.add_argument("--at", help="时间：今天 15:00 / 明天 09:30 / 15:00 / ISO")
    parser.add_argument("--lead", type=int, default=None, help="提前提醒分钟数（0=到点提醒；--lead 5 = 提前 5 分钟）")
    parser.add_argument("--id", help="已有提醒 ID（查询/更新/删除用）")
    parser.add_argument("--list", action="store_true", help="列出全部提醒")
    parser.add_argument("--update", action="store_true", help="按 --id 更新提醒（配合 --text/--at/--lead）")
    parser.add_argument("--delete", action="store_true", help="按 --id 删除提醒")
    parser.add_argument("--port", help="桌宠本地端口（默认读 PET_AGENT_PORT，再默认 46231）")
    args = parser.parse_args()

    if args.lead is not None and not (0 <= args.lead <= 1440):
        print(f"错误：--lead 需在 0~1440 之间（分钟），当前 {args.lead}", file=sys.stderr)
        return 2

    port = args.port or os.environ.get("PET_AGENT_PORT") or "46231"
    url = base_url(port)

    # 列出全部
    if args.list:
        status, data = request("GET", url)
        if status != 200 or not data.get("ok"):
            print(f"请求桌宠失败：{data}", file=sys.stderr)
            return 1
        reminders = data.get("reminders", [])
        if not reminders:
            print("暂无提醒")
            return 0
        for r in reminders:
            print(fmt_reminder(r))
        return 0

    # 按 ID 查询 / 更新 / 删除
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
            if not payload:
                print("错误：--update 至少需要提供 --text / --at / --lead 之一", file=sys.stderr)
                return 2
            status, data = request("PUT", item_url, payload)
            if status != 200 or not data.get("ok"):
                print(f"更新失败：{data}", file=sys.stderr)
                return 1
            print(f"已更新提醒：{fmt_reminder(data.get('reminder', {}))}")
            return 0

        # 默认：查询单条
        status, data = request("GET", item_url)
        if status != 200 or not data.get("ok"):
            print(f"查询失败：{data}", file=sys.stderr)
            return 1
        print(fmt_reminder(data.get("reminder", {})))
        return 0

    # 新增
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
    status, data = request("POST", url, payload)
    if status != 200 or not data.get("ok"):
        print(f"桌宠返回失败：{data}", file=sys.stderr)
        return 1
    lead_txt = f"，提前 {args.lead} 分钟" if args.lead else ""
    print(f"已添加提醒：{args.text.strip()} @ {due.isoformat()}{lead_txt}（{url}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
