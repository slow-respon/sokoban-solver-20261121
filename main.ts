// Sokoban solver: push-optimal, room by room.
//
// A level from make.fun's generator is a one-square-wide hallway with one to
// four small rooms off it (each in a 6x6 slot, one door onto the hallway).
// A box pushed out of a room through its door can never be pushed back, so
// every box stays in its own room and the rooms are independent problems:
// the level's push optimum is the sum of its rooms' optima, and the only
// thing joining the rooms is the player's walk between their doors.
//
// So this program cuts the level into rooms, solves each room on its own
// with an A* search over pushes, and joins the rooms' move strings with the
// walks between them. A room of 3-4 boxes in a 6x6 slot is tiny; the search
// is push-optimal on every room, hence push-optimal on the whole level.
//
// The search:
//   - A state is the boxes' squares plus the player's reachable region
//     (named by its lowest square: any two player squares in one region
//     are the same state, the walk between them costs no push).
//   - A step is one push: the player walks (for free) to the square behind
//     a box and pushes it one square. Cost 1 per push.
//   - The estimate is the Hungarian assignment of boxes to goals over
//     shortest-path distances (ignoring other boxes), which never
//     overestimates: one push moves one box one square.
//   - Deadlock pruning: a box on a square from which no sequence of pushes
//     (other boxes ignored) can reach any goal is pruned, and so is a box
//     in a frozen 2x2 block of walls and boxes with a box off its goal.
//   - The search is bounded by a state cap, never by the clock, so two
//     runs write the same bytes. A wall-clock guard only stops a runaway
//     search from eating the whole 60-second budget.
//
// Node 22 runs this file directly (erasable TypeScript syntax only).
// Standard library only, no network, no files read but the levels.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The whole run gets 60 seconds; keep a margin for startup and writing.
const STARTED_MS = Date.now();
const TIME_BUDGET_MS = 54_000;
/** The most states one room search may create before it gives up. */
const MAX_STATES_PER_SEARCH = 400_000;

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  goals: number[];
  boxes: number[];
  done: boolean;
}

/** Parse XSB text: # wall, space floor, . goal, $ box, * box on goal, @ player, + player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box alone can be pushed onto some goal, found by
 * pulling boxes back from the goals: a box on square y can be pushed onto a
 * live square x = y + d exactly when y and the player's stance y - d are
 * open floor. A square this never reaches is dead: a box there can never
 * reach a goal, whatever the other boxes do.
 */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Split a level into rooms: cut the player's row (the hallway) where its
 * squares are dead — a box in the hallway reaches no goal — and each
 * connected part of the floor that is left and holds a box is a room.
 * Null when the level is no such set of rooms (a box in the hallway, a
 * goal cut off, or a part holding a different count of boxes and goals).
 */
