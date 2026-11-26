# Sim Horde

**Simulating the whole world on spare graphics cards.** Watch it live at **[sim-horde.org](https://sim-horde.org)**.

Sim Horde is one shared world: simulated people meeting each other every day in every country, each
running on its own real statistics (income, jobs, inequality, crowding). Events are simulated, and no
real person is named: leaders appear only by office ("the President") and parties by broad family. It's too big for one computer, so volunteers run pieces of it on their own GPUs, and the world
moves forward a month each time every piece comes back. Elections, protests, coups and conflicts happen
about as often worldwide as they have in recent decades; where they land depends on the simulation.

The behavior model is tuned on California, where every test run is scored against real county data on
stress, loneliness, assaults and people moving away.

## Lend your GPU (Windows)

1. **Install Python** from [python.org/downloads](https://www.python.org/downloads/).
   On the first install screen, tick **"Add python.exe to PATH"**. Skip this if you already have Python 3.10 or newer.
2. **Download this project.** Click the green **Code** button above, then **Download ZIP**,
   or use [this direct link](https://github.com/locastil/Sim-Horde/archive/refs/heads/main.zip).
3. **Unzip it** anywhere, for example your Desktop.
4. **Double-click `start_worker.bat`** in the unzipped folder. If Windows shows "Windows protected
   your PC", click **More info**, then **Run anyway**.
5. **Wait for setup.** The first start installs PyTorch for NVIDIA GPUs (about 3 GB, a few minutes).
6. **Type a name** for the leaderboard and press Enter.

That's it. Jobs arrive on their own, and the window shows each one as it finishes. Close the
window to stop. Next time, just double-click `start_worker.bat` again.

**Linux:** install Python 3.10+, download and unzip as above, then run `./start_worker.sh`.

**What you need:** an NVIDIA GPU with 4 GB of memory or more. It also works on a CPU, just slowly.
For GPUs under 6 GB, start it with `start_worker.bat --max-agents 200000`.

## What runs on your computer

- **`world_kernel.py`**: runs one piece of the shared world (a few nations) for a month.
- **`sim_kernel.py`**: the California test model. Neither file has a main loop or data of its own;
  they run single jobs and nothing else.
- **`worker.py`**: joins the horde, receives the county data (kept in memory only), then runs jobs
  and sends back county-level numbers.

A job is numbers only: behavior weights, each nation's conditions, a random seed, and for world jobs
the saved state of that piece of the world (arrays, loaded without pickle). It's data, not code. The
worker checks every weight against its published range and never downloads or runs a program.

The coordinator sees the name you pick, your GPU model and its memory, and your results. Your
worker key is stored in `worker_config.json`. Keep it private.

## How results are checked

- The coordinator scores every result itself, so a worker can't report its own score.
- One run in ten is repeated on a different volunteer's machine. If two runs disagree, a third
  settles it, and a worker that keeps disagreeing is paused.
- Jobs not returned within 45 minutes go back in the queue.

Kudos are earned for each accepted run, plus a bonus when another volunteer's re-run matches yours.
They have no money value.

## Live progress

The live globe, this month's headlines and the leaderboard are at [sim-horde.org](https://sim-horde.org).
