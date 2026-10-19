# 数据迁移边界

任务 18 首次引入 `HistoryStore`。开发适配器使用 SQLite；`game_id` 是对局幂等键，参与者关联与对局主记录在同一事务提交。

任务 20 已将存储契约升级为异步，并增加 `SqliteHistoryStore` 与 `PostgresHistoryStore` 两个适配器。存在 `DATABASE_URL` 时使用 PostgreSQL，否则继续使用本地 SQLite。SQL 方言分别位于 `apps/server/migrations/001_history.postgres.sql` 和 `001_history.sqlite.sql`，业务实时层不包含 SQL。

两个适配器都维护 `schema_migrations`。版本 1 建立 `games`、`game_visitors` 和访客查询索引；SQLite 旧库没有迁移记录时通过 `IF NOT EXISTS` 安全接管，PostgreSQL 使用事务和 advisory lock 保证多个启动者不会重复迁移。PostgreSQL 保存使用 `ON CONFLICT DO NOTHING` 和同事务参与者写入，保持 `game_id` 幂等。

迁移不得保存实时连接对象、房间权威状态、手牌、牌墩、随机源、聊天或重连令牌。应用重启会丢失进行中房间，已完成历史由 PostgreSQL 保留。

新增迁移只能追加更高编号，已部署迁移不得原地修改。生产迁移前先用 `scripts/backup-postgres.sh` 生成逻辑备份，并按 `docs/operations.md` 恢复到空白测试库演练。真 PostgreSQL 并发测试由 `POSTGRES_TEST_DATABASE_URL` 显式启用，变量必须指向名称包含 `8cards_test` 的隔离数据库。

任务 21 追加版本 2：`002_room_series.sqlite.sql` 与 `002_room_series.postgres.sql` 新增 `room_series` 汇总表，使用 `series_id` 幂等保存最终排名、积分、胜负、连胜和称号 JSON。版本 1 文件保持不变；SQLite 与 PostgreSQL 启动迁移均按 1、2 顺序跳过已应用版本。旧备份可直接向前迁移，回滚应用时版本 2 表可保留且不影响旧代码。

任务 23 不增加 SQL 迁移。已完成单局的 record_json 新增可选 roundResult 公共结算，包含名次、基础分、倍率、增减和累计分；旧记录没有此字段仍可读取。两种数据库继续按 game_id/series_id 幂等，不保存演出队列、手牌、牌墩或凭证。
