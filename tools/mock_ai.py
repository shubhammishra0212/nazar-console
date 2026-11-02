#!/usr/bin/env python3
"""mock_ai.py — stand-ins for nazar-vision (127.0.0.1:8765) and nazar-agent (127.0.0.1:8766), shaped exactly like
CONTRACT.md §4 and §5, for testing the console without the real model or the LLM. Standard library only.

    python3 tools/mock_ai.py                 # both services
    python3 tools/mock_ai.py --slow 3        # vision answers after 3 s (the console must time out at 2 s and PASS)
    python3 tools/mock_ai.py --no-agent      # vision only

Vision: random verdicts (~80 % PASS, 10 % HOLD, 8 % REJECT, 2 % NO_PART), small grey crop and coloured heatmap PNGs.
Agent: real counts, p-chart and strata from the posted inspections (normal-approximation p-values), template 8D text,
after --agent-delay seconds (default 3) to show the console's waiting state.
"""
import argparse
import base64
import json
import math
import random
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def png(w, h, pixel):
    """Tiny PNG encoder: pixel(x, y) -> (r, g, b)."""
    rows = b"".join(b"\x00" + bytes(c for x in range(w) for c in pixel(x, y)) for y in range(h))
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def washer(x, y):
    d = math.hypot(x - 32, y - 32)
    return (185, 188, 188) if 11 < d < 28 else (45, 50, 52)


def heat(defect):
    cx, cy = random.randint(14, 50), random.randint(14, 50)
    def f(x, y):
        d = math.hypot(x - cx, y - cy)
        if defect and d < 10:
            k = 1 - d / 10
            return (220, int(60 + 150 * (1 - k)), 30)
        return (30, 50, 110)
    return f


