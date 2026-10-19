"""Command line interface: gree.py <scan|bind|status|set|watch|web|emulator>."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import __version__
from .client import GreeClient, GreeError, GreeTimeout, scan
from .crypto import CipherV2, make_cipher
from .packets import PORT, DeviceInfo, format_mac, key_bytes

DEFAULT_CONFIG = "greeplus.json"

MODES = {"auto": 0, "automatico": 0, "cool": 1, "resfriar": 1, "dry": 2, "desumidificar": 2,
         "fan": 3, "ventilar": 3, "heat": 4, "aquecer": 4}
MODE_NAMES = {0: "Automático", 1: "Resfriar", 2: "Desumidificar", 3: "Ventilar", 4: "Aquecer"}

FANS = {"auto": 0, "automatico": 0, "low": 1, "baixo": 1, "medium-low": 2, "medio-baixo": 2,
        "medium": 3, "medio": 3, "medium-high": 4, "medio-alto": 4, "high": 5, "alto": 5}
FAN_NAMES = {0: "Automático", 1: "Baixo", 2: "Médio-baixo", 3: "Médio", 4: "Médio-alto", 5: "Alto"}

SWING_VERTICAL = {
    "off": 0, "parado": 0, "full": 1, "completo": 1, "oscilar": 1, "swing": 1,
    "upper": 2, "superior": 2,
    "upper-middle": 3, "middle": 4, "meio": 4, "lower-middle": 5, "lower": 6, "inferior": 6,
    "swing-upper": 7, "swing-middle": 9, "swing-lower": 11,
}
SWING_NAMES = {0: "Parado", 1: "Oscilando (completo)", 2: "Fixo superior", 3: "Fixo superior-médio",
               4: "Fixo no meio", 5: "Fixo inferior-médio", 6: "Fixo inferior", 7: "Oscilando superior",
               8: "Oscilando superior-médio", 9: "Oscilando no meio", 10: "Oscilando inferior-médio",
               11: "Oscilando inferior"}

ON_OFF = {"on": 1, "ligar": 1, "ligado": 1, "1": 1, "true": 1, "sim": 1,
          "off": 0, "desligar": 0, "desligado": 0, "0": 0, "false": 0, "nao": 0, "não": 0}

# Friendly CLI names -> protocol property names.
ALIASES = {
    "power": "Pow", "pow": "Pow", "energia": "Pow",
    "mode": "Mod", "mod": "Mod", "modo": "Mod",
    "temp": "SetTem", "temperatura": "SetTem", "settem": "SetTem",
    "fan": "WdSpd", "wdspd": "WdSpd", "ventilador": "WdSpd",
    "swing": "SwUpDn", "swupdn": "SwUpDn", "aleta": "SwUpDn",
    "swingh": "SwingLfRig",
    "light": "Lig", "lig": "Lig", "luz": "Lig", "lampada": "Lig", "lâmpada": "Lig",
    "sleep": "SwhSlp", "swhslp": "SwhSlp", "dormir": "SwhSlp",
    "turbo": "Tur", "tur": "Tur",
    "quiet": "Quiet", "silencioso": "Quiet",
    "xfan": "Blo", "blo": "Blo",
    "health": "Health", "anion": "Health", "ion": "Health",
    "air": "Air", "freshair": "Air",
}

BOOL_PROPS = {"Pow", "Lig", "SwhSlp", "SlpMod", "Tur", "Health", "Air", "Blo", "SvSt", "StHt"}


# ---------------------------------------------------------------------------
# Small output helpers
# ---------------------------------------------------------------------------


class UsageError(Exception):
    """Erro de uso que deve virar uma mensagem amigável (sem traceback)."""


class Style:
    enabled = False

    @classmethod
    def setup(cls, enable: bool) -> None:
        if enable and os.name == "nt":
            try:  # enable ANSI escape processing on modern Windows consoles
                import ctypes

                kernel32 = ctypes.windll.kernel32
                kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            except Exception:  # noqa: BLE001
                pass
        cls.enabled = enable

    @classmethod
    def _wrap(cls, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if cls.enabled else text

    @classmethod
    def bold(cls, text: str) -> str:
        return cls._wrap("1", text)

    @classmethod
    def dim(cls, text: str) -> str:
        return cls._wrap("2", text)

    @classmethod
    def green(cls, text: str) -> str:
        return cls._wrap("32", text)

    @classmethod
    def yellow(cls, text: str) -> str:
        return cls._wrap("33", text)

    @classmethod
    def cyan(cls, text: str) -> str:
        return cls._wrap("36", text)


def print_json(data: Any) -> None:
    json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


def config_path(value: Optional[str]) -> Path:
    return Path(value or os.environ.get("GREEPLUS_CONFIG") or DEFAULT_CONFIG)


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    file = config_path(path)
    if not file.is_file():
        return {}
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(data: Dict[str, Any], path: Optional[str] = None) -> Path:
    file = config_path(path)
    file.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return file


# ---------------------------------------------------------------------------
# Value conversion
# ---------------------------------------------------------------------------


def _to_number(text: str) -> Any:
    try:
        return int(text)
    except ValueError:
        try:
            return float(text)
        except ValueError:
            return text


def parse_property(text: str) -> tuple[str, Any]:
    """Translate ``temp=24``/``pow=on``/``SvSt=1`` into a protocol pair."""
    if "=" not in text:
        raise argparse.ArgumentTypeError(f"use NOME=VALOR (recebido: {text!r})")
    name, value = text.split("=", 1)
    name = name.strip()
    value = value.strip()
    key = name.lower()

    if key in ("temp", "temperatura", "settem"):
        number = int(float(value))
        if not 8 <= number <= 30:
            raise argparse.ArgumentTypeError("temperatura deve ficar entre 8 e 30 °C")
        return "SetTem", number
    if key in ("mode", "mod", "modo"):
        if value.lower() not in MODES:
            raise argparse.ArgumentTypeError(f"modo inválido: {value} (use {', '.join(MODES)})")
        return "Mod", MODES[value.lower()]
    if key in ("fan", "wdspd", "ventilador"):
        if value.lower() in FANS:
            return "WdSpd", FANS[value.lower()]
        try:
            number = int(float(value))
        except ValueError:
            raise argparse.ArgumentTypeError(f"velocidade inválida: {value} (use {', '.join(FANS)} ou 0-5)") from None
        if not 0 <= number <= 5:
            raise argparse.ArgumentTypeError("velocidade deve ficar entre 0 e 5")
        return "WdSpd", number
    if key in ("swing", "swupdn", "aleta"):
        if value.lower() in SWING_VERTICAL:
            return "SwUpDn", SWING_VERTICAL[value.lower()]
        return "SwUpDn", int(float(value))
    if key in ("swingh", "swinglfrig"):
        return "SwingLfRig", int(float(value))

    prop = ALIASES.get(key, name)
    if prop in BOOL_PROPS or key in ("xfan", "quiet", "turbo", "sleep", "light", "health", "air"):
        if value.lower() in ON_OFF:
            flag = ON_OFF[value.lower()]
            if prop == "Quiet":
                return "Quiet", 2 if flag else 0
            return prop, flag
        return prop, _to_number(value)
    return prop, _to_number(value)


def friendly_state(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise protocol properties for display/JSON."""
    power = raw.get("Pow")
    mode = raw.get("Mod")
    target = raw.get("SetTem")
    sensor = raw.get("TemSen")
    indoor = None
    if isinstance(sensor, int):
        # Firmware sends the room sensor with a +40 offset on most models.
        indoor = sensor - 40 if sensor >= 40 else sensor

    swing = raw.get("SwUpDn")
    return {
        "power": bool(power) if power is not None else None,
        "mode": mode,
        "mode_name": MODE_NAMES.get(mode, str(mode)) if mode is not None else None,
        "target": target,
        "indoor": indoor,
        "fan": raw.get("WdSpd"),
        "fan_name": FAN_NAMES.get(raw.get("WdSpd"), str(raw.get("WdSpd"))) if raw.get("WdSpd") is not None else None,
        "swing": swing,
        "swing_name": SWING_NAMES.get(swing, str(swing)) if swing is not None else None,
        "swing_horizontal": raw.get("SwingLfRig"),
        "light": bool(raw.get("Lig")) if raw.get("Lig") is not None else None,
        "sleep": bool(raw.get("SwhSlp")) if raw.get("SwhSlp") is not None else None,
        "turbo": bool(raw.get("Tur")) if raw.get("Tur") is not None else None,
        "quiet": bool(raw.get("Quiet")) if raw.get("Quiet") is not None else None,
        "xfan": bool(raw.get("Blo")) if raw.get("Blo") is not None else None,
        "health": bool(raw.get("Health")) if raw.get("Health") is not None else None,
        "fresh_air": bool(raw.get("Air")) if raw.get("Air") is not None else None,
        "heat_cool_type": raw.get("HeatCoolType"),
        "temperature_unit": raw.get("TemUn"),
        "raw": raw,
    }


