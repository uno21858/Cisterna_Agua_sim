// Visor en vivo de la cisterna: planta y corte a escala con el flujo de la bomba de mezcla.
// El motor corre en el hilo principal con un presupuesto de tiempo por cuadro (SPEC.md, Visor).

let mod;
let motorReal = true;
try {
  mod = await import("./solver.js");
  if (typeof mod.Cisterna !== "function") throw new Error("solver.js no exporta Cisterna");
} catch (e) {
  console.warn("Uso el motor de prueba:", e.message);
  mod = await import("./stub_solver.js");
  motorReal = false;
}
const { DEFAULTS, validar, geometria, puntoOperacion, tiempoMezclaS, Cisterna } = mod;

const RAD = Math.PI / 180;
const PRESUPUESTO_MS = 8;
const MURO = 0.15; // solo dibujo (supuesto)
const LOSA = 0.10; // solo dibujo (supuesto)
const BOCA = 0.60; // boca de la tapa de 60 x 60 cm, solo dibujo (supuesto)
const POZO_DIAM = 0.10; // bomba de pozo de 4", solo dibujo (supuesto)
const MIBEE = { largo: 0.061, diam: 0.046 };
const TUBO = 0.0267; // PVC 3/4, diámetro exterior
const DIST_REJILLA = 0.5;
const FRANJA = 0.25;
const APAGA_S = 45 * 60;
const CADA_S = 10;
const ESTELA = 12;
const DT_PART_MAX = 0.2;

const $ = (id) => document.getElementById(id);
const copia = (o) => structuredClone(o);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const cm = (m) => Math.round(m * 100);
const r2 = (x) => Math.round(x * 100) / 100;
const reduceMov = matchMedia("(prefers-reduced-motion: reduce)").matches;

const cfg = copia(DEFAULTS);
let geo = geometria(copia(cfg));

const est = {
  corriendo: true,
  velocidad: 30,
  modo: "firmware",
  fondo: "c",
  planta: "promedio",
  zPlanta: 0.45,
  corte: "largo",
  capas: { part: !reduceMov, flechas: reduceMov, cotas: true, nombres: true },
  editar: false,
  lugar: "llenado",
};

let sim = null;
let deuda = 0;
let costoPaso = 4;
let espera = 0;
let vSim = 1;
let tDosis = 0;
let apagaEn = APAGA_S;
let proxMuestra = 0;
let serie = null;
let dosisT = [];
let deteccion = { cov5: null, todo10: null };
let ultimo = { stats: null, sondas: null };
let corridas = [];
let corrida = null;
let errorCfg = null;
let timerReinicio = 0;
let arrastre = null;

// ---------- tokens del tema ----------

let T = {};
let LUT = new Uint8ClampedArray(256 * 3);

function hexRgb(h) {
  h = h.trim().replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function leeTokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  T = {
    papel: g("--papel"), tinta: g("--tinta"), tinta2: g("--tinta-2"), tinta3: g("--tinta-3"),
    linea: g("--linea"), muro: g("--muro"), agua: g("--agua"), acento: g("--acento"),
    s: [g("--s1"), g("--s2"), g("--s3")], peligro: g("--peligro"), aviso: g("--aviso"),
    ui: g("--f-ui"), num: g("--f-num"),
  };
  const paradas = ["--ramp-0", "--ramp-1", "--ramp-2", "--ramp-3"].map((n) => hexRgb(g(n)));
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (paradas.length - 1);
    const a = Math.min(paradas.length - 2, Math.floor(f));
    const t = f - a;
    for (let c = 0; c < 3; c++) LUT[i * 3 + c] = paradas[a][c] * (1 - t) + paradas[a + 1][c] * t;
  }
  patron = null;
  for (const v of Object.values(vistas)) v.sucio = true;
  fondoSucio = true;
}

const fuente = (tam, peso = 500, mono = false) => `${peso} ${tam}px ${mono ? T.num : T.ui}`;

// ---------- simulación ----------

function bombaEncendida() {
  if (est.modo === "siempre") return true;
  if (est.modo === "apagada") return false;
  return sim.t < apagaEn - 1e-9;
}

function volumen(c = cfg) {
  return c.largo * c.ancho * c.nivel;
}

function arranca() {
  let nueva;
  try {
    nueva = new Cisterna(copia(cfg));
  } catch (e) {
    errorCfg = e.message;
    pintaAvisos();
    return false;
  }
  if (corrida && sim) corrida.activa = false;
  sim = nueva;
  errorCfg = null;
  deuda = 0;
  espera = 0;
  dosisT = [];
  serie = { t: [], s: [[], [], []], lo: [], hi: [], meta: [], nombres: [] };
  corrida = { n: (corridas[0]?.n ?? 0) + 1, ...resumenCfg(), cov5: null, todo10: null, tMax: 0, activa: true };
  corridas.unshift(corrida);
  if (corridas.length > 12) corridas.pop();
  echaCloro();
  tomaSnapshot();
  for (const v of Object.values(vistas)) {
    v.sucio = true;
    v.P = null;
  }
  fondoSucio = true;
  $("cargando").hidden = true;
  pintaAvisos();
  pintaCorridas();
  return true;
}

function echaCloro() {
  if (!sim) return;
  const g = geometria(copia(cfg));
  sim.dosifica(cfg.dosis_ml * cfg.cloralex_mg_ml, g.punto_dosis);
  tDosis = sim.t;
  dosisT.push(sim.t);
  apagaEn = sim.t + APAGA_S;
  deteccion = { cov5: null, todo10: null };
  registra();
}

function registra() {
  const st = sim.stats();
  const so = sim.valoresSondas();
  ultimo = { stats: st, sondas: so };
  const cf = sim.cFinal;
  const nombres = Object.keys(so);
  serie.nombres = nombres;
  serie.t.push(sim.t / 60);
  nombres.slice(0, 3).forEach((n, k) => serie.s[k].push(so[n]));
  serie.lo.push(st.cmin * cf);
  serie.hi.push(st.cmax * cf);
  serie.meta.push(cf);
  const tm = (sim.t - tDosis) / 60;
  const vol = sim.nx * sim.ny * sim.nz * sim.volCelda;
  const media = cf > 0 ? st.masa_mg / (vol * 1000) / cf : 1;
  if (tm > 0 && deteccion.cov5 == null && st.cov < 0.05) deteccion.cov5 = tm;
  if (tm > 0 && deteccion.todo10 == null && st.cmin >= 0.9 * media && st.cmax <= 1.1 * media) deteccion.todo10 = tm;
  if (dosisT.length === 1 && corrida) {
    corrida.tMax = tm;
    if (corrida.cov5 == null && deteccion.cov5 != null) corrida.cov5 = deteccion.cov5;
    if (corrida.todo10 == null && deteccion.todo10 != null) corrida.todo10 = deteccion.todo10;
  }
  proxMuestra = sim.t + CADA_S;
  graficaSucia = true;
}

function avanzaSim(dtReal) {
  if (!sim) return 0;
  deuda = Math.min(deuda + dtReal * est.velocidad, Math.max(0.5, est.velocidad * 0.25));
  if (espera > 0) {
    espera--;
    return 0;
  }
  const t0 = performance.now();
  const tIni = sim.t;
  let pasos = 0;
  while (deuda > 1e-4) {
    let dt = Math.min(sim.dtFlujo(), deuda);
    if (est.modo === "firmware" && sim.t < apagaEn - 1e-9) dt = Math.min(dt, apagaEn - sim.t);
    dt = Math.max(dt, 1e-4);
    sim.avanza(dt, { cloro: sim.cFinal > 0, bomba: bombaEncendida() });
    deuda -= dt;
    pasos++;
    if (sim.t >= proxMuestra - 1e-9) registra();
    if (performance.now() - t0 > PRESUPUESTO_MS) break;
  }
  if (pasos) {
    costoPaso = 0.8 * costoPaso + 0.2 * ((performance.now() - t0) / pasos);
    espera = costoPaso > PRESUPUESTO_MS * 1.5 ? Math.min(4, Math.floor(costoPaso / PRESUPUESTO_MS) - 1) : 0;
  }
  return sim.t - tIni;
}

function cambiaConsumo() {
  // El consumo no cambia la malla: paso el estado a un motor nuevo en vez de reiniciar.
  if (!sim) return;
  let nueva;
  try {
    nueva = new Cisterna({ ...copia(sim.cfg), consumo_lpm: cfg.consumo_lpm });
  } catch (e) {
    errorCfg = e.message;
    pintaAvisos();
    return;
  }
  if (nueva.u.length !== sim.u.length || nueva.c.length !== sim.c.length) return arranca();
  nueva.u.set(sim.u);
  nueva.v.set(sim.v);
  nueva.w.set(sim.w);
  nueva.c.set(sim.c);
  nueva.t = sim.t;
  nueva.cFinal = sim.cFinal;
  sim = nueva;
}

// ---------- velocidades en los centros (para partículas y flechas) ----------

const snap = { uc: null, vc: null, wc: null, spd: null, vmax: 0, vEsc: 0.05, tEsc: 0 };

function tomaSnapshot() {
  const { nx, ny, nz } = sim;
  const n = nx * ny * nz;
  if (!snap.uc || snap.uc.length !== n) {
    snap.uc = new Float32Array(n);
    snap.vc = new Float32Array(n);
    snap.wc = new Float32Array(n);
    snap.spd = new Float32Array(n);
  }
  Object.assign(snap, { nx, ny, nz, dx: sim.dx, dy: sim.dy, dz: sim.dz, L: sim.cfg.largo, W: sim.cfg.ancho, H: sim.cfg.nivel });
  const { u, v, w } = sim;
  let vmax = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const m = (i * ny + j) * nz + k;
        const mv = (i * (ny + 1) + j) * nz + k;
        const mw = (i * ny + j) * (nz + 1) + k;
        const a = 0.5 * (u[m] + u[m + ny * nz]);
        const b = 0.5 * (v[mv] + v[mv + nz]);
        const c = 0.5 * (w[mw] + w[mw + 1]);
        snap.uc[m] = a;
        snap.vc[m] = b;
        snap.wc[m] = c;
        const s = Math.sqrt(a * a + b * b + c * c);
        snap.spd[m] = s;
        if (s > vmax) vmax = s;
      }
    }
  }
  snap.vmax = vmax;
  const ahora = performance.now();
  if (ahora - snap.tEsc > 500) {
    snap.tEsc = ahora;
    const orden = Float32Array.from(snap.spd).sort();
    const p98 = orden[Math.floor(0.98 * (orden.length - 1))];
    snap.vEsc = Math.max(0.005, p98);
  }
}

