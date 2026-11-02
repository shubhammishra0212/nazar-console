#!/usr/bin/env python3
"""sim_board.py — a pretend NAZAR ESP32 on a pseudo-terminal, speaking the v2 protocol of CONTRACT.md.

    python3 tools/sim_board.py                 # prints e.g. /dev/ttys004
    open -n -a "build/NAZAR Console.app" --env NAZAR_EXTRA_PORT=/dev/ttys004

What it does (standard library only, no hardware):
  * JSON telemetry every 100 ms: v, ma, vib, vpk, lux, temp, ir, parts, rej, gate, belt, mode
  * a washer every 2.2-3.6 s of belt running time: {"t":"part"} → belt stops after stop_ms → {"t":"inspect"}
    → waits for PASS / FAIL / HOLD (or wait_ms) → {"t":"go"} → FAIL fires the gate after gate_ms → {"t":"gate"}
  * commands: PING PASS FAIL HOLD RESUME STOP START REJECT BELT RESET SET, each answered with ack / err
  * a "loose motor mount" episode: shaking climbs past amber and red for ~25 s, every --loose-every seconds
  * optional faults: --drop-light-at (light sensor vanishes for 8 s), --reboot-at (board restarts: counters to 0,
    boot noise, hello), --quit-at (the "cable is pulled": the pty closes)
  * every command received is printed as `received: ...`, so you can check what the console sent.
"""
import argparse
import fcntl
import json
import os
import random
import select
import sys
import time
import tty

DEFAULT_CFG = {"stop_ms": 150, "dwell_ms": 1200, "wait_ms": 5000, "gate_ms": 800, "gate_open_ms": 600, "stops": 1}


def gauss(s):
    return random.gauss(0, s)


