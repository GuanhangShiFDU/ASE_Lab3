# ASE Lab 3 · 网约车平台微服务开发

2026 高级软件工程 · 第 22 小组。[作业要求](https://openmsg.yuque.com/openmsg/gp3cfs/kyho3e4luti0xo6a) · 截止 2026-11-25。

平台包含四个可独立运行的 Node.js 24 服务、MySQL 8.4 和双角色前端。各服务的健康接口会检查自己的数据库连接。

## 启动

```sh
docker compose up -d --build --wait
docker compose ps
sh scripts/smoke.sh
```

| 服务 | 职责 | 本机健康检查 |
| --- | --- | --- |
| Order | 订单写模型与状态规则 | http://localhost:18101/health |
| Order Query | 订单读模型与组合查询 | http://localhost:18102/health |
| Driver | 预设身份、司机资料、在线与占用 | http://localhost:18103/health |
| Dispatch | 派单与匹配进度 | http://localhost:18104/health |

前端入口为 http://localhost:18080。见[双角色端到端步骤](contracts/frontend.md)。可复制 `.env.example` 为 `.env` 修改本机端口。运行 `docker compose down` 停止环境。容器间用服务名和端口 3000 访问。见[接口基线](contracts/README.md)。

## 数据库与演示数据

Compose 内使用 `db:3306`，MySQL 端口不映射到宿主机。每个服务收到自己的 `DB_HOST`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`。四个账号只获准访问各自的库 `lab3_order`、`lab3_order_query`、`lab3_driver` 和 `lab3_dispatch`。跨服务读取通过接口或事件。应用容器不使用 root 账号。

首次启动在 Driver 库的 `demo_accounts` 表预置以下可登录的身份。

| 角色 | 账号 ID |
| --- | --- |
| 乘客 | `passenger-1`、`passenger-2` |
| 司机 | `driver-1`、`driver-2` |

用 `sh scripts/check-databases.sh` 检查四个库的权限隔离及预置身份。配置示例包含本地演示默认值。在共享环境通过未提交的 `.env` 设置独立密码，应用库密码使用至少 8 个字母、数字、下划线或连字符。

`docker compose down` 会保留数据。确认当前目录和 Compose 项目名对应的是可丢弃的 Lab3 开发环境之后，运行以下命令可重新初始化。**第一条会删除该项目的数据库卷和全部开发数据。**

```sh
docker compose down --volumes
docker compose up -d --build --wait
sh scripts/check-databases.sh
```

首次初始化才会应用账号和种子。可丢弃的环境可以按上述步骤重建来更改数据库密码。需要保留数据时，应先在 MySQL 内更新账号密码，再同步修改配置。

## Order 自动化测试

单元测试需要 Node.js 24 或更高版本，无需启动数据库：

```sh
node --test services/order/test/domain.test.mjs services/order/test/application.test.mjs
```

组件测试需要 Docker 与 Docker Compose。脚本自动创建独立测试项目和 MySQL `lab3_order_test` 库，使用完会清理。无需先启动整个平台：

```sh
sh scripts/test-order-components.sh
```

测试范围、环境与一次实跑结果见 [Order 测试记录](docs/order-testing.md)。

## 分工

| 成员 | 任务 |
| --- | --- |
| 史冠航 | 仓库及 Compose、Order Query、报告与交付 |
| 李全昊 | Order 领域与行程、Driver 服务 |
| 刘子扬 | Dispatch、跨服务恢复与事件投递 |
| 刘乐翔 | 双角色界面与地图 |
| 杨润东 | Order 单元及组件测试、现场验收 |

## CodeArts 同步

在原 CodeArts 项目中创建空的独立 `lab3` 仓库。GitHub 本仓库的 Actions Repository secret 使用 `CODEARTS_SSH_PRIVATE_KEY`，可复用 Lab2 的专用同步密钥。对应 CodeArts 账号需要对 `lab3` 有写权限。

工作流合并到 GitHub `master` 后自动推送，也可在 Actions 手动运行 **Sync master to CodeArts**。工作流会校验两端提交 SHA，并在历史分叉时保留原记录、报告失败。
