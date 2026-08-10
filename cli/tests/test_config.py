from __future__ import annotations

import stat

from speakerweave_cli.config import load_config, resolve_config, save_config


def test_config_store_is_private_and_round_trips(isolated_config):
    saved = save_config("https://conf.example/", "dais_stored", path=isolated_config)

    assert saved == isolated_config
    assert stat.S_IMODE(saved.stat().st_mode) == 0o600
    assert load_config(saved).server == "https://conf.example"
    assert load_config(saved).token == "dais_stored"


def test_token_precedence_is_flag_then_env_then_file(isolated_config):
    save_config("https://stored.example", "dais_file", path=isolated_config)

    from_file = resolve_config(environ={}, path=isolated_config)
    from_env = resolve_config(
        environ={"SPEAKERWEAVE_TOKEN": "dais_env"},
        path=isolated_config,
    )
    from_flag = resolve_config(
        token_override="dais_flag",
        environ={"SPEAKERWEAVE_TOKEN": "dais_env"},
        path=isolated_config,
    )

    assert (from_file.token, from_file.token_source) == ("dais_file", "file")
    assert (from_env.token, from_env.token_source) == ("dais_env", "environment")
    assert (from_flag.token, from_flag.token_source) == ("dais_flag", "flag")
