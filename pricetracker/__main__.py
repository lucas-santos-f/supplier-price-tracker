"""Command line: python -m pricetracker {sources,fetch,report,pages,build}"""
import argparse
import sys
from datetime import date
from urllib.parse import urlsplit

from . import analysis as an
from . import collectors, store
from .net import Client
from .registry import Refused, Registry


def cmd_sources(args):
    registry = Registry.load()
    client = Client(registry)
    for source in registry:
        print(f"{source.id:22} {source.status:9} {source.license or '-':10} {source.name}")
        if args.check:
            for host in source.hosts:
                url = source.landing_page if urlsplit(source.landing_page).hostname == host else f"https://{host}/"
                allowed = client.robots(url).can_fetch(client.user_agent, url)
                print(f"{'':22} robots.txt {host}: {'allows' if allowed else 'disallows'} {urlsplit(url).path}")


def cmd_fetch(args):
    client = Client(Registry.load())
    until = args.until or date.today().strftime("%Y-%m")
    try:
        wb = collectors.worldbank_monthly(client, args.since)
        print("World Bank:", store.save_market(wb, "worldbank.csv"), f"({len(wb)} months)")
        bcb = collectors.bcb_monthly(client, args.since, until)
        print("BCB:", store.save_market(bcb, "bcb.csv"), f"({len(bcb)} months)")
    except Refused as err:
        sys.exit(f"refused: {err}")


def cmd_report(args):
    items, quotes, market = store.load_items(), store.load_quotes(), store.load_market()
    as_of = args.as_of or min(an.latest_complete_month(market, ("usd_brl", "copper")), max(q.month for q in quotes))
    print(f"As of {as_of}\n")
    for item in items:
        print(f"{item.id}  {item.description}  (BRL per {item.unit})")
        for r in an.compare_suppliers(item, quotes, market, as_of):
            change = "n/a" if r["change_pct"] is None else f"{r['change_pct']:+.1f}%"
            mark = "*" if r["current"] else " "
            stale = "  stale" if r["stale"] else ""
            print(f"  {mark}{r['supplier']:16} {r['price']:>10.2f}  vs best {r['vs_best_pct']:+6.1f}%  "
                  f"6m {change:>7}  material {r['material_change_pct']:+.1f}%{stale}")
        print()
    for flag in an.find_flags(items, quotes, market, as_of):
        print(f"[{flag['severity']}] {flag['item']}: {flag['message']}")


def cmd_pages(args):
    from .pages import run
    results = run(args.links, args.out)
    for r in results:
        price = f"{r['price']:.2f} {r['currency']} ({r['method']})" if r["status"] == "ok" else r.get("note", "")
        print(f"{r['status']:12} {r['item']:16} {r['supplier']:20} {price}")
    print(f"wrote {args.out}")


def cmd_build(args):
    from .site import build
    path, data = build()
    print(f"wrote {path} (as of {data['asOf']}, {len(data['flags'])} flags)")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pricetracker")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("sources", help="list the source registry")
    p.add_argument("--check", action="store_true", help="also read robots.txt of each host")
    p.set_defaults(func=cmd_sources)
    p = sub.add_parser("fetch", help="download market data from the approved sources")
    p.add_argument("--since", default="2022-01")
    p.add_argument("--until", help="last month for BCB series (default: current month)")
    p.set_defaults(func=cmd_fetch)
    p = sub.add_parser("report", help="supplier comparison and flags in the terminal")
    p.add_argument("--as-of", help="YYYY-MM")
    p.set_defaults(func=cmd_report)
    p = sub.add_parser("pages", help="read prices from the supplier product pages you listed")
    p.add_argument("links", nargs="?", default="supplier-pages.json", help="file downloaded from the page (default: supplier-pages.json)")
    p.add_argument("--out", default="site/page-prices.json")
    p.set_defaults(func=cmd_pages)
    p = sub.add_parser("build", help="write site/data.js")
    p.set_defaults(func=cmd_build)
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