function roomsOf(lv: Level): Room[] | null {
  const live = liveSquares(lv);
  const row = Math.floor(lv.player / lv.w);
  const cut = new Uint8Array(lv.w * lv.h);
  for (let x = 0; x < lv.w; x++) {
    const i = row * lv.w + x;
    if (!lv.wall[i] && !live[i]) cut[i] = 1;
  }
  if (lv.boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(lv.w * lv.h).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < lv.w * lv.h; s++) {
    if (lv.wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    const stack = [s];
    part[s] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const { dx, dy } of DIRS) {
        const q = p + dy * lv.w + dx;
        if (!lv.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          stack.push(q);
        }
      }
    }
    rooms.push({ goals: [], boxes: [], done: false });
  }
  for (const b of lv.boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of lv.goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Shortest walk distances from `from` over open floor (boxes ignored), -1 where unreachable. */
function distancesFrom(lv: Level, from: number): Int32Array {
  const dist = new Int32Array(lv.w * lv.h).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const { dx, dy } of DIRS) {
      const q = p + dy * lv.w + dx;
      if (!lv.wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** All orderings of n items, as index arrays (n is at most 6 here). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/** The shortest walk from `from` to `to` around walls and `boxes`, in lower-case letters. */
function walkTo(lv: Level, boxes: number[], from: number, to: number): string {
  if (from === to) return '';
  const occupied = new Uint8Array(lv.w * lv.h);
  for (const b of boxes) occupied[b] = 1;
  const prev = new Int32Array(lv.w * lv.h).fill(-1);
  const how = new Array<string>(lv.w * lv.h).fill('');
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const { dx, dy, ch } of DIRS) {
      const q = p + dy * lv.w + dx;
      if (lv.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p] + s;
  return s;
}

/** The player's square after playing `moves` (lower-case letters) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of a (sub-)level: { pushes, moves }, or null
 * when the search gives up. A* over pushes with a Hungarian-assignment
 * estimate, dead-square and frozen-block pruning, and a transposition
 * table keyed on the boxes plus the player's reachable region.
 */
function solvePushes(lv: Level, maxStates: number, deadlineMs: number): { pushes: number; moves: string } | null {
  const size = lv.w * lv.h;
  const n = lv.boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of lv.goals) goalSet[g] = 1;
  const live = liveSquares(lv);
  if (lv.boxes.some((b) => !live[b])) return null;

  // distToGoal[g][cell]: shortest walk from goal g to cell, boxes ignored.
  const distToGoal = lv.goals.map((g) => distancesFrom(lv, g));
  const perms = n <= 6 ? permutations(n) : null;
  const estimate = (boxes: number[]): number => {
    if (perms !== null) {
      let best = Number.POSITIVE_INFINITY;
      for (const perm of perms) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = distToGoal[perm[i]!]![boxes[i]!]!;
          if (d < 0) {
            sum = Number.POSITIVE_INFINITY;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let d = Number.POSITIVE_INFINITY;
      for (let gi = 0; gi < n; gi++) {
        const v = distToGoal[gi]![b]!;
        if (v >= 0 && v < d) d = v;
      }
      if (d === Number.POSITIVE_INFINITY) return d;
      sum += d;
    }
    return sum;
  };

  // State storage, in creation order. A state's index is its identity; the
  // transposition table maps a state's canonical key to its index.
  const sBoxes: number[][] = [lv.boxes.slice()];
  const sPlayer: number[] = [lv.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sG: number[] = [0];
  // The canonical key is the boxes plus the lowest square of the player's
  // reachable region. A numeric mixed-radix key while it fits in a safe
  // integer (rooms: at most 5 squares), a string key otherwise.
  const numericKey = n <= 4;
  const indexOf = new Map<number | string, number>();
  const keyOf = (boxes: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return `${low}|${boxes.join(',')}`;
  };

  // Scratch arrays, reused across expansions. `occupied` is the current
  // state's box mask for the expansion loop; `occ2` is the helpers' own
  // mask, so they never disturb the loop's.
  const seen = new Int32Array(size);
  const seen2 = new Int32Array(size);
  const occupied = new Uint8Array(size);
  const occ2 = new Uint8Array(size);
  const stack: number[] = [];
  const stack2: number[] = [];
  let stamp = 0;
  let stamp2 = 0;

  /** Mark the player's region from `from` with `boxes` in the way; return its lowest square. */
  const reachLow = (boxes: number[], from: number): number => {
    for (const b of boxes) occ2[b] = 1;
    stamp2++;
    const mark = stamp2;
    let low = from;
    stack2.length = 0;
    stack2.push(from);
    seen2[from] = mark;
    while (stack2.length > 0) {
      const p = stack2.pop()!;
      if (p < low) low = p;
      for (const { dx, dy } of DIRS) {
        const q = p + dy * lv.w + dx;
        if (!lv.wall[q] && !occ2[q] && seen2[q] !== mark) {
          seen2[q] = mark;
          stack2.push(q);
        }
      }
    }
    for (const b of boxes) occ2[b] = 0;
    return low;
  };

  /** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
  const frozenAt = (boxes: number[], t: number): boolean => {
    for (const b of boxes) occ2[b] = 1;
    let frozen = false;
    for (const a of [t, t - 1, t - lv.w, t - lv.w - 1]) {
      const c0 = a;
      const c1 = a + 1;
      const c2 = a + lv.w;
      const c3 = c2 + 1;
      if (
        (lv.wall[c0] || occ2[c0]) &&
        (lv.wall[c1] || occ2[c1]) &&
        (lv.wall[c2] || occ2[c2]) &&
        (lv.wall[c3] || occ2[c3]) &&
        ((occ2[c0] && !goalSet[c0]) ||
          (occ2[c1] && !goalSet[c1]) ||
          (occ2[c2] && !goalSet[c2]) ||
          (occ2[c3] && !goalSet[c3]))
      ) {
        frozen = true;
        break;
      }
    }
    for (const b of boxes) occ2[b] = 0;
    return frozen;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // A binary heap of [f, g, h, sequence, state], smallest first.
  type HeapEntry = [number, number, number, number, number];
  const heap: HeapEntry[] = [];
  const heapLess = (a: HeapEntry, b: HeapEntry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[2] < b[2] || (a[2] === b[2] && a[3] < b[3])));
  const heapPush = (e: HeapEntry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let seq = 0;
  const h0 = estimate(sBoxes[0]!);
  if (!Number.isFinite(h0)) return null;
  indexOf.set(keyOf(sBoxes[0]!, reachLow(sBoxes[0]!, sPlayer[0]!)), 0);
  heapPush([h0, 0, h0, seq++, 0]);

  let found = -1;
  let expansions = 0;
  while (heap.length > 0) {
    const [, g, , , s] = heapPop();
    // A stale heap entry: a better path to this state was found since.
    if (g !== sG[s]) continue;
    const boxes = sBoxes[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    expansions++;
    if ((expansions & 1023) === 0 && Date.now() > deadlineMs) return null;
    // The player's region from this state, marked in `seen`.
    for (const b of boxes) occupied[b] = 1;
    stamp++;
    const regionMark = stamp;
    stack.length = 0;
    stack.push(sPlayer[s]!);
    seen[sPlayer[s]!] = regionMark;
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const { dx, dy } of DIRS) {
        const q = p + dy * lv.w + dx;
        if (!lv.wall[q] && !occupied[q] && seen[q] !== regionMark) {
          seen[q] = regionMark;
          stack.push(q);
        }
      }
    }
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const { dx, dy } of DIRS) {
        const d = dy * lv.w + dx;
        const stance = b - d;
        const t = b + d;
        if (seen[stance] !== regionMark) continue;
        if (lv.wall[t] || occupied[t] || !live[t]) continue;
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        if (frozenAt(next, t)) continue;
        const low = reachLow(next, b);
        const key = keyOf(next, low);
        const g2 = sG[s]! + 1;
        const idx = indexOf.get(key);
        if (idx !== undefined && sG[idx]! <= g2) continue;
        const h = estimate(next);
        if (!Number.isFinite(h)) continue;
        if (idx === undefined) {
          if (sBoxes.length >= maxStates) {
            for (const x of boxes) occupied[x] = 0;
            return null;
          }
          const ni = sBoxes.length;
          sBoxes.push(next);
          sPlayer.push(b);
          sParent.push(s);
          sFrom.push(b);
          sTo.push(t);
          sG.push(g2);
          indexOf.set(key, ni);
          heapPush([g2 + h, g2, h, seq++, ni]);
        } else {
          // A better path to a known state: rewire it and requeue it.
          sG[idx] = g2;
          sParent[idx] = s;
          sFrom[idx] = b;
          sTo[idx] = t;
          sPlayer[idx] = b;
          heapPush([g2 + h, g2, h, seq++, idx]);
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = lv.player;
  let boxes = lv.boxes.slice();
  for (const s of path) {
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = to - from;
    moves += walkTo(lv, boxes, player, from - d);
    moves += d === -lv.w ? 'u' : d === lv.w ? 'd' : d === -1 ? 'l' : 'r';
    player = from;
    boxes = boxes.slice();
    boxes[boxes.indexOf(from)] = to;
    boxes.sort((a, b) => a - b);
  }
  return { pushes: path.length, moves };
}

/** Solve one level's text, room by room; '' when a room gives up. */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  if (lv.boxes.length === 0) return '';
  const goalSet = new Uint8Array(lv.w * lv.h);
  for (const g of lv.goals) goalSet[g] = 1;
  if (lv.boxes.every((b) => goalSet[b])) return '';
  const deadlineMs = STARTED_MS + TIME_BUDGET_MS;
  const rooms = roomsOf(lv);
  if (rooms !== null) {
    let moves = '';
    let player = lv.player;
    for (const room of rooms) {
      // The other rooms' boxes stand as walls (on their goals once done).
      const wall = lv.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const c of other.done ? other.goals : other.boxes) wall[c] = 1;
      }
      const sub: Level = {
        w: lv.w,
        h: lv.h,
        wall,
        goals: room.goals.slice(),
        boxes: room.boxes.slice(),
        player,
      };
      const solved = solvePushes(sub, MAX_STATES_PER_SEARCH, deadlineMs);
      if (solved === null) return '';
      moves += solved.moves;
      player = endOf(lv.w, player, solved.moves);
      room.done = true;
    }
    return moves;
  }
  // No room structure: fall back to one search over the whole level.
  const solved = solvePushes(lv, MAX_STATES_PER_SEARCH, deadlineMs);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
