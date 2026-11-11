---
name: pet-reminder
description: 当用户说「小猫咪 帮我」或以自然语言要求添加、查询、修改、取消任务、会议、提醒（如"今天下午 3 点有个会议"、"帮我定个任务"、"记个提醒"、"把刚才的会议改到明天"、"删掉那条提醒"）时使用。将内容与时间通过本地 HTTP API 发送给桌面宠物应用（布偶猫桌宠）后台，由桌宠持久化并在到点提醒。只处理提醒/任务/会议类请求，其他场景不要使用。
---

# 桌宠任务/会议提醒

把用户的「任务/会议/提醒」送到本地桌面宠物应用（布偶猫桌宠）后台。桌宠会写入提醒列表、持久化到本地，并在到点弹出提醒、播放动作。支持新增、查询、更新、删除全流程。

## 后端 API

- 基址：`http://127.0.0.1:46231/reminders`（仅本机回环地址，不暴露局域网；端口可用环境变量 `PET_AGENT_PORT` 覆盖）
- 请求头：`Content-Type: application/json`
- 提醒对象字段：

```json
{
  "id": "系统生成的 UUID，查询/更新/删除时使用",
  "text": "提醒内容（最长 500 字）",
  "dueAt": "ISO 8601 时间，如 2026-11-03T15:00:00+08:00",
  "createdAt": "创建时间（系统生成）",
  "leadMinutes": 5
}
```

- `leadMinutes`：可选，提前提醒分钟数（0~1440）。缺省或 0 = 到点提醒；如 `5` = 在 dueAt 前 5 分钟提醒。用户说「提前提醒/提前 X 分钟」时使用。

### 接口一览

| 方法 | 路径 | 用途 | body |
| --- | --- | --- | --- |
| `POST` | `/reminders` | 新增提醒 | `{text, dueAt, leadMinutes?}` |
| `GET` | `/reminders` | 查询全部提醒 | 无 |
| `GET` | `/reminders/:id` | 查询单条提醒 | 无 |
| `PUT` | `/reminders/:id` | 更新提醒（部分字段，只传要改的） | `{text?, dueAt?, leadMinutes?}` |
| `DELETE` | `/reminders/:id` | 删除提醒 | 无 |

- 新增 / 更新成功：`200 {"ok": true, "reminder": {...}}`
- 列表成功：`200 {"ok": true, "reminders": [...]} `
- 查询单条成功：`200 {"ok": true, "reminder": {...}}`；`id` 不存在返回 `404 {"ok": false, "error": "提醒不存在"}`
- 失败响应：`400` 校验失败 / `404` 路径、方法或 `id` 错误 / `413` body 超过 64KB
- 更新时：未传的字段保持不变；`leadMinutes` 传 `0` 可清除提前提醒；更新后桌宠会按新时间重新排到点定时器。

## 执行步骤

1. 从用户原话中拆出「提醒内容」「时间」以及意图（新增 / 查询 / 修改 / 删除）。修改或删除前，如用户没给 ID，先 `GET /reminders` 按内容/时间定位目标提醒，再对对应 `id` 操作。
2. 把中文时间换算成 ISO 8601（带 `+08:00` 时区）：
   - 「今天 15:00」→ 今天本地 15:00
   - 「明天 09:30」→ 明天本地 09:30
   - 纯「15:00」→ 今天 15:00
   - 用户给了具体日期时间 → 直接使用
3. 用户明确要求「提前 N 分钟」时，把 N 填入 `leadMinutes`。
4. 优先调用技能自带脚本（自动完成换算与请求）：

   ```bash
   # 新增
   python3 scripts/add-reminder.py --text "<提醒内容>" --at "<时间原文，如 今天 15:00>" [--lead 5]
   # 查询全部 / 单条
   python3 scripts/add-reminder.py --list
   python3 scripts/add-reminder.py --id <提醒ID>
   # 更新（只传要改的字段）
   python3 scripts/add-reminder.py --id <提醒ID> --update --text "<新内容>" --at "明天 10:00" [--lead 5]
   # 删除
   python3 scripts/add-reminder.py --id <提醒ID> --delete
   ```

   脚本 `--at` 支持：`今天 HH:MM` / `明天 HH:MM` / `HH:MM` / ISO 时间（如 `2026-11-05T18:00:00+08:00`）；`--lead` 为提前分钟数（缺省 0 = 到点提醒）。
5. 若脚本不可用，用等价 curl 直接请求：

   ```bash
   # 新增
   curl -X POST http://127.0.0.1:46231/reminders \
     -H 'Content-Type: application/json' \
     -d '{"text":"<提醒内容>","dueAt":"<ISO 时间>","leadMinutes":5}'
   # 查询全部
   curl http://127.0.0.1:46231/reminders
   # 更新
   curl -X PUT http://127.0.0.1:46231/reminders/<ID> \
     -H 'Content-Type: application/json' \
     -d '{"text":"<新内容>","dueAt":"<新 ISO 时间>"}'
   # 删除
   curl -X DELETE http://127.0.0.1:46231/reminders/<ID>
   ```

6. 脚本输出「已添加/已更新/已删除提醒：…」或接口返回 `{"ok": true}` 后，告诉用户结果并附时间。未确认写入前不要宣称已成功。

## 错误处理

- 时间无法解析：说明支持格式（今天/明天 HH:MM、HH:MM、ISO），请用户确认时间后重试。
- 请求失败（连接被拒）：提示「桌宠没有在运行（`npm run dev`）或端口不是 46231」，不要编造成功。
- 返回 400：按提示修正 text（非空、≤500 字）、dueAt（可解析为时间）或 leadMinutes（0~1440 整数）后重试一次。
- 返回 404：说明目标提醒不存在；可先 `GET /reminders` 列出当前提醒，确认 ID 或内容后再操作。