const velTmp = [0, 0, 0];
function velEn(x, y, z, out = velTmp) {
  const { nx, ny, nz } = snap;
  const fi = clamp(x / snap.dx - 0.5, 0, nx - 1);
  const fj = clamp(y / snap.dy - 0.5, 0, ny - 1);
  const fk = clamp(z / snap.dz - 0.5, 0, nz - 1);
  const i0 = Math.min(fi | 0, nx - 2), j0 = Math.min(fj | 0, ny - 2), k0 = Math.min(fk | 0, nz - 2);
  const ti = fi - i0, tj = fj - j0, tk = fk - k0;
  const sx = ny * nz, sy = nz;
  const b = (i0 * ny + j0) * nz + k0;
  const w000 = (1 - ti) * (1 - tj) * (1 - tk), w001 = (1 - ti) * (1 - tj) * tk;
  const w010 = (1 - ti) * tj * (1 - tk), w011 = (1 - ti) * tj * tk;
  const w100 = ti * (1 - tj) * (1 - tk), w101 = ti * (1 - tj) * tk;
  const w110 = ti * tj * (1 - tk), w111 = ti * tj * tk;
  for (const [c, a] of [[0, snap.uc], [1, snap.vc], [2, snap.wc]]) {
    out[c] = a[b] * w000 + a[b + 1] * w001 + a[b + sy] * w010 + a[b + sy + 1] * w011
      + a[b + sx] * w100 + a[b + sx + 1] * w101 + a[b + sx + sy] * w110 + a[b + sx + sy + 1] * w111;
  }
  return out;
}

// ---------- geometría auxiliar ----------

function planoCorte() {
  const p = geo.pos_bomba;
  if (est.corte === "largo") return { o: [0, p[1]], h: [1, 0], n: [0, 1], h0: 0, h1: cfg.largo };
  const [hx, hy] = geo.plano_chorro;
  let h0 = -Infinity, h1 = Infinity;
  for (const [p0, d, L] of [[p[0], hx, cfg.largo], [p[1], hy, cfg.ancho]]) {
    if (Math.abs(d) > 1e-9) {
      const a = -p0 / d, b = (L - p0) / d;
      h0 = Math.max(h0, Math.min(a, b));
      h1 = Math.min(h1, Math.max(a, b));
    }
  }
  return { o: [p[0], p[1]], h: [hx, hy], n: [-hy, hx], h0, h1 };
}

function proy(pc, x, y) {
  const dx = x - pc.o[0], dy = y - pc.o[1];
  return [dx * pc.h[0] + dy * pc.h[1], dx * pc.n[0] + dy * pc.n[1]];
}

function rayoChorro(g = geo) {
  const p = g.pos_bomba, d = g.dir_chorro;
  let t = Infinity, donde = "pared";
  const planos = [[0, 0, "pared"], [0, cfg.largo, "pared"], [1, 0, "pared"], [1, cfg.ancho, "pared"],
    [2, 0, "fondo"], [2, cfg.nivel, "superficie"]];
  for (const [eje, val, tipo] of planos) {
    if (Math.abs(d[eje]) < 1e-9) continue;
    const ti = (val - p[eje]) / d[eje];
    if (ti > 1e-6 && ti < t) {
      t = ti;
      donde = tipo;
    }
  }
  const fin = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
  const r = [cfg.pozo[0] - p[0], cfg.pozo[1] - p[1], cfg.pozo[2] - p[2]];
  const tc = clamp(r[0] * d[0] + r[1] * d[1] + r[2] * d[2], 0, t);
  const dist = Math.hypot(r[0] - d[0] * tc, r[1] - d[1] * tc, r[2] - d[2] * tc);
  let op = null;
  try {
    op = puntoOperacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida);
  } catch {}
  // Chorro redondo libre: u_eje = 6.2 u0 d / x (estimación, vale lejos de la boquilla).
  const uFin = op ? Math.min(op.u_ms, 6.2 * op.u_ms * (cfg.boquilla_mm / 1000) / t) : 0;
  return { t, fin, donde, dist, tc, uFin };
}

function resumenCfg() {
  const p = geo.pos_bomba, d = geo.dir_chorro;
  let op = null;
  try {
    op = puntoOperacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida);
  } catch {}
  const az = Math.round(Math.atan2(d[1], d[0]) / RAD);
  const el = Math.round(Math.asin(clamp(d[2], -1, 1)) / RAD);
  const bomba = cfg.pos_bomba
    ? `libre (${p[0].toFixed(2)}, ${p[1].toFixed(2)}) a ${cm(p[2])} cm`
    : `mástil ${cfg.angulo_tubo}° a ${cm(p[2])} cm`;
  const chorro = `${az}° / ${el}° · ${cfg.boquilla_mm} mm · ${op ? Math.round(op.q_lh) : "-"} L/h`;
  const lugar = Array.isArray(cfg.lugar_dosis)
    ? `(${cfg.lugar_dosis[0].toFixed(2)}, ${cfg.lugar_dosis[1].toFixed(2)})`
    : cfg.lugar_dosis === "mastil" ? "boca" : "flotador";
  const formula = op ? tiempoMezclaS(volumen(), op.m_m4s2) / 60 : null;
  return { bomba, chorro, dosis: `${cfg.dosis_ml} mL, ${lugar}`, formula };
}

// ---------- vistas ----------

const vistas = {
  planta: creaVista("c-planta", "planta"),
  corte: creaVista("c-corte", "corte"),
};
let fondoSucio = true;
let graficaSucia = true;
let patron = null;

function creaVista(id, tipo) {
  const canvas = $(id);
  const over = document.createElement("canvas");
  const img = document.createElement("canvas");
  return {
    tipo, canvas, ctx: canvas.getContext("2d"), over, octx: over.getContext("2d"), img, ictx: img.getContext("2d"),
    w: 0, h: 0, dpr: 1, esc: 100, sucio: true, visible: true, manijas: [], P: null, ext: null,
  };
}

function dimensiona(v) {
  const w = v.canvas.parentElement.clientWidth;
  if (!w) return;
  const hMax = Math.max(240, window.innerHeight * (window.innerWidth >= 760 ? 0.62 : 0.75));
  let esc, h;
  if (v.tipo === "planta") {
    const m = { l: 14, r: 46, t: 14, b: 50 };
    const ew = cfg.largo + 2 * MURO, eh = cfg.ancho + 2 * MURO;
    esc = (w - m.l - m.r) / ew;
    h = m.t + m.b + eh * esc;
    if (h > hMax) {
      esc = (hMax - m.t - m.b) / eh;
      h = hMax;
    }
    const ox = m.l + (w - m.l - m.r - ew * esc) / 2 + MURO * esc;
    const W = cfg.ancho;
    v.X = (x) => ox + x * esc;
    v.Y = (y) => m.t + (W + MURO - y) * esc;
    v.inv = (px, py) => [(px - ox) / esc, W + MURO - (py - m.t) / esc];
  } else {
    const pc = planoCorte();
    v.pc = pc;
    const m = { l: 44, r: 52, t: 8, b: 50 };
    const zTop = cfg.z_tapa + LOSA + 0.30, zBot = -MURO;
    const ew = pc.h1 - pc.h0 + 2 * MURO, eh = zTop - zBot;
    esc = (w - m.l - m.r) / ew;
    h = m.t + m.b + eh * esc;
    if (h > hMax) {
      esc = (hMax - m.t - m.b) / eh;
      h = hMax;
    }
    const ox = m.l + (w - m.l - m.r - ew * esc) / 2 + MURO * esc;
    v.X = (s) => ox + (s - pc.h0) * esc;
    v.Y = (z) => m.t + (zTop - z) * esc;
    v.inv = (px, py) => [pc.h0 + (px - ox) / esc, zTop - (py - m.t) / esc];
  }
  h = Math.round(h);
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  if (v.w !== w || v.h !== h || v.dpr !== dpr) {
    v.w = w;
    v.h = h;
    v.dpr = dpr;
    v.canvas.style.height = h + "px";
    for (const c of [v.canvas, v.over]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    patron = null;
  }
  v.esc = esc;
  v.sucio = true;
}

function hazPatron(ctx, dpr) {
  const t = document.createElement("canvas");
  const s = Math.round(8 * dpr);
  t.width = t.height = s;
  const c = t.getContext("2d");
  c.strokeStyle = T.muro;
  c.lineWidth = Math.max(1, dpr * 0.9);
  c.beginPath();
  c.moveTo(0, s);
  c.lineTo(s, 0);
  c.moveTo(-s / 2, s / 2);
  c.lineTo(s / 2, -s / 2);
  c.moveTo(s / 2, s + s / 2);
  c.lineTo(s + s / 2, s / 2);
  c.stroke();
  const p = ctx.createPattern(t, "repeat");
  p.setTransform(new DOMMatrix().scale(1 / dpr));
  return p;
}

// ---------- primitivas de dibujo ----------

function texto(c, s, x, y, o = {}) {
  const { color = T.tinta, tam = 12, peso = 500, mono = false, alinea = "left", base = "middle", rot = 0, halo = true } = o;
  c.save();
  c.translate(x, y);
  if (rot) c.rotate(rot);
  c.font = fuente(tam, peso, mono);
  c.textAlign = alinea;
  c.textBaseline = base;
  if (halo) {
    c.lineJoin = "round";
    c.strokeStyle = T.papel;
    c.lineWidth = 3.5;
    c.strokeText(s, 0, 0);
  }
  c.fillStyle = color;
  c.fillText(s, 0, 0);
  c.restore();
}

function trazo(c, pts, color, ancho = 1, guiones = null) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.strokeStyle = color;
  c.lineWidth = ancho;
  c.setLineDash(guiones || []);
  c.stroke();
  c.setLineDash([]);
}

function flecha(c, x0, y0, x1, y1, color, ancho = 2, punta = 9) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  trazo(c, [[x0, y0], [x1 - Math.cos(a) * punta * 0.6, y1 - Math.sin(a) * punta * 0.6]], color, ancho);
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x1 - punta * Math.cos(a - 0.38), y1 - punta * Math.sin(a - 0.38));
  c.lineTo(x1 - punta * Math.cos(a + 0.38), y1 - punta * Math.sin(a + 0.38));
  c.closePath();
  c.fillStyle = color;
  c.fill();
}

function marcaSonda(c, x, y, color) {
  c.fillStyle = T.papel;
  c.fillRect(x - 6, y - 6, 12, 12);
  c.fillStyle = color;
  c.fillRect(x - 4, y - 4, 8, 8);
  c.strokeStyle = T.tinta;
  c.lineWidth = 1;
  c.strokeRect(x - 4.5, y - 4.5, 9, 9);
}

function marcaDosis(c, x, y) {
  c.beginPath();
  c.moveTo(x, y - 9);
  c.bezierCurveTo(x + 6, y - 2, x + 5, y + 4, x, y + 4);
  c.bezierCurveTo(x - 5, y + 4, x - 6, y - 2, x, y - 9);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.4;
  c.stroke();
}

