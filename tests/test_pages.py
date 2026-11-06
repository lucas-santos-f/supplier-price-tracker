import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pricetracker.pages import Reader, merge, parse_number, read_link, read_price, run, terms_block
from pricetracker.registry import Refused

JSON_LD = """<html><head><script type="application/ld+json">
{"@context": "https://schema.org", "@type": "Product", "name": "Wheat flour type 1, 25 kg",
 "offers": {"@type": "Offer", "price": "109.90", "priceCurrency": "BRL", "availability": "https://schema.org/InStock"},
 "isSimilarTo": {"@type": "Product", "offers": {"@type": "Offer", "price": "9.90", "priceCurrency": "BRL"}}}
</script></head><body>R$ 109,90</body></html>"""

GRAPH = """<script type="application/ld+json">{"@graph": [
 {"@type": "WebPage", "name": "Flour"},
 {"@type": ["Product"], "offers": [
   {"@type": "Offer", "price": 98.5, "priceCurrency": "BRL", "availability": "http://schema.org/OutOfStock"},
   {"@type": "Offer", "price": 101.2, "priceCurrency": "BRL", "availability": "http://schema.org/InStock"}]},
 {"@type": "Product", "offers": {"@type": "AggregateOffer", "lowPrice": "1.234,56", "priceCurrency": "BRL"}}]}</script>"""

MICRODATA = """<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Flour</span>
<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
<meta itemprop="priceCurrency" content="BRL"><span itemprop="price">104,50</span></div></div>"""

META = """<head><meta property="og:title" content="Flour">
<meta property="product:price:amount" content="99.00"><meta property="product:price:currency" content="BRL"></head>"""


class ReadPriceTest(unittest.TestCase):
    def test_json_ld_offer_and_not_the_related_product(self):
        self.assertEqual(read_price(JSON_LD), {"price": 109.9, "currency": "BRL", "method": "json-ld", "availability": "InStock"})

    def test_graph_prefers_the_lowest_offer_in_stock(self):
        r = read_price(GRAPH)
        self.assertEqual((r["price"], r["availability"]), (101.2, "InStock"))

    def test_microdata_with_text_price(self):
        self.assertEqual(read_price(MICRODATA)["price"], 104.5)
        self.assertEqual(read_price(MICRODATA)["method"], "microdata")

    def test_meta_tags(self):
        self.assertEqual(read_price(META), {"price": 99.0, "currency": "BRL", "method": "meta tag", "availability": None})

    def test_visible_text_alone_is_not_read(self):
        self.assertIsNone(read_price("<p>Price: R$ 109,90</p>"))
        self.assertIsNone(read_price('<script type="application/ld+json">{not json</script>'))

    def test_parse_number(self):
        cases = {"109.90": 109.9, "R$ 1.234,56": 1234.56, "1,234.56": 1234.56, "104,50": 104.5, "1.234": 1234.0,
                 "1,234": 1234.0, 98: 98.0, "": None, "free": None, None: None}
        for value, expected in cases.items():
            self.assertEqual(parse_number(value), expected, value)


class TermsTest(unittest.TestCase):
    def test_sites_whose_terms_rule_out_robots(self):
        for host in ("www.mercadolivre.com.br", "produto.mercadolivre.com.br", "mercadolibre.com.ar", "api.mercadolibre.com",
                     "www.amazon.com.br", "amazon.com"):
            self.assertTrue(terms_block(host), host)
        for host in ("www.mill.example", "shop.deltamills.example", "amazonas-flour.example"):
            self.assertIsNone(terms_block(host), host)


class FakeReader:
    def __init__(self, pages):
        self.pages = pages
        self.user_agent = "test"

    def get(self, url, headers=None):
        page = self.pages[url]
        if isinstance(page, Exception):
            raise page
        return page.encode("utf-8") if isinstance(page, str) else page


