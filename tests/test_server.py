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


if __name__ == "__main__":
    unittest.main()