function tache(c, x, y, color) {
  trazo(c, [[x - 5, y - 5], [x + 5, y + 5]], color, 2);
  trazo(c, [[x - 5, y + 5], [x + 5, y - 5]], color, 2);
}

// Cota al estilo de plano: línea fina, diagonales en los extremos y el número en cm.
function cotaH(c, x1, x2, y, txt, color = T.tinta2, yRef = null) {
  if (yRef != null) {
    trazo(c, [[x1, yRef], [x1, y + 4]], color, 0.8);
    trazo(c, [[x2, yRef], [x2, y + 4]], color, 0.8);
  }
  trazo(c, [[x1 - 4, y], [x2 + 4, y]], color, 1);
  for (const x of [x1, x2]) trazo(c, [[x - 4, y + 4], [x + 4, y - 4]], color, 1.2);
  texto(c, txt, (x1 + x2) / 2, y - 7, { color, tam: 11, mono: true, alinea: "center" });
}

function cotaV(c, x, y1, y2, txt, color = T.tinta2, xRef = null, lado = 1) {
  if (xRef != null) {
    trazo(c, [[xRef, y1], [x + 4 * lado, y1]], color, 0.8);
    trazo(c, [[xRef, y2], [x + 4 * lado, y2]], color, 0.8);
  }
  trazo(c, [[x, y1 + 4], [x, y2 - 4]], color, 1);
  for (const y of [y1, y2]) trazo(c, [[x - 4, y + 4], [x + 4, y - 4]], color, 1.2);
  texto(c, txt, x + 8 * lado, (y1 + y2) / 2, { color, tam: 11, mono: true, alinea: "center", rot: -Math.PI / 2 });
}

function barraEscala(c, x, y, esc) {
  const paso = esc > 140 ? 0.25 : 0.5;
  const n = 2;
  for (let i = 0; i < n; i++) {
    c.fillStyle = i % 2 ? T.papel : T.tinta2;
    c.fillRect(x + i * paso * esc, y, paso * esc, 5);
  }
  c.strokeStyle = T.tinta2;
  c.lineWidth = 1;
  c.strokeRect(x, y, n * paso * esc, 5);
  for (let i = 0; i <= n; i++) {
    texto(c, String(Math.round(i * paso * 100)) + (i === n ? " cm" : ""), x + i * paso * esc, y + 14,
      { tam: 10, mono: true, alinea: i === n ? "left" : "center", color: T.tinta2, halo: false });
  }
}

function cuerpoMibee(c, x, y, ang, esc) {
  const l = Math.max(MIBEE.largo * esc, 9), d = Math.max(MIBEE.diam * esc, 7);
  c.save();
  c.translate(x, y);
  c.rotate(ang + Math.PI / 2);
  c.beginPath();
  c.roundRect(-l / 2, -d / 2, l, d, 2);
  c.fillStyle = T.acento;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1;
  c.stroke();
  c.restore();
}

function manija(v, id, x, y, r, dibuja = true, forma = "anillo") {
  v.manijas.push({ id, x, y, r: Math.max(r, 20) });
  if (!dibuja) return;
  const c = v.octx;
  c.beginPath();
  if (forma === "cuadro") c.rect(x - 9, y - 9, 18, 18);
  else c.arc(x, y, r, 0, Math.PI * 2);
  c.strokeStyle = forma === "cuadro" ? T.tinta : T.acento;
  c.lineWidth = 1.2;
  c.setLineDash([3, 3]);
  c.stroke();
  c.setLineDash([]);
}

function limpiaOverlay(v) {
  const c = v.octx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, v.over.width, v.over.height);
  c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  if (!patron) patron = hazPatron(c, v.dpr);
  v.manijas = [];
  return c;
}

// ---------- planta ----------

function overlayPlanta(v) {
  const c = limpiaOverlay(v);
  const { X, Y, esc } = v;
  const L = cfg.largo, W = cfg.ancho;
  const ray = rayoChorro();
  const avisoRejilla = ray.dist < DIST_REJILLA;

  c.beginPath();
  c.rect(X(-MURO), Y(W + MURO), (L + 2 * MURO) * esc, (W + 2 * MURO) * esc);
  c.rect(X(0), Y(W), L * esc, W * esc);
  c.fillStyle = patron;
  c.fill("evenodd");
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.6;
  c.strokeRect(X(0), Y(W), L * esc, W * esc);
  c.lineWidth = 1;
  c.strokeRect(X(-MURO), Y(W + MURO), (L + 2 * MURO) * esc, (W + 2 * MURO) * esc);

  // Línea del corte A-A
  const pc = planoCorte();
  const a0 = [pc.o[0] + pc.h[0] * pc.h0, pc.o[1] + pc.h[1] * pc.h0];
  const a1 = [pc.o[0] + pc.h[0] * pc.h1, pc.o[1] + pc.h[1] * pc.h1];
  trazo(c, [[X(a0[0]), Y(a0[1])], [X(a1[0]), Y(a1[1])]], T.tinta3, 1, [10, 3, 2, 3]);
  for (const [p, sgn] of [[a0, -1], [a1, 1]]) {
    const px = X(p[0] + pc.h[0] * sgn * 0.06), py = Y(p[1] + pc.h[1] * sgn * 0.06);
    texto(c, "A", px, py, { tam: 11, peso: 700, alinea: "center", color: T.tinta2 });
  }

  // Boca de la tapa (arriba del plano de corte: línea oculta) y travesaño
  const [bx, by] = cfg.boca;
  trazo(c, [[X(bx - BOCA / 2), Y(by - BOCA / 2)], [X(bx + BOCA / 2), Y(by - BOCA / 2)], [X(bx + BOCA / 2), Y(by + BOCA / 2)],
    [X(bx - BOCA / 2), Y(by + BOCA / 2)], [X(bx - BOCA / 2), Y(by - BOCA / 2)]], T.tinta2, 1, [6, 4]);
  const [rx, ry] = geo.rumbo;
  trazo(c, [[X(bx + ry * BOCA / 2), Y(by - rx * BOCA / 2)], [X(bx - ry * BOCA / 2), Y(by + rx * BOCA / 2)]], T.tinta2, 3);

  // Zona a evitar alrededor de la rejilla
  const [px, py, pz] = cfg.pozo;
  c.beginPath();
  c.arc(X(px), Y(py), DIST_REJILLA * esc, 0, Math.PI * 2);
  c.strokeStyle = avisoRejilla ? T.peligro : T.tinta3;
  c.lineWidth = avisoRejilla ? 1.5 : 1;
  c.setLineDash([2, 4]);
  c.stroke();
  c.setLineDash([]);

  // Flotador: tubo desde la pared más cercana
  const [lx, ly] = cfg.llenado;
  const dists = [ly, W - ly, lx, L - lx];
  const kp = dists.indexOf(Math.min(...dists));
  const ent = kp === 0 ? [lx, -MURO] : kp === 1 ? [lx, W + MURO] : kp === 2 ? [-MURO, ly] : [L + MURO, ly];
  trazo(c, [[X(ent[0]), Y(ent[1])], [X(lx), Y(ly)]], T.tinta2, Math.max(2, 0.021 * esc));
  c.beginPath();
  c.arc(X(lx), Y(ly), Math.max(5, 0.06 * esc), 0, Math.PI * 2);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.3;
  c.stroke();

  // Bomba de pozo con la sonda de la llave en su rejilla
  c.beginPath();
  c.arc(X(px), Y(py), Math.max(5, (POZO_DIAM / 2) * esc), 0, Math.PI * 2);
  c.fillStyle = T.tinta2;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1;
  c.stroke();
  c.beginPath();
  c.arc(X(px), Y(py), Math.max(5, (POZO_DIAM / 2) * esc) + 3, 0, Math.PI * 2);
  c.strokeStyle = T.s[1];
  c.lineWidth = 2.5;
  c.stroke();

  // Mástil y sonda ORP
  const tope = [bx, by];
  const punta = geo.punto_tubo(cfg.z_orp);
  trazo(c, [[X(tope[0]), Y(tope[1])], [X(punta[0]), Y(punta[1])]], T.tinta2, Math.max(2.5, TUBO * esc));
  marcaSonda(c, X(punta[0]), Y(punta[1]), T.s[2]);
  marcaSonda(c, X(bx), Y(by), T.s[0]);

  // Dosis
  const pd = geo.punto_dosis;
  marcaDosis(c, X(pd[0]), Y(pd[1]) - 2);

  // Bomba de mezcla, chorro y amarre libre
  const pb = geo.pos_bomba, d = geo.dir_chorro;
  if (cfg.pos_bomba) trazo(c, [[X(bx), Y(by)], [X(pb[0]), Y(pb[1])]], T.acento, 1.2, [5, 4]);
  const colorRayo = avisoRejilla || ray.donde === "fondo" ? T.peligro : T.acento;
  trazo(c, [[X(pb[0]), Y(pb[1])], [X(ray.fin[0]), Y(ray.fin[1])]], colorRayo, 1.2, [2, 4]);
  tache(c, X(ray.fin[0]), Y(ray.fin[1]), colorRayo);
  const nh = Math.hypot(d[0], d[1]);
  const az = Math.atan2(d[1], d[0]);
  const lf = Math.max(0.5 * nh, 0.24);
  const tip = [pb[0] + Math.cos(az) * lf, pb[1] + Math.sin(az) * lf];
  flecha(c, X(pb[0]), Y(pb[1]), X(tip[0]), Y(tip[1]), T.acento, 2.5, 10);
  cuerpoMibee(c, X(pb[0]), Y(pb[1]), -az, esc);
  manija(v, "bomba", X(pb[0]), Y(pb[1]), 15);
  c.beginPath();
  c.arc(X(tip[0]), Y(tip[1]), 7, 0, Math.PI * 2);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.acento;
  c.lineWidth = 2;
  c.stroke();
  v.manijas.push({ id: "chorro", x: X(tip[0]), y: Y(tip[1]), r: 20 });

  if (est.editar) {
    manija(v, "boca", X(bx), Y(by), 12, true, "cuadro");
    manija(v, "pozo", X(px), Y(py), 12, true, "cuadro");
    manija(v, "llenado", X(lx), Y(ly), 12, true, "cuadro");
  }

  if (est.capas.nombres) {
    const n = (s, x, y, o) => texto(c, s, x, y, { tam: 12, color: T.tinta2, ...o });
    n("boca", X(bx - BOCA / 2) + 3, Y(by + BOCA / 2) - 8);
    n("bomba de pozo", X(px), Y(py) + 18, { alinea: "center" });
    n("flotador", X(lx), Y(ly) + (ly > W / 2 ? 18 : -18), { alinea: "center" });
    n("sonda ORP", X(punta[0]) + 10, Y(punta[1]) + 12);
    n(`mástil ${cfg.angulo_tubo}°`, X((bx + punta[0]) / 2) + 8, Y((by + punta[1]) / 2) - 8);
    const sx = Math.cos(az) >= 0 ? -1 : 1;
    n("bomba de mezcla", X(pb[0]) + sx * 18, Y(pb[1]) - 16, { alinea: sx < 0 ? "right" : "left", color: T.acento, peso: 600 });
    n("dosis", X(pd[0]) + 9, Y(pd[1]) - 4);
    const etq = ray.donde === "fondo" ? "pega en el fondo" : ray.donde === "superficie" ? "sale arriba" : "pega en la pared";
    n(etq, X(ray.fin[0]) + 8, Y(ray.fin[1]) + 12, { color: colorRayo, tam: 11 });
  }

  if (est.capas.cotas) {
    cotaH(c, X(0), X(L), Y(-MURO) + 18, String(cm(L)), T.tinta2, Y(-MURO) + 2);
    cotaV(c, X(L + MURO) + 18, Y(W), Y(0), String(cm(W)), T.tinta2, X(L + MURO) + 2);
    // Posición de la bomba desde las dos paredes más cercanas
    const xw = pb[0] < L / 2 ? 0 : L, yw = pb[1] < W / 2 ? 0 : W;
    const dxm = Math.abs(pb[0] - xw), dym = Math.abs(pb[1] - yw);
    if (dxm > 0.08) {
      trazo(c, [[X(xw), Y(pb[1])], [X(pb[0]) - Math.sign(pb[0] - xw) * 14, Y(pb[1])]], T.acento, 0.9, [1, 3]);
      texto(c, String(cm(dxm)), X((xw + pb[0]) / 2), Y(pb[1]) + 10, { tam: 11, mono: true, color: T.acento, alinea: "center" });
    }
    if (dym > 0.08) {
      trazo(c, [[X(pb[0]), Y(yw)], [X(pb[0]), Y(pb[1]) + Math.sign(pb[1] - yw) * 14]], T.acento, 0.9, [1, 3]);
      texto(c, String(cm(dym)), X(pb[0]) + 6, Y((yw + pb[1]) / 2), { tam: 11, mono: true, color: T.acento });
    }
  }
  barraEscala(c, X(-MURO), Y(-MURO) + 30, esc);
}

