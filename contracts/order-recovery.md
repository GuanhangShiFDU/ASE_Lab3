# Order 跨服务恢复与事件投递 · #71272990

Order 的状态是业务权威。取消、完单、对应 Outbox 快照事件和司机释放任务在同一个 MySQL 事务中写入。HTTP 命令成功表示订单已提交，司机占用和查询投影会异步追上。已有数据卷中已取消或已完单且曾绑定司机的订单会补登记释放任务。

Order 后台有两个独立循环。一条向 Driver 的 `POST /internal/drivers/{id}/release` 发送原订单 ID。Driver 根据订单 ID 释放，迟到的旧任务不会清掉新订单的占用。另一条将 Outbox 中待处理的 `OrderSnapshotChanged` 快照发给 Order Query。两个循环互不等待。接收方暂时不可用时，Order 保存重试次数、下次尝试时间和最近错误，并按 1、2、4 秒递增，最多每 30 秒重试。Order 重启后从数据库恢复。日志包含订单 ID、任务 ID 和处理状态。

## 事件传输与投影交接

- `POST /internal/order-events` 使用独立的服务 Bearer 凭证 `LAB3_INTERNAL_TOKEN`，请求体是 [Order 快照事件](order-write.md)。
- Order Query 把事件写入独立 MySQL 库的 `order_event_inbox` 后返回 204。相同事件 ID 和相同内容重放仍返回 204，内容冲突返回 409。事务成功收件后才确认，Order 得到 2xx 后才记录 `published_at`。
- 传输为异步后台任务通过内部 HTTP 推送，采用至少一次交付。重试可能带来重复或乱序。后续 Query 投影按订单的 `orderVersion` 判断新旧，并在更新独立读模型的同一事务中设置收件箱的 `processed_at`。
- 比 Lab2 更轻量的传输方案保留了服务边界和持久投递，用 HTTP 加数据库收发箱替代外部消息中间件。公开查询、投影和司机数据组合由 #71272991 接入。

## 接单失败与取消竞争

沿用 Dispatch 持久化的 `ACCEPTING` 状态和按邀约生成的稳定确认键。占用成功后，Dispatch 可能没收到 Order 的确认响应，下一轮读取权威快照或使用原键确认。明确判定未分配时才补偿释放。若 Order 最终取消或完单，释放任务由本卡的 Order worker 继续处理。重复释放可安全执行。

## 本地验证

测试会写入订单、重启 Order、暂时停止 Driver 和 Order Query。请在专用且全新的 Compose 项目运行。

```sh
export COMPOSE_PROJECT_NAME=lab3-recovery-demo
docker compose up -d --build --wait order order-query driver
node services/order/test/recovery-smoke.mjs --isolated-test-project
docker compose down
```

自定义端口时为测试设置 `ORDER_BASE_URL`、`ORDER_QUERY_BASE_URL`、`DRIVER_BASE_URL`，自定义服务凭证时设置 `LAB3_INTERNAL_TOKEN`。用例会在已收件后重新设置待投递标记来验证回执丢失时的重发行为。
