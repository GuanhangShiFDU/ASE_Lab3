# Order Query 读服务 · #71272991

Order Query 维护自己的持久读模型，接收 Order 的异步快照事件。公开查询读取本地数据，订单详情和当前订单再通过 Driver API 补充司机姓名。写操作仍走 [Order](order-write.md)。

| 查询 | 身份 | 结果 |
| --- | --- | --- |
| `GET /orders/{id}` | 本人乘客或订单关联司机 | 订单快照，附 `driver` 和 `driverProfileStatus` |
| `GET /orders/current` | 乘客 | `{"order":<详情或 null>}` |
| `GET /drivers/me/order` | 司机 | `{"order":<详情或 null>}` |
| `GET /orders/history?limit=50&before=<cursor>` | 乘客 | `{"orders":[订单快照],"nextCursor":<字符串或 null>}` |

所有公开查询使用 Driver 签发的用户 Bearer JWT。详情存在但不属于本人返回 403，读模型尚未收到该订单或查无此订单返回 404。当前单只包含匹配中、已接单、已到达或行程中。历史只包含本人已完成、取消和匹配失败的订单，按最近更新时间倒序，`limit` 范围 1–100。翻页时把 `nextCursor` 作为 `before` 传入。历史列表直接用本地快照，点开详情再组合司机资料。

组合 Driver 的 `GET /internal/drivers/{id}` 后返回 `driver: {driverId, displayName}` 和 `driverProfileStatus: "AVAILABLE"`。暂时无法取得资料时仍返回 HTTP 200、完整订单快照、`driver: null`、`driverProfileStatus: "UNAVAILABLE"`。这里的 `AVAILABLE` 指资料成功取得，和司机是否在线空闲无关。尚未分配司机时使用 `NOT_ASSIGNED`。

## CQRS 与前端联动

[事件收件接口](order-recovery.md)先写入 `order_event_inbox` 再确认投递。后台将未处理事件投影到 `order_read_model`，同一事务写入快照和收件项的 `processed_at`。投影只接受更高 `orderVersion`，不会让重复或旧事件覆盖新状态。事务失败时保留未处理记录，循环继续扫描并重试，重启后也可追赶。读模型只关心最新状态，允许跳过已被更新快照覆盖的中间版本。Driver 组合使用单独超时，数据库仍可用时继续返回基础数据。

客户端收到成功写响应后，可以立即显示其中的状态和版本，再刷新读侧。在详情 404 或返回版本较旧时，保留该订单最新的成功写结果，等读侧版本追上后再用读模型替换。首次进入页面时，`order: null` 表示目前读不到有效单。历史和当前单的查询也受短暂投影延迟影响。

## 独立环境验证

在新建、可丢弃的 Compose 项目中运行。测试会创建订单并停止、重启服务。

```sh
export COMPOSE_PROJECT_NAME=lab3-query-demo
docker compose up -d --build --wait order order-query driver
node services/order-query/test/http-smoke.mjs --isolated-test-project
docker compose down
```

端口自定义时给测试设置 `ORDER_BASE_URL`、`ORDER_QUERY_BASE_URL` 和 `DRIVER_BASE_URL`。内部凭证自定义时设置 `LAB3_INTERNAL_TOKEN`。