class Board:
    def __init__(self, out, args):
        self.out = out
        self.args = args
        self.t0 = time.monotonic()
        self.boot()

    # ---------- lifecycle ----------
    def boot(self):
        self.ms0 = time.monotonic()
        self.mode, self.belt = "RUN", 1
        self.parts = self.rej = 0
        self.ir_left = 0.0
        self.next_part = 2.5
        self.to_stop = None
        self.insp = None             # {"n", "stopped", "verdict"}
        self.flow = None             # continuous mode: {"n", "age"} part waiting for a verdict
        self.to_stop_n = 0
        self.gates = []              # [[n, running seconds left]]
        self.gate_open = 0.0
        self.before = "RUN"
        self.hold_for = 0.0
        self.temp = 31.5
        self.vib_level = 0.035
        self.cfg = dict(DEFAULT_CFG)
        self.cfg["stops"] = self.args.stops
        self.light_ok = True
        self.send({"t": "hello", "fw": "2.0.0-sim", "sensors": self.sensors(), "cfg": self.cfg})

    def sensors(self):
        return {"ina219": True, "mpu6050": True, "bh1750": self.light_ok, "ds18b20": True}

    def send(self, obj):
        self.raw(json.dumps(obj, separators=(",", ":")))

    def raw(self, line):
        try:
            os.write(self.out, (line + "\n").encode())
        except BlockingIOError:
            pass                     # nobody is reading the port: drop it, like a real UART would
        except OSError:
            pass

    # ---------- 100 ms step ----------
    def step(self, dt):
        now = time.monotonic() - self.t0
        running = self.belt == 1

        if running and self.mode == "RUN":
            self.next_part -= dt
            if self.next_part <= 0:
                self.parts += 1
                self.ir_left = 0.18
                self.next_part = random.uniform(2.2, 3.6)
                self.send({"t": "part", "n": self.parts})
                self.to_stop = self.cfg["stop_ms"] / 1000      # reaches the camera after stop_ms of running
                self.to_stop_n = self.parts
        self.ir_left = max(0.0, self.ir_left - dt)
        if running and self.to_stop is not None:
            self.to_stop -= dt
            if self.to_stop <= 0:
                self.to_stop = None
                if self.cfg["stops"]:
                    self.belt, self.mode = 0, "INSPECT"
                    self.insp = {"n": self.to_stop_n, "stopped": 0.0, "verdict": None}
                else:                                         # continuous: belt keeps running, no go follows
                    self.flow = {"n": self.to_stop_n, "age": 0.0}
                self.send({"t": "inspect", "n": self.to_stop_n})
        if self.flow:
            self.flow["age"] += dt
            if self.flow["age"] >= self.cfg["wait_ms"] / 1000:
                self.flow = None                              # no verdict in time: the part just goes on
        if self.mode == "INSPECT" and self.insp:
            self.insp["stopped"] += dt
            v = self.insp["verdict"]
            if v and self.insp["stopped"] >= self.cfg["dwell_ms"] / 1000:
                self.go("reject" if v == "FAIL" else "pass")
            elif not v and self.insp["stopped"] >= self.cfg["wait_ms"] / 1000:
                self.go("timeout")
        if self.mode == "HOLD":
            self.hold_for += dt
        if self.belt:
            for g in self.gates:
                g[1] -= dt
            for g in [g for g in self.gates if g[1] <= 0]:
                self.rej += 1
                self.gate_open = self.cfg["gate_open_ms"] / 1000
                self.send({"t": "gate", "n": g[0]})
            self.gates = [g for g in self.gates if g[1] > 0]
        self.gate_open = max(0.0, self.gate_open - dt)

        # faults
        a = self.args
        light_now = not (a.drop_light_at and a.drop_light_at <= now < a.drop_light_at + 8)
        if light_now != self.light_ok:
            self.light_ok = light_now
            self.send({"t": "hello", "fw": "2.0.0-sim", "sensors": self.sensors(), "cfg": self.cfg})

        # sensors
        loose = self.loose(now)
        self.vib_level += ((0.036 + loose * 0.15) - self.vib_level) * 0.08
        vib = max(0.004, (self.vib_level if running else 0.006) + gauss(0.004 + loose * 0.012 if running else 0.001))
        ma = (312 + loose * 70 + gauss(9)) if running else (6 + gauss(2))
        self.temp += ((37.5 + loose * 4 if running else 33) - self.temp) * 0.0015
        tel = {"t": "tel", "ms": int((time.monotonic() - self.ms0) * 1000),
               "v": round(11.95 - ma * 0.00035 + gauss(0.01), 2), "ma": round(max(0, ma), 1),
               "vib": round(vib, 3), "vpk": round(vib * random.uniform(2.4, 3.0), 3)}
        if self.light_ok:
            tel["lux"] = round(812 + gauss(5), 1)
        tel.update({"temp": round(self.temp + gauss(0.05), 1), "ir": 1 if self.ir_left > 0 else 0,
                    "parts": self.parts, "rej": self.rej, "gate": 1 if self.gate_open > 0 else 0,
                    "belt": self.belt, "mode": self.mode})
        self.send(tel)

    def loose(self, now):
        every, length = self.args.loose_every, self.args.loose_len
        if every <= 0 or now < self.args.loose_first:
            return 0.0
        phase = (now - self.args.loose_first) % every
        if phase > length:
            return 0.0
        return min(1.0, phase / (length * 0.45))

    def go(self, res):
        n = self.insp["n"] if self.insp else self.parts
        if res == "reject":
            self.gates.append([n, self.cfg["gate_ms"] / 1000])
        self.insp = None
        self.mode, self.belt = "RUN", 1
        self.send({"t": "go", "n": n, "res": res})

    # ---------- commands ----------
    def command(self, line):
        parts = line.strip().split()
        if not parts:
            return
        cmd = parts[0].upper()
        print(f"{time.strftime('%H:%M:%S')} received: {line.strip()}", flush=True)
        # SET and BELT echo the whole command, uppercased (firmware contract choice)
        ack = lambda: self.send({"t": "ack", "cmd": " ".join(parts).upper() if cmd in ("SET", "BELT") else cmd})
        if cmd == "PING":
            self.send({"t": "pong"})
            self.send({"t": "hello", "fw": "2.0.0-sim", "sensors": self.sensors(), "cfg": self.cfg})
        elif cmd in ("PASS", "FAIL"):
            if self.mode == "HOLD":
                self.send({"t": "err", "msg": f"{cmd} ignored: line is on HOLD"})
            elif self.mode == "INSPECT" and self.insp and not self.insp["verdict"]:
                self.insp["verdict"] = cmd
                ack()
            elif self.mode == "INSPECT" and self.insp:
                self.send({"t": "err", "msg": f"{cmd} ignored: part {self.insp['n']} already has a verdict"})
            elif self.flow:
                if cmd == "FAIL":
                    self.gates.append([self.flow["n"], self.cfg["gate_ms"] / 1000])
                self.flow = None
                ack()
            else:
                self.send({"t": "err", "msg": f"{cmd} ignored: no part waiting for a verdict"})
        elif cmd == "HOLD":
            if self.mode != "STOP":
                self.mode, self.belt, self.hold_for = "HOLD", 0, 0.0
            ack()
        elif cmd == "RESUME":
            if self.mode == "HOLD":
                if self.insp:
                    n = self.insp["n"]
                    self.insp = None
                    self.send({"t": "go", "n": n, "res": "hold-released"})
                self.mode, self.belt = "RUN", 1
            ack()
        elif cmd == "STOP":
            if self.mode != "STOP":
                self.before, self.mode, self.belt = self.mode, "STOP", 0
            ack()
        elif cmd == "START":
            if self.mode == "STOP":
                self.mode = self.before
                self.belt = 1 if self.mode == "RUN" else 0
            ack()
        elif cmd == "REJECT":
            self.rej += 1
            self.gate_open = self.cfg["gate_open_ms"] / 1000
            self.send({"t": "gate", "n": 0})               # manual test: n 0
            ack()
        elif cmd == "BELT":
            if self.mode == "STOP":
                self.belt = 1 if parts[1:2] == ["1"] else 0
                ack()
            else:
                self.send({"t": "err", "msg": "BELT only works in STOP mode"})
        elif cmd == "RESET":
            self.parts = self.rej = 0
            ack()
        elif cmd == "SET":
            key = parts[1].lower() if len(parts) > 1 else ""
            try:
                val = int(parts[2])
            except (IndexError, ValueError):
                val = None
            if key in self.cfg and val is not None:
                self.cfg[key] = val
                ack()
                self.send({"t": "hello", "fw": "2.0.0-sim", "sensors": self.sensors(), "cfg": self.cfg})
            else:
                self.send({"t": "err", "msg": f"bad SET {' '.join(parts[1:])}"})
        else:
            self.send({"t": "err", "msg": f"unknown command {cmd}"})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--loose-every", type=float, default=60, help="seconds between loose-mount episodes (0 = never)")
    ap.add_argument("--loose-first", type=float, default=30, help="first episode starts after this many seconds")
    ap.add_argument("--loose-len", type=float, default=25, help="episode length in seconds")
    ap.add_argument("--stops", type=int, default=1, choices=(0, 1), help="1 = stop-and-inspect, 0 = continuous")
    ap.add_argument("--drop-light-at", type=float, default=0, help="light sensor disappears for 8 s at this second")
    ap.add_argument("--reboot-at", type=float, default=0, help="the board restarts at this second")
    ap.add_argument("--quit-at", type=float, default=0, help="close the port at this second (cable pulled)")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    random.seed(args.seed)

    master, slave = os.openpty()
    tty.setraw(slave)                                   # no echo: our telemetry must not come back as commands
    fl = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
    path = os.ttyname(slave)
    print(path, flush=True)
    print(f"NAZAR sim board on {path}. Start the console with NAZAR_EXTRA_PORT={path}. Ctrl-C to stop.", file=sys.stderr, flush=True)

    board = Board(master, args)
    buf = b""
    last = time.monotonic()
    rebooted = False
    try:
        while True:
            r, _, _ = select.select([master], [], [], 0.1)
            if r:
                try:
                    data = os.read(master, 4096)
                except (BlockingIOError, OSError):
                    data = b""
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    board.command(line.decode(errors="replace").strip("\r"))
            now = time.monotonic()
            if now - last >= 0.1:
                board.step(now - last)
                last = now
            up = now - board.t0
            if args.reboot_at and not rebooted and up >= args.reboot_at:
                rebooted = True
                print(f"{time.strftime('%H:%M:%S')} simulating a board reboot", flush=True)
                board.raw("ets Jun  8 2016 00:22:57")
                board.raw("rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)")
                board.boot()
            if args.quit_at and up >= args.quit_at:
                print(f"{time.strftime('%H:%M:%S')} closing the port (cable pulled)", flush=True)
                break
    except KeyboardInterrupt:
        pass
    finally:
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    main()