class Handler(BaseHTTPRequestHandler):
    server_version = "nazar-mock/2.0"
    slow = 0.0
    agent_delay = 3.0

    def log_message(self, fmt, *args):
        print(f"{time.strftime('%H:%M:%S')} {self.server.server_address[1]} {fmt % args}", flush=True)

    def reply(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        port = self.server.server_address[1]
        if self.path.startswith("/health"):
            if port == 8765:
                return self.reply({"ok": True, "model": "mock-patchcore", "hold": 0.33, "reject": 0.44, "bank": 0, "version": "2.0.0-mock"})
            return self.reply({"ok": True, "llm": "missing", "busy": False, "version": "2.0.0-mock"})
        self.reply({"ok": False, "error": "unknown path"})

    def do_POST(self):
        port = self.server.server_address[1]
        data = self.body()
        if port == 8765 and self.path.startswith("/inspect"):
            if self.slow:
                time.sleep(self.slow)
            u = random.random()
            verdict = "PASS" if u < 0.8 else "HOLD" if u < 0.9 else "REJECT" if u < 0.98 else "NO_PART"
            score = {"PASS": random.uniform(0.1, 0.3), "HOLD": random.uniform(0.34, 0.43),
                     "REJECT": random.uniform(0.45, 0.8), "NO_PART": 0.0}[verdict]
            out = {"ok": True, "verdict": verdict, "score": round(score, 3), "hold": 0.33, "reject": 0.44,
                   "ms": random.randint(40, 70), "box": [400, 160, 400, 400], "bytes": len(data)}
            if verdict != "NO_PART":
                out["crop"] = base64.b64encode(png(64, 64, washer)).decode()
                out["heatmap"] = base64.b64encode(png(64, 64, heat(verdict != "PASS"))).decode()
            return self.reply(out)
        if port == 8766 and self.path.startswith("/report"):
            try:
                req = json.loads(data or b"{}")
            except ValueError:
                return self.reply({"ok": False, "error": "body is not JSON"})
            time.sleep(self.agent_delay)
            return self.reply(report(req))
        self.reply({"ok": False, "error": "unknown path"})


def p_two(hb, hn, lb, ln):
    if not hn or not ln:
        return None
    p = (hb + lb) / (hn + ln)
    se = math.sqrt(max(p * (1 - p) * (1 / hn + 1 / ln), 1e-12))
    z = abs(hb / hn - lb / ln) / se
    return math.erfc(z / math.sqrt(2))


def report(req):
    rows = req.get("inspections") or []
    lim = req.get("limits") or {}
    bad = lambda r: r.get("verdict") != "PASS"
    n, nb = len(rows), sum(1 for r in rows if bad(r))
    rate = nb / n if n else 0
    pchart = []
    for i in range(0, n - n % 20, 20):
        g = rows[i:i + 20]
        b = sum(1 for r in g if bad(r))
        sd = math.sqrt(rate * (1 - rate) / 20)
        pchart.append({"from": g[0]["at"], "to": g[-1]["at"], "n": 20, "bad": b, "p": b / 20,
                       "ucl": min(1, rate + 3 * sd), "lcl": max(0, rate - 3 * sd)})
    labels = {"vib": "Motor shaking", "temp": "Motor temperature", "lux": "Tunnel light", "ma": "Belt motor current"}
    strata = []
    for f, label in labels.items():
        a = (lim.get(f) or {}).get("amber")
        rs = [r for r in rows if r.get(f) is not None and a is not None]
        hi = [r for r in rs if (r[f] <= a if f == "lux" else r[f] >= a)]
        lo = [r for r in rs if r not in hi]
        hb, lb = sum(1 for r in hi if bad(r)), sum(1 for r in lo if bad(r))
        ratio = (hb / len(hi)) / max(lb / len(lo), 0.5 / len(lo)) if hi and lo else None
        strata.append({"factor": f, "label": label, "high_n": len(hi), "high_bad": hb, "low_n": len(lo), "low_bad": lb,
                       "ratio": ratio, "p_value": p_two(hb, len(hi), lb, len(lo))})
    cands = sorted([s for s in strata if s["p_value"] is not None and s["p_value"] < 0.05 and s["ratio"] and s["ratio"] > 1],
                   key=lambda s: s["p_value"])
    cause = cands[0]["factor"] if cands else None
    stats = {"n": n, "bad": nb, "rate": rate, "pchart": pchart, "strata": strata, "cause": cause}
    if req.get("fix_at"):
        fa = req["fix_at"]
        be, af = [r for r in rows if r["at"] < fa], [r for r in rows if r["at"] >= fa]
        stats["before_after"] = {"before_n": len(be), "before_bad": sum(1 for r in be if bad(r)),
                                 "after_n": len(af), "after_bad": sum(1 for r in af if bad(r)), "cause_before": 0, "cause_after": 0}
    if n < 20:
        return {"ok": True, "enough": False, "writer": "template", "ms": 0, "stats": stats,
                "message": f"Only {n} inspections; at least 20 are needed."}
    name = labels.get(cause, "no single factor").lower()
    sections = [{"id": f"D{i}", "title": t, "body": b} for i, (t, b) in enumerate([
        ("Team", "Mock agent: operator, maintenance, quality."),
        ("Problem", f"{nb} of {n} parts held or rejected ({rate * 100:.1f} %)."),
        ("Containment", "Rejected parts removed by the gate; held parts checked by hand."),
        ("Root cause", f"Largest difference: {name}."),
        ("Corrective action", "Fix the cause found in D4."),
        ("Verification", "Compare before and after the fix."),
        ("Prevention", "Keep the limits on the console."),
        ("Closure", "Close when the rate stays normal for a shift."),
    ], start=1)]
    return {"ok": True, "enough": True, "writer": "template", "ms": int(Handler.agent_delay * 1000), "stats": stats,
            "report": {"title": f"Mock 8D: rejects and {name}", "summary": "Written by tools/mock_ai.py for testing.", "sections": sections}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slow", type=float, default=0, help="vision answers after this many seconds")
    ap.add_argument("--agent-delay", type=float, default=3, help="agent answers after this many seconds")
    ap.add_argument("--no-agent", action="store_true")
    args = ap.parse_args()
    Handler.slow, Handler.agent_delay = args.slow, args.agent_delay
    ports = [8765] + ([] if args.no_agent else [8766])
    servers = [ThreadingHTTPServer(("127.0.0.1", p), Handler) for p in ports]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"mock AI on {', '.join('127.0.0.1:%d' % p for p in ports)}. Ctrl-C to stop.", flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
