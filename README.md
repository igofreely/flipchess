# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

# 揭棋（手机可运行）

基于 `React + TypeScript + Vite + PWA` 的揭棋 MVP。

## 功能

- 9x10 中国象棋棋盘
- 将/帅明子开局，其余暗子随机落位
- 暗子首次按“初始位对应棋种”规则走，走后自动翻明
- 明子按真实身份行走
- 象、士支持过河
- 吃将即胜，支持重新开局
- PWA 可安装到手机桌面

## 本地运行

```bash
npm install
npm run dev
```

开发服务器启动后，在同一局域网手机浏览器访问提示地址即可。

## 构建

```bash
npm run build
npm run preview
```

## AI 接口规范

- 规范与接入文档见 `docs/ai-integration.md`

## 说明

当前为单机双人 MVP，不含联网与 AI。
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
