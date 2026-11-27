"""
Sim Horde live traffic: real aircraft and ships for the globe's "Live" view.
==========================================================================
  * Aircraft - OpenSky Network (https://opensky-network.org), the public ADS-B network.
               Every ~90 s with a free account (client ID + secret), every 15 min without one.
  * Ships    - AISStream.io (https://aisstream.io), a free global AIS stream (needs a free key).

Keys live in secrets\\live_keys.json (made by setup_live_traffic.bat). They never leave this computer:
this program writes a slim snapshot to logs\\traffic.json, and the coordinator serves that at
/api/v1/traffic. Only standard Python is used (no extra packages).

Run:  python live_traffic.py           (the background service starts it for you)
"""
import base64, json, math, os, socket, ssl, struct, threading, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = os.path.join(HERE, "secrets", "live_keys.json")
OUT = os.path.join(HERE, "logs", "traffic.json")
LOG = os.path.join(HERE, "logs", "live_traffic.log")
UA = "SimHorde-live/1.0 (+https://sim-horde.org)"
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
STATES_URL = "https://opensky-network.org/api/states/all?extended=1"
MAX_PLANES, MAX_SHIPS, SHIP_TTL = 14000, 12000, 1800
PLANE_EST_SECS, SHIP_EST_SECS = 6 * 3600, 12 * 3600   # how long to keep moving a plane or ship that has left receiver range

lock = threading.Lock()
planes, planes_t = [], 0
seen = {}                       # icao24 -> [lon, lat, alt, heading, speed, callsign, category, time seen, cruising]
ships = {}                      # mmsi -> [lon, lat, cog, sog, name, kind, t]
names = {}                      # mmsi -> (name, kind)
status = dict(planes="starting", ships="starting")


def log(m):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S  ") + m + "\n")
    try:
        if os.path.getsize(LOG) > 2_000_000:
            os.replace(LOG, LOG + ".old")
    except OSError:
        pass


def keys():
    k = {}
    try:
        k = json.load(open(KEYS, encoding="utf-8-sig"))
    except Exception:
        pass
    # OpenSky's own download (credentials.json: clientId, clientSecret) works too, dropped into secrets\
    if not (k.get("opensky_client_id") and k.get("opensky_client_secret")):
        try:
            c = json.load(open(os.path.join(HERE, "secrets", "credentials.json"), encoding="utf-8-sig"))
            k["opensky_client_id"], k["opensky_client_secret"] = c.get("clientId") or c.get("client_id"), c.get("clientSecret") or c.get("client_secret")
        except Exception:
            pass
    return k


def ahead(lon, lat, heading, metres):
    """Where something ends up after `metres` along `heading` (degrees from north), on a sphere."""
    R = 6371000.0
    d, h, p1, l1 = metres / R, math.radians(heading), math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(h))
    l2 = l1 + math.atan2(math.sin(h) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return (math.degrees(l2) + 540) % 360 - 180, math.degrees(p2)


# ------------------------------------------------------------------ aircraft (OpenSky)
def opensky_loop():
    global planes, planes_t
    token, token_exp = None, 0
    while True:
        k = keys()
        cid, sec = (k.get("opensky_client_id") or "").strip(), (k.get("opensky_client_secret") or "").strip()
        wait = 90 if cid and sec else 900
        try:
            hdr = {"User-Agent": UA}
            if cid and sec:
                if not token or time.time() > token_exp - 60:
                    body = urllib.parse.urlencode(dict(grant_type="client_credentials", client_id=cid, client_secret=sec)).encode()
                    r = json.load(urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body, headers=hdr), timeout=30))
                    token, token_exp = r["access_token"], time.time() + int(r.get("expires_in", 1800))
                hdr["Authorization"] = "Bearer " + token
            with urllib.request.urlopen(urllib.request.Request(STATES_URL, headers=hdr), timeout=60) as resp:
                d = json.load(resp)
                left = resp.headers.get("X-Rate-Limit-Remaining")
            now_t = int(d.get("time") or time.time())
            here = set()
            for s in d.get("states") or []:
                lon, lat = s[5], s[6]
                if lon is None or lat is None or s[8]:            # no position, or on the ground
                    seen.pop(s[0], None)
                    continue
                alt = s[13] if s[13] is not None else s[7]
                if alt is None or not (0 <= alt <= 16000) or (s[9] or 0) > 350:    # drop garbled reports
                    continue
                t_pos = s[3] or now_t
                cruising = alt >= 7000 and (s[11] or 0) > -3          # high up and not coming down to land
                seen[s[0]] = [lon, lat, int(alt), int(s[10] or 0), int(s[9] or 0), (s[1] or "").strip(),
                              s[17] if len(s) > 17 and s[17] is not None else 0, t_pos, cruising]
                here.add(s[0])
            out = []
            for k, v in list(seen.items()):
                age = now_t - v[7]
                if k in here and age < 120:
                    out.append([round(v[0], 3), round(v[1], 3), v[2], v[3], v[4], v[5], v[6], 0])
                elif v[8] and age < PLANE_EST_SECS:                 # out of range over the sea: carry on along its heading
                    lon, lat = ahead(v[0], v[1], v[3], v[4] * age)
                    out.append([round(lon, 3), round(lat, 3), v[2], v[3], v[4], v[5], v[6], 1])
                else:
                    del seen[k]
            out.sort(key=lambda p: (p[7], -p[2]))                    # tracked first, then estimated
            with lock:
                planes, planes_t = out[:MAX_PLANES], int(d.get("time") or time.time())
            status["planes"] = f"ok: {len(out)} in the air ({sum(p[7] for p in out)} estimated)" + (f", {left} credits left today" if left else "")
            if left is not None and int(left) < 40:
                wait = max(wait, 1800)
        except urllib.error.HTTPError as e:
            status["planes"] = f"OpenSky said {e.code}"
            log(f"opensky http {e.code}")
            if e.code in (401, 403):
                token = None
            wait = 1800 if e.code == 429 else max(wait, 300)
        except Exception as e:
            status["planes"] = f"error: {e}"
            log(f"opensky {e!r}")
            wait = max(wait, 120)
        time.sleep(wait)


