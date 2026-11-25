# TODO / 待办清单

> 维护说明：本文件跟踪 ragdoll-pet（Tauri v2 迁移后）尚未完成、待验证或待拍板的事项。完成一项勾掉一项；新增待办按对应分组追加。最后更新：2026-11-25。

## 一、发版阻塞（CI / Release）

- [x] ~~复验 CI 双平台构建~~：线上 #20（main，7b4ebed）11m19s、#21（tag v1.5.1，7b4ebed）8m55s 均 completed successfully，macOS（dmg+app）、Windows（nsis）build job 绿色。
- [x] ~~tag 与提交对齐~~：历史 `v1.5.0` 仍指向首次失败提交 `9599ec4` 保持不动；新 tag `v1.5.1` 指向 `7b4ebed`，release job 已生成 v1.5.1 Release。
- [x] ~~核对 Release 附件构成~~：CI release job 的 files glob 已收窄为 `macos/*.dmg`、`windows/*.exe`，下次发布不再把 `.app` 内部的 `icon.icns` / `Info.plist` / 二进制拆成冗余附件；完整 `.app` 已打进 dmg。
- [x] ~~v1.6.1 素材压缩发版~~：动画帧改 256 色量化 PNG（pngquant quality 75-95，`--strip`），打包素材 14 MB → 5.4 MB；102 张 512×512 无损母版用 `git mv` 迁到 `src/pets/<pet>/assets-original/` 并保留历史；`core-ip.png` 母版不再进包；前端 `import.meta.glob` 收窄为 `/src/pets/**/assets/**/*.png`；三个校验脚本（validate-asset-links / qa-experience / qa-assets）区分运行时帧与母版；顺带修复 pet-spec `app.version` 长期停留 1.4.1。**注意：不要覆盖 `assets-original/` 做量化，原件是唯一可回退来源。**
- [x] ~~v1.6.0 发版~~：提交 `74b20a8` + annotated tag `v1.6.0` 已推送；Release 页正文取自仓库 `RELEASE_NOTES.md`（CI release job 增加 checkout + `body_path`，移除 `generate_release_notes`），附件实测仅 `布偶猫桌宠_1.6.0_aarch64.dmg`、`布偶猫桌宠_1.6.0_x64-setup.exe` 两项，无 `.app` 内部冗余。
- [x] ~~Release 附件 glob 嵌套导致 dmg 漏发~~：`upload-artifact@v4` 对 `macos/*.app` 与 `dmg/*.dmg` 两个父目录按最小公共父目录（bundle/）保留层级，artifact 内是 `macos/…app` + `dmg/…dmg`；下载到 `macos/` 后 dmg 落在 `macos/dmg/`，收窄后的 `macos/*.dmg` 静默失配（glob 不匹配不报错），首版 v1.6.0 Release 只有 exe。改为 release 前 `find` 递归归位到 `dist/` 并对 dmg/exe 各做硬校验（缺失直接失败），重建 tag 后 dmg 21.4MB、exe 17.4MB 均上传成功。**不要再把 release files 收缩成单层 glob。**
- [ ] （可选）给 release job 加兜底：build 失败时也在 Release 页生成「构建未完成」条目（不带附件），避免 tag 推了却找不到 Release。
- [ ] （可选）配置 `Swatinem/rust-cache@v2` 缓存 Rust `target/`，缩短后续 CI 编译时间（首次为空，收益从第二次起）。

## 二、已知占位 / 未接通的功能

