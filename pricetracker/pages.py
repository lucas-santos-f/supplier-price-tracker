"""Reads supplier prices from the product pages listed in supplier-pages.json.

A browser page cannot read other sites, so this runs on its own (by hand or on a schedule) and writes
page-prices.json, which the page loads. The price comes from the structured data stores publish for search
engines: schema.org Product/Offer in JSON-LD or microdata, or product:price meta tags. Nothing else on the
page is parsed. robots.txt is read before each site, requests to one host are spaced out, and sites whose
terms do not allow automated reading are skipped.
"""
import json
import os
import re
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from .net import Client, origin
from .registry import Refused

AGENT = "SupplyPulse-PriceReader/1.0"
MAX_BYTES = 3_000_000
KEEP_DAYS = 730

# Sites whose terms rule out this kind of reading. Checked 2026-11-06.
NOT_ALLOWED = [
    (re.compile(r"(^|\.)api\.mercadolibre\.com$"),
     "Mercado Livre's API needs your own registered app, and its terms limit it to uses that support the "
     "marketplace and ask for written permission for price statistics; ask them before using it here"),
    (re.compile(r"(^|\.)mercadoli(vre|bre)\.com(\.[a-z]{2})?$"),
     "Mercado Livre's developer terms do not allow robots or scraping of the site (item 7.6)"),
    (re.compile(r"(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$"),
     "Amazon's conditions of use do not allow robots or data gathering tools"),
]


def terms_block(host):
    host = (host or "").lower()
    for pattern, reason in NOT_ALLOWED:
        if pattern.search(host):
            return reason
    return None


class Reader(Client):
    """Client for pages the user listed: no source registry, but robots.txt, the terms list above,
    a pause between requests to the same host and a size limit."""

    def __init__(self, user_agent=AGENT, delay=5.0, timeout=30):
        super().__init__(registry=None, user_agent=user_agent, delay=delay, timeout=timeout)
        reader = self

        class CheckedRedirect(urllib.request.HTTPRedirectHandler):
            # a redirect target gets the same checks before it is requested
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                if not newurl.endswith("/robots.txt"):
                    reader.check(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        self._opener = urllib.request.build_opener(CheckedRedirect)

    def check(self, url):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"not a web address: {url}")
        reason = terms_block(parts.hostname)
        if reason:
            raise Refused(reason)
        robots = self.robots(url)
        if not robots.can_fetch(self.user_agent, url):
            raise Refused(f"robots.txt of {origin(url)} does not allow {parts.path or '/'}")
        return robots

    def get(self, url, headers=None):
        robots = self.check(url)
        self._pause(url, robots.crawl_delay(self.user_agent))
        status, _, body = self._fetch(url, headers)
        if status != 200:
            raise OSError(f"HTTP {status}")
        return body

    def _fetch(self, url, headers=None):
        request = urllib.request.Request(url, headers={"User-Agent": self.user_agent, **(headers or {})})
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise OSError("page larger than 3 MB, not read")
                return response.status, response.geturl(), body
        except urllib.error.HTTPError as err:
            with err:
                return err.code, url, err.read(MAX_BYTES)


# ---------------------------------------------------------------- reading the price

PRODUCT_KINDS = {"Product", "ProductGroup", "IndividualProduct", "ProductModel"}
OFFER_KINDS = {"Offer", "AggregateOffer"}
SKIP_KEYS = {"review", "aggregateRating", "isRelatedTo", "isSimilarTo", "isAccessoryOrSparePartFor", "brand", "manufacturer"}
META_PRICE = ("product:price:amount", "og:price:amount", "price")
META_CURRENCY = ("product:price:currency", "og:price:currency", "pricecurrency")


class _Collector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ld, self.meta, self.micro = [], {}, {}
        self._ld_buf = None
        self._text_for = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "script" and a.get("type", "").strip().lower() == "application/ld+json":
            self._ld_buf = []
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").strip().lower()
            if key and a.get("content"):
                self.meta.setdefault(key, a["content"].strip())
        prop = a.get("itemprop", "").strip().lower()
        if prop in ("price", "lowprice", "pricecurrency", "availability"):
            value = a.get("content") or (a.get("href") if prop == "availability" else "")
            if value:
                self.micro.setdefault(prop, value.strip())
            elif tag != "meta":
                self._text_for = prop

    def handle_endtag(self, tag):
        if tag == "script" and self._ld_buf is not None:
            self.ld.append("".join(self._ld_buf))
            self._ld_buf = None

    def handle_data(self, data):
        if self._ld_buf is not None:
            self._ld_buf.append(data)
        elif self._text_for and data.strip():
            self.micro.setdefault(self._text_for, data.strip())
            self._text_for = None


