"""Writes site/data.js, the only data file the static page reads."""
import json
from datetime import date

from . import analysis as an
from .registry import ROOT, Registry
from .store import load_items, load_market, load_quotes

SITE = ROOT / "site"
MONTHS_SHOWN = 24


def _round(value, digits=2):
    return None if value is None else round(value, digits)


def _clean(obj):
    if isinstance(obj, float):
        return round(obj, 4)
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def load_web(folder=ROOT / "data" / "web"):
    """Sample for the supplier pages tab: one item priced from product pages and a run of the page reader."""
    read = lambda name: json.loads((folder / name).read_text(encoding="utf-8")) if (folder / name).exists() else {}
    sample, links, results = read("sample.json"), read("supplier-pages.json"), read("page-prices.json")
    return {"items": sample.get("items", []), "quotes": sample.get("quotes", []), "links": links.get("links", []),
            "results": results.get("results", []), "resultsUpdated": results.get("updated")}


def payload(items, quotes, market, registry, as_of=None, web=None):
    if as_of is None:
        market_month = an.latest_complete_month(market, ("usd_brl", "igpm_pct", "copper"))
        as_of = min(market_month, max(q.month for q in quotes))
    months = [an.add_months(as_of, -i) for i in range(MONTHS_SHOWN - 1, -1, -1)]

    item_rows = []
    for item in items:
        prices = {}
        for q in quotes:
            if q.item == item.id and q.month in months:
                prices.setdefault(q.supplier, [None] * len(months))[months.index(q.month)] = q.price
        item_rows.append({
            "id": item.id,
            "description": item.description,
            "unit": item.unit,
            "annualVolume": item.annual_volume,
            "currentSupplier": item.current_supplier,
            "basket": item.basket,
            "material": [_round(an.material_cost(item, market, m)) for m in months],
            "prices": dict(sorted(prices.items())),
            "table": an.compare_suppliers(item, quotes, market, as_of),
        })

    igpm = [an.igpm_factor(market, months[0], m) for m in months]
    return _clean({
        "asOf": as_of,
        "generated": date.today().isoformat(),
        "months": months,
        "items": item_rows,
        "flags": an.find_flags(items, quotes, market, as_of),
        "igpmIndex": [None if f is None else f * 100 for f in igpm],
        "market": [an.market_trend(market, key, as_of, in_brl=True) for key in an.COMMODITIES],
        "fx": an.market_trend(market, "usd_brl", as_of),
        "sources": [
            {"name": s.name, "license": s.license, "url": s.landing_page, "attribution": s.attribution}
            for s in registry if s.approved
        ],
        # inputs, so the page can redo the analysis with the user's own items and quotes
        "raw": {
            "market": {m: market[m] for m in sorted(market)},
            "items": [
                {"id": i.id, "description": i.description, "unit": i.unit, "kgPerUnit": i.kg_per_unit,
                 "annualVolume": i.annual_volume, "currentSupplier": i.current_supplier,
                 "source": {"type": "basket", "basket": i.basket}}
                for i in items
            ],
            "quotes": [
                {"month": q.month, "supplier": q.supplier, "item": q.item, "price": q.price,
                 "leadTime": q.lead_time_days, "payment": q.payment_days, "moq": q.moq}
                for q in quotes
            ],
            "web": web or {},
        },
    })


def build(out=SITE / "data.js"):
    data = payload(load_items(), load_quotes(), load_market(), Registry.load(), web=load_web())
    out.write_text("window.PRICE_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n", encoding="utf-8")
    return out, data
