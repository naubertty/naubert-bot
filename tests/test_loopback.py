"""End-to-end tests against the in-process emulator over real UDP sockets."""

import pytest

from greeplus.client import GreeClient, GreeError, GreeTimeout, discover, scan


def test_scan_finds_emulator(emulator):
    devices = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)
    assert len(devices) == 1
    device = devices[0]
    assert device.mac == emulator.mac
    assert device.name == "Sala (teste)"
    assert device.protocol == emulator.protocol
    assert device.port == emulator.port


def test_discover_unicast(emulator):
    device = discover("127.0.0.1", timeout=1.0)
    assert device is None or device.mac == emulator.mac  # uses default port 7000


def test_bind_status_and_command(emulator):
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(device.ip, port=emulator.port, mac=device.mac, protocol=device.protocol)
    key = client.bind()
    assert key == emulator.key.decode()
    assert client.protocol == emulator.protocol

    state = client.status()
    assert state["Pow"] == 0
    assert state["Mod"] == 1
    assert state["SetTem"] == 24
    assert state["TemSen"] == 66

    reply = client.command({"Pow": 1, "Mod": 1, "SetTem": 21})
    assert reply["Pow"] == 1
    assert reply["SetTem"] == 21

    updated = client.status()
    assert updated["Pow"] == 1
    assert updated["SetTem"] == 21
    assert updated["Mod"] == 1


def test_bind_with_explicit_key_skips_negotiation(emulator):
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(
        device.ip,
        port=emulator.port,
        mac=device.mac,
        key=emulator.key.decode(),
        protocol=emulator.protocol,
    )
    assert client.status()["Pow"] == 0


def test_wrong_key_times_out(emulator):
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(
        device.ip,
        port=emulator.port,
        mac=device.mac,
        key="WrongKey12345678",
        protocol=emulator.protocol,
        timeout=0.6,
        retries=1,
    )
    with pytest.raises((GreeTimeout, GreeError)):
        client.status()


def test_bind_autodetects_protocol(emulator):
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(device.ip, port=emulator.port, mac=device.mac, timeout=3.0)
    client.bind()
    assert client.protocol == emulator.protocol


def test_command_echo_buzzer_control(emulator):
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(device.ip, port=emulator.port, mac=device.mac, protocol=emulator.protocol)
    client.bind()
    reply = client.command({"WdSpd": 3})
    assert reply.get("WdSpd") == 3
    assert client.status()["WdSpd"] == 3


def test_status_unknown_columns_are_ignored(emulator):
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(device.ip, port=emulator.port, mac=device.mac, protocol=emulator.protocol)
    client.bind()
    state = client.status(columns=["Pow", "NaoExiste"])
    assert state == {"Pow": 0}


def test_bind_requires_scan_in_same_session(emulator):
    """Firmwares reais (ex.: V3.4.M) ignoram o bind que não vem da porta do scan."""
    from greeplus.emulator import GreeEmulator
    from tests.conftest import free_udp_port

    strict = GreeEmulator(
        host="127.0.0.1",
        port=free_udp_port(),
        protocol=emulator.protocol,
        require_scan=True,
    ).start()
    try:
        device = scan(["127.0.0.1"], timeout=1.5, port=strict.port)[0]
        client = GreeClient(device.ip, port=strict.port, mac=device.mac, protocol=device.protocol)
        key = client.bind(mac=device.mac)
        assert key == strict.key.decode()
        assert client.status()["Pow"] == 0
    finally:
        strict.stop()


def test_bind_works_without_unicast_discovery(emulator, monkeypatch):
    """O fluxo da interface web não pode depender da descoberta em unicast."""
    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient(device.ip, port=emulator.port, mac=device.mac, protocol=device.protocol)

    def sem_descoberta(*args, **kwargs):
        raise GreeTimeout("unicast ignorado pelo firmware")

    monkeypatch.setattr(client, "discover", sem_descoberta)
    assert client.bind() == emulator.key.decode()


def test_scan_subnet_finds_emulator(emulator):
    from greeplus.client import scan_subnet

    devices = scan_subnet(local="127.0.0.1", timeout=1.5, port=emulator.port)
    assert any(d.mac == emulator.mac for d in devices)


def test_scan_sweep_when_broadcast_fails(emulator, monkeypatch):
    import greeplus.client as client_module

    monkeypatch.setattr(client_module, "broadcast_targets", lambda: ["192.0.2.1"])  # TEST-NET: sem resposta
    monkeypatch.setattr(client_module, "local_ip", lambda: "127.0.0.1")
    devices = client_module.scan(None, timeout=0.6, port=emulator.port, sweep=True, sweep_timeout=1.5)
    assert [d.mac for d in devices] == [emulator.mac]


def test_icmp_ping_loopback():
    from greeplus.client import icmp_ping

    assert icmp_ping("127.0.0.1") in (True, None)


def test_prime_updates_stale_ip_from_broadcast_reply(emulator, monkeypatch):
    """Se o IP salvo estiver errado, o scan da sessão corrige pelo MAC."""
    import socket as socket_module

    import greeplus.client as client_module

    device = scan(["127.0.0.1"], timeout=1.5, port=emulator.port)[0]
    client = GreeClient("192.0.2.10", port=emulator.port, mac=device.mac, protocol=device.protocol)
    client.probe_timeout = 1.0
    # simula um broadcast que chega ao aparelho do teste
    monkeypatch.setattr(client_module, "broadcast_targets", lambda: ["127.0.0.1"])

    sock = socket_module.socket(socket_module.AF_INET, socket_module.SOCK_DGRAM)
    try:
        client._prime_session(sock)
    finally:
        sock.close()

    assert client.info.ip == "127.0.0.1"
    assert client.bind() == emulator.key.decode()
