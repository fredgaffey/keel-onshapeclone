// Airfoil sections for the default scripts: Clark-Y and NACA 4-digit, as closed point loops.
// Pure functions, no DOM: used in the browser (Keel's Scripts panel) and in node (tests, headless).

// Clark-Y ordinates, % chord, from the flat lower surface (x, upper, lower).
const CLARK_Y = [
  [0, 3.50, 3.50], [1.25, 5.45, 1.93], [2.5, 6.50, 1.47], [5, 7.90, 0.93], [7.5, 8.85, 0.63],
  [10, 9.60, 0.42], [15, 10.68, 0.15], [20, 11.36, 0.03], [30, 11.70, 0], [40, 11.40, 0],
  [50, 10.52, 0], [60, 9.15, 0], [70, 7.35, 0], [80, 5.22, 0], [90, 2.80, 0], [95, 1.49, 0], [100, 0.12, 0],
];
const CLARK_Y_T = 0.117; // its maximum thickness / chord

/** Natural cubic spline through (xs, ys); returns f(x). */
export function cubic(xs, ys) {
  const n = xs.length - 1, h = [], a = [0], l = [1], mu = [0], z = [0], c = new Array(n + 1).fill(0), b = [], d = [];
  for (let i = 0; i < n; i++) h[i] = xs[i + 1] - xs[i];
  for (let i = 1; i < n; i++) a[i] = 3 / h[i] * (ys[i + 1] - ys[i]) - 3 / h[i - 1] * (ys[i] - ys[i - 1]);
  for (let i = 1; i < n; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (a[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  for (let j = n - 1; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (ys[j + 1] - ys[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }
  return (x) => {
    let i = 0;
    while (i < n - 1 && x > xs[i + 1]) i++;
    const t = x - xs[i];
    return ys[i] + b[i] * t + c[i] * t * t + d[i] * t * t * t;
  };
}

// Clark-Y as camber (about its chord line, LE to TE midpoint) and thickness / sqrt(x), both smooth.
const cyX = CLARK_Y.map((r) => r[0] / 100);
const cyLe = CLARK_Y[0][1] / 100, cyTe = (CLARK_Y.at(-1)[1] + CLARK_Y.at(-1)[2]) / 200;
const cyCamber = cubic(cyX, CLARK_Y.map((r, i) => (r[1] + r[2]) / 200 - (cyLe + (cyTe - cyLe) * cyX[i])));
const cyTs = CLARK_Y.map((r) => (r[1] - r[2]) / 100);
const cyTsq = cubic(cyX.slice(1), cyTs.slice(1).map((t, i) => t / Math.sqrt(cyX[i + 1])));

/** Parse "clark-y" | "naca4412" | "NACA 2410" → {kind, m, p, t?}. Throws on anything else. */
export function parseAirfoil(name = 'clark-y') {
  const s = String(name).toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'clarky' || s === 'clark') return { kind: 'clarky' };
  const m = s.match(/^naca(\d)(\d)(\d\d)$/);
  if (m) return { kind: 'naca', m: +m[1] / 100, p: +m[2] / 10, t: +m[3] / 100 };
  throw new Error(`unknown airfoil "${name}" (use clark-y or naca + 4 digits, e.g. naca4412)`);
}

/** Camber y and half-thickness at x (0…1) for a unit chord with max thickness ratio t. */
function shape(af, x, t) {
  if (af.kind === 'clarky') {
    const half = (x <= 0 ? 0 : cyTsq(Math.max(x, cyX[1])) * Math.sqrt(x)) / 2 * (t / CLARK_Y_T);
    return { yc: cyCamber(x), half, slope: 0 };
  }
  const { m, p } = af;
  const half = 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  if (!m || !p) return { yc: 0, half, slope: 0 };
  const yc = x < p ? m / p ** 2 * (2 * p * x - x * x) : m / (1 - p) ** 2 * (1 - 2 * p + 2 * p * x - x * x);
  const slope = x < p ? 2 * m / p ** 2 * (p - x) : 2 * m / (1 - p) ** 2 * (p - x);
  return { yc, half, slope };
}

/**
 * A unit-chord section as an open point list: upper trailing edge → leading edge → lower trailing edge.
 * t: thickness / chord (the NACA code's own thickness is replaced by it), te: trailing-edge
 * thickness / chord (kept open so the loop closes with a short straight edge), n: points per side.
 */
export function unitSection(airfoil, t, te = 0.01, n = 24) {
  const af = typeof airfoil === 'string' ? parseAirfoil(airfoil) : airfoil;
  const pt = (x, side) => {
    const s = shape(af, x, t);
    const h = s.half + te * x / 2;
    const th = Math.atan(s.slope);
    return [x - side * h * Math.sin(th), s.yc + side * h * Math.cos(th)];
  };
  // Points close together at the leading edge only (half-cosine): even spans aft, so the loft's
  // faces (one per spline span) stay a usable size towards the trailing edge.
  const xs = Array.from({ length: n + 1 }, (_, i) => 1 - Math.cos(Math.PI / 2 * i / n));
  const upper = xs.slice().reverse().map((x) => pt(x, 1));
  const lower = xs.slice(1).map((x) => pt(x, -1));
  return upper.concat(lower);
}

/**
 * The same section as a closed loop for a periodic (smooth, seamless) spline: the open trailing
 * edge is rounded with a half circle of its own thickness, so the loop has no corners. Starts at
 * the upper trailing edge; the closing point is implied.
 */
export function closedSection(airfoil, t, te = 0.01, n = 24) {
  const pts = unitSection(airfoil, t, Math.max(te, 0.002), n);
  const a = pts[0], b = pts.at(-1); // upper and lower trailing-edge points
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rr = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2;
  const base = Math.atan2(a[1] - b[1], a[0] - b[0]); // direction lower → upper
  const arc = [];
  for (const k of [1, 2, 3]) { // lower → aft → upper, ends excluded
    const ang = base - Math.PI + k * Math.PI / 4;
    arc.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]);
  }
  return pts.concat(arc);
}