# ------------------------------------------------------------------ ships (AISStream, a tiny websocket client)
def kind_of(t):
    t = int(t or 0)
    if 70 <= t <= 79: return "cargo"
    if 80 <= t <= 89: return "tanker"
    if 60 <= t <= 69: return "passenger"
    if t == 30: return "fishing"
    if t in (31, 32, 52): return "tug"
    if t == 35: return "military"
    if t in (36, 37): return "pleasure"
    return "other"


class WS:
    def __init__(self, host, path):
        raw = socket.create_connection((host, 443), timeout=60)
        self.s = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: {UA}\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            c = self.s.recv(1)
            if not c:
                raise ConnectionError("closed during handshake")
            head += c
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.split(b"\r\n")[0].decode(errors="replace"))
        self.buf = b""

    def _read(self, n):
        while len(self.buf) < n:
            c = self.s.recv(65536)
            if not c:
                raise ConnectionError("closed")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, data, op=1):
        data = data.encode() if isinstance(data, str) else data
        mask = os.urandom(4)
        n = len(data)
        hdr = bytes([0x80 | op]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536
                                     else bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126: n = struct.unpack(">H", self._read(2))[0]
            elif n == 127: n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 9:
                self.send(data, 10); continue
            if op == 8:
                raise ConnectionError("server closed the stream")
            if op in (0, 1, 2):
                msg += data
                if b0 & 0x80:
                    return msg


def ais_loop():
    while True:
        key = (keys().get("aisstream_key") or "").strip()
        if not key:
            status["ships"] = "no AISStream key yet (run setup_live_traffic.bat)"
            time.sleep(60); continue
        try:
            ws = WS("stream.aisstream.io", "/v0/stream")
            ws.send(json.dumps(dict(APIKey=key, BoundingBoxes=[[[-90, -180], [90, 180]]],
                                    FilterMessageTypes=["PositionReport", "StandardClassBPositionReport", "ShipStaticData"])))
            status["ships"] = "connected"
            log("aisstream connected")
            while True:
                raw = ws.recv()
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if "error" in m:
                    raise ConnectionError(str(m["error"])[:200])
                meta, typ, body = m.get("MetaData") or {}, m.get("MessageType"), (m.get("Message") or {})
                mmsi = meta.get("MMSI")
                if not mmsi:
                    continue
                if typ == "ShipStaticData":
                    sd = body.get("ShipStaticData") or {}
                    if len(names) > 300000:
                        names.clear()
                    names[mmsi] = ((sd.get("Name") or meta.get("ShipName") or "").strip(), kind_of(sd.get("Type")))
                    continue
                pr = body.get(typ) or {}
                lat, lon = pr.get("Latitude"), pr.get("Longitude")
                if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
                    continue
                nm, kd = names.get(mmsi, ((meta.get("ShipName") or "").strip(), "other"))
                sog = pr.get("Sog") or 0
                cog = pr.get("Cog") or 0
                with lock:
                    ships[mmsi] = [round(lon, 3), round(lat, 3), int(cog) % 360, round(min(sog, 60), 1), nm, kd, time.time()]
        except Exception as e:
            status["ships"] = f"reconnecting ({e})"
            log(f"aisstream {e!r}")
            time.sleep(20)


# ------------------------------------------------------------------ the snapshot the coordinator serves
def writer_loop():
    while True:
        time.sleep(30)
        now = time.time()
        with lock:
            for k in [k for k, v in ships.items() if now - v[6] > (SHIP_EST_SECS if v[3] >= 3 else SHIP_TTL)]:
                del ships[k]
            sh = []
            for v in ships.values():
                age = now - v[6]
                if age <= SHIP_TTL:
                    sh.append([v[0], v[1], v[2], v[3], v[4], v[5], 0])
                else:                                               # out of range at sea: carry on along its course
                    lon, lat = ahead(v[0], v[1], v[2], v[3] * 0.5144 * age)
                    sh.append([round(lon, 3), round(lat, 3), v[2], v[3], v[4], v[5], 1])
            sh.sort(key=lambda v: (v[6], v[3] < 0.5))                 # reported, then estimated; moving first
            sh = sh[:MAX_SHIPS]
            snap = dict(t=int(now), planes_t=planes_t, planes=planes, estimated=dict(planes_hours=PLANE_EST_SECS // 3600, ships_hours=SHIP_EST_SECS // 3600),
                        ships=sh, status=dict(status),
                        sources=["Aircraft: The OpenSky Network, https://opensky-network.org",
                                 "Ships: AISStream.io, https://aisstream.io"])
        tmp = OUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, OUT)


if __name__ == "__main__":
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    log("starting")
    for fn in (opensky_loop, ais_loop):
        threading.Thread(target=fn, daemon=True).start()
    writer_loop()
