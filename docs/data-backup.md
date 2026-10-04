# 一键导出 / 一键导入全部数据（task-38）

**用户口径**：「一键导出用户数据，所有数据那种」，再「写个一键导入」。

## 归档格式
`.tar.gz`（自实现最小 ustar + 内置 `zlib` gzip，**不新增依赖、不调用系统 7z/bsdtar**；读端是流式 `Transform` 状态机，只认 ustar + GNU base-256 size，pax/GNU 扩展头一律拒绝 → fail-closed）：

```
manifest.json                 # { format:'linshe-backup', version:1, app, exportedAt, includeConfig, dbBytes, files:[{path,bytes,sha256}], counts:{...} }
data/agent.db                 # VACUUM INTO 一致性快照（不裸拷，避免 WAL 半写）
data/avatars/**  data/town/**
config/.env                   # 仅 includeConfig=1（含 API Key，默认不导）
```
排除：`node_modules` / `logs` / `public`（可重建）/ `data/backups`（防套娃）。

## 接口
| 接口 | 说明 |
| --- | --- |
| `GET /api/data/export?includeConfig=0\|1` | 200 二进制 tar.gz + `Content-Disposition: attachment; filename="linshe-backup-<YYYYMMDD-HHmm>.tar.gz"`；先写临时文件、成功才发响应（绝不吐半个归档） |
| `GET /api/data/export/info` | `{ ok, dbBytes, counts, lastExportAt }`（`dbBytes` 是**估算上界**，不是精确导出量） |
| `POST /api/data/import` | body = 原始 tar.gz（路由级 `express.raw`，默认上限 2GB，`LINSHE_BACKUP_MAX_BYTES` 可覆盖） |

## 导入的安全与顺序（顺序即安全边界）
1. **先校验到 staging 临时目录**：gzip 魔数 → manifest 唯一且 `format/version` 匹配 → 逐文件 `sha256`/`bytes` 对 manifest → manifest 与实际条目**双向**比对 → 路径安全（拒绝 `..`、绝对路径、盘符、UNC、反斜杠、>1024 字节路径、只允许 `data/**` 与 `config/.env`、显式拒绝 `data/backups/**` 与 `agent.db-wal/-shm`）→ 条目类型只放行普通文件/目录（软链/硬链/设备/FIFO/pax 一律拒）→ `agent.db` 必须是 SQLite → 压缩前后大小上限（413）。
2. **校验失败绝不创建备份目录、绝不动现有数据**（有专门测试断言）。
3. **备份**：`wal_checkpoint(TRUNCATE)` + `closeDb()` → 整份 `data/` 复制到 `data/backups/pre-import-<YYYYMMDD-HHmmss>/`（同秒冲突自动 `-2`）。
4. **落地**：清 `-wal/-shm` → 换 `agent.db` → `getDb()` 重开 → 合并 `avatars/`、`town/`（归档里没有的文件不删 = 合并语义）→ 可选写回 `.env`。
5. **回滚**：把 `backupPath/agent.db` 拷回（先删 `-wal/-shm`）再重启即可。任何 500 都带 `backupPath`。

## 已知边界
- 导出走临时文件（需一份等价磁盘空间）；导入 body 整体进内存（2GB 上限下峰值 ≈ 归档大小）。
- 导入后数据库**已在进程内重开**（`restartRecommended:false`），但正在进行的 SSE 流、日程调度器的内存快照与已排定定时器**不会立刻反映**导入内容 → 对不上就重启一次；`includeConfig=1` 写回 `.env` 时 `restartRecommended:true`（dotenv 启动时已加载）。
- 导出会**跳过**目录里的符号链接（打 warn，不硬失败）。
- 前端：「数据备份」区块（`SettingsView.vue`）= 摘要 + 「包含模型配置（含 API Key）」开关 + 导出/导入按钮 + 二次确认 `LinsheModal`（写明会覆盖、会自动备份）；失败时把 `backupPath` 显示给用户。
- **未做浏览器真机点击验证**（导出下载 / 文件选择 / 上传 / 弹窗交互只做了构建与静态核对）。