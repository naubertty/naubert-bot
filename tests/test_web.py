"""HTTP layer tests: the browser UI talks to these endpoints."""

import json
import threading
import urllib.error
import urllib.request

import pytest

from greeplus.web import DeviceSession, GreeHTTPServer, make_handler


@pytest.fixture
def server(emulator, tmp_path):
    session = DeviceSession(config_file=str(tmp_path / "client.json"))
    httpd = GreeHTTPServer(("127.0.0.1", 0), make_handler(session))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        yield base, session, tmp_path / "client.json"
    finally:
        httpd.shutdown()
        httpd.server_close()


def request(base, path, method="GET", payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read()
        return error.code, json.loads(body) if body else {}


def test_index_page(server):
    base, _, _ = server
    with urllib.request.urlopen(base + "/", timeout=5) as response:
        html = response.read().decode()
    assert response.status == 200
    assert "Conectar aparelho" in html
    assert "/api/state" in html
    assert "Gree" in html


def test_health(server):
    base, _, _ = server
    status, payload = request(base, "/api/health")
    assert status == 200 and payload["ok"] is True


def test_scan_endpoint(server, emulator):
    base, _, _ = server
    status, payload = request(base, f"/api/scan?target=127.0.0.1&port={emulator.port}")
    assert status == 200
    assert len(payload["devices"]) == 1
    assert payload["devices"][0]["mac"] == emulator.mac


def test_connect_state_set(server, emulator):
    base, session, config_file = server
    status, payload = request(
        base,
        "/api/connect",
        "POST",
        {
            "ip": "127.0.0.1",
            "port": emulator.port,
            "mac": emulator.mac,
            "protocol": emulator.protocol,
        },
    )
    assert status == 200, payload
    assert payload["connected"] is True
    assert payload["state"]["power"] is False

    stored = json.loads(config_file.read_text())
    assert stored["key"] == emulator.key.decode()
    assert stored["ip"] == "127.0.0.1"

    status, payload = request(base, "/api/state?force=1")
    assert status == 200 and payload["state"]["target"] == 24

    status, payload = request(
        base, "/api/set", "POST", {"props": {"Pow": 1, "SetTem": 21, "Mod": 1}}
    )
    assert status == 200, payload
    assert payload["state"]["power"] is True
    assert payload["state"]["target"] == 21

    status, payload = request(base, "/api/disconnect", "POST", {})
    assert status == 200 and payload["connected"] is False


def test_connect_without_ip_fails_cleanly(server):
    base, _, _ = server
    status, payload = request(base, "/api/connect", "POST", {})
    assert status == 502
    assert payload["ok"] is False
    assert "IP" in payload["error"]


def test_set_requires_props(server):
    base, _, _ = server
    status, payload = request(base, "/api/set", "POST", {})
    assert status == 400
    assert payload["ok"] is False


def test_unknown_route(server):
    base, _, _ = server
    status, payload = request(base, "/api/nada")
    assert status == 404


def test_connect_with_scanned_device_uses_single_session(tmp_path):
    """Reproduz o caso real: aparelho que só aceita bind após scan na mesma porta."""
    from greeplus.emulator import GreeEmulator
    from tests.conftest import free_udp_port

    emu = GreeEmulator(host="127.0.0.1", port=free_udp_port(), require_scan=True).start()
    session = DeviceSession(config_file=str(tmp_path / "client.json"))
    httpd = GreeHTTPServer(("127.0.0.1", 0), make_handler(session))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        status, payload = request(
            base,
            "/api/connect",
            "POST",
            {"ip": "127.0.0.1", "port": emu.port, "mac": emu.mac, "protocol": emu.protocol},
        )
        assert status == 200, payload
        assert payload["connected"] is True
        assert payload["state"]["target"] == 24
    finally:
        httpd.shutdown()
        httpd.server_close()
        emu.stop()
