from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from speakerweave_cli import api as api_module
from speakerweave_cli import config as config_module
from speakerweave_cli import main as main_module


@pytest.fixture
def isolated_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    path = tmp_path / "speakerweave" / "config.toml"
    monkeypatch.setattr(config_module, "CONFIG_PATH", path)
    monkeypatch.setattr(main_module, "CONFIG_PATH", path)
    return path


@pytest.fixture
def mock_http(monkeypatch: pytest.MonkeyPatch):
    real_client = httpx.Client

    def install(handler: Callable[[httpx.Request], httpx.Response]) -> None:
        transport = httpx.MockTransport(handler)

        def client_factory(*args, **kwargs):
            kwargs["transport"] = transport
            return real_client(*args, **kwargs)

        monkeypatch.setattr(api_module.httpx, "Client", client_factory)

    return install
