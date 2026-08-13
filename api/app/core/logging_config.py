"""Logging setup. Plain text everywhere — deployed logs split by stream.

Deployed logs are deliberately NOT JSON: Railway's ingest blanks the message
field of any JSON log line on this project (verified empirically 2026-08-13 —
even the documented minimal example {"message": "...", "level": "info"}
arrives with an empty message), while plain-text lines survive verbatim.
Level fidelity comes from the stream split instead: INFO and below go to
stdout (Railway tags stdout lines "info"), WARNING and above go to stderr
(Railway tags stderr lines "error").
"""

from __future__ import annotations

import logging
import os
import sys

DEFAULT_LOG_FORMAT = "%(levelname)s - %(name)s - %(message)s"


class _MaxLevelFilter(logging.Filter):
    """Cap a handler at a level so stdout and stderr never both emit a line."""

    def __init__(self, max_level: int) -> None:
        super().__init__()
        self.max_level = max_level

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno <= self.max_level


def setup_logging(default_level: str = "INFO") -> None:
    """Configure the root logger. Stream-split when ENVIRONMENT != development."""
    log_level = os.getenv("LOG_LEVEL", default_level).upper()
    numeric_level = getattr(logging, log_level, logging.INFO)
    deployed = os.getenv("ENVIRONMENT", "development") != "development"

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(numeric_level)

    formatter = logging.Formatter(DEFAULT_LOG_FORMAT)
    if deployed:
        info_handler = logging.StreamHandler(sys.stdout)
        info_handler.setLevel(numeric_level)
        info_handler.addFilter(_MaxLevelFilter(logging.INFO))
        info_handler.setFormatter(formatter)
        root_logger.addHandler(info_handler)

        error_handler = logging.StreamHandler(sys.stderr)
        error_handler.setLevel(logging.WARNING)
        error_handler.setFormatter(formatter)
        root_logger.addHandler(error_handler)
    else:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(numeric_level)
        handler.setFormatter(formatter)
        root_logger.addHandler(handler)

    for noisy, level in {"httpx": logging.WARNING, "hpack": logging.WARNING}.items():
        logging.getLogger(noisy).setLevel(level)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
