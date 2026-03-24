# Discord議事録作成Bot

Discord の VC 会話を Bot が受信し、ローカルの Vosk で文字起こしし、会議終了後に Gemini API で要約してテキストチャンネルへ出力する Bot です。  
Bot 本体は `discord.js` / `@discordjs/voice`、文字起こしは Python の Vosk ワーカー、要約は `@google/genai` を使います。

## この実装の方針

2026 年 3 月以降、Discord の通常 Voice Channel では DAVE/E2EE 対応が事実上前提になっています。  
このリポジトリはその前提を踏まえ、Voice 受信まわりを `discord.js` + `@discordjs/voice` に寄せています。

参考:

- [Discord Change Log](https://docs.discord.com/developers/change-log)
- [discord.js voice guide](https://discordjs.guide/voice)
- [@discordjs/voice docs](https://discord.js.org/docs/packages/voice/stable)

## 構成

- Node.js Bot
  - Slash Command の受付
  - VC への参加 / 切断
  - 音声受信
  - テキストチャンネル投稿の記録
  - Gemini 要約
  - Discord への出力
- Python Worker
  - Vosk モデルのロード
  - FFmpeg で音声を 16kHz mono WAV へ正規化
  - 文字起こし

## 実装済み機能

- `/start` でコマンド実行者のいる VC に参加
- VC 音声をユーザー単位で受信し、無音 1.5 秒で発言チャンク化
- Vosk でローカル文字起こし
- `/start` を実行したテキストチャンネルへの投稿も記録
- `transcript_cache.txt` に時系列で追記
- `/stop` で要約生成、議事録 Markdown 作成、VC から切断
- VC から Bot 以外の人がいなくなったら自動 stop
- 2,000 文字超過時は `minutes.md` を添付送信
- 生ログは常に `transcript_cache.txt` として添付送信

## ディレクトリ

```text
.
├─ package.json
├─ .env.example
├─ requirements-transcriber.txt
├─ scripts/
│  └─ transcribe_worker.py
├─ src/
│  ├─ audio-utils.js
│  ├─ bot.js
│  ├─ config.js
│  ├─ formatting.js
│  ├─ gemini.js
│  ├─ index.js
│  ├─ python-transcriber.js
│  ├─ session.js
│  ├─ summary-parser.js
│  └─ transcript-pipeline.js
├─ tests/
│  ├─ formatting.test.js
│  └─ summary-parser.test.js
└─ docs/
   └─ ARCHITECTURE_V2.md
```

## 前提環境

- WSL Ubuntu などの Linux 環境
- Node.js 22.12.0 以上
- Python 3.x
- FFmpeg

`@discordjs/voice` の公式 docs でも Node.js 22.12.0 以上が必要です。

## セットアップ

### 1. Node.js 22 系を入れる

Ubuntu の標準 `apt install nodejs` だと古い版が入ることがあるので、`nvm` の利用をおすすめします。

```bash
sudo apt update
sudo apt install -y curl ffmpeg python3 python3-venv unzip

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node -v
```

### 2. Node 依存を入れる

```bash
cd /home/kokastar/project/Gijirokun
npm install
```

### 3. Python 仮想環境を作る

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
pip install -r requirements-transcriber.txt
```

### 4. Vosk 日本語モデルを配置する

Vosk 公式モデル一覧:
- [https://alphacephei.com/vosk/models](https://alphacephei.com/vosk/models)

小さめの日本語モデル例:

```bash
mkdir -p models
cd models
wget https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip
unzip vosk-model-small-ja-0.22.zip
cd ..
```

デフォルトでは `./models/vosk-model-small-ja-0.22` を参照します。

## Discord Bot の作成手順

Discord Developer Portal:
- [https://discord.com/developers/applications](https://discord.com/developers/applications)

### 1. アプリを作成する

1. `New Application` を押す
2. アプリ名を入力して作成する

### 2. Bot を作る

1. 左メニューの `Bot` を開く
2. `Add Bot` で Bot を作成する
3. `Reset Token` などから Bot Token を取得する
4. その値をあとで `.env` の `DISCORD_BOT_TOKEN` に入れる

### 3. Intent を設定する

`Bot` タブの `Privileged Gateway Intents` で以下を有効化してください。

- `MESSAGE CONTENT INTENT`

補足:

- 現在のコードは `SERVER MEMBERS INTENT` なしでも動く想定です
- もしサーバーニックネーム解決が不安定な場合だけ、追加で `SERVER MEMBERS INTENT` を有効化してください

### 4. Bot をサーバーへ招待する

1. `OAuth2 > URL Generator` を開く
2. Scope で以下を選ぶ
   - `bot`
   - `applications.commands`
3. Bot Permissions で以下を選ぶ
   - `View Channels`
   - `Connect`
   - `Speak`
   - `Send Messages`
   - `Attach Files`
   - `Use Slash Commands`
   - `Read Message History`
4. 生成された URL を開いて Bot をサーバーへ招待する

## Gemini API Key の発行手順

公式:

- [Gemini API key docs](https://ai.google.dev/gemini-api/docs/api-key)
- [Google Cloud: Creating and managing projects](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects)

### 1. Google Cloud でプロジェクトを作る

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 上部のプロジェクト選択から `新しいプロジェクト` を選ぶ
3. プロジェクト名を入力して `作成`
4. 作成後、そのプロジェクトを選択状態にする

### 2. Gemini API 用にプロジェクトを使える状態にする

1. [Google AI Studio](https://aistudio.google.com/) を開く
2. `Get API key` もしくは API key 作成画面へ進む
3. 必要に応じて Google Cloud プロジェクトを選ぶ
4. まだ紐付いていなければ、対象プロジェクトを AI Studio から選択できる状態にする
5. `Create API key` を押して API key を発行する

### 3. `.env` に設定する

発行したキーを `.env` の `GEMINI_API_KEY` に設定します。

## `.env` の作成

このリポジトリでは `.env` はコミットしません。  
`.env.example` を見ながら、必要なら自分で `.env` を作成してください。

```bash
cp .env.example .env
```

` .env.example `

```dotenv
DISCORD_BOT_TOKEN=your_discord_bot_token
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
VOSK_MODEL_PATH=./models/vosk-model-small-ja-0.22
FFMPEG_BINARY=ffmpeg
PYTHON_EXECUTABLE=python3
BOT_TIMEZONE=Asia/Tokyo
SILENCE_TIMEOUT_SECONDS=1.5
DISCORD_GUILD_IDS=
```

### 環境変数の意味

- `DISCORD_BOT_TOKEN`
  - Discord Bot のトークン
- `GEMINI_API_KEY`
  - Gemini API key
- `GEMINI_MODEL`
  - 要約に使う Gemini モデル
- `VOSK_MODEL_PATH`
  - Vosk モデルのパス
- `FFMPEG_BINARY`
  - `ffmpeg` コマンド名またはフルパス
- `PYTHON_EXECUTABLE`
  - Python 実行コマンド
- `BOT_TIMEZONE`
  - ログと議事録のタイムゾーン
- `SILENCE_TIMEOUT_SECONDS`
  - 無音判定秒数
- `DISCORD_GUILD_IDS`
  - 開発用。ここにギルド ID を入れると Slash Command の反映が速い

## 起動方法

```bash
cd /home/kokastar/project/Gijirokun
source .venv/bin/activate
npm start
```

## 使い方

### `/start`

- コマンド実行者がいる VC に Bot が参加します
- VC 音声の記録を開始します
- `/start` を実行したテキストチャンネルへの投稿も記録します
- 開始メッセージを返します

### `/stop`

- 音声受信を止めます
- 未処理の音声チャンクをすべて消化します
- Gemini で要約します
- 議事録をテキストチャンネルへ出します
- VC から切断します

### 自動 stop

- 対象 VC から Bot 以外のユーザーが全員抜けたら自動 stop します

## 出力仕様

### 文字起こしログ

`transcript_cache.txt` に以下の形式で保存します。

```text
[10:15:30] 山田

では次の議題に入ります。

[10:16:02] 鈴木 [text]

テキスト側にも資料リンクを貼っておきます
[添付] spec.md
```

### 議事録 Markdown

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

### 保存先

セッションごとの成果物は以下へ作られます。

```text
data/sessions/<guildId>_<timestamp>/
├─ transcript_cache.txt
├─ minutes.md
└─ chunks/
```

## テスト

```bash
npm test
```

## トラブルシュート

### Slash Command が見えない

- `DISCORD_GUILD_IDS` に開発用ギルド ID を入れて再起動する
- グローバル登録の場合は反映まで時間がかかることがあります

### `MESSAGE CONTENT INTENT` で怒られる

- Discord Developer Portal の `Bot` タブで `MESSAGE CONTENT INTENT` を有効化してください

### Voice 接続に失敗する

- Bot に `Connect` と `Speak` 権限があるか確認してください
- Node.js が 22.12.0 以上か確認してください
- 依存関係の状態を確認したい場合は、次のコマンドで `@discordjs/voice` の依存レポートを出せます

```bash
node -e "import('@discordjs/voice').then(({ generateDependencyReport }) => console.log(generateDependencyReport()))"
```

### FFmpeg が見つからない

- `ffmpeg -version` が通るか確認してください
- `.env` の `FFMPEG_BINARY` でフルパスを指定しても構いません

### Vosk model not found

- `.env` の `VOSK_MODEL_PATH` を確認してください
- 展開後のディレクトリを指しているか確認してください

### Python worker が起動しない

- `source .venv/bin/activate` した状態で `pip install -r requirements-transcriber.txt` を実行してください
- `.env` の `PYTHON_EXECUTABLE` が正しいか確認してください

## 補足

- `.env` はこの書き換えでは触っていません。必要な値は自分で設定してください。
- 実機での動作確認は行っていません。セットアップ後の `/start` と `/stop`、音声受信、文字起こし精度は手元で確認してください。
