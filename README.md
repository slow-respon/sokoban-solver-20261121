# sokoban-solver-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/slow-respon/sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/slow-respon/sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. It reads every level in `/input/<id>/level.txt` (XSB) and writes the
player's moves to `/output/<id>/solution.txt`, in as few pushes as possible.

## How it works

A generated level is a one-square-wide hallway with one to four small rooms
off it. A box pushed out of a room through its door can never be pushed
back, so every box stays in its own room: the rooms are independent
problems, the level's push optimum is the sum of its rooms' optima, and
only the player's walk joins them.

1. **Split into rooms.** The hallway row is cut where its squares are dead
   (a box there reaches no goal); each connected part of the floor that is
   left and holds a box is a room.
2. **Solve each room with A\* over pushes.** A state is the boxes' squares
   plus the player's reachable region; a step is one push. The estimate is
   the Hungarian assignment of boxes to goals over shortest-path distances,
   which never overestimates. Deadlock pruning removes boxes on dead
   squares (no push sequence, other boxes ignored, reaches a goal) and
   boxes in frozen 2x2 blocks of walls and boxes.
3. **Join the rooms.** The rooms' move strings are joined with the walks
   between their doors; other rooms' boxes stand as walls while a room is
   solved. The search is bounded by a state cap, never by the clock, so two
   runs write the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node.js 22, standard library only, no network. One run answers a whole set
of 5 levels in about a second, far inside the 60-second budget.

## Results

Practice set (in the kit): **1,000,000** — every instance solved in exactly
its push-optimal count (13, 16, 29, 47, 60 pushes). Three further sets drawn
fresh from the competition's own generator also scored 1,000,000 each.
