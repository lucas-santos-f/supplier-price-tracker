"""Registry of the data sources the tracker may use (sources.json)."""
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / "sources.json"


class Refused(Exception):
    """A request was blocked by the registry or by robots.txt."""


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    kind: str
    status: str
    hosts: tuple
    landing_page: str
    license: str = ""
    license_url: str = ""
    attribution: str = ""
    checked: str = ""
    notes: str = ""

    @property
    def approved(self):
        return self.status == "approved"


class Registry:
    def __init__(self, sources):
        self._sources = {source.id: source for source in sources}

    @classmethod
    def load(cls, path=SOURCES_FILE):
        with open(path, encoding="utf-8") as fh:
            entries = json.load(fh)["sources"]
        return cls(Source(**{**entry, "hosts": tuple(entry["hosts"])}) for entry in entries)

    def __iter__(self):
        return iter(self._sources.values())

    def get(self, source_id):
        return self._sources.get(source_id)

    def require(self, source_id, url):
        """Return the source if `url` may be requested on its behalf, else raise Refused."""
        source = self._sources.get(source_id)
        if source is None:
            raise Refused(f"unknown source {source_id!r}")
        if not source.approved:
            raise Refused(f"source {source_id!r} is {source.status}: {source.notes}")
        host = urlsplit(url).hostname
        if host not in source.hosts:
            raise Refused(f"{host} is not a host of source {source_id!r}")
        return source
