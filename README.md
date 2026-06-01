<p align="center">
  <img src="assets/banner.png" alt="Harbor — Anchor-based workspace for Chrome" width="100%">
</p>

# Harbor

戻り先を「錨(Anchor)」としてグリッド管理する Chrome サイドパネル拡張。
タブを保存場所として使うのをやめ、恒久的な戻り先(Anchor)と流動的な作業(Live tabs)を分離する。

- **ANCHORED** … ファビコングリッド。クリックで「そのURLの既存タブにフォーカス、無ければ新規で開く」。タブ内でどこへ移動しても錨のURLは変わらない。ブラウザを閉じても残る。
- **LIVE** … 現在ウィンドウの開いているタブ。⚓ で錨に昇格、× で閉じる。
- **Spaces** … 上部のピル。コンテキストごとに錨を切り替える（※セッション分離ではなく整理用。ログイン分離は Chrome プロファイルと併用）。

## インストール（Load unpacked）

1. `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」→ この `harbor` フォルダを選択
4. ツールバーの錨アイコンをクリック（または `Ctrl/Cmd+Shift+K`）でサイドパネルが開く

> フォルダの実体を参照するので、移動・削除すると外れます。固定パスに置いてください。
> コードを変更したら `chrome://extensions/` の更新ボタン（または再読み込み）で反映。

## 使い方

- 錨を追加: グリッド末尾の「＋ 現在のタブ」、または LIVE 行の ⚓
- 錨をクリック: 既存タブにフォーカス / 無ければ開く
- ⟲（錨タイル左上, ホバー時）: 今のアクティブタブをその錨のURLに戻す（Arc のスナップバック相当）
- 「編集」: 並べ替え（ドラッグ）/ 削除（×）/ タイルクリックで編集モーダル
- スペース追加: ピル末尾の「＋」

## データ

`chrome.storage.local` の単一キー `harbor:v1` に保存。
端末間同期したい場合は `sidepanel.js` の `chrome.storage.local` を `chrome.storage.sync` に置換可能
（sync は容量制限あり: 1項目8KB / 合計100KB。錨が多い場合はキー分割が必要）。

## カスタマイズの勘どころ

- 配色・余白: `sidepanel.css` の `:root` 変数（`--anchor` = 暖色/恒久, `--live` = 寒色/流動）
- 既存タブ判定のゆるさ: `sidepanel.js` の `sameTarget()`（現在は origin + pathname 一致）
- 初期スペース: `sidepanel.js` の `defaultState()`
- 追加候補: Cmd-K 風のコマンドバー（錨/タブ/履歴を横断検索）、ドメイン自動グルーピング、エクスポート（Netscape bookmark HTML 出力）

## 権限

- `sidePanel` サイドパネル表示
- `tabs` タブのURL/タイトル取得・フォーカス・新規・クローズ
- `storage` 錨/スペースの保存
- `favicon` ファビコン取得（`_favicon/` エンドポイント）
- `tabGroups` （将来のグループ表示用に予約）

外部通信は行いません。すべてローカル。
