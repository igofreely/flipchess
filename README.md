# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

# 揭棋（客户端 + 服务器版）

基于 `React + TypeScript + Vite + PWA + Express` 的揭棋项目，支持本地客户端与服务器对局管理。

## 功能

- 客户端揭棋对局（双 AI、音效、复盘、PGN 导入导出）
- 服务器账号体系（注册/登录/JWT）
- 服务器对局管理（PVP / VS AI / AI VS AI）
- 平台级统计与排行榜

## 本地运行

```bash
npm install
npm run dev
```

开发服务器启动后，在同一局域网手机浏览器访问提示地址即可。

## 服务器运行

```bash
npm run server:dev
```

默认端口 `3001`，可通过 `PORT` 环境变量修改。

API 文档：`docs/server-api.md`

## 前端接入服务器

在项目根目录创建 `.env`：

```bash
VITE_SERVER_API_BASE=http://localhost:3001/api
```

然后分别启动：

```bash
npm run server:dev
npm run dev
```

进入页面后切换到“服务器模式”，即可注册/登录并创建在线对局。

服务器模式下支持直接导出当前在线对局为 PGN（含初始局面快照 `FlipChessSetup`，可用于准确复盘）。

## 构建

```bash
npm run build
npm run preview
```

## AI 接口规范

- 规范与接入文档见 `docs/ai-integration.md`

## 说明

- AI Provider 规范与接入：`docs/ai-integration.md`
- 服务器 API：`docs/server-api.md`
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