# ---------------------------------------------------------------------------
# Device helpers
# ---------------------------------------------------------------------------


def client_from_args(args, config: Optional[Dict[str, Any]] = None, require_key: bool = False) -> GreeClient:
    config = config if config is not None else load_config(getattr(args, "config", None))
    ip = getattr(args, "ip", None) or config.get("ip")
    if not ip:
        raise UsageError(
            "Informe o IP do aparelho com --ip (ex.: --ip 192.168.0.50) ou rode antes:\n"
            "  python gree.py bind --ip 192.168.0.50"
        )
    mac = getattr(args, "mac", None) or config.get("mac")
    key = getattr(args, "key", None) or config.get("key")
    protocol = getattr(args, "protocol", None) or config.get("protocol")
    port = getattr(args, "port", None) or config.get("port") or PORT
    if require_key and not key:
        raise UsageError(
            "Nenhuma chave salva para este aparelho. Rode primeiro:\n"
            f"  python gree.py bind --ip {ip}"
        )
    return GreeClient(
        ip=ip,
        port=int(port),
        mac=mac,
        key=key,
        name=config.get("name"),
        model=config.get("model"),
        version=config.get("version"),
        mid=config.get("mid"),
        protocol=protocol,
        timeout=float(getattr(args, "timeout", None) or 4.0),
    )


