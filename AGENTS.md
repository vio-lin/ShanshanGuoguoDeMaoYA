# AGENTS.md — 山山国国（布偶猫桌宠）素材管线备忘

本项目是 Electron + TypeScript + Webpack 的桌面宠物（布偶猫「山山国国」，Code by Doubao）。
本文档记录**素材生图与抠图的完整逻辑**，供后续新增/重做动作帧时直接复用，避免重复踩坑（尤其是"白边"问题）。

---

## 1. 素材管线总览

```
core-ip（唯一身份母版）
   │  image_edit 逐状态生成（提示词见 §2，一次生成整个状态的全部帧）
   ▼
incoming-assets/<state>/NN.png   ← 2048×2048 原图（AI 输出：纯白底不透明）
   │  npm run process:assets -- --state <state>
   │    （Apple Vision 语义分割抠图 → 统一 512×512 → 脚底锚点归一化）
   ▼
src/assets/pet/<state>/NN.png    ← 运行时素材
   │  npm run inspect:assets -- --state <state>   （状态级 QA）
   │  npm run check                                （全量 QA：50/50）
   ▼
桌宠应用 / 安装包
```

- **core-ip 是唯一身份真值**：所有动作帧必须从 `src/assets/pet/core-ip/core-ip.png` 衍生（`image_edit` 的 `image_reference_url_list` 只传它）。永远不要重生成 core-ip，否则整套素材身份漂移。
- 每个状态作为**同一动作序列**一次生成（一次 `image_edit` 调用传全部帧），不要逐帧当作独立任务。
- 已启用状态：idle(5) blink(5) tap(5) notify(5) peek(5) walk(6) jump(6) stalk(6) bury(6)，共 50 帧。

## 2. 生图提示词逻辑（核心：防白边）

### 2.1 白边问题的根因（重要，勿再犯）

- AI 生成透明贴纸图时，**自带 2–3px 不透明白色描边环**（贴纸白边），它邻接透明像素，任何分割工具（Apple Vision / rembg）都会把它当主体保留。
- 用 rembg（`birefnet-general` + alpha_matting）实测**无法去除**；对邻接透明像素做"智能去白"反而暴露内层描边、扩大白边。
- **唯一有效解法：在生图提示词里显式禁止白色描边**，让边缘像素直接是猫毛本色。

### 2.2 已验证有效的提示词模板（bury 全绿，6/6 PASS）

每帧 prompt 必须包含以下全部要素：

```
保持布偶猫身份特征完全一致（海豹双色、蓝眼、粉鼻、白胸白爪、深棕耳尖面罩）。
<具体动作描述，第 N/M 帧：只改变完成该动作所需的局部姿态和表情>。
画面中只有猫，没有地面、没有道具、没有碎屑、没有文字、没有人手。
身体大小占画布比例与其他帧完全一致，保持<基态体型>，只小幅改变<局部部位>。
绝对不要白色描边/白色轮廓线/贴纸边，猫的轮廓边缘像素直接是猫毛本身的颜色，背景完全透明。
轻度卡通贴纸风。
```

要点：
- **身份要素固定一句话**：海豹双色、蓝眼、粉鼻、白胸白爪、深棕耳尖面罩。
- **体型一致**是过 `SCALE_DRIFT` 的关键：所有帧必须写"身体大小占画布比例完全一致"，动作幅度要收敛（尤其 jump/walk 这类大动作，幅度太大会导致等效尺度差 >8% 被 QA 拦截）。
- **禁描边语句**：`绝对不要任何白色描边/白色轮廓线/贴纸边，猫的轮廓边缘像素直接是猫毛本身的颜色`。
- **禁道具/地面**：埋粑粑时不要画出粑粑本体和碎屑（v1 就是因此返工）；只画猫的扒拉动作。
- 输出为**纯白底不透明图**是正常的（描述里可见"背景为纯白色"），由 Apple Vision 抠图去底，不是失败。

### 2.3 各状态帧动作设计（历史调优结论）

| 状态 | 帧数 | 动作序列 |
|---|---|---|
| idle | 5 | 呼吸微动：正坐→耳动→眼微眯→尾动→回位（幅度极小，锚定高度锁死） |
| blink | 5 | 睁眼→双眼半闭→闭眼→半睁→睁眼回位（尾巴统一卷右侧） |
| tap | 5 | 被点击：惊讶抬头→压缩→眯眼开心→回弹→回位 |
| notify | 5 | 提醒：竖耳→歪头→强调→缓回→回位 |
| peek | 5 | 贴边探头：侧探→探出→停→缩回→回位 |
| walk | 6 | 步态：右前爪迈→左前爪迈→双爪着地交替（**左右脚必须交替**，不要全部右脚在前） |
| jump | 6 | 蓄力→起跳→腾空→**中间帧整体上移体现跳跃高度**→下落→落地回位（最后一帧=第一帧姿态，避免缺帧感） |
| stalk | 6 | 悄悄走：伏低→小步前挪→探头→挪→停→回位（变化幅度要够，之前版本被反馈"变化太小"） |
| bury | 6 | 低头嗅→右爪扒→左爪扒→双爪扒→回头嗅→回位（已按本模板重做，全绿） |

## 3. 抠图处理逻辑

- 后端：macOS 只走 **Apple Vision**（`semantic-cutout`），不装/不切 rembg。
- 命令：`npm run process:assets -- --state <state>`（处理 `incoming-assets/<state>/` → `src/assets/pet/<state>/`）。
- **缓存**：语义分割结果缓存于 `.build/semantic-cutouts/`（按源图哈希）。**换新源图后必须 `rm -rf .build/semantic-cutouts` 强制重抠**，否则会命中旧图缓存。
- 归一化：同状态共享缩放系数 → 512×512，底部中心锚点，主体占画布约 72–80%。
- 抠图后白边验证脚本（Python/PIL + numpy）：统计"邻接透明的白色像素数"，目标 <30/帧，理想 0–8（bury 全绿水平）。

## 4. QA 与验收

- `npm run inspect:assets -- --state <state>`：状态级 QA，错误码见 skill 文档（`SCALE_DRIFT`=同状态等效尺度差>8%（idle/blink 2.5%）；`DUPLICATE_FRAME`=重复帧；`SUBJECT_TOUCHES_BORDER`=源图裁断；`GROUND_RESIDUE`=地面残留）。
- `npm run check`：全量门禁（tsc + 契约 + spec + asset links + UI/Experience/Asset QA）。**目标：Asset QA summary passed=50 failed=0**。
- 深色背景联系表：拼接 6 帧到深灰(42,42,42)背景目检白边。
- 不要调低阈值/跳过 QA 来迁就结果。

## 5. 常用命令速查

```bash
npm run dev                  # macOS 源码开发预览（DEV_PREVIEW_READY 为就绪标志）
npm run process:assets -- --state <state>   # 处理单个状态
npm run inspect:assets -- --state <state>   # 状态级 QA
npm run check                # 全量检查
npm run test:dev-smoke       # 冒烟测试
```

## 6. 已知坑位

- **单实例锁**：`~/Library/Application Support/布偶猫桌宠/Singleton{Lock,Socket,Cookie}` 被强杀后残留会导致新实例静默 `app.exit(0)`。启动失败时先删这三个文件。
- 启动失败定位：`npm run dev` 报 `Electron Forge exited before runtime became ready` 时，先查锁文件，再 `npx electron .` 看是否静默退出。
- 素材换源后忘记 `rm -rf .build/semantic-cutouts` 会得到旧图结果。
- 新帧数/帧序改动后，`pet-spec.json` 的 `states[].frames` 必须同步（blink 必须恰好 5 帧）。