// ---------- corte ----------

function overlayCorte(v) {
  const c = limpiaOverlay(v);
  const { X, Y, esc } = v;
  const pc = v.pc = planoCorte();
  const { h0, h1 } = pc;
  const zt = cfg.z_tapa, N = cfg.nivel;
  const ray = rayoChorro();
  const avisoRejilla = ray.dist < DIST_REJILLA;
  const P = (x, y) => proy(pc, x, y);

  // Muros, fondo y tapa con la boca
  const [hb] = P(cfg.boca[0], cfg.boca[1]);
  const b0 = clamp(hb - BOCA / 2, h0, h1), b1 = clamp(hb + BOCA / 2, h0, h1);
  c.beginPath();
  c.rect(X(h0 - MURO), Y(0), (h1 - h0 + 2 * MURO) * esc, MURO * esc);
  c.rect(X(h0 - MURO), Y(zt), MURO * esc, zt * esc);
  c.rect(X(h1), Y(zt), MURO * esc, zt * esc);
  c.rect(X(h0 - MURO), Y(zt + LOSA), (b0 - h0 + MURO) * esc, LOSA * esc);
  c.rect(X(b1), Y(zt + LOSA), (h1 + MURO - b1) * esc, LOSA * esc);
  c.fillStyle = patron;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.6;
  trazo(c, [[X(b0), Y(zt)], [X(h0), Y(zt)], [X(h0), Y(0)], [X(h1), Y(0)], [X(h1), Y(zt)], [X(b1), Y(zt)]], T.tinta, 1.6);
  trazo(c, [[X(b0), Y(zt + LOSA)], [X(h0 - MURO), Y(zt + LOSA)], [X(h0 - MURO), Y(-MURO)], [X(h1 + MURO), Y(-MURO)],
    [X(h1 + MURO), Y(zt + LOSA)], [X(b1), Y(zt + LOSA)]], T.tinta, 1);
  trazo(c, [[X(b0), Y(zt)], [X(b0), Y(zt + LOSA)]], T.tinta, 1);
  trazo(c, [[X(b1), Y(zt)], [X(b1), Y(zt + LOSA)]], T.tinta, 1);

  // Nivel del agua
  trazo(c, [[X(h0), Y(N)], [X(h1), Y(N)]], T.agua, 1.6);
  const hn = h0 + 0.82 * (h1 - h0);
  c.beginPath();
  c.moveTo(X(hn) - 6, Y(N) - 10);
  c.lineTo(X(hn) + 6, Y(N) - 10);
  c.lineTo(X(hn), Y(N) - 1);
  c.closePath();
  c.fillStyle = T.agua;
  c.fill();
  for (const [dw, dy] of [[8, 4], [5, 8]]) trazo(c, [[X(hn) - dw, Y(N) + dy], [X(hn) + dw, Y(N) + dy]], T.agua, 1);

  // Bomba de pozo colgando con su rejilla
  const [pp, pd] = P(cfg.pozo[0], cfg.pozo[1]);
  const zr = cfg.pozo[2];
  const lejos = Math.abs(pd) > 0.3;
  c.globalAlpha = lejos ? 0.45 : 1;
  const r = Math.max(4, (POZO_DIAM / 2) * esc);
  const z0 = Math.max(0.03, zr - 0.30), z1 = zr + 0.35;
  trazo(c, [[X(pp), Y(z1)], [X(pp), Y(zt + LOSA + 0.22)]], T.tinta2, Math.max(2.5, 0.033 * esc));
  c.fillStyle = T.tinta2;
  c.fillRect(X(pp) - r, Y(z1), 2 * r, (z1 - z0) * esc);
  c.strokeStyle = T.tinta;
  c.lineWidth = 1;
  c.strokeRect(X(pp) - r, Y(z1), 2 * r, (z1 - z0) * esc);
  c.fillStyle = T.papel;
  for (let i = -2; i <= 2; i++) c.fillRect(X(pp) - r + 2, Y(zr + i * 0.012) - 0.6, 2 * r - 4, 1.2);
  c.globalAlpha = 1;
  marcaSonda(c, X(pp) + r + 8, Y(zr), T.s[1]);

  // Flotador
  const [hl] = P(cfg.llenado[0], cfg.llenado[1]);
  const zv = Math.min(zt - 0.06, N + 0.10);
  const lado = hl - h0 < h1 - hl ? -1 : 1;
  const hw = lado < 0 ? h0 - MURO : h1 + MURO;
  const hlc = clamp(hl, h0 + 0.05, h1 - 0.05);
  trazo(c, [[X(hw), Y(zv)], [X(hlc), Y(zv)]], T.tinta2, Math.max(2, 0.021 * esc));
  const bola = [hlc - lado * 0.16, N];
  trazo(c, [[X(hlc), Y(zv)], [X(bola[0]), Y(bola[1])]], T.tinta2, 1.2);
  c.beginPath();
  c.arc(X(bola[0]), Y(bola[1]), Math.max(4, 0.06 * esc), 0, Math.PI * 2);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.3;
  c.stroke();
  if (cfg.consumo_lpm > 0) trazo(c, [[X(hlc), Y(zv)], [X(hlc), Y(N)]], T.agua, 1.5, [3, 3]);

  // Mástil, travesaño y sondas
  const punta = geo.punto_tubo(cfg.z_orp);
  const [ht] = P(punta[0], punta[1]);
  c.fillStyle = T.tinta2;
  c.fillRect(X(hb) - 3, Y(zt) - 3, 6, 6);
  trazo(c, [[X(hb), Y(zt)], [X(ht), Y(cfg.z_orp)]], T.tinta2, Math.max(2.5, TUBO * esc));
  marcaSonda(c, X(ht), Y(cfg.z_orp), T.s[2]);
  marcaSonda(c, X(hb), Y(N - 0.10), T.s[0]);

  // Dosis
  const [hd] = P(geo.punto_dosis[0], geo.punto_dosis[1]);
  marcaDosis(c, X(clamp(hd, h0, h1)), Y(geo.punto_dosis[2]) - 2);

  // Bomba de mezcla, chorro y cotas de altura
  const pb = geo.pos_bomba, d = geo.dir_chorro;
  const [hp] = P(pb[0], pb[1]);
  const dh = d[0] * pc.h[0] + d[1] * pc.h[1];
  if (cfg.pos_bomba) trazo(c, [[X(hb), Y(zt)], [X(hp), Y(pb[2])]], T.acento, 1.2, [5, 4]);
  const [hf] = P(ray.fin[0], ray.fin[1]);
  const colorRayo = avisoRejilla || ray.donde === "fondo" ? T.peligro : T.acento;
  trazo(c, [[X(hp), Y(pb[2])], [X(hf), Y(ray.fin[2])]], colorRayo, 1.2, [2, 4]);
  tache(c, X(hf), Y(ray.fin[2]), colorRayo);
  const nd = Math.hypot(dh, d[2]) || 1;
  const lf = 0.45;
  const tip = [hp + (dh / nd) * lf, pb[2] + (d[2] / nd) * lf];
  flecha(c, X(hp), Y(pb[2]), X(tip[0]), Y(tip[1]), T.acento, 2.5, 10);
  cuerpoMibee(c, X(hp), Y(pb[2]), -Math.atan2(d[2], dh), esc);
  manija(v, "bomba-z", X(hp), Y(pb[2]), 15);
  if (est.corte === "chorro") {
    c.beginPath();
    c.arc(X(tip[0]), Y(tip[1]), 7, 0, Math.PI * 2);
    c.fillStyle = T.papel;
    c.fill();
    c.strokeStyle = T.acento;
    c.lineWidth = 2;
    c.stroke();
    v.manijas.push({ id: "chorro-el", x: X(tip[0]), y: Y(tip[1]), r: 20 });
  }

  if (est.capas.nombres) {
    const n = (s, x, y, o) => texto(c, s, x, y, { tam: 12, color: T.tinta2, ...o });
    n(lejos ? "bomba de pozo (fuera del corte)" : "bomba de pozo", X(pp) - r - 4, Y(z1) - 10, { alinea: "right" });
    n("flotador", X(bola[0]), Y(N) - 16, { alinea: "center" });
    n("boca", X(hb), Y(zt + LOSA) - 9, { alinea: "center" });
    n("sonda ORP", X(ht) + 10, Y(cfg.z_orp) + 13);
    const izq = dh >= 0;
    n("bomba de mezcla", X(hp) + (izq ? -14 : 14), Y(pb[2]) - 14, { alinea: izq ? "right" : "left", color: T.acento, peso: 600 });
    n(`nivel ${cm(N)}`, X(hn) + 10, Y(N) - 7, { color: T.agua, tam: 11 });
    if (ray.donde === "fondo") n("pega en el fondo", X(hf), Y(0) - 10, { color: colorRayo, tam: 11, alinea: "center" });
  }

  if (est.capas.cotas) {
    const xr = X(h1 + MURO);
    cotaV(c, xr + 14, Y(N), Y(0), String(cm(N)), T.agua, X(h1) + 2);
    cotaV(c, xr + 34, Y(zt), Y(0), String(cm(zt)), T.tinta2, xr + 2);
    cotaV(c, X(pp) - r - 12, Y(zr), Y(0), String(cm(zr)), T.tinta2, X(pp) - r, -1);
    const ladoB = dh >= 0 ? -1 : 1;
    cotaV(c, X(hp) + ladoB * 16, Y(pb[2]), Y(0), String(cm(pb[2])), T.acento, X(hp), ladoB);
    cotaV(c, X(ht) + 14, Y(cfg.z_orp), Y(0), String(cm(cfg.z_orp)), T.s[2], X(ht) + 6);
    const txtLargo = est.corte === "largo" ? String(cm(h1 - h0)) : `${cm(h1 - h0)} por el chorro`;
    cotaH(c, X(h0), X(h1), Y(-MURO) + 18, txtLargo, T.tinta2, Y(-MURO) + 2);
  }
  barraEscala(c, X(h0 - MURO), Y(-MURO) + 30, esc);
  texto(c, "A", X(h0 - MURO) - 12, Y(zt + LOSA + 0.15), { tam: 11, peso: 700, color: T.tinta2, alinea: "center" });
  texto(c, "A", X(h1 + MURO) + 12, Y(zt + LOSA + 0.15), { tam: 11, peso: 700, color: T.tinta2, alinea: "center" });
}

