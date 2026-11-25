---
name: pet-reminder
description: 当用户说「小猫咪 帮我」或以自然语言要求添加、查询、修改、关闭、延期、删除待办/任务/会议提醒（如"今天下午 3 点有个会议"、"帮我记个待办"、"把刚才的会议改到明天"、"这条先关掉"、"往后推一小时"）时使用。将内容与时间通过本地 HTTP API 发送给桌面宠物应用（布偶猫桌宠）后台，由桌宠持久化、到期提醒，过期后每天继续提醒。只处理待办/任务/会议类请求，其他场景不要使用。
---

# 桌宠待办 / 任务 / 会议

把用户的「待办 / 任务 / 会议」送到本地桌面宠物应用（布偶猫桌宠）后台。桌宠写入待办列表、持久化到本地，到期弹窗提醒；**过期后仍会每天在同一时分继续提醒**，直到用户关闭或改期。支持新建、查询、更新、关闭、重开、延期、删除全流程。

## 后端 API

- 基址：`http://127.0.0.1:46231/todos`（仅本机回环地址；端口可用环境变量 `PET_AGENT_PORT` 覆盖）
- 请求头：`Content-Type: application/json`
- 待办对象字段：

```json
{
  "id": "系统生成的 UUID，查询/更新/关闭/延期/删除时使用",
  "title": "标题（必填，最长 80 字）",
  "content": "详细内容（可选，最长 2000 字）",
  "dueAt": "截止时间，ISO 8601，精确到分，如 2026-11-25T15:00:00+08:00",
  "priority": 3,
  "status": "open | closed",
  "createdAt": "创建时间（系统生成）",
  "updatedAt": "更新时间（系统生成）",
  "closedAt": "关闭时间（关闭后由系统写入）",
  "postponements": [
    { "from": "原时间", "to": "新时间", "at": "延期操作时间", "minutes": 60 }
  ],
  "source": "reminder-migration 表示由旧提醒迁移而来，其他为空"
}
```

- `priority`：1~5，1 最高（红），5 最低（蓝）。不传默认 3。用户说「最高优先级 / 急」用 1，「不急 / 长期跟进」用 5。
- `postponements`：每次延期自动追加一条，桌面端会展示「延期 N 次」和最近一次延期记录。不要手写该字段。
- 状态分栏由桌面端按 `status` 与当前时间派生：进行中 = `open` 且未到期；过期 = `open` 且已过 `dueAt`；已关闭 = `closed`。接口本身只存 `open/closed`。

### 接口一览

| 方法 | 路径 | 用途 | body |
| --- | --- | --- | --- |
| `POST` | `/todos` | 新建待办 | `{title, dueAt, content?, priority?}` |
| `GET` | `/todos` | 查询全部待办 | 无 |
| `GET` | `/todos/:id` | 查询单条 | 无 |
| `PUT` | `/todos/:id` | 更新（部分字段） | `{title?, content?, dueAt?, priority?}` |
| `POST` | `/todos/:id/close` | 关闭待办 | 无 |
| `POST` | `/todos/:id/reopen` | 重新打开 | 无 |
| `POST` | `/todos/:id/postpone` | 延期并记录历史 | `{minutes}`（1~720） |
| `DELETE` | `/todos/:id` | 删除待办 | 无 |

- 新建 / 更新 / 延期成功：`200 {"ok": true, "todo": {...}}`
- 列表成功：`200 {"ok": true, "todos": [...]}`
- 关闭 / 重开 / 删除成功：`200 {"ok": true}`
- 查询单条：`200 {"ok": true, "todo": {...}}`；`id` 不存在返回 `404 {"ok": false, "error": "待办不存在"}`
- 失败响应：`400` 校验失败（标题为空、时间无效、minutes 越界）/ `404` 路径、方法或 `id` 错误 / `413` body 超过 64KB
- 更新时未传的字段保持不变；改 `dueAt` 后桌宠会按新时间重排定时器。

> 旧接口 `/reminders` 仍保留（新建、查询、更新、删除），但桌面端已把历史提醒一次性迁移为待办，日常请统一用 `/todos`。