def print_device_line(info: DeviceInfo) -> None:
    parts = [Style.bold(info.display_name), Style.dim(f"{info.ip}:{info.port}")]
    if info.mac:
        parts.append(f"MAC {format_mac(info.mac)}")
    print("  ".join(parts))
    details = []
    if info.version:
        details.append(f"firmware {info.version}")
    if info.model:
        details.append(f"modelo {info.model}")
    if info.mid:
        details.append(f"mid {info.mid}")
    if info.protocol:
        details.append(f"protocolo {info.protocol.upper()}")
    if details:
        print("  " + Style.dim(" · ".join(details)))


def print_status(info: DeviceInfo, state: Dict[str, Any]) -> None:
    print()
    print_device_line(info)
    print(Style.dim("─" * 52))
    if state.get("power") is None:
        print(Style.yellow("  Aparelho não informou o estado (Pow ausente)."))
    power = "LIGADO" if state.get("power") else "desligado"
    power_text = Style.green(power) if state.get("power") else Style.dim(power)
    print(f"  {'Energia':<14} {power_text}")
    print(f"  {'Modo':<14} {state.get('mode_name') or '—'}")
    target = f"{state['target']} °C" if state.get("target") is not None else "—"
    indoor = f"{state['indoor']} °C" if state.get("indoor") is not None else "—"
    print(f"  {'Temperatura':<14} {target}  {Style.dim(f'(ambiente {indoor})')}")
    print(f"  {'Ventilador':<14} {state.get('fan_name') or '—'}")
    print(f"  {'Aleta':<14} {state.get('swing_name') or '—'}")

    def flag(name: str, value: Optional[bool]) -> str:
        if value is None:
            return Style.dim(f"{name}: —")
        return f"{name}: " + ("on" if value else "off")

    toggles = [
        flag("Luz", state.get("light")),
        flag("Sleep", state.get("sleep")),
        flag("Turbo", state.get("turbo")),
        flag("Quieto", state.get("quiet")),
    ]
    print("  " + "   ".join(toggles))
    extras = [flag("XFan", state.get("xfan")), flag("Ion", state.get("health")), flag("Ar novo", state.get("fresh_air"))]
    print("  " + "   ".join(extras))
    print()


