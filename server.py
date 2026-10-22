"""Small, local web panel that queues Spotify URLs through spotDL.

The browser only submits Spotify links. The backend validates those links and
runs spotDL with an argument list (never through a shell) into a configured
music folder.
"""

from __future__ import annotations

import base64
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
from urllib.parse import parse_qs, unquote, urlsplit

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
SETTINGS_PATH = BASE_DIR / ".sonora-settings.json"
ALLOWED_FORMATS = {"mp3", "m4a", "flac", "ogg", "opus", "wav"}
ALLOWED_BITRATES = {"auto", "128k", "192k", "320k"}
AUDIO_SUFFIXES = {".mp3", ".m4a", ".flac", ".ogg", ".opus", ".wav", ".aac", ".aiff"}
MAX_BODY_BYTES = 8 * 1024
MAX_PENDING_JOBS = 30
MAX_STORED_JOBS = 100
MAX_LOG_LINES = 100
MAX_LIBRARY_ITEMS = 200
MAX_LIBRARY_SCAN = 5000
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


def _resolve_output_dir(value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = BASE_DIR / path
    return path.resolve()


def configured_output_dir() -> Path:
    """Use env configuration, saved panel settings, or ./downloads in that order."""
    environment_value = os.environ.get("SPOTDL_OUTPUT_DIR", "").strip()
    if environment_value:
        return _resolve_output_dir(environment_value)

    try:
        saved = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        saved_value = saved.get("output_dir") if isinstance(saved, dict) else None
        if isinstance(saved_value, str) and saved_value.strip():
            return _resolve_output_dir(saved_value)
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return _resolve_output_dir("downloads")


def display_output_dir(path: Path | None = None) -> str:
    target = (path or OUTPUT_DIR).resolve()
    try:
        return str(target.relative_to(BASE_DIR))
    except ValueError:
        return str(target)


def update_output_dir(value: Any) -> str:
    """Persist a destination selected in the panel and make it active immediately."""
    global OUTPUT_DIR
    if os.environ.get("SPOTDL_OUTPUT_DIR", "").strip():
        raise RuntimeError("O destino está fixado pela variável SPOTDL_OUTPUT_DIR.")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Informe o caminho da pasta de destino.")
    if len(value) > 2048:
        raise ValueError("O caminho informado é longo demais.")

    try:
        target = _resolve_output_dir(value.strip())
        if target == Path(target.anchor):
            raise ValueError("Escolha uma pasta dentro do disco, não a raiz do sistema.")
        target.mkdir(parents=True, exist_ok=True)
        if not target.is_dir() or not os.access(target, os.W_OK):
            raise ValueError("A pasta não existe ou não permite gravação.")
        temp_path = SETTINGS_PATH.with_name(SETTINGS_PATH.name + ".tmp")
        temp_path.write_text(
            json.dumps({"output_dir": str(target)}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(SETTINGS_PATH)
    except OSError as exc:
        raise ValueError(f"Não foi possível usar essa pasta: {exc}") from exc

    OUTPUT_DIR = target
    return display_output_dir(target)


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
    python_supported = (3, 10) <= sys.version_info[:2] < (3, 15)
    setup_command = (
        "powershell -ExecutionPolicy Bypass -File .\\setup.ps1"
        if platform.system() == "Windows"
        else "bash setup.sh"
    )
    return {
        "spotdl_installed": prefix is not None,
        "spotdl_version": version,
        "python_version": platform.python_version(),
        "python_supported": python_supported,
        "setup_command": setup_command,
        "ffmpeg_installed": ffmpeg_ready,
        "deno_installed": deno_ready,
        "can_download": prefix is not None and ffmpeg_ready and python_supported,
        "output_dir": display_output_dir(OUTPUT_DIR),
        "output_dir_locked": bool(os.environ.get("SPOTDL_OUTPUT_DIR", "").strip()),
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
        if not health["python_supported"]:
            raise RuntimeError(
                f"Python {health['python_version']} não é compatível com spotDL 4.5.2. Use Python 3.14 ou 3.13."
            )
        if not health["spotdl_installed"]:
            raise RuntimeError("spotDL não está instalado. Instale as dependências primeiro.")
        if not health["ffmpeg_installed"]:
            raise RuntimeError("O FFmpeg ainda não está pronto. Use “Preparar ferramentas” na configuração.")
        return self._enqueue(
            "download",
            url=spotify_url,
            audio_format=audio_format,
            bitrate=bitrate,
            download_dir=str(OUTPUT_DIR),
        )

    def enqueue_prepare(self) -> dict[str, Any]:
        health = get_health()
        if not health["python_supported"]:
            raise RuntimeError(
                f"Python {health['python_version']} não é compatível com spotDL 4.5.2. Use Python 3.14 ou 3.13."
            )
        if not health["spotdl_installed"]:
            raise RuntimeError("Instale o spotDL primeiro usando as instruções desta página.")
        return self._enqueue("prepare")

    @staticmethod
    def _public_job(job: dict[str, Any], include_private: bool = False) -> dict[str, Any]:
        return {
            key: value.copy() if key == "logs" else value
            for key, value in job.items()
            if include_private or key != "download_dir"
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
            job["url"], job["audio_format"], job["bitrate"], Path(job.get("download_dir", OUTPUT_DIR))
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
                    job_copy = self._public_job(job, include_private=True)

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


def _first_tag_text(tags: Any, *keys: str) -> str | None:
    if not tags:
        return None
    for key in keys:
        try:
            value = tags.get(key)
        except (AttributeError, TypeError):
            value = None
        if isinstance(value, (list, tuple)):
            value = next((item for item in value if item), None)
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="replace")
        if value is not None:
            text = str(value).strip()
            if text:
                return text
    return None


def _image_mime(data: bytes, preferred: str | None = None) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if preferred and preferred.lower().startswith("image/"):
        return preferred.lower()
    return "image/jpeg"


def extract_artwork(path: Path) -> tuple[bytes, str] | None:
    """Read embedded album art from common Mutagen formats, with folder-art fallback."""
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(str(path), easy=False)
        tags = getattr(audio, "tags", None) if audio is not None else None
        pictures = getattr(audio, "pictures", None) if audio is not None else None
        if pictures:
            picture = pictures[0]
            data = getattr(picture, "data", None)
            if data:
                return bytes(data), _image_mime(bytes(data), getattr(picture, "mime", None))

        if tags is not None:
            if hasattr(tags, "getall"):
                for picture in tags.getall("APIC"):
                    data = getattr(picture, "data", None)
                    if data:
                        return bytes(data), _image_mime(bytes(data), getattr(picture, "mime", None))

            covers = tags.get("covr")
            if covers:
                cover = covers[0]
                data = bytes(cover)
                return data, _image_mime(data)

            encoded_pictures = tags.get("metadata_block_picture")
            if encoded_pictures:
                from mutagen.flac import Picture

                encoded = encoded_pictures[0]
                if isinstance(encoded, str):
                    picture = Picture(base64.b64decode(encoded))
                    data = bytes(picture.data)
                    return data, _image_mime(data, picture.mime)

            legacy_covers = tags.get("coverart")
            if legacy_covers:
                encoded = legacy_covers[0]
                if isinstance(encoded, str):
                    data = base64.b64decode(encoded)
                    mime_values = tags.get("coverartmime") or []
                    preferred = mime_values[0] if mime_values else None
                    return data, _image_mime(data, preferred)
    except Exception:
        # A damaged tag block should not make the entire library unavailable.
        pass

    for filename in ("cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png"):
        candidate = path.parent / filename
        try:
            if candidate.is_file() and candidate.stat().st_size <= 12 * 1024 * 1024:
                data = candidate.read_bytes()
                return data, _image_mime(data, mimetypes.guess_type(str(candidate))[0])
        except OSError:
            continue
    return None


def _fallback_title(path: Path) -> str:
    return re.sub(r"^\d{1,3}\s*[-_.]\s*", "", path.stem).strip() or path.stem


def _library_metadata(path: Path, root: Path, stat_result: os.stat_result) -> dict[str, Any]:
    relative = path.relative_to(root)
    parts = relative.parts
    fallback_artist = parts[0] if len(parts) > 1 else "Artista desconhecido"
    fallback_album = parts[1] if len(parts) > 2 else "Álbum desconhecido"
    title = _fallback_title(path)
    artist = fallback_artist
    album = fallback_album
    year = ""

    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(str(path), easy=True)
        tags = getattr(audio, "tags", None) if audio is not None else None
        title = _first_tag_text(tags, "title") or title
        artist = _first_tag_text(tags, "artist", "albumartist") or artist
        album = _first_tag_text(tags, "album") or album
        year = _first_tag_text(tags, "date", "originaldate", "year") or ""
    except Exception:
        # Mutagen may reject a damaged tag block; path-based fallbacks still work.
        pass

    return {
        "path": relative.as_posix(),
        "title": title,
        "artist": artist,
        "album": album,
        "year": year[:4],
        "format": path.suffix.lstrip(".").upper(),
        "size_bytes": stat_result.st_size,
        "modified_at": datetime.fromtimestamp(stat_result.st_mtime, timezone.utc).isoformat(timespec="seconds"),
        "artwork": extract_artwork(path) is not None,
    }


def list_library() -> tuple[list[dict[str, Any]], int, bool]:
    """Return the newest audio files in the configured folder, with their tags."""
    root = OUTPUT_DIR.resolve()
    if not root.is_dir():
        return [], 0, False

    candidates: list[tuple[float, Path, os.stat_result]] = []
    scanned = 0
    truncated = False
    for current, directories, filenames in os.walk(root, onerror=lambda _error: None):
        directories[:] = [name for name in directories if not name.startswith(".")]
        for filename in filenames:
            path = Path(current) / filename
            if path.suffix.lower() not in AUDIO_SUFFIXES or filename.startswith("."):
                continue
            try:
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(root) or not resolved.is_file():
                    continue
                stat_result = resolved.stat()
            except (OSError, RuntimeError):
                continue
            candidates.append((stat_result.st_mtime, resolved, stat_result))
            scanned += 1
            if scanned >= MAX_LIBRARY_SCAN:
                truncated = True
                break
        if truncated:
            break

    candidates.sort(key=lambda item: item[0], reverse=True)
    items = [
        _library_metadata(path, root, stat_result)
        for _modified, path, stat_result in candidates[:MAX_LIBRARY_ITEMS]
    ]
    return items, scanned, truncated


def safe_library_file(relative_path: Any) -> Path | None:
    if not isinstance(relative_path, str) or not relative_path or len(relative_path) > 4096:
        return None
    relative = Path(relative_path)
    if relative.is_absolute() or any(part in {".", ".."} for part in relative.parts):
        return None
    try:
        root = OUTPUT_DIR.resolve()
        target = (root / relative).resolve(strict=True)
        if not target.is_relative_to(root) or not target.is_file():
            return None
        if target.suffix.lower() not in AUDIO_SUFFIXES:
            return None
        return target
    except (OSError, RuntimeError, ValueError):
        return None


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
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/api/health":
            self._send_json(get_health())
            return
        if path == "/api/jobs":
            self._send_json({"jobs": MANAGER.snapshot()})
            return
        if path == "/api/library":
            items, total, truncated = list_library()
            self._send_json({
                "items": items,
                "total": total,
                "truncated": truncated,
                "output_dir": display_output_dir(OUTPUT_DIR),
            })
            return
        if path == "/api/artwork":
            self._serve_artwork(parsed.query)
            return
        self._serve_static(path)

    def _serve_artwork(self, query_string: str) -> None:
        query = parse_qs(query_string, keep_blank_values=True)
        target = safe_library_file(query.get("path", [""])[0])
        if target is None:
            self._send_error_json("Arquivo de áudio não encontrado.", 404)
            return
        artwork = extract_artwork(target)
        if artwork is None:
            self._send_error_json("Este arquivo não tem capa incorporada.", 404)
            return
        data, content_type = artwork
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if not self._same_origin_post():
            self._send_error_json("Origem da solicitação não permitida.", 403)
            return

        path = urlsplit(self.path).path
        if path not in {"/api/download", "/api/prepare", "/api/settings"}:
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
            elif path == "/api/prepare":
                job = MANAGER.enqueue_prepare()
            else:
                output_dir = update_output_dir(data.get("output_dir"))
                self._send_json({
                    "output_dir": output_dir,
                    "output_dir_locked": False,
                })
                return
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
