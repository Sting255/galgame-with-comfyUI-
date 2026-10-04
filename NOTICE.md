# 署名与来源

本包是 **邻舍.EXE** 的衍生版本。

## 上游（原作者）

- 项目：邻舍.EXE / galgame-with-comfyUI
- 仓库：https://github.com/icecranberry/galgame-with-comfyUI
- 作者：icecranberry
- 许可：MIT（见同目录 `LICENSE`）

## 本衍生版

- 上游基线：v3.6.3
- 本地改动：见 `town-update.md` 与仓库内 `docs/`
- 许可：沿用上游 MIT

## 再分发时必须保留

1. `LICENSE` 全文（MIT 明文要求：copyright notice + permission notice 必须随副本一起分发）
2. 本 `NOTICE.md`（指明上游来源）
3. 上游 `README.md` / `README_EN.md` 中的项目出处与演示链接

## 第三方组件

`runtime/`、`node_modules/`、`vector-service/models/` 内含大量第三方软件
（Node.js、Python、ComfyUI 相关、Chroma、ONNX Runtime、Playwright 等），
各自许可见各自目录下的 `LICENSE*` / `ThirdPartyNotices.txt`，随本包一并分发。