def print_scan(devices: List[DeviceInfo]) -> None:
    if not devices:
        print(Style.yellow("Nenhum aparelho respondeu. Verifique se o Wi-Fi do PC está na mesma rede do ar-condicionado."))
        return
    print(Style.bold(f"{len(devices)} aparelho(s) encontrado(s):"))
    for info in devices:
        print()
        print_device_line(info)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_scan(args) -> int:
    targets = args.target or None
    timeout = args.timeout or 3.0
    devices = scan(targets, timeout=timeout, port=args.port or PORT)
    if args.json:
        print_json([d.to_dict() for d in devices])
    else:
        print_scan(devices)
    return 0 if devices else 1


def cmd_bind(args) -> int:
    device_port = args.port or PORT
    info = None
    if args.ip:
        info = discover_with_retry(args.ip, args.timeout, device_port)
        if info is None:
            print(Style.yellow(f"Nenhum aparelho respondeu em {args.ip}. Tentando parear mesmo assim..."))
    client = GreeClient(
        ip=args.ip or "",
        port=device_port,
        mac=args.mac or (info.mac if info else None),
        name=info.name if info else None,
        model=info.model if info else None,
        version=info.version if info else None,
        mid=info.mid if info else None,
        protocol=args.protocol or (info.protocol if info else None),
        timeout=args.timeout or 4.0,
    )
    if not client.info.mac:
        found = scan(args.target or None, timeout=args.timeout or 3.0, port=device_port)
        if not found:
            print(Style.yellow("Nenhum aparelho encontrado na rede. Use --ip <endereço>."))
            return 1
        if len(found) > 1 and not args.ip:
            print("Mais de um aparelho encontrado; escolha com --ip:")
            print_scan(found)
            return 1
        info = found[0]
        client.info.ip = info.ip
        client.info.mac = info.mac
        client.info.port = info.port
        client.info.name = info.name
        client.info.model = info.model
        client.info.version = info.version
        client.info.mid = info.mid
        client.protocol = info.protocol

    if not client.info.ip:
        raise UsageError("Informe o IP do aparelho com --ip (ex.: --ip 192.168.0.50).")

    try:
        key = client.bind()
    except (GreeTimeout, GreeError) as exc:
        print(Style.yellow(f"Falha no pareamento: {exc}"))
        return 2

    data = {
        "ip": client.info.ip,
        "port": client.info.port,
        "mac": client.info.mac,
        "key": key,
        "name": client.info.name,
        "model": client.info.model,
        "version": client.info.version,
        "mid": client.info.mid,
        "protocol": client.protocol,
    }
    path = save_config(data, args.config)
    if args.json:
        print_json(data)
        return 0
    print()
    print_device_line(client.info)
    print(Style.green("  Pareado com sucesso."))
    print(f"  Chave do aparelho: {Style.bold(key)}")
    print(f"  Salva em: {path}")
    print(Style.dim("\n  Agora: python gree.py status  (ou: python gree.py web)"))
    return 0


def discover_with_retry(ip: str, timeout: Optional[float], port: int) -> Optional[DeviceInfo]:
    from .client import discover

    return discover(ip, timeout=timeout or 3.0, port=port)


def cmd_status(args) -> int:
    client = client_from_args(args)
    columns = None
    if getattr(args, "cols", None):
        columns = [name.strip() for name in args.cols.split(",") if name.strip()]
    try:
        raw = client.status(columns=columns)
    except GreeTimeout as exc:
        print(Style.yellow(f"Sem resposta: {exc}"))
        print(Style.dim("Dica: rode 'python gree.py bind --ip <ip>' novamente se o app Gree+ foi repareado."))
        return 2
    except GreeError as exc:
        print(Style.yellow(f"Erro: {exc}"))
        return 2

    info = client.info
    state = friendly_state(raw)
    if args.json:
        payload = {"device": info.to_dict(), "state": state}
        print_json(payload)
    elif args.raw:
        print_json(raw)
    else:
        print_status(info, state)
    return 0


