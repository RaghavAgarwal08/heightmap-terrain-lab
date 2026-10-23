/*
 * shaders.js
 * Terrain and sky GLSL. All lighting runs in linear space; output goes through
 * an ACES filmic tone curve and then the sRGB gamma.
 */
(function (root) {
  "use strict";
  const TL = (root.TL = root.TL || {});

  const common = `
vec3 toLin(vec3 c){ return pow(c, vec3(2.2)); }
vec3 toSRGB(vec3 c){ return pow(clamp(c, 0.0, 1.0), vec3(1.0/2.2)); }
// Narkowicz fit of the ACES filmic curve
vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03)) / (x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }
`;

  TL.terrainVS = `
uniform float uAmp;
attribute float aRaw;
attribute float aAO;
attribute float aErr;
varying vec3 vN;
varying vec3 vWorld;
varying float vH;
varying float vRaw;
varying float vAO;
varying float vErr;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vH = position.y / uAmp;      // displayed height, 0..1
  vRaw = aRaw;                 // height before the sea surface was flattened
  vAO = aAO;
  vErr = aErr;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

  TL.terrainFS = common + `
uniform vec3 uLight;
uniform float uSea, uAmp, uSize, uMode, uSlopeRock, uContours, uShadows, uFog, uErrMax, uTexN;
uniform sampler2D uHeightTex;
varying vec3 vN;
varying vec3 vWorld;
varying float vH;
varying float vRaw;
varying float vAO;
varying float vErr;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f*f*(3.0 - 2.0*f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}

// terrain height at world (x, z): manual bilinear filter of the height texture (texel k = vertex k)
float terrainY(vec2 xz){
  vec2 st = clamp(xz / uSize + 0.5, 0.0, 1.0) * (uTexN - 1.0);
  vec2 i = floor(st), f = st - i;
  float inv = 1.0 / uTexN;
  vec2 c = (i + 0.5) * inv;
  float a = texture2D(uHeightTex, c).r;
  float b = texture2D(uHeightTex, c + vec2(inv, 0.0)).r;
  float d = texture2D(uHeightTex, c + vec2(0.0, inv)).r;
  float e = texture2D(uHeightTex, c + vec2(inv, inv)).r;
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y) * uAmp;
}

// march toward the sun; penumbra width ~ smallest (clearance / distance) seen along the ray
float softShadow(vec3 p, vec3 L){
  if(L.y <= 0.0) return 0.0;
  float res = 1.0, t = 0.04, hw = uSize * 0.5;
  for(int s = 0; s < 48; s++){
    vec3 q = p + L * t;
    if(abs(q.x) > hw || abs(q.z) > hw || q.y > uAmp * 1.02) break;
    float clear = q.y - terrainY(q.xz);
    if(clear < 0.0005) return 0.0;
    res = min(res, 12.0 * clear / t);
    t += max(0.03, clear * 0.7);
  }
  return smoothstep(0.0, 1.0, res);
}

vec3 heat(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.05, 0.08, 0.30), c1 = vec3(0.10, 0.60, 0.60), c2 = vec3(0.98, 0.84, 0.25), c3 = vec3(0.85, 0.14, 0.10);
  if(t < 0.3333) return mix(c0, c1, t * 3.0);
  if(t < 0.6667) return mix(c1, c2, t * 3.0 - 1.0);
  return mix(c2, c3, t * 3.0 - 2.0);
}

