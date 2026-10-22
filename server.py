"""Small, local web panel that queues Spotify URLs through spotDL.

The browser only submits Spotify links. The backend validates those links and
runs spotDL with an argument list (never through a shell) into a configured
music folder.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import mimetypes
import os
import platform
import queue
import re
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, unquote

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
ALLOWED_FORMATS = {"mp3", "m4a", "flac", "ogg", "opus", "wav"}
ALLOWED_BITRATES = {"auto", "128k", "192k", "320k"}
MAX_BODY_BYTES = 8 * 1024
MAX_PENDING_JOBS = 30
MAX_STORED_JOBS = 100
MAX_LOG_LINES = 100
SPOTIFY_ID_RE = re.compile(r"^[A-Za-z0-9]{10,64}$")
SPOTIFY_PATH_RE = re.compile(
    r"^/(?:intl-[A-Za-z0-9-]+/)?(track|playlist|album)/([A-Za-z0-9]{10,64})/?$",
    re.IGNORECASE,
)
SPOTIFY_URI_RE = re.compile(
    r"^spotify:(track|playlist|album):([A-Za-z0-9]{10,64})$",
    re.IGNORECASE,
)
ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def configured_output_dir() -> Path:
    """Return the configured destination, defaulting to ./downloads."""
    value = os.environ.get("SPOTDL_OUTPUT_DIR", "downloads").strip() or "downloads"
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BASE_DIR / path
    return path.resolve()


OUTPUT_DIR = configured_output_dir()


def normalize_spotify_url(value: Any) -> str:
    """Validate a Spotify track, album, or playlist link and remove tracking data."""
    if not isinstance(value, str):
        raise ValueError("Cole um link de faixa, álbum ou playlist do Spotify.")

    raw = value.strip()
    if not raw or len(raw) > 2048:
        raise ValueError("O link está vazio ou é longo demais.")

    uri_match = SPOTIFY_URI_RE.fullmatch(raw)
    if uri_match:
        kind, spotify_id = uri_match.groups()
        return f"https://open.spotify.com/{kind.lower()}/{spotify_id}"

    try:
        parsed = urlsplit(raw)
        hostname = (parsed.hostname or "").lower()
        # Accessing .port also validates malformed port strings.
        port = parsed.port
    except ValueError as exc:
        raise ValueError("O link do Spotify não é válido.") from exc

    allowed_hosts = {"open.spotify.com", "spotify.com", "www.spotify.com"}
    if parsed.scheme.lower() != "https" or hostname not in allowed_hosts:
        raise ValueError("Use um link HTTPS de open.spotify.com.")
    if parsed.username or parsed.password or port is not None:
        raise ValueError("O link do Spotify não pode conter usuário, senha ou porta.")

    match = SPOTIFY_PATH_RE.fullmatch(parsed.path)
    if not match:
        raise ValueError("O link precisa apontar para uma faixa, um álbum ou uma playlist do Spotify.")

    kind, spotify_id = match.groups()
    if not SPOTIFY_ID_RE.fullmatch(spotify_id):
        raise ValueError("O identificador do Spotify não é válido.")

    return f"https://open.spotify.com/{kind.lower()}/{spotify_id}"


def spotdl_prefix() -> list[str] | None:
    """Find spotDL as a CLI executable or as an installed Python module."""
    executable = shutil.which("spotdl")
    if executable:
        return [executable]

    try:
        if importlib.util.find_spec("spotdl") is not None:
            return [sys.executable, "-m", "spotdl"]
    except (ImportError, ModuleNotFoundError, ValueError):
        pass
    return None


def _spotdl_data_dir() -> Path:
    home = Path.home()
    if platform.system() == "Linux":
        xdg_path = home / ".config" / "spotdl"
        legacy_path = home / ".spotdl"
        if xdg_path.exists():
            return xdg_path
        if legacy_path.exists():
            return legacy_path
        return xdg_path
    return home / ".spotdl"


def _helper_installed(name: str) -> bool:
    executable = name + (".exe" if platform.system() == "Windows" else "")
    return bool(shutil.which(name)) or (_spotdl_data_dir() / executable).is_file()


def get_health() -> dict[str, Any]:
    prefix = spotdl_prefix()
    try:
        version = importlib.metadata.version("spotdl") if prefix else None
    except importlib.metadata.PackageNotFoundError:
        version = None

    ffmpeg_ready = _helper_installed("ffmpeg")
    deno_ready = _helper_installed("deno")
    try:
        display_output_dir = str(OUTPUT_DIR.relative_to(BASE_DIR))
    except ValueError:
        display_output_dir = str(OUTPUT_DIR)

    return {
        "spotdl_installed": prefix is not None,
        "spotdl_version": version,
        "ffmpeg_installed": ffmpeg_ready,
        "deno_installed": deno_ready,
        "can_download": prefix is not None and ffmpeg_ready,
        "output_dir": display_output_dir,
    }


def build_download_command(
    spotify_url: str,
    audio_format: str,
    bitrate: str,
    output_dir: Path | str,
) -> list[str]:
    """Build a shell-free spotDL command with embedded metadata and cover art."""
    prefix = spotdl_prefix()
    if prefix is None:
        raise RuntimeError("spotDL não está instalado. Siga as instruções de instalação.")
    if audio_format not in ALLOWED_FORMATS:
        raise ValueError("Formato de áudio não permitido.")
    if bitrate not in ALLOWED_BITRATES:
        raise ValueError("Qualidade de áudio não permitida.")

    output_root = Path(output_dir)
    output_template = str(
        output_root
        / "{artist}"
        / "{album}"
        / "{track-number} - {title}.{output-ext}"
    )
    return prefix + [
        "download",
        spotify_url,
        "--format",
        audio_format,
        "--bitrate",
        bitrate,
        "--output",
        output_template,
        "--overwrite",
        "skip",
        "--simple-tui",
        "--log-level",
        "INFO",
        "--print-errors",
    ]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class DownloadManager:
    """In-memory job queue with one worker to avoid overloading spotDL."""

    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._queue: queue.Queue[str] = queue.Queue(maxsize=MAX_PENDING_JOBS)
        self._worker_thread = threading.Thread(
            target=self._worker, name="spotdl-job-worker", daemon=True
        )
        self._worker_thread.start()

    def _trim_history(self) -> None:
        if len(self._jobs) < MAX_STORED_JOBS:
            return
        terminal = [
            job
            for job in self._jobs.values()
            if job["status"] in {"completed", "failed"}
        ]
        terminal.sort(key=lambda job: job["created_at"])
        for job in terminal[: max(1, len(self._jobs) - MAX_STORED_JOBS + 10)]:
            self._jobs.pop(job["id"], None)

    def _enqueue(self, kind: str, **values: Any) -> dict[str, Any]:
        with self._lock:
            active_count = sum(
                job["status"] in {"queued", "running"}
                for job in self._jobs.values()
            )
            if active_count >= MAX_PENDING_JOBS + 1:
                raise queue.Full
            job_id = uuid.uuid4().hex[:12]
            job: dict[str, Any] = {
                "id": job_id,
                "kind": kind,
                "status": "queued",
                "created_at": _utc_now(),
                "started_at": None,
                "finished_at": None,
                "exit_code": None,
                "logs": ["Adicionado à fila."],
                **values,
            }
            self._trim_history()
            self._jobs[job_id] = job
            try:
                self._queue.put_nowait(job_id)
            except queue.Full:
                self._jobs.pop(job_id, None)
                raise
            return self._public_job(job)

    def enqueue_download(self, spotify_url: str, audio_format: str, bitrate: str) -> dict[str, Any]:
        health = get_health()
        if not health["spotdl_installed"]:
            raise RuntimeError("spotDL não está instalado. Instale as dependências primeiro.")
        if not health["ffmpeg_installed"]:
            raise RuntimeError("O FFmpeg ainda não está pronto. Use “Preparar ferramentas” na configuração.")
        return self._enqueue(
            "download",
            url=spotify_url,
            audio_format=audio_format,
            bitrate=bitrate,
        )

    def enqueue_prepare(self) -> dict[str, Any]:
        if not get_health()["spotdl_installed"]:
            raise RuntimeError("Instale o spotDL primeiro usando as instruções desta página.")
        return self._enqueue("prepare")

    @staticmethod
    def _public_job(job: dict[str, Any]) -> dict[str, Any]:
        return {
            key: value.copy() if key == "logs" else value
            for key, value in job.items()
        }

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            jobs = sorted(
                self._jobs.values(), key=lambda item: item["created_at"], reverse=True
            )
            return [self._public_job(job) for job in jobs]

    def _update(self, job_id: str, **changes: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job.update(changes)

    def _log(self, job_id: str, message: str) -> None:
        clean = ANSI_RE.sub("", message).replace("\r", " ").strip()
        if not clean:
            return
        clean = clean[:600]
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job["logs"].append(clean)
                del job["logs"][:-MAX_LOG_LINES]

    def _run_process(self, job_id: str, command: list[str]) -> int:
        environment = os.environ.copy()
        environment.update({"NO_COLOR": "1", "FORCE_COLOR": "0", "CI": "1"})
        self._log(job_id, "$ " + " ".join(command))
        try:
            process = subprocess.Popen(
                command,
                cwd=BASE_DIR,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=environment,
            )
        except OSError as exc:
            self._log(job_id, f"Não foi possível iniciar spotDL: {exc}")
            return 127

        assert process.stdout is not None
        for line in process.stdout:
            self._log(job_id, line)
        return process.wait()

    def _run_download(self, job: dict[str, Any]) -> int:
        command = build_download_command(
            job["url"], job["audio_format"], job["bitrate"], OUTPUT_DIR
        )
        return self._run_process(job["id"], command)

    def _run_prepare(self, job: dict[str, Any]) -> int:
        prefix = spotdl_prefix()
        if prefix is None:
            self._log(job["id"], "spotDL não foi encontrado. Instale-o antes de preparar as ferramentas.")
            return 127

        steps = [
            ("FFmpeg", "ffmpeg", ["--download-ffmpeg"]),
            ("Deno", "deno", ["--download-deno"]),
        ]
        for label, binary, arguments in steps:
            if _helper_installed(binary):
                self._log(job["id"], f"{label} já está instalado; etapa ignorada.")
                continue
            self._log(job["id"], f"Preparando {label}…")
            return_code = self._run_process(job["id"], prefix + arguments)
            if return_code != 0:
                self._log(job["id"], f"A preparação de {label} falhou (código {return_code}).")
                return return_code
        return 0

    def _worker(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                with self._lock:
                    job = self._jobs.get(job_id)
                    if job is None:
                        continue
                    job["status"] = "running"
                    job["started_at"] = _utc_now()
                    job["logs"].append("Processo iniciado.")
                    job_copy = self._public_job(job)

                try:
                    if job_copy["kind"] == "prepare":
                        return_code = self._run_prepare(job_copy)
                    else:
                        return_code = self._run_download(job_copy)
                except (OSError, RuntimeError, ValueError) as exc:
                    self._log(job_id, str(exc))
                    return_code = 1
                except Exception as exc:  # Keep one failed job from stopping the worker.
                    self._log(job_id, f"Erro inesperado: {exc}")
                    return_code = 1

                status = "completed" if return_code == 0 else "failed"
                self._update(
                    job_id,
                    status=status,
                    exit_code=return_code,
                    finished_at=_utc_now(),
                )
                self._log(
                    job_id,
                    "Concluído com sucesso." if return_code == 0 else f"Falha ao executar (código {return_code}).",
                )
            finally:
                self._queue.task_done()


MANAGER = DownloadManager()


class PanelHandler(BaseHTTPRequestHandler):
    server_version = "SpotDLPanel/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep the terminal useful without exposing request headers or credentials.
        super().log_message(format, *args)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_error_json(self, message: str, status: int) -> None:
        self._send_json({"error": message}, status)

    def _same_origin_post(self) -> bool:
        origin = self.headers.get("Origin")
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host")
        if not origin or not host:
            return False
        host = host.split(",", 1)[0].strip()
        try:
            parsed_origin = urlsplit(origin)
        except ValueError:
            return False
        return (
            parsed_origin.scheme in {"http", "https"}
            and parsed_origin.netloc.lower() == host.lower()
        )

    def _read_json_body(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ValueError("A solicitação precisa usar JSON.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Tamanho da solicitação inválido.") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise OverflowError
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("O corpo da solicitação não contém JSON válido.") from exc
        if not isinstance(data, dict):
            raise ValueError("O corpo da solicitação precisa ser um objeto JSON.")
        return data

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        path = urlsplit(self.path).path
        if path == "/api/health":
            self._send_json(get_health())
            return
        if path == "/api/jobs":
            self._send_json({"jobs": MANAGER.snapshot()})
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if not self._same_origin_post():
            self._send_error_json("Origem da solicitação não permitida.", 403)
            return

        path = urlsplit(self.path).path
        if path not in {"/api/download", "/api/prepare"}:
            self._send_error_json("Rota não encontrada.", 404)
            return

        try:
            data = self._read_json_body()
        except OverflowError:
            self._send_error_json("A solicitação excede o tamanho permitido.", 413)
            return
        except ValueError as exc:
            self._send_error_json(str(exc), 400)
            return

        try:
            if path == "/api/download":
                spotify_url = normalize_spotify_url(data.get("url"))
                audio_format = data.get("format", "mp3")
                bitrate = data.get("bitrate", "auto")
                if not isinstance(audio_format, str) or audio_format not in ALLOWED_FORMATS:
                    raise ValueError("Escolha um formato de áudio válido.")
                if not isinstance(bitrate, str) or bitrate not in ALLOWED_BITRATES:
                    raise ValueError("Escolha uma qualidade de áudio válida.")
                job = MANAGER.enqueue_download(spotify_url, audio_format, bitrate)
            else:
                job = MANAGER.enqueue_prepare()
        except queue.Full:
            self._send_error_json("A fila está cheia. Aguarde um pouco e tente novamente.", 429)
            return
        except ValueError as exc:
            self._send_error_json(str(exc), 400)
            return
        except RuntimeError as exc:
            self._send_error_json(str(exc), 503)
            return

        self._send_json({"job": job}, 202)

    def _serve_static(self, request_path: str) -> None:
        try:
            decoded = unquote(request_path)
            if decoded in {"", "/"}:
                decoded = "/index.html"
            relative_path = Path(decoded.lstrip("/"))
            if any(part in {".", ".."} for part in relative_path.parts):
                raise ValueError("invalid path")
            target = (WEB_DIR / relative_path).resolve()
            if not target.is_relative_to(WEB_DIR.resolve()) or not target.is_file():
                self._send_error_json("Arquivo não encontrado.", 404)
                return
        except (OSError, ValueError):
            self._send_error_json("Arquivo não encontrado.", 404)
            return

        content_type, _ = mimetypes.guess_type(str(target))
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; "
            "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'",
        )
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Painel local para spotDL")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), PanelHandler)
    server.daemon_threads = True
    print(f"Painel disponível em http://{args.host}:{args.port}")
    print(f"Downloads serão salvos em: {OUTPUT_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando painel…")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
