# 任务 23 实现与验收报告

验收日期：2026-10-19。分支：`feature/round-presentation-joker-rule`。基线：`origin/release/first-online@03a77d4edb6035a3269d444c26cb8e059cbceb9a`。提交完整 SHA 见交付消息及本分支 Git 日志。

任务 23 保持未勾选，等待项目总控验收。未合并发布分支或 main，未操作 Render。指定保留的本地文件未读取、修改或暂存。

## 八项反馈对应实现

| 反馈 | 最终行为 |
| --- | --- |
| 牌墩遮挡倒计时 | 牌墩、计时器和攻防牌分配独立空间；手机横屏使用并排的牌墩/计时通道，其余视口使用分离位置；短横屏收起页头/页脚，让操作区完整留在视口。真实 DOM 检查两者不相交；计时器层级高于飞牌、低于结算。 |
| 缺少单局完整排名 | 服务端生成 lastRoundResult，全体原参赛者都有名次、基础分、倍率、增减、总分及结果。单局使用金银铜圆章、头像、分数计数与逐行揭晓，支持内部滚动；短屏另存滚动到底的证据。 |
| 表情空图或相同 | 七种本地原创 React SVG：点赞、鼓掌、大笑、思考、惊讶、加油、捂脸；选择面板、玩家收到效果和观战效果复用同一绘图。浏览器验证每个 SVG 可见、尺寸非零、图形不同。 |
| 指定快捷语 | 原样加入豪到你了吗、惊天大孙伯、这猪÷、野猪、我日野猪。玩家与观战均经原聊天协议发送，保持纯文本、字节/长度、十秒五条及房间权限限制。观战聊天采用限高消息滚动区，竖屏为可收起抽屉，输入和发送按钮不会被消息挤出视口。 |
| 憋王过早判负 | 仅当前空桌主攻必须首攻且非空手牌全为王时判负；打掉最后普通牌、纯王防守、第二进攻者过牌均不提前失败。四人降级仍按原队伍结算。 |
| 发牌补牌不够明确 | 服务端发布逐张接收者队列和绝对展示时间。开局逆时针逐圈发牌，补牌按真实抽取顺序逐张飞出；本人已到达手牌逐张加入后排序，其他人只见牌背和公开数量。 |
| 动作反馈不足 | 增加洗牌聚拢、明牌揭示、行动转移、逐张飞牌、过牌座位标签、收牌汇拢、成功弃牌、名次和分数揭晓。演出期间不错误强调正在操作的玩家；所有效果有界且可清理。 |
| 彩蛋概率和演出 | 第三局起 40%，精确命中区间 [0,0.4)，2/3/4 倍等概率且覆盖连胜。彩蛋以大倍率、原创金色舞台、弹入/揭晓/退场及短音效表现；普通/连胜使用轻量不同提示。 |

## 新憋王规则测试矩阵

| 场景 | 二人 | 三人 | 四人 |
| --- | --- | --- | --- |
| 打出最后普通攻牌后只剩王仍继续 | joker-opening.test.ts | 同左 | 同左 |
| 纯王防守并正常出完 | 引擎测试 | 引擎 + 固定种子 5 的真实浏览器前后截图/JSON | 引擎测试 |
| 第二进攻者纯王可过牌 | 不适用 | 引擎测试 | 引擎测试 |
| 防守成功后成为空桌主攻才失败 | 引擎测试 | 引擎测试 | 引擎测试 |
| 收牌结算后新主攻纯王立即失败 | 引擎测试 | 引擎测试 | 引擎测试 |
| 一个王/大小王强制首攻 | 引擎测试 | 引擎测试 | 引擎测试 |
| 先补牌，补到普通牌可解除纯王状态 | 引擎测试 | 引擎测试 | 引擎测试 |
| 主 2 非回合交换不误判其他纯王玩家 | 引擎测试 | 引擎测试 | 引擎测试 |
| 原队伍与降级后的提前结算 | 不适用 | 不适用 | series.test.ts 原队伍测试 + 四人真实憋王结果 |
| 超时与初始化/降级检查 | 创建/动作与 resolveTwoPlayerState 共用检查；超时在选牌前再 resolve | 对应 Three API | 对应 Four API |
| 固定种子整局、守恒、输入不可变与确定性复跑 | 100 种子复跑 | 100 种子复跑 | 100 种子复跑 |

主 2 交换用普通牌换取普通明牌，按现有牌具本身不可能凭空把交换者变为纯王；测试验证交换不会误伤其他非首攻的纯王玩家。原先沿座次扫描任意纯王的判定已移除，旧测试改为强制首攻边界。

## 权威单局结果、恢复与存储