// ---------- fondo: cloro o rapidez ----------

function valorFondo() {
  const cf = sim.cFinal > 0 ? sim.cFinal : 1;
  if (est.fondo === "vel") {
    const a = snap.spd, e = snap.vEsc;
    return (m) => a[m] / e;
  }
  const a = sim.c, e = 2 * cf;
  return (m) => a[m] / e;
}

function ponPixel(data, p, f) {
  const i = Math.max(0, Math.min(255, (f * 255) | 0)) * 3;
  data[p] = LUT[i];
  data[p + 1] = LUT[i + 1];
  data[p + 2] = LUT[i + 2];
  data[p + 3] = 255;
}

function pintaFondoPlanta(v) {
  const { nx, ny, nz, dz } = sim;
  if (v.img.width !== nx || v.img.height !== ny) {
    v.img.width = nx;
    v.img.height = ny;
  }
  const im = v.ictx.createImageData(nx, ny);
  const val = valorFondo();
  const prom = est.planta === "promedio";
  const fk = clamp(est.zPlanta / dz - 0.5, 0, nz - 1);
  const k0 = Math.min(fk | 0, nz - 2), tk = fk - k0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const b = (i * ny + j) * nz;
      let f;
      if (prom) {
        f = 0;
        for (let k = 0; k < nz; k++) f += val(b + k);
        f /= nz;
      } else {
        f = val(b + k0) * (1 - tk) + val(b + k0 + 1) * tk;
      }
      ponPixel(im.data, ((ny - 1 - j) * nx + i) * 4, f);
    }
  }
  v.ictx.putImageData(im, 0, 0);
  v.ext = [0, sim.cfg.largo, 0, sim.cfg.ancho];
}

function pintaFondoCorte(v) {
  const { nx, ny, nz, dx, dy, dz } = sim;
  const pc = planoCorte();
  const val = valorFondo();
  let ncol, muestra;
  if (est.corte === "largo") {
    ncol = nx;
    const fj = clamp(pc.o[1] / dy - 0.5, 0, ny - 1);
    const j0 = Math.min(fj | 0, ny - 2), tj = fj - j0;
    muestra = (col, k) => val((col * ny + j0) * nz + k) * (1 - tj) + val((col * ny + j0 + 1) * nz + k) * tj;
  } else {
    ncol = Math.max(8, Math.round((pc.h1 - pc.h0) / dx));
    muestra = (col, k) => {
      const s = pc.h0 + ((col + 0.5) / ncol) * (pc.h1 - pc.h0);
      const x = pc.o[0] + s * pc.h[0], y = pc.o[1] + s * pc.h[1];
      const fi = clamp(x / dx - 0.5, 0, nx - 1), fj = clamp(y / dy - 0.5, 0, ny - 1);
      const i0 = Math.min(fi | 0, nx - 2), j0 = Math.min(fj | 0, ny - 2), ti = fi - i0, tj = fj - j0;
      const m = (i, j) => val((i * ny + j) * nz + k);
      return (m(i0, j0) * (1 - tj) + m(i0, j0 + 1) * tj) * (1 - ti) + (m(i0 + 1, j0) * (1 - tj) + m(i0 + 1, j0 + 1) * tj) * ti;
    };
  }
  if (v.img.width !== ncol || v.img.height !== nz) {
    v.img.width = ncol;
    v.img.height = nz;
  }
  const im = v.ictx.createImageData(ncol, nz);
  for (let col = 0; col < ncol; col++) {
    for (let k = 0; k < nz; k++) ponPixel(im.data, ((nz - 1 - k) * ncol + col) * 4, muestra(col, k));
  }
  v.ictx.putImageData(im, 0, 0);
  v.ext = est.corte === "largo" ? [0, sim.cfg.largo, 0, sim.cfg.nivel] : [pc.h0, pc.h1, 0, sim.cfg.nivel];
}

// ---------- partículas ----------

function creaParticulas(v) {
  const n = Math.round(clamp((v.w * v.h) / (v.tipo === "planta" ? 160 : 190), 250, 1100));
  const P = {
    n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    edad: new Float32Array(n), vida: new Float32Array(n),
    hx: new Float32Array(n * ESTELA), hy: new Float32Array(n * ESTELA), cuenta: new Uint8Array(n), cab: 0,
  };
  for (let k = 0; k < n; k++) {
    siembra(v, P, k);
    P.edad[k] = Math.random() * P.vida[k];
  }
  return P;
}

function siembra(v, P, k) {
  const { L, W, H } = snap;
  let x, y, z;
  if (v.tipo === "planta") {
    x = 0.02 + Math.random() * (L - 0.04);
    y = 0.02 + Math.random() * (W - 0.04);
    z = est.planta === "promedio" ? Math.random() * H : clamp(est.zPlanta + (Math.random() - 0.5) * 0.24, 0.01, H - 0.01);
  } else {
    const pc = planoCorte();
    for (let intento = 0; intento < 12; intento++) {
      const s = pc.h0 + Math.random() * (pc.h1 - pc.h0);
      const d = (Math.random() * 2 - 1) * FRANJA;
      x = pc.o[0] + s * pc.h[0] + d * pc.n[0];
      y = pc.o[1] + s * pc.h[1] + d * pc.n[1];
      if (x > 0.02 && x < L - 0.02 && y > 0.02 && y < W - 0.02) break;
    }
    x = clamp(x, 0.02, L - 0.02);
    y = clamp(y, 0.02, W - 0.02);
    z = 0.01 + Math.random() * (H - 0.02);
  }
  P.x[k] = x;
  P.y[k] = y;
  P.z[k] = z;
  P.edad[k] = 0;
  P.vida[k] = 2.5 + Math.random() * 4;
  P.cuenta[k] = 0;
}

function mueveParticulas(v, dtp, dtReal) {
  if (!snap.uc) return;
  if (!v.P) v.P = creaParticulas(v);
  const P = v.P;
  const { L, W, H } = snap;
  const hmin = Math.min(snap.dx, snap.dy, snap.dz);
  const nsub = clamp(Math.ceil((dtp * snap.vmax) / (0.5 * hmin)), 1, 6);
  const h = dtp / nsub;
  const pc = v.tipo === "corte" ? planoCorte() : null;
  const capa = v.tipo === "planta" && est.planta !== "promedio";
  P.cab = (P.cab + 1) % ESTELA;
  const vel = [0, 0, 0];
  for (let k = 0; k < P.n; k++) {
    let x = P.x[k], y = P.y[k], z = P.z[k];
    for (let s = 0; s < nsub; s++) {
      velEn(x, y, z, vel);
      const xm = x + 0.5 * h * vel[0], ym = y + 0.5 * h * vel[1], zm = z + 0.5 * h * vel[2];
      velEn(xm, ym, zm, vel);
      x += h * vel[0];
      y += h * vel[1];
      z += h * vel[2];
    }
    P.edad[k] += dtReal;
    let fuera = x < 0.005 || x > L - 0.005 || y < 0.005 || y > W - 0.005 || z < 0.005 || z > H - 0.005 || P.edad[k] > P.vida[k];
    if (!fuera && capa && Math.abs(z - est.zPlanta) > 0.15) fuera = true;
    if (!fuera && pc && Math.abs(proy(pc, x, y)[1]) > FRANJA * 1.2) fuera = true;
    if (fuera) {
      siembra(v, P, k);
      x = P.x[k];
      y = P.y[k];
      z = P.z[k];
    } else {
      P.x[k] = x;
      P.y[k] = y;
      P.z[k] = z;
    }
    const i = k * ESTELA + P.cab;
    if (pc) {
      P.hx[i] = proy(pc, x, y)[0];
      P.hy[i] = z;
    } else {
      P.hx[i] = x;
      P.hy[i] = y;
    }
    P.cuenta[k] = Math.min(ESTELA, P.cuenta[k] + 1);
  }
}

function dibujaParticulas(c, v) {
  const P = v.P;
  if (!P) return;
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  const { X, Y } = v;
  for (let k = 0; k < P.n; k++) {
    const n = P.cuenta[k];
    if (n < 2) continue;
    const base = k * ESTELA;
    for (let a = 0; a < n - 1; a++) {
      const i1 = base + ((P.cab - a + ESTELA) % ESTELA);
      const i0 = base + ((P.cab - a - 1 + ESTELA) % ESTELA);
      const p = paths[Math.min(2, ((a * 3) / (ESTELA - 1)) | 0)];
      p.moveTo(X(P.hx[i1]), Y(P.hy[i1]));
      p.lineTo(X(P.hx[i0]), Y(P.hy[i0]));
    }
  }
  c.lineCap = "round";
  const alfas = [0.95, 0.6, 0.3];
  c.strokeStyle = T.papel;
  c.lineWidth = 3.2;
  for (let b = 0; b < 3; b++) {
    c.globalAlpha = alfas[b] * 0.55;
    c.stroke(paths[b]);
  }
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.3;
  for (let b = 0; b < 3; b++) {
    c.globalAlpha = alfas[b];
    c.stroke(paths[b]);
  }
  c.globalAlpha = 1;
  c.lineCap = "butt";
}

