from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime

import discord

from .config import BotConfig
from .formatting import format_markdown_minutes
from .gemini import GeminiSummarizer
from .models import MeetingArtifacts, MeetingMetadata, Participant, TranscriptEntry, TranscriptionJob
from .transcriber import TranscriptCache, TranscriptionPipeline, VoskTranscriber, write_pcm_wav
from .voice import StreamingTranscriptSink

LOGGER = logging.getLogger(__name__)


class StartRecordingError(RuntimeError):
    pass


class MeetingSession:
    def __init__(
        self,
        *,
        bot: discord.Bot,
        config: BotConfig,
        guild: discord.Guild,
        voice_channel: discord.VoiceChannel | discord.StageChannel,
        text_channel_id: int,
        transcriber: VoskTranscriber,
        summarizer: GeminiSummarizer,
    ) -> None:
        self._bot = bot
        self._config = config
        self._guild = guild
        self._voice_channel = voice_channel
        self.text_channel_id = text_channel_id
        self._transcriber = transcriber
        self._summarizer = summarizer
        self._order_lock = threading.Lock()
        self._next_order = 1
        self._completion_future: asyncio.Future[MeetingArtifacts] = asyncio.get_running_loop().create_future()
        self._stop_lock = asyncio.Lock()
        self._stop_requested = False

        self.started_at = datetime.now(self._config.timezone)
        self.ended_at = self.started_at
        self.session_dir = self._config.data_root / "sessions" / self._session_key
        self.chunks_dir = self.session_dir / "chunks"
        self.transcript_path = self.session_dir / "transcript_cache.txt"
        self.minutes_path = self.session_dir / "minutes.md"
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self.chunks_dir.mkdir(parents=True, exist_ok=True)

        self.cache = TranscriptCache(self.transcript_path)
        self.pipeline = TranscriptionPipeline(transcriber=self._transcriber, cache=self.cache)
        self.participants = _collect_participants(
            self._voice_channel.members,
            bot_user_id=self._bot.user.id if self._bot.user else None,
        )
        self.sink = StreamingTranscriptSink(
            silence_timeout_seconds=self._config.silence_timeout_seconds,
            timezone=self._config.timezone,
            segment_order_factory=self.next_segment_order,
            segment_handler=self.handle_segment,
            should_record_user=self.should_record_user,
        )

    @property
    def completion_future(self) -> asyncio.Future[MeetingArtifacts]:
        return self._completion_future

    @property
    def _session_key(self) -> str:
        return f"{self._guild.id}_{self.started_at.strftime('%Y%m%d_%H%M%S')}"

    def next_segment_order(self) -> int:
        with self._order_lock:
            value = self._next_order
            self._next_order += 1
        return value

    def mark_stop_requested(self) -> None:
        self._stop_requested = True
        self.ended_at = datetime.now(self._config.timezone)

    @property
    def stop_requested(self) -> bool:
        return self._stop_requested

    @property
    def stop_lock(self) -> asyncio.Lock:
        return self._stop_lock

    def should_record_user(self, user_id: int) -> bool:
        member = self._guild.get_member(user_id)
        return not bool(member and member.bot)

    def add_text_message(self, author_id: int, created_at: datetime, content: str) -> None:
        normalized = _normalize_message_content(content)
        if not normalized:
            return
        speaker_name = self.resolve_speaker_name(author_id)
        if speaker_name is None:
            return
        self.pipeline.submit_entry(
            TranscriptEntry(
                order=self.next_segment_order(),
                speaker_name=f"{speaker_name} [text]",
                started_at=created_at.astimezone(self._config.timezone),
                text=normalized,
            )
        )

    def handle_segment(self, order: int, speaker_id: int, started_at: datetime, payload: bytes) -> None:
        speaker_name = self.resolve_speaker_name(speaker_id)
        if speaker_name is None:
            return
        segment_path = self.chunks_dir / f"{order:05d}_{speaker_id}.wav"
        write_pcm_wav(segment_path, payload)
        self.pipeline.submit(
            TranscriptionJob(
                order=order,
                speaker_id=speaker_id,
                speaker_name=speaker_name,
                started_at=started_at,
                segment_path=segment_path,
            )
        )

    def resolve_speaker_name(self, speaker_id: int) -> str | None:
        member = self._guild.get_member(speaker_id)
        if member is not None:
            if member.bot:
                return None
            return member.display_name
        user = self._bot.get_user(speaker_id)
        if user is not None:
            return user.name
        return f"user-{speaker_id}"

    async def on_recording_stopped(self, *_: object) -> None:
        try:
            artifacts = await self.finalize()
        except Exception as exc:
            if not self._completion_future.done():
                self._completion_future.set_exception(exc)
            return
        if not self._completion_future.done():
            self._completion_future.set_result(artifacts)

    async def finalize(self) -> MeetingArtifacts:
        self.mark_stop_requested()
        await asyncio.to_thread(self.pipeline.close_and_wait)

        metadata = MeetingMetadata(
            voice_channel_name=self._voice_channel.name,
            started_at=self.started_at,
            ended_at=self.ended_at,
            participants=self.participants,
        )
        transcript_text = self.cache.read_text()
        sections = await self._summarizer.summarize(
            metadata=metadata,
            transcript_text=transcript_text,
        )
        markdown = format_markdown_minutes(metadata, sections)
        self.minutes_path.write_text(markdown, encoding="utf-8")
        return MeetingArtifacts(
            metadata=metadata,
            sections=sections,
            markdown_text=markdown,
            minutes_path=self.minutes_path,
            transcript_path=self.transcript_path,
            warnings=self.pipeline.warnings,
        )


