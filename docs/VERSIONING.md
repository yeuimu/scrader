# 版本策略

**唯一版本源：根 package.json。** 其余位置必须与之一致，CI 断言（见下）。

| 位置 | 说明 | 同步方式 |
|---|---|---|
| `package.json` 的 `version` | npm 发布版本 | ✍️ 手改这里（唯一入口） |
| `core/index.js` | `require('../package.json').version` | 自动，无硬编码 |
| `hands/browser/extension/manifest.json` 的 `version` | 扩展版本 | CI 断言一致，改版时手改 |

## 兼容矩阵（bridge WS 协议）

- extension ⇄ bridge：`/status` 互报版本。0.6.0 起 bridge 与扩展同仓同版。
- core ⇄ bridge：HTTP `/tool`，字段 `{tool,args,timeoutMs}` 稳定；跨小版本兼容。
- gaze/weights：`eyes/gaze/weights/icon_detect/model.onnx`（OmniParser YOLO，CC-BY-4.0），
  模型文件升级需同步更新 `eyes/gaze/README` 中的精度/来源记录。

## 外部依赖版本基准

| 依赖 | 验证版本 | 验证日期 | 钉版方式 |
|---|---|---|---|
| cua-driver | 0.28.2 | 2026-09-22 | 国内: `scripts/cn-setup.ps1`（Gitee Release 镜像 zip，官方包 MIT 原样转存）；海外: `$env:CUA_DRIVER_RS_VERSION="0.28.2"; irm https://cua.ai/driver/install.ps1 | iex`；回滚: `install.ps1 -Release <旧版>`（junction 切换） |

升级流程：金丝雀机 update → npm run selftest + test/test-desktop-e2e.js + glide 冒烟 → 全绿后更新本表 → 其余机器钉装。

## CI 断言（.github/workflows/ci.yml）

1. 全量 `node --check`
2. `motion/trajectory.test.js`（轨迹纯函数）
3. `scripts/build-extension.js --check`（vendor 产物与源头一致）
4. manifest.json 版本 == package.json 版本
