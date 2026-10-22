import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class SpotifyUrlValidationTests(unittest.TestCase):
    def test_canonicalizes_track_and_removes_tracking_query(self):
        spotify_id = "AbCdEfGhIjKlMnOpQrStUv"
        result = server.normalize_spotify_url(
            f"https://open.spotify.com/intl-pt-br/track/{spotify_id}?si=tracking#fragment"
        )
        self.assertEqual(result, f"https://open.spotify.com/track/{spotify_id}")

    def test_accepts_album_and_playlist(self):
        spotify_id = "1234567890abcdefghij12"
        for kind in ("album", "playlist"):
            with self.subTest(kind=kind):
                self.assertEqual(
                    server.normalize_spotify_url(f"https://open.spotify.com/{kind}/{spotify_id}"),
                    f"https://open.spotify.com/{kind}/{spotify_id}",
                )

    def test_accepts_spotify_uri(self):
        spotify_id = "1234567890abcdefghij12"
        self.assertEqual(
            server.normalize_spotify_url(f"spotify:playlist:{spotify_id}"),
            f"https://open.spotify.com/playlist/{spotify_id}",
        )

    def test_rejects_non_spotify_hosts(self):
        with self.assertRaises(ValueError):
            server.normalize_spotify_url("https://open.spotify.com.evil.example/track/1234567890")

    def test_rejects_youtube_and_unrecognized_spotify_pages(self):
        for url in (
            "https://www.youtube.com/watch?v=1234567890",
            "https://open.spotify.com/artist/1234567890abcdefghij12",
            "http://open.spotify.com/track/1234567890abcdefghij12",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                server.normalize_spotify_url(url)

    def test_rejects_malformed_uri_and_oversized_input(self):
        with self.assertRaises(ValueError):
            server.normalize_spotify_url("spotify:track:not-an-id")
        with self.assertRaises(ValueError):
            server.normalize_spotify_url("x" * 2049)


class SpotdlCommandTests(unittest.TestCase):
    def test_builds_shell_free_command_with_metadata_output_template(self):
        prefix = ["/usr/bin/spotdl"]
        with patch.object(server, "spotdl_prefix", return_value=prefix):
            command = server.build_download_command(
                "https://open.spotify.com/track/1234567890abcdefghij12",
                "mp3",
                "320k",
                Path("/music"),
            )
        self.assertEqual(command[0], "/usr/bin/spotdl")
        self.assertEqual(command[1:3], ["download", "https://open.spotify.com/track/1234567890abcdefghij12"])
        self.assertIn("--format", command)
        self.assertIn("--output", command)
        output_template = command[command.index("--output") + 1]
        self.assertEqual(
            output_template,
            "/music/{artist}/{album}/{track-number} - {title}.{output-ext}",
        )
        self.assertIn("--overwrite", command)
        self.assertNotIn("shell", command)

    def test_rejects_unlisted_format_and_quality(self):
        with patch.object(server, "spotdl_prefix", return_value=["spotdl"]):
            with self.assertRaises(ValueError):
                server.build_download_command("https://open.spotify.com/track/1234567890", "exe", "auto", Path("downloads"))
            with self.assertRaises(ValueError):
                server.build_download_command("https://open.spotify.com/track/1234567890", "mp3", "999k", Path("downloads"))

    def test_reports_missing_spotdl(self):
        with patch.object(server, "spotdl_prefix", return_value=None):
            with self.assertRaises(RuntimeError):
                server.build_download_command("https://open.spotify.com/track/1234567890", "mp3", "auto", Path("downloads"))


class LibraryTests(unittest.TestCase):
    def test_lists_audio_files_with_artist_album_and_title_fallbacks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / "Artista" / "Álbum" / "03 - Minha Música.mp3"
            audio.parent.mkdir(parents=True)
            audio.write_bytes(b"test audio data")
            (audio.parent / "not-a-song.txt").write_text("ignore me", encoding="utf-8")

            with patch.object(server, "OUTPUT_DIR", root):
                items, total, truncated = server.list_library()

            self.assertEqual(total, 1)
            self.assertFalse(truncated)
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["title"], "Minha Música")
            self.assertEqual(items[0]["artist"], "Artista")
            self.assertEqual(items[0]["album"], "Álbum")
            self.assertFalse(items[0]["artwork"])

    def test_uses_cover_file_from_album_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / "artist" / "album" / "song.mp3"
            audio.parent.mkdir(parents=True)
            audio.write_bytes(b"test audio data")
            cover_bytes = bytes([137]) + b"PNG" + bytes([13, 10, 26, 10]) + b"cover data"
            (audio.parent / "cover.png").write_bytes(cover_bytes)

            with patch.object(server, "OUTPUT_DIR", root):
                items, _total, _truncated = server.list_library()
                artwork = server.extract_artwork(audio)

            self.assertTrue(items[0]["artwork"])
            self.assertEqual(artwork, (cover_bytes, "image/png"))

    def test_library_file_lookup_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / "artist" / "album" / "song.mp3"
            audio.parent.mkdir(parents=True)
            audio.write_bytes(b"test audio data")
            with patch.object(server, "OUTPUT_DIR", root):
                self.assertEqual(server.safe_library_file("artist/album/song.mp3"), audio.resolve())
                self.assertIsNone(server.safe_library_file("../outside.mp3"))
                self.assertIsNone(server.safe_library_file("artist/album/song.txt"))

    def test_persists_destination_path_from_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            settings_file = root / ".sonora-settings.json"
            with (
                patch.object(server, "BASE_DIR", root),
                patch.object(server, "SETTINGS_PATH", settings_file),
                patch.object(server, "OUTPUT_DIR", root / "old"),
                patch.dict(os.environ, {"SPOTDL_OUTPUT_DIR": ""}),
            ):
                result = server.update_output_dir("Music/Spotify")
                self.assertEqual(result, "Music/Spotify")
                self.assertTrue((root / "Music" / "Spotify").is_dir())
                self.assertEqual(
                    json.loads(settings_file.read_text(encoding="utf-8"))["output_dir"],
                    str(root / "Music" / "Spotify"),
                )
                self.assertEqual(server.configured_output_dir(), root / "Music" / "Spotify")

    def test_environment_destination_is_locked(self):
        with patch.dict(os.environ, {"SPOTDL_OUTPUT_DIR": "C:\\Music"}):
            with self.assertRaises(RuntimeError):
                server.update_output_dir("D:\\Other")


if __name__ == "__main__":
    unittest.main()
