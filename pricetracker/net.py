"""HTTP access for the collectors: registry check, robots.txt and a pause per host."""
import time
import urllib.error
import urllib.request
import urllib.robotparser
from urllib.parse import urlsplit

from .registry import Refused

USER_AGENT = "supplier-price-tracker/0.1"


def origin(url):
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


class Client:
    def __init__(self, registry, user_agent=USER_AGENT, delay=1.0, timeout=60):
        self.registry = registry
        self.user_agent = user_agent
        self.delay = delay
        self.timeout = timeout
        self._robots = {}
        self._last_request = {}

    def get(self, url, source_id):
        self.registry.require(source_id, url)
        robots = self.robots(url)
        if not robots.can_fetch(self.user_agent, url):
            raise Refused(f"robots.txt of {origin(url)} does not allow {urlsplit(url).path}")
        self._pause(url, robots.crawl_delay(self.user_agent))
        status, final_url, body = self._fetch(url)
        if final_url != url:
            self.registry.require(source_id, final_url)  # a redirect must stay on the source's hosts
        if status != 200:
            raise OSError(f"GET {url} returned HTTP {status}")
        return body

    def robots(self, url):
        key = origin(url)
        if key not in self._robots:
            self._robots[key] = self._read_robots(key)
        return self._robots[key]

    def _read_robots(self, base):
        parser = urllib.robotparser.RobotFileParser(base + "/robots.txt")
        try:
            status, _, body = self._fetch(base + "/robots.txt")
        except OSError:
            status, body = None, b""
        if status == 200:
            parser.parse(body.decode("utf-8", "replace").splitlines())
        elif status is None or status >= 500 or status in (401, 403):
            # Server down or robots.txt forbidden: stay out. Stricter than RFC 9309 on 401/403.
            parser.disallow_all = True
        else:
            parser.allow_all = True  # no robots.txt
        return parser

    def _pause(self, url, crawl_delay):
        host = urlsplit(url).netloc
        gap = max(self.delay, crawl_delay or 0)
        last = self._last_request.get(host)
        if last is not None:
            wait = last + gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        self._last_request[host] = time.monotonic()

    def _fetch(self, url):
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, response.geturl(), response.read()
        except urllib.error.HTTPError as err:
            with err:
                return err.code, url, err.read()
