# 山山国国的猫呀 🐱

一只会待在桌面上的布偶猫桌宠（macOS + Windows），支持多只宠物随时切换。

## 猫猫档案

> 此猫，名哈哈，布偶，五岁，重十斤。  
> 五千购得，主食皇家猫粮，辅以鲜鸡胸肉。  
> 一身长毛堆雪，蓝眸静如寒潭。  
> ---  
> 它不必出剑，静卧，便是它的江湖。

第二只猫「妮妮」（Nini）也已入驻：蓬松白毛、浅灰面纹、蓝眼粉鼻的布偶，性格乖巧安静。

在系统托盘右键 →「🐾 切换宠物」即可在哈哈 / 妮妮之间切换，托盘图标与桌宠形象会同步更新。

由海豹双色布偶猫照片生成的桌面宠物，支持待机呼吸、眨眼、打哈欠、翘尾巴，以及 4 个右键互动：

| 互动 | 说明 |
|---|---|
| 🚶 散步去 | 左右来回走动，自动镜像 |
| 🦘 蹦高高 | 跳跃抛物线动画 |
| 🐾 悄悄走 | 匍匐前进 |
| 💩 埋粑粑 | 扒拉埋屎 |

## 运行

```bash
npm ci          # 安装依赖（国内可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
npm run dev     # 源码开发预览
```

## 打包

```bash
npm run make:mac    # macOS: DMG + ZIP（需在 macOS 上）
npm run make:win    # Windows: EXE + ZIP（需在 Windows 上）
```

GitHub Actions 已配置自动构建：推送到 `main` 分支自动出双平台安装包（Artifacts）；打 `v*` tag 自动发布到 Releases。

## 技术栈

- Electron + Electron Forge + Webpack + TypeScript
- 角色素材由 Seedream 生成，Apple Vision 语义抠图处理

## 🤖 接入 Agent 任务状态（Claude Code）

桌宠内置一个本地 Agent Bridge（只监听 `127.0.0.1`，默认端口 `46231`），外部 agent 在「任务完成 / 需要输入」时推送一条事件，桌宠就会：
- **任务完成**：播放开心提醒动作 + 泡泡「🤖 Agent 完成 · …」（绿色描边，30 秒后自动消失，点击可提前关闭）
- **需要输入**：播放注意强调动作 + 泡泡「🤖 Agent 需要你 · …」（橙色描边，同样可停留/点击关闭）

### 0. 一键安装（推荐）

仓库已带安装脚本，自动把 `tools/agent-notify.py` 注册进 `~/.claude/settings.json`（幂等：已存在相同配置时直接跳过；与 `ee-agent-workflow` 等已有 hooks 共存）：

```bash
python3 tools/install-claude-hook.py            # 安装
python3 tools/install-claude-hook.py --check    # 检查是否已装
python3 tools/install-claude-hook.py --dry-run  # 只预览变更
python3 tools/install-claude-hook.py --uninstall  # 卸载
```

脚本只读写 `hooks` 区块、写入前自动备份 `settings.json`、不会打印 env/令牌等敏感字段；仓库移动后重跑一次会自动把旧路径替换为当前绝对路径。

### 1. 手工配置 Claude Code hooks

把下方片段合并进 `~/.claude/settings.json`（全局，所有项目生效；或放进项目 `.claude/settings.json`），把两处 `python3 .../agent-notify.py` 换成仓库里 `tools/agent-notify.py` 的绝对路径（新版嵌套格式；旧版 `{type,command}` 平铺格式同样兼容）：

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /绝对路径/pet-app/tools/agent-notify.py --kind need-input"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /绝对路径/pet-app/tools/agent-notify.py --kind task-complete --text \"Claude 会话已结束\""
          }
        ]
      }
    ]
  }
}
```

- `Notification`：Claude 等待你的输入或权限时触发（对应「✋ 需要输入」泡泡）；
- `SessionEnd`（可选）：一次会话结束时触发（对应「✅ 任务完成」泡泡）。

改完保存即可，无需重启桌宠；hook 里未显式设置 `PET_AGENT_PORT` 时默认走 `46231`。

### 2. 验证

先让桌宠跑起来（`npm run dev`），再随便开一个 Claude Code 会话让它执行需要你确认的工具调用，桌宠应弹出橙色泡泡并播放强调动作。也可以手动验证端点：

```bash
curl -X POST http://127.0.0.1:46231/agent-task \
  -H 'Content-Type: application/json' \
  -d '{"kind":"need-input","text":"测试：请确认执行","source":"claude-code"}'
