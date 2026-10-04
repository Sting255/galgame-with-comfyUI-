# HiresFix 细化精度（设置项 `hiresQuality`）

> 落地：2026-09-30（D1 步数实验 + 用户裁决）。实现：`agent-core/src/config.js`（键 + 三态分支）、
> `agent-core/src/services/imageRefine.js`（映射步数）、`agent-core/src/db/settings.js`（落库）。

## 这个选项是干什么的

HiresFix 是「成图之后再放大细化一遍」那一步。它每一步都由 **anima_turboV10** 这个蒸馏模型重画，
**步数越多越慢、细节越干净**。这个设置就是**在画质与耗时之间选档**——改完立刻生效，不用重启。

（turbo 模型必须 CFG 1.0，所以 CFG 不开放；关掉 `hiresTurbo` 才会回到旧的 `hiresSteps` / `hiresCfg` 口径。）

## 三档

| 档位 | 值 | 细化步数 | 说明 |
| --- | --- | --- | --- |
| 高 | `high` | 12 | 细节最干净（发丝末端、细饰带缝隙都保得住），最慢 |
| 中 | `medium` | 10 | 与「高」肉眼几乎无差别，省一点点 |
| 低 | `low` | **8（默认）** | 最快；细结构开始有轻微并线/发软 |

## D1 实测（同角色卡 · 同 prompt · 同 seed，只改步数）

RTX 3060 12G / ComfyUI 0.37 / 源图 768×512 → 细化出图 2000×1328 / denoise 0.35 / maxSize 2000（已剔除模型加载的预热耗时）：

| 步数 | 耗时 | 相对 12 步 |
| --- | --- | --- |
| 12（高） | 38.51s | — |
| 10（中） | 33.60s | −13% |
| 8（低） | 24.31s | **−37%** |

画质主观结论（100% 逐区对比）：**12 ↔ 10 肉眼几乎无差别**；**8 步是拐点**——右侧领口细白饰带之间的缝隙会被填掉、
发丝末端与耳坠链边缘发软。用户据此裁决：**默认用 8 步（省时优先）**，需要更干净时手动切「高」。

## 配置口径（给排查/前端用）

| 项 | 值 |
| --- | --- |
| 设置键 | `features.hiresQuality` |
| 取值 | `high` / `medium` / `low`（**默认 `low`**）；其它值一律回落 `low` |
| env | `FEATURE_HIRES_QUALITY` |
| 落库键 | `feature_hiresQuality`（`db/settings.js`，type string） |
| GET | `GET /api/config` → `features.hiresQuality` |
| PUT | `PUT /api/config/features` body `{ key: 'hiresQuality', value: 'high' }` → `{ ok: true, features: {...} }` |

**优先级（避免两处打架）**：`config.comfyui.hiresTurboSteps` 是**底层逃生门** —— 它被显式改成**非内置默认（12）**的值时
完全以它为准（绕过三档）；保持默认 12 时由 `hiresQuality` 决定（`imageRefine.resolveTurboSteps()`，注释里写明了口径）。

## 建议的设置项文案（一句）

> **细化精度**：成图后放大细化那一步的精细程度。高 = 细节最干净但最慢；低（默认）= 最快，细看细结构会略软。

三档标签建议：`高`（12 步）/ `中`（10 步）/ `低`（8 步 · 默认）。

## 测试

- `agent-core/test/hiresQuality.test.js`：默认 low、三档映射 12/10/8、非法值回落 low、`hiresTurboSteps` 覆盖优先、
  `PUT /api/config/features` 线路级（含落库与「PUT 后 workflow 真的换步数」）。
- `agent-core/test/hiresTurboMode.test.js`：turbo 开关打开/关闭的旧口径回归（已按新默认更新为 low=8）。
