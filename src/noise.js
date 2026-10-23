/*
 * noise.js
 * Gradient noise with exact analytic derivatives, rotated fBm, and domain warping.
 * Every height sample comes back as [h, dh/du, dh/dv] so the mesh can use exact normals.
 *
 * Notation: (u, v) in [0,1]^2 are terrain coordinates, p = scale * (u, v) is noise space.
 */
(function (root) {
  "use strict";
  const TL = (root.TL = root.TL || {});

  /* ---------- seeded PRNG ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  TL.mulberry32 = mulberry32;

  /* ---------- gradient noise with derivatives ----------
   * Lattice corners a(0,0) b(1,0) c(0,1) d(1,1) carry random unit gradients g.
   * Corner contributions: va = ga.f, vb = gb.(f-(1,0)), vc = gc.(f-(0,1)), vd = gd.(f-(1,1)).
   * Quintic fade u(t) = 6t^5 - 15t^4 + 10t^3, u'(t) = 30 t^2 (t-1)^2 (C2 continuous).
   * n  = va + ux(vb-va) + uy(vc-va) + ux uy k,      k = va - vb - vc + vd
   * dn/dx = ga.x + ux(gb.x-ga.x) + uy(gc.x-ga.x) + ux uy(ga.x-gb.x-gc.x+gd.x) + ux'(vb-va + uy k)
   * dn/dy = ga.y + ux(gb.y-ga.y) + uy(gc.y-ga.y) + ux uy(ga.y-gb.y-gc.y+gd.y) + uy'(vc-va + ux k)
   */
  function GradientNoise(seed) {
    const rnd = mulberry32(seed >>> 0);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint16Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    // 256 random unit gradients: isotropic, unlike the classic 8 axis aligned ones
    this.gx = new Float64Array(256); this.gy = new Float64Array(256);
    for (let i = 0; i < 256; i++) { const a = rnd() * Math.PI * 2; this.gx[i] = Math.cos(a); this.gy[i] = Math.sin(a); }
  }
  GradientNoise.prototype.eval = function (x, y, out) {
    const X = Math.floor(x), Y = Math.floor(y);
    const fx = x - X, fy = y - Y, xi = X & 255, yi = Y & 255;
    const P = this.perm, GX = this.gx, GY = this.gy;
    const ia = P[P[xi] + yi], ib = P[P[xi + 1] + yi], ic = P[P[xi] + yi + 1], id = P[P[xi + 1] + yi + 1];
    const gax = GX[ia], gay = GY[ia], gbx = GX[ib], gby = GY[ib];
    const gcx = GX[ic], gcy = GY[ic], gdx = GX[id], gdy = GY[id];
    const va = gax * fx + gay * fy;
    const vb = gbx * (fx - 1) + gby * fy;
    const vc = gcx * fx + gcy * (fy - 1);
    const vd = gdx * (fx - 1) + gdy * (fy - 1);
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
    const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
    const k = va - vb - vc + vd;
    out[0] = va + ux * (vb - va) + uy * (vc - va) + ux * uy * k;
    out[1] = gax + ux * (gbx - gax) + uy * (gcx - gax) + ux * uy * (gax - gbx - gcx + gdx) + dux * (vb - va + uy * k);
    out[2] = gay + ux * (gby - gay) + uy * (gcy - gay) + ux * uy * (gay - gby - gcy + gdy) + duy * (vc - va + ux * k);
    return out;
  };
  TL.GradientNoise = GradientNoise;

  /* ---------- fBm with rotated octaves ----------
   * Octave o samples n(q_o) with q_o = M_o p + c_o, where M_{o+1} = L R M_o.
   * R is a rotation by atan(3/4) so octave lattices never line up (removes grid artifacts).
   * Chain rule: grad_p n(q_o) = M_o^T grad_q n.  f = sum a_o n(q_o) / sum a_o.
   */
  /*
   * Band limiting: a grid with spacing du can only represent frequencies below its Nyquist
   * limit 1 / (2 du). Octaves above it alias (the mesh cannot show them, but the exact
   * gradient still sees them). With fcut = the Nyquist frequency in noise space, octave o
   * of frequency L^o gets weight 1 - smoothstep(fcut/4, fcut/2, L^o), i.e. it fades out
   * between 8 and 4 samples per cycle. The weight is a constant, so derivatives stay exact.
   */
  const RC = 0.8, RS = 0.6, TMP = new Float64Array(3);
  function bandWeight(f, fcut) {
    if (!(fcut > 0)) return 1;
    const t = Math.min(Math.max((f - fcut * 0.25) / (fcut * 0.25), 0), 1);
    return 1 - t * t * (3 - 2 * t);
  }
  TL.bandWeight = bandWeight;
  function fbm(noise, x, y, octaves, gain, lac, out, fcut) {
    let m00 = 1, m01 = 0, m10 = 0, m11 = 1, cx = 0, cy = 0;
    let a = 1, f = 1, sum = 0, dx = 0, dy = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const w = a * bandWeight(f, fcut);
      if (w > 0) {
        noise.eval(m00 * x + m01 * y + cx, m10 * x + m11 * y + cy, TMP);
        sum += w * TMP[0];
        dx += w * (m00 * TMP[1] + m10 * TMP[2]);
        dy += w * (m01 * TMP[1] + m11 * TMP[2]);
      }
      norm += a; a *= gain; f *= lac;
      const n00 = lac * (RC * m00 - RS * m10), n01 = lac * (RC * m01 - RS * m11);
      const n10 = lac * (RS * m00 + RC * m10), n11 = lac * (RS * m01 + RC * m11);
      m00 = n00; m01 = n01; m10 = n10; m11 = n11;
      const ncx = lac * (RC * cx - RS * cy) + 13.7, ncy = lac * (RS * cx + RC * cy) + 7.3;
      cx = ncx; cy = ncy;
    }
    out[0] = sum / norm; out[1] = dx / norm; out[2] = dy / norm;
    return out;
  }
  TL.fbm = fbm;

  /* ---------- full height function ----------
   * 1. p = scale (u, v)
   * 2. domain warp  w(p) = p + W (A(p'), B(p')),  p' = wf p     (A, B are 3 octave fBm)
   *    Jacobian J = I + W wf [[dA/dx, dA/dy], [dB/dx, dB/dy]]
   * 3. s = fbm(w(p)),  grad_p s = J^T grad_w fbm
   * 4. t = (s - min) / (max - min),  e = t^gamma            (redistribution)
   * 5. island mask m(r) = 1 - smoothstep(r0, r1, r),  r = |(2u-1, 2v-1)|
   * 6. h = e m,  dh/du = gamma t^(gamma-1) dt/du m + e dm/dr dr/du
   */
  function HeightSampler(P) {
    this.P = P;
    this.main = new GradientNoise(P.seed);
    this.wa = new GradientNoise(P.seed + 101);
    this.wb = new GradientNoise(P.seed + 202);
    this.A = new Float64Array(3); this.B = new Float64Array(3); this.F = new Float64Array(3);
    this.min = 0; this.range = 1;
    this.fcut = 0;   // Nyquist cutoff in noise space, 0 = off
  }
  HeightSampler.prototype.raw = function (u, v, out) {
    const P = this.P, sc = P.scale;
    const px = u * sc, py = v * sc;
    let wx = px, wy = py, j00 = 1, j01 = 0, j10 = 0, j11 = 1;
    if (P.warp > 0) {
      const wf = P.warpFreq, W = P.warp;
      fbm(this.wa, px * wf, py * wf, 3, 0.5, 2.0, this.A);
      fbm(this.wb, px * wf + 5.2, py * wf + 1.3, 3, 0.5, 2.0, this.B);
      wx = px + W * this.A[0]; wy = py + W * this.B[0];
      j00 = 1 + W * wf * this.A[1]; j01 = W * wf * this.A[2];
      j10 = W * wf * this.B[1];     j11 = 1 + W * wf * this.B[2];
    }
    const F = fbm(this.main, wx, wy, P.octaves, P.persistence, P.lacunarity, this.F, this.fcut);
    out[0] = F[0];
    out[1] = sc * (j00 * F[1] + j10 * F[2]);   // ds/du
    out[2] = sc * (j01 * F[1] + j11 * F[2]);   // ds/dv
    return out;
  };
  const R0 = 0.55, R1 = 1.05;
  HeightSampler.prototype.finish = function (u, v, s, su, sv, out) {
    const P = this.P;
    let t = (s - this.min) / this.range, dtu = su / this.range, dtv = sv / this.range;
    out[3] = (t > 0 && t < 1) ? 1 : 0;             // 1 where the function is differentiable
    if (t <= 0) { t = 0; dtu = 0; dtv = 0; } else if (t >= 1) { t = 1; dtu = 0; dtv = 0; }
    const g = P.exponent;
    const e = Math.pow(t, g);
    const de = t > 1e-9 ? g * Math.pow(t, g - 1) : 0;
    let h = e, hu = de * dtu, hv = de * dtv;
    if (P.island) {
      const dx = 2 * u - 1, dz = 2 * v - 1, r = Math.sqrt(dx * dx + dz * dz);
      const x = Math.min(Math.max((r - R0) / (R1 - R0), 0), 1);
      const m = 1 - x * x * (3 - 2 * x);
      const dmdr = (x > 0 && x < 1) ? -6 * x * (1 - x) / (R1 - R0) : 0;
      const dru = r > 1e-9 ? 2 * dx / r : 0, drv = r > 1e-9 ? 2 * dz / r : 0;
      h = e * m;
      hu = hu * m + e * dmdr * dru;
      hv = hv * m + e * dmdr * drv;
    }
    out[0] = h; out[1] = hu; out[2] = hv;
    return out;
  };
  HeightSampler.prototype.height = function (u, v, out) {
    const r = this.raw(u, v, new Float64Array(3));
    return this.finish(u, v, r[0], r[1], r[2], out || new Float64Array(4));
  };
  TL.HeightSampler = HeightSampler;

  /* Sample an N x N grid. Returns heights and their exact gradients in (u, v). */
  TL.generateNoise = function (P, N) {
    const smp = new HeightSampler(P), V = N * N;
    // grid Nyquist is (N-1)/2 cycles per unit u; noise space is p = scale u.
    // Domain warp stretches space by up to |J|, so divide by its typical stretch (1 + W wf).
    if (P.bandlimit) smp.fcut = (N - 1) / 2 / P.scale / (1 + P.warp * P.warpFreq * 0.5);
    const S = new Float64Array(V), SU = new Float64Array(V), SV = new Float64Array(V);
    const r = new Float64Array(3), o = new Float64Array(4);
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      smp.raw(i / (N - 1), j / (N - 1), r);
      S[k] = r[0]; SU[k] = r[1]; SV[k] = r[2];
      if (r[0] < mn) mn = r[0]; if (r[0] > mx) mx = r[0];
    }
    smp.min = mn; smp.range = (mx - mn) || 1;
    const h = new Float32Array(V), gu = new Float32Array(V), gv = new Float32Array(V);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      smp.finish(i / (N - 1), j / (N - 1), S[k], SU[k], SV[k], o);
      h[k] = o[0]; gu[k] = o[1]; gv[k] = o[2];
    }
    return { h, gu, gv, sampler: smp };
  };

  /* Image heightmap: resample to N x N, height = relative luminance (Rec. 709). */
  TL.imageHeights = function (img, N) {
    const c = document.createElement("canvas"); c.width = c.height = N;
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data, h = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) h[k] = (0.2126 * d[4 * k] + 0.7152 * d[4 * k + 1] + 0.0722 * d[4 * k + 2]) / 255;
    return h;
  };
})(typeof window !== "undefined" ? window : globalThis);