```

### 3. 把任务/会议送到桌宠后台（提醒）

Claude Code 里直接对 Claude 说「帮我定个任务，今天下午 3 点有个会议」，它会执行仓库里的 `tools/add-reminder.py`，把内容+时间 POST 到桌宠 `/reminders` 端点，桌宠到点弹提醒并做动作：

```bash
python3 tools/add-reminder.py --text "今天下午 3 点有个会议" --at "今天 15:00"
python3 tools/add-reminder.py --text "明天 9:30 站会" --at "明天 09:30"
python3 tools/add-reminder.py --text "发版" --at "2026-11-05T18:00:00+08:00"
python3 tools/add-reminder.py --text "提前 5 分钟提醒的会议" --at "今天 15:00" --lead 5
```

- `--at` 支持：`今天 HH:MM` / `明天 HH:MM` / `HH:MM`（今天）/ ISO 时间；
- `--lead N`（可选，0~1440）：提前 N 分钟提醒。缺省/0 = 到点提醒；带提前量时提前那次即唯一提醒，到点不再重复；
- 底层等价于 `POST http://127.0.0.1:46231/reminders`，body `{"text":"…","dueAt":"<ISO 时间>","leadMinutes":5}`（`leadMinutes` 可选，同上语义），复用桌宠提醒系统（持久化到 `reminders.json`，重启不丢）。

### 4. 一键安装 Claude 技能（pet-reminder）

按 Claude Code 的 Agent Skills 机制做成的技能：装到 `~/.claude/skills/pet-reminder/` 全局目录，所有项目可用。在 Claude Code 里说「**小猫咪 帮我**加个会议，今天下午 3 点」即可触发，Claude 会按技能指示把内容+时间 POST 到桌宠后台（也可直接 `/pet-reminder` 显式调用）：

```bash
python3 tools/install-claude-skill.py            # 安装/更新（幂等）
python3 tools/install-claude-skill.py --check    # 检查是否最新
python3 tools/install-claude-skill.py --list     # 列出全局技能
python3 tools/install-claude-skill.py --uninstall --dry-run
```

技能包含：SKILL.md（frontmatter 含「小猫咪 帮我」触发短语）+ 自包含的 `scripts/add-reminder.py`，请求对象与接口地址写死在技能正文里。

### 5. 安全与自定义

- Bridge 只监听 `127.0.0.1` 回环地址，不暴露到局域网；body 上限 64KB，payload 经白名单校验（`agent-task`：`kind` 只允许 `task-complete` / `need-input`、`text` 最长 400 字；`reminders`：`text` 最长 500 字、`dueAt` 必须可解析为时间），非法请求一律 4xx。
- 端口可通过环境变量 `PET_AGENT_PORT` 修改（hook 脚本与 `add-reminder.py` 自动读取同一环境变量）；端口被占用时桌宠会启动失败并提示，请换端口并同步改 hook。
- 其他 agent（如自定义脚本、CI 通知）只要向 `/agent-task` POST 同样的 `{kind, text}` 结构即可接入；同一事件 3 秒内自动去重。


## 版本更新

| 版本号 | 时间 | 改动内容 |
|---|---|---|
| 1.3.1 | 2026-11-03 | 修复打包版面板「安装技能」失败：技能安装器与资源（install-claude-skill.py / add-reminder.py / skills）经 extraResource 随包输出为真实文件，打包环境改用 resourcesPath 定位，不再指向不可访问的 asar 内路径 |
| 1.3.0 | 2026-11-03 | Claude Code 打通：Agent 任务状态实时上桌宠（需要输入/任务完成泡泡，多会话堆叠）；「定任务/会议 → 后台提醒」本地接口（`POST /reminders`，支持 `leadMinutes` 提前提醒）；一键安装 Claude hooks 与 `pet-reminder` 技能（`~/.claude/skills`），小屋面板新增「🤖 Claude 技能」安装入口与案例按钮 |
| 1.2.0 | 2026-10-14 | 节日待机系统：按日期自动切换特殊待机帧（首个节日：妮妮生日 08-19，戴生日帽+蛋糕）；小屋面板改为 tab 布局（主页/节日/更新日志），节日页支持预览任意节日效果；纪念日配置可通过 `src/anniversaries/index.json` 扩展 |
| 1.1.0 | 2026-10-10 | 多宠物支持：新增第二只宠物「妮妮」（Nini）并补齐整套 50 帧素材；托盘菜单新增「🐾 切换宠物」，切换时桌宠形象与托盘图标同步更新；素材与 QA 工具链多宠物化 |
| 1.0.1 | 2026-09-29 | 新增自动更新：托盘菜单与小屋面板支持「检查更新」，GitHub Releases 有新版本时弹窗/系统通知提示并直达下载页 |
| 1.0.0 | 2026-09-29 | 首发版本：布偶猫「哈哈」桌宠上线，支持待机呼吸、眨眼、打哈欠、翘尾巴及 4 个右键互动（散步去/蹦高高/悄悄走/埋粑粑）；完成素材白边治理与托盘图标透明化修复；原图素材移出 git 跟踪，仓库历史瘦身 |

---

Code by Doubao 🐱
