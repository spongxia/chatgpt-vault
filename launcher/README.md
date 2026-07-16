# ChatGPT Vault Launcher

双击 `ChatGPT Vault Launcher.app` 即可启动 ChatGPT Vault，无需打开终端。

启动器只使用 macOS 自带组件：

- 检查 Node.js 18 或更高版本；
- Node.js 缺失时询问是否自动安装；
- 首次运行时自动执行 `npm install`；
- 启动 `http://127.0.0.1:4318` 本地服务；
- 自动打开系统默认浏览器。

请保持 `ChatGPT Vault Launcher.app` 位于项目根目录下的 `launcher/` 文件夹中。启动器没有代码签名，macOS 首次拦截时请右键点击并选择“打开”。

如果启动失败，可查看 `data/chatgpt-vault-launcher.log`。
