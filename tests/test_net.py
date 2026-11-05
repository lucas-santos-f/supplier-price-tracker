import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pricetracker.net import Client
from pricetracker.registry import Refused, Registry, Source


def make_handler(robots_status, robots_body):
    class Handler(BaseHTTPRequestHandler):
        requests = []

        def do_GET(self):
            Handler.requests.append(self.path)
            if self.path == "/robots.txt":
                self._send(robots_status, robots_body)
            elif self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", f"http://localhost:{self.server.server_port}/public/data.json")
                self.end_headers()
            elif self.path.startswith(("/public/", "/private/")):
                self._send(200, b'{"ok": true}')
            else:
                self._send(404, b"not found")

        def _send(self, status, body):
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


class ServerCase(unittest.TestCase):
    robots_status = 200
    robots_body = b"User-agent: *\nDisallow: /private/\n"

    def setUp(self):
        self.handler = make_handler(self.robots_status, self.robots_body)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        registry = Registry([
            Source(id="local", name="Local test", kind="test", status="approved", hosts=("127.0.0.1",), landing_page=self.base),
            Source(id="blocked", name="Blocked", kind="test", status="rejected", hosts=("127.0.0.1",), landing_page=self.base,
                   notes="terms forbid automated access"),
        ])
        self.client = Client(registry, delay=0)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()


class RobotsAllowListTest(ServerCase):
    def test_allowed_path_is_fetched(self):
        self.assertEqual(self.client.get(self.base + "/public/data.json", "local"), b'{"ok": true}')

    def test_disallowed_path_is_refused_without_requesting_it(self):
        with self.assertRaisesRegex(Refused, "robots.txt"):
            self.client.get(self.base + "/private/data.json", "local")
        self.assertNotIn("/private/data.json", self.handler.requests)

    def test_rejected_source_makes_no_request(self):
        with self.assertRaisesRegex(Refused, "rejected"):
            self.client.get(self.base + "/public/data.json", "blocked")
        self.assertEqual(self.handler.requests, [])

    def test_unknown_source_and_foreign_host_are_refused(self):
        with self.assertRaises(Refused):
            self.client.get(self.base + "/public/data.json", "nope")
        with self.assertRaisesRegex(Refused, "not a host"):
            self.client.get("http://example.com/data.json", "local")

    def test_redirect_to_another_host_is_refused(self):
        with self.assertRaisesRegex(Refused, "localhost is not a host"):
            self.client.get(self.base + "/redirect", "local")

    def test_robots_is_read_once_per_origin(self):
        self.client.get(self.base + "/public/a", "local")
        self.client.get(self.base + "/public/b", "local")
        self.assertEqual(self.handler.requests.count("/robots.txt"), 1)


class MissingRobotsTest(ServerCase):
    robots_status = 404
    robots_body = b"not found"

    def test_everything_allowed(self):
        self.assertEqual(self.client.get(self.base + "/private/data.json", "local"), b'{"ok": true}')


class ForbiddenRobotsTest(ServerCase):
    robots_status = 403
    robots_body = b"forbidden"

    def test_nothing_allowed(self):
        with self.assertRaises(Refused):
            self.client.get(self.base + "/public/data.json", "local")


class ServerErrorRobotsTest(ServerCase):
    robots_status = 503
    robots_body = b"down"

    def test_nothing_allowed(self):
        with self.assertRaises(Refused):
            self.client.get(self.base + "/public/data.json", "local")


class RegistryFileTest(unittest.TestCase):
    def test_shipped_registry(self):
        registry = Registry.load()
        approved = {s.id for s in registry if s.approved}
        self.assertEqual(approved, {"worldbank-pinksheet", "bcb-sgs"})
        for source in registry:
            if source.approved:
                self.assertTrue(source.license and source.attribution and source.checked, source.id)


if __name__ == "__main__":
    unittest.main()
