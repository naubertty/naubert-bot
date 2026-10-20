import json

import pytest

from greeplus.cli import (
    MODE_NAMES,
    friendly_state,
    main,
    parse_property,
)


def test_parse_property_friendly_names():
    assert parse_property("temp=24") == ("SetTem", 24)
    assert parse_property("temperatura=22.0") == ("SetTem", 22)
    assert parse_property("mode=cool") == ("Mod", 1)
    assert parse_property("modo=aquecer") == ("Mod", 4)
    assert parse_property("fan=medium-high") == ("WdSpd", 4)
    assert parse_property("power=on") == ("Pow", 1)
    assert parse_property("pow=off") == ("Pow", 0)
    assert parse_property("light=ligado") == ("Lig", 1)
    assert parse_property("quiet=on") == ("Quiet", 2)
    assert parse_property("swing=oscilar") == ("SwUpDn", 1)
    assert parse_property("swing=3") == ("SwUpDn", 3)
    assert parse_property("SvSt=1") == ("SvSt", 1)
    assert parse_property("WdSpd=5") == ("WdSpd", 5)


def test_parse_property_rejects_bad_values():
    with pytest.raises(Exception):
        parse_property("temp=40")
    with pytest.raises(Exception):
        parse_property("mode=gelar")
    with pytest.raises(Exception):
        parse_property("temp")


def test_friendly_state_mapping():
    raw = {
        "Pow": 1,
        "Mod": 1,
        "SetTem": 23,
        "TemSen": 66,
        "WdSpd": 0,
        "SwUpDn": 1,
        "Lig": 1,
        "SwhSlp": 0,
        "Tur": 0,
        "Quiet": 0,
        "Blo": 0,
        "Health": 0,
        "Air": 0,
        "TemUn": 0,
    }
    state = friendly_state(raw)
    assert state["power"] is True
    assert state["mode_name"] == "Resfriar"
    assert state["target"] == 23
    assert state["indoor"] == 26
    assert state["fan_name"] == "Automático"
    assert state["swing_name"] == "Oscilando (completo)"
    assert state["light"] is True
    assert state["raw"] is raw
    assert MODE_NAMES[4] == "Aquecer"


def test_friendly_state_without_sensor():
    state = friendly_state({"Pow": 0, "TemSen": 0})
    assert state["indoor"] == 0
    assert state["light"] is None


def run_cli(capsys, *argv):
    code = main(["--no-color", *argv])
    captured = capsys.readouterr()
    return code, captured.out


def test_cli_scan(emulator, capsys):
    code, out = run_cli(
        capsys, "scan", "--target", "127.0.0.1", "--port", str(emulator.port), "--timeout", "1.2", "--json"
    )
    assert code == 0
    devices = json.loads(out)
    assert len(devices) == 1
    assert devices[0]["mac"] == emulator.mac


def test_cli_bind_status_set(emulator, capsys, tmp_path):
    config = str(tmp_path / "greeplus.json")
    code, out = run_cli(
        capsys,
        "bind",
        "--ip",
        "127.0.0.1",
        "--port",
        str(emulator.port),
        "--mac",
        emulator.mac,
        "--protocol",
        emulator.protocol,
        "--config",
        config,
        "--json",
        "--timeout",
        "1.0",
    )
    assert code == 0, out
    saved = json.loads(out)
    assert saved["key"] == emulator.key.decode()
    assert saved["ip"] == "127.0.0.1"

    code, out = run_cli(capsys, "status", "--config", config, "--json")
    assert code == 0, out
    payload = json.loads(out)
    assert payload["state"]["power"] is False
    assert payload["state"]["target"] == 24

    code, out = run_cli(capsys, "set", "pow=on", "temp=22", "mode=cool", "--config", config, "--json")
    assert code == 0, out
    payload = json.loads(out)
    assert payload["state"]["power"] is True
    assert payload["state"]["target"] == 22
    assert payload["sent"] == {"Pow": 1, "SetTem": 22, "Mod": 1}

    code, out = run_cli(capsys, "status", "--config", config, "--raw")
    assert code == 0
    assert json.loads(out)["Pow"] == 1


def test_cli_status_without_config(capsys, tmp_path):
    code, out = run_cli(capsys, "status", "--config", str(tmp_path / "none.json"))
    assert code == 2
    assert "bind" in out or "IP" in out


def test_cli_decode_v1(capsys):
    from greeplus.crypto import CipherV1

    payload = {"t": "dev", "mac": "502cc6aabbcc", "name": "Sala"}
    pack = CipherV1().encrypt(payload)
    code, out = run_cli(capsys, "decode", "--pack", pack, "--json")
    assert code == 0
    assert json.loads(out) == payload


def test_cli_decode_failure(capsys):
    import base64

    bad = base64.b64encode(bytes(32)).decode()
    code, out = run_cli(capsys, "decode", "--pack", bad)
    assert code == 1
    assert "decifrar" in out or "chave" in out


def test_cli_diagnose(emulator, capsys, tmp_path):
    code, out = run_cli(
        capsys,
        "diagnose",
        "--target",
        "127.0.0.1",
        "--port",
        str(emulator.port),
        "--config",
        str(tmp_path / "cfg.json"),
        "--timeout",
        "1.5",
    )
    assert code == 0
    assert "Diagnóstico greeplus" in out
    assert emulator.mac in out
    assert "bind" in out or "OK" in out


def test_cli_sniff_shows_raw_packets(emulator, capsys):
    code, out = run_cli(
        capsys, "sniff", "--target", "127.0.0.1", "--port", str(emulator.port), "--seconds", "1.5"
    )
    assert code == 0
    assert "pacote(s) recebido(s)" in out
    assert "decifrado" in out


def test_cli_diagnose_with_ip_hint(emulator, capsys, tmp_path):
    code, out = run_cli(
        capsys,
        "diagnose",
        "--ip",
        "127.0.0.1",
        "--port",
        str(emulator.port),
        "--config",
        str(tmp_path / "cfg.json"),
        "--timeout",
        "1.5",
    )
    assert code == 0
    assert "Alcançabilidade (ping)" in out
