# Dispatch 派单与匹配 · #71272989

Dispatch 定时从 Order 的 `GET /internal/orders/matching?after=<cursor>` 读取分页快照，订单写成功后即进入可发现范围。依据 Driver 的在线空闲列表，按司机 ID 每次只邀请一名尚未尝试的司机。Dispatch 自己的 MySQL 库保存匹配截止时间、已尝试司机、当前邀请、邀请快照及回应结果。

默认单次邀约 15 秒，总匹配 60 秒，从订单创建时起算。拒单、超时或接单时司机已离线会改派；候选用完或到达总期限时写回 Order 的 `MATCH_FAILED`。取消时撤销未处理邀约。容器重启后读取原记录和截止时间，不延长原邀请。用 `DISPATCH_OFFER_MS`、`DISPATCH_MATCH_MS`、`DISPATCH_POLL_MS` 调整测试节奏。

| 接口 | 响应 |
| --- | --- |
| `GET /drivers/me/offers` | `200 {offers:[...]}`，仅本人有效的 `PENDING` 及正在确认的 `ACCEPTING` |
| `GET /offers/{id}` | 200，单条本人邀约，可查询最终状态 |
| `POST /offers/{id}/accept` | 空请求体。202 表示 `ACCEPTING`，200 表示已确认 `ACCEPTED` |
| `POST /offers/{id}/reject` | 空请求体。200，状态 `REJECTED` |

邀约返回 `{offerId,orderId,driverId,expiresAt,status,pickup,dropoff,estimatedFareCents}`。统一使用 Driver 签发的司机 Bearer JWT。非本人返回 403，缺失或无效凭证 401，不存在 404，过期、已拒绝或已失效时尝试接单返回 409。前端遇到 202 可以轮询单条邀约与订单状态。收到 200 且 `ACCEPTED` 后才能显示确认成功。

接单先原子保存 `ACCEPTING`，再请求 Driver 占用和 Order 确认，Order 幂等键从邀约 ID 生成。进程重启可继续处理 `ACCEPTING`。若 Order 已取消或确认明确失败，则按原订单 ID 释放该司机。网络错误留待重试；日志以订单 ID 关联。正常确认后的取消、完单自动释放以及独立的 Outbox 投递由 #71272990 接入。当前版按单个 Dispatch 实例运行。

## 复现

用独立的 Compose 测试项目，以免写入日常数据。Node 脚本会停止并重新启动该项目的 Dispatch，验证过期和改派。

```sh
export COMPOSE_PROJECT_NAME=lab3-dispatch-demo
export DISPATCH_OFFER_MS=6500 DISPATCH_MATCH_MS=40000 DISPATCH_POLL_MS=250
docker compose up -d --build --wait order driver dispatch
node services/dispatch/test/http-smoke.mjs
docker compose down
```

测试默认使用服务本机端口。自定义端口时同时设置 `ORDER_BASE_URL`、`DRIVER_BASE_URL`、`DISPATCH_BASE_URL`，自定义服务凭证时设置 `LAB3_INTERNAL_TOKEN`。