def create_bot(config: BotConfig) -> discord.Bot:
    intents = discord.Intents.default()
    intents.guilds = True
    intents.members = True
    intents.messages = True
    intents.message_content = True
    intents.voice_states = True

    bot = discord.Bot(intents=intents)
    transcriber = VoskTranscriber(
        model_path=config.vosk_model_path,
        ffmpeg_binary=config.ffmpeg_binary,
    )
    summarizer = GeminiSummarizer(
        api_key=config.gemini_api_key,
        model_name=config.gemini_model,
    )
    sessions: dict[int, MeetingSession] = {}
    command_kwargs = {"guild_ids": list(config.command_guild_ids)} if config.command_guild_ids else {}

    @bot.event
    async def on_ready() -> None:
        LOGGER.info("Logged in as %s", bot.user)

    @bot.event
    async def on_message(message: discord.Message) -> None:
        if message.author.bot or message.guild is None:
            return

        session = sessions.get(message.guild.id)
        if session is None or message.channel.id != session.text_channel_id:
            return

        content = _build_message_content(message)
        if content:
            session.add_text_message(
                author_id=message.author.id,
                created_at=message.created_at,
                content=content,
            )

        await bot.process_commands(message)

    @bot.event
    async def on_voice_state_update(
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        session = sessions.get(member.guild.id)
        if session is None or session.stop_requested:
            return

        watched_channel = session._voice_channel
        changed_channel_ids = {
            before.channel.id if before.channel is not None else None,
            after.channel.id if after.channel is not None else None,
        }
        if watched_channel.id not in changed_channel_ids:
            return

        if _count_human_members(watched_channel) == 0:
            await _stop_session(
                bot=bot,
                sessions=sessions,
                guild_id=member.guild.id,
                reason="VC から人がいなくなったため、自動で議事録を確定します。",
            )

    @bot.slash_command(
        name="start",
        description="VC のリアルタイム文字起こしを開始します。",
        **command_kwargs,
    )
    async def start(ctx: discord.ApplicationContext) -> None:
        if ctx.guild is None:
            await ctx.respond("このコマンドはサーバー内でのみ使用できます。", ephemeral=True)
            return
        if ctx.guild.id in sessions:
            await ctx.respond("このサーバーではすでに録音中のセッションがあります。", ephemeral=True)
            return
        if ctx.author.voice is None or ctx.author.voice.channel is None:
            await ctx.respond("先にボイスチャンネルへ参加してください。", ephemeral=True)
            return
        if not isinstance(ctx.author.voice.channel, (discord.VoiceChannel, discord.StageChannel)):
            await ctx.respond("対応していないチャンネル種別です。", ephemeral=True)
            return

        await ctx.defer()
        voice_channel = ctx.author.voice.channel

        try:
            session = await _start_session(
                bot=bot,
                config=config,
                sessions=sessions,
                guild=ctx.guild,
                voice_channel=voice_channel,
                text_channel_id=ctx.channel.id,
                transcriber=transcriber,
                summarizer=summarizer,
            )
        except Exception as exc:
            await ctx.followup.send(f"録音開始に失敗しました: {exc}", ephemeral=True)
            return

        await ctx.followup.send(
            (
                f"議事録を取り始めたよ！\n"
                f"`{session._voice_channel.name}` の会話と、このテキストチャンネルの投稿を記録します。\n"
                "終了時は `/stop` を実行してください。"
            )
        )

    @bot.slash_command(
        name="stop",
        description="録音を止めて議事録を生成します。",
        **command_kwargs,
    )
    async def stop(ctx: discord.ApplicationContext) -> None:
        if ctx.guild is None:
            await ctx.respond("このコマンドはサーバー内でのみ使用できます。", ephemeral=True)
            return

        session = sessions.get(ctx.guild.id)
        if session is None:
            await ctx.respond("停止できる録音セッションが見つかりません。", ephemeral=True)
            return

        await ctx.defer(ephemeral=True)
        try:
            artifacts = await _stop_session(
                bot=bot,
                sessions=sessions,
                guild_id=ctx.guild.id,
                reason=None,
            )
            warning_text = ""
            if artifacts is not None and artifacts.warnings:
                warning_text = "\n警告: 一部の音声チャンクで文字起こしに失敗しました。README のトラブルシュートを確認してください。"
            await ctx.followup.send(f"議事録を出力しました。{warning_text}", ephemeral=True)
        except Exception as exc:
            LOGGER.exception("Failed to stop recording: %s", exc)
            await ctx.followup.send(f"停止処理に失敗しました: {exc}", ephemeral=True)

    return bot


async def _start_session(
    *,
    bot: discord.Bot,
    config: BotConfig,
    sessions: dict[int, MeetingSession],
    guild: discord.Guild,
    voice_channel: discord.VoiceChannel | discord.StageChannel,
    text_channel_id: int,
    transcriber: VoskTranscriber,
    summarizer: GeminiSummarizer,
) -> MeetingSession:
    voice_client = guild.voice_client
    try:
        if voice_client is None:
            voice_client = await voice_channel.connect(timeout=20.0, reconnect=False)
        elif voice_client.channel.id != voice_channel.id:
            await voice_client.move_to(voice_channel)

        session = MeetingSession(
            bot=bot,
            config=config,
            guild=guild,
            voice_channel=voice_channel,
            text_channel_id=text_channel_id,
            transcriber=transcriber,
            summarizer=summarizer,
        )
        sessions[guild.id] = session
        voice_client.start_recording(session.sink, session.on_recording_stopped, text_channel_id)
        return session
    except Exception as exc:
        sessions.pop(guild.id, None)
        if voice_client is not None and voice_client.is_connected():
            await voice_client.disconnect(force=True)
        raise StartRecordingError(
            "VC 接続または録音開始に失敗しました。"
            " Discord 側の権限、Pycord の音声受信対応状況、Voice 接続の可否を確認してください。"
        ) from exc


async def _stop_session(
    *,
    bot: discord.Bot,
    sessions: dict[int, MeetingSession],
    guild_id: int,
    reason: str | None,
) -> MeetingArtifacts | None:
    session = sessions.get(guild_id)
    if session is None:
        return None

    async with session.stop_lock:
        if session.stop_requested and session.completion_future.done():
            return await session.completion_future

        session.mark_stop_requested()
        guild = bot.get_guild(guild_id)
        voice_client = guild.voice_client if guild is not None else None

        if voice_client is not None and getattr(voice_client, "recording", False):
            voice_client.stop_recording()

        artifacts = await session.completion_future

        if voice_client is not None and voice_client.is_connected():
            await voice_client.disconnect(force=True)

        sessions.pop(guild_id, None)

        if reason:
            await _send_status_message(bot=bot, text_channel_id=session.text_channel_id, message=reason)

        await _send_artifacts(bot=bot, text_channel_id=session.text_channel_id, artifacts=artifacts)
        return artifacts


async def _send_artifacts(
    *,
    bot: discord.Bot,
    text_channel_id: int,
    artifacts: MeetingArtifacts,
) -> None:
    channel = bot.get_channel(text_channel_id)
    if channel is None:
        channel = await bot.fetch_channel(text_channel_id)

    transcript_file = discord.File(str(artifacts.transcript_path), filename="transcript_cache.txt")
    if len(artifacts.markdown_text) <= 2000:
        await channel.send(artifacts.markdown_text, file=transcript_file)
        return

    minutes_file = discord.File(str(artifacts.minutes_path), filename="minutes.md")
    await channel.send(
        "議事録が 2,000 文字を超えたため、Markdown ファイルとして添付します。",
        files=[minutes_file, transcript_file],
    )


async def _send_status_message(*, bot: discord.Bot, text_channel_id: int, message: str) -> None:
    channel = bot.get_channel(text_channel_id)
    if channel is None:
        channel = await bot.fetch_channel(text_channel_id)
    await channel.send(message)


def _collect_participants(
    members: list[discord.Member],
    *,
    bot_user_id: int | None,
) -> list[Participant]:
    participants: list[Participant] = []
    seen: dict[int, Participant] = {}
    for member in members:
        if member.bot or (bot_user_id is not None and member.id == bot_user_id):
            continue
        seen[member.id] = Participant(
            display_name=member.display_name,
            username=member.name,
        )
    participants.extend(seen.values())
    participants.sort(key=lambda participant: participant.display_name.lower())
    return participants


def _build_message_content(message: discord.Message) -> str:
    chunks: list[str] = []
    if message.content and message.content.strip():
        chunks.append(message.content.strip())
    if message.attachments:
        attachment_lines = [f"[添付] {attachment.filename}" for attachment in message.attachments]
        chunks.extend(attachment_lines)
    return "\n".join(chunks).strip()


def _normalize_message_content(content: str) -> str:
    lines = [line.rstrip() for line in content.splitlines()]
    normalized = "\n".join(line for line in lines if line.strip())
    return normalized.strip()


def _count_human_members(channel: discord.VoiceChannel | discord.StageChannel) -> int:
    return sum(1 for member in channel.members if not member.bot)