## 执行步骤

1. 从用户原话中拆出「标题」「内容」「时间」以及意图（新建 / 查询 / 修改 / 关闭 / 重开 / 延期 / 删除）。修改、关闭、延期或删除前，如用户没给 ID，先 `GET /todos` 按标题/时间定位目标，再对对应 `id` 操作。
2. 把中文时间换算成 ISO 8601（带 `+08:00` 时区），精确到分：
   - 「今天 15:00」→ 今天本地 15:00
   - 「明天 09:30」→ 明天本地 09:30
   - 纯「15:00」→ 今天 15:00
   - 用户给了具体日期时间 → 直接使用
3. 用户表达急迫程度时映射到 `priority`：`急/最重要` → 1，`重要` → 2，未说明 → 3，`不急` → 4，`长期跟进/先记着` → 5。
4. 优先调用技能自带脚本（自动完成换算与请求）：

   ```bash
   # 新建
   python3 scripts/add-reminder.py --text "<标题>" --at "<时间原文，如 今天 15:00>" [--content "<详细内容>"] [--priority 3]
   # 查询全部 / 单条
   python3 scripts/add-reminder.py --list
   python3 scripts/add-reminder.py --id <待办ID>
   # 更新（只传要改的字段）
   python3 scripts/add-reminder.py --id <待办ID> --update --text "<新标题>" --at "明天 10:00" [--content "<新内容>"] [--priority 2]
   # 关闭 / 重新打开
   python3 scripts/add-reminder.py --id <待办ID> --close
   python3 scripts/add-reminder.py --id <待办ID> --reopen
   # 延期（分钟）
   python3 scripts/add-reminder.py --id <待办ID> --postpone 60
   # 删除
   python3 scripts/add-reminder.py --id <待办ID> --delete
   ```

   脚本 `--at` 支持：`今天 HH:MM` / `明天 HH:MM` / `HH:MM` / ISO 时间（如 `2026-11-25T18:00:00+08:00`）。
5. 若脚本不可用，用等价 curl 直接请求：

   ```bash
   # 新建
   curl -X POST http://127.0.0.1:46231/todos \
     -H 'Content-Type: application/json' \
     -d '{"title":"<标题>","content":"<内容>","dueAt":"<ISO 时间>","priority":3}'
   # 查询全部
   curl http://127.0.0.1:46231/todos
   # 更新
   curl -X PUT http://127.0.0.1:46231/todos/<ID> \
     -H 'Content-Type: application/json' \
     -d '{"title":"<新标题>","dueAt":"<新 ISO 时间>","priority":2}'
   # 关闭 / 重开 / 延期
   curl -X POST http://127.0.0.1:46231/todos/<ID>/close
   curl -X POST http://127.0.0.1:46231/todos/<ID>/reopen
   curl -X POST http://127.0.0.1:46231/todos/<ID>/postpone \
     -H 'Content-Type: application/json' -d '{"minutes":60}'
   # 删除
   curl -X DELETE http://127.0.0.1:46231/todos/<ID>
   ```

6. 脚本输出「已添加待办/已更新待办/已关闭待办/已延期…」或接口返回 `{"ok": true}` 后，告诉用户结果并附时间与优先级。未确认写入前不要宣称已成功。

## 错误处理

- 时间无法解析：说明支持格式（今天/明天 HH:MM、HH:MM、ISO），请用户确认时间后重试。
- 请求失败（连接被拒）：提示「桌宠没有在运行（`npm run dev`）或端口不是 46231」，不要编造成功。
- 返回 400：按提示修正 title（非空、≤80 字）、content（≤2000 字）、dueAt（可解析为时间）、priority（1~5）或 minutes（1~720）后重试一次。
- 返回 404：说明目标待办不存在；可先 `GET /todos` 列出当前待办，确认 ID 后再操作。
- 用户说「关掉这条」但没给 ID：先按标题模糊匹配 `GET /todos`，唯一命中才关闭；多条命中时列出候选让用户选。