def parse_number(value):
    """109.9, "109.90", "R$ 1.234,56", "1,234.56", "104,50" -> float; None when there is no number."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = re.sub(r"[^\d.,-]", "", str(value))
    if not re.search(r"\d", s):
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", "") if re.fullmatch(r"-?\d{1,3}(,\d{3})+", s) else s.replace(",", ".")
    elif re.fullmatch(r"-?\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def _kinds(node):
    t = node.get("@type")
    return {str(x).rsplit("/", 1)[-1] for x in (t if isinstance(t, list) else [t]) if x}


def _ld_offers(node, inside=False):
    found = []
    if isinstance(node, list):
        for n in node:
            found += _ld_offers(n, inside)
    elif isinstance(node, dict):
        kinds = _kinds(node)
        here = inside or bool(kinds & PRODUCT_KINDS) or "itemOffered" in node
        priced = kinds & OFFER_KINDS or any(k in node for k in ("price", "lowPrice", "priceSpecification"))
        if here and priced and not kinds & PRODUCT_KINDS:
            found.append(node)
        for key, value in node.items():
            if key not in SKIP_KEYS and isinstance(value, (dict, list)):
                found += _ld_offers(value, here)
    return found


def _offer_price(offer):
    spec = offer.get("priceSpecification")
    spec = spec[0] if isinstance(spec, list) and spec else spec if isinstance(spec, dict) else {}
    price = parse_number(offer.get("price"))
    if price is None:
        price = parse_number(offer.get("lowPrice"))
    if price is None:
        price = parse_number(spec.get("price"))
    currency = offer.get("priceCurrency") or spec.get("priceCurrency")
    availability = str(offer.get("availability") or "").rsplit("/", 1)[-1]
    return price, currency, availability


def read_price(html):
    """{"price", "currency", "method", "availability"} from a product page, or None."""
    c = _Collector()
    c.feed(html)
    c.close()
    offers = []
    for text in c.ld:
        try:
            data = json.loads(text)
        except ValueError:
            continue
        for offer in _ld_offers(data):
            price, currency, availability = _offer_price(offer)
            if price is not None and price > 0:
                offers.append((price, currency, availability))
    if offers:
        in_stock = [o for o in offers if o[2] not in ("OutOfStock", "Discontinued", "SoldOut")]
        price, currency, availability = min(in_stock or offers, key=lambda o: o[0])
        return {"price": price, "currency": currency, "method": "json-ld", "availability": availability or None}
    price = parse_number(c.micro.get("price") or c.micro.get("lowprice"))
    if price:
        return {"price": price, "currency": c.micro.get("pricecurrency"), "method": "microdata",
                "availability": (c.micro.get("availability") or "").rsplit("/", 1)[-1] or None}
    for key in META_PRICE:
        price = parse_number(c.meta.get(key))
        if price:
            currency = next((c.meta[k] for k in META_CURRENCY if c.meta.get(k)), None)
            return {"price": price, "currency": currency, "method": "meta tag", "availability": None}
    return None


def path_get(obj, path):
    for key in [k for k in str(path or "").split(".") if k]:
        if isinstance(obj, list):
            obj = obj[int(key)] if key.isdigit() and int(key) < len(obj) else None
        elif isinstance(obj, dict):
            obj = obj.get(key)
        else:
            return None
    return obj


def read_api(reader, link, env):
    headers = {"Accept": "application/json"}
    name = link.get("tokenEnv")
    if name:
        token = env.get(name)
        if not token:
            raise ValueError(f"environment variable {name} is not set")
        headers["Authorization"] = f"Bearer {token}"
    data = json.loads(reader.get(link["url"], headers).decode("utf-8"))
    price = parse_number(path_get(data, link.get("priceField") or "price"))
    if not price:
        return None
    currency = path_get(data, link["currencyField"]) if link.get("currencyField") else None
    return {"price": price, "currency": currency, "method": "api", "availability": None}


# ---------------------------------------------------------------- running a list

def _decode(body):
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("cp1252", "replace")


def read_link(reader, link, day, env):
    result = {"date": day, "item": link["item"], "supplier": link["supplier"], "url": link["url"], "kind": link.get("kind", "page")}
    try:
        found = read_api(reader, link, env) if result["kind"] == "api" else read_price(_decode(reader.get(link["url"])))
    except Refused as err:
        return {**result, "status": "not allowed", "note": str(err)}
    except (OSError, ValueError) as err:
        return {**result, "status": "error", "note": str(err) or err.__class__.__name__}
    if not found:
        return {**result, "status": "no price", "note": "no product price in the page's structured data"}
    factor = parse_number(link.get("factor")) or 1.0
    result.update(status="ok", price=round(found["price"] * factor, 4), currency=found["currency"] or "BRL",
                  method=found["method"], availability=found["availability"])
    if factor != 1:
        result["note"] = f"page price x {factor:g}"
    return result


def merge(previous, new, today):
    """Keeps the history: one result per day, item, supplier and address, for two years."""
    cutoff = (date.fromisoformat(today) - timedelta(days=KEEP_DAYS)).isoformat()
    key = lambda r: (r["date"], r["item"], r["supplier"], r["url"])
    rows = {key(r): r for r in previous if r.get("date", "") >= cutoff}
    rows.update((key(r), r) for r in new)
    return sorted(rows.values(), key=lambda r: (r["date"], r["item"], r["supplier"]), reverse=True)


def run(links_path, out_path, today=None, reader=None, env=None):
    spec = json.loads(Path(links_path).read_text(encoding="utf-8"))
    links = [l for l in spec.get("links", []) if l.get("item") and l.get("supplier") and l.get("url")]
    contact = str(spec.get("contact") or "").strip()
    reader = reader or Reader(user_agent=AGENT + (f" (+{contact})" if contact else ""))
    day = today or date.today().isoformat()
    env = os.environ if env is None else env
    results = [read_link(reader, link, day, env) for link in links]
    out = Path(out_path)
    previous = []
    if out.exists():
        try:
            previous = json.loads(out.read_text(encoding="utf-8")).get("results", [])
        except ValueError:
            previous = []
    data = {
        "app": "SupplyPulse",
        "kind": "page-prices",
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat() if today is None else f"{day}T00:00:00+00:00",
        "agent": reader.user_agent,
        "results": merge(previous, results, day),
    }
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return results
