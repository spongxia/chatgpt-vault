# ChatGPT Vault

ChatGPT Vault 是一个本地优先、支持多语言的 ChatGPT 聊天记录管理器。它支持 Markdown、LaTeX、代码、表格、附件和折叠工具输出，也支持选择性增量同步与官方兼容的 `conversations.json` 导出。

这是独立社区项目，与 OpenAI 没有隶属关系。

## 支持语言

English、简体中文、Français、Español、日本語、العربية、Deutsch、Italiano、Português。

## 主要功能

- 聊天记录以 JSON 保存在本地，不需要云数据库或 API Key。
- 类似 ChatGPT 的三栏阅读界面，左栏和中栏可独立折叠。
- Markdown、代码块、表格、引用、链接、附件和本地 KaTeX 公式渲染。
- 上传文件全文、网页检索、工具调用和生成文件默认折叠。
- 可选 Tampermonkey/Violentmonkey 油猴脚本，按选择增量同步。
- 搜索、收藏、归档、重命名、标签、暗色模式和阿拉伯语 RTL 布局。
- 单条会话导出 Markdown/JSON，以及官方兼容的 `conversations.json`。
- 提供零依赖 macOS 启动器，可检测并安装 Node.js、启动本地服务并自动打开浏览器。
- 以轻量本地 Web 应用运行，方便自行扩展或封装。

## 快速开始

需要 Node.js 18+：

```bash
npm install
npm start
```

打开 <http://127.0.0.1:4318>。默认数据目录为 `data/conversations`，也可以使用 `CHATGPT_VAULT_DATA_DIR` 修改。

在 macOS 上也可以直接双击 [ChatGPT Vault Launcher.app](../../launcher/ChatGPT%20Vault%20Launcher.app)，无需打开终端。请保持启动器位于项目根目录的 `launcher/` 文件夹中。

## 选择性同步

在应用的“导入与同步帮助”中安装 `chatgpt-vault-bridge.user.js`。脚本会扫描普通和归档会话，让你只勾选需要下载的记录，并且只把选中的详情发送到本地服务。

## 开发与许可证

```bash
npm test
npm run dev
```

默认数据目录为 `data/conversations`，仓库不会包含个人聊天、附件、截图、`data/` 或构建产物。

MIT，详见 [LICENSE](../../LICENSE)。
