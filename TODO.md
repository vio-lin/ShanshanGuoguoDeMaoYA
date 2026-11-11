# TODO / 待办清单

> 维护说明：本文件跟踪 ragdoll-pet（Tauri v2 迁移后）尚未完成、待验证或待拍板的事项。完成一项勾掉一项；新增待办按对应分组追加。最后更新：2026-11-11。

## 一、发版阻塞（CI / Release）

- [ ] 复验 CI 双平台构建：`14f3bdf` 推送 main 后，确认 macOS（dmg+app）、Windows（nsis）两个 build job 全部绿色。
  - 本地已用干净 `npm ci` + `tsc --noEmit` + `vite build` 复现通过；Windows nsis 线上首跑，重点看 WebView2、链接器、NSIS 段。
- [ ] tag 与提交对齐：历史 `v1.5.0` 仍指向首次失败提交 `9599ec4`，保持不动；v1.5.1 走新 tag，指向本轮新提交。两个 build job 通过后推送 tag，`release` job 自动生成 v1.5.1 Release。
- [ ] 确认 Release 产物：macOS app/dmg、Windows exe 三个附件随 Release 自动上传；`release` job 依赖两个 build job 同时成功，任一失败则不生成 Release。
- [ ] （可选）给 release job 加兜底：build 失败时也在 Release 页生成「构建未完成」条目（不带附件），避免 tag 推了却找不到 Release。
- [ ] （可选）配置 `Swatinem/rust-cache@v2` 缓存 Rust `target/`，缩短后续 CI 编译时间（首次为空，收益从第二次起）。

## 二、已知占位 / 未接通的功能

- [ ] **边缘吸附 edgeSnap**：设置项与 `snapBounds` 工具已在前端，但原生拖拽结束无贴边钩子，未真正吸附到屏幕边缘。
- [ ] **文件口袋**：`FILE_POCKET_ENABLED = false`（`src-tauri/src/main.rs`），命令层在、菜单入口已隐藏；web 拖拽无源路径，缺原生 `onDragDropEvent`。
- [ ] **全局打字监听**：设置项 `typingReaction` 与 `typing-status` 通道保留，后端不发事件，属空壳；原版 typing-listener 也无真实钩子。是否需要真实全局键盘监听待决策（需明确授权，且只产生活动脉冲、不读存键值）。
- [ ] **E2E 探针 `__petE2E`**：契约类型已在 `contracts.ts`，未在运行时暴露给测试。
- [ ] **Dashboard 标题**：无边框原生标题固定「哈哈的小屋」，前端 `document.title` 随宠覆盖；未做原生标题随宠切换。
- [ ] **更新流程线上实测**：本地 1.5.0 高于远端 v1.3.1，走「已是最新」分支；「发现新版本」分支仅由版本比较单测覆盖，需发更高版本后线上验证。`releases.atom` 降级链路未实现（API 限流/失败返回 null，前端提示检查失败）。
- [ ] **面板待办编辑入口**：闹钟 HTTP 已闭环（`GET /reminders` 列表、`GET /reminders/:id`、`PUT /reminders/:id`、`DELETE /reminders/:id`），AI 可经本地接口查询/更新/删除；dashboard 待办 tab 面板目前仅「删除」，未做前端回填编辑（复用 reminder 弹窗预填）。

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

## 五、素材待确认

- [x] ~~`src/pets/ragdoll/assets/blink/02.png` 手动修图~~：已随 v1.5.1 纳入 git 提交。

## 备注

- 素材处理 Node 脚本保留不迁（已确认接受）。
- 旧 `.doubao-pet-builder.json` 为 Electron sha256 哈希契约，Tauri 发版门禁不适用；Tauri 路线门禁以 `cargo test` / `tsc --noEmit` / `vite build` / `cargo tauri build` 为准。
