/* Rainbow Ants
   Ants with see-through abdomens drink from drops of coloured sugar water. Their
   abdomens swell and take on the colour (mixing it when they visit more than one
   drop), the drops shrink as they are drunk, and full ants leave by the top door. */
(() => {
  'use strict';

  // ── Arena ────────────────────────────────────────────────────────────────
  const W = 900, H = 600;                  // canvas size in CSS pixels
  const WALL = 16;                         // wall thickness
  const DOOR_X = W / 2, DOOR_HALF = 36;    // both doorways are centred and 72px wide
  const TAU = Math.PI * 2;
  const LIGHT_X = -0.55, LIGHT_Y = -0.83;  // the lamp is up and to the left

  // ── Tuning ───────────────────────────────────────────────────────────────
  const DROP_VOLUME = 26;    // smallest drop: enough to fill 26 ants to the brim
  const DROP_RADIUS = 54;    // px, for a full drop of that size
  const SPARE = 1.2;         // between them, the drops hold 20% more than all the ants can drink
  const MAX_RADIUS = [0, 110, 85, 70, 58];   // px, the biggest a drop can be for 1–4 drops
  const DRINK_RATE = 0.13;   // share of a full crop drunk per second
  const CLEARANCE = 40;      // berth walking ants give drops they aren't heading for
  const REACH = 14.6;        // thorax centre to mandible tip, in body units

  // Drop positions for one to four colours. Drops can be dragged before a run.
  const LAYOUTS = [
    [],
    [[450, 292]],
    [[312, 282], [588, 308]],
    [[300, 222], [602, 212], [452, 408]],
    [[288, 206], [614, 192], [304, 412], [598, 404]],
  ];

  // Leg geometry for the right side (the left side mirrors it): hip position, then
  // femur and tibia angles (radians back from straight ahead) and lengths.
  const LEGS = [
    { hx: 3.6, hy: 1.3, fa: 0.95, fl: 5.4, ta: 0.35, tl: 6.2 },
    { hx: 1.2, hy: 1.6, fa: 1.6, fl: 5.4, ta: 2.05, tl: 6.4 },
    { hx: -1.2, hy: 1.5, fa: 2.25, fl: 6.2, ta: 2.75, tl: 8.4 },
  ];

  // ── Helpers ──────────────────────────────────────────────────────────────
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const wrap = (a) => ((a % TAU) + TAU) % TAU;
  // Signed smallest rotation that takes angle a to angle b.
  const turnTo = (a, b) => {
    let d = (b - a) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return d;
  };

  // ── Dyes and colour mixing ───────────────────────────────────────────────
  // Each dye is defined by how it looks in the middle of a full drop. From that we
  // work out how strongly it absorbs red, green and blue light (Beer–Lambert), so
  // mixtures behave like food colouring: yellow and blue make green, red and yellow
  // make orange, and a fuller abdomen shows a deeper colour.
  const DYES = [
    { name: 'Red', hex: '#d81e3c' },
    { name: 'Yellow', hex: '#f5c400' },
    { name: 'Blue', hex: '#1b62d6' },
    { name: 'Green', hex: '#169b45' },
  ];
  const PAPER = [0.93, 0.915, 0.88];  // linear reflectance of the white card
  const CROP = [0.92, 0.86, 0.76];    // linear tint of the abdomen wall

  const toLinear = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const toByte = (v) => {
    v = v <= 0 ? 0 : v >= 1 ? 1 : v;
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  };

  DYES.forEach((dye, i) => {
    const lin = [1, 3, 5].map((k) => toLinear(parseInt(dye.hex.slice(k, k + 2), 16)));
    dye.absorb = lin.map((v, c) => Math.max(0, -Math.log10(Math.max(v, 0.003) / PAPER[c])));
    dye.pure = DYES.map((_, j) => (j === i ? 1 : 0));
  });

  // Colour of `base` seen through `depth` of a dye mixture (`shares` sum to 1).
  function tint(shares, depth, base, alpha = 1) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < DYES.length; i++) {
      const s = shares[i];
      if (s > 0) {
        const A = DYES[i].absorb;
        r += s * A[0];
        g += s * A[1];
        b += s * A[2];
      }
    }
    const R = toByte(base[0] * Math.pow(10, -r * depth));
    const G = toByte(base[1] * Math.pow(10, -g * depth));
    const B = toByte(base[2] * Math.pow(10, -b * depth));
    return alpha >= 1 ? `rgb(${R},${G},${B})` : `rgba(${R},${G},${B},${alpha.toFixed(3)})`;
  }

  // How much liquid light passes through in an abdomen that is `fill` full.
  const cropDepth = (fill) => 1.25 * Math.pow(fill, 0.55);

  // ── Simulation state ─────────────────────────────────────────────────────
  const settings = { ants: 25, fullness: 0.75, hopping: 0.5, speed: 1, dyes: [true, false, false, false] };
  const sim = {
    state: 'setup',      // setup → running ⇄ paused → done
    drops: [],
    ants: [],
    gone: [],            // what each departed ant carried out
    total: 0,
    spawned: 0,
    spawnTimer: 0,
    time: 0,             // simulated seconds; drives the ants
    clock: 0,            // real seconds, frozen while paused; drives the drops' shimmer
    placed: {},          // dye index → [x, y] for drops that have been dragged
  };

  // ── Drops ────────────────────────────────────────────────────────────────
  class Drop {
    constructor(dye, x, y) {
      this.dye = dye;
      this.x = x;
      this.y = y;
      this.capacity = DROP_VOLUME;   // volume when full
      this.volume = DROP_VOLUME;
      this.fullRadius = DROP_RADIUS;
      this.seed = rand(0, 100);
      this.ripples = [];
      this.drinkers = [];
    }
    get level() { return this.volume / this.capacity; }
    get radius() { return this.volume > 0 ? this.fullRadius * Math.pow(this.level, 0.45) : 0; }
  }

  function layDrops(fresh) {
    if (fresh) sim.placed = {};
    const dyes = [];
    settings.dyes.forEach((on, i) => on && dyes.push(i));
    const spots = LAYOUTS[dyes.length];
    sim.drops = dyes.map((dye, k) => {
      const [x, y] = sim.placed[dye] || spots[k];
      return new Drop(dye, x, y);
    });
    sizeDrops();
  }

  // Fill the drops so every ant can drink its fill with some to spare. More ants means
  // bigger drops, as big as the layout has room for.
  function sizeDrops() {
    const n = sim.drops.length;
    if (!n) return;
    const capacity = Math.max(DROP_VOLUME, (SPARE * settings.ants) / n);
    const fullRadius = Math.min(MAX_RADIUS[n], DROP_RADIUS * Math.cbrt(capacity / DROP_VOLUME));
    for (const d of sim.drops) {
      d.capacity = d.volume = capacity;
      d.fullRadius = fullRadius;
    }
    for (const d of sim.drops) settle(d, d.x, d.y);
  }

  // Put a drop at (x, y), or as near as fits: clear of the walls and doorways, with a
  // walkway between it and the other drops.
  function settle(d, x, y) {
    const r = d.fullRadius;
    const fit = () => {
      x = clamp(x, WALL + r + 30, W - WALL - r - 30);
      y = clamp(y, WALL + r + 70, H - WALL - r - 90);
    };
    fit();
    for (const o of sim.drops) {
      if (o === d) continue;
      const dx = x - o.x, dy = y - o.y, dist = Math.hypot(dx, dy) || 1, min = r + o.fullRadius + 46;
      if (dist < min) {
        x = o.x + (dx / dist) * min;
        y = o.y + (dy / dist) * min;
      }
    }
    fit();
    d.x = x;
    d.y = y;
  }

  // ── Ants ─────────────────────────────────────────────────────────────────
  // States: enter (coming through the bottom door) → seek (walking to a place at a
  // drop's edge) → drink → seek another drop, or leave by the top door. An ant that
  // finds no room at its drop waits nearby and tries again.
  class Ant {
    constructor(x, y) {
      this.x = x;
      this.y = y;
      this.size = rand(0.98, 1.14);
      this.heading = -Math.PI / 2 + rand(-0.2, 0.2);
      this.speed = 0;
      this.topSpeed = rand(62, 80);
      this.state = 'enter';
      this.goal = { x: DOOR_X + rand(-24, 24), y: H - WALL - rand(36, 64) };
      this.outbound = false;
      this.crop = [0, 0, 0, 0];     // how much of each dye it has drunk
      this.fill = 0;                // total, where 1 is brim full
      this.appetite = rand(0.86, 1.1);
      this.front = [0, 0, 0, 0];    // colour mix shown at the waist end of the abdomen
      this.back = [0, 0, 0, 0];     // and at the tip, which catches up more slowly
      this.drop = null;
      this.slot = 0;                // angle round the drop where this ant drinks
      this.near = 0;                // seconds spent just short of that place
      this.quota = Infinity;        // how much to drink at this drop before moving on
      this.sipping = false;
      this.sipDye = 0;
      this.rippleIn = rand(0.3, 1);
      this.pause = 0;
      this.retry = 0;
      this.waitPoint = null;
      this.circling = Math.random() < 0.5 ? -1 : 1;   // which way it drifts round a busy drop
      this.avoid = null;            // which way round an obstacle, so it doesn't dither
      this.age = rand(0, 100);
      this.legPhase = rand(0, TAU);
      this.gait = 0;
      this.wiggle = [rand(0, TAU), rand(0, TAU), rand(0, TAU)];
      const tone = rand(-8, 10);
      this.bodyColour = `rgb(${(34 + tone) | 0},${(24 + tone * 0.75) | 0},${(19 + tone * 0.55) | 0})`;
      this.legColour = `rgba(${(56 + tone) | 0},${(40 + tone * 0.8) | 0},${(30 + tone * 0.6) | 0},0.95)`;
    }

    get reach() { return REACH * this.size; }
    get target() { return Math.min(1, settings.fullness * this.appetite); }
    get isFull() { return this.fill >= this.target - 0.003; }
    get bellyHalfWidth() { return (3.9 + 4.5 * Math.pow(this.fill, 0.85)) * this.size; }

    update(dt) {
      this.age += dt;
      this.sipping = false;
      if (this.pause > 0) this.pause -= dt;
      else if (this.state !== 'drink' && this.y > WALL + 30 && this.y < H - WALL - 30 && Math.random() < dt * 0.09) {
        this.pause = rand(0.15, 0.5);   // stop to feel about with the antennae
      }
      if (this.state === 'enter') this.enter(dt);
      else if (this.state === 'seek') this.seek(dt);
      else if (this.state === 'drink') this.drink(dt);
      else if (this.state === 'wait') this.wait(dt);
      else this.leave(dt);
      this.mix(dt);
    }

    // Head for (tx, ty), going round any drop in the way. Returns the distance left.
    walk(tx, ty, dt, drop = null, pace = 1, wander = 1) {
      route(this, tx, ty, drop);
      const dist = Math.hypot(tx - this.x, ty - this.y);
      const want = Math.atan2(way.y - this.y, way.x - this.x) + this.meander() * wander * Math.min(1, dist / 90);
      const diff = turnTo(this.heading, want);
      const maxTurn = (dist < 30 ? 8 : 4.5) * dt;
      const turn = clamp(diff, -maxTurn, maxTurn);
      this.heading += turn;
      let v = this.pause > 0 ? 0 : this.topSpeed * pace * (1 - 0.42 * this.fill);   // full ants are slow
      v *= 1 - 0.55 * Math.min(1, Math.abs(diff) / 1.5);
      v *= clamp(dist / 24, 0.2, 1);
      this.speed += (v - this.speed) * (1 - Math.exp(-8 * dt));
      const step = this.speed * dt;
      this.x += Math.cos(this.heading) * step;
      this.y += Math.sin(this.heading) * step;
      this.stride(step, turn, dt);
      return dist;
    }

    meander() {
      const t = this.age, w = this.wiggle;
      return 0.22 * Math.sin(1.1 * t + w[0]) + 0.13 * Math.sin(2.4 * t + w[1]) + 0.07 * Math.sin(4.9 * t + w[2]);
    }

    stride(step, turn, dt) {
      const moved = step + Math.abs(turn) * 4.5 * this.size;
      this.legPhase += (moved / (12 * this.size)) * TAU;
      const pace = dt > 0 ? moved / dt : 0;
      this.gait += (Math.min(1, pace / 28) - this.gait) * (1 - Math.exp(-10 * dt));
    }

    enter(dt) {
      const left = this.walk(this.goal.x, this.goal.y, dt, null, 1, 0.4);
      if (left < 12 || this.y < this.goal.y) {
        this.pause = rand(0.1, 0.45);
        this.pickDrop(null, true);
      }
    }

    // Choose a drop: the nearest one when `nearest` is set (on the way in), otherwise
    // one at random, and a different one when moving on from `leaving`.
    pickDrop(leaving, nearest = false) {
      const wet = sim.drops.filter((d) => d.volume > 0);
      if (!wet.length) return this.exit();
      const pool = leaving && wet.length > 1 ? wet.filter((d) => d !== leaving) : wet;
      const need = this.target - this.fill;
      this.drop = nearest ? this.closest(pool) : pool[(Math.random() * pool.length) | 0];
      this.quota = wet.length > 1 && Math.random() < settings.hopping ? Math.max(0.06, need * rand(0.3, 0.65)) : Infinity;
      this.claim();
    }

    // The drop whose edge is nearest to this ant.
    closest(drops) {
      let best = null, bestGap = Infinity;
      for (const d of drops) {
        const gap = Math.hypot(d.x - this.x, d.y - this.y) - d.radius;
        if (gap < bestGap) {
          bestGap = gap;
          best = d;
        }
      }
      return best;
    }

    claim() {
      const d = this.drop;
      // aim for the near side of the drop, give or take, so the ring fills from all round
      const slot = findSlot(d, Math.atan2(this.y - d.y, this.x - d.x) + rand(-0.8, 0.8), this);
      if (slot === null) {
        this.state = 'wait';
        this.retry = rand(0.4, 1);
        this.waitPoint = null;
      } else {
        this.slot = slot;
        this.state = 'seek';
      }
    }

    seek(dt) {
      const d = this.drop;
      if (d.volume <= 0) return this.pickDrop(d);
      if (this.isFull) return this.exit();
      const r = d.radius, at = r + this.reach - 1.5;
      const sx = d.x + Math.cos(this.slot) * at, sy = d.y + Math.sin(this.slot) * at;
      let tx = sx, ty = sy;
      const ox = this.x - d.x, oy = this.y - d.y;
      const bearing = Math.atan2(oy, ox), off = turnTo(bearing, this.slot);
      if (Math.hypot(ox, oy) < r + 80 && Math.abs(off) > 0.45) {
        // wrong side of the drop: work round outside the ring of drinkers
        const a = bearing + Math.sign(off) * 0.55;
        tx = d.x + Math.cos(a) * (r + CLEARANCE);
        ty = d.y + Math.sin(a) * (r + CLEARANCE);
      }
      this.walk(tx, ty, dt, d, 1, 0.7);
      // Arrived, or close enough for a moment while neighbours are in the way:
      // once drinking, the ring shuffles to make room.
      const gap = Math.hypot(sx - this.x, sy - this.y);
      this.near = gap < 12 ? this.near + dt : 0;
      if (gap < 4 || this.near > 0.6) {
        this.state = 'drink';
        this.pause = 0;
        this.near = 0;
      }
    }

    drink(dt) {
      const d = this.drop;
      if (d.volume <= 0) return this.moveOn();
      // stay at the edge as the drop shrinks and neighbours shuffle
      const at = d.radius + this.reach - 1.5;
      const tx = d.x + Math.cos(this.slot) * at, ty = d.y + Math.sin(this.slot) * at;
      const dx = tx - this.x, dy = ty - this.y, dist = Math.hypot(dx, dy);
      const step = Math.min(dist, 26 * dt);
      if (dist > 1e-3) {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
      const diff = turnTo(this.heading, this.slot + Math.PI);
      const turn = clamp(diff, -5 * dt, 5 * dt);
      this.heading += turn;
      this.speed = 0;
      this.stride(step, turn, dt);
      if (Math.abs(diff) > 0.3 || dist > 3) return;
      const sip = Math.min(DRINK_RATE * dt, d.volume, this.target - this.fill, this.quota);
      if (sip > 0) {
        d.volume -= sip;
        if (d.volume < 0.02) d.volume = 0;
        this.crop[d.dye] += sip;
        this.fill += sip;
        this.quota -= sip;
        this.sipping = true;
        this.sipDye = d.dye;
        if ((this.rippleIn -= dt) <= 0) {
          this.rippleIn = rand(0.6, 1.4);
          d.ripples.push({ a: this.slot, age: 0 });
        }
      }
      if (this.isFull || this.quota <= 1e-4) this.moveOn();
    }

    moveOn() {
      const from = this.drop;
      this.pause = rand(0.4, 1);   // a moment to clean the antennae
      if (this.isFull) return this.exit();
      this.pickDrop(from);
    }

    // Squeezed out of a crowded drop.
    bumped() {
      if (this.fill >= 0.8 * this.target) return this.exit();
      this.pickDrop(this.drop);
    }

    wait(dt) {
      const d = this.drop;
      if (d.volume <= 0) return this.pickDrop(d);
      if (this.isFull) return this.exit();
      if ((this.retry -= dt) <= 0) {
        this.retry = rand(0.5, 1.2);
        const slot = findSlot(d, Math.atan2(this.y - d.y, this.x - d.x), this);
        if (slot !== null) {
          this.slot = slot;
          this.state = 'seek';
          return;
        }
        if (Math.random() < 0.3 && sim.drops.some((o) => o !== d && o.volume > 0)) return this.pickDrop(d);
      }
      // drift round the drop just outside the crowd, looking for a gap
      const wp = this.waitPoint;
      if (!wp || Math.hypot(wp.x - this.x, wp.y - this.y) < 6) {
        const a = Math.atan2(this.y - d.y, this.x - d.x) + this.circling * rand(0.15, 0.55);
        const rr = d.radius + rand(44, 62);
        this.waitPoint = {
          x: clamp(d.x + Math.cos(a) * rr, WALL + 20, W - WALL - 20),
          y: clamp(d.y + Math.sin(a) * rr, WALL + 20, H - WALL - 20),
        };
      }
      this.walk(this.waitPoint.x, this.waitPoint.y, dt, d, 0.45, 1);
    }

    exit() {
      this.state = 'leave';
      this.drop = null;
      this.outbound = false;
      this.goal = { x: DOOR_X + rand(-18, 18), y: WALL + rand(36, 54) };
    }

    leave(dt) {
      if (!this.outbound && Math.hypot(this.goal.x - this.x, this.goal.y - this.y) < 30) this.outbound = true;
      if (this.outbound) this.walk(this.goal.x, -40, dt, null, 1, 0.15);
      else this.walk(this.goal.x, this.goal.y, dt, null, 1, 0.8);
    }

    // Ease the displayed colours towards what's actually in the crop. While sipping,
    // the waist end shows the fresh intake and the tip catches up over a few seconds.
    mix(dt) {
      if (this.fill <= 0) return;
      const first = this.front[0] + this.front[1] + this.front[2] + this.front[3] === 0;
      const kf = first ? 1 : 1 - Math.exp(-dt / 0.5);
      const kb = first ? 1 : 1 - Math.exp(-dt / 3.5);
      const dye = this.sipping ? this.sipDye : -1;
      for (let i = 0; i < 4; i++) {
        const share = this.crop[i] / this.fill;
        const fresh = dye < 0 ? share : share + ((i === dye ? 1 : 0) - share) * 0.45;
        this.front[i] += (fresh - this.front[i]) * kf;
        this.back[i] += (share - this.back[i]) * kb;
      }
    }
  }

  // ── Getting around ───────────────────────────────────────────────────────
  const way = { x: 0, y: 0 };

  // Where an ant should head so that its path to (tx, ty) doesn't cross a drop
  // (other than `ignore`, the one it's going to). The answer goes in `way`.
  function route(ant, tx, ty, ignore) {
    way.x = tx;
    way.y = ty;
    const ax = ant.x, ay = ant.y;
    const len = Math.hypot(tx - ax, ty - ay);
    if (len < 1) return;
    const ux = (tx - ax) / len, uy = (ty - ay) / len;
    let block = null, nearest = Infinity, across = 0, reach = 0;
    for (const d of sim.drops) {
      if (d === ignore || d.volume <= 0) continue;
      const rr = d.radius + CLEARANCE;
      const cx = d.x - ax, cy = d.y - ay, dist = Math.hypot(cx, cy);
      if (dist < rr) {
        // In the crowd round this drop. If the goal is on the far side, walk round.
        const nx = -cx / dist, ny = -cy / dist;
        if (ux * nx + uy * ny > -0.2) continue;
        const side = sideFor(ant, d, -ny * ux + nx * uy >= 0 ? 1 : -1);
        way.x = ax + (-ny * side * 0.9 + nx * 0.45) * 30;
        way.y = ay + (nx * side * 0.9 + ny * 0.45) * 30;
        return;
      }
      const along = cx * ux + cy * uy;
      if (along <= 0 || along - rr > len) continue;
      const off = cx * uy - cy * ux;   // > 0 when the drop is on our left
      if (Math.abs(off) < rr && along < nearest) {
        nearest = along;
        block = d;
        across = off;
        reach = rr;
      }
    }
    if (!block) {
      ant.avoid = null;
      return;
    }
    // +1 goes round clockwise (past the drop's left side), -1 anticlockwise
    const side = sideFor(ant, block, across > 0 ? -1 : 1);
    way.x = block.x + uy * side * (reach + 8);
    way.y = block.y - ux * side * (reach + 8);
  }

  function sideFor(ant, drop, preferred) {
    if (!ant.avoid || ant.avoid.drop !== drop) ant.avoid = { drop, side: preferred };
    return ant.avoid.side;
  }

  // Angle two ants need between them to drink side by side at a drop of radius r.
  function slotGap(r, a, b) {
    const heads = (4.6 * (a.size + b.size)) / (r + 3);
    const bellies = (a.bellyHalfWidth + b.bellyHalfWidth + 1.5) / (r + 26);
    return Math.max(heads, bellies);
  }

  // A free place on the drop's edge, as close as possible to the angle `prefer`.
  function findSlot(drop, prefer, self) {
    const r = drop.radius;
    if (r < 5) return null;
    const others = sim.ants.filter((a) => a !== self && a.drop === drop && (a.state === 'drink' || a.state === 'seek'));
    for (let k = 0; k < 80; k++) {
      const ang = prefer + (k & 1 ? 1 : -1) * Math.ceil(k / 2) * 0.08;
      if (others.every((o) => Math.abs(turnTo(o.slot, ang)) >= slotGap(r, self, o))) return ang;
    }
    return null;
  }

  // Ants drinking at the same drop shuffle sideways to make room for each other,
  // more so as their abdomens swell and the drop shrinks.
  function relaxRing(drop, dt) {
    const ring = drop.drinkers, n = ring.length;
    if (n < 2) return;
    for (const a of ring) a.slot = wrap(a.slot);
    ring.sort((a, b) => a.slot - b.slot);
    const r = drop.radius;
    let room = 0;
    for (let i = 0; i < n; i++) room += slotGap(r, ring[i], ring[(i + 1) % n]);
    if (room > TAU) {
      // not enough edge for everyone: the fullest ant gives up its place
      let out = ring[0];
      for (const a of ring) if (a.fill > out.fill) out = a;
      out.bumped();
      return;
    }
    const most = 0.35 * dt;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      let gap = b.slot - a.slot;
      if (gap <= 0) gap += TAU;
      const need = slotGap(r, a, b);
      if (gap < need) {
        const push = Math.min((need - gap) / 2, most);
        a.slot -= push;
        b.slot += push;
      }
    }
  }

  // Walking ants nudge each other apart. Drinking ants hold their ground.
  function separate() {
    const ants = sim.ants, n = ants.length;
    for (let i = 0; i < n; i++) {
      const a = ants[i], aFixed = a.state === 'drink';
      for (let j = i + 1; j < n; j++) {
        const b = ants[j], bFixed = b.state === 'drink';
        if (aFixed && bFixed) continue;
        // full ants squeeze past each other in the exit doorway
        const squeeze = a.state === 'leave' && b.state === 'leave' && a.y < WALL + 50 && b.y < WALL + 50;
        const min = (aFixed || bFixed ? 5.5 : squeeze ? 4.5 : 7) * (a.size + b.size);
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), push = (min - d) * 0.4, ux = dx / d, uy = dy / d;
        const ka = aFixed ? 0 : bFixed ? 1 : 0.5, kb = 1 - ka;
        a.x -= ux * push * ka;
        a.y -= uy * push * ka;
        b.x += ux * push * kb;
        b.y += uy * push * kb;
      }
    }
  }

  // Walls, doorways (in at the bottom, out at the top) and no wading through drops.
  function confine(a) {
    const m = 8, inner = DOOR_HALF - 6;
    if (a.y > H - WALL - m) {
      if (a.state === 'enter') a.x = clamp(a.x, DOOR_X - inner, DOOR_X + inner);
      else a.y = H - WALL - m;
    }
    if (a.y < WALL + m) {
      if (a.state === 'leave' && Math.abs(a.x - DOOR_X) < inner + 2) a.x = clamp(a.x, DOOR_X - inner, DOOR_X + inner);
      else a.y = WALL + m;
    }
    a.x = clamp(a.x, WALL + m, W - WALL - m);
    for (const d of sim.drops) {
      if (d.volume <= 0) continue;
      const own = a.drop === d && (a.state === 'drink' || a.state === 'seek');
      const min = d.radius + (own ? a.reach - 2 : a.reach);
      const dx = a.x - d.x, dy = a.y - d.y, dist = Math.hypot(dx, dy);
      if (dist < min && dist > 1e-3) {
        a.x = d.x + (dx / dist) * min;
        a.y = d.y + (dy / dist) * min;
      }
    }
  }

  // Let the next ant in through the bottom door, if it's time and there's room.
  function release(dt) {
    if (sim.spawned >= sim.total) return;
    if ((sim.spawnTimer -= dt) > 0) return;
    const x = DOOR_X + rand(-20, 20), y = H + 18;
    if (sim.ants.some((a) => Math.abs(a.x - x) < 11 && Math.abs(a.y - y) < 14)) return;
    sim.ants.push(new Ant(x, y));
    sim.spawned++;
    sim.spawnTimer = clamp(12 / sim.total, 0.09, 0.6) * rand(0.5, 1.5);
  }

  function step(dt) {
    sim.time += dt;
    release(dt);
    for (const d of sim.drops) d.drinkers.length = 0;
    for (const a of sim.ants) if (a.state === 'drink') a.drop.drinkers.push(a);
    for (const d of sim.drops) relaxRing(d, dt);
    for (const a of sim.ants) a.update(dt);
    separate();
    for (const a of sim.ants) confine(a);
    for (const d of sim.drops) {
      for (const rp of d.ripples) rp.age += dt;
      if (d.ripples.length && d.ripples[0].age > 1.2) d.ripples = d.ripples.filter((rp) => rp.age <= 1.2);
    }
    for (let i = sim.ants.length - 1; i >= 0; i--) {
      const a = sim.ants[i];
      if (a.state === 'leave' && a.y < -22) {
        sim.ants.splice(i, 1);
        depart(a);
      }
    }
    if (sim.spawned >= sim.total && !sim.ants.length) finish();
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  const canvas = document.getElementById('arena');
  const ctx = canvas.getContext('2d');
  const paper = document.createElement('canvas');
  const overlay = document.createElement('canvas');
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let dpr = 0;

  // A soft blob, stretched under each ant as its shadow.
  const BLOB = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(48,34,22,0.34)');
    grad.addColorStop(0.6, 'rgba(48,34,22,0.15)');
    grad.addColorStop(1, 'rgba(48,34,22,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  })();

  function fitCanvas() {
    const next = Math.min(2, window.devicePixelRatio || 1);
    if (next === dpr) return;
    dpr = next;
    for (const c of [canvas, paper, overlay]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    paintPaper();
    paintOverlay();
  }

  // White card with a little grain, a few fibres and fall-off from the lamp.
  function paintPaper() {
    const g = paper.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f6f4ee';
    g.fillRect(0, 0, paper.width, paper.height);
    const img = g.getImageData(0, 0, paper.width, paper.height), px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const n = (Math.random() - 0.5) * 7;
      px[i] += n;
      px[i + 1] += n;
      px[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 0.5;
    for (let i = 0; i < 240; i++) {
      const x = rand(0, W), y = rand(0, H), a = rand(0, TAU), l = rand(6, 24);
      g.strokeStyle = `rgba(120,100,80,${rand(0.025, 0.06).toFixed(3)})`;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    const lamp = g.createLinearGradient(0, 0, W, H);
    lamp.addColorStop(0, 'rgba(255,255,255,0.4)');
    lamp.addColorStop(0.55, 'rgba(255,255,255,0)');
    lamp.addColorStop(1, 'rgba(70,55,40,0.07)');
    g.fillStyle = lamp;
    g.fillRect(0, 0, W, H);
    const vignette = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
    vignette.addColorStop(0, 'rgba(60,45,30,0)');
    vignette.addColorStop(1, 'rgba(60,45,30,0.12)');
    g.fillStyle = vignette;
    g.fillRect(0, 0, W, H);
  }

  // Walls, doorways and labels. Drawn over the ants, so they vanish into the doorways.
  function paintOverlay() {
    const g = overlay.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const shade = (x0, y0, x1, y1, rx, ry, rw, rh, alpha) => {
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, `rgba(50,40,30,${alpha})`);
      grad.addColorStop(1, 'rgba(50,40,30,0)');
      g.fillStyle = grad;
      g.fillRect(rx, ry, rw, rh);
    };
    // shadows the walls cast on the card, deeper on the lamp side
    shade(0, WALL, 0, WALL + 14, WALL, WALL, W - WALL * 2, 14, 0.2);
    shade(WALL, 0, WALL + 12, 0, WALL, WALL, 12, H - WALL * 2, 0.15);
    shade(0, H - WALL, 0, H - WALL - 6, WALL, H - WALL - 6, W - WALL * 2, 6, 0.07);
    shade(W - WALL, 0, W - WALL - 6, 0, W - WALL - 6, WALL, 6, H - WALL * 2, 0.07);

    const left = DOOR_X - DOOR_HALF, right = DOOR_X + DOOR_HALF;
    const wall = new Path2D();
    wall.rect(0, 0, WALL, H);
    wall.rect(W - WALL, 0, WALL, H);
    wall.rect(WALL, 0, left - WALL, WALL);
    wall.rect(right, 0, W - WALL - right, WALL);
    wall.rect(WALL, H - WALL, left - WALL, WALL);
    wall.rect(right, H - WALL, W - WALL - right, WALL);
    const face = g.createLinearGradient(0, 0, W, H);
    face.addColorStop(0, '#e4ddd1');
    face.addColorStop(1, '#cfc6b7');
    g.fillStyle = face;
    g.fill(wall);

    // inner edges of the walls and the doorway jambs
    g.strokeStyle = 'rgba(70,55,40,0.3)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(left, WALL + 0.5);
    g.lineTo(WALL + 0.5, WALL + 0.5);
    g.lineTo(WALL + 0.5, H - WALL - 0.5);
    g.lineTo(left, H - WALL - 0.5);
    g.moveTo(right, WALL + 0.5);
    g.lineTo(W - WALL - 0.5, WALL + 0.5);
    g.lineTo(W - WALL - 0.5, H - WALL - 0.5);
    g.lineTo(right, H - WALL - 0.5);
    for (const x of [left + 0.5, right - 0.5]) {
      g.moveTo(x, 0);
      g.lineTo(x, WALL);
      g.moveTo(x, H - WALL);
      g.lineTo(x, H);
    }
    g.stroke();

    // the doorways lead off into the dark
    for (const [from, to] of [[H - WALL - 10, H], [WALL + 10, 0]]) {
      const grad = g.createLinearGradient(0, from, 0, to);
      grad.addColorStop(0, 'rgba(24,17,12,0)');
      grad.addColorStop(0.45, 'rgba(24,17,12,0.4)');
      grad.addColorStop(1, 'rgba(24,17,12,0.94)');
      g.fillStyle = grad;
      g.fillRect(left, Math.min(from, to), right - left, Math.abs(to - from));
    }

    g.font = '500 9px "IBM Plex Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(66,54,44,0.78)';
    g.textBaseline = 'middle';
    spaced(g, 'ENTRANCE', right + 10, H - WALL / 2 + 0.5, 1.6);
    spaced(g, 'EXIT', right + 10, WALL / 2 + 0.5, 1.6);

    // a 10 mm scale bar, as on a macro photo: the ants are about 8 mm long
    const sx = WALL + 22, sy = H - WALL - 22, len = 40;
    g.strokeStyle = 'rgba(52,44,38,0.7)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + len, sy);
    g.moveTo(sx, sy - 4);
    g.lineTo(sx, sy + 4);
    g.moveTo(sx + len, sy - 4);
    g.lineTo(sx + len, sy + 4);
    g.stroke();
    g.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    g.fillStyle = 'rgba(52,44,38,0.8)';
    g.textBaseline = 'bottom';
    g.fillText('10 mm', sx, sy - 6);
  }

  function spaced(g, text, x, y, gap) {
    for (const ch of text) {
      g.fillText(ch, x, y);
      x += g.measureText(ch).width + gap;
    }
  }

  const RIM = 72;
  const rimPts = new Float32Array(RIM * 2);

  // Outline of a drop: a slightly lumpy circle that shivers a little and bulges
  // towards the mouth of each ant sipping at its edge.
  function dropPath(d, r, shimmer, t) {
    for (let i = 0; i < RIM; i++) {
      const a = (i / RIM) * TAU;
      let rr = r * (1 + 0.016 * Math.sin(3 * a + d.seed) + 0.011 * Math.sin(5 * a + d.seed * 1.7));
      if (shimmer) {
        rr += shimmer * Math.sin(7 * a + sim.clock * 1.3 + d.seed);
        for (const ant of d.drinkers) {
          if (!ant.sipping) continue;
          const arc = turnTo(ant.slot, a) * r;
          if (arc > -18 && arc < 18) rr += (1.2 + Math.sin(t * 8 + ant.wiggle[0])) * Math.exp(-(arc * arc) / 40);
        }
      }
      rimPts[i * 2] = d.x + Math.cos(a) * rr;
      rimPts[i * 2 + 1] = d.y + Math.sin(a) * rr;
    }
    const p = new Path2D();
    const last = (RIM - 1) * 2;
    p.moveTo((rimPts[0] + rimPts[last]) / 2, (rimPts[1] + rimPts[last + 1]) / 2);
    for (let i = 0; i < RIM; i++) {
      const j = ((i + 1) % RIM) * 2;
      p.quadraticCurveTo(rimPts[i * 2], rimPts[i * 2 + 1], (rimPts[i * 2] + rimPts[j]) / 2, (rimPts[i * 2 + 1] + rimPts[j + 1]) / 2);
    }
    p.closePath();
    return p;
  }

  // Under and around a drop: the stain it leaves as it shrinks, and the coloured
  // light it throws onto the card.
  function drawDropBase(g, d) {
    const pure = DYES[d.dye].pure;
    const used = 1 - d.level;
    if (used > 0.002) {
      const k = Math.min(1, used * 5);
      const stain = dropPath(d, d.fullRadius, 0, 0);
      g.fillStyle = tint(pure, 0.06, PAPER, 0.55 * k);
      g.fill(stain);
      g.lineWidth = 1.4;
      g.strokeStyle = tint(pure, 0.4, PAPER, 0.3 * k);
      g.stroke(stain);
    }
    const r = d.radius;
    if (r <= 0) return;
    const ox = d.x + r * 0.16, oy = d.y + r * 0.2;
    const glow = g.createRadialGradient(ox, oy, r * 0.45, ox, oy, r * 1.22);
    glow.addColorStop(0, tint(pure, 0.5, PAPER, 0.5));
    glow.addColorStop(0.65, tint(pure, 0.35, PAPER, 0.2));
    glow.addColorStop(1, tint(pure, 0.3, PAPER, 0));
    g.fillStyle = glow;
    g.beginPath();
    g.arc(ox, oy, r * 1.22, 0, TAU);
    g.fill();
  }

  function drawDrop(g, d, t) {
    const r = d.radius;
    if (r <= 0.5) return;
    const pure = DYES[d.dye].pure;
    const depth = 0.62 + 0.38 * Math.sqrt(d.level);   // a shrinking drop is also a shallower one
    const path = dropPath(d, r, calm ? 0 : 0.45, t);

    const body = g.createRadialGradient(d.x - r * 0.2, d.y - r * 0.22, r * 0.05, d.x, d.y, r);
    body.addColorStop(0, tint(pure, depth * 0.6, PAPER));
    body.addColorStop(0.55, tint(pure, depth * 0.88, PAPER));
    body.addColorStop(0.86, tint(pure, depth, PAPER));
    body.addColorStop(1, tint(pure, depth * 1.5, PAPER));
    g.fillStyle = body;
    g.fill(path);

    g.save();
    g.clip(path);
    // light focused through the drop pools on the side away from the lamp
    const cx = d.x + r * 0.3, cy = d.y + r * 0.36;
    const caustic = g.createRadialGradient(cx, cy, 0, cx, cy, r * 0.62);
    caustic.addColorStop(0, tint(pure, 0.16, PAPER, 0.85));
    caustic.addColorStop(1, tint(pure, 0.16, PAPER, 0));
    g.fillStyle = caustic;
    g.fillRect(d.x - r, d.y - r, r * 2, r * 2);
    // ripples spreading from each sip
    g.lineWidth = 1.1;
    for (const rp of d.ripples) {
      const p = rp.age / 1.2, fade = Math.pow(1 - p, 1.5);
      const ex = d.x + Math.cos(rp.a) * r, ey = d.y + Math.sin(rp.a) * r, rad = 3 + 30 * p;
      g.strokeStyle = `rgba(255,255,255,${(0.42 * fade).toFixed(3)})`;
      g.beginPath();
      g.arc(ex, ey, rad, 0, TAU);
      g.stroke();
      g.strokeStyle = tint(pure, depth * 1.6, PAPER, 0.25 * fade);
      g.beginPath();
      g.arc(ex, ey, rad + 1.4, 0, TAU);
      g.stroke();
    }
    g.restore();

    // the meniscus edge, then the lamp's reflections
    g.lineWidth = 1.2;
    g.strokeStyle = tint(pure, depth * 2, PAPER, 0.55);
    g.stroke(path);
    g.save();
    g.translate(d.x - r * 0.36, d.y - r * 0.42);
    g.rotate(-0.62);
    g.scale(1, 0.46);
    const spec = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.32);
    spec.addColorStop(0, 'rgba(255,255,255,0.92)');
    spec.addColorStop(0.45, 'rgba(255,255,255,0.4)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spec;
    g.beginPath();
    g.arc(0, 0, r * 0.32, 0, TAU);
    g.fill();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1.3;
    g.beginPath();
    g.arc(d.x, d.y, r * 0.86, Math.PI * 1.06, Math.PI * 1.38);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(d.x + r * 0.42, d.y + r * 0.5, Math.max(0.8, r * 0.035), 0, TAU);
    g.fill();

    if (sim.state === 'setup' && (hover === d || (drag && drag.d === d))) {
      g.save();
      g.setLineDash([4, 5]);
      g.strokeStyle = 'rgba(45,35,28,0.45)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(d.x, d.y, r + 10, 0, TAU);
      g.stroke();
      g.restore();
    }
  }

  // Size of the abdomen (gaster): it swells as the crop inside fills up.
  const belly = { f: 0, gx: 0, gy: 0, cx: 0 };
  function bellyShape(a, t) {
    const f = Math.pow(a.fill, 0.85);
    let gx = 5.1 + 5.3 * f, gy = 3.9 + 4.5 * f;
    if (a.sipping) {
      const pump = 1 + 0.022 * Math.sin(t * 8 + a.wiggle[1]);
      gx *= pump;
      gy *= pump;
    }
    belly.f = f;
    belly.gx = gx;
    belly.gy = gy;
    belly.cx = -5.4 - gx * 0.94;
    return belly;
  }

  // Each ant is drawn in its own frame: x points the way it faces, units are ~0.25 mm.
  function antFrame(g, a, ox, oy) {
    const c = Math.cos(a.heading), s = Math.sin(a.heading), k = a.size * dpr;
    g.setTransform(c * k, s * k, -s * k, c * k, (a.x + ox) * dpr, (a.y + oy) * dpr);
  }

  function drawAntShadow(g, a, t) {
    antFrame(g, a, 2.2, 3.2);
    const b = bellyShape(a, t);
    g.drawImage(BLOB, -5.5, -5.2, 21, 10.4);
    g.drawImage(BLOB, b.cx - b.gx * 1.12, -b.gy * 1.15, b.gx * 2.24, b.gy * 2.3);
  }

  function drawAnt(g, a, t) {
    const c = Math.cos(a.heading), s = Math.sin(a.heading);
    const bob = a.sipping ? 0.5 * Math.sin(t * 8 + a.wiggle[1]) * a.size : 0;
    antFrame(g, a, c * bob, s * bob);
    // the lamp's direction in the ant's frame, for highlights
    const lx = LIGHT_X * c + LIGHT_Y * s, ly = -LIGHT_X * s + LIGHT_Y * c;
    const { f, gx, gy, cx } = bellyShape(a, t);

    // legs, in a tripod gait: front and hind legs on one side step with the middle
    // leg on the other
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = a.legColour;
    g.lineWidth = 1.2;
    g.beginPath();
    const amp = 0.36 * a.gait;
    for (let j = 0; j < 3; j++) {
      const L = LEGS[j], splay = j ? 0.12 * f : 0;
      for (let side = -1; side <= 1; side += 2) {
        const ph = a.legPhase + ((j + (side > 0 ? 0 : 1)) & 1) * Math.PI;
        const swing = Math.sin(ph) * amp, lift = Math.max(0, Math.cos(ph)) * a.gait;
        const fa = side * (L.fa + splay - swing), ta = side * (L.ta + splay - swing * 1.15);
        const hy = L.hy * side;
        const kx = L.hx + Math.cos(fa) * L.fl, ky = hy + Math.sin(fa) * L.fl;
        const tl = L.tl * (1 - 0.14 * lift);
        g.moveTo(L.hx, hy);
        g.lineTo(kx, ky);
        g.lineTo(kx + Math.cos(ta) * tl, ky + Math.sin(ta) * tl);
      }
    }
    g.stroke();

    drawBelly(g, a, f, gx, gy, cx, lx, ly);

    // petiole, thorax, head
    g.fillStyle = a.bodyColour;
    g.beginPath();
    g.ellipse(-4.8, 0, 1.05, 1.75, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(-0.9, 0, 3.25, 1.95, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(3.4, 0, 2.95, 2.55, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(8.9, 0, 4.3, 3.95, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.moveTo(12.4, 2.1);
    g.quadraticCurveTo(15.1, 1.9, 14.6, 0.25);
    g.lineTo(13.3, 0.9);
    g.closePath();
    g.moveTo(12.4, -2.1);
    g.quadraticCurveTo(15.1, -1.9, 14.6, -0.25);
    g.lineTo(13.3, -0.9);
    g.closePath();
    g.fill();
    g.fillStyle = '#0c0907';
    g.beginPath();
    g.ellipse(9.8, 3.25, 1.35, 0.95, 0.3, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(9.8, -3.25, 1.35, 0.95, -0.3, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,236,214,0.17)';
    g.beginPath();
    g.ellipse(8.9 + lx * 1.5, ly * 1.5, 2.1, 1.5, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(3.4 + lx, ly, 1.4, 1, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(-0.9 + lx * 0.8, ly * 0.7, 1.4, 0.7, 0, 0, TAU);
    g.fill();

    // elbowed antennae: tapping the surface while drinking, sweeping when paused
    g.strokeStyle = a.legColour;
    g.lineWidth = 0.95;
    g.beginPath();
    for (let side = -1; side <= 1; side += 2) {
      let scape = 0.62, flag = 0.16, wave;
      if (a.state === 'drink') {
        scape = 0.48;
        flag = -0.18;
        wave = 0.07 * Math.sin(t * 13 + a.wiggle[2] + side);
      } else if (a.pause > 0) {
        wave = 0.28 * Math.sin(t * 7 + a.wiggle[2] + side * 1.9);
      } else {
        wave = 0.12 * Math.sin(t * 5 + a.wiggle[2] + side * 1.3);
      }
      const bx = 11.4, by = 1.5 * side;
      const sa = side * (scape + wave * 0.6);
      const ex = bx + Math.cos(sa) * 5.2, ey = by + Math.sin(sa) * 5.2;
      const fa = side * (flag + wave);
      g.moveTo(bx, by);
      g.lineTo(ex, ey);
      g.quadraticCurveTo(
        ex + Math.cos(fa + side * 0.22) * 3.8, ey + Math.sin(fa + side * 0.22) * 3.8,
        ex + Math.cos(fa) * 7.2, ey + Math.sin(fa) * 7.2,
      );
    }
    g.stroke();

    // a bead of sugar water at the mouth
    if (a.sipping) {
      g.fillStyle = tint(DYES[a.sipDye].pure, 0.7, PAPER, 0.9);
      g.beginPath();
      g.arc(15.1, 0, 1.3, 0, TAU);
      g.fill();
    }
  }

  // The abdomen: the crop shows through the stretched membrane between the hard plates.
  function drawBelly(g, a, f, gx, gy, cx, lx, ly) {
    const sway = 0.08 * Math.sin(a.legPhase) * a.gait;
    g.save();
    if (sway) {
      g.translate(-5.2, 0);
      g.rotate(sway);
      g.translate(5.2, 0);
    }
    const shape = new Path2D();
    shape.ellipse(cx, 0, gx, gy, 0, 0, TAU);
    if (a.fill > 0.004) {
      // fresh intake near the waist, the older mix towards the tip
      const depth = cropDepth(a.fill);
      const fresh = tint(a.front, depth, CROP), old = tint(a.back, depth, CROP);
      if (fresh === old) {
        g.fillStyle = fresh;
      } else {
        const lg = g.createLinearGradient(cx + gx, 0, cx - gx, 0);
        lg.addColorStop(0.1, fresh);
        lg.addColorStop(0.9, old);
        g.fillStyle = lg;
      }
    } else {
      g.fillStyle = 'rgb(176,150,120)';   // empty: pale, see-through amber
    }
    g.fill(shape);

    g.save();
    g.clip(shape);
    // roundness: lit on the lamp side, darker towards the edge
    const shade = g.createRadialGradient(cx + lx * gx * 0.3, ly * gy * 0.3, 0, cx, 0, Math.max(gx, gy) * 1.05);
    shade.addColorStop(0, 'rgba(255,255,255,0.2)');
    shade.addColorStop(0.55, 'rgba(255,255,255,0)');
    shade.addColorStop(1, 'rgba(25,12,6,0.4)');
    g.fillStyle = shade;
    g.fillRect(cx - gx, -gy, gx * 2, gy * 2);
    // the plates (tergites) don't stretch, so they drift apart as the crop fills
    const plates = 5, thick = 2.15 - 0.45 * f;
    const pitch = (gx * 2 - 0.5 - thick) / (plates - 1);
    const narrow = 1 - 0.3 * f, bow = 0.7 + 1.2 * f;
    const x0 = cx + gx - 0.25;
    g.beginPath();
    for (let i = 0; i < plates; i++) {
      const xf = x0 - i * pitch, xb = xf - thick;
      const u = ((xf + xb) / 2 - cx) / gx;
      const hs = gy * Math.sqrt(Math.max(0.08, 1 - u * u)) * narrow + 0.7;
      g.moveTo(xf + bow, -hs);
      g.quadraticCurveTo(xf - bow, 0, xf + bow, hs);
      g.lineTo(xb + bow, hs);
      g.quadraticCurveTo(xb - bow, 0, xb + bow, -hs);
      g.closePath();
    }
    g.fillStyle = 'rgba(31,21,15,0.8)';
    g.fill();
    g.lineWidth = 0.5;
    g.strokeStyle = 'rgba(255,228,200,0.14)';
    g.stroke();
    // the lamp's reflection on the taut, glossy membrane
    const hx = cx + lx * gx * 0.42, hy = ly * gy * 0.42, hr = gy * 0.6;
    const spec = g.createRadialGradient(hx, hy, 0, hx, hy, hr);
    spec.addColorStop(0, `rgba(255,255,255,${(0.3 + 0.45 * f).toFixed(3)})`);
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = spec;
    g.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    g.restore();

    g.lineWidth = 0.6;
    g.strokeStyle = 'rgba(22,13,8,0.5)';
    g.stroke(shape);
    g.restore();
  }

  function pill(g, x, y, w, h) {
    const r = h / 2;
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // A label on the card: centred above the drops when the arena is empty, tucked into
  // the corner while paused so it doesn't hide the ants on their way out.
  function drawHint(g) {
    let text = '';
    if (sim.state === 'setup') text = sim.drops.length ? 'Drag a drop to move it, then press Go' : 'Choose at least one drop';
    else if (sim.state === 'paused') text = 'Paused';
    else if (sim.state === 'done') text = `All ${sim.total} ants have left the arena`;
    if (!text) return;
    g.font = '600 13px "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif';
    const w = g.measureText(text).width + 32, h = 30;
    const x = sim.state === 'paused' ? WALL + 14 : (W - w) / 2, y = sim.state === 'paused' ? WALL + 14 : 42;
    pill(g, x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.88)';
    g.fill();
    g.strokeStyle = 'rgba(45,35,28,0.14)';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = '#3e352e';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + w / 2, y + h / 2 + 0.5);
  }

  function render() {
    const g = ctx, t = sim.time;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.drawImage(paper, 0, 0, W, H);
    for (const d of sim.drops) drawDropBase(g, d);
    for (const a of sim.ants) drawAntShadow(g, a, t);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const d of sim.drops) drawDrop(g, d, t);
    for (const a of sim.ants) if (a.state === 'drink') drawAnt(g, a, t);
    for (const a of sim.ants) if (a.state !== 'drink') drawAnt(g, a, t);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.drawImage(overlay, 0, 0, W, H);
    drawHint(g);
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const ui = {
    go: $('go'),
    reset: $('reset'),
    state: $('state'),
    arena: $('n-arena'),
    drinking: $('n-drinking'),
    left: $('n-left'),
    ants: $('ants'),
    antsOut: $('ants-out'),
    fullness: $('fullness'),
    fullnessOut: $('fullness-out'),
    hopping: $('hopping'),
    hoppingOut: $('hopping-out'),
    chips: [...document.querySelectorAll('.chip')],
    speeds: [...document.querySelectorAll('input[name="speed"]')],
    summary: $('tally-summary'),
    swatches: $('swatches'),
    live: $('live'),
  };

  function readControls() {
    settings.ants = +ui.ants.value;
    settings.fullness = ui.fullness.value / 100;
    settings.hopping = ui.hopping.value / 100;
    const speed = ui.speeds.find((r) => r.checked);
    settings.speed = speed ? +speed.value : 1;
    ui.antsOut.textContent = settings.ants;
    ui.fullnessOut.textContent = ui.fullness.value + '%';
    ui.hoppingOut.textContent = ui.hopping.value + '%';
    for (const input of [ui.ants, ui.fullness, ui.hopping]) {
      const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
      input.style.setProperty('--pct', pct + '%');
    }
  }

  function announce(text) {
    ui.live.textContent = text;
  }

  function syncUI() {
    const s = sim.state, busy = s === 'running' || s === 'paused';
    ui.go.textContent = { setup: 'Go', running: 'Pause', paused: 'Resume', done: 'Run again' }[s];
    ui.go.disabled = !sim.drops.length;
    ui.ants.disabled = busy;
    ui.ants.title = busy ? 'Reset to change the number of ants' : '';
    for (const chip of ui.chips) {
      chip.setAttribute('aria-pressed', String(settings.dyes[+chip.dataset.dye]));
      chip.disabled = busy;
      chip.title = busy ? 'Reset to change the drops' : '';
    }
    ui.state.dataset.state = s;
    ui.state.textContent = { setup: 'Ready', running: 'Running', paused: 'Paused', done: 'Finished' }[s];
    canvas.classList.toggle('editable', s === 'setup');
    reserveTally();
    updateReadouts();
  }

  // Swatch sizes in px. The gap matches .swatches in the CSS.
  const SWATCH = { min: 8, max: 17, gap: 5 };

  // Once a run starts, make room for every ant's swatch up front, so whatever sits
  // below the tally doesn't creep down the page as ants leave.
  function reserveTally() {
    const box = ui.swatches;
    box.hidden = sim.state === 'setup';
    if (box.hidden) {
      box.style.minHeight = '';
      return;
    }
    const pitch = SWATCH.max + SWATCH.gap;
    const perRow = Math.max(1, Math.floor((box.clientWidth + SWATCH.gap) / pitch));
    box.style.minHeight = Math.ceil(sim.total / perRow) * pitch - SWATCH.gap + 'px';
  }

  function updateReadouts() {
    let drinking = 0;
    for (const a of sim.ants) if (a.state === 'drink') drinking++;
    ui.arena.textContent = sim.ants.length;
    ui.drinking.textContent = drinking;
    ui.left.textContent = `${sim.gone.length}/${sim.state === 'setup' ? settings.ants : sim.total}`;
    for (const chip of ui.chips) {
      const d = sim.drops.find((x) => x.dye === +chip.dataset.dye);
      chip.querySelector('.level').textContent = d && sim.state !== 'setup' ? Math.round(d.level * 100) + '%' : '';
    }
  }

  function describe(rec) {
    const parts = rec.shares
      .map((s, i) => [s, DYES[i].name])
      .filter(([s]) => s > 0.03)
      .sort((a, b) => b[0] - a[0])
      .map(([s, name]) => `${name} ${Math.round(s * 100)}%`);
    return `${parts.join(' · ') || 'Nothing'}, ${Math.round(rec.fill * 100)}% full`;
  }

  function updateTally() {
    const n = sim.gone.length;
    if (!n) {
      ui.summary.textContent = 'Each ant that leaves shows up here in the colour it ended up.';
      return;
    }
    const mixed = sim.gone.filter((r) => r.mixed).length;
    const hungry = sim.gone.filter((r) => r.fill < 0.05).length;
    let text = `${n} left: ${n - mixed - hungry} one colour, ${mixed} mixed`;
    if (hungry) text += `, ${hungry} went without`;
    ui.summary.textContent = text;
  }

  function depart(a) {
    const shares = a.crop.map((v) => (a.fill > 0 ? v / a.fill : 0));
    const rec = {
      shares,
      fill: a.fill,
      colour: a.fill > 0.01 ? tint(shares, cropDepth(a.fill), CROP) : 'rgb(120,98,80)',
      mixed: shares.filter((s) => s > 0.12).length > 1,
    };
    sim.gone.push(rec);
    const el = document.createElement('span');
    el.className = 'swatch';
    el.style.setProperty('--c', rec.colour);
    el.style.setProperty('--s', (SWATCH.min + (SWATCH.max - SWATCH.min) * rec.fill).toFixed(1) + 'px');
    el.title = describe(rec);
    ui.swatches.append(el);
    updateTally();
  }

  function start() {
    if (!sim.drops.length) return;
    sim.state = 'running';
    sim.total = settings.ants;
    sim.spawned = 0;
    sim.spawnTimer = 0;
    announce('Running');
    syncUI();
  }

  function finish() {
    sim.state = 'done';
    const mixed = sim.gone.filter((r) => r.mixed).length;
    announce(`Finished. ${sim.gone.length} ants left, ${mixed} of them with mixed colours.`);
    syncUI();
  }

  function reset(fresh) {
    sim.state = 'setup';
    sim.ants = [];
    sim.gone = [];
    sim.time = 0;
    sim.total = settings.ants;
    sim.spawned = 0;
    layDrops(fresh);
    ui.swatches.replaceChildren();
    updateTally();
    syncUI();
  }

  ui.go.addEventListener('click', () => {
    if (sim.state === 'setup') start();
    else if (sim.state === 'done') {
      reset(false);
      start();
    } else {
      sim.state = sim.state === 'running' ? 'paused' : 'running';
      announce(sim.state === 'paused' ? 'Paused' : 'Running');
      syncUI();
    }
  });
  ui.reset.addEventListener('click', () => reset(false));
  ui.ants.addEventListener('input', () => {
    readControls();
    if (sim.state === 'done') {
      reset(false);
    } else {
      if (sim.state === 'setup') sizeDrops();
      updateReadouts();
    }
  });
  ui.fullness.addEventListener('input', readControls);
  ui.hopping.addEventListener('input', readControls);
  for (const r of ui.speeds) r.addEventListener('change', readControls);
  for (const chip of ui.chips) {
    chip.addEventListener('click', () => {
      if (sim.state === 'running' || sim.state === 'paused') return;
      const i = +chip.dataset.dye;
      settings.dyes[i] = !settings.dyes[i];
      reset(true);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.target.closest('button, input, a, select, textarea')) return;
    e.preventDefault();
    ui.go.click();
  });

  // ── Dragging drops before a run ──────────────────────────────────────────
  let drag = null, hover = null;

  const stagePoint = (e) => {
    const box = canvas.getBoundingClientRect();
    return { x: ((e.clientX - box.left) / box.width) * W, y: ((e.clientY - box.top) / box.height) * H };
  };
  const dropAt = (p) => sim.drops.find((d) => Math.hypot(p.x - d.x, p.y - d.y) < d.radius + 8) || null;

  function moveDrop(d, x, y) {
    settle(d, x, y);
    sim.placed[d.dye] = [d.x, d.y];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (sim.state !== 'setup') return;
    const p = stagePoint(e), d = dropAt(p);
    if (!d) return;
    drag = { d, dx: d.x - p.x, dy: d.y - p.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = stagePoint(e);
    if (drag) {
      moveDrop(drag.d, p.x + drag.dx, p.y + drag.dy);
      return;
    }
    hover = sim.state === 'setup' ? dropAt(p) : null;
    canvas.style.cursor = hover ? 'grab' : '';
  });
  const endDrag = () => {
    drag = null;
    canvas.style.cursor = hover ? 'grab' : '';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    hover = null;
    canvas.style.cursor = '';
  });

  // ── Main loop ────────────────────────────────────────────────────────────
  let last = performance.now(), readoutIn = 0;

  function frame(now) {
    const real = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (sim.state !== 'paused') sim.clock += real;
    if (sim.state === 'running') {
      const span = real * settings.speed;
      const steps = Math.max(1, Math.ceil(span * 60 - 1e-6));
      for (let i = 0; i < steps && sim.state === 'running'; i++) step(span / steps);
    }
    render();
    if ((readoutIn -= real) <= 0) {
      readoutIn = 0.2;
      updateReadouts();
    }
    requestAnimationFrame(frame);
  }

  // For poking at the simulation from the browser console.
  window.rainbowAnts = { sim, settings, step, render };

  readControls();
  settings.dyes = ui.chips.map((c) => c.getAttribute('aria-pressed') === 'true');
  window.addEventListener('resize', () => {
    fitCanvas();
    reserveTally();
  });
  fitCanvas();
  reset(true);
  requestAnimationFrame(frame);
  if (document.fonts) document.fonts.load('500 10px "IBM Plex Mono"').then(paintOverlay, () => {});
})();
