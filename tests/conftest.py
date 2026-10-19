import socket
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from greeplus.emulator import GreeEmulator  # noqa: E402


def free_udp_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


@pytest.fixture(params=["v1", "v2"])
def emulator(request):
    emu = GreeEmulator(
        host="127.0.0.1",
        port=free_udp_port(),
        protocol=request.param,
        name="Sala (teste)",
    ).start()
    try:
        yield emu
    finally:
        emu.stop()
