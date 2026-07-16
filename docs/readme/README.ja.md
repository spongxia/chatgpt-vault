# ChatGPT Vault

ChatGPT Vault は、ChatGPT の会話をローカルで管理する多言語アーカイブです。Markdown、LaTeX、コード、表、引用を表示し、ツール出力やアップロードファイルを折りたたみます。選択的な差分同期と、公式互換の `conversations.json` 出力に対応します。

OpenAI とは無関係の独立コミュニティプロジェクトです。

## 主な機能

- クラウド DB や API キーを使わないローカル JSON 保存。
- 左欄と会話一覧を個別に折りたためる三列 UI。
- Markdown、LaTeX、コード、表、リンク、添付ファイル、ローカル KaTeX。
- Web 検索、長いテキスト、ツール呼び出し、生成ファイルを自動折りたたみ。
- Tampermonkey/Violentmonkey 用の選択同期 userscript。
- 検索、お気に入り、アーカイブ、名前変更、タグ、ダークモード、アラビア語 RTL。
- Markdown/JSON と公式互換 `conversations.json` の書き出し。

## クイックスタート

Node.js 18 以上が必要です。

```bash
npm install
npm start
```

<http://127.0.0.1:4318> を開いてください。データは通常 `data/conversations` に保存されます。

## 開発

```bash
npm test
npm run dev
```

データは通常 `data/conversations` に保存されます。リポジトリには個人の会話、添付ファイル、スクリーンショット、`data/`、ビルド成果物を含めません。MIT ライセンスです。