- lastRoundResult 包含 roundNumber、reason 和所有原参赛者的 playerId/rank/baseScore/multiplier/delta/totalScore/outcome。客户端只排序服务端给出的名次供展示，不计算本局排名或分数。
- 普通局保存完整 1/2、1/2/3、1/2/3/4。三人中间名次明确显示未决。四人个人名次与原队伍计分分别表达。
- 提前结束按标准竞赛名次：二人 1/2；三人非失败者 1/1、失败者 3；四人胜队 1/1、负队 3/3，不用部分 finishOrder 假造完整顺序。
- 严格 schema 拒绝未知字段、重复 ID、错误竞赛名次、非零和增减、错误倍率乘法。没有手牌、牌墩、随机源或凭证。
- 计分仍由 roundScored 保护，历史按 game_id/series_id 唯一键幂等。已完成单局后退出不会再次计分。
- 刷新、重连、投票保留原结果；下一局清除旧结果和演出。单局 record_json 可选 roundResult 同步保存权威数据，旧记录仍兼容，无 SQL 迁移。退出先取消行动/演出计时器再等待历史保存，慢速数据库期间不会继续自动出牌（专门回归测试覆盖）。退出也保存单局历史；首次写入失败保留 pending 并可经历史查询重试。

## 权威演出时序

- 开局：普通/连胜引导 650ms，彩蛋开场 1900ms；每张 100ms，最后收敛 350ms。所有时刻由服务器生成。
- 补牌：无额外开场，每张 140ms，最后收敛 350ms。飞牌按实际 DOM 座位锚点定位，经牌桌中线绕开计时器；接收者从实际消耗的牌墩和最终手牌归属生成，不能用净牌数变化误把收牌当补牌；降级补牌仍从原本轮主攻沿座次处理。
- 演出窗口内 turnDeadline=null，私有 legalActionTypes 为空，服务器拒绝包括抢先合法首攻在内的所有游戏动作。服务器回调原子结束窗口后才开始完整 20 秒计时并广播新版本；即使边界请求先于排队回调到达，也不能取消激活并留下过期演出（专门回归测试覆盖）。
- 公开队列只有接收者、开始牌数、牌墩数量及起止时间，不含牌面。本人只展示已经到达的私有手牌部分，其他玩家及观战者只见牌背/数量。
- 重连依据同一 id/readyAt 恢复当前进度；过期直接收敛，不补播旧队列。浏览器实际验证中途刷新和后台冻结后无幽灵飞牌、最终手牌正确。
- 动画主体为 transform/opacity；减弱动态改为逐张计数/淡入，服务器边界不受客户端偏好影响。Web Audio 失败、未解锁、关闭音效或页面隐藏均不会阻断游戏。音效使用最多 128 个公开事件键的标签页缓存，刷新不重播同一权威音效；选择音效不写此缓存。

## 质量门禁

| 项目 | 结果 |
| --- | --- |
| pnpm install --frozen-lockfile | 通过，锁文件未改变 |
| pnpm typecheck / lint / format:check | 通过 |
| pnpm test | 33 个文件：32 通过，1 条件跳过；331 项通过，2 项 PostgreSQL 条件跳过 |
| pnpm test:coverage | 语句 92.00%，分支 86.71%，函数 100%，行 93.78%，门槛通过 |
| pnpm build | 通过；网页 JS 384.67KB / gzip 116.41KB，CSS 49.31KB / gzip 11.51KB |
| pnpm test:e2e | 10 项真实浏览器验收；最终结果见仓库外 HTML/JSON 报告 |
| git diff --check origin/release/first-online...HEAD | 通过，提交后再次按完整提交区间复核 |

真实 PostgreSQL 因本机没有获授权的隔离测试库而跳过，没有伪造真库通过。SQLite 幂等、持久化、失败重试及旧记录回归正常。

## 仓库外证据

根目录：`C:\Users\12571\8cards-task23-evidence`。下表文件名均相对此根目录；manifest.json 列出完整绝对路径、大小和 SHA-256。

