# Sim Horde

**Simulating the whole world on spare graphics cards.**

Sim Horde is a model of how people treat each other: who they meet, how stressed they are, and
whether a run-in goes well or badly. It's too big for one computer, so volunteers run pieces of it
on their own GPUs. Stage one is California. Every run is scored against real county data on
stress, loneliness, assaults and people moving away. Once it matches reality, it scales out to the
United States and then to the rest of the planet.

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

- **`sim_kernel.py`**: the behavior model, readable in full. It has no main loop and no data of
  its own. It runs single jobs and nothing else.
- **`worker.py`**: joins the horde, receives the county data (kept in memory only), then runs jobs
  and sends back county-level numbers.

A job is a list of behavior weights, a random seed and a population size. It's data, not code. The
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

The live map, progress chart and leaderboard are on the Sim Horde page. Its address is in
[`coordinator.json`](coordinator.json).