function dibujaFlechas(c, v) {
  if (!snap.uc) return;
  const { L, W, H, nz } = snap;
  const lmax = 0.17, vr = snap.vEsc;
  const p = new Path2D();
  const cabezas = new Path2D();
  const una = (x0, y0, ux, uy) => {
    const s = Math.hypot(ux, uy);
    const l = Math.min(1, s / vr) * lmax;
    if (l < 0.015) return;
    const ax = (ux / s) * l, ay = (uy / s) * l;
    const X0 = v.X(x0 - ax / 2), Y0 = v.Y(y0 - ay / 2), X1 = v.X(x0 + ax / 2), Y1 = v.Y(y0 + ay / 2);
    p.moveTo(X0, Y0);
    p.lineTo(X1, Y1);
    const a = Math.atan2(Y1 - Y0, X1 - X0);
    cabezas.moveTo(X1, Y1);
    cabezas.lineTo(X1 - 5 * Math.cos(a - 0.45), Y1 - 5 * Math.sin(a - 0.45));
    cabezas.lineTo(X1 - 5 * Math.cos(a + 0.45), Y1 - 5 * Math.sin(a + 0.45));
    cabezas.closePath();
  };
  const vel = [0, 0, 0];
  if (v.tipo === "planta") {
    for (let x = 0.1; x < L; x += 0.2) {
      for (let y = 0.1; y < W; y += 0.2) {
        let ux = 0, uy = 0;
        if (est.planta === "promedio") {
          for (let k = 0; k < nz; k++) {
            velEn(x, y, (k + 0.5) * snap.dz, vel);
            ux += vel[0] / nz;
            uy += vel[1] / nz;
          }
        } else {
          velEn(x, y, est.zPlanta, vel);
          ux = vel[0];
          uy = vel[1];
        }
        una(x, y, ux, uy);
      }
    }
  } else {
    const pc = planoCorte();
    for (let s = pc.h0 + 0.1; s < pc.h1; s += 0.2) {
      for (let z = 0.075; z < H; z += 0.15) {
        velEn(pc.o[0] + s * pc.h[0], pc.o[1] + s * pc.h[1], z, vel);
        una(s, z, vel[0] * pc.h[0] + vel[1] * pc.h[1], vel[2]);
      }
    }
  }
  c.strokeStyle = T.papel;
  c.lineWidth = 3;
  c.globalAlpha = 0.6;
  c.stroke(p);
  c.globalAlpha = 1;
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.2;
  c.stroke(p);
  c.fillStyle = T.tinta;
  c.fill(cabezas);
}

// ---------- dibujo por cuadro ----------

function dibujaVista(v) {
  if (!v.visible || !v.w) return;
  if (v.sucio) {
    if (v.tipo === "planta") overlayPlanta(v);
    else overlayCorte(v);
    v.sucio = false;
  }
  const c = v.ctx;
  c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  c.fillStyle = T.papel;
  c.fillRect(0, 0, v.w, v.h);
  if (sim && v.ext) {
    const [a, b, z0, z1] = v.ext;
    const x0 = v.X(a), x1 = v.X(b), y0 = v.Y(z1), y1 = v.Y(z0);
    if (est.fondo === "nada") {
      c.fillStyle = `rgb(${LUT[0]},${LUT[1]},${LUT[2]})`;
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      c.imageSmoothingEnabled = true;
      c.drawImage(v.img, x0, y0, x1 - x0, y1 - y0);
    }
  }
  if (est.capas.flechas) dibujaFlechas(c, v);
  if (est.capas.part) dibujaParticulas(c, v);
  c.drawImage(v.over, 0, 0, v.w, v.h);
}

// ---------- gráfica ----------

const graf = { canvas: $("c-grafica"), w: 0, h: 0, dpr: 1, m: { l: 44, r: 12, t: 14, b: 26 }, xMax: 30, yMax: 1.5 };
graf.ctx = graf.canvas.getContext("2d");

function dimensionaGrafica() {
  const w = graf.canvas.parentElement.clientWidth;
  const h = window.innerWidth < 760 ? 170 : 190;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  graf.w = w;
  graf.h = h;
  graf.dpr = dpr;
  graf.canvas.style.height = h + "px";
  graf.canvas.width = Math.round(w * dpr);
  graf.canvas.height = Math.round(h * dpr);
  graficaSucia = true;
}

function pasoBonito(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function dibujaGrafica() {
  const c = graf.ctx, { w, h, m } = graf;
  if (!w) return;
  c.setTransform(graf.dpr, 0, 0, graf.dpr, 0, 0);
  c.fillStyle = T.papel;
  c.fillRect(0, 0, w, h);
  if (!serie || !serie.t.length) return;
  const n = serie.t.length;
  const cfMax = Math.max(...serie.meta, 0.01);
  const yMax = 2 * cfMax;
  const tFin = serie.t[n - 1];
  const xp = tFin > 120 ? 30 : tFin > 50 ? 15 : tFin > 25 ? 10 : 5;
  const xMax = Math.max(30, Math.ceil((tFin * 1.05) / xp) * xp);
  graf.xMax = xMax;
  graf.yMax = yMax;
  const X = (t) => m.l + (t / xMax) * (w - m.l - m.r);
  const Y = (y) => m.t + (1 - Math.min(y, yMax) / yMax) * (h - m.t - m.b);
  graf.X = X;

  c.font = fuente(11, 400, true);
  const yp = pasoBonito(yMax / 4);
  for (let y = 0; y <= yMax + 1e-9; y += yp) {
    trazo(c, [[m.l, Y(y)], [w - m.r, Y(y)]], T.linea, 1);
    texto(c, y.toFixed(yp < 0.1 ? 2 : 1), m.l - 6, Y(y), { tam: 11, mono: true, alinea: "right", color: T.tinta2, halo: false });
  }
  for (let t = 0; t <= xMax; t += xp) {
    texto(c, String(t), X(t), h - m.b + 12, { tam: 11, mono: true, alinea: "center", color: T.tinta2, halo: false });
  }
  texto(c, "min", w - m.r, h - 6, { tam: 11, alinea: "right", color: T.tinta3, halo: false });
  texto(c, "mg/L", 4, 7, { tam: 11, color: T.tinta3, halo: false });

  // banda del rango de toda la cisterna
  c.beginPath();
  for (let i = 0; i < n; i++) c.lineTo(X(serie.t[i]), Y(serie.hi[i]));
  for (let i = n - 1; i >= 0; i--) c.lineTo(X(serie.t[i]), Y(serie.lo[i]));
  c.closePath();
  c.fillStyle = T.linea;
  c.globalAlpha = 0.85;
  c.fill();
  c.globalAlpha = 1;

  // meta, dosis, apagado y fórmula
  const meta = [];
  for (let i = 0; i < n; i++) meta.push([X(serie.t[i]), Y(serie.meta[i])]);
  if (meta.length > 1) trazo(c, meta, T.tinta2, 1.2, [5, 4]);
  const tf = corrida?.formula;
  if (tf && dosisT.length) {
    const xf = X(dosisT[0] / 60 + tf);
    if (tf + dosisT[0] / 60 <= xMax) {
      trazo(c, [[xf, m.t], [xf, h - m.b]], T.tinta3, 1, [1, 3]);
      texto(c, "fórmula", xf + 3, m.t + 4, { tam: 11, color: T.tinta2 });
    }
  }
  if (est.modo === "firmware" && apagaEn / 60 <= xMax) {
    const xa = X(apagaEn / 60);
    trazo(c, [[xa, m.t], [xa, h - m.b]], T.tinta3, 1, [4, 3]);
    texto(c, "bomba se apaga", xa - 3, m.t + 4, { tam: 11, color: T.tinta2, alinea: "right" });
  }
  for (const td of dosisT) {
    const xd = X(td / 60);
    c.beginPath();
    c.moveTo(xd - 5, m.t - 6);
    c.lineTo(xd + 5, m.t - 6);
    c.lineTo(xd, m.t + 2);
    c.closePath();
    c.fillStyle = T.tinta;
    c.fill();
  }

  c.save();
  c.beginPath();
  c.rect(m.l, m.t - 1, w - m.l - m.r, h - m.t - m.b + 2);
  c.clip();
  for (let s = 0; s < 3; s++) {
    if (!serie.s[s].length) continue;
    const pts = serie.s[s].map((y, i) => [X(serie.t[i]), Y(y)]);
    if (pts.length === 1) pts.push([pts[0][0] + 1, pts[0][1]]);
    trazo(c, pts, T.s[s], 2);
  }
  c.restore();
  trazo(c, [[m.l, h - m.b], [w - m.r, h - m.b]], T.tinta3, 1);

  if (graf.hover != null && graf.hover < n) {
    const i = graf.hover;
    const xh = X(serie.t[i]);
    trazo(c, [[xh, m.t], [xh, h - m.b]], T.tinta2, 1);
    for (let s = 0; s < 3; s++) {
      if (serie.s[s][i] == null) continue;
      c.beginPath();
      c.arc(xh, Y(serie.s[s][i]), 4, 0, Math.PI * 2);
      c.fillStyle = T.s[s];
      c.fill();
      c.strokeStyle = T.papel;
      c.lineWidth = 2;
      c.stroke();
    }
  }
}

function hoverGrafica(e) {
  if (!serie || !serie.t.length || !graf.X) return;
  const r = graf.canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const t = ((x - graf.m.l) / (graf.w - graf.m.l - graf.m.r)) * graf.xMax;
  let i = 0, best = Infinity;
  for (let k = 0; k < serie.t.length; k++) {
    const d = Math.abs(serie.t[k] - t);
    if (d < best) {
      best = d;
      i = k;
    }
  }
  graf.hover = i;
  const tip = $("tip");
  const nombres = ["Superficie", "Llave", "Sonda ORP"];
  const filas = [0, 1, 2].filter((s) => serie.s[s][i] != null)
    .map((s) => `<div><span style="color:${T.s[s]}">■</span> ${nombres[s]} <span class="num">${serie.s[s][i].toFixed(2)}</span></div>`);
  tip.innerHTML = `<div class="num">${serie.t[i].toFixed(1)} min</div>${filas.join("")}`
    + `<div>Rango <span class="num">${serie.lo[i].toFixed(2)} a ${serie.hi[i].toFixed(2)}</span></div>`;
  tip.hidden = false;
  const xh = graf.X(serie.t[i]);
  const tw = tip.offsetWidth;
  tip.style.left = (xh + 12 + tw > graf.w ? xh - 12 - tw : xh + 12) + "px";
  tip.style.top = "8px";
  graficaSucia = true;
}

// ---------- lecturas, avisos y corridas ----------

function fmtMin(x) {
  return x == null ? "-" : `${x.toFixed(1)} <small>min</small>`;
}

function pintaLecturas() {
  if (!sim) return;
  const tm = (sim.t - tDosis) / 60;
  $("l-tiempo").innerHTML = fmtMin(tm);
  const st = ultimo.stats, so = ultimo.sondas, cf = sim.cFinal;
  if (st) {
    const ok = st.cov < 0.05;
    $("l-cov").innerHTML = `${st.cov.toFixed(2)}<span class="chip ${ok ? "ok" : "no"}">${ok ? "mezclada" : "falta"}</span>`;
    $("l-rango").innerHTML = `${Math.round(st.cmin * 100)} a ${Math.round(st.cmax * 100)} <small>% meta</small>`;
  }
  $("l-meta").innerHTML = `${cf.toFixed(2)} <small>mg/L</small>`;
  if (so) {
    Object.keys(so).slice(0, 3).forEach((n, k) => {
      $(`l-s${k}`).innerHTML = `${so[n].toFixed(2)} <small>mg/L</small>`;
    });
  }
  let estado;
  if (est.modo === "siempre") estado = "siempre encendida";
  else if (est.modo === "apagada") estado = "apagada";
  else estado = bombaEncendida() ? `encendida <small>se apaga en ${Math.max(0, (apagaEn - sim.t) / 60).toFixed(0)} min</small>` : "apagada <small>pasaron 45 min</small>";
  $("l-estado").innerHTML = estado;
  let op = null;
  try {
    op = puntoOperacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida);
  } catch {}
  if (op) {
    $("l-q").innerHTML = `${Math.round(op.q_lh)} <small>L/h</small>`;
    $("l-u").innerHTML = `${op.u_ms.toFixed(2)} <small>m/s</small>`;
    $("l-m").innerHTML = `${(op.m_m4s2 * 1e4).toFixed(1)}<small>×10⁻⁴ m⁴/s²</small>`;
    $("l-formula").innerHTML = fmtMin(tiempoMezclaS(volumen(), op.m_m4s2) / 60);
  }
  $("l-sim5").innerHTML = deteccion.cov5 != null ? fmtMin(deteccion.cov5) : `<small>aún no</small>`;
  $("l-sim10").innerHTML = deteccion.todo10 != null ? fmtMin(deteccion.todo10) : `<small>aún no</small>`;
  const pb = geo.pos_bomba;
  if (cfg.pos_bomba) {
    const hdist = Math.hypot(pb[0] - cfg.boca[0], pb[1] - cfg.boca[1]);
    const dz = cfg.z_tapa - pb[2];
    $("l-montaje").innerHTML = `tubo de ${Math.hypot(hdist, dz).toFixed(2)} m a ${Math.round(Math.atan2(dz, hdist) / RAD)}° <small>desde el travesaño</small>`;
  } else {
    const ltubo = (cfg.z_tapa - pb[2]) / Math.sin(cfg.angulo_tubo * RAD);
    $("l-montaje").innerHTML = `mástil a ${cfg.angulo_tubo}°, bomba a ${ltubo.toFixed(2)} m <small>del travesaño por el tubo</small>`;
  }
  $("reloj-t").textContent = `${(sim.t / 60).toFixed(1)} min`;
  $("reloj-v").textContent = !est.corriendo ? "en pausa" : timerReinicio ? "aplicando el cambio" : `simula a ${vSim < 10 ? vSim.toFixed(1) : Math.round(vSim)}x`;
  const cfLey = cf > 0 ? cf : 0.75;
  if (est.fondo === "vel") {
    $("leyenda-nombre").textContent = "Rapidez";
    $("ley-0").textContent = "0";
    $("ley-1").textContent = (snap.vEsc * 50).toFixed(1);
    $("ley-2").textContent = `${(snap.vEsc * 100).toFixed(1)} cm/s`;
  } else {
    $("leyenda-nombre").textContent = "Cloro";
    $("ley-0").textContent = "0";
    $("ley-1").textContent = `${cfLey.toFixed(2)} meta`;
    $("ley-2").textContent = `${(2 * cfLey).toFixed(2)} mg/L`;
  }
}

