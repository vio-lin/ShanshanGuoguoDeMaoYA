#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把桌宠「pet-reminder」技能安装到 Claude Code 的全局技能目录。

Claude Code Agent Skills 规范：技能放在 ~/.claude/skills/<skill-name>/SKILL.md，
所有项目可用；frontmatter 的 description 里含触发短语（「小猫咪 帮我」等），
Claude 在用户提出相关请求时自动加载该技能，技能正文指示它向桌宠本地端点
POST /reminders 发送提醒。

安装内容：
  ~/.claude/skills/pet-reminder/SKILL.md          ← tools/skills/pet-reminder/SKILL.md
  ~/.claude/skills/pet-reminder/scripts/add-reminder.py  ← tools/add-reminder.py（技能自包含，不依赖工程路径）

用法：
  python3 tools/install-claude-skill.py            # 安装/更新技能（幂等）
  python3 tools/install-claude-skill.py --check    # 检查是否已安装且为最新
  python3 tools/install-claude-skill.py --dry-run  # 只预览将执行的操作
  python3 tools/install-claude-skill.py --uninstall --dry-run   # 预览卸载
  python3 tools/install-claude-skill.py --uninstall            # 卸载（保留备份）
  python3 tools/install-claude-skill.py --list     # 列出全局技能目录
"""

import argparse
import datetime as dt
import os
import shutil
import sys

SKILL_NAME = "pet-reminder"
HOME = os.path.expanduser("~")
SKILLS_ROOT = os.path.join(HOME, ".claude", "skills")
DEST_DIR = os.path.join(SKILLS_ROOT, SKILL_NAME)

HERE = os.path.dirname(os.path.abspath(__file__))


def resolve_sources() -> tuple:
    """返回 (SKILL.md 源, add-reminder.py 源)。

    兼容两种布局：
    - 源码运行：脚本在 <工程>/tools/，技能目录在 <工程>/tools/skills/，提醒脚本在 <工程>/tools/
    - 打包产物：extraResource 把三者放进 <app>/Contents/Resources/（脚本与 add-reminder.py、skills/ 并列）
    """
    candidates = [
        (os.path.join(HERE, "skills", SKILL_NAME, "SKILL.md"), os.path.join(HERE, "add-reminder.py")),  # 打包布局
        (os.path.join(HERE, "skills", SKILL_NAME, "SKILL.md"), os.path.join(os.path.dirname(HERE), "tools", "add-reminder.py")),  # 源码布局
    ]
    for md, py in candidates:
        if os.path.isfile(md) and os.path.isfile(py):
            return md, py
    raise SystemExit(
        "错误：找不到技能源文件（源码布局需 <工程>/tools/skills/pet-reminder/SKILL.md 与 "
        "<工程>/tools/add-reminder.py；打包布局需 Resources/skills/ 与 Resources/add-reminder.py）"
    )


SRC_SKILL_MD, SRC_REMINDER_PY = resolve_sources()

FILES = (
    (SRC_SKILL_MD, os.path.join(DEST_DIR, "SKILL.md")),
    (SRC_REMINDER_PY, os.path.join(DEST_DIR, "scripts", "add-reminder.py")),
)


def file_content_equal(src: str, dst: str) -> bool:
    if not os.path.exists(dst):
        return False
    with open(src, "rb") as f1, open(dst, "rb") as f2:
        return f1.read() == f2.read()


def installed_status() -> list:
    """返回 [(dest, exists, up_to_date)]。"""
    return [
        (dest, os.path.exists(dest), file_content_equal(src, dest))
        for src, dest in FILES
    ]


def is_installed_up_to_date() -> bool:
    return all(up for _, _exists, up in installed_status())


def backup_dest() -> str | None:
    if not os.path.exists(DEST_DIR):
        return None
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{DEST_DIR}.bak-{stamp}"
    shutil.copytree(DEST_DIR, backup)
    return backup


def do_install(verbose: bool = True) -> None:
    backup = backup_dest()
    for src, dest in FILES:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
    if verbose:
        print(f"已安装技能：{SKILL_NAME} -> {DEST_DIR}")
        if backup:
            print(f"旧版本已备份：{backup}")


def do_uninstall() -> None:
    backup = backup_dest()
    if not os.path.exists(DEST_DIR):
        print(f"未安装：{DEST_DIR}")
        return
    shutil.rmtree(DEST_DIR)
    print(f"已卸载：{DEST_DIR}")
    if backup:
        print(f"已备份：{backup}")


def plan_lines() -> list:
    lines = []
    for src, dest in FILES:
        action = "更新" if os.path.exists(dest) else "安装"
        lines.append(f"{action} {dest}  <-  {src}")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="安装/卸载桌宠 pet-reminder 技能到 Claude 全局技能目录")
    parser.add_argument("--check", action="store_true", help="检查是否已安装且为最新")
    parser.add_argument("--dry-run", action="store_true", help="只预览操作，不实际写入")
    parser.add_argument("--uninstall", action="store_true", help="卸载技能（保留备份）")
    parser.add_argument("--list", action="store_true", help="列出全局技能目录")
    args = parser.parse_args()

    if args.list:
        if not os.path.isdir(SKILLS_ROOT):
            print("全局技能目录不存在（尚未安装任何技能）：", SKILLS_ROOT)
            return 0
        names = sorted(
            name for name in os.listdir(SKILLS_ROOT)
            if os.path.isdir(os.path.join(SKILLS_ROOT, name))
        )
        if not names:
            print("全局技能目录为空：", SKILLS_ROOT)
        else:
            print("已安装技能：")
            for name in names:
                md = os.path.join(SKILLS_ROOT, name, "SKILL.md")
                print(f"  - {name}  ({'有 SKILL.md' if os.path.exists(md) else '缺 SKILL.md'})")
        return 0

    if args.check:
        if not os.path.isdir(DEST_DIR):
            print(f"未安装：{DEST_DIR}")
            return 1
        for dest, exists, up in installed_status():
            state = "最新" if up else ("存在但内容不一致" if exists else "缺失")
            print(f"  {state}: {dest}")
        if is_installed_up_to_date():
            print(f"技能 {SKILL_NAME} 已是最新配置。")
            return 0
        print(f"技能 {SKILL_NAME} 需要更新（运行 install 或 install-claude-hook 即可）。")
        return 1

    if args.uninstall:
        if args.dry_run:
            print(f"将卸载并备份：{DEST_DIR}")
        else:
            do_uninstall()
        return 0

    # 默认：安装/更新
    if args.dry_run:
        print("将执行：")
        for line in plan_lines():
            print("  " + line)
        return 0

    if is_installed_up_to_date():
        print(f"技能 {SKILL_NAME} 已是最新配置，无需变更。")
        return 0

    do_install()
    print("安装完成。在 Claude Code 里说「小猫咪 帮我加个会议，今天下午 3 点」即可触发。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
