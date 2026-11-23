# Order 写服务 · #71272987

Order 是订单写入权威。接口层解析 HTTP 并验证身份，应用层协调命令与幂等，领域层维护订单聚合，设施层管理 MySQL 事务。四层对应 `services/order/src/{interface,application,domain,infrastructure}`。

| 调用 | 身份 | 入参 / 结果 |
| --- | --- | --- |
| `POST /orders/estimate` | 乘客 | `{pickup, dropoff}` → 预估米数与分数 |
| `POST /orders` | 乘客 | 同估价请求 → 201 和 `MATCHING` 快照 |
| `POST /orders/{id}/cancel` | 订单乘客 | 空体 → 200 和 `CANCELED`，上车后拒绝 |
| `POST /orders/{id}/arrive`、`/start`、`/finish` | 承接司机 | 空体 → 200 和更新后的快照 |
| `POST /internal/orders/{id}/assign` | Dispatch / 恢复调用方 | `{"driverId":"driver-1"}` → 200 和 `ASSIGNED` |
| `POST /internal/orders/{id}/match-failed` | Dispatch | 空体 → 200 和 `MATCH_FAILED` |
| `GET /internal/orders/{id}` | 服务调用方 | 200 和写模型快照，供结果确认与恢复 |

地点格式为 `{label, longitude, latitude}`，限上海演示坐标范围。价格是直线距离按每公里 250 分加 1200 分起步费的模拟结果，完单沿用估算的米数和分数。命令响应是快照本身，包含 `orderId`、`passengerId`、`driverId`、`status`、`orderVersion`、`pickup`、`dropoff`、`estimatedDistanceMeters`、`estimatedFareCents`、`distanceMeters`、`fareCents` 及各状态时间。估价只返回两项 `estimated*` 字段。

预设登录由 Driver 卡实现，签发 HS256 Bearer JWT，密钥为 `LAB3_AUTH_SIGNING_KEY`，必要声明为 `sub`（账号 ID）、`role`（`passenger` 或 `driver`）、`exp`（Unix 秒）。内部地址用独立的 Bearer `LAB3_INTERNAL_TOKEN`。共享环境用不同的随机值替换开发默认值，浏览器只接收用户 JWT。

写命令使用 `Idempotency-Key`（1–128 个 ASCII 字母、数字或 `._:-`）。同一身份用同键重试返回首次提交的状态码和快照，改请求内容返回 409。不同键重复有效动作不会再次更新时间、版本或费用。取消重叫需要新键。错误格式统一为 `{"error":{"code":"STATE_CONFLICT","message":"..."}}`。参数错误 400，身份无效 401，操作人不属于订单 403，不存在 404，状态/占用/请求键冲突 409，数据库暂不可用 503。

以接单为例，接口验证服务凭证，应用层取幂等记录，仓储锁住订单行，聚合确认订单仍在匹配中。数据库用唯一索引保证同一乘客和司机各至多绑定一笔有效订单。取消与上车由同一订单行锁确定先后。匹配失败、取消及完单会释放 Order 内的占用索引。Dispatch 需先验证邀约有效，Driver 的在线检查、预留与释放，以及跨服务恢复由相应卡片实现。内部接口可用原请求键重试确认，也可查询权威订单状态用于恢复判断。

同一个 MySQL 事务写入订单、成功请求的结果与 `order_outbox`。事件类型为 `OrderSnapshotChanged`，外层包括 `eventId`、`schemaVersion: 1`、`orderId`、`orderVersion`、`occurredAt`、`snapshot`。投递方从 `order_outbox` 查询 `published_at IS NULL`，用 `sequence` 排序，投递确认后才能标记。同一订单版本最多生成一条事件，Query 消费时按 `orderVersion` 去重、拒绝旧快照。跨服务投递由 #71272990 接入，测试查询服务和界面应走 Order Query 卡的公开读接口。

## 验证

- 单元测试使用 `node --test services/order/test/domain.test.mjs`。
- 在一个新的、专用 Compose 项目中执行 `docker compose up -d --build --wait order`，然后运行 `node services/order/test/http-smoke.mjs`。使用其他端口时设置 `ORDER_BASE_URL`。使用自定义密钥时为测试进程提供同名环境变量。用例会真正写入订单，请在独立测试库或新测试卷执行。