- [ ] **边缘吸附 edgeSnap**：设置项与 `snapBounds` 工具已在前端，但原生拖拽结束无贴边钩子，未真正吸附到屏幕边缘。
- [ ] **文件口袋**：`FILE_POCKET_ENABLED = false`（`src-tauri/src/main.rs`），命令层在、菜单入口已隐藏；web 拖拽无源路径，缺原生 `onDragDropEvent`。
- [ ] **全局打字监听**：设置项 `typingReaction` 与 `typing-status` 通道保留，后端不发事件，属空壳；原版 typing-listener 也无真实钩子。是否需要真实全局键盘监听待决策（需明确授权，且只产生活动脉冲、不读存键值）。
- [ ] **E2E 探针 `__petE2E`**：契约类型已在 `contracts.ts`，未在运行时暴露给测试。
- [ ] **Dashboard 标题**：无边框原生标题固定「哈哈的小屋」，前端 `document.title` 随宠覆盖；未做原生标题随宠切换。
- [ ] **更新流程线上实测**：本地走「已是最新」分支；「发现新版本」分支仅由版本比较单测覆盖。v1.6.0 上线后，1.5.1 客户端应能检出 1.6.0，可据此复验「发现新版本」分支与 API 限流时降级 `releases.atom` 的链路。
- [x] ~~面板待办编辑入口~~：dashboard 待办页已支持新建/编辑（标题+内容+时分+5 档优先级）、关闭/重开、延期（自动记录 `postponements` 历史），见「五」。
- [x] ~~v1.6.1 runtime core-ip 校验回归~~：`pet/index.ts` 强制要求 `character.coreAsset` 有运行时映射，而 `core-ip.png` 只保留在 `assets-original/`，启动即 `runtime fail`；已改为「无运行时映射则跳过」（母版不参与渲染）。

## 三、待用户拍板的决策项

- [ ] 系统通知横幅（提醒到点 / agent 任务）：相对原版属新增，是否保留。
- [ ] 边缘吸附是否补做。
- [ ] 文件口袋是否启用（需原生拖拽事件支持）。
- [ ] 技能安装是否在 spec 开关外暴露入口。
- [ ] `AGENTS.md` 发版流程仍写 Electron 时代「6 处版本号 + sha256 契约」，是否同步为 Tauri 四处版本号口径（`tauri.conf.json` / `Cargo.toml` / 根 `package.json` / `frontend/package.json`，另加两个 lock 版本字段）。

## 四、体积 / 工程优化

- [ ] **素材分辨率压缩**：102 张素材为 512×512（每张 150–170K，共约 14M），桌宠实际显示最大约 176px，存在约 3 倍冗余；评估缩到 256×256 + PNG 优化（oxipng/sips），压缩后回验帧一致性与画质。
- [ ] **Rust release profile 优化**：`Cargo.toml` 未配 `[profile.release]`，未 strip、未 LTO；评估加 `strip = true`、`lto = true`、`panic = "abort"`、`codegen-units = 1`、`opt-level = "s"`，本地重编对比二进制大小。
- [ ] 依赖裁剪：`tokio` 当前 `full`，评估改为按需 features；核对 reqwest `blocking/rustls/json` 是否可精简。
- [x] ~~核实 CI macOS 产物架构~~：已下载 CI 产物实测，`macos/*.app` 33M（二进制 32M + 图标 912K）、`dmg/*.dmg` 21M，两者均为 arm64 单架构（Non-fat，非 universal，`--target universal-apple-darwin` 未配置）；`macos/` 与 `dmg/` 两个目录是两条 artifact glob 下载形成的两种分发形态，不是两代芯片版本。体积大头仍是嵌入的约 14M 素材 + 未 strip 的 Rust 二进制。

## 五、本轮已实现（代码+自动门禁通过，待真人回归）

