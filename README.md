# Merchandiser

自托管的 **Hyperliquid 永续合约跟单工具**。跟随任意公开地址（或你自己的账户）的仓位变化，按规则自动在你的 Hyperliquid 账户上开平仓；也可以先用模拟账户试跑。

一个 Go 服务负责跟单引擎、风控、持久化（SQLite）与监控，并直接提供网页界面；桌面与手机浏览器均可使用。

## 功能

- **跟单员广场**：基于 Hyperliquid 公开排行榜与链上成交，为钱包计算「跟单适配度」（回撤控制、持仓时长、收益稳定、资金规模），并识别高频钱包；一键把钱包加为信号源并进入建任务向导。
- **信号源**：任意 Hyperliquid 地址（只读、无需密钥），或你自己已连接的账户。
- **跟单任务**：一个信号源可带多个跟单账户。
  - 仓位计算：按权益比例 / 固定倍数 / 固定名义金额，可按账户单独覆盖。
  - 规则：币种白名单 / 黑名单、只做多 / 只做空、反向跟单、启动时是否同步已有仓位、停止时是否平仓、最小调整金额、市价或 IOC 限价、挂单镜像。
  - 对账：定时比对目标仓位与实际仓位，超出容差自动修正或仅告警。
- **风控**：单币种 / 总名义上限、单笔最大滑点、日亏损与总亏损上限（可选触发平仓）、信号源失联时保持 / 暂停 / 平仓、全局急停与一键全平。
- **记录**：信号、订单、成交与盈亏曲线，审计日志导出 CSV；配置导入导出。
- **安全**：Hyperliquid 交易使用 API（agent）钱包签名，该钱包无法提币，主钱包私钥会被拒绝；密钥保存在服务器上由主密码加密的文件中（Argon2id + XChaCha20）；网页访问需令牌，可选界面锁。

## 部署（Docker）

```bash
cp .env.example .env      # 按需修改：访问令牌、域名、时区等
./deploy.sh               # 构建并启动（蓝绿部署）
```

- 默认只监听本机 `http://127.0.0.1:8686`。外网访问二选一：在 `.env` 设置 `DOMAIN` 后运行 `docker compose --profile https up -d caddy`（自动 HTTPS，推荐）；或设置 `MERCHANDISER_BIND=0.0.0.0`（明文 HTTP，仅限可信网络）。
- 未设置 `MERCHANDISER_TOKEN` 时，访问令牌会自动生成到数据卷的 `/data/api_token`。
- 首次在网页里输入的主密码即为密钥文件的主密码。服务重启后需要在网页解锁，任务才会恢复；也可配置 `MERCHANDISER_MASTER_PASSWORD_FILE` 开机自动解锁（蓝绿部署时强烈建议）。
- `./deploy.sh rollback` 切回上一版本，`./deploy.sh status` 查看当前版本。两个版本共享数据卷，同一时刻只有持有 `/data/engine.lock` 的实例运行引擎，切换期间跟单只暂停数秒。

## 本地开发

需要 Go 1.26、Node 24 与 pnpm。

```bash
# 后端
cd server
MERCHANDISER_DATA_DIR=./data MERCHANDISER_ADDR=127.0.0.1:8686 \
MERCHANDISER_TOKEN=devtoken go run ./cmd/merchandiser-server

# 前端（另开终端，/api 代理到 :8686）
pnpm install
pnpm dev
```

打开 Vite 给出的地址，服务器地址留空、令牌填 `devtoken`。

检查与测试：

```bash
pnpm typecheck
pnpm build
cd server && go vet ./... && go test ./...
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MERCHANDISER_DATA_DIR` | `/data` | 数据库、密钥文件、令牌与备份目录 |
| `MERCHANDISER_ADDR` | `:8686` | 监听地址 |
| `MERCHANDISER_WEB_DIR` | `/app/web` | 前端构建产物目录；不存在则只提供 API |
| `MERCHANDISER_TOKEN` | 自动生成 | 网页 / API 访问令牌 |
| `MERCHANDISER_MASTER_PASSWORD` / `_FILE` | — | 启动时自动解锁密钥文件 |
| `MERCHANDISER_BACKUP_ON_START` | — | 设为 `1` 时启动前备份数据库（保留最近 5 份） |
| `MERCHANDISER_DRAIN` | `2s` | 停机前排空请求的时间 |
| `MERCHANDISER_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `TZ` | `Asia/Shanghai`（compose） | 「今日」统计与日亏损上限按此时区零点计算 |

## 目录

```
server/            Go 服务
  cmd/             入口
  internal/engine  跟单引擎（每个任务一个 runner）
  internal/exchange Hyperliquid 与模拟盘适配器
  internal/plaza   跟单员广场：排行榜抓取与适配度评分
  internal/api     HTTP 命令与 SSE 事件流
  internal/store   SQLite 与迁移
src/               React 前端
design/            设计稿（静态 HTML）
deploy.sh          蓝绿部署脚本
```

## 风险提示

跟单存在延迟与滑点，信号源的历史表现不代表未来收益；高频钱包几乎无法被有效跟随。请先用模拟账户或小资金验证规则与风控设置。
