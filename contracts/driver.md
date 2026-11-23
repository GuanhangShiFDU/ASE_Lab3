# Driver 服务 · #71272988

Driver 服务从自己的 MySQL 库读取四个演示身份，维护司机在线和占用状态。初始两位司机都离线。已有开发卷若存了早期初始化产生的乱码，服务启动时只修正与旧种子字节完全一致的四个名字。账号 ID 可用 `passenger-1`、`passenger-2`、`driver-1`、`driver-2`。

| 方法和路径 | 身份 | 输入及结果 |
| --- | --- | --- |
| `POST /auth/login` | 演示账号选择 | `{"accountId":"passenger-1"}` → `{token, tokenType:"Bearer", expiresIn:28800, account:{id,role,displayName}}` |
| `GET /drivers/me/status` | 司机 JWT | 当前司机状态 |
| `PUT /drivers/me/status` | 司机 JWT | `{"online":true}` 或 `false` → 当前司机状态 |
| `GET /internal/drivers/available` | 服务凭证 | `{drivers:[...]}`，仅包含调用时在线且空闲的司机，按 ID 排序 |
| `GET /internal/drivers/{driverId}` | 服务凭证 | 单名司机的资料及状态，供 Query 组合和调度恢复 |
| `POST /internal/drivers/{driverId}/reserve` | 服务凭证 | `{"orderId":"订单的 UUID"}` → 更新后司机状态 |
| `POST /internal/drivers/{driverId}/release` | 服务凭证 | 同上 → `{released,driver}`，表示本次实际是否清掉该订单的占用 |

司机状态为 `{driverId, displayName, online, available, currentOrderId}`。未占用时 `currentOrderId` 为 `null`。前端可用登录结果中的 `account.role` 决定加载哪个界面，以 `Authorization: Bearer <token>` 调用业务接口。订单写服务和 Driver 使用相同的 HS256 JWT，`sub` 为预设账号 ID，另含 `role` 与 Unix 秒 `exp`。服务间调用走 `http://driver:3000`，使用 `Authorization: Bearer <LAB3_INTERNAL_TOKEN>`。两个配置项的本地值为开发示例，共享环境应替换为两个不同的随机值。生产账号认证需另做，预设身份选择只适用于课程演示。

统一错误结构为 `{error:{code,message}}`。非法数据 400、无效凭证 401、非司机访问本人状态 403、账号或司机不存在 404、不可用或已释放的占用请求 409、数据库或事务暂时失败 503。

## 事务与跨服务交接

- 候选查询是即时快照。占用时重新锁定司机记录，校验仍在线且空闲。唯一索引保证一笔订单同时至多占用一名司机。相同司机和订单的已成功占用可以重试，即使司机随后下线。
- 司机手动下线只改变在线标记。占用保留，Order 通过司机 JWT 和订单归属继续处理到达、上车和完单。释放后，只有仍在线的司机重新变为可用。
- 释放按司机与订单两者匹配，重试返回 `released:false`。每次释放都持久化该组合的释放记录，防止同一组合的延迟占用在取消或补偿后重新生效。其他订单的占用保持原值。
- Dispatch 后续先占用，再向 Order 确认接单。如果 Order 回包丢失，使用原键重试或查询权威快照；确认失败且不会继续分配时释放。最终释放由 #71272990 接入取消、完单及补偿流程。

## 验证

在新的 Compose 测试项目执行以下命令。测试会真正写入数据库，并留下一个占用给重启检查。使用自定义端口或服务凭证时，为测试进程设置 `DRIVER_BASE_URL`、`ORDER_BASE_URL` 和 `LAB3_INTERNAL_TOKEN`。

```sh
docker compose up -d --build --wait driver order
node services/driver/test/http-smoke.mjs
docker compose restart driver
docker compose up -d --no-recreate --wait driver
node services/driver/test/http-smoke.mjs --after-restart
```
