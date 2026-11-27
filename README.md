# Sim Horde

**One shared world, powered by everyone's devices.** Watch it live at **[sim-horde.org](https://sim-horde.org)**.

Sim Horde is one shared world: simulated people meeting each other every day in every country, each
running on its own real statistics (income, jobs, inequality, crowding). Events are simulated, and no
real person is named: leaders appear only by office ("the President") and parties by broad family. It's too big for one computer, so volunteers power pieces of it from their phones, tablets and computers, and the world
moves forward a month each time every piece comes back. Elections, protests, coups and conflicts happen
about as often worldwide as they have in recent decades; where they land depends on the simulation.

The behavior model is tuned on California, where every test run is scored against real county data on
stress, loneliness, assaults and people moving away.

## On a phone or tablet

Open **[sim-horde.org](https://sim-horde.org)**, tap **Help from this device**, and keep the page open.
Nothing to install. It pauses on its own when the screen is off or the battery is low.

## On a desktop (Windows)

1. **Download this project.** Click the green **Code** button above, then **Download ZIP**,
   or use [this direct link](https://github.com/locastil/Sim-Horde/archive/refs/heads/main.zip).
2. **Unzip it** anywhere, for example your Desktop.
3. **Double-click `start_sim_horde.bat`** in the unzipped folder. If Windows shows "Windows protected
   your PC", click **More info**, then **Run anyway**. If Python isn't on your PC, it offers to install
   it for you: press **Y**.
4. **Wait for setup.** The first start downloads PyTorch (about 3 GB, a few minutes).
5. **Type a name** for the leaderboard and press Enter.

That's it. Jobs arrive on their own, and the window shows each one as it finishes. Close the
window to stop. Next time, just double-click `start_sim_horde.bat` again.

**Linux:** download and unzip as above, then run `./start_sim_horde.sh`.

**What you need:** an NVIDIA GPU with 4 GB of memory or more. It also works on a CPU, just slowly.
For GPUs under 6 GB, start it with `start_sim_horde.bat --max-agents 200000`.

## What runs on your computer

- **`world_kernel.py`**: runs one piece of the shared world (a few nations) for a month.
- **`sim_kernel.py`**: the California test model. Neither file has a main loop or data of its own;
  they run single jobs and nothing else.
- **`worker.py`**: the desktop app. It joins the horde, receives the county data (kept in memory only), then runs jobs
  and sends back county-level numbers.

A job is numbers only: behavior weights, each nation's conditions, a random seed, and for world jobs
the saved state of that piece of the world (arrays, loaded without pickle). It's data, not code. The
app checks every weight against its published range and never downloads or runs a program.

The coordinator sees the name you pick, your GPU model and its memory, and your results. Your
key is stored in `worker_config.json`. Keep it private.

## How results are checked

- The coordinator scores every result itself, so nobody can report their own score.
- One run in ten is repeated on a different volunteer's machine. If two runs disagree, a third
  settles it, and a device that keeps disagreeing is paused.
- Jobs not returned within 45 minutes go back in the queue.

Kudos are earned for each accepted run, plus a bonus when another volunteer's re-run matches yours.
They have no money value.

## Live progress

The live globe, this month's headlines and the leaderboard are at [sim-horde.org](https://sim-horde.org).

## License

Everything in this repository is free software under the **GNU Affero General Public License v3.0**
([LICENSE](LICENSE)): you can read, run, change and share it, and if you run a changed version for others
over a network, you must publish your changes too. The one exception is the [`server/`](server/) folder,
the code behind sim-horde.org, which is published **read-only for evaluation** under its own
[license](server/LICENSE).

Bundled libraries keep their own licenses: three.js (MIT) and MapLibre GL JS (BSD-3-Clause) in
`web/vendor/`. Map data: © OpenStreetMap contributors, OpenFreeMap, Natural Earth, GeoNames (CC BY 4.0).
