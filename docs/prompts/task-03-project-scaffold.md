# 任务 03 工程基础结构提示词

将下面提示词完整复制到新的 Codex 窗口。

```text
你正在处理 E:\8Cards 中的“永城八张在线版”项目。

这是完整路线图中的任务 03：工程基础结构。本窗口只能完成任务 03，不得提前实现后续任务。

一 开始前必须完成

1. 完整阅读以下文件：
   - E:\8Cards\AGENTS.md
   - E:\8Cards\README.md
   - E:\8Cards\docs\project-status.md
   - E:\8Cards\docs\TODO.md
   - E:\8Cards\docs\decisions.md
   - E:\8Cards\docs\architecture.md
   - E:\8Cards\docs\requirements.md
   - E:\8Cards\docs\workflow.md
   - E:\8Cards\docs\game-rules.md
2. 检查 Git 工作区和远程状态，确认当前 `main` 干净并与 `origin/main` 同步。
3. 从最新 `main` 创建并切换到分支：
   `feature/project-scaffold`
4. 开始修改前，先向用户报告：
   - 你理解的任务边界
   - 推荐的具体技术选型
   - 将创建的目录和文件
   - 验收命令
5. 如果发现当前工作区有不属于本任务的未提交修改，不得覆盖或删除，先向用户说明。

二 本任务目标

建立可持续开发的 TypeScript 单仓库基础，但不实现任何永城八张业务功能。

目标目录至少包括：

E:\8Cards
├─ apps
│  ├─ web
│  └─ server
├─ packages
│  ├─ game-engine
│  ├─ shared
│  └─ ui
├─ docs
└─ tests 或与所选测试方案一致的测试位置

三 技术要求

1. 优先使用当前稳定、维护活跃且适合后续部署的技术组合。
2. 建议但需先核实环境后确定：
   - Node.js 当前 LTS
   - pnpm workspace
   - TypeScript
   - 前端：React + Vite
   - 服务端：Node.js TypeScript 应用；本任务只提供最小健康检查骨架
   - 测试：Vitest
   - 静态检查：ESLint
   - 格式化：Prettier
3. 不要为了追求复杂架构引入暂时用不到的大量依赖。
4. 所有包应具有明确名称、入口、脚本和 TypeScript 配置。
5. 根目录应提供统一命令，至少覆盖：
   - 开发
   - 构建
   - 类型检查
   - 静态检查
   - 测试
   - 格式检查
6. 前端可以显示一个非常简单的工程启动占位页，但不能开始正式 UI 设计。
7. 服务端可以提供最小健康检查或启动入口，但不能实现房间、WebSocket 或游戏接口。
8. `game-engine`、`shared`、`ui` 只能建立清晰的包骨架、入口和最小测试，不得实现游戏规则。
9. 不得添加真实密钥或 `.env` 文件；如需要环境变量示例，只能创建 `.env.example`。
10. 保持 Windows PowerShell 环境可用，命令不得只适用于 Bash。

四 允许修改

- 根目录的工程配置文件
- `apps/`
- `packages/`
- 与基础工具相关的测试文件
- `.gitignore`
- `README.md` 中的开发启动说明
- `docs/architecture.md`
- `docs/decisions.md`
- `docs/project-status.md`
- `docs/TODO.md` 中任务 03 的执行记录

五 禁止事项

- 不得实现洗牌、发牌、牌力、出牌或任何八张规则。
- 不得实现房间、匹配、WebSocket、聊天、观战、登录或数据库业务。
- 不得制作正式牌桌 UI 或复制《欢乐斗地主》素材。
- 不得部署网站。
- 不得购买服务或创建外部资源。
- 不得修改 `八张规则.docx`。
- 不得合并到 `main`。
- 不得开始任务 04 或后续任务。
- 不得把任务 03 在 `TODO.md` 中最终勾选为 `[x]`；只有总控窗口验收并合并后才能勾选。

六 必须完成的验证

根据最终选型运行全部相应命令，至少应验证：

1. 依赖能够安装。
2. 所有 workspace 能完成类型检查。
3. ESLint 或所选静态检查通过。
4. Prettier 格式检查通过。
5. 所有测试通过。
6. 所有 workspace 能完成生产构建。
7. 前端开发服务器能够启动。
8. 服务端能够启动，最小健康检查可用。
9. `git status` 中不存在意外生成物或敏感文件。

如果某项因环境限制无法验证，必须说明具体命令、错误和影响，不能写成“应该可以”。

七 文档和 Git 要求

1. 如果技术选型产生新决策，更新 `docs/decisions.md`。
2. 更新 `docs/architecture.md` 中已经实际落地的结构。
3. 更新 `docs/project-status.md`，记录任务 03 已在分支完成并等待总控验收。
4. 在 `docs/TODO.md` 的任务 03 下记录验证结果，但保持任务复选框为 `[ ]`。
5. 提交所有本任务修改到 `feature/project-scaffold`。
6. 推送该分支到 `origin`。
7. 不创建或合并 Pull Request，除非用户另行要求。

八 最终报告格式

完成后必须明确报告：

- 任务：03 工程基础结构
- 状态：已在任务分支完成，等待总控验收
- 分支名称
- 提交 SHA
- 推送结果
- 最终技术选型及原因
- 新增或修改的主要文件
- 实际运行的验证命令及各自结果
- 是否存在警告、未验证项或风险
- 明确声明没有实现任何游戏业务功能
- 提醒用户回到项目总控窗口，并发送：
  “任务 03 已完成，这是任务窗口的最终报告，请验收 feature/project-scaffold。”

不要在本窗口继续任务 04。
```

