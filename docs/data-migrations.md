# 数据迁移边界

任务 18 首次引入 `HistoryStore`。开发适配器使用 SQLite，启动时以幂等 DDL 创建 `games` 与 `game_visitors`；`game_id` 是对局幂等键，参与者关联与对局主记录在同一事务提交。

未来 PostgreSQL 迁移时保持 `HistoryStore.saveGame` 和 `getVisitorHistory` 领域契约不变，仅替换连接、占位符、DDL 和事务实现。迁移不得把实时连接对象、房间权威状态、手牌、牌墩、随机源或重连令牌写入历史库。正式部署前需把当前启动 DDL 转为带版本号的迁移文件，并增加备份、恢复和并发写入验收；这些部署工作属于任务 20。
