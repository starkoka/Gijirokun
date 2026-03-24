# Discord議事録作成Bot

Discord のボイスチャンネル会話をローカルでリアルタイム文字起こしし、終了時に Gemini API で要約してテキストチャンネルへ投稿する Bot です。音声認識は Vosk の日本語ローカルモデルを使うため、会話音声そのものはクラウドへ送られません。

## できること

- `/start` でコマンド実行者がいる VC へ Bot が参加
- ユーザーごとの音声ストリームを分離して発言単位でチャンク化
- 発言終了後に Vosk で非同期文字起こし
- セッション中に紐づくテキストチャンネルへ投稿されたメッセージも記録
- `transcript_cache.txt` に `[HH:MM:SS] ユーザー名` 形式で追記
- `/stop` で Gemini API に要約を依頼し、Markdown 議事録を出力
- 2,000 文字超の議事録は `minutes.md` として添付
- 生ログ `transcript_cache.txt` は常にファイル添付

## 技術スタック

- Python 3.x
- Pycord
- Vosk
- google-genai
- FFmpeg
- PyNaCl

## ディレクトリ構成

```text
.
├─ main.py
├─ requirements.txt
├─ .env.example
├─ src/
│  └─ gijirokun/
│     ├─ bot.py
│     ├─ config.py
│     ├─ formatting.py
│     ├─ gemini.py
│     ├─ models.py
│     ├─ summary_parser.py
│     ├─ transcriber.py
│     └─ voice.py
└─ tests/
```

## 前提ソフト

WSL Ubuntu での実行を想定しています。最低限、以下を入れてください。

```bash
sudo apt update
sudo apt install -y python3 python3-venv ffmpeg unzip
```

必要に応じて `build-essential`, `python3-dev`, `libffi-dev` も追加してください。`PyNaCl` のビルドで不足する環境があります。

## セットアップ手順

### 1. 仮想環境を作る

```bash
cd /home/kokastar/project/Gijirokun
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
pip install -r requirements.txt
```

### 2. Vosk 日本語モデルを配置する

