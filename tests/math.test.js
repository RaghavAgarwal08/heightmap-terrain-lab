/*
 * Math tests. Run with:  node tests/math.test.js
 * Checks the analytic derivatives against finite differences, the mesh topology and winding,
 * the convergence order of the numeric normal methods, and erosion stability.
 */
"use strict";
require("../src/noise.js");
require("../src/erosion.js");
require("../src/mesh.js");
const TL = globalThis.TL;

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
}
const rnd = TL.mulberry32(42);

/* 1. gradient noise derivative vs central finite difference */
{
  const n = new TL.GradientNoise(7), o = new Float64Array(3), a = new Float64Array(3), b = new Float64Array(3);
  const e = 1e-6;
  let worst = 0;
  for (let s = 0; s < 20000; s++) {
    const x = rnd() * 50 - 25, y = rnd() * 50 - 25;
    n.eval(x, y, o);
    const fx = (n.eval(x + e, y, a)[0] - n.eval(x - e, y, b)[0]) / (2 * e);
    const fy = (n.eval(x, y + e, a)[0] - n.eval(x, y - e, b)[0]) / (2 * e);
    worst = Math.max(worst, Math.abs(fx - o[1]), Math.abs(fy - o[2]));
  }
  check("noise analytic gradient matches finite difference", worst < 1e-6, `max abs error ${worst.toExponential(2)}`);
}

/* 2. full height pipeline (rotated fBm + domain warp + redistribution + island) */
{
  const P = { seed: 1337, scale: 2.2, octaves: 7, persistence: 0.5, lacunarity: 2, exponent: 1.5, island: 1, warp: 0.5, warpFreq: 0.8 };
  const smp = TL.generateNoise(P, 129).sampler;
  const o = new Float64Array(4), e = 1e-7;
  let worst = 0, tested = 0;
  for (let s = 0; s < 5000; s++) {
    const u = 0.02 + rnd() * 0.96, v = 0.02 + rnd() * 0.96;
    smp.height(u, v, o);
    if (!o[3]) continue;
    const gu = o[1], gv = o[2];
    const fu = (smp.height(u + e, v)[0] - smp.height(u - e, v)[0]) / (2 * e);
    const fv = (smp.height(u, v + e)[0] - smp.height(u, v - e)[0]) / (2 * e);
    const scale = Math.max(1, Math.abs(gu), Math.abs(gv));
    worst = Math.max(worst, Math.abs(fu - gu) / scale, Math.abs(fv - gv) / scale);
    tested++;
  }
  check("warped fBm chain rule gradient matches finite difference", worst < 1e-5, `${tested} points, max rel error ${worst.toExponential(2)}`);
}

/* 3. mesh topology, winding and unit normals */
{
  const P = { seed: 9, scale: 2.2, octaves: 6, persistence: 0.5, lacunarity: 2, exponent: 1.5, island: 1, warp: 0.5, warpFreq: 0.8 };
  const N = 97, g = TL.generateNoise(P, N), m = new TL.TerrainMesh();
  m.allocate(N);
  m.build(g.h, { size: 10, amp: 2.4, sea: 0.14, adaptive: true });
  check("triangle count is 2(N-1)^2", m.idx.length / 3 === 2 * (N - 1) * (N - 1), `${m.idx.length / 3} triangles, ${m.flips} cells use the a-d diagonal`);
  let down = 0, degenerate = 0;
  for (let q = 0; q < m.idx.length; q += 3) {
    const a = 3 * m.idx[q], b = 3 * m.idx[q + 1], c = 3 * m.idx[q + 2], p = m.pos;
    const e1x = p[b] - p[a], e1z = p[b + 2] - p[a + 2], e2x = p[c] - p[a], e2z = p[c + 2] - p[a + 2];
    const ny = e1z * e2x - e1x * e2z;
    if (ny < 0) down++; if (ny === 0) degenerate++;
  }
  check("every triangle is counter clockwise seen from +Y", down === 0 && degenerate === 0, `${down} flipped, ${degenerate} degenerate`);
  let badLen = 0;
  for (const method of ["analytic", "central", "sobel", "face"]) {
    m.normals(method, m.tmp, g.gu, g.gv);
    for (let k = 0; k < N * N; k++) {
      const l = Math.hypot(m.tmp[3 * k], m.tmp[3 * k + 1], m.tmp[3 * k + 2]);
      if (Math.abs(l - 1) > 1e-5 || m.tmp[3 * k + 1] <= 0) badLen++;
    }
  }
  check("all normals are unit length and point up", badLen === 0);
}

