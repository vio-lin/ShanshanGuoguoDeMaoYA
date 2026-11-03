#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键安装 Claude Code hooks 配置（A 方案：Claude hook → agent-notify.py → 本地桌宠主应用）。

把本仓库 tools/agent-notify.py 注册到 ~/.claude/settings.json 的 hooks：
  - Notification  → agent-notify.py --kind need-input   （Claude 需要输入/确认时）
  - SessionEnd    → agent-notify.py --kind task-complete （会话结束时）

特性：
  - 幂等：已存在相同配置时跳过，重复执行不产生重复条目
  - 共存：保留 settings.json 中其它 hooks（如 ee-agent-workflow 的 SessionStart/Stop/UserPromptSubmit）
  - 安全：只读写 hooks 区块；自动备份；不打印 env/令牌等敏感字段
  - 可卸载：--uninstall 移除本脚本添加的条目

用法：
  python3 tools/install-claude-hook.py            # 安装（幂等）
  python3 tools/install-claude-hook.py --dry-run  # 只预览将要做的变更
  python3 tools/install-claude-hook.py --check    # 检查是否已安装
  python3 tools/install-claude-hook.py --uninstall  # 卸载
"""

import argparse
import json
import os
import shutil
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
NOTIFY_PY = os.path.join(SCRIPT_DIR, "agent-notify.py")
SETTINGS_PATH = os.path.expanduser("~/.claude/settings.json")

# 本脚本负责的 hooks 条目（command 中的 <NOTIFY> 会被替换为真实绝对路径）
MANAGED_HOOKS = [
    ("Notification", {"matcher": "", "command": "python3 <NOTIFY> --kind need-input"}),
    ("SessionEnd", {"matcher": "", "command": 'python3 <NOTIFY> --kind task-complete --text "Claude 会话已结束"'}),
]


def notify_command(event: str) -> str:
    """返回该 event 对应的完整 command（用绝对路径替换 <NOTIFY>）。"""
    for name, spec in MANAGED_HOOKS:
        if name == event:
            return spec["command"].replace("<NOTIFY>", NOTIFY_PY)
    raise KeyError(event)


def entry_commands(entry) -> list[str]:
    """取一个 hooks 条目里的全部 command。
    兼容新版嵌套格式 {matcher, hooks: [{type, command}]} 与旧版平铺格式 {matcher, command}。
    """
    if not isinstance(entry, dict):
        return []
    if isinstance(entry.get("command"), str):
        return [entry["command"]]
    out = []
    for h in entry.get("hooks") or []:
        if isinstance(h, dict) and isinstance(h.get("command"), str):
            out.append(h["command"])
    return out


def replace_managed_command(entry, target: str) -> bool:
    """把条目内指向 agent-notify.py 的 command 替换为目标路径（仓库移动过）。"""
    if not isinstance(entry, dict):
        return False
    if isinstance(entry.get("command"), str) and "agent-notify.py" in entry["command"]:
        entry["command"] = target
        return True
    for h in entry.get("hooks") or []:
        if isinstance(h, dict) and isinstance(h.get("command"), str) and "agent-notify.py" in h["command"]:
            h["command"] = target
            return True
    return False


def load_settings() -> dict:
    if not os.path.exists(SETTINGS_PATH):
        return {}
    with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_settings(data: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, SETTINGS_PATH)


def backup_if_exists() -> str | None:
    if not os.path.exists(SETTINGS_PATH):
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = f"{SETTINGS_PATH}.bak-{stamp}"
    shutil.copy2(SETTINGS_PATH, bak)
    return bak


def is_managed_command(cmd: str) -> bool:
    return "agent-notify.py" in cmd and NOTIFY_PY in cmd


def plan_install(data: dict) -> list[tuple[str, str]]:
    """返回将要执行的变更列表 [(event, 'add'|'replace'|'skip'), ...]。"""
    actions: list[tuple[str, str]] = []
    hooks = data.setdefault("hooks", {})
    for event, spec in MANAGED_HOOKS:
        target = spec["command"].replace("<NOTIFY>", NOTIFY_PY)
        entries = hooks.get(event, [])
        existing = [c for e in entries for c in entry_commands(e)]
        if target in existing:
            actions.append((event, "skip"))
            continue
        # 已有同事件下其它 agent-notify 路径（仓库移动过）→ 替换；否则新增
        replaced = any(replace_managed_command(e, target) for e in entries)
        if replaced:
            actions.append((event, "replace"))
        else:
            entries.append({"matcher": "", "hooks": [{"type": "command", "command": target}]})
            actions.append((event, "add"))
    return actions


def plan_uninstall(data: dict) -> list[tuple[str, str]]:
    actions: list[tuple[str, str]] = []
    hooks = data.get("hooks", {})
    for event in list(hooks.keys()):
        entries = hooks[event]
        kept: list = []
        for e in entries:
            if not isinstance(e, dict):
                kept.append(e)
                continue
            # 旧版平铺：command 是 managed → 整条移除
            if isinstance(e.get("command"), str) and is_managed_command(e["command"]):
                continue
            # 新版嵌套：过滤 managed 子项
            sub = [h for h in e.get("hooks") or []
                   if not (isinstance(h, dict) and is_managed_command(h.get("command", "")))]
            if len(sub) != len(e.get("hooks") or []):
                if sub:
                    e["hooks"] = sub
                    kept.append(e)
                else:
                    continue
            else:
                kept.append(e)
        if len(kept) != len(entries):
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
            actions.append((event, "removed"))
    return actions


def fmt_action(event: str, action: str) -> str:
    label = {"add": "添加", "replace": "替换", "skip": "已存在，跳过", "removed": "移除"}[action]
    return f"  [{label}] {event}"


def main() -> int:
    parser = argparse.ArgumentParser(description="一键安装 Claude Code hooks 到桌宠 A 方案链路")
    parser.add_argument("--dry-run", action="store_true", help="只预览变更，不写文件")
    parser.add_argument("--check", action="store_true", help="检查是否已安装")
    parser.add_argument("--uninstall", action="store_true", help="卸载本脚本添加的条目")
    args = parser.parse_args()

    if not os.path.exists(NOTIFY_PY):
        print(f"错误：找不到 {NOTIFY_PY}", file=sys.stderr)
        return 1

    data = load_settings()
    hooks = data.get("hooks", {})
    managed_missing = []
    for event, spec in MANAGED_HOOKS:
        target = spec["command"].replace("<NOTIFY>", NOTIFY_PY)
        found = any(target == c for e in hooks.get(event, []) for c in entry_commands(e))
        if not found:
            managed_missing.append((event, spec))

    if args.check:
        if managed_missing:
            print("未完整安装，缺少：")
            for event, _ in managed_missing:
                print(f"  - {event}")
            return 1
        print("已安装（Notification + SessionEnd 均指向当前 agent-notify.py）")
        return 0

    if args.uninstall:
        actions = plan_uninstall(data)
        if not actions:
            print("没有需要卸载的条目（或尚未安装）")
            return 0
        print("将卸载：")
        for event, action in actions:
            print(fmt_action(event, action))
        if not args.dry_run:
            bak = backup_if_exists()
            if bak:
                print(f"备份：{bak}")
            save_settings(data)
        print("完成。卸载后请重启桌宠 / Claude 使配置生效。")
        return 0

    actions = plan_install(data)
    if all(action == "skip" for _, action in actions):
        print("已是最新配置，无需变更。")
        return 0
    print("将更新 ~/.claude/settings.json hooks：")
    for event, action in actions:
        print(fmt_action(event, action))
    if args.dry_run:
        print("（--dry-run，未写入）")
        return 0
    bak = backup_if_exists()
    if bak:
        print(f"备份：{bak}")
    save_settings(data)
    print("完成。验证：")
    print(f"  1) 确认文件：python3 {os.path.abspath(__file__)} --check")
    print("  2) 手动触发：在任意 Claude Code 会话中触发一次需要确认/等待输入的操作")
    print(f"  3) 桌宠应出现泡泡；日志：cat ~/.claude/agent-notify.log | tail")
    return 0


if __name__ == "__main__":
    sys.exit(main())
