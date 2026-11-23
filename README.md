# ASE Lab 3 · 网约车平台微服务开发

2026 高级软件工程 · 第 22 小组。[作业要求](https://openmsg.yuque.com/openmsg/gp3cfs/kyho3e4luti0xo6a) · 截止 2026-11-25。

当前骨架包含四个可独立运行的 Node.js 24 服务和健康接口。订单、数据库、消息投递、界面与正式测试随对应卡片实现。

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

可复制 `.env.example` 为 `.env` 修改本机端口。运行 `docker compose down` 停止环境。容器间用服务名和端口 3000 访问。见[接口基线](contracts/README.md)。

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