def cmd_set(args) -> int:
    client = client_from_args(args, require_key=True)
    properties: Dict[str, Any] = {}
    try:
        for item in args.assignments:
            name, value = parse_property(item)
            properties[name] = value
    except (argparse.ArgumentTypeError, ValueError) as exc:
        print(Style.yellow(str(exc)))
        return 2

    try:
        client.command(properties)
        if args.no_status:
            if args.json:
                print_json({"sent": properties})
            else:
                print(Style.green("Comando enviado: ") + ", ".join(f"{k}={v}" for k, v in properties.items()))
            return 0
        raw = client.status()
    except GreeTimeout as exc:
        print(Style.yellow(f"Sem resposta: {exc}"))
        return 2
    except GreeError as exc:
        print(Style.yellow(f"Erro: {exc}"))
        return 2

    state = friendly_state(raw)
    if args.json:
        print_json({"sent": properties, "state": state})
    else:
        print_status(client.info, state)
    return 0


def cmd_watch(args) -> int:
    client = client_from_args(args)
    interval = max(1.0, args.interval)
    try:
        while True:
            raw = client.status()
            state = friendly_state(raw)
            stamp = time.strftime("%H:%M:%S")
            target = f"{state['target']}°C" if state.get("target") is not None else "--"
            indoor = f"{state['indoor']}°C" if state.get("indoor") is not None else "--"
            power = "ON " if state.get("power") else "OFF"
            print(
                f"{Style.dim(stamp)}  {power}  {state.get('mode_name') or '--':<14} "
                f"alvo {target:>5}  ambiente {indoor:>5}  vent {state.get('fan_name') or '--'}",
                flush=True,
            )
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nEncerrado.")
        return 0
    except GreeError as exc:
        print(Style.yellow(f"Erro: {exc}"))
        return 2


def cmd_web(args) -> int:
    from .web import main as web_main

    web_main(args)
    return 0


def cmd_decode(args) -> int:
    """Decifra um campo `pack` copiado de uma captura (Wireshark/tcpdump)."""
    attempts: List[tuple] = []
    versions = [args.protocol] if args.protocol else ["v1", "v2"]
    if args.key:
        raw = key_bytes(args.key)
        for version in versions:
            attempts.append((f"{version.upper()} com a chave informada", make_cipher(version, raw)))
    for version in versions:
        attempts.append((f"{version.upper()} com a chave genérica", make_cipher(version)))

    for label, cipher in attempts:
        try:
            if isinstance(cipher, CipherV2):
                data = cipher.decrypt(args.pack, args.tag)
            else:
                data = cipher.decrypt(args.pack)
        except Exception:  # noqa: BLE001 - try the next cipher
            continue
        if not isinstance(data, dict):
            continue
        if args.json:
            print_json(data)
        else:
            print(Style.green(f"Decifrado com {label}:"))
            print_json(data)
        return 0

    print(Style.yellow("Não foi possível decifrar com as chaves conhecidas."))
    print(Style.dim("Informe a chave do aparelho com --key e, se necessário, --protocol v1|v2."))
    return 1