公式モデル一覧:
[https://alphacephei.com/vosk/models](https://alphacephei.com/vosk/models)

軽量な日本語モデル例:

```bash
mkdir -p models
cd models
wget https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip
unzip vosk-model-small-ja-0.22.zip
cd ..
```

デフォルトでは `./models/vosk-model-small-ja-0.22` を見に行きます。別の場所に置く場合は `.env` の `VOSK_MODEL_PATH` を変更してください。

### 3. Discord Bot を作る

Discord Developer Portal:
[https://discord.com/developers/applications](https://discord.com/developers/applications)

1. `New Application` でアプリを作成する。
2. `Bot` タブで Bot を追加し、トークンを発行する。
3. `Privileged Gateway Intents` で `SERVER MEMBERS INTENT` を有効にする。
4. 同じく `MESSAGE CONTENT INTENT` も有効にする。
5. `OAuth2 > URL Generator` で `bot` と `applications.commands` を選ぶ。
6. Bot 権限は最低でも以下を付ける。

- `View Channels`
- `Connect`
- `Send Messages`
- `Attach Files`
- `Use Slash Commands`
- `Read Message History`

7. 生成された URL で対象サーバーへ招待する。

### 4. Google Cloud プロジェクトを作成し、Gemini API Key を発行する

公式ドキュメント:
[https://ai.google.dev/gemini-api/docs/api-key](https://ai.google.dev/gemini-api/docs/api-key)

Google Cloud Console:
[https://console.cloud.google.com/](https://console.cloud.google.com/)

推奨手順:

1. Google Cloud Console で新しいプロジェクトを作成する。
2. 必要なら課金アカウントを紐づける。
3. Gemini API のキー発行ページを開く。
4. 既存の Google Cloud プロジェクトを使いたい場合は、ページ上の案内に従ってプロジェクトを選択または import する。
5. `Create API key` を実行し、発行されたキーを控える。
6. そのキーを `.env` の `GEMINI_API_KEY` に入れる。

補足:

- 組織ポリシーや請求設定によっては、先に Cloud 側の設定が必要です。
- UI やボタン名称は更新されることがあるため、迷った場合は必ず上の公式ページを基準にしてください。

### 5. `.env` を作る

```bash
cp .env.example .env
```

`.env` 例:

```dotenv
DISCORD_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_MODEL=gemini-2.0-flash
VOSK_MODEL_PATH=./models/vosk-model-small-ja-0.22
FFMPEG_BINARY=ffmpeg
BOT_TIMEZONE=Asia/Tokyo
SILENCE_TIMEOUT_SECONDS=1.5
DISCORD_GUILD_IDS=123456789012345678
```

`DISCORD_GUILD_IDS` は任意です。テスト用サーバー ID を入れると、スラッシュコマンドがそのギルドへ優先登録されるため反映が速くなります。複数ある場合はカンマ区切りです。

### 6. Bot を起動する

```bash
source .venv/bin/activate
python3 main.py
```

## 使い方

### `/start`

- コマンド実行者が参加している VC に Bot が入ります。
- `/start` を実行したテキストチャンネルを、その会議の付属テキストチャンネルとして記録対象にします。
- 会議開始時刻、VC 名、参加者リストを保持します。
- ユーザーごとの音声受信を開始します。
- 同じテキストチャンネルへ投稿された通常メッセージと添付ファイル名を記録します。
- 開始できたら、チャンネルに「議事録を取り始めたよ！」と返します。

### `/stop`

- 録音を止めます。
- 未処理キューを消化します。
- `transcript_cache.txt` を確定します。
- Gemini API で要約を作成します。
- Markdown 議事録をテキストチャンネルへ送信します。

### 自動停止

- 監視対象 VC に人間ユーザーが 0 人になったら、自動で `/stop` 相当の確定処理を行います。
- Bot 自身は人数に数えません。

## 出力仕様

### 文字起こしログ

発言ごとに次の形式で `transcript_cache.txt` に追記されます。

```text
[10:15:30] 山田

では次の議題に入ります。

[10:16:02] 山田 [text]

仕様書のリンクを貼ります
[添付] spec.md
```

### 参加者一覧

```text
- サーバーニックネーム(@Discordユーザー名)
```

### 最終議事録

```markdown
# 議事録: 開発定例

**日時:** 2026年03月24日 10:00 - 11:30

**参加者:**
- 山田 (@yamada)
- 鈴木 (@suzuki)

## 📝 要約

...

## ✅ 決定事項

- ...

## 🏃 次のアクション (TODO)

- ...
```

## 実装メモ

- 録音中はユーザーごとの PCM バッファを保持します。
- 1.5 秒以上音声パケットが止まったら発言終了とみなし、一時 WAV を切り出します。
- 切り出した WAV はキューに積み、別スレッドで FFmpeg 変換後に Vosk 文字起こしします。
- 発言順を維持するため、発言開始順のシーケンス番号で `transcript_cache.txt` へ整列追記します。
- 一時音声ファイルは文字起こし後に削除します。

## トラブルシュート

### `Vosk model not found`

- `.env` の `VOSK_MODEL_PATH` を確認してください。
- モデル展開後のディレクトリを直接指定してください。

### `FFmpeg が見つかりません`

- `ffmpeg -version` が通るか確認してください。
- `.env` の `FFMPEG_BINARY` を実行可能名に合わせてください。

### スラッシュコマンドが出てこない

- `DISCORD_GUILD_IDS` を設定すると反映が速くなります。
- グローバル登録は Discord 側で反映まで時間がかかることがあります。

### Voice 接続で `4017` が出る

- これはアプリ設定だけでなく、Pycord 側の音声受信実装や Discord 側仕様変更の影響でも起こりえます。
- まずは Bot に `Connect`, `Speak`, `Use Voice Activity` 相当の権限があるか確認してください。
- そのうえで改善しない場合は、Pycord の音声受信対応バージョン差分を確認してください。

### 文字起こし精度が低い

- より大きい日本語モデルへの変更を検討してください。
- 発話音量、雑音、マイク品質の影響を受けます。

### Gemini API の要約に失敗する

- API キーを再確認してください。
- クォータや請求設定、プロジェクト選択状態を見直してください。
- まずは公式ドキュメントの API key 手順を再確認してください。

## 開発メモ

このリポジトリには `formatting.py` と `summary_parser.py` 向けの最小テストを入れています。必要に応じて、手元で次のように確認してください。

```bash
source .venv/bin/activate
PYTHONPATH=src python3 -m unittest discover -s tests
```
