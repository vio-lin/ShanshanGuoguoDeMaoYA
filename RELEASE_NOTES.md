# 布偶猫桌宠 v1.6.1

这一版只做一件事：把安装包瘦下来，同时把原始素材完整留在仓库。

## 优化

- **素材重新压缩**：100 张动画帧改用 256 色调色板 PNG（`pngquant`，quality 75–95，保留 Alpha）。逐帧比对下来平均 PSNR 约 31 dB，放大 4 倍肉眼无差，差异集中在鼻头高光和轮廓抗锯齿。
- **安装包体积约减半**：前端素材从 14 MB 降到 5.4 MB，macOS dmg 预计从 21.4 MB 降到 13 MB 上下，Windows exe 从 17.4 MB 降到 10 MB 上下（以实际构建产物为准）。
- **无损母版完整保留**：102 张 512×512 原始帧仍在仓库 `src/pets/<pet>/assets-original/`，`git mv` 保留了文件历史，随时可以重新导出或调整压缩参数。
- **角色母版不进包**：`core-ip.png` 只作为素材母版保存在 `assets-original/`，不再打进安装包。

## 修复

- `pet-spec.json`（根模板与两个宠物）的 `app.version` 长期停留在 1.4.1，与 `package.json` 不一致，已统一到 1.6.1。
- 素材校验脚本改为区分「运行时帧」与「仓库母版」：动画帧必须在 `assets/`，`core-ip` 必须在 `assets-original/`；同时校验前端 `import.meta.glob` 只匹配打包目录，避免母版被误打包。

## 下载

- macOS（Apple Silicon）：`布偶猫桌宠_1.6.1_aarch64.dmg`
- Windows x64：`布偶猫桌宠_1.6.1_x64-setup.exe`

应用未签名，首次打开可能需要在「系统设置 → 隐私与安全性」里放行。

## 说明

素材压缩是有损的调色板量化。如果后续要做大幅改色、印刷级导出或训练素材，请使用 `assets-original/` 里的无损版本。