/* 4. convergence: numeric normals vs exact normals of f(x,z) = 0.6 sin(1.3x) cos(0.9z) */
{
  const f = (x, z) => 0.6 * Math.sin(1.3 * x) * Math.cos(0.9 * z);
  const fx = (x, z) => 0.78 * Math.cos(1.3 * x) * Math.cos(0.9 * z);
  const fz = (x, z) => -0.54 * Math.sin(1.3 * x) * Math.sin(0.9 * z);
  const rows = [];
  for (const N of [33, 65, 129, 257]) {
    const m = new TL.TerrainMesh(); m.allocate(N);
    const H = new Float32Array(N * N), gu = new Float32Array(N * N), gv = new Float32Array(N * N);
    const S = 10;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i * S / (N - 1) - S / 2, z = j * S / (N - 1) - S / 2, k = j * N + i;
      H[k] = f(x, z); gu[k] = fx(x, z) * S; gv[k] = fz(x, z) * S;
    }
    m.build(H, { size: S, amp: 1, sea: -10, adaptive: true });
    m.normals("analytic", m.ref, gu, gv);
    const r = { N };
    for (const meth of ["central", "sobel", "face"]) { m.normals(meth, m.tmp); r[meth] = m.compare(m.tmp, m.ref).rms; }
    rows.push(r);
  }
  console.log("\n  RMS normal error in degrees vs exact surface");
  console.log("  N      central     sobel       face");
  for (const r of rows) console.log(`  ${String(r.N).padEnd(6)} ${r.central.toFixed(5).padEnd(11)} ${r.sobel.toFixed(5).padEnd(11)} ${r.face.toFixed(5)}`);
  const order = (meth) => Math.log2(rows[1][meth] / rows[2][meth]);
  console.log(`  observed order  central ${order("central").toFixed(2)}  sobel ${order("sobel").toFixed(2)}  face ${order("face").toFixed(2)}\n`);
  check("central difference converges at second order", order("central") > 1.7, `order ${order("central").toFixed(2)}`);
}

/* 5. erosion stays finite and non negative */
{
  const P = { seed: 3, scale: 2.2, octaves: 6, persistence: 0.5, lacunarity: 2, exponent: 1.5, island: 1, warp: 0.5, warpFreq: 0.8 };
  const N = 128, g = TL.generateNoise(P, N), H = Float32Array.from(g.h);
  const before = H.reduce((s, x) => s + x, 0);
  const er = new TL.Erosion(H, N, { droplets: 40000, radius: 3, erodeRate: 0.3, depositRate: 0.3, inertia: 0.05 }, 3);
  const t0 = Date.now();
  while (!er.step(5000));
  const ms = Date.now() - t0;
  let bad = 0, changed = 0;
  for (let k = 0; k < N * N; k++) { if (!isFinite(H[k]) || H[k] < 0) bad++; if (Math.abs(H[k] - g.h[k]) > 1e-4) changed++; }
  const after = H.reduce((s, x) => s + x, 0);
  check("erosion keeps heights finite and non negative", bad === 0, `${er.total} droplets in ${ms} ms, ${(100 * changed / (N * N)).toFixed(1)}% of vertices changed, mass ${((after / before - 1) * 100).toFixed(2)}%`);
}

console.log(failed ? `\n${failed} test(s) failed` : "\nAll tests passed");
process.exit(failed ? 1 : 0);
