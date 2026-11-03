#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「任务/会议提醒」送到本地桌宠后台（A 方案扩展：请求触发后端数据变更）。

用法（Claude Code 里让 Claude 执行即可，Claude 负责把自然语言拆成 text + 时间）：
  python3 tools/add-reminder.py --text "今天下午 3 点有个会议" --at "今天 15:00"
  python3 tools/add-reminder.py --text "明天 9:30 站会" --at "明天 09:30"
  python3 tools/add-reminder.py --text "发版" --at "2026-11-05T18:00:00+08:00"

--at 支持的格式：
  今天 HH:MM / 明天 HH:MM / HH:MM（今天）/ ISO 时间（如 2026-11-05T18:00:00+08:00）/
  YYYY-MM-DD HH:MM（按本机时区）

脚本解析出 ISO 时间后 POST 到桌宠本地端点（默认 http://127.0.0.1:46231/reminders，
可用环境变量 PET_AGENT_PORT 覆盖端口）。桌宠到点会弹提醒 + 猫做动作。
"""

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request


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


def main() -> int:
    parser = argparse.ArgumentParser(description="把会议/任务提醒送到本地桌宠后台")
    parser.add_argument("--text", required=True, help="提醒内容（如：今天下午 3 点有个会议）")
    parser.add_argument("--at", required=True, help="时间：今天 15:00 / 明天 09:30 / 15:00 / ISO")
    parser.add_argument("--lead", type=int, default=0, help="提前提醒分钟数（0=到点提醒；如 --lead 5 = 提前 5 分钟）")
    parser.add_argument("--port", help="桌宠本地端口（默认读 PET_AGENT_PORT，再默认 46231）")
    args = parser.parse_args()

    if not (0 <= args.lead <= 1440):
        print(f"错误：--lead 需在 0~1440 之间（分钟），当前 {args.lead}", file=sys.stderr)
        return 2

    try:
        due = parse_at(args.at)
    except ValueError as err:
        print(f"错误：{err}", file=sys.stderr)
        return 2

    due_at = due.isoformat()
    port = args.port or os.environ.get("PET_AGENT_PORT") or "46231"
    url = f"http://127.0.0.1:{port}/reminders"
    payload = {"text": args.text.strip(), "dueAt": due_at}
    if args.lead:
        payload["leadMinutes"] = args.lead
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as err:  # 网络/校验失败统一提示
        print(f"请求桌宠失败：{err}", file=sys.stderr)
        return 1
    if not data.get("ok"):
        print(f"桌宠返回失败：{data}", file=sys.stderr)
        return 1
    lead_txt = f"，提前 {args.lead} 分钟" if args.lead else ""
    print(f"已添加提醒：{args.text.strip()} @ {due_at}{lead_txt}（{url}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