function pintaAvisos() {
  const caja = $("avisos");
  const out = [];
  if (!motorReal) {
    out.push(`<p class="aviso"><b>Motor de prueba.</b> No encontré solver.js: el flujo que ves es falso y no sirve para decidir. La geometría y la fórmula sí son las reales.</p>`);
  }
  if (errorCfg) out.push(`<p class="aviso peligro"><b>No se aplicó el cambio.</b> ${errorCfg}. Sigue corriendo la configuración anterior.</p>`);
  const ray = rayoChorro();
  if (ray.dist < DIST_REJILLA) {
    out.push(`<p class="aviso"><b>El chorro pasa a ${cm(ray.dist)} cm de la rejilla de la bomba de pozo.</b> Mantenlo a más de ${cm(DIST_REJILLA)} cm: el cloro sin mezclar se iría directo a la casa.</p>`);
  }
  if (ray.donde === "fondo") {
    out.push(`<p class="aviso"><b>El chorro pega en el fondo</b> a ${cm(ray.t)} cm de la boquilla, a unos ${ray.uFin.toFixed(2)} m/s (estimado como chorro redondo libre): puede levantar lodo. Inclínalo menos o sube la bomba.</p>`);
  }
  caja.innerHTML = out.join("");
}

function pintaCorridas() {
  const cuerpo = $("corridas");
  const celda = (r, x) => x != null ? `${x.toFixed(1)} min` : r.activa ? "corriendo" : `&gt; ${r.tMax.toFixed(0)} min`;
  cuerpo.innerHTML = corridas.map((r) => `<tr class="${r === corrida ? "actual" : ""}">
    <td class="num">${r.n}</td><td>${r.bomba}</td><td>${r.chorro}</td><td>${r.dosis}</td>
    <td class="num">${r.formula != null ? r.formula.toFixed(1) + " min" : "-"}</td>
    <td class="num">${celda(r, r.cov5)}</td><td class="num">${celda(r, r.todo10)}</td></tr>`).join("");
}

// ---------- controles ----------

function efectivos() {
  const d = geo.dir_chorro;
  return {
    altura: geo.pos_bomba[2],
    az: Math.round(Math.atan2(d[1], d[0]) / RAD),
    el: Math.round(Math.asin(clamp(d[2], -1, 1)) / RAD),
  };
}

function ponAltura(z) {
  if (cfg.pos_bomba) cfg.pos_bomba = [cfg.pos_bomba[0], cfg.pos_bomba[1], z];
  else cfg.z_bomba = z;
}

const rangos = {
  altura: { get: () => cm(efectivos().altura), set: (v) => ponAltura(v / 100), fmt: (v) => `${v} cm`, reinicia: true },
  angulo: { get: () => cfg.angulo_tubo, set: (v) => (cfg.angulo_tubo = v), fmt: (v) => `${v}°`, reinicia: true },
  azimut: { get: () => efectivos().az, set: (v) => (cfg.azimut = v), fmt: (v) => `${v}°`, reinicia: true },
  elevacion: { get: () => efectivos().el, set: (v) => (cfg.elevacion = v), fmt: (v) => `${v}°`, reinicia: true },
  caudal: { get: () => cfg.q_max_lh, set: (v) => (cfg.q_max_lh = v), fmt: (v) => `${v} L/h`, reinicia: true },
  boquilla: { get: () => cfg.boquilla_mm, set: (v) => (cfg.boquilla_mm = v), fmt: (v) => `${v} mm`, reinicia: true },
  nivel: { get: () => cm(cfg.nivel), set: (v) => (cfg.nivel = v / 100), fmt: (v) => `${v} cm`, reinicia: true },
  consumo: { get: () => cfg.consumo_lpm, set: (v) => (cfg.consumo_lpm = v), fmt: (v) => `${v} L/min`, reinicia: false, luego: () => cambiaConsumo() },
  dosis: { get: () => cfg.dosis_ml, set: (v) => (cfg.dosis_ml = v), fmt: (v) => `${v} mL`, reinicia: false },
};

function syncControles() {
  for (const [id, r] of Object.entries(rangos)) {
    const v = r.get();
    $(id).value = v;
    $(`o-${id}`).textContent = r.fmt(v);
  }
  $("altura").max = Math.max(20, cm(cfg.nivel) - 10);
  $("estado-montaje").textContent = cfg.pos_bomba ? "libre" : "en el mástil";
  $("montar").disabled = !cfg.pos_bomba;
  $("seguir").disabled = cfg.azimut == null && cfg.elevacion == null;
  $("largo").value = cm(cfg.largo);
  $("ancho").value = cm(cfg.ancho);
  $("ztapa").value = cm(cfg.z_tapa);
  $("zrejilla").value = cm(cfg.pozo[2]);
  $("z-planta").max = Math.max(10, cm(cfg.nivel) - 5);
  $("d-volumen").textContent = `${volumen().toFixed(1)} m³`;
}

function valida() {
  try {
    validar(copia(cfg));
    return null;
  } catch (e) {
    return e.message;
  }
}

function cambioCfg({ reinicia = true } = {}) {
  geo = geometria(copia(cfg));
  for (const v of Object.values(vistas)) v.sucio = true;
  syncControles();
  errorCfg = valida();
  pintaAvisos();
  pintaLecturas();
  if (reinicia && !errorCfg) programaReinicio();
}

function programaReinicio() {
  clearTimeout(timerReinicio);
  timerReinicio = 0;
  if (arrastre) return;
  timerReinicio = setTimeout(() => {
    timerReinicio = 0;
    arranca();
    redimensiona();
  }, 450);
}

for (const [id, r] of Object.entries(rangos)) {
  $(id).addEventListener("input", (e) => {
    r.set(Number(e.target.value));
    $(`o-${id}`).textContent = r.fmt(Number(e.target.value));
    cambioCfg({ reinicia: r.reinicia });
    if (id === "nivel") redimensiona();
  });
  if (r.luego) $(id).addEventListener("change", r.luego);
}

for (const [id, clave, idx] of [["largo", "largo"], ["ancho", "ancho"], ["ztapa", "z_tapa"], ["zrejilla", "pozo", 2]]) {
  $(id).addEventListener("change", (e) => {
    const v = Number(e.target.value) / 100;
    if (!(v > 0)) return syncControles();
    if (idx != null) cfg[clave] = cfg[clave].map((q, i) => (i === idx ? v : q));
    else cfg[clave] = v;
    cambioCfg();
    redimensiona();
  });
}

$("medidas-doc").addEventListener("click", () => {
  for (const k of ["largo", "ancho", "z_tapa", "boca", "pozo", "llenado"]) cfg[k] = copia(DEFAULTS[k]);
  cambioCfg();
  redimensiona();
});

$("montar").addEventListener("click", () => {
  if (cfg.pos_bomba) cfg.z_bomba = cfg.pos_bomba[2];
  cfg.pos_bomba = null;
  cambioCfg();
});
$("seguir").addEventListener("click", () => {
  cfg.azimut = null;
  cfg.elevacion = null;
  cambioCfg();
});

