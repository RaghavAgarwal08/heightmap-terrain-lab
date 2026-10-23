/*
 * mesh.js
 * Turns an N x N height field into GPU buffers: positions, UVs, triangle indices,
 * normals (four methods), per vertex ambient occlusion and normal error vs the exact surface.
 *
 * World mapping for grid sample (i, j), spacing D = S / (N - 1):
 *   x = i D - S/2,   y = A max(h, sea),   z = j D - S/2,   uv = (i, j) / (N - 1)
 */
(function (root) {
  "use strict";
  const TL = (root.TL = root.TL || {});
  const RAD2DEG = 180 / Math.PI;

  function TerrainMesh() { this.N = 0; }

  TerrainMesh.prototype.allocate = function (N) {
    if (N === this.N) return false;
    this.N = N;
    const V = N * N;
    this.pos = new Float32Array(V * 3);
    this.nor = new Float32Array(V * 3);
    this.ref = new Float32Array(V * 3);
    this.tmp = new Float32Array(V * 3);
    this.uv = new Float32Array(V * 2);
    this.raw = new Float32Array(V);
    this.disp = new Float32Array(V);
    this.ao = new Float32Array(V).fill(1);
    this.err = new Float32Array(V);
    this.idx = new Uint32Array((N - 1) * (N - 1) * 6);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      this.uv[2 * k] = i / (N - 1); this.uv[2 * k + 1] = j / (N - 1);
    }
    return true;
  };

  /* positions + indices. o = { size, amp, sea, adaptive } */
  TerrainMesh.prototype.build = function (H, o) {
    const N = this.N, S = o.size, A = o.amp, D = S / (N - 1);
    const pos = this.pos, disp = this.disp, raw = this.raw;
    this.S = S; this.A = A; this.D = D; this.sea = o.sea;
    for (let k = 0; k < N * N; k++) { raw[k] = H[k]; disp[k] = H[k] > o.sea ? H[k] : o.sea; }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[3 * k] = i * D - S / 2;
      pos[3 * k + 1] = disp[k] * A;
      pos[3 * k + 2] = j * D - S / 2;
    }
    this.triangulate(!!o.adaptive);
  };

  /*
   * Each cell (a = jN+i, b = a+1, c = a+N, d = c+1) becomes two counter clockwise triangles.
   * A quad has two possible diagonals. Both have the same 2D length, so the shorter 3D
   * diagonal is the one with the smaller height difference: |h_a - h_d| vs |h_b - h_c|.
   * Splitting along it gives better shaped triangles that follow ridges and valleys.
   *   diagonal a-d: (a, c, d) (a, d, b)        diagonal b-c: (a, c, b) (b, c, d)
   * Winding check: (c - a) x (d - a) = (0,0,D) x (D,0,D) = (0, D^2, 0), facing +Y.
   */
  TerrainMesh.prototype.triangulate = function (adaptive) {
    const N = this.N, h = this.disp, idx = this.idx;
    let t = 0, flips = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      if (adaptive && Math.abs(h[a] - h[d]) < Math.abs(h[b] - h[c])) {
        idx[t++] = a; idx[t++] = c; idx[t++] = d;
        idx[t++] = a; idx[t++] = d; idx[t++] = b;
        flips++;
      } else {
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    this.flips = flips;
  };

  function setNormal(out, k, nx, ny, nz) {
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out[3 * k] = nx / l; out[3 * k + 1] = ny / l; out[3 * k + 2] = nz / l;
  }

  /*
   * The surface is a graph y = f(x, z). Its tangents are (1, f_x, 0) and (0, f_z, 1);
   * their cross product gives the normal  n = normalize(-f_x, 1, -f_z).
   * The methods differ only in how f_x and f_z are obtained.
   */
  TerrainMesh.prototype.normals = function (method, out, gu, gv) {
    const N = this.N, h = this.disp, A = this.A, D = this.D, S = this.S, raw = this.raw, sea = this.sea;
    if (method === "analytic") {
      // exact: f_x = A dh/dx = A dh/du du/dx = (A / S) dh/du
      const s = A / S;
      for (let k = 0; k < N * N; k++) {
        if (raw[k] <= sea) setNormal(out, k, 0, 1, 0);
        else setNormal(out, k, -s * gu[k], 1, -s * gv[k]);
      }
      return;
    }
    if (method === "face") {
      // sum of unnormalized face normals: |e1 x e2| = 2 * triangle area, so big faces count more
      out.fill(0);
      const pos = this.pos, idx = this.idx;
      for (let q = 0; q < idx.length; q += 3) {
        const a = 3 * idx[q], b = 3 * idx[q + 1], c = 3 * idx[q + 2];
        const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
        const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
        out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
        out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
      }
      for (let k = 0; k < N * N; k++) setNormal(out, k, out[3 * k], out[3 * k + 1], out[3 * k + 2]);
      return;
    }
    const sobel = method === "sobel";
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let fx, fz;
      if (sobel && i > 0 && j > 0 && i < N - 1 && j < N - 1) {
        // Sobel 3x3: central difference smoothed by [1 2 1] across the other axis, / (8 D)
        const t = k - N, b = k + N;
        fx = (h[t + 1] + 2 * h[k + 1] + h[b + 1] - h[t - 1] - 2 * h[k - 1] - h[b - 1]) * A / (8 * D);
        fz = (h[b - 1] + 2 * h[b] + h[b + 1] - h[t - 1] - 2 * h[t] - h[t + 1]) * A / (8 * D);
      } else {
        // central difference (h[i+1] - h[i-1]) / 2D, second order accurate; one sided at edges
        const iL = i > 0 ? i - 1 : i, iR = i < N - 1 ? i + 1 : i;
        const jD = j > 0 ? j - 1 : j, jU = j < N - 1 ? j + 1 : j;
        fx = (h[j * N + iR] - h[j * N + iL]) * A / ((iR - iL) * D);
        fz = (h[jU * N + i] - h[jD * N + i]) * A / ((jU - jD) * D);
      }
      setNormal(out, k, -fx, 1, -fz);
    }
  };

  /*
   * Angle between two normal fields, in degrees. Stats skip sea vertices and the shoreline ring:
   * the displayed surface max(h, sea) has a crease there, so no derivative exists to compare with.
   */
  TerrainMesh.prototype.compare = function (a, ref, errOut) {
    const N = this.N, V = N * N, raw = this.raw, sea = this.sea;
    const shore = (k) => { const i = k % N, j = (k / N) | 0;
      return (i > 0 && raw[k - 1] <= sea) || (i < N - 1 && raw[k + 1] <= sea) || (j > 0 && raw[k - N] <= sea) || (j < N - 1 && raw[k + N] <= sea); };
    let sum = 0, sq = 0, max = 0, n = 0;
    for (let k = 0; k < V; k++) {
      let d = a[3 * k] * ref[3 * k] + a[3 * k + 1] * ref[3 * k + 1] + a[3 * k + 2] * ref[3 * k + 2];
      d = d > 1 ? 1 : d < -1 ? -1 : d;
      const ang = Math.acos(d) * RAD2DEG;
      if (errOut) errOut[k] = ang;
      if (raw[k] <= sea || shore(k)) continue;
      sum += ang; sq += ang * ang; n++; if (ang > max) max = ang;
    }
    return n ? { mean: sum / n, rms: Math.sqrt(sq / n), max } : { mean: 0, rms: 0, max: 0 };
  };

  /*
   * Horizon based ambient occlusion. March 8 directions; in each keep the steepest
   * elevation angle theta to the horizon, tan(theta) = A dh / distance.
   * Visible sky fraction in that slice is 1 - sin(theta); AO is the average over slices.
   */
  TerrainMesh.prototype.computeAO = function () {
    const N = this.N, h = this.disp, A = this.A, D = this.D, ao = this.ao, raw = this.raw, sea = this.sea;
    const sc = Math.max(1, N / 256);
    const steps = [1, 2, 3, 5, 8, 12, 17, 24, 32].map((s) => Math.max(1, Math.round(s * sc)));
    const dirs = [];
    for (let a = 0; a < 8; a++) {
      const th = (a * Math.PI) / 4, list = [];
      for (const s of steps) {
        const di = Math.round(Math.cos(th) * s), dj = Math.round(Math.sin(th) * s);
        list.push([di, dj, Math.hypot(di, dj) * D]);
      }
      dirs.push(list);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (raw[k] <= sea) { ao[k] = 1; continue; }
      const h0 = h[k];
      let sum = 0;
      for (let d = 0; d < 8; d++) {
        let maxT = 0;
        const list = dirs[d];
        for (let s = 0; s < list.length; s++) {
          const ii = i + list[s][0], jj = j + list[s][1];
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) break;
          const tn = (h[jj * N + ii] - h0) * A / list[s][2];
          if (tn > maxT) maxT = tn;
        }
        sum += 1 - maxT / Math.sqrt(1 + maxT * maxT);
      }
      ao[k] = sum / 8;
    }
  };

  TL.TerrainMesh = TerrainMesh;
})(typeof window !== "undefined" ? window : globalThis);