def cmd_emulator(args) -> int:
    from .emulator import run_emulator

    run_emulator(host=args.host, port=args.port, protocol=args.protocol)
    return 0


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gree.py",
        description="Controle local de ar-condicionado Gree/GREE+ pelo PC (UDP 7000).",
        epilog="Exemplos:\n"
        "  python gree.py scan\n"
        "  python gree.py bind --ip 192.168.0.50\n"
        "  python gree.py status\n"
        "  python gree.py set temp=22 mode=cool fan=auto\n"
        "  python gree.py web --demo\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"greeplus {__version__}")
    parser.add_argument("--no-color", action="store_true", help="desliga cores no terminal")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_connection_options(p, key: bool = True) -> None:
        p.add_argument("--ip", help="IP do aparelho (ex.: 192.168.0.50)")
        p.add_argument("--port", type=int, default=None, help="porta UDP (padrão 7000)")
        p.add_argument("--mac", help="MAC do aparelho (descoberto automaticamente)")
        if key:
            p.add_argument("--key", help="chave do aparelho (a mesma salva pelo bind)")
        p.add_argument("--protocol", choices=["v1", "v2"], help="força a geração do protocolo")
        p.add_argument("--config", help=f"arquivo de configuração (padrão {DEFAULT_CONFIG})")
        p.add_argument("--timeout", type=float, help="tempo de espera por resposta, em segundos")
        p.add_argument("--json", action="store_true", help="saída em JSON")

    scan_p = sub.add_parser("scan", help="procura aparelhos na rede local")
    scan_p.add_argument("--target", action="append", help="IP ou broadcast específico (pode repetir)")
    scan_p.add_argument("--timeout", type=float, default=3.0, help="segundos aguardando respostas")
    scan_p.add_argument("--port", type=int, default=None, help="porta UDP (padrão 7000)")
    scan_p.add_argument("--json", action="store_true", help="saída em JSON")
    scan_p.set_defaults(func=cmd_scan)

    bind_p = sub.add_parser("bind", help="pareia com o aparelho e salva a chave")
    add_connection_options(bind_p, key=False)
    bind_p.add_argument("--target", action="append", help="broadcast específico para a busca")
    bind_p.set_defaults(func=cmd_bind)

    status_p = sub.add_parser("status", help="mostra o estado atual")
    add_connection_options(status_p)
    status_p.add_argument("--raw", action="store_true", help="mostra as propriedades cruas do protocolo")
    status_p.add_argument("--cols", help="propriedades específicas separadas por vírgula (ex.: hid,name,host)")
    status_p.set_defaults(func=cmd_status)

    set_p = sub.add_parser("set", help="envia comandos (ex.: temp=22 pow=on)")
    add_connection_options(set_p)
    set_p.add_argument("assignments", nargs="+", metavar="NOME=VALOR",
                       help="pow=on/off, mode=auto|cool|dry|fan|heat, temp=8..30, fan=..., swing=..., light=...")
    set_p.add_argument("--no-status", action="store_true", help="não consulta o estado depois do comando")
    set_p.set_defaults(func=cmd_set)

    watch_p = sub.add_parser("watch", help="acompanha o estado em tempo real")
    add_connection_options(watch_p)
    watch_p.add_argument("--interval", type=float, default=5.0, help="segundos entre consultas")
    watch_p.set_defaults(func=cmd_watch)

    web_p = sub.add_parser("web", help="abre a interface web local")
    add_connection_options(web_p)
    web_p.add_argument("--host", default="0.0.0.0", help="endereço de escuta (padrão 0.0.0.0)")
    web_p.add_argument("--http-port", type=int, default=8080, help="porta HTTP (padrão 8080)")
    web_p.add_argument("--demo", action="store_true", help="sobe um aparelho emulado para testar a interface")
    web_p.add_argument("--demo-protocol", choices=["v1", "v2"], default="v1", help="protocolo do emulador")
    web_p.add_argument("--open", dest="open_browser", action="store_true", help="abre o navegador automaticamente")
    web_p.set_defaults(func=cmd_web)

    decode_p = sub.add_parser("decode", help="decifra um campo pack copiado de uma captura")
    decode_p.add_argument("--pack", required=True, help="conteúdo Base64 do campo pack")
    decode_p.add_argument("--tag", help="conteúdo Base64 do campo tag (protocolo v2)")
    decode_p.add_argument("--key", help="chave do aparelho (opcional; tenta as genéricas antes)")
    decode_p.add_argument("--protocol", choices=["v1", "v2"], help="força a geração do protocolo")
    decode_p.add_argument("--json", action="store_true", help="saída em JSON")
    decode_p.set_defaults(func=cmd_decode)

    emu_p = sub.add_parser("emulator", help="roda um aparelho Gree falso para testes")
    emu_p.add_argument("--host", default="0.0.0.0", help="endereço de escuta (padrão 0.0.0.0)")
    emu_p.add_argument("--port", type=int, default=PORT, help="porta UDP (padrão 7000)")
    emu_p.add_argument("--protocol", choices=["v1", "v2"], default="v1", help="geração do protocolo")
    emu_p.set_defaults(func=cmd_emulator)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    color = not args.no_color and sys.stdout.isatty()
    Style.setup(color)
    try:
        return int(args.func(args) or 0)
    except UsageError as exc:
        print(Style.yellow(str(exc)))
        return 2
    except KeyboardInterrupt:
        print("\nCancelado.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
