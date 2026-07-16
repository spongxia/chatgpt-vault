# ChatGPT Vault

ChatGPT Vault 是一個本機優先、多語言的 ChatGPT 聊天記錄管理器。支援 Markdown、LaTeX、程式碼、表格、附件、摺疊工具輸出、選擇性增量同步，以及官方相容的 `conversations.json` 匯出。

這是獨立社群專案，與 OpenAI 沒有隸屬關係。

## 功能

- 記錄以 JSON 儲存在本機，不需要雲端資料庫或 API Key。
- 類似 ChatGPT 的三欄閱讀介面，左欄與中欄可獨立收合。
- Markdown、程式碼、表格、引用、連結、附件與本機 KaTeX 公式。
- 上傳檔案全文、網頁搜尋、工具呼叫和產生檔案預設收合。
- 可選 Tampermonkey/Violentmonkey 使用者腳本，按選擇增量同步。
- 搜尋、收藏、封存、重新命名、標籤、深色模式與 RTL 阿拉伯語版面。
- 單一對話 Markdown/JSON 匯出，以及官方相容 `conversations.json`。

## 快速開始

需要 Node.js 18+：

```bash
npm install
npm start
```

開啟 <http://127.0.0.1:4318>。預設資料目錄為 `data/conversations`，可用 `CHATGPT_VAULT_DATA_DIR` 自訂。

## 選擇性同步

在「匯入與同步說明」中安裝 `chatgpt-vault-bridge.user.js`，掃描一般與封存對話後，只勾選需要的記錄。

## 開發

```bash
npm test
npm run dev
```

預設資料目錄為 `data/conversations`。儲存庫不包含個人聊天、附件、截圖、`data/` 或建置產物。MIT，詳見 [LICENSE](../../LICENSE)。
