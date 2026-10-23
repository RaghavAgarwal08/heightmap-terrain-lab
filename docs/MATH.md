# The math behind Heightmap Terrain Lab

Notation. Terrain coordinates are (u, v) in [0, 1]². The world is S units wide, heights are scaled by A, the grid is N × N with spacing Δ = S / (N − 1).

## 1. Height function with exact derivatives

### Gradient noise
Each lattice corner gets a random unit gradient g (256 random angles, so the noise is isotropic). With f the fractional position and corner contributions

```
va = ga·f      vb = gb·(f − (1,0))      vc = gc·(f − (0,1))      vd = gd·(f − (1,1))
```

and the quintic fade u(t) = 6t⁵ − 15t⁴ + 10t³ (so u'(t) = 30t²(t − 1)², continuous second derivative),

```
n     = va + ux(vb − va) + uy(vc − va) + ux·uy·k              k = va − vb − vc + vd
∂n/∂x = ga.x + ux(gb.x − ga.x) + uy(gc.x − ga.x) + ux·uy(ga.x − gb.x − gc.x + gd.x) + ux'(vb − va + uy·k)
∂n/∂y = (same with y, swapping the roles of ux and uy)
```

### fBm with rotated octaves
Octave o samples n(q) with q = M_o p + c_o and M_{o+1} = L·R·M_o, where L is the lacunarity and R rotates by atan(3/4). The rotation stops octave lattices from lining up, which removes axis aligned artifacts. By the chain rule ∇_p n(q) = M_oᵀ ∇_q n, so

```
f = Σ a_o w_o n(M_o p + c_o) / Σ a_o          ∇f = Σ a_o w_o M_oᵀ ∇n / Σ a_o
```

### Band limiting (anti aliasing in space)
A grid can only represent frequencies below its Nyquist limit of (N − 1)/2 cycles across the terrain. Octaves above that alias: the mesh cannot show them, but the exact gradient still contains them. Each octave therefore gets a constant weight

```
w_o = 1 − smoothstep(f_cut / 4, f_cut / 2, L^o)
```

which fades octaves out between 8 and 4 samples per cycle. Because w_o does not depend on position, the derivative formula stays exact. In the app, turning this off raises the mean normal error at 256 × 256 from about 0.9° to about 9°.

### Domain warp
```
w(p) = p + W·(A(ωp), B(ωp))           J = ∂w/∂p = I + W·ω·[∇Aᵀ; ∇Bᵀ]
s(p) = f(w(p))                          ∇_p s = Jᵀ ∇f(w)
```

### Shaping
```
t = (s − s_min) / (s_max − s_min)        e = t^γ                  ∂e = γ t^(γ−1) ∂t
m = 1 − smoothstep(r0, r1, r)            r = |(2u − 1, 2v − 1)|     ∂r/∂u = 2(2u − 1) / r
h = e·m                                  ∂h/∂u = ∂e/∂u · m + e · m'(r) · ∂r/∂u
```

`tests/math.test.js` checks this whole chain against central finite differences at 5,000 random points (max relative error about 2 × 10⁻⁸).

## 2. Mesh

Vertex (i, j) is at x = iΔ − S/2, y = A·max(h, sea), z = jΔ − S/2, with uv = (i, j)/(N − 1). The sea is flattened so water is a plane.

Each cell with corners a = jN + i, b = a + 1, c = a + N, d = c + 1 has two possible diagonals. Both have the same length in xz, so the shorter one in 3D is the one with the smaller height difference. Splitting along it (|h_a − h_d| < |h_b − h_c|) gives better shaped triangles that follow ridges and valleys instead of cutting across them.

```
diagonal a–d:  (a, c, d)  (a, d, b)          diagonal b–c:  (a, c, b)  (b, c, d)
```

Both orders are counter clockwise seen from +Y. For example (c − a) × (d − a) = (0, 0, Δ) × (Δ, 0, Δ) = (0, Δ², 0). Triangle count is 2(N − 1)².

## 3. Normals

The surface is a graph y = F(x, z). Its tangents are (1, F_x, 0) and (0, F_z, 1), and their cross product is

```
n = normalize(−F_x, 1, −F_z)
```

The four methods differ only in how F_x and F_z are found.

| Method | Slope | Notes |
|---|---|---|
| Analytic | F_x = (A/S)·∂h/∂u | exact, from section 1 |
| Central difference | (h[i+1] − h[i−1])·A / 2Δ | second order, O(Δ²) |
| Sobel 3 × 3 | [1 2 1] smoothed central difference / 8Δ | second order, smoother, biased on sharp detail |
| Face weighted | Σ (e₁ × e₂) over adjacent triangles | area weighted, since \|e₁ × e₂\| = 2·area |

Measured RMS error against the exact normal of a known surface:

```
N      central    sobel      face
33     0.518°     1.011°     2.121°
65     0.148°     0.270°     0.751°
129    0.045°     0.073°     0.264°
257    0.016°     0.020°     0.093°
```

Halving Δ cuts central difference error by about 3.5 to 4 times, which is the expected second order convergence. The app computes the same comparison live on the generated terrain and shows it as a table and as a heatmap.

## 4. Hydraulic erosion

Each droplet has position p, direction d, speed s, water w and sediment c. Per step:

```
d ← normalize(d·inertia − ∇h·(1 − inertia))
p ← p + d
Δh = h(p_new) − h(p_old)
C  = max(−Δh · s · w · K_c, C_min)                           carrying capacity
if c > C or Δh > 0:  deposit (bilinear into the 4 cell corners)
else:                erode min((C − c)·K_e, −Δh) with a radial brush
s ← sqrt(max(0, s² − g·Δh))                                  energy conservation
w ← w·(1 − evaporation)
```

The speed update comes from v² = v₀² + 2g(−Δh), so droplets speed up going downhill. Heights are scaled by (N − 1)/255 while eroding, so slope per cell, and therefore the result, is the same at every grid resolution.

## 5. Ambient occlusion

For each vertex, march 8 directions and keep the steepest elevation angle θ to the horizon, tan θ = A·Δh / distance. The visible sky fraction in that slice is 1 − sin θ, and AO is the average over the 8 slices.

## 6. Shading (GLSL)

All lighting is in linear space.

```
albedo      height ramp (sand → grass → forest → scree → snow) with smoothstep blends,
            jittered by value noise so bands are not straight lines,
            cliffs where slope = 1 − n.y is high, snow only where n.y is high
direct      sun · max(n·l, 0) · shadow
ambient     mix(ground bounce, sky, n.y·0.5 + 0.5) · AO
water       Schlick Fresnel F = 0.02 + 0.98(1 − n·v)⁵ toward the sky, Blinn highlight
fog         1 − exp(−distance · density), warmer toward the sun
output      ACES filmic tone curve, then sRGB gamma 1/2.2
```

Shadows are raymarched in the fragment shader. The height field is uploaded as a float texture and sampled with manual bilinear filtering. The ray steps toward the sun, and the penumbra is the smallest ratio k·clearance / distance seen along the way, which gives soft shadows that widen with distance from the occluder.
