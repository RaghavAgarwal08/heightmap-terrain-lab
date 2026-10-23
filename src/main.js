/*
 * main.js
 * Scene setup, build pipeline and UI. Three.js is used only for the renderer, camera,
 * orbit controls and to upload the buffers built in mesh.js.
 */
(function () {
  "use strict";
  const TL = window.TL, SIZE = 10;

  const P = {
    source: "noise", seed: 1337, scale: 2.2, octaves: 7, persistence: 0.5, lacunarity: 2.0,
    exponent: 1.5, island: 1, warp: 0.5, warpFreq: 0.8, bandlimit: 1,
    droplets: 80000, radius: 3, erodeRate: 0.3, depositRate: 0.3, inertia: 0.05,
    res: 256, amp: 2.4, sea: 0.14, adaptive: 1, normals: "analytic",
    mode: 0, slopeRock: 1, contours: 0, wire: 0, shadows: 1, fog: 0.008,
    az: 215, el: 24, orbit: 0
  };
  const S = { H: null, gu: null, gv: null, img: null, erosion: null, eroded: false, tGen: 0, tAO: 0, method: "analytic" };
  const TM = new TL.TerrainMesh();
  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();
  const analyticOK = () => !!S.gu && !S.eroded;

  /* ---------- three.js plumbing ---------- */
  const canvas = $("gl"), view = $("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 300);
  camera.position.set(9.5, 6.5, 9.5);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.target.set(0, 0.5, 0); controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495; controls.maxDistance = 40; controls.update();

  const light = new THREE.Vector3(0, 1, 0);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(120, 32, 16),
    new THREE.ShaderMaterial({ vertexShader: TL.skyVS, fragmentShader: TL.skyFS, side: THREE.BackSide, depthWrite: false, uniforms: { uLight: { value: light } } })
  );
  scene.add(sky);

  const uniforms = {
    uLight: { value: light }, uSea: { value: P.sea }, uAmp: { value: P.amp }, uSize: { value: SIZE },
    uMode: { value: 0 }, uSlopeRock: { value: 1 }, uContours: { value: 0 }, uShadows: { value: 1 },
    uFog: { value: P.fog }, uErrMax: { value: 1 }, uHeightTex: { value: null }, uTexN: { value: 1 }
  };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: TL.terrainVS, fragmentShader: TL.terrainFS, extensions: { derivatives: true }
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scene.add(mesh);

  let geo = null, heightTex = null, texData = null;
  function upload() {
    const N = TM.N;
    if (!geo || geo.userData.N !== N) {
      if (geo) geo.dispose();
      geo = new THREE.BufferGeometry();
      geo.userData.N = N;
      geo.setAttribute("position", new THREE.BufferAttribute(TM.pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(TM.nor, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(TM.uv, 2));
      geo.setAttribute("aRaw", new THREE.BufferAttribute(TM.raw, 1));
      geo.setAttribute("aAO", new THREE.BufferAttribute(TM.ao, 1));
      geo.setAttribute("aErr", new THREE.BufferAttribute(TM.err, 1));
      geo.setIndex(new THREE.BufferAttribute(TM.idx, 1));
      mesh.geometry.dispose(); mesh.geometry = geo;
      if (heightTex) heightTex.dispose();
      texData = new Float32Array(N * N * 4);
      heightTex = new THREE.DataTexture(texData, N, N, THREE.RGBAFormat, THREE.FloatType);
      heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;
      uniforms.uHeightTex.value = heightTex; uniforms.uTexN.value = N;
    } else {
      for (const name of ["position", "normal", "aRaw", "aAO", "aErr"]) geo.attributes[name].needsUpdate = true;
      geo.index.needsUpdate = true;
    }
    geo.computeBoundingSphere();
    for (let k = 0; k < N * N; k++) texData[4 * k] = TM.disp[k];
    heightTex.needsUpdate = true;
  }

  function updateLight() {
    const az = P.az * Math.PI / 180, el = P.el * Math.PI / 180;
    light.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
  }
  function updateUniforms() {
    uniforms.uSea.value = P.sea; uniforms.uAmp.value = P.amp; uniforms.uMode.value = P.mode;
    uniforms.uSlopeRock.value = P.slopeRock; uniforms.uContours.value = P.contours;
    uniforms.uShadows.value = P.shadows; uniforms.uFog.value = P.fog;
    material.wireframe = !!P.wire;
    $("legend-height").hidden = P.mode === 2 || P.mode === 3;
    $("legend-err").hidden = P.mode !== 2;
    $("legend-slope").hidden = P.mode !== 3;
  }

  /* ---------- build pipeline ---------- */
  function generate() {
    const N = P.res;
    TM.allocate(N);
    S.erosion = null; S.eroded = false; setErosionUI();
    const t0 = now();
    if (P.source === "image" && S.img) { S.H = TL.imageHeights(S.img, N); S.gu = S.gv = null; }
    else { const g = TL.generateNoise(P, N); S.H = g.h; S.gu = g.gu; S.gv = g.gv; }
    S.tGen = now() - t0;
    rebuild(true);
  }

  function rebuild(full) {
    const t0 = now();
    TM.build(S.H, { size: SIZE, amp: P.amp, sea: P.sea, adaptive: P.adaptive });
    S.method = P.normals === "analytic" && !analyticOK() ? "central" : P.normals;
    TM.normals(S.method, TM.nor, S.gu, S.gv);
    const tMesh = now() - t0;
    if (full) {
      const t1 = now(); TM.computeAO(); S.tAO = now() - t1;
      errorStats();
    } else TM.err.fill(0);
    upload(); updateUniforms(); renderStats(tMesh);
  }

  // compare every numeric method with the exact normals; per vertex error for the selected one
  function errorStats() {
    const tb = $("err-body");
    if (!analyticOK()) {
      TM.err.fill(0);
      tb.innerHTML = `<tr><td colspan="4" class="muted">No exact reference: ${S.eroded ? "the terrain was eroded" : "heights come from an image"}, so there is no closed form gradient.</td></tr>`;
      return;
    }
    TM.normals("analytic", TM.ref, S.gu, S.gv);
    const rows = [];
    for (const m of ["central", "sobel", "face"]) {
      TM.normals(m, TM.tmp);
      const s = TM.compare(TM.tmp, TM.ref);
      rows.push(`<tr${m === S.method ? ' class="sel"' : ""}><td>${LABEL[m]}</td><td>${s.mean.toFixed(3)}°</td><td>${s.rms.toFixed(3)}°</td><td>${s.max.toFixed(2)}°</td></tr>`);
    }
    tb.innerHTML = rows.join("");
    // heatmap: the selected numeric method, or central difference when the exact normals are shown
    const viz = S.method === "analytic" ? "central" : S.method;
    TM.normals(viz, TM.tmp);
    const s = TM.compare(TM.tmp, TM.ref, TM.err);
    const errMax = Math.max(0.5, Math.ceil(s.rms * 3 * 2) / 2);
    uniforms.uErrMax.value = errMax;
    $("err-label").textContent = LABEL[viz] + " vs exact";
    $("err-max").textContent = errMax.toFixed(1) + "°";
  }
  const LABEL = { analytic: "Analytic", central: "Central", sobel: "Sobel", face: "Face" };

  const fmt = (n) => n.toLocaleString("en-US");
  function renderStats(tMesh) {
    const N = TM.N;
    $("s-v").textContent = fmt(N * N);
    $("s-t").textContent = fmt(2 * (N - 1) * (N - 1));
    $("s-flip").textContent = P.adaptive ? (100 * TM.flips / ((N - 1) * (N - 1))).toFixed(1) + "%" : "off";
    $("s-gen").textContent = S.tGen.toFixed(1) + " ms";
    $("s-mesh").textContent = tMesh.toFixed(1) + " ms";
    $("s-ao").textContent = S.tAO.toFixed(1) + " ms";
    const an = $("seg-normals").querySelector('[data-v="analytic"]');
    an.disabled = !analyticOK();
    $("normals-note").textContent = analyticOK()
      ? "Analytic normals use the exact chain rule gradient. The table shows how far each numeric method is from it on land."
      : "Analytic normals need the closed form height function, so central difference is used instead.";
    setSeg("seg-normals", S.method);
  }

  /* ---------- scheduler: 0 = uniforms only, 1 = rebuild mesh, 2 = regenerate heights ---------- */
  let pending = 0, queued = false;
  function schedule(level) {
    if (level === 0) { updateUniforms(); updateLight(); return; }
    pending = Math.max(pending, level);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false; const l = pending; pending = 0;
      if (l === 2) generate(); else rebuild(!S.erosion);
    });
  }

  /* ---------- erosion ---------- */
  function startErosion() {
    if (!S.H || S.erosion) return;
    S.erosion = new TL.Erosion(S.H, TM.N, P, P.seed);
    S.eroded = true; setErosionUI();
  }
  function setErosionUI() {
    const e = S.erosion;
    $("erode").disabled = !!e;
    $("erode").textContent = e ? "Eroding…" : S.eroded ? "Erode again" : "Run erosion";
    $("bar").style.width = (e ? e.progress() * 100 : S.eroded ? 100 : 0) + "%";
    $("erode-note").textContent = e
      ? `${fmt(e.done)} of ${fmt(e.total)} droplets`
      : S.eroded ? "Done. Change any noise setting or press Reset to start over." : "Droplets carve channels and drop sediment in valleys.";
  }
  function tickErosion() {
    const e = S.erosion; if (!e) return;
    const t0 = now();
    let done = false;
    while (!done && now() - t0 < 12) done = e.step(250);
    if (done) { S.erosion = null; rebuild(true); } else rebuild(false);
    setErosionUI();
  }

  /* ---------- controls ---------- */
  const f2 = (v) => (+v).toFixed(2), f0 = (v) => String(Math.round(v));
  const SPEC = {
    "g-noise": [
      ["seed", "Seed", 1, 9999, 1, 2, f0],
      ["scale", "Base frequency", 0.5, 6, 0.1, 2, (v) => (+v).toFixed(1)],
      ["octaves", "Octaves", 1, 10, 1, 2, f0],
      ["persistence", "Persistence (gain per octave)", 0.2, 0.75, 0.01, 2, f2],
      ["lacunarity", "Lacunarity (frequency per octave)", 1.5, 3, 0.05, 2, f2],
      ["exponent", "Redistribution exponent", 0.5, 3, 0.05, 2, f2],
      ["warp", "Domain warp strength", 0, 2, 0.05, 2, f2],
      ["warpFreq", "Domain warp frequency", 0.2, 3, 0.05, 2, f2]
    ],
    "g-erode": [
      ["droplets", "Droplets (at 256 × 256)", 10000, 300000, 10000, -1, (v) => fmt(+v)],
      ["radius", "Brush radius", 1, 6, 1, -1, (v) => v + " cells"],
      ["erodeRate", "Erosion rate", 0.05, 0.9, 0.05, -1, f2],
      ["depositRate", "Deposition rate", 0.05, 0.9, 0.05, -1, f2],
      ["inertia", "Inertia", 0, 0.5, 0.01, -1, f2]
    ],
    "g-mesh": [
      ["res", "Grid resolution", 32, 512, 32, 2, (v) => v + " × " + v],
      ["amp", "Height scale", 0.3, 5, 0.05, 1, (v) => (+v).toFixed(2) + " u"],
      ["sea", "Sea level", 0, 0.5, 0.01, 1, f2]
    ],
    "g-shade": [
      ["slopeRock", "Cliffs on steep slopes", 0, 1, 0.05, 0, f2],
      ["fog", "Aerial perspective", 0, 0.05, 0.002, 0, (v) => (+v).toFixed(3)]
    ],
    "g-light": [
      ["az", "Azimuth", 0, 360, 1, 0, (v) => Math.round(v) + "°"],
      ["el", "Elevation", 2, 90, 1, 0, (v) => Math.round(v) + "°"]
    ]
  };
  const outputs = {};
  for (const gid in SPEC) {
    const host = $(gid);
    for (const [key, label, min, max, step, level, fmtv] of SPEC[gid]) {
      const row = document.createElement("div"); row.className = "row";
      const id = "in-" + key;
      row.innerHTML = `<label for="${id}">${label}</label><output for="${id}"></output><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${P[key]}">`;
      host.appendChild(row);
      const out = row.querySelector("output"), inp = row.querySelector("input");
      out.textContent = fmtv(P[key]); outputs[key] = { out, inp, fmtv };
      inp.addEventListener("input", () => { P[key] = +inp.value; out.textContent = fmtv(inp.value); if (level >= 0) schedule(level); });
    }
  }
  function addCheck(gid, key, label, level) {
    const l = document.createElement("label"); l.className = "check";
    l.innerHTML = `<input type="checkbox" id="in-${key}" ${P[key] ? "checked" : ""}> ${label}`;
    $(gid).appendChild(l);
    l.querySelector("input").addEventListener("change", (e) => { P[key] = e.target.checked ? 1 : 0; schedule(level); });
  }
  addCheck("g-noise", "island", "Island falloff mask", 2);
  addCheck("g-noise", "bandlimit", "Band limit octaves to the grid's Nyquist frequency", 2);
  addCheck("g-mesh", "adaptive", "Split each cell along its shorter 3D diagonal", 1);
  addCheck("g-shade", "shadows", "Raymarched soft shadows", 0);
  addCheck("g-shade", "contours", "Contour lines every 4% of height", 0);
  addCheck("g-shade", "wire", "Wireframe", 0);
  addCheck("g-light", "orbit", "Orbit the sun", 0);

  function setSeg(id, v) { $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === String(v)))); }
  function bindSeg(id, key, level, onPick) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || b.disabled) return;
      const v = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v;
      if (onPick && onPick(v) === false) return;
      P[key] = v; setSeg(id, v); schedule(level);
    });
  }
  bindSeg("seg-normals", "normals", 1);
  bindSeg("seg-mode", "mode", 0);
  bindSeg("seg-source", "source", 2, (v) => {
    if (v === "image" && !S.img) { $("file").click(); return false; }
    $("g-noise").hidden = v === "image";
  });
  $("erode").addEventListener("click", startErosion);
  $("reset").addEventListener("click", () => schedule(2));

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) { $("src-note").textContent = "That file is not an image. Use a PNG or JPEG heightmap."; return; }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        S.img = img; P.source = "image"; setSeg("seg-source", "image"); $("g-noise").hidden = true;
        $("src-note").textContent = `Using ${file.name} (${img.naturalWidth} × ${img.naturalHeight} px), resampled to the grid.`;
        schedule(2);
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  }
  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
  let dragDepth = 0;
  view.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").hidden = false; });
  view.addEventListener("dragover", (e) => e.preventDefault());
  view.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
  view.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("drop").hidden = true; loadFile(e.dataTransfer.files[0]); });

  /* ---------- loop ---------- */
  function resize() {
    const w = view.clientWidth, h = view.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(view); resize();

  function frame() {
    tickErosion();
    if (P.orbit) { P.az = (P.az + 0.2) % 360; const o = outputs.az; o.inp.value = P.az; o.out.textContent = o.fmtv(P.az); updateLight(); }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  updateLight(); generate(); frame();
})();
