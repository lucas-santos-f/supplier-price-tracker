"""Supplier comparison, pass-through checks and market trends.

Market rows are {"YYYY-MM": {"copper": USD/t, ..., "usd_brl": rate, "igpm_pct": % m/m}}.
"""
from dataclasses import dataclass
from statistics import mean

COMMODITIES = ("copper", "aluminum", "zinc", "nickel", "iron_ore")
WINDOW = 6            # months used for price changes
OUTPACE_PP = 5.0      # supplier change above material change that gets flagged
ABOVE_BEST_PCT = 5.0  # current supplier this far above the best valid quote
STALE_MONTHS = 3      # a quote older than this is not a valid offer
TREND_BAND = 2.0      # % between the last 3 months and the 3 before that counted as flat
MONTH_NAMES = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


@dataclass
class Item:
    id: str
    description: str
    unit: str
    kg_per_unit: float
    basket: dict  # commodity -> tonnes of it per tonne of product
    annual_volume: float
    current_supplier: str


@dataclass
class Quote:
    month: str
    supplier: str
    item: str
    price: float
    lead_time_days: int
    payment_days: int
    moq: float


def add_months(month, n):
    year, mon = map(int, month.split("-"))
    year, mon = divmod(year * 12 + mon - 1 + n, 12)
    return f"{year:04d}-{mon + 1:02d}"


def months_between(start, end):
    y1, m1 = map(int, start.split("-"))
    y2, m2 = map(int, end.split("-"))
    return (y2 - y1) * 12 + m2 - m1


def month_name(month):
    year, mon = month.split("-")
    return f"{MONTH_NAMES[int(mon) - 1]} {year}"


def pct(new, old):
    if new is None or not old:
        return None
    return (new / old - 1) * 100


def material_cost(item, market, month):
    """Raw material in one unit of the item, in BRL, at that month's prices."""
    row = market.get(month)
    if not row or "usd_brl" not in row:
        return None
    usd_per_tonne = 0.0
    for key, tonnes in item.basket.items():
        if key not in row:
            return None
        usd_per_tonne += tonnes * row[key]
    return item.kg_per_unit * usd_per_tonne / 1000 * row["usd_brl"]


def igpm_factor(market, start, end):
    """IGP-M accumulated over the months after `start` up to and including `end`."""
    factor = 1.0
    month = add_months(start, 1)
    while month <= end:
        rate = market.get(month, {}).get("igpm_pct")
        if rate is None:
            return None
        factor *= 1 + rate / 100
        month = add_months(month, 1)
    return factor


def last_quote(quotes, item_id, supplier, month):
    """Most recent quote from `supplier` for the item at or before `month`."""
    found = None
    for q in quotes:
        if q.item == item_id and q.supplier == supplier and q.month <= month:
            if found is None or q.month > found.month:
                found = q
    return found


def compare_suppliers(item, quotes, market, as_of, window=WINDOW):
    cost_now = material_cost(item, market, as_of)
    material_change = pct(cost_now, material_cost(item, market, add_months(as_of, -window)))
    rows = []
    for supplier in sorted({q.supplier for q in quotes if q.item == item.id}):
        quote = last_quote(quotes, item.id, supplier, as_of)
        if quote is None:
            continue
        before = last_quote(quotes, item.id, supplier, add_months(as_of, -window))
        change = pct(quote.price, before.price if before else None)
        rows.append({
            "supplier": supplier,
            "price": quote.price,
            "quoted": quote.month,
            "lead_time_days": quote.lead_time_days,
            "payment_days": quote.payment_days,
            "moq": quote.moq,
            "change_pct": change,
            "material_change_pct": material_change,
            "gap_pp": None if change is None or material_change is None else change - material_change,
            "material_share_pct": cost_now / quote.price * 100 if cost_now else None,
            "current": supplier == item.current_supplier,
            "stale": months_between(quote.month, as_of) >= STALE_MONTHS,
        })
    best = min((r["price"] for r in rows if not r["stale"]), default=None)
    for r in rows:
        r["vs_best_pct"] = pct(r["price"], best)
    rows.sort(key=lambda r: (r["stale"], r["price"]))
    return rows


def find_flags(items, quotes, market, as_of):
    flags = []
    for item in items:
        rows = compare_suppliers(item, quotes, market, as_of)
        valid = [r for r in rows if not r["stale"]]
        best = valid[0] if valid else None
        for r in rows:
            if r["stale"]:
                flags.append(_flag(item, r, "stale", "low",
                                   f"Last quote from {r['supplier']} is from {month_name(r['quoted'])}; ask for a new one."))
            elif r["gap_pp"] is not None and r["gap_pp"] > OUTPACE_PP:
                flags.append(_flag(item, r, "outpaced", "high" if r["gap_pp"] > 2 * OUTPACE_PP else "medium",
                                   f"{r['supplier']} moved {r['change_pct']:+.1f}% in {WINDOW} months while the "
                                   f"material in this item moved {r['material_change_pct']:+.1f}%. Ask for the cost breakdown."))
        current = next((r for r in valid if r["current"]), None)
        if current and best and current is not best and current["vs_best_pct"] > ABOVE_BEST_PCT:
            saving = (current["price"] - best["price"]) * item.annual_volume
            flag = _flag(item, current, "above_best", "high",
                         f"Current supplier {current['supplier']} is {current['vs_best_pct']:.1f}% above "
                         f"{best['supplier']}, about R$ {saving:,.0f} a year at the planned volume. "
                         f"{best['supplier']}: {best['lead_time_days']} days lead time, {best['payment_days']}-day payment; "
                         f"{current['supplier']}: {current['lead_time_days']} days, {current['payment_days']}-day payment.")
            flag["saving_brl"] = round(saving, 2)
            flags.append(flag)
    order = {"high": 0, "medium": 1, "low": 2}
    flags.sort(key=lambda f: (order[f["severity"]], -f.get("saving_brl", 0)))
    return flags


def _flag(item, row, kind, severity, message):
    return {"item": item.id, "supplier": row["supplier"], "kind": kind, "severity": severity, "message": message}


def market_value(market, key, month, in_brl):
    row = market.get(month, {})
    value = row.get(key)
    if value is None:
        return None
    if in_brl:
        if "usd_brl" not in row:
            return None
        return value * row["usd_brl"] / 1000  # USD per tonne -> BRL per kg
    return value


def trend(values):
    """Direction from the mean of the last 3 points against the 3 before them."""
    if len(values) < 6 or None in values[-6:]:
        return None
    change = pct(mean(values[-3:]), mean(values[-6:-3]))
    if change > TREND_BAND:
        return "rising"
    if change < -TREND_BAND:
        return "falling"
    return "flat"


def market_trend(market, key, as_of, in_brl=False, months=24):
    history = [market_value(market, key, add_months(as_of, -i), in_brl) for i in range(months - 1, -1, -1)]
    last = history[-1]
    return {
        "key": key,
        "currency": "BRL/kg" if in_brl else "USD/t",
        "last": last,
        "change_3m": pct(last, history[-4]),
        "change_6m": pct(last, history[-7]),
        "change_12m": pct(last, history[-13]),
        "direction": trend(history),
        "history": history,
    }


def latest_complete_month(market, keys):
    months = [m for m, row in market.items() if all(k in row for k in keys)]
    return max(months) if months else None
