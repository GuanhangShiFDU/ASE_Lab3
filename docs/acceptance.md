# Lab3 联调与现场验收 · #71272994

验收基线为第 22 小组 [CodeArts lab3 仓库](https://devcloud.cn-north-4.huaweicloud.com/codehub/project/c1aa0a224dba4c2591226b87a5af9407/codehub/3123171/home?ref=master)的 `master`，完整提交 `87ba79ce0d47700cf2601bf072f9531915ef60f2`。2026-11-24 核对 GitHub 和 CodeArts 的 `master` 一致后，从 CodeArts 干净克隆验证。记录指向这次实际被测提交，后续文档提交仍须核对同步状态。

## 现场准备

使用全新克隆或新的 Compose 项目名，避免旧订单影响演示。以下命令从仓库根目录运行。镜像构建需要访问镜像仓库和 npm 源。演示环境保留终端，方便查看健康状态和按订单 ID 关联日志。

```sh
git rev-parse HEAD
git status --short
export COMPOSE_PROJECT_NAME=lab3-live-demo
docker compose up -d --build --wait
docker compose ps
sh scripts/smoke.sh
sh scripts/check-databases.sh
```

使用 `http://localhost:18080`，准备两个互不共享会话的窗口。正常流程选「乘客一」与「司机一」，冲突或改派时可加入乘客二、司机二。司机初始离线，地点可选人民广场与虹桥火车站。若默认本机端口已有占用，按 README 修改新项目的端口。

## 演示顺序

| 操作 | 预期结果 |
| --- | --- |
| 司机一上线；乘客一选点估价并叫车 | 显示模拟预估里程与费用，订单进入匹配，司机收到带截止时间的邀约 |
| 司机一接单，点击到达和上车 | 确认接单后双方状态一致，乘客详情显示司机姓名。上车后取消按钮消失，直接调用普通取消也会被拒绝 |
| 刷新乘客页，司机点击结束 | 刷新后可继续当前行程，完单进入历史，费用与时间可查，仍在线司机释放占用后可以继续接单 |
| 重新叫车，乘客在上车前取消，再次叫车 | 旧邀约撤销，新单 ID 不同。若取消前已接单，司机占用异步解除 |
| 司机都离线；再开启两名司机，做拒单和超时改派 | 无人时匹配失败。拒单或超时后换下一名司机，迟到的原邀约返回冲突 |
| 从第三个会话尝试访问别人的订单，或并发提交两个操作 | 后端校验归属。同一司机只承接一单，取消与上车只生效一个，重复请求不会额外产生订单 |
| 用 `?tiles=off` 打开界面 | 有坐标、起终点和操作按钮，主流程可继续。在线底图的可用性取决于网络 |
| 在独立测试项目运行故障复现 | 停 Driver 和 Query 后，已提交订单、待释放任务及待投递事件仍在；重启后能追赶，旧释放不会影响新单 |

故障复现和投影、并发的具体命令分别见 [Order 恢复](../contracts/order-recovery.md)、[Order Query](../contracts/order-query.md)、[Dispatch](../contracts/dispatch.md) 和 [Order 两级测试](order-testing.md)。各故障场景用不同的专用 Compose 项目运行。现场演示项目普通结束可用 `docker compose down` 保留数据；确需重置时按 README 操作，避免删除其他项目的卷。

## 实跑结果

| 检查 | 结果 |
| --- | --- |
| 干净克隆与启动 | 四个业务服务及 MySQL 通过健康检查，前端可访问。四个数据库账号越库访问均被拒绝。 |
| 两级测试 | Order 单元 8/8、真实 MySQL 组件 6/6；前端状态与按钮单元 3/3。 |
| 派单 | 无人可用、拒单和超时后的改派、他人无权接单、离线竞争、取消邀约、重启保留原截止时间均通过。 |
| 恢复与查询 | 实际停止 Driver 和 Query，再重启 Order 后成功补做释放与事件投递。重复事件去重，旧释放保留新占用。Query 可追赶、拒绝越权和旧版本，Driver 停机返回基础订单数据。 |
| 双角色操作 | 两个独立 Chrome 会话验证估价、接单、到达、上车、刷新、完单、历史、取消重叫，并在模拟瓦片失败时完成操作。 |

[环境与测试输出](evidence/lab3-acceptance/verification.txt) · [司机接单](evidence/lab3-acceptance/driver-assigned.png) · [乘客完单及历史](evidence/lab3-acceptance/passenger-completed.png) · [取消后重新叫车](evidence/lab3-acceptance/passenger-rebooked.png)

## 验收边界

这次记录的是固定候选在干净克隆中的执行结果。截图来自独立的 Chrome 乘客和司机会话，底图故障由测试拦截瓦片请求模拟。现场展示和授课方抽查由小组按上表执行。