class RunTest(unittest.TestCase):
    def test_statuses_factor_and_history(self):
        pages = {
            "https://a.example/flour": JSON_LD,
            "https://b.example/flour-1kg": META,
            "https://c.example/flour": Refused("robots.txt of https://c.example does not allow /flour"),
            "https://d.example/flour": "<p>R$ 99</p>",
            "https://api.e.example/items/1": json.dumps({"item": {"price": 97.4, "currency_id": "BRL"}}),
        }
        links = {"links": [
            {"item": "FLOUR", "supplier": "A", "url": "https://a.example/flour"},
            {"item": "FLOUR", "supplier": "B", "url": "https://b.example/flour-1kg", "factor": 25},
            {"item": "FLOUR", "supplier": "C", "url": "https://c.example/flour"},
            {"item": "FLOUR", "supplier": "D", "url": "https://d.example/flour"},
            {"item": "FLOUR", "supplier": "E", "url": "https://api.e.example/items/1", "kind": "api",
             "priceField": "item.price", "currencyField": "item.currency_id", "tokenEnv": "E_TOKEN"},
            {"item": "", "supplier": "F", "url": "https://f.example"},
        ]}
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "supplier-pages.json", Path(tmp) / "page-prices.json"
            src.write_text(json.dumps(links), encoding="utf-8")
            out.write_text(json.dumps({"results": [
                {"date": "2026-10-01", "item": "FLOUR", "supplier": "A", "url": "https://a.example/flour", "status": "ok", "price": 105.0},
                {"date": "2023-01-01", "item": "FLOUR", "supplier": "A", "url": "https://a.example/flour", "status": "ok", "price": 80.0},
            ]}), encoding="utf-8")
            results = run(src, out, today="2026-10-28", reader=FakeReader(pages), env={"E_TOKEN": "x"})
            saved = json.loads(out.read_text(encoding="utf-8"))
        by = {r["supplier"]: r for r in results}
        self.assertEqual(len(results), 5)
        self.assertEqual((by["A"]["status"], by["A"]["price"], by["A"]["method"]), ("ok", 109.9, "json-ld"))
        self.assertEqual((by["B"]["price"], by["B"]["note"]), (2475.0, "page price x 25"))
        self.assertEqual(by["C"]["status"], "not allowed")
        self.assertEqual(by["D"]["status"], "no price")
        self.assertEqual((by["E"]["price"], by["E"]["method"]), (97.4, "api"))
        self.assertEqual([r["date"] for r in saved["results"]], ["2026-10-28"] * 5 + ["2026-10-01"])

    def test_api_token_must_be_set(self):
        link = {"item": "X", "supplier": "E", "url": "https://api.e.example/items/1", "kind": "api", "tokenEnv": "E_TOKEN"}
        r = read_link(FakeReader({}), link, "2026-10-28", env={})
        self.assertEqual((r["status"], r["note"]), ("error", "environment variable E_TOKEN is not set"))

    def test_merge_keeps_one_row_per_day(self):
        a = {"date": "2026-10-28", "item": "X", "supplier": "A", "url": "u", "price": 1}
        b = dict(a, price=2)
        self.assertEqual(merge([a], [b], "2026-10-28"), [b])


class Handler(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        Handler.requests.append((self.path, self.headers.get("User-Agent")))
        if self.path == "/robots.txt":
            body, status = b"User-agent: *\nDisallow: /private/\n", 200
        elif self.path == "/moved":
            self.send_response(302)
            self.send_header("Location", "/private/flour")
            self.end_headers()
            return
        elif self.path in ("/flour", "/private/flour"):
            body, status = JSON_LD.encode("utf-8"), 200
        else:
            body, status = b"not found", 404
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class ReaderTest(unittest.TestCase):
    def setUp(self):
        Handler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.reader = Reader(user_agent="SupplyPulse-PriceReader/1.0 (+buyer@example.com)", delay=0)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_reads_an_allowed_page_with_its_own_user_agent(self):
        self.assertEqual(read_price(self.reader.get(self.base + "/flour").decode())["price"], 109.9)
        self.assertEqual(Handler.requests[0], ("/robots.txt", "SupplyPulse-PriceReader/1.0 (+buyer@example.com)"))

    def test_robots_and_redirects_are_respected(self):
        with self.assertRaises(Refused):
            self.reader.get(self.base + "/private/flour")
        with self.assertRaises(Refused):
            self.reader.get(self.base + "/moved")
        self.assertNotIn("/private/flour", [p for p, _ in Handler.requests])

    def test_not_found_is_an_error(self):
        with self.assertRaises(OSError):
            self.reader.get(self.base + "/nothing")

    def test_terms_list_stops_the_request(self):
        with self.assertRaises(Refused):
            self.reader.get("https://www.mercadolivre.com.br/farinha")


if __name__ == "__main__":
    unittest.main()