void main(){
  vec3 N = normalize(vN);
  vec3 L = normalize(uLight);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndl = max(dot(N, L), 0.0);                 // Lambert cosine term
  bool water = vRaw < uSea;

  if(uMode > 0.5 && uMode < 1.5){ gl_FragColor = vec4(N * 0.5 + 0.5, 1.0); return; }
  if(uMode > 1.5 && uMode < 2.5){ gl_FragColor = vec4(heat(vErr / uErrMax) * (0.6 + 0.4 * ndl), 1.0); return; }
  if(uMode > 2.5 && uMode < 3.5){ gl_FragColor = vec4(heat(degrees(acos(clamp(N.y, -1.0, 1.0))) / 50.0) * (0.6 + 0.4 * ndl), 1.0); return; }
  if(uMode > 3.5 && uMode < 4.5){ gl_FragColor = vec4(vec3(pow(vAO, 1.5)), 1.0); return; }

  float sh = uShadows > 0.5 ? softShadow(vWorld + N * 0.02, L) : 1.0;
  if(uMode > 4.5){ gl_FragColor = vec4(toSRGB(vec3(0.75) * (ndl * sh + 0.12 * vAO)), 1.0); return; }

  /* ---- albedo from height, slope and a little noise ---- */
  float t = (vH - uSea) / max(1.0 - uSea, 0.001);                 // height above sea, 0..1
  float slope = 1.0 - N.y;                                          // 0 flat, 1 vertical
  float n = vnoise(vWorld.xz * 3.0) * 0.6 + vnoise(vWorld.xz * 11.0) * 0.4;
  float tj = t + (n - 0.5) * 0.06;                                  // jitter so bands are not lines
  vec3 alb = toLin(vec3(0.82, 0.76, 0.56));                         // sand
  alb = mix(alb, toLin(vec3(0.38, 0.55, 0.22)), smoothstep(0.02, 0.07, tj));   // grass
  alb = mix(alb, toLin(vec3(0.17, 0.33, 0.15)), smoothstep(0.22, 0.38, tj));   // forest
  alb = mix(alb, toLin(vec3(0.46, 0.42, 0.38)), smoothstep(0.48, 0.62, tj));   // scree
  alb = mix(alb, toLin(vec3(0.34, 0.30, 0.27)), smoothstep(0.30, 0.50, slope + (n - 0.5) * 0.1) * uSlopeRock); // cliffs
  alb = mix(alb, toLin(vec3(0.95, 0.96, 0.99)), smoothstep(0.58, 0.66, tj + 0.25 * (N.y - 0.85)));         // snow sticks to flat faces
  if(water){
    float depth = clamp((uSea - vRaw) / max(uSea, 0.001), 0.0, 1.0);
    alb = mix(toLin(vec3(0.20, 0.46, 0.50)), toLin(vec3(0.02, 0.09, 0.19)), sqrt(depth));
  }

  /* ---- lighting: sun * Lambert * shadow + hemisphere sky * AO ---- */
  vec3 sunC = vec3(1.0, 0.92, 0.80) * 3.2;
  vec3 skyC = toLin(vec3(0.42, 0.58, 0.82));
  vec3 horizon = toLin(vec3(0.78, 0.84, 0.90));
  vec3 amb = mix(toLin(vec3(0.30, 0.27, 0.22)), skyC, N.y * 0.5 + 0.5) * 0.9 * vAO;
  vec3 col = alb * (sunC * ndl * sh + amb);

  if(water){
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);   // Schlick Fresnel, F0 = 0.02
    col = mix(col, mix(horizon, skyC, 0.5), F);
    col += sunC * pow(max(dot(N, normalize(L + V)), 0.0), 900.0) * sh * 2.0;   // Blinn highlight
  }

  if(uContours > 0.5){
    float h = vH * 25.0;
    float w = fwidth(h);                                            // screen space derivative: 1px lines
    float line = 1.0 - smoothstep(0.0, w * 1.2, abs(fract(h - 0.5) - 0.5));
    col *= 1.0 - 0.6 * line;
  }

  /* ---- aerial perspective: exponential fog toward the horizon, warmer toward the sun ---- */
  float f = 1.0 - exp(-length(cameraPosition - vWorld) * uFog);
  vec3 fogC = mix(horizon, vec3(1.0, 0.88, 0.70), pow(max(dot(-V, L), 0.0), 8.0) * 0.5);
  col = mix(col, fogC, f);

  gl_FragColor = vec4(toSRGB(aces(col)), 1.0);
}`;

  TL.skyVS = `
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

  TL.skyFS = common + `
uniform vec3 uLight;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 zen = toLin(vec3(0.30, 0.48, 0.78)), hor = toLin(vec3(0.78, 0.84, 0.90)), gnd = toLin(vec3(0.22, 0.24, 0.24));
  vec3 c = d.y > 0.0 ? mix(hor, zen, sqrt(d.y)) : mix(hor, gnd, min(-d.y * 4.0, 1.0));
  float s = max(dot(d, normalize(uLight)), 0.0);
  c += vec3(1.0, 0.9, 0.7) * (pow(s, 900.0) * 30.0 + pow(s, 8.0) * 0.3);
  gl_FragColor = vec4(toSRGB(aces(c)), 1.0);
}`;
})(typeof window !== "undefined" ? window : globalThis);
