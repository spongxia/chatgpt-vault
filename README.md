# ChatGPT Vault

ChatGPT Vault is a local-first, multilingual archive for managing ChatGPT conversations. It renders Markdown and LaTeX, keeps uploaded files and tool output folded, supports selective incremental sync, and exports an official-compatible `conversations.json`.

It is an independent community project and is not affiliated with OpenAI.

## Languages

English · 简体中文 · Français · Español · 日本語 · العربية · Deutsch · Italiano · Português

Read the documentation in another language:

- [简体中文](docs/readme/README.zh-CN.md)
- [Français](docs/readme/README.fr.md)
- [Español](docs/readme/README.es.md)
- [日本語](docs/readme/README.ja.md)
- [العربية](docs/readme/README.ar.md)
- [Deutsch](docs/readme/README.de.md)
- [Italiano](docs/readme/README.it.md)
- [Português](docs/readme/README.pt.md)

## Features

- Local JSON storage with no cloud database or API key.
- ChatGPT-style three-column reader with independently collapsible navigation panels.
- Markdown, code blocks, tables, block quotes, links, attachments, and local KaTeX rendering.
- Folded tool calls, web results, uploaded text, and generated files.
- Selective incremental sync through the optional Tampermonkey/Violentmonkey userscript.
- Search, favorites, archive, rename, tags, dark mode, RTL Arabic layout, and 9 UI languages.
- Single-chat Markdown/JSON export and official-compatible `conversations.json` export.
- A zero-dependency macOS launcher that checks Node.js, offers installation, starts the local service, and opens the browser.
- Runs as a lightweight local web app; package it with the toolchain you prefer.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm start
```

Open <http://127.0.0.1:4318>.

The default data directory is `data/conversations`. Override it when needed:

```bash
CHATGPT_VAULT_DATA_DIR=/path/to/conversations npm start
```

On macOS, double-click [ChatGPT Vault Launcher.app](launcher/ChatGPT%20Vault%20Launcher.app) to perform the same setup without opening a terminal. Keep the app bundle inside the repository's `launcher/` directory.

## Selective sync

Open **Import and sync help** in the app and install `chatgpt-vault-bridge.user.js` into Tampermonkey or Violentmonkey. The script scans normal and archived conversations, lets you select exactly which records to download, and only sends selected conversation details to the local service.

The script uses the signed-in ChatGPT page session and undocumented web endpoints. If ChatGPT changes those endpoints, the panel reports a warning instead of silently claiming a complete scan.

## Development

```bash
npm test
npm run dev
```

The server stores conversations under `data/conversations` by default. The repository never includes personal conversations, attachments, screenshots, `data/`, or build artifacts.

## License

MIT. See [LICENSE](LICENSE).