| 场景 | 文件 |
| --- | --- |
| 牌墩/计时器三视口 | screenshots/clock-stock-1440x900.png、clock-stock-844x390.png、clock-stock-390x844.png |
| 开局逐张发牌三视口 | screenshots/two-initial-deal-1440x900.png、two-initial-deal-844x390.png、two-initial-deal-390x844.png；另有 3-initial-deal-*、4-initial-deal-* |
| 逐张补牌桌面/横屏 | screenshots/two-refill-1440x900.png、two-refill-844x390.png；另有 3-player-refill-*、4-player-refill-* |
| 七表情与发送效果 | screenshots/seven-reactions-desktop.png、seven-reactions-spectator-phone.png、reaction-burst-0.png、reaction-burst-1.png、reaction-burst-2.png |
| 二人单局三视口 | screenshots/two-round-ranking-1440x900.png、two-round-ranking-844x390.png、two-round-ranking-390x844.png |
| 三人普通排名 | screenshots/3-round-ranking-1440x900.png |
| 四人普通排名 | screenshots/4-round-ranking-1440x900.png、4-round-ranking-844x390.png 及对应 scrolled-bottom 图片 |
| 四人团队憋王 | screenshots/4-joker-team-ranking-1440x900.png；4-joker-round-result.json |
| 三人纯王合法防守 | screenshots/three-pure-joker-defender-before.png、three-pure-joker-defender-after.png；three-pure-joker-defense.json |
| 彩蛋三视口 | screenshots/easter-egg-1440x900.png、easter-egg-844x390.png、easter-egg-390x844.png |
| 最终榜三视口 | screenshots/desktop-two-round-series-result-1440x900.png、mobile-landscape-final-ranking-844x390.png、mobile-portrait-final-ranking-390x844.png；文件名前缀沿用旧测试，实际完成三局 |
| 轨迹与揭晓机器时间线 | two-three-round-timeline.json、3-round-timeline.json、4-round-timeline.json：记录每 50ms 的队列 id/逐张序号、飞牌接收者和几何坐标、已显示手牌数量、牌墩数量、彩蛋出现与排名透明度 |
| 几何/恢复/社交/性能 | *-geometry.json、presentation-recovery.json、social-acceptance.json、*-timeline-performance.json |
| 测试报告 | automation/playwright/report/index.html、automation/playwright/playwright-results.json |

使用有界机器时间线作为动态证据，不把包含私有协议载荷和恢复凭证的原始 trace 分发给其他玩家。时间线只保存公开动画指标及本人显示数量。

## 隐藏信息、性能与风险

- 继续使用服务端安全随机源、严格动作序号/版本/身份/权限。测试入口的固定随机源仅存在本地验收进程，不暴露为网页开关、请求字段或生产环境变量。
- 玩家帧检查其他玩家凭证不交叉；观战帧、DOM、存储检查无 private 手牌、完整 stock 或其他玩家凭证。本人浏览器保留本人白名单恢复凭证是既有恢复机制。
- 七表情为受控 SVG；快捷语经纯文本聊天。原有 XSS、UTF-8、限流、跨房间与权限测试继续通过。无商业图片/音频/字体或新增大型框架。
- 飞牌节点同时最多一张；动作汇拢最多八张牌背；反应只保留一条。所有 interval/timeout/rAF 和音频 Context 均有清理，下一局不残留旧节点。
- CPU 四倍减速的浏览器采样见 performance JSON；这是桌面模拟降速，不能代替真实低端手机硬件帧率和内存验收。本轮手机触控为浏览器触控模拟，未唤醒用户进行物理手机复测。
- 新增严格协议字段后，旧页面部署时需要刷新获取新前端；如回退到完全不认识 roundResult 的旧代码，需先评估新增历史 JSON 字段的兼容性。本轮不发布 Render，未执行公网新版本和生产 PostgreSQL 验收；单实例进行中房间仍是内存状态，进程重启不能恢复。

请回项目总控窗口验收本分支及证据。验收后由总控决定合并和发布，本窗口不自行执行。

## 关键证据绝对路径

- `C:\Users\12571\8cards-task23-evidence\screenshots\clock-stock-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\clock-stock-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\clock-stock-390x844.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-initial-deal-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-initial-deal-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-initial-deal-390x844.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-refill-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-refill-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\seven-reactions-desktop.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\seven-reactions-spectator-phone.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\reaction-burst-0.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\reaction-burst-1.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\reaction-burst-2.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-round-ranking-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-round-ranking-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\two-round-ranking-390x844.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\3-round-ranking-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\4-round-ranking-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\4-round-ranking-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\4-round-ranking-844x390-scrolled-bottom.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\4-joker-team-ranking-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\easter-egg-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\easter-egg-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\easter-egg-390x844.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\desktop-two-round-series-result-1440x900.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\mobile-landscape-final-ranking-844x390.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\mobile-portrait-final-ranking-390x844.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\three-pure-joker-defender-before.png`
- `C:\Users\12571\8cards-task23-evidence\screenshots\three-pure-joker-defender-after.png`

动态时间线：`C:\Users\12571\8cards-task23-evidence\two-three-round-timeline.json`、`C:\Users\12571\8cards-task23-evidence\3-round-timeline.json`、`C:\Users\12571\8cards-task23-evidence\4-round-timeline.json`。
