# Sim Horde server (read-only)

This is the code behind [sim-horde.org](https://sim-horde.org): the coordinator that volunteers' devices
connect to. It's here so you can check what it does, not to be run or reused. See [LICENSE](LICENSE):
**read only, for evaluation**. Everything that runs on *your* device is in the rest of this repository,
under the GNU AGPL.

| File | What it does |
|---|---|
| `coordinator.py` | Hands out work, accepts results, spot-checks them against other volunteers, keeps track of each device's trust, serves the public numbers. |
| `world_engine.py` | The shared world: splits it into pieces, closes each month, runs elections, conflicts, markets, trade and inflation. |
| `horde_status.py` | A local status page for the person running the server. |
| `trade_data.py` | Downloads trade, inflation and growth figures from the World Bank. |

Things worth checking, if you're evaluating it:

- **What is stored about volunteers:** the name they type, a random key, the device name they report
  (for example "RTX 4080 SUPER"), how much work they did, and their trust record. See the `workers`
  table in `coordinator.py`. When a device signs up, its IP address is kept for one hour (the `signups`
  table) to limit how many accounts one address can create, then deleted. Behind the Cloudflare tunnel this
  is usually Cloudflare's address, not yours.
- **How results are checked:** `submit` in `coordinator.py`, and the spot checks in `world_engine.py`.

The California tuning code it imports (`calibrate.py`) belongs to a separate, private project and isn't
included here.
