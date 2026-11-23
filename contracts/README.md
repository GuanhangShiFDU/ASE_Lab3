# Lab3 接口基线（供各任务联调）

范围为上海单城。量纲用整数米、整数分；时间使用 UTC ISO 8601；地点提供经纬度和标签，界面按经度、纬度传值。

| 服务 | 首批 HTTP 接口 |
| --- | --- |
| Driver | `POST /auth/login`、`PUT /drivers/me/status`、内部司机资料及占用/释放 |
| Order | `POST /orders/estimate`、`POST /orders`、`POST /orders/{id}/{cancel,arrive,start,finish}` |
| Dispatch | `GET /drivers/me/offers`、`POST /offers/{id}/{accept,reject}` |
| Order Query | `GET /orders/{id}`、`GET /orders/history`、`GET /drivers/me/order` |

业务接口采用 JSON。客户端通过 Bearer token 表示预设身份，服务须验证身份和资源归属。错误结构为 `{"error":{"code":"STATE_CONFLICT","message":"..."}}`。越权、非法状态与暂时不可用分别使用 403、409、503。

订单主链 `MATCHING → ASSIGNED → ARRIVED → IN_PROGRESS → COMPLETED`。匹配中可转 `MATCH_FAILED`；上车前可以转 `CANCELED`。接单与取消、上车与取消通过订单写入条件裁决。Driver 以订单标识绑定和释放占用，避免旧请求释放新单。创建及状态命令使用 `Idempotency-Key`，重复请求返回原结果，取消后重叫使用新键。

Order 在写事务中记录订单快照事件。建议事件包含 `eventId`、`type: OrderSnapshotChanged`、`schemaVersion: 1`、`orderId`、`orderVersion`、`occurredAt` 和 `snapshot`。读侧只接受更高版本，快照包含当前状态、乘客/司机标识、起终点、时间与费用摘要。客户端用写响应的状态和版本，查询追上之前避免界面回退。组合司机资料失败时保留订单基本内容并标记资料暂不可用。

各服务自行管理业务表。Order 与 Driver、Dispatch 与 Order 的内部调用格式、恢复进度和重试策略由对应任务在首轮联调前补齐。
