# 山山国国的猫呀 🐱

一只会待在桌面上的布偶猫桌宠（macOS + Windows）。

## 猫猫档案

> 此猫，名哈哈，
> 布偶，五岁，重十斤。主五千购得，
> 主食皇家猫粮，辅以鲜鸡胸肉。一身长毛堆雪，蓝眸静如寒潭。
>       ---  它不必出剑，静卧，便是它的江湖。

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

---

Code by Doubao 🐱
