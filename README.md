# 永城八张在线版

这是一个将河南永城传统扑克玩法“八张”制作成在线多人网页游戏的项目。玩家可以通过电脑或手机浏览器创建房间，邀请远程朋友实时联机。

GitHub 仓库：https://github.com/postman777li/8cards

项目已建立工程基础结构，尚未开始游戏业务功能开发。任何开发窗口开始工作前，都必须先阅读 [AGENTS.md](AGENTS.md) 和 [docs/project-status.md](docs/project-status.md)。

## 文档导航

- [协作规则](AGENTS.md)
- [已确认游戏规则](docs/game-rules.md)
- [产品需求](docs/requirements.md)
- [系统架构](docs/architecture.md)
- [重要决策](docs/decisions.md)
- [项目状态](docs/project-status.md)
- [任务清单](docs/TODO.md)
- [多窗口工作方式](docs/workflow.md)
- 原始规则来源：`八张规则.docx`

## 当前目标

先冻结规则和第一版产品范围，再创建 GitHub 仓库、交互原型和工程代码。未经项目总控确认，不提前进入功能开发。

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

## UI 原型预览

任务 04 的本地视觉原型包含首页、创建房间、等待房间、游戏牌桌和结算五个场景。运行 `pnpm --filter @8cards/web dev` 后，可通过页面顶部的“原型场景导航”切换，也可直接访问：

- `http://localhost:5173/#/home`
- `http://localhost:5173/#/create`
- `http://localhost:5173/#/waiting`
- `http://localhost:5173/#/table`
- `http://localhost:5173/#/result`

原型只使用浏览器本地模拟状态，不连接服务端，不包含真实房间、聊天、游戏规则或战绩保存。

