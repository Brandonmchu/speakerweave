"""Logging setup. JSON lines in deployed environments, plain text locally."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

DEFAULT_LOG_FORMAT = "%(levelname)s - %(name)s - %(message)s"


class JSONFormatter(logging.Formatter):
    """Structured logs so Railway parses levels instead of guessing."""

    def format(self, record: logging.LogRecord) -> str:
        log_obj = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
            # Railway's log explorer swallows the "message" key into its own
            # (empty) message field; the duplicate keeps the text visible as an
            # attribute in the UI and CLI.
            "msg": record.getMessage(),
        }
        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)
        if hasattr(record, "extra_fields"):
            log_obj.update(record.extra_fields)
        return json.dumps(log_obj)


def setup_logging(default_level: str = "INFO") -> None:
    """Configure the root logger. JSON when ENVIRONMENT != development."""
    log_level = os.getenv("LOG_LEVEL", default_level).upper()
    numeric_level = getattr(logging, log_level, logging.INFO)
    use_json = os.getenv("ENVIRONMENT", "development") != "development"

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(numeric_level)

    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(numeric_level)
    handler.setFormatter(JSONFormatter() if use_json else logging.Formatter(DEFAULT_LOG_FORMAT))
    root_logger.addHandler(handler)

    for noisy, level in {"httpx": logging.WARNING, "hpack": logging.WARNING}.items():
        logging.getLogger(noisy).setLevel(level)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
