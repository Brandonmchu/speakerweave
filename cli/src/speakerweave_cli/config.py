"""Credential storage and precedence for the SpeakerWeave CLI."""

from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_SERVER = "https://speakerweave.com"
CONFIG_PATH = Path.home() / ".config" / "speakerweave" / "config.toml"


class ConfigError(ValueError):
    """The local configuration cannot be read or validated."""


@dataclass(frozen=True)
class Config:
    server: str | None = None
    token: str | None = None


@dataclass(frozen=True)
class ResolvedConfig:
    server: str
    token: str | None
    token_source: str | None


def normalize_server(value: str) -> str:
    server = value.strip().rstrip("/")
    parsed = urlsplit(server)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigError("Server must be a full http:// or https:// URL.")
    if parsed.query or parsed.fragment:
        raise ConfigError("Server URL cannot contain a query string or fragment.")
    return server


def load_config(path: Path | None = None) -> Config:
    target = path or CONFIG_PATH
    if not target.exists():
        return Config()
    try:
        payload = tomllib.loads(target.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"Could not read {target}: {exc}") from exc
    server = payload.get("server")
    token = payload.get("token")
    if server is not None and not isinstance(server, str):
        raise ConfigError(f"Invalid server value in {target}.")
    if token is not None and not isinstance(token, str):
        raise ConfigError(f"Invalid token value in {target}.")
    return Config(server=server or None, token=token or None)


def resolve_config(
    *,
    server_override: str | None = None,
    token_override: str | None = None,
    environ: dict[str, str] | os._Environ[str] | None = None,
    path: Path | None = None,
) -> ResolvedConfig:
    stored = load_config(path)
    env = os.environ if environ is None else environ
    env_token = (env.get("SPEAKERWEAVE_TOKEN") or "").strip() or None
    flag_token = (token_override or "").strip() or None
    token = flag_token or env_token or stored.token
    source = "flag" if flag_token else "environment" if env_token else "file" if stored.token else None
    server = normalize_server(server_override or stored.server or DEFAULT_SERVER)
    return ResolvedConfig(server=server, token=token, token_source=source)


def save_config(server: str, token: str, path: Path | None = None) -> Path:
    target = path or CONFIG_PATH
    normalized_server = normalize_server(server)
    clean_token = token.strip()
    if not clean_token:
        raise ConfigError("API token cannot be empty.")
    try:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_text(
            f"server = {json.dumps(normalized_server)}\ntoken = {json.dumps(clean_token)}\n",
            encoding="utf-8",
        )
        target.chmod(0o600)
    except OSError as exc:
        raise ConfigError(f"Could not write {target}: {exc}") from exc
    return target


def delete_config(path: Path | None = None) -> bool:
    target = path or CONFIG_PATH
    try:
        target.unlink()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise ConfigError(f"Could not remove {target}: {exc}") from exc
    return True


def mask_token(token: str) -> str:
    if len(token) <= 8:
        return "•" * len(token)
    return f"{token[:5]}…{token[-4:]}"