- [x] 小屋 tab「🎂 节日」改名「🎂 纪念日」，日历标题同步；内部 `data-tab="festival"` / `id="tab-festival"` 保留，历史更新日志文案不动。
- [x] 待办面板「🗑 清除已过期」：过期口径 `!repeat && dueAt < now`，无过期项时按钮禁用。
- [x] 桌宠窗口位置记忆：`Moved` 事件 500ms 节流落盘 `window-position.json`，退出/托盘退出前补存，启动时校验坐标落在任一显示器后再恢复。
- [x] 重复提醒：`repeat` 支持 `hourly/daily/weekdays/weekly`；到点触发后 `advance_reminder` 推进 `dueAt`（循环跳过已过时刻，防休眠补发）；HTTP、提醒面板、`pet-reminder` 技能脚本三条入口均支持。
- [x] 稍后提醒 Snooze：提醒窗到点态提供 5/10/30 分钟；重复提醒另建一次性副本，不改原重复节奏；一次性提醒直接改 `due_at`。
- [x] 右键菜单「⏱ 快捷提醒」：💧 每小时喝水、🧘 每小时起来活动、🌙 每天 22:30 休息。
- [x] 开机自启开关：`tauri-plugin-autostart 2.7.0`（macOS LaunchAgent），设置区开关读取系统侧真值并用返回值回写。
- [x] ~~待真人回归：位置记忆~~：用 System Events 真实移动窗口到逻辑 (700,500)，`outer_position()` 落盘 physical (1400,1000)（Retina 2x），kill 重启两次均恢复到 (700,500)/(708,199)，二次恢复仍生效。副屏拔除后「坐标不可见则不恢复」的回退分支未实测。
- [ ] **待真人回归：Snooze**——到点弹窗点 5/10/30 分钟，确认一次性提醒 `dueAt` 顺延、重复提醒新增副本且原条 `dueAt` 不变（WebView 内容不暴露给 System Events，gcu 只能匹配 `.app`、绑不上裸二进制，自动化点击无法闭环）。
- [ ] **待真人验证：开机自启**——需在安装版 `.app` 上 enable/disable（dev 裸二进制下 LaunchAgent 路径可能不生效）。
- [ ] **待真人回归：窗口拖动加固**——`.card` 可拖区域在 release 打包版上验证（dev 阶段 gcu 无法绑定裸二进制进程）。
- [ ] （可选）给 agent-bridge 增加 `POST /reminders/{id}/snooze`，让 AI 侧也能执行「稍后提醒」。
- [x] **待办（Todo）体系**：新增 `todos.json` 存储与 `Todo` / `Postponement` 数据结构；5 档优先级（P1 红 → P5 蓝，新建默认 P3）；`todos_list/create/update/close/reopen/delete/postpone` 七条命令与 HTTP `/todos` 系列端点；`todos-changed` / `todo-due` 事件。
- [x] **旧提醒迁移**：启动时把 `reminders.json` 一次性转成待办（统一 P5、`source=reminder-migration`），备份 `reminders.pre-todo.json` 后清空旧文件；按「标题 + 时间」去重，后续残留也会被吸收，避免两套调度重复提醒（迁移已提前到提醒定时器注册之前）。
- [x] **到期与过期提醒**：未到期按 `dueAt` 提醒；过期后每天同一时分继续提醒，标题区分「待办到期 / 待办已过期 N 天」；启动时对过期待办发一条系统通知（不弹窗打断）。
- [x] **待办页 UI**：日历（周日开头、7×N 网格、每日最多 3 个优先级色点、点击日期筛选、今天/切月）+ 三栏（进行中 / 过期 / 已关闭，带计数）+ 逐条列表（优先级色条、标题、内容、时间、延期次数与最近一次记录）+ 编辑表单（标题 / 内容 / 日期 / 时间 `step=60` / 5 档优先级 / 删除 / 取消 / 保存）。
- [x] **左下角箱子**：小屋主页左侧底部 📦 入口，角标显示未关闭数量（有过期时转红），点击弹出最近 3 条 + 「查看全部」。
- [x] **提醒窗联动**：`todo-due` 进入到点态，显示标题 / 内容 / 截止时间 / P 档；「✓ 完成」关闭待办，5/10/30 分钟走 `todos_postpone` 并写入延期历史。
- [x] **pet-reminder 技能**：`tools/add-reminder.py` 默认走 `/todos`（新建 / 查询 / 更新 / 关闭 / 重开 / 延期 / 删除，`--priority` 1–5），`--legacy` 保留旧 `/reminders`；SKILL.md 同步重写，并已复制到 `~/.claude/skills/pet-reminder/`。
- [x] 面板技能说明文案改为「待办箱子」口径。
- [ ] **待真人回归：待办 UI**——日历切月 / 点日期筛选、箱子气泡与「查看全部」跳转、编辑表单保存、延期内联菜单（+1 小时 / +1 天 / +7 天）需在安装版 `.app` 上点一遍（本轮已用 Playwright + Tauri 桩截图验证布局，接口用 curl 闭环）。
- [x] **桌宠旁的待办箱子**：改成独立 60×60 透明小窗口（`todo-box.html`），贴桌宠右侧 8pt、底部对齐；监听 pet `Moved` 事件以 60ms 节流跟随；右侧放不下自动翻到左侧并夹在当前显示器内；角标为未关闭数量（有过期转红）；点击调用 `window_show_dashboard_todo` 打开小屋并落到待办页；小屋展开时箱子收起、关闭后回来。
- [x] **箱子点击可靠性**：窗口加 `accept_first_mouse(true)`（否则非激活状态下首次点击只激活窗口、不进 WebView）；`default.json` capability 的 windows 补 `todo-box`，否则事件订阅/emit 被拒。
- [x] **桌宠拖动不跟随修复**：原生 `startDragging()` 在这台 macOS 上只切拖拽姿态、窗口不动；改为 pointerdown 过阈值后调 `start_pet_drag`，Rust 后台线程用 `AppHandle::cursor_position()` 读全局光标、按物理增量 `set_position`，并夹在当前显示器内；pointerup 调 `end_pet_drag` 停止（10 秒兜底）。dev 合成拖动实测窗口 (1239,430) → (1154,362)，箱子跟随贴到右侧。
- [x] **箱子间距可配置**：`settings.todoBoxGap`（点，默认 2，范围 0–40），小屋「⚙️ 设置」里用滑杆调，松手即写盘并调 `position_todo_box` 重排；箱子的贴边距离不再写死在 Rust。
- [x] **小屋/提醒窗拖动失效修复**：dashboard 与 reminder 一直用的原生 `startDragging()` 在这台 macOS 上与桌宠同症状（按下不动）；复用桌宠的 Rust 跟随方案泛化为 `start_window_drag(window)` / `move_window(label,dx,dy)`，前端 `bindDrag` 改调 `startWindowDrag('dashboard'/'reminder')`，靠 `CGEventSourceButtonState` 松手自动停。release 安装版实测小屋拖动正常、桌宠拖动+箱子跟随不受影响（1.6.1 未提交）。
- [x] **待真人回归：拖动手感**——用户已确认安装版小屋拖动正常。
- [x] **高优先级删除保护**：P1/P2 在编辑表单点「删除」需再点一次确认（文案变「再点一次删除」，3 秒未确认自动复位）。
- [x] 从 dashboard 内移除旧「左下角箱子」入口及其气泡/样式，避免与桌宠旁的箱子重复。
- [ ] **待真人回归：提醒窗完成 / 延期**——点「✓ 完成」确认待办变 `closed`；点 5/10/30 确认 `dueAt` 顺延且 `postponements` 追加（WebView 不暴露 AX，自动化点击无法闭环）。

## 六、素材待确认

- [x] ~~`src/pets/ragdoll/assets/blink/02.png` 手动修图~~：已随 v1.5.1 纳入 git 提交。

## 备注

- 素材处理 Node 脚本保留不迁（已确认接受）。
- 旧 `.doubao-pet-builder.json` 为 Electron sha256 哈希契约，Tauri 发版门禁不适用；Tauri 路线门禁以 `cargo test` / `tsc --noEmit` / `vite build` / `cargo tauri build` 为准。
- [x] **待办四 tab + 表格化排序 + 放弃理由**：状态 tab 改为 进行中/过期/已完成/放弃；列表改表格（优先级/标题/到期时间/创建时间），点表头排序（同列再点翻转方向），三个 tab 均显示所有日期条目（日历仅高亮不筛选）；Todo 新增 `abandoned` 状态与 `abandonReason` 字段，`todos_abandon(id, reason)`（理由 trim 非空才接受，HTTP `POST /todos/{id}/abandon`），放弃在行内 🚫 按钮弹理由输入，完成/放弃后重新打开会清空放弃理由。接口链路 curl 实测通过，UI 四 tab/表头截图确认（1.6.1 未提交）。
