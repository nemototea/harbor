# Harbor プライバシーポリシー / Privacy Policy

最終更新日 / Last updated: 2026-06-02

## 日本語

Harbor（以下「本拡張機能」）は、利用者のプライバシーを最大限に尊重して設計されています。

### 収集・送信するデータ

**本拡張機能は、いかなる個人情報・利用データも収集しません。また、いかなるデータも外部のサーバーや第三者に送信しません。** すべての処理は利用者のブラウザ内（ローカル）で完結します。アカウント登録やログインも不要です。

### データの保存場所

本拡張機能が扱う情報は、すべて利用者の端末内にのみ保存されます。

- **ブックマーク** … スペース・錨（アンカー）・PINS は、ブラウザ標準のブックマークとして保存されます。これらは Chrome のブックマーク同期機能の対象となり、利用者自身の Google アカウントによって同期される場合があります（これは Chrome の機能であり、本拡張機能による送信ではありません）。
- **表示設定** … スペースの色、セクションの折りたたみ状態、選択中のスペース、表示密度、初回ガイドの表示有無などは、`chrome.storage.local`（端末内のローカルストレージ）に保存されます。

### 権限の利用目的

- `bookmarks` … スペース・錨・PINS の実体としてブックマークを読み書きするため
- `tabs` / `tabGroups` … 開いているタブの一覧表示・切り替え・開閉・グループ操作のため
- `storage` … 上記の表示設定をローカルに保存するため
- `sidePanel` … サイドパネルとして UI を表示するため
- `favicon` … ブックマークやタブのファビコンを表示するため

取得したタブの URL・タイトル等は、利用者自身のタブを画面に表示・操作する目的でのみローカルに利用され、外部送信や保存（ローカルストレージへの記録）は行いません。

### お問い合わせ

ご質問は GitHub リポジトリの Issues までお願いします。
https://github.com/nemototea/harbor/issues

---

## English

Harbor ("the Extension") is designed with strong respect for user privacy.

### Data we collect or transmit

**The Extension does not collect any personal or usage data, and does not transmit any data to external servers or third parties.** All processing happens locally within the user's browser. No account or sign-in is required.

### Where data is stored

All information handled by the Extension is stored solely on the user's device.

- **Bookmarks** — Spaces, Anchors and Pins are stored as native browser bookmarks. These may be synced by Chrome's built-in bookmark sync under the user's own Google account (this is a Chrome feature, not a transmission performed by the Extension).
- **Display preferences** — Space colors, collapsed sections, the active space, display density, and whether the intro was shown are stored in `chrome.storage.local` on the device.

### Why each permission is used

- `bookmarks` — read/write bookmarks that back Spaces, Anchors and Pins
- `tabs` / `tabGroups` — list, switch, open, close and group the user's tabs
- `storage` — save the display preferences above, locally
- `sidePanel` — render the UI as a side panel
- `favicon` — display favicons for bookmarks and tabs

Tab URLs and titles are read only to display and operate on the user's own tabs locally; they are never transmitted or persisted.

### Contact

Questions: please open an issue at
https://github.com/nemototea/harbor/issues
