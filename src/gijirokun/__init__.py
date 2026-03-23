from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .bot import create_bot as create_bot
    from .config import BotConfig as BotConfig
    from .config import load_config as load_config

__all__ = ["BotConfig", "create_bot", "load_config"]


def create_bot(*args, **kwargs):
    from .bot import create_bot as _create_bot

    return _create_bot(*args, **kwargs)


def load_config():
    from .config import load_config as _load_config

    return _load_config()


def __getattr__(name: str) -> Any:
    if name == "BotConfig":
        from .config import BotConfig as _BotConfig

        return _BotConfig
    if name == "create_bot":
        return create_bot
    if name == "load_config":
        return load_config
    raise AttributeError(name)
