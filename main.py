from __future__ import annotations

import logging
import sys
from pathlib import Path


def main() -> None:
    project_root = Path(__file__).resolve().parent
    src_path = project_root / "src"
    if str(src_path) not in sys.path:
        sys.path.insert(0, str(src_path))

    from gijirokun import create_bot, load_config

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    config = load_config()
    bot = create_bot(config)
    bot.run(config.discord_bot_token)


if __name__ == "__main__":
    main()
