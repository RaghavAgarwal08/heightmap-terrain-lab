/*
 * erosion.js
 * Particle based hydraulic erosion. Each droplet rolls downhill, picks up sediment
 * while it has spare carrying capacity, and drops it when it slows down or climbs.
 *
 * Per step, for a droplet at position p with direction d, speed s, water w, sediment c:
 *   (h, grad h)  bilinear height and gradient of the cell under p
 *   d   <- normalize(d * inertia - grad h * (1 - inertia))
 *   p   <- p + d
 *   dh   = h(p_new) - h(p_old)
 *   C    = max(-dh * s * w * Kc, Cmin)                carrying capacity
 *   if c > C or dh > 0: deposit (into the 4 corners, bilinear weights)
 *   else: erode min((C - c) * Ke, -dh) with a radial brush
 *   s   <- sqrt(max(0, s^2 - g dh))                   energy: v^2 = v0^2 + 2 g (-dh)
 *   w   <- w (1 - evaporation)
 *
 * Heights are scaled by (N - 1) / 255 while eroding so the same parameters give the
 * same look at every grid resolution (slope per cell stays constant).
 */
(function (root) {
  "use strict";
  const TL = (root.TL = root.TL || {});

  function Erosion(H, N, o, seed) {
    this.H = H; this.N = N;
    this.rnd = TL.mulberry32((seed * 7919 + 17) >>> 0);
    this.k = (N - 1) / 255;
    const ratio = N / 256;
    this.total = Math.max(1, Math.round(o.droplets * ratio * ratio));
    this.done = 0;
    this.inertia = o.inertia; this.erodeRate = o.erodeRate; this.depositRate = o.depositRate;
    this.capacity = 4; this.minCapacity = 0.01; this.gravity = 4; this.evaporation = 0.01; this.maxLife = 40;
    // radial brush: weight = max(0, R - dist), normalized to sum 1
    const R = Math.max(1, Math.round(o.radius * ratio));
    const bx = [], by = [], bw = [];
    let sum = 0;
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const w = Math.max(0, R - Math.sqrt(x * x + y * y));
      if (w > 0) { bx.push(x); by.push(y); bw.push(w); sum += w; }
    }
    this.bx = Int32Array.from(bx); this.by = Int32Array.from(by);
    this.bw = Float64Array.from(bw.map((w) => w / sum));
    this.T = new Float64Array(3);
    this.eroded = 0; this.deposited = 0;
  }

  // bilinear height and gradient (per cell) at (x, y), 0 <= x, y < N-1
  Erosion.prototype.sample = function (x, y, out) {
    const N = this.N, H = this.H;
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, k = iy * N + ix;
    const h00 = H[k], h10 = H[k + 1], h01 = H[k + N], h11 = H[k + N + 1];
    out[0] = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
    out[1] = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
    out[2] = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
    return out;
  };

  Erosion.prototype.droplet = function () {
    const N = this.N, H = this.H, T = this.T, K = this.k, lim = N - 1;
    let x = this.rnd() * (lim - 1e-6), y = this.rnd() * (lim - 1e-6);
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let life = 0; life < this.maxLife; life++) {
      const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, cell = iy * N + ix;
      this.sample(x, y, T);
      const h0 = T[0] * K;
      dx = dx * this.inertia - T[1] * K * (1 - this.inertia);
      dy = dy * this.inertia - T[2] * K * (1 - this.inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) { const a = this.rnd() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); }
      else { dx /= len; dy /= len; }
      x += dx; y += dy;
      if (x < 0 || y < 0 || x >= lim || y >= lim) break;
      const dh = this.sample(x, y, T)[0] * K - h0;
      const cap = Math.max(-dh * speed * water * this.capacity, this.minCapacity);
      if (sed > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * this.depositRate;
        sed -= dep; this.deposited += dep;
        const d = dep / K;
        H[cell] += d * (1 - fx) * (1 - fy); H[cell + 1] += d * fx * (1 - fy);
        H[cell + N] += d * (1 - fx) * fy;   H[cell + N + 1] += d * fx * fy;
      } else {
        const amt = Math.min((cap - sed) * this.erodeRate, -dh);
        for (let b = 0; b < this.bw.length; b++) {
          const xx = ix + this.bx[b], yy = iy + this.by[b];
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
          const idx = yy * N + xx;
          const take = Math.min(H[idx] * K, amt * this.bw[b]);
          H[idx] -= take / K; sed += take; this.eroded += take;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * this.gravity));
      water *= 1 - this.evaporation;
    }
  };

  // run up to `count` droplets; returns true when finished
  Erosion.prototype.step = function (count) {
    const end = Math.min(this.total, this.done + count);
    for (; this.done < end; this.done++) this.droplet();
    return this.done >= this.total;
  };
  Erosion.prototype.progress = function () { return this.done / this.total; };

  TL.Erosion = Erosion;
})(typeof window !== "undefined" ? window : globalThis);
