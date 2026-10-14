# 永城八张在线版

这是一个将河南永城传统扑克玩法“八张”制作成在线多人网页游戏的项目。玩家可以通过电脑或手机浏览器创建房间，邀请远程朋友实时联机。

GitHub 仓库：https://github.com/postman777li/8cards

项目已完成二至四人规则、实时房间、断线恢复、聊天、观战、战绩和全系统测试，正在执行部署与正式上线。任何开发窗口开始工作前，都必须先阅读 [AGENTS.md](AGENTS.md) 和 [docs/project-status.md](docs/project-status.md)。

## 文档导航

- [协作规则](AGENTS.md)
- [已确认游戏规则](docs/game-rules.md)
- [产品需求](docs/requirements.md)
- [系统架构](docs/architecture.md)
- [重要决策](docs/decisions.md)
- [项目状态](docs/project-status.md)
- [任务清单](docs/TODO.md)
- [多窗口工作方式](docs/workflow.md)
- [部署运维手册](docs/operations.md)
- 原始规则来源：`八张规则.docx`

## 当前目标

先通过 Render + Neon 新加坡免费环境完成公网预发布验收，稳定后迁移到腾讯云中国大陆正式生产。当前架构只允许一个应用实例；应用重启会丢失进行中房间，已完成历史由 PostgreSQL 保留。

## 本地开发

需要 Node.js 24 LTS 和 pnpm 11。首次使用先安装依赖：

```powershell
pnpm install
```

常用命令：

```powershell
pnpm dev          # 同时启动网页与服务端开发进程
pnpm build        # 构建全部 workspace
pnpm typecheck    # TypeScript 类型检查
pnpm lint         # ESLint 静态检查
pnpm test         # 运行 Vitest 测试
pnpm format:check # 检查代码格式
```

网页开发地址默认为 `http://localhost:5173`，服务端健康检查默认为 `http://localhost:3001/health`。

生产环境变量说明见 [.env.example](.env.example)，操作、备份、恢复、发布和回滚步骤见 [docs/operations.md](docs/operations.md)。真实密码和连接串不得写入本地文档、Git、日志或聊天。

## UI 原型预览

任务 04 的本地视觉原型包含首页、创建房间、等待房间、游戏牌桌和结算五个场景。运行 `pnpm --filter @8cards/web dev` 后，可通过页面顶部的“原型场景导航”切换，也可直接访问：

- `http://localhost:5173/#/home`
- `http://localhost:5173/#/create`
- `http://localhost:5173/#/waiting`
- `http://localhost:5173/#/table`
- `http://localhost:5173/#/result`

原型只使用浏览器本地模拟状态，不连接服务端，不包含真实房间、聊天、游戏规则或战绩保存。