$("play").addEventListener("click", () => {
  est.corriendo = !est.corriendo;
  $("play").textContent = est.corriendo ? "Pausa" : "Seguir";
  $("play").setAttribute("aria-pressed", String(est.corriendo));
  deuda = 0;
  pintaLecturas();
});
$("reiniciar").addEventListener("click", () => {
  clearTimeout(timerReinicio);
  timerReinicio = 0;
  arranca();
});
$("echar").addEventListener("click", () => {
  echaCloro();
  pintaLecturas();
});
$("velocidad").addEventListener("change", (e) => {
  est.velocidad = Number(e.target.value);
  deuda = 0;
});
$("modo-bomba").addEventListener("change", (e) => {
  est.modo = e.target.value;
  if (est.modo === "firmware") apagaEn = tDosis + APAGA_S;
  graficaSucia = true;
});
$("malla").addEventListener("change", (e) => {
  cfg.dx = Number(e.target.value);
  cambioCfg();
});

function radios(nombre, fn) {
  for (const el of document.querySelectorAll(`input[name="${nombre}"]`)) {
    el.addEventListener("change", () => el.checked && fn(el.value));
  }
}

radios("planta", (v) => {
  est.planta = v;
  $("zplanta-caja").hidden = v !== "z";
  vistas.planta.P = null;
  fondoSucio = true;
  pintaSubtitulos();
});
radios("corte", (v) => {
  est.corte = v;
  vistas.corte.P = null;
  dimensiona(vistas.corte);
  fondoSucio = true;
  pintaSubtitulos();
});
radios("fondo", (v) => {
  est.fondo = v;
  fondoSucio = true;
  pintaLecturas();
});
radios("lugar", (v) => {
  est.lugar = v;
  if (v !== "clic") cfg.lugar_dosis = v;
  cambioCfg({ reinicia: false });
  pintaSubtitulos();
});

$("z-planta").addEventListener("input", (e) => {
  est.zPlanta = Number(e.target.value) / 100;
  $("o-z-planta").textContent = `${e.target.value} cm`;
  fondoSucio = true;
  pintaSubtitulos();
});

for (const [id, clave] of [["capa-part", "part"], ["capa-flechas", "flechas"], ["capa-cotas", "cotas"], ["capa-nombres", "nombres"]]) {
  $(id).checked = est.capas[clave];
  $(id).addEventListener("change", (e) => {
    est.capas[clave] = e.target.checked;
    for (const v of Object.values(vistas)) v.sucio = true;
  });
}

$("editar").addEventListener("change", (e) => {
  est.editar = e.target.checked;
  $("editar-caja").hidden = !est.editar;
  vistas.planta.sucio = true;
  pintaSubtitulos();
});

function pintaSubtitulos() {
  $("t-planta-sub").textContent = est.planta === "promedio" ? "promedio de toda la columna" : `a ${Math.round(est.zPlanta * 100)} cm del fondo`;
  const p = geo.pos_bomba;
  $("t-corte-sub").textContent = est.corte === "largo" ? `A-A a lo largo, y = ${cm(p[1])} cm` : "A-A por el plano del chorro";
  $("pie-corte").textContent = (est.corte === "largo"
    ? "Corte a lo largo por la bomba de mezcla."
    : "Corte por el plano del chorro: arrastra la punta de la flecha para inclinarlo.")
    + " Arrastra la bomba para subirla o bajarla. Partículas a ±25 cm del corte.";
  let pie;
  if (est.editar) pie = "Editando: arrastra los cuadros de la boca, la bomba de pozo y el flotador.";
  else if (est.lugar === "clic") pie = Array.isArray(cfg.lugar_dosis) ? "Toca la planta para mover el punto de la dosis." : "Toca la planta donde vas a echar el cloro.";
  else pie = "Arrastra la bomba de mezcla para moverla y la punta de su flecha para girar el chorro.";
  $("pie-planta").textContent = pie;
}

// ---------- arrastre en las vistas ----------

function local(v, e) {
  const r = v.canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function manijaEn(v, x, y) {
  let mejor = null, dm = Infinity;
  for (const m of v.manijas) {
    const d = Math.hypot(x - m.x, y - m.y);
    if (d < m.r && d < dm) {
      mejor = m;
      dm = d;
    }
  }
  return mejor;
}

function aplicaArrastre(v, m, px, py) {
  const [a, b] = v.inv(px, py);
  const L = cfg.largo, W = cfg.ancho;
  const xy = () => [r2(clamp(a, 0.05, L - 0.05)), r2(clamp(b, 0.05, W - 0.05))];
  switch (m.id) {
    case "bomba": {
      const z = geo.pos_bomba[2];
      cfg.pos_bomba = [...xy(), z];
      break;
    }
    case "chorro": {
      const p = geo.pos_bomba;
      cfg.azimut = Math.round(Math.atan2(b - p[1], a - p[0]) / RAD);
      break;
    }
    case "boca":
      cfg.boca = [r2(clamp(a, 0.3, L - 0.3)), r2(clamp(b, 0.3, W - 0.3))];
      break;
    case "pozo":
      cfg.pozo = [...xy(), cfg.pozo[2]];
      break;
    case "llenado":
      cfg.llenado = [...xy(), cfg.llenado[2]];
      break;
    case "bomba-z":
      ponAltura(r2(clamp(b, 0.05, cfg.nivel - 0.10)));
      break;
    case "chorro-el": {
      const pc = vistas.corte.pc;
      const p = geo.pos_bomba;
      const [hp] = proy(pc, p[0], p[1]);
      cfg.elevacion = Math.round(Math.atan2(b - p[2], Math.max(a - hp, 0.001)) / RAD);
      break;
    }
  }
  cambioCfg();
}

function enlazaVista(v) {
  const cv = v.canvas;
  let toque = null;
  cv.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const r = cv.getBoundingClientRect();
    if (manijaEn(v, t.clientX - r.left, t.clientY - r.top)) e.preventDefault();
  }, { passive: false });
  cv.addEventListener("pointerdown", (e) => {
    const [x, y] = local(v, e);
    const m = manijaEn(v, x, y);
    if (m) {
      arrastre = { v, m, id: e.pointerId };
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = "grabbing";
      e.preventDefault();
    } else {
      toque = { x, y, id: e.pointerId };
    }
  });
  cv.addEventListener("pointermove", (e) => {
    const [x, y] = local(v, e);
    if (arrastre && arrastre.v === v && arrastre.id === e.pointerId) {
      aplicaArrastre(v, arrastre.m, x, y);
      return;
    }
    if (e.pointerType === "mouse") {
      cv.style.cursor = manijaEn(v, x, y) ? "grab" : v.tipo === "planta" && est.lugar === "clic" ? "crosshair" : "default";
    }
  });
  const suelta = (e) => {
    if (arrastre && arrastre.id === e.pointerId) {
      arrastre = null;
      cv.style.cursor = "";
      cambioCfg();
      return;
    }
    if (toque && toque.id === e.pointerId && e.type === "pointerup" && v.tipo === "planta" && est.lugar === "clic") {
      const [x, y] = local(v, e);
      if (Math.hypot(x - toque.x, y - toque.y) < 8) {
        const [a, b] = v.inv(x, y);
        if (a > 0.02 && a < cfg.largo - 0.02 && b > 0.02 && b < cfg.ancho - 0.02) {
          cfg.lugar_dosis = [r2(a), r2(b), r2(cfg.nivel - 0.10)];
          cambioCfg({ reinicia: false });
          pintaSubtitulos();
        }
      }
    }
    toque = null;
  };
  cv.addEventListener("pointerup", suelta);
  cv.addEventListener("pointercancel", suelta);
}

// ---------- tamaños, tema y ciclo ----------

function redimensiona() {
  for (const v of Object.values(vistas)) dimensiona(v);
  dimensionaGrafica();
  fondoSucio = true;
}

const ro = new ResizeObserver(() => redimensiona());
for (const v of Object.values(vistas)) ro.observe(v.canvas.parentElement);
ro.observe(graf.canvas.parentElement);

const io = new IntersectionObserver((entradas) => {
  for (const en of entradas) {
    for (const v of Object.values(vistas)) if (v.canvas === en.target) v.visible = en.isIntersecting;
  }
});
for (const v of Object.values(vistas)) io.observe(v.canvas);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  leeTokens();
  graficaSucia = true;
});
new MutationObserver(() => {
  leeTokens();
  graficaSucia = true;
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
document.fonts?.ready.then(() => {
  for (const v of Object.values(vistas)) v.sucio = true;
  graficaSucia = true;
});

graf.canvas.addEventListener("pointermove", hoverGrafica);
graf.canvas.addEventListener("pointerdown", hoverGrafica);
graf.canvas.addEventListener("pointerleave", () => {
  graf.hover = null;
  $("tip").hidden = true;
  graficaSucia = true;
});

let tAnterior = performance.now();
let tFondo = 0, tLecturas = 0, tSnap = 0, tCorridas = 0;

function cuadro(ahora) {
  const dtReal = Math.min(0.1, Math.max(0, (ahora - tAnterior) / 1000));
  tAnterior = ahora;
  let avanzado = 0;
  if (est.corriendo && sim) avanzado = avanzaSim(dtReal);
  if (dtReal > 0 && est.corriendo) vSim = 0.92 * vSim + 0.08 * (avanzado / dtReal);
  if (sim && avanzado > 0 && ahora - tSnap > 40) {
    tomaSnapshot();
    tSnap = ahora;
  }
  if (sim && ((avanzado > 0 && ahora - tFondo > 120) || fondoSucio)) {
    pintaFondoPlanta(vistas.planta);
    pintaFondoCorte(vistas.corte);
    tFondo = ahora;
    fondoSucio = false;
  }
  const dtp = est.corriendo ? Math.min(DT_PART_MAX, vSim * dtReal) : 0;
  if (sim && est.capas.part && dtp > 0) {
    for (const v of Object.values(vistas)) if (v.visible) mueveParticulas(v, dtp, dtReal);
  }
  for (const v of Object.values(vistas)) dibujaVista(v);
  if (graficaSucia) {
    dibujaGrafica();
    graficaSucia = false;
  }
  if (ahora - tLecturas > 200) {
    pintaLecturas();
    tLecturas = ahora;
  }
  if (ahora - tCorridas > 1000) {
    pintaCorridas();
    tCorridas = ahora;
  }
  requestAnimationFrame(cuadro);
}

$("d-motor").innerHTML = motorReal ? "CFD 3D, port de cisterna_sim" : `<span class="motor-prueba">de prueba (flujo falso)</span>`;
leeTokens();
for (const v of Object.values(vistas)) enlazaVista(v);
redimensiona();
syncControles();
pintaSubtitulos();
arranca();
redimensiona();
pintaLecturas();
requestAnimationFrame(cuadro);

window.visor = { get sim() { return sim; }, cfg, est, get vSim() { return vSim; }, get costoPaso() { return costoPaso; } };
