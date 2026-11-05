import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pricetracker import analysis as an
from pricetracker import site, store
from pricetracker.analysis import Item, Quote

MARKET = {
    "2026-01": {"copper": 10000.0, "zinc": 3000.0, "usd_brl": 5.0, "igpm_pct": 1.0},
    "2026-02": {"copper": 10500.0, "zinc": 3000.0, "usd_brl": 5.0, "igpm_pct": 2.0},
    "2026-03": {"copper": 11000.0, "zinc": 3000.0, "usd_brl": 5.0, "igpm_pct": 0.5},
    "2026-07": {"copper": 9000.0, "zinc": 3000.0, "usd_brl": 5.0, "igpm_pct": 0.5},
}
TUBE = Item("TUBE", "Copper tube", "kg", 1.0, {"copper": 1.0}, 1000, "Gamma")


def quote(month, supplier, price, item="TUBE", lead=10, pay=30):
    return Quote(month, supplier, item, price, lead, pay, 100)


class CalendarTest(unittest.TestCase):
    def test_add_months(self):
        self.assertEqual(an.add_months("2026-11", 2), "2027-01")
        self.assertEqual(an.add_months("2026-01", -1), "2025-12")
        self.assertEqual(an.months_between("2025-11", "2026-02"), 3)
        self.assertEqual(an.month_name("2026-05"), "May 2026")


class MaterialCostTest(unittest.TestCase):
    def test_single_metal(self):
        self.assertAlmostEqual(an.material_cost(TUBE, MARKET, "2026-01"), 50.0)  # 10,000 USD/t = 10 USD/kg = 50 BRL

    def test_basket_and_unit_weight(self):
        elbow = Item("ELB", "Brass elbow", "pc", 0.06, {"copper": 0.62, "zinc": 0.38}, 1, "")
        expected = 0.06 * (0.62 * 10000 + 0.38 * 3000) / 1000 * 5.0
        self.assertAlmostEqual(an.material_cost(elbow, MARKET, "2026-01"), expected)

    def test_missing_data(self):
        self.assertIsNone(an.material_cost(TUBE, MARKET, "2026-05"))
        nickel = Item("N", "n", "kg", 1, {"nickel": 1.0}, 1, "")
        self.assertIsNone(an.material_cost(nickel, MARKET, "2026-01"))

    def test_igpm_compounds_after_the_start_month(self):
        self.assertAlmostEqual(an.igpm_factor(MARKET, "2026-01", "2026-03"), 1.02 * 1.005)
        self.assertEqual(an.igpm_factor(MARKET, "2026-03", "2026-03"), 1.0)
        self.assertIsNone(an.igpm_factor(MARKET, "2026-03", "2026-05"))


class CompareTest(unittest.TestCase):
    def setUp(self):
        # copper falls 10% from January to July
        self.quotes = [
            quote("2026-01", "Alpha", 60.0), quote("2026-07", "Alpha", 50.0, lead=20, pay=28),
            quote("2026-01", "Beta", 58.0), quote("2026-07", "Beta", 59.0),
            quote("2026-01", "Gamma", 66.0), quote("2026-07", "Gamma", 56.0, lead=15, pay=45),
            quote("2026-02", "Old", 40.0),
        ]

    def table(self):
        return {r["supplier"]: r for r in an.compare_suppliers(TUBE, self.quotes, MARKET, "2026-07")}

    def test_best_ignores_stale_quotes(self):
        rows = self.table()
        self.assertTrue(rows["Old"]["stale"])
        self.assertEqual(rows["Alpha"]["vs_best_pct"], 0)
        self.assertAlmostEqual(rows["Gamma"]["vs_best_pct"], 12.0)

    def test_changes_against_material(self):
        rows = self.table()
        self.assertAlmostEqual(rows["Beta"]["material_change_pct"], -10.0)
        self.assertAlmostEqual(rows["Beta"]["change_pct"], 5900 / 58 - 100)
        self.assertAlmostEqual(rows["Beta"]["gap_pp"], (5900 / 58 - 100) + 10.0)
        self.assertAlmostEqual(rows["Alpha"]["material_share_pct"], 90.0)
        self.assertTrue(rows["Gamma"]["current"])

    def test_flags(self):
        flags = an.find_flags([TUBE], self.quotes, MARKET, "2026-07")
        kinds = {(f["kind"], f["supplier"]) for f in flags}
        self.assertEqual(kinds, {("outpaced", "Beta"), ("above_best", "Gamma"), ("stale", "Old")})
        above = next(f for f in flags if f["kind"] == "above_best")
        self.assertEqual(above["saving_brl"], 6000.0)  # (56 - 50) * 1000 kg
        self.assertIn("Alpha: 20 days lead time, 28-day payment", above["message"])
        self.assertEqual(flags[-1]["severity"], "low")

    def test_no_saving_flag_when_current_supplier_is_best(self):
        item = Item("TUBE", "Copper tube", "kg", 1.0, {"copper": 1.0}, 1000, "Alpha")
        flags = an.find_flags([item], self.quotes, MARKET, "2026-07")
        self.assertNotIn("above_best", {f["kind"] for f in flags})


class TrendTest(unittest.TestCase):
    def test_direction(self):
        self.assertEqual(an.trend([10, 10, 10, 11, 11, 11]), "rising")
        self.assertEqual(an.trend([10, 10, 10, 9, 9, 9]), "falling")
        self.assertEqual(an.trend([10, 10, 10, 10.1, 10, 10]), "flat")
        self.assertIsNone(an.trend([10, None, 10, 10, 10, 10]))


class SampleDataTest(unittest.TestCase):
    def test_site_payload_from_shipped_data(self):
        items, quotes, market = store.load_items(), store.load_quotes(), store.load_market()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "data.js"
            with mock.patch.object(site, "SITE", Path(tmp)):
                site.build(out=out)
            text = out.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("window.PRICE_DATA = "))
        data = json.loads(text[len("window.PRICE_DATA = "):].rstrip().rstrip(";"))
        self.assertEqual(len(data["months"]), site.MONTHS_SHOWN)
        self.assertEqual(data["months"][-1], data["asOf"])
        self.assertEqual({i["id"] for i in data["items"]}, {i.id for i in items})
        for item in data["items"]:
            self.assertEqual(len(item["material"]), site.MONTHS_SHOWN)
            self.assertIn(item["currentSupplier"], item["prices"])
        self.assertTrue(data["flags"])
        self.assertEqual(len(data["sources"]), 2)
        self.assertTrue(all(q.supplier and q.price > 0 for q in quotes))
        self.assertTrue(market)


if __name__ == "__main__":
    unittest.main()
