from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv


@dataclass(frozen=True, slots=True)
class BotConfig:
    discord_bot_token: str
    gemini_api_key: str
    gemini_model: str
    vosk_model_path: Path
    ffmpeg_binary: str
    data_root: Path
    timezone_name: str
    silence_timeout_seconds: float
    command_guild_ids: tuple[int, ...]

    @property
    def timezone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone_name)


def load_config() -> BotConfig:
    load_dotenv()

    root_dir = Path(__file__).resolve().parents[2]
    data_root = Path(os.getenv("DATA_ROOT", root_dir / "data")).expanduser()
    vosk_model_path = Path(
        os.getenv("VOSK_MODEL_PATH", root_dir / "models" / "vosk-model-small-ja-0.22")
    ).expanduser()

    return BotConfig(
        discord_bot_token=_require_env("DISCORD_BOT_TOKEN"),
        gemini_api_key=_require_env("GEMINI_API_KEY"),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
        vosk_model_path=vosk_model_path,
        ffmpeg_binary=os.getenv("FFMPEG_BINARY", "ffmpeg"),
        data_root=data_root,
        timezone_name=os.getenv("BOT_TIMEZONE", "Asia/Tokyo"),
        silence_timeout_seconds=float(os.getenv("SILENCE_TIMEOUT_SECONDS", "1.5")),
        command_guild_ids=_parse_guild_ids(os.getenv("DISCORD_GUILD_IDS", "")),
    )


def _require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Environment variable '{name}' is required.")
    return value


def _parse_guild_ids(raw_value: str) -> tuple[int, ...]:
    values: list[int] = []
    for part in raw_value.split(","):
        part = part.strip()
        if part:
            values.append(int(part))
    return tuple(values)
