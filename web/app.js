// Visor en vivo de la cisterna: planta y corte a escala con el flujo de la bomba de mezcla.
// El motor (solver.js) corre en worker.js y manda instantáneas; aquí solo se dibuja (SPEC.md, Visor).

import { DEFAULTS, validar, geometria, puntoOperacion, tiempoMezclaS } from "./solver.js";

const RAD = Math.PI / 180;
const MURO = 0.15; // solo dibujo (supuesto)
const LOSA = 0.10; // solo dibujo (supuesto)
const BOCA = 0.60; // boca de la tapa de 60 x 60 cm, solo dibujo (supuesto)
const POZO_DIAM = 0.10; // bomba de pozo de 4", solo dibujo (supuesto)
const MIBEE = { largo: 0.061, diam: 0.046 };
const TUBO = 0.0267; // PVC 3/4, diámetro exterior
const DIST_REJILLA = 0.5;
const FRANJA = 0.25;
const APAGA_S = 45 * 60;
const ESTELA = 12;
const DT_PART_MAX = 0.2;
const JUNTOS_M = 0.12;

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

let sim = null; // última instantánea del motor: t, cFinal, malla y cloro
let idSim = 0;
let tDosis = 0;
let apagaEn = APAGA_S;
let serie = null;
let dosisT = [];
let deteccion = { cov5: null, todo10: null };
let ultimo = { stats: null, sondas: null };
let corridas = [];
let corrida = null;
let errorCfg = null;
let errorMotor = null;
let timerReinicio = 0;
let arrastre = null;
let nSnap = 0;

const perf = { fps: 0, cuadroMs: 0, particulasMs: 0, fondoMs: 0, vistasMs: 0, motorPasoMs: 0, vSim: 0, motor: "" };
const media = (k, x) => (perf[k] = perf[k] ? 0.9 * perf[k] + 0.1 * x : x);

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
  T.tintaRgb = hexRgb(g("--particula"));
  T.haloRgb = hexRgb(g("--particula-halo"));
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
  graficaSucia = true;
}

const fuente = (tam, peso = 500, mono = false) => `${peso} ${tam}px ${mono ? T.num : T.ui}`;

// ---------- motor en el worker ----------

let motor = null;

function transferibles(s) {
  return s ? [s.c.buffer, s.uc.buffer, s.vc.buffer, s.wc.buffer, s.spd.buffer] : [];
}

function iniciaMotor() {
  let w;
  try {
    w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  } catch (e) {
    return motorDeRespaldo();
  }
  let vivo = false;
  const plazo = setTimeout(() => {
    if (!vivo) {
      w.terminate();
      motorDeRespaldo();
    }
  }, 10000);
  w.onmessage = (e) => {
    if (e.data.tipo === "listo") {
      vivo = true;
      clearTimeout(plazo);
      return;
    }
    recibeMotor(e.data);
  };
  w.onerror = (e) => {
    e.preventDefault();
    if (vivo) {
      errorMotor = e.message || "el motor se detuvo";
      pintaAvisos();
      return;
    }
    clearTimeout(plazo);
    w.terminate();
    motorDeRespaldo();
  };
  motor = { manda: (m, t) => w.postMessage(m, t || []) };
  perf.motor = "worker";
}

// Sin Web Workers de módulo: el mismo motor corre aquí con un presupuesto chico por tarea.
async function motorDeRespaldo() {
  const { creaMotor } = await import("./worker.js");
  const recibe = creaMotor((d) => recibeMotor(d), { presupuestoMs: 6, enHiloPrincipal: true });
  motor = { manda: (m) => recibe(m) };
  perf.motor = "hilo principal";
  pintaMotor();
  arranca();
}

function recibeMotor(m) {
  if (m.tipo === "error") {
    if (m.id === idSim) {
      errorCfg = m.mensaje;
      pintaAvisos();
    }
    return;
  }
  if (m.tipo !== "snap") return;
  if (m.id !== idSim) {
    motor.manda({ tipo: "devuelve", set: m.set }, transferibles(m.set));
    return;
  }
  const otraMalla = !sim || sim.id !== m.id || sim.nx !== m.nx || sim.ny !== m.ny || sim.nz !== m.nz;
  const viejo = snap.set;
  sim = {
    id: m.id, t: m.t, cFinal: m.cFinal, encendida: m.encendida, nx: m.nx, ny: m.ny, nz: m.nz,
    dx: m.dx, dy: m.dy, dz: m.dz, volCelda: m.volCelda, L: m.L, W: m.W, H: m.H, c: m.set.c,
  };
  Object.assign(snap, {
    set: m.set, uc: m.set.uc, vc: m.set.vc, wc: m.set.wc, spd: m.set.spd, vmax: m.vmax, vEsc: m.vEsc,
    nx: m.nx, ny: m.ny, nz: m.nz, dx: m.dx, dy: m.dy, dz: m.dz, L: m.L, W: m.W, H: m.H,
  });
  perf.vSim = m.vSim;
  perf.motorPasoMs = m.costoPaso;
  for (const ev of m.eventos) {
    if (ev.tipo === "dosis") alDosificar(ev.t);
    else registra(ev);
  }
  // Siempre se contesta: el motor no manda otra instantánea hasta saber que llegó esta.
  motor.manda({ tipo: "devuelve", set: viejo }, transferibles(viejo));
  if (otraMalla) {
    for (const v of Object.values(vistas)) v.P = null;
    fondoSucio = true;
    $("cargando").hidden = true;
  }
  nSnap++;
}

function mandaControl() {
  motor?.manda({ tipo: "control", corriendo: est.corriendo && !document.hidden, velocidad: est.velocidad, modo: est.modo });
}

// ---------- corrida ----------

function volumen(c = cfg) {
  return c.largo * c.ancho * c.nivel;
}

function dosisActual() {
  const g = geometria(copia(cfg));
  return { masa: cfg.dosis_ml * cfg.cloralex_mg_ml, punto: g.punto_dosis };
}

function arranca() {
  const e = valida();
  if (e) {
    errorCfg = e;
    pintaAvisos();
    return false;
  }
  errorCfg = null;
  if (!motor) return false;
  idSim++;
  if (corrida) corrida.activa = false;
  dosisT = [];
  deteccion = { cov5: null, todo10: null };
  ultimo = { stats: null, sondas: null };
  serie = { t: [], s: [[], [], []], lo: [], hi: [], meta: [], nombres: [] };
  corrida = { n: (corridas[0]?.n ?? 0) + 1, ...resumenCfg(), cov5: null, todo10: null, tMax: 0, activa: true };
  corridas.unshift(corrida);
  if (corridas.length > 12) corridas.pop();
  mandaControl();
  motor.manda({ tipo: "arranca", id: idSim, cfg: copia(cfg), dosis: dosisActual() });
  for (const v of Object.values(vistas)) v.sucio = true;
  pintaAvisos();
  pintaCorridas();
  graficaSucia = true;
  return true;
}

function echaCloro() {
  if (!sim || !motor) return;
  motor.manda({ tipo: "dosis", ...dosisActual() });
}

function alDosificar(t) {
  tDosis = t;
  dosisT.push(t);
  apagaEn = t + APAGA_S;
  deteccion = { cov5: null, todo10: null };
}

function registra(m) {
  const st = m.stats, so = m.sondas, cf = m.cFinal;
  ultimo = { stats: st, sondas: so };
  const nombres = Object.keys(so);
  serie.nombres = nombres;
  serie.t.push(m.t / 60);
  nombres.slice(0, 3).forEach((n, k) => serie.s[k].push(so[n]));
  serie.lo.push(st.cmin * cf);
  serie.hi.push(st.cmax * cf);
  serie.meta.push(cf);
  const tm = (m.t - tDosis) / 60;
  const vol = sim ? sim.L * sim.W * sim.H : volumen();
  const relMedia = cf > 0 ? st.masa_mg / (vol * 1000) / cf : 1;
  if (tm > 0 && deteccion.cov5 == null && st.cov < 0.05) deteccion.cov5 = tm;
  if (tm > 0 && deteccion.todo10 == null && st.cmin >= 0.9 * relMedia && st.cmax <= 1.1 * relMedia) deteccion.todo10 = tm;
  if (dosisT.length === 1 && corrida) {
    corrida.tMax = tm;
    if (corrida.cov5 == null && deteccion.cov5 != null) corrida.cov5 = deteccion.cov5;
    if (corrida.todo10 == null && deteccion.todo10 != null) corrida.todo10 = deteccion.todo10;
  }
  graficaSucia = true;
}

function bombaEncendida() {
  if (est.modo === "siempre") return true;
  if (est.modo === "apagada") return false;
  return sim ? sim.encendida : true;
}

// ---------- velocidad interpolada en la instantánea ----------

const snap = { set: null, uc: null, vc: null, wc: null, spd: null, vmax: 0, vEsc: 0.05 };

function velEn(x, y, z, out) {
  const { nx, ny, nz } = snap;
  let fi = x / snap.dx - 0.5, fj = y / snap.dy - 0.5, fk = z / snap.dz - 0.5;
  fi = fi < 0 ? 0 : fi > nx - 1 ? nx - 1 : fi;
  fj = fj < 0 ? 0 : fj > ny - 1 ? ny - 1 : fj;
  fk = fk < 0 ? 0 : fk > nz - 1 ? nz - 1 : fk;
  let i0 = fi | 0, j0 = fj | 0, k0 = fk | 0;
  if (i0 > nx - 2) i0 = nx - 2;
  if (j0 > ny - 2) j0 = ny - 2;
  if (k0 > nz - 2) k0 = nz - 2;
  const ti = fi - i0, tj = fj - j0, tk = fk - k0;
  const sx = ny * nz, sy = nz;
  const b = (i0 * ny + j0) * nz + k0;
  const w000 = (1 - ti) * (1 - tj) * (1 - tk), w001 = (1 - ti) * (1 - tj) * tk;
  const w010 = (1 - ti) * tj * (1 - tk), w011 = (1 - ti) * tj * tk;
  const w100 = ti * (1 - tj) * (1 - tk), w101 = ti * (1 - tj) * tk;
  const w110 = ti * tj * (1 - tk), w111 = ti * tj * tk;
  const b1 = b + sy, b2 = b + sx, b3 = b + sx + sy;
  let a = snap.uc;
  out[0] = a[b] * w000 + a[b + 1] * w001 + a[b1] * w010 + a[b1 + 1] * w011 + a[b2] * w100 + a[b2 + 1] * w101 + a[b3] * w110 + a[b3 + 1] * w111;
  a = snap.vc;
  out[1] = a[b] * w000 + a[b + 1] * w001 + a[b1] * w010 + a[b1 + 1] * w011 + a[b2] * w100 + a[b2 + 1] * w101 + a[b3] * w110 + a[b3 + 1] * w111;
  a = snap.wc;
  out[2] = a[b] * w000 + a[b + 1] * w001 + a[b1] * w010 + a[b1 + 1] * w011 + a[b2] * w100 + a[b2 + 1] * w101 + a[b3] * w110 + a[b3 + 1] * w111;
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

function operacion() {
  try {
    return puntoOperacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida);
  } catch {
    return null;
  }
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
  const op = operacion();
  // Chorro redondo libre: u_eje = 6.2 u0 d / x (estimación, vale lejos de la boquilla).
  const uFin = op ? Math.min(op.u_ms, 6.2 * op.u_ms * (cfg.boquilla_mm / 1000) / t) : 0;
  return { t, fin, donde, dist, tc, uFin };
}

function resumenCfg() {
  const p = geo.pos_bomba, d = geo.dir_chorro;
  const op = operacion();
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

function dosisJuntoAlFlotador() {
  const pd = geo.punto_dosis, ll = cfg.llenado;
  return Math.hypot(pd[0] - ll[0], pd[1] - ll[1]) < JUNTOS_M;
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
  const capa = document.createElement("canvas");
  return {
    tipo, canvas, ctx: canvas.getContext("2d"), over, octx: over.getContext("2d"), img, ictx: img.getContext("2d"),
    capa, cctx: capa.getContext("2d"), cimg: null, c32: null,
    w: 0, h: 0, dpr: 1, esc: 100, sucio: true, visible: true, manijas: [], P: null, ext: null, flechas: null,
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
    const clave = [pc.o, pc.h, pc.h0, pc.h1].flat().map((q) => q.toFixed(3)).join();
    if (clave !== v.clavePlano) v.P = null;
    v.clavePlano = clave;
    v.pc = pc;
    const m = { l: 30, r: 52, t: 8, b: 50 };
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
    v.capa.width = w;
    v.capa.height = h;
    v.cimg = v.cctx.createImageData(w, h);
    v.c32 = new Uint32Array(v.cimg.data.buffer);
    patron = null;
  }
  if (v.esc !== esc) v.P = null;
  v.esc = esc;
  v.sucio = true;
  v.flechas = null;
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

function anchoTexto(c, s, tam, peso = 500, mono = false) {
  c.font = fuente(tam, peso, mono);
  return c.measureText(s).width;
}

// Cota al estilo de plano: línea fina, diagonales en los extremos y el número en cm.
function cotaH(c, R, x1, x2, y, txt, color = T.tinta2, yRef = null) {
  if (yRef != null) {
    trazo(c, [[x1, yRef], [x1, y + 4]], color, 0.8);
    trazo(c, [[x2, yRef], [x2, y + 4]], color, 0.8);
  }
  trazo(c, [[x1 - 4, y], [x2 + 4, y]], color, 1);
  for (const x of [x1, x2]) trazo(c, [[x - 4, y + 4], [x + 4, y - 4]], color, 1.2);
  const xm = (x1 + x2) / 2, tw = anchoTexto(c, txt, 11, 500, true);
  texto(c, txt, xm, y - 7, { color, tam: 11, mono: true, alinea: "center" });
  R.tapa(xm - tw / 2 - 2, y - 14, xm + tw / 2 + 2, y, 4);
  R.linea(x1, y, x2, y, 2, 0.4);
}

function cotaV(c, R, x, y1, y2, txt, color = T.tinta2, xRef = null, lado = 1) {
  if (xRef != null) {
    trazo(c, [[xRef, y1], [x + 4 * lado, y1]], color, 0.8);
    trazo(c, [[xRef, y2], [x + 4 * lado, y2]], color, 0.8);
  }
  trazo(c, [[x, y1 + 4], [x, y2 - 4]], color, 1);
  for (const y of [y1, y2]) trazo(c, [[x - 4, y + 4], [x + 4, y - 4]], color, 1.2);
  const ym = (y1 + y2) / 2, tw = anchoTexto(c, txt, 11, 500, true);
  texto(c, txt, x + 8 * lado, ym, { color, tam: 11, mono: true, alinea: "center", rot: -Math.PI / 2 });
  R.tapa(x + 8 * lado - 7, ym - tw / 2 - 2, x + 8 * lado + 7, ym + tw / 2 + 2, 4);
  R.linea(x, y1, x, y2, 2, 0.4);
}

function barraEscala(c, R, x, y, esc) {
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
  R.tapa(x - 6, y - 2, x + n * paso * esc + 40, y + 20, 4);
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

// ---------- rótulos sin choques ----------
// Cada nombre prueba lugares alrededor de su pieza, en anillos cada vez más lejanos, y se queda
// con el que menos tapa a otros rótulos, a las piezas dibujadas y a las cotas. Desde el segundo
// anillo lleva línea guía. Las cotas que miden piezas (alturas, distancias a los muros) también
// se acomodan: prueban varias posiciones de su línea y de su número, y se colocan primero porque
// tienen menos lugares posibles.

const RUMBOS = { e: [1, 0], o: [-1, 0], n: [0, -1], s: [0, 1], ne: [1, -1], no: [-1, -1], se: [1, 1], so: [-1, 1] };
const ORDEN_RUMBOS = ["e", "o", "ne", "no", "se", "so", "n", "s"];
const TAM_COTA = 11;

const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

function creaRotulos(c, w, h, tam) {
  const obst = [];
  const pedidos = [];
  const puestos = [];
  const fuera = (r) => r[0] < 1 || r[1] < 1 || r[2] > w - 1 || r[3] > h - 1;
  const holgado = (r) => [r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2];
  const R = {
    tapa(x0, y0, x1, y1, peso = 3) {
      obst.push([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), peso]);
    },
    punto(x, y, r, peso = 3) {
      obst.push([x - r, y - r, x + r, y + r, peso]);
    },
    linea(xa, ya, xb, yb, g = 3, peso = 1) {
      const n = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) / (1.6 * g)));
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n, y = ya + ((yb - ya) * i) / n;
        obst.push([x - g, y - g, x + g, y + g, peso]);
      }
    },
    // Nombre de una pieza: se busca lugar alrededor de (x, y).
    pide(txt, x, y, o = {}) {
      pedidos.push({ tipo: "nombre", txt, x, y, r: o.r ?? 6, color: o.color ?? T.tinta2, peso: o.peso ?? 500, prio: o.prio ?? 0, pref: o.pref ?? ORDEN_RUMBOS });
    },
    // Cota móvil: cands = [{ linea: [x1, y1, x2, y2] | null, ext: [[xa, ya, xb, yb], ...], tx, ty, rot }]
    cota(txt, cands, o = {}) {
      pedidos.push({ tipo: "cota", txt, cands, color: o.color ?? T.tinta2, prio: 100 + (o.prio ?? 0) });
    },
    resuelve() {
      pedidos.sort((a, b) => b.prio - a.prio);
      // Las piezas de cada nombre estorban a los demás rótulos.
      for (const p of pedidos) if (p.tipo === "nombre") obst.push([p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, 3, p]);
      for (const p of pedidos) (p.tipo === "cota" ? colocaCota : colocaNombre)(p);
      dibuja();
      return pedidos;
    },
    get puestos() { return puestos; },
    get obst() { return obst; },
  };

  function colocaCota(p) {
    const tw = anchoTexto(c, p.txt, TAM_COTA, 500, true);
    const a = (TAM_COTA + 4) / 2, b = tw / 2 + 2;
    let mejor = null;
    p.cands.forEach((q, i) => {
      const r = q.rot ? [q.tx - a, q.ty - b, q.tx + a, q.ty + b] : [q.tx - b, q.ty - a, q.tx + b, q.ty + a];
      let costo = i * 8;
      if (fuera(r)) costo += 1e6;
      const rh = holgado(r);
      for (const u of puestos) costo += 40 * inter(rh, u);
      for (const o of obst) costo += (o[4] >= 3 ? 5 * o[4] : o[4]) * inter(r, o);
      if (q.linea) {
        const [x1, y1, x2, y2] = q.linea;
        const lr = [Math.min(x1, x2) - 1.5, Math.min(y1, y2) - 1.5, Math.max(x1, x2) + 1.5, Math.max(y1, y2) + 1.5];
        for (const u of puestos) costo += 8 * inter(lr, u);
        for (const o of obst) costo += 0.6 * o[4] * inter(lr, o);
      }
      if (!mejor || costo < mejor.costo) mejor = { costo, r, q };
    });
    const { r, q } = mejor;
    r.p = p;
    puestos.push(r);
    if (q.linea) R.linea(...q.linea, 2, 2);
    for (const e of q.ext || []) R.linea(...e, 1.5, 0.5);
    p.lugar = { r, q };
  }

  function colocaNombre(p) {
    const padX = 3, th = tam + 5;
    const tw = anchoTexto(c, p.txt, tam, p.peso) + 2 * padX;
    let mejor = null;
    const anillos = [p.r + 3, p.r + 15, p.r + 30, p.r + 48, p.r + 70];
    const rumbos = [...p.pref, ...ORDEN_RUMBOS.filter((q) => !p.pref.includes(q))];
    anillos.forEach((d, ia) => {
      rumbos.forEach((nombre, ir) => {
        const [dx, dy] = RUMBOS[nombre];
        const k = dx && dy ? 0.72 : 1;
        const ax = p.x + dx * d * k, ay = p.y + dy * d * k;
        const x0 = dx > 0 ? ax : dx < 0 ? ax - tw : ax - tw / 2;
        const y0 = dy > 0 ? ay : dy < 0 ? ay - th : ay - th / 2;
        const r = [x0, y0, x0 + tw, y0 + th];
        let costo = ia * 140 + ir * 6;
        if (fuera(r)) costo += 1e6;
        const rh = holgado(r);
        for (const u of puestos) costo += 40 * inter(rh, u);
        // Tapar una pieza (peso 3 o más) cuesta más que alejarse un anillo.
        for (const o of obst) if (o[5] !== p) costo += (o[4] >= 3 ? 5 * o[4] : o[4]) * inter(r, o);
        if (ia >= 1) {
          // La línea guía tampoco debe cruzar otros rótulos.
          const gx = clamp(p.x, r[0], r[2]), gy = clamp(p.y, r[1], r[3]);
          const n = Math.max(1, Math.ceil(Math.hypot(gx - p.x, gy - p.y) / 4));
          for (let s = 1; s < n; s++) {
            const x = p.x + ((gx - p.x) * s) / n, y = p.y + ((gy - p.y) * s) / n;
            for (const u of puestos) if (x > u[0] && x < u[2] && y > u[1] && y < u[3]) costo += 60;
          }
        }
        if (!mejor || costo < mejor.costo) mejor = { costo, r, ia };
      });
    });
    const { r, ia } = mejor;
    r.p = p;
    puestos.push(r);
    let guia = null;
    if (ia >= 1) {
      const gx = clamp(p.x, r[0], r[2]), gy = clamp(p.y, r[1], r[3]);
      const dd = Math.hypot(gx - p.x, gy - p.y) || 1;
      guia = [p.x + ((gx - p.x) / dd) * p.r, p.y + ((gy - p.y) / dd) * p.r, gx, gy];
      R.linea(...guia, 1.5, 1);
    }
    p.lugar = { r, guia };
  }

  function dibuja() {
    // Primero las líneas (guías y cotas), luego todos los textos encima.
    for (const p of pedidos) {
      if (p.tipo === "nombre") {
        const { guia } = p.lugar;
        if (guia) trazo(c, [[guia[0], guia[1]], [guia[2], guia[3]]], p.color, 1);
        continue;
      }
      const { q } = p.lugar;
      for (const e of q.ext || []) trazo(c, [[e[0], e[1]], [e[2], e[3]]], p.color, 0.8);
      if (q.linea) {
        const [x1, y1, x2, y2] = q.linea;
        const vert = Math.abs(x2 - x1) < Math.abs(y2 - y1);
        if (vert) trazo(c, [[x1, Math.min(y1, y2) - 4], [x1, Math.max(y1, y2) + 4]], p.color, 1);
        else trazo(c, [[Math.min(x1, x2) - 4, y1], [Math.max(x1, x2) + 4, y1]], p.color, 1);
        for (const [x, y] of [[x1, y1], [x2, y2]]) trazo(c, [[x - 4, y + 4], [x + 4, y - 4]], p.color, 1.2);
      }
    }
    c.save();
    c.textBaseline = "middle";
    for (const p of pedidos) {
      if (p.tipo === "cota") {
        const { q } = p.lugar;
        texto(c, p.txt, q.tx, q.ty, { color: p.color, tam: TAM_COTA, mono: true, alinea: "center", rot: q.rot || 0 });
        continue;
      }
      const { r } = p.lugar;
      c.globalAlpha = 0.88;
      c.fillStyle = T.papel;
      c.beginPath();
      c.roundRect(r[0], r[1], r[2] - r[0], r[3] - r[1], 2);
      c.fill();
      c.globalAlpha = 1;
      c.font = fuente(tam, p.peso);
      c.fillStyle = p.color;
      c.textAlign = "left";
      c.fillText(p.txt, r[0] + 3, (r[1] + r[3]) / 2 + 0.5);
    }
    c.restore();
  }

  return R;
}

// Cota vertical móvil (alturas sobre el fondo en el corte): prueba la línea a varios lados y
// distancias de la pieza (xs = [[x, lado], ...]) y el número a varias alturas sobre ella.
function cotaVMovil(R, txt, yTop, yBot, xRef, xs, color, prio = 0) {
  const fr = yBot - yTop > 60 ? [0.5, 0.3, 0.7] : [0.5];
  const cands = [];
  for (const [x, lado, xr = xRef] of xs) {
    for (const f of fr) {
      cands.push({
        linea: [x, yTop, x, yBot], tx: x + 8 * lado, ty: yTop + (yBot - yTop) * f, rot: -Math.PI / 2,
        ext: [[xr, yTop, x + 4 * lado, yTop]],
      });
    }
  }
  R.cota(txt, cands, { color, prio });
}

// Registro de lo que quedó en cada vista, para revisar choques desde las pruebas.
const rotulosVista = {};

const tamRotulo = (v) => (v.w < 520 ? 11 : 12);

// ---------- planta ----------

function overlayPlanta(v) {
  const c = limpiaOverlay(v);
  const { X, Y, esc } = v;
  const R = creaRotulos(c, v.w, v.h, tamRotulo(v));
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
    const px = X(p[0] + pc.h[0] * sgn * 0.075), py = Y(p[1] + pc.h[1] * sgn * 0.075);
    texto(c, "A", px, py, { tam: 11, peso: 700, alinea: "center", color: T.tinta2 });
    R.punto(px, py, 7, 4);
  }

  // Boca de la tapa (arriba del plano de corte: línea oculta) y travesaño
  const [bx, by] = cfg.boca;
  trazo(c, [[X(bx - BOCA / 2), Y(by - BOCA / 2)], [X(bx + BOCA / 2), Y(by - BOCA / 2)], [X(bx + BOCA / 2), Y(by + BOCA / 2)],
    [X(bx - BOCA / 2), Y(by + BOCA / 2)], [X(bx - BOCA / 2), Y(by - BOCA / 2)]], T.tinta2, 1, [6, 4]);
  const [rx, ry] = geo.rumbo;
  const trav = [X(bx + ry * BOCA / 2), Y(by - rx * BOCA / 2), X(bx - ry * BOCA / 2), Y(by + rx * BOCA / 2)];
  trazo(c, [[trav[0], trav[1]], [trav[2], trav[3]]], T.tinta2, 3);
  R.linea(...trav, 3, 1);

  // Zona a evitar alrededor de la rejilla
  const [px, py] = cfg.pozo;
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
  R.linea(X(ent[0]), Y(ent[1]), X(lx), Y(ly), 2, 1);
  const rFlot = Math.max(5, 0.06 * esc);
  c.beginPath();
  c.arc(X(lx), Y(ly), rFlot, 0, Math.PI * 2);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.3;
  c.stroke();

  // Bomba de pozo con la sonda de la llave en su rejilla
  const rPozo = Math.max(5, (POZO_DIAM / 2) * esc);
  c.beginPath();
  c.arc(X(px), Y(py), rPozo, 0, Math.PI * 2);
  c.fillStyle = T.tinta2;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1;
  c.stroke();
  c.beginPath();
  c.arc(X(px), Y(py), rPozo + 3, 0, Math.PI * 2);
  c.strokeStyle = T.s[1];
  c.lineWidth = 2.5;
  c.stroke();

  // Mástil y sonda ORP
  const punta = geo.punto_tubo(cfg.z_orp);
  trazo(c, [[X(bx), Y(by)], [X(punta[0]), Y(punta[1])]], T.tinta2, Math.max(2.5, TUBO * esc));
  R.linea(X(bx), Y(by), X(punta[0]), Y(punta[1]), 3, 1.5);
  marcaSonda(c, X(punta[0]), Y(punta[1]), T.s[2]);
  marcaSonda(c, X(bx), Y(by), T.s[0]);
  R.punto(X(bx), Y(by), 6, 3);

  // Dosis
  const pd = geo.punto_dosis;
  const juntos = dosisJuntoAlFlotador();
  const dosisXY = juntos ? [X(lx) + rFlot + 4, Y(ly) - rFlot - 2] : [X(pd[0]), Y(pd[1]) - 2];
  marcaDosis(c, dosisXY[0], dosisXY[1]);
  R.punto(dosisXY[0], dosisXY[1] - 2, 7, 3);

  // Bomba de mezcla, chorro y amarre libre
  const pb = geo.pos_bomba, d = geo.dir_chorro;
  if (cfg.pos_bomba) {
    trazo(c, [[X(bx), Y(by)], [X(pb[0]), Y(pb[1])]], T.acento, 1.2, [5, 4]);
    R.linea(X(bx), Y(by), X(pb[0]), Y(pb[1]), 2, 0.5);
  }
  const colorRayo = avisoRejilla || ray.donde === "fondo" ? T.peligro : T.acento;
  trazo(c, [[X(pb[0]), Y(pb[1])], [X(ray.fin[0]), Y(ray.fin[1])]], colorRayo, 1.2, [2, 4]);
  R.linea(X(pb[0]), Y(pb[1]), X(ray.fin[0]), Y(ray.fin[1]), 2, 0.3);
  tache(c, X(ray.fin[0]), Y(ray.fin[1]), colorRayo);
  const nh = Math.hypot(d[0], d[1]);
  const az = Math.atan2(d[1], d[0]);
  const lf = Math.max(0.5 * nh, 0.24);
  const tip = [pb[0] + Math.cos(az) * lf, pb[1] + Math.sin(az) * lf];
  flecha(c, X(pb[0]), Y(pb[1]), X(tip[0]), Y(tip[1]), T.acento, 2.5, 10);
  R.linea(X(pb[0]), Y(pb[1]), X(tip[0]), Y(tip[1]), 4, 2);
  cuerpoMibee(c, X(pb[0]), Y(pb[1]), -az, esc);
  manija(v, "bomba", X(pb[0]), Y(pb[1]), 15);
  c.beginPath();
  c.arc(X(tip[0]), Y(tip[1]), 7, 0, Math.PI * 2);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.acento;
  c.lineWidth = 2;
  c.stroke();
  R.punto(X(tip[0]), Y(tip[1]), 9, 3);
  v.manijas.push({ id: "chorro", x: X(tip[0]), y: Y(tip[1]), r: 20 });

  if (est.editar) {
    manija(v, "boca", X(bx), Y(by), 12, true, "cuadro");
    manija(v, "pozo", X(px), Y(py), 12, true, "cuadro");
    manija(v, "llenado", X(lx), Y(ly), 12, true, "cuadro");
  }

  if (est.capas.cotas) {
    cotaH(c, R, X(0), X(L), Y(-MURO) + 18, String(cm(L)), T.tinta2, Y(-MURO) + 2);
    cotaV(c, R, X(L + MURO) + 18, Y(W), Y(0), String(cm(W)), T.tinta2, X(L + MURO) + 2);
    // Posición de la bomba desde las dos paredes más cercanas
    const xw = pb[0] < L / 2 ? 0 : L, yw = pb[1] < W / 2 ? 0 : W;
    const dxm = Math.abs(pb[0] - xw), dym = Math.abs(pb[1] - yw);
    // El número se acomoda a lo largo de su línea punteada, de un lado o del otro.
    const fr = [0.5, 0.35, 0.65, 0.2, 0.8];
    if (dxm > 0.08) {
      const xa = X(xw), xb = X(pb[0]) - Math.sign(pb[0] - xw) * 14, yl = Y(pb[1]);
      trazo(c, [[xa, yl], [xb, yl]], T.acento, 0.9, [1, 3]);
      R.linea(xa, yl, xb, yl, 2, 0.5);
      const cands = [];
      for (const f of fr) for (const dy of [10, -10]) cands.push({ tx: xa + (xb - xa) * f, ty: yl + dy });
      R.cota(String(cm(dxm)), cands, { color: T.acento, prio: 2 });
    }
    if (dym > 0.08) {
      const ya = Y(yw), yb = Y(pb[1]) + Math.sign(pb[1] - yw) * 14, xl = X(pb[0]);
      trazo(c, [[xl, ya], [xl, yb]], T.acento, 0.9, [1, 3]);
      R.linea(xl, ya, xl, yb, 2, 0.5);
      const s = String(cm(dym)), tw = anchoTexto(c, s, TAM_COTA, 500, true);
      const cands = [];
      for (const f of fr) for (const dx of [6 + tw / 2, -6 - tw / 2]) cands.push({ tx: xl + dx, ty: ya + (yb - ya) * f });
      R.cota(s, cands, { color: T.acento, prio: 2 });
    }
  }
  barraEscala(c, R, X(-MURO), Y(-MURO) + 30, esc);

  if (est.capas.nombres) {
    const lado = Math.cos(az) >= 0 ? ["o", "no", "so", "n", "s"] : ["e", "ne", "se", "n", "s"];
    R.pide("bomba de mezcla", X(pb[0]), Y(pb[1]), { r: 12, color: T.acento, peso: 600, prio: 10, pref: lado });
    R.pide("bomba de pozo", X(px), Y(py), { r: rPozo + 4, prio: 8, pref: ["s", "so", "se", "o", "e"] });
    R.pide(juntos ? "flotador y dosis" : "flotador", X(lx), Y(ly), { r: rFlot + 2, prio: 7 });
    if (!juntos) R.pide("dosis", dosisXY[0], dosisXY[1] - 2, { r: 8, prio: 6 });
    R.pide("sonda ORP", X(punta[0]), Y(punta[1]), { r: 7, prio: 6, pref: ["se", "e", "s", "ne"] });
    const etq = ray.donde === "fondo" ? "pega en el fondo" : ray.donde === "superficie" ? "sale arriba" : "pega en la pared";
    R.pide(etq, X(ray.fin[0]), Y(ray.fin[1]), { r: 7, color: colorRayo, prio: 5 });
    R.pide("boca", X(bx - BOCA / 2), Y(by + BOCA / 2), { r: 2, prio: 4, pref: ["no", "n", "o", "ne"] });
    R.pide(`mástil ${cfg.angulo_tubo}°`, X((bx + punta[0]) / 2), Y((by + punta[1]) / 2), { r: 4, prio: 3 });
  }
  R.resuelve();
  rotulosVista.planta = R;
}

// ---------- corte ----------

function overlayCorte(v) {
  const c = limpiaOverlay(v);
  const { X, Y, esc } = v;
  const R = creaRotulos(c, v.w, v.h, tamRotulo(v));
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
  trazo(c, [[X(b0), Y(zt)], [X(h0), Y(zt)], [X(h0), Y(0)], [X(h1), Y(0)], [X(h1), Y(zt)], [X(b1), Y(zt)]], T.tinta, 1.6);
  trazo(c, [[X(b0), Y(zt + LOSA)], [X(h0 - MURO), Y(zt + LOSA)], [X(h0 - MURO), Y(-MURO)], [X(h1 + MURO), Y(-MURO)],
    [X(h1 + MURO), Y(zt + LOSA)], [X(b1), Y(zt + LOSA)]], T.tinta, 1);
  trazo(c, [[X(b0), Y(zt)], [X(b0), Y(zt + LOSA)]], T.tinta, 1);
  trazo(c, [[X(b1), Y(zt)], [X(b1), Y(zt + LOSA)]], T.tinta, 1);
  R.tapa(X(h0 - MURO), Y(zt + LOSA), X(b0), Y(zt), 0.3);
  R.tapa(X(b1), Y(zt + LOSA), X(h1 + MURO), Y(zt), 0.3);

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
  R.tapa(X(hn) - 8, Y(N) - 11, X(hn) + 8, Y(N) + 9, 3);

  // Bomba de pozo colgando con su rejilla
  const [pp, pdist] = P(cfg.pozo[0], cfg.pozo[1]);
  const zr = cfg.pozo[2];
  const lejos = Math.abs(pdist) > 0.3;
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
  R.tapa(X(pp) - r - 1, Y(z1), X(pp) + r + 1, Y(z0), 3);
  R.linea(X(pp), Y(z1), X(pp), Y(zt + LOSA + 0.22), 3, 1.5);
  R.punto(X(pp) + r + 8, Y(zr), 6, 3);

  // Flotador
  const [hl] = P(cfg.llenado[0], cfg.llenado[1]);
  const zv = Math.min(zt - 0.06, N + 0.10);
  const lado = hl - h0 < h1 - hl ? -1 : 1;
  const hw = lado < 0 ? h0 - MURO : h1 + MURO;
  const hlc = clamp(hl, h0 + 0.05, h1 - 0.05);
  trazo(c, [[X(hw), Y(zv)], [X(hlc), Y(zv)]], T.tinta2, Math.max(2, 0.021 * esc));
  const bola = [hlc - lado * 0.16, N];
  trazo(c, [[X(hlc), Y(zv)], [X(bola[0]), Y(bola[1])]], T.tinta2, 1.2);
  const rBola = Math.max(4, 0.06 * esc);
  c.beginPath();
  c.arc(X(bola[0]), Y(bola[1]), rBola, 0, Math.PI * 2);
  c.fillStyle = T.papel;
  c.fill();
  c.strokeStyle = T.tinta;
  c.lineWidth = 1.3;
  c.stroke();
  if (cfg.consumo_lpm > 0) trazo(c, [[X(hlc), Y(zv)], [X(hlc), Y(N)]], T.agua, 1.5, [3, 3]);
  R.linea(X(hw), Y(zv), X(hlc), Y(zv), 2, 1);
  R.linea(X(hlc), Y(zv), X(bola[0]), Y(bola[1]), 2, 1);

  // Mástil, travesaño y sondas
  const punta = geo.punto_tubo(cfg.z_orp);
  const [ht] = P(punta[0], punta[1]);
  c.fillStyle = T.tinta2;
  c.fillRect(X(hb) - 3, Y(zt) - 3, 6, 6);
  trazo(c, [[X(hb), Y(zt)], [X(ht), Y(cfg.z_orp)]], T.tinta2, Math.max(2.5, TUBO * esc));
  R.linea(X(hb), Y(zt), X(ht), Y(cfg.z_orp), 3, 1.5);
  marcaSonda(c, X(ht), Y(cfg.z_orp), T.s[2]);
  marcaSonda(c, X(hb), Y(N - 0.10), T.s[0]);
  R.punto(X(hb), Y(N - 0.10), 6, 3);

  // Dosis
  const juntos = dosisJuntoAlFlotador();
  const [hd] = P(geo.punto_dosis[0], geo.punto_dosis[1]);
  const dosisXY = juntos ? [X(bola[0]) - lado * (rBola + 8), Y(N) - 8] : [X(clamp(hd, h0, h1)), Y(geo.punto_dosis[2]) - 2];
  marcaDosis(c, dosisXY[0], dosisXY[1]);
  R.punto(dosisXY[0], dosisXY[1] - 2, 7, 3);

  // Bomba de mezcla, chorro y cotas de altura
  const pb = geo.pos_bomba, d = geo.dir_chorro;
  const [hp] = P(pb[0], pb[1]);
  const dh = d[0] * pc.h[0] + d[1] * pc.h[1];
  if (cfg.pos_bomba) trazo(c, [[X(hb), Y(zt)], [X(hp), Y(pb[2])]], T.acento, 1.2, [5, 4]);
  const [hf] = P(ray.fin[0], ray.fin[1]);
  const colorRayo = avisoRejilla || ray.donde === "fondo" ? T.peligro : T.acento;
  trazo(c, [[X(hp), Y(pb[2])], [X(hf), Y(ray.fin[2])]], colorRayo, 1.2, [2, 4]);
  R.linea(X(hp), Y(pb[2]), X(hf), Y(ray.fin[2]), 2, 0.3);
  tache(c, X(hf), Y(ray.fin[2]), colorRayo);
  R.punto(X(hf), Y(ray.fin[2]), 6, 3);
  const nd = Math.hypot(dh, d[2]) || 1;
  const lf = 0.45;
  const tip = [hp + (dh / nd) * lf, pb[2] + (d[2] / nd) * lf];
  flecha(c, X(hp), Y(pb[2]), X(tip[0]), Y(tip[1]), T.acento, 2.5, 10);
  R.linea(X(hp), Y(pb[2]), X(tip[0]), Y(tip[1]), 4, 2);
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
    R.punto(X(tip[0]), Y(tip[1]), 9, 3);
    v.manijas.push({ id: "chorro-el", x: X(tip[0]), y: Y(tip[1]), r: 20 });
  }

  if (est.capas.cotas) {
    const xr = X(h1 + MURO);
    cotaV(c, R, xr + 14, Y(N), Y(0), String(cm(N)), T.agua, X(h1) + 2);
    cotaV(c, R, xr + 34, Y(zt), Y(0), String(cm(zt)), T.tinta2, xr + 2);
    // Alturas de la rejilla, la bomba y la sonda ORP: cada una prueba su línea a los dos lados de
    // su pieza y a varias distancias; primero del lado contrario al chorro.
    const ladoB = dh >= 0 ? -1 : 1;
    const xsDe = (x0, ds, primero, xRef0 = x0, hueco = 0) => ds.flatMap((d) => [primero, -primero]
      .map((s) => [x0 + s * (d + hueco), s, xRef0 + s * hueco]));
    cotaVMovil(R, String(cm(pb[2])), Y(pb[2]), Y(0), X(hp), xsDe(X(hp), [18, 32, 46, 60], ladoB), T.acento, 3);
    cotaVMovil(R, String(cm(cfg.z_orp)), Y(cfg.z_orp), Y(0), X(ht), xsDe(X(ht), [14, 28, 42, 56], ht >= hp ? 1 : -1), T.s[2], 2);
    cotaVMovil(R, String(cm(zr)), Y(zr), Y(0), X(pp), xsDe(X(pp), [12, 26, 40], -1, X(pp), r), T.tinta2, 1);
    const txtLargo = est.corte === "largo" ? String(cm(h1 - h0)) : `${cm(h1 - h0)} por el chorro`;
    cotaH(c, R, X(h0), X(h1), Y(-MURO) + 18, txtLargo, T.tinta2, Y(-MURO) + 2);
  }
  barraEscala(c, R, X(h0 - MURO), Y(-MURO) + 30, esc);
  for (const [xa, al] of [[X(h0 - MURO) - 10, "center"], [X(h1 + MURO) + 10, "center"]]) {
    texto(c, "A", xa, Y(zt + LOSA + 0.15), { tam: 11, peso: 700, color: T.tinta2, alinea: al });
    R.punto(xa, Y(zt + LOSA + 0.15), 7, 4);
  }

  if (est.capas.nombres) {
    const izq = dh >= 0;
    R.pide("bomba de mezcla", X(hp), Y(pb[2]), { r: 12, color: T.acento, peso: 600, prio: 10, pref: izq ? ["no", "o", "n", "so"] : ["ne", "e", "n", "se"] });
    R.pide("bomba de pozo", X(pp), Y((z0 + z1) / 2), { r: r + 2, prio: 8, pref: ["o", "e", "no", "ne"] });
    R.pide(juntos ? "flotador y dosis" : "flotador", X(bola[0]), Y(N), { r: rBola + 2, prio: 7, pref: ["n", "ne", "no", "e", "o"] });
    if (!juntos) R.pide("dosis", dosisXY[0], dosisXY[1] - 2, { r: 8, prio: 6 });
    R.pide("boca", X(hb), Y(zt + LOSA), { r: 3, prio: 6, pref: ["n", "ne", "no"] });
    R.pide("sonda ORP", X(ht), Y(cfg.z_orp), { r: 7, prio: 6, pref: ["e", "o", "se", "ne"] });
    R.pide(est.capas.cotas ? "nivel" : `nivel ${cm(N)}`, X(hn), Y(N) - 6, { r: 7, color: T.agua, prio: 5, pref: ["o", "no", "e", "ne"] });
    if (ray.donde === "fondo") R.pide("pega en el fondo", X(hf), Y(ray.fin[2]), { r: 7, color: colorRayo, prio: 5, pref: ["n", "ne", "no"] });
  }
  R.resuelve();
  rotulosVista.corte = R;
}

// ---------- fondo: cloro o rapidez ----------

function valorFondo() {
  if (est.fondo === "vel") {
    const a = snap.spd, e = snap.vEsc;
    return (m) => a[m] / e;
  }
  const a = sim.c, e = 2 * (sim.cFinal > 0 ? sim.cFinal : 1);
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
  v.ext = [0, sim.L, 0, sim.W];
}

function pintaFondoCorte(v) {
  const { nx, ny, nz, dx, dy } = sim;
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
  v.ext = est.corte === "largo" ? [0, sim.L, 0, sim.H] : [pc.h0, pc.h1, 0, sim.H];
}

// ---------- partículas ----------
// Posiciones en metros (3D) y estela en píxeles CSS. Se rasterizan en un ImageData propio:
// miles de trazos con stroke() cuestan decenas de ms por cuadro en un canvas sin GPU.

function creaParticulas(v) {
  const n = Math.round(clamp((v.w * v.h) / (v.tipo === "planta" ? 150 : 170), 250, 1400));
  const P = {
    n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    edad: new Float32Array(n), vida: new Float32Array(n),
    hx: new Float32Array(n * ESTELA), hy: new Float32Array(n * ESTELA), cuenta: new Uint8Array(n), cab: 0,
    pix: new Int32Array(n * ESTELA * 8), alfa: new Uint8Array(n * ESTELA * 8),
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
    const pc = v.pc;
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

const velA = [0, 0, 0];

function mueveParticulas(v, dtp, dtReal) {
  if (!snap.uc) return;
  if (!v.P) v.P = creaParticulas(v);
  const P = v.P;
  const { L, W, H } = snap;
  const hmin = Math.min(snap.dx, snap.dy, snap.dz);
  const nsub = clamp(Math.ceil((dtp * snap.vmax) / (0.5 * hmin)), 1, 6);
  const h = dtp / nsub;
  const pc = v.tipo === "corte" ? v.pc : null;
  const capa = v.tipo === "planta" && est.planta !== "promedio";
  const zc = est.zPlanta;
  const { X, Y } = v;
  P.cab = (P.cab + 1) % ESTELA;
  const vel = velA;
  for (let k = 0; k < P.n; k++) {
    let x = P.x[k], y = P.y[k], z = P.z[k];
    if (dtp > 0) {
      for (let s = 0; s < nsub; s++) {
        velEn(x, y, z, vel);
        const xm = x + 0.5 * h * vel[0], ym = y + 0.5 * h * vel[1], zm = z + 0.5 * h * vel[2];
        velEn(xm, ym, zm, vel);
        x += h * vel[0];
        y += h * vel[1];
        z += h * vel[2];
      }
    }
    P.edad[k] += dtReal;
    let fuera = x < 0.005 || x > L - 0.005 || y < 0.005 || y > W - 0.005 || z < 0.005 || z > H - 0.005 || P.edad[k] > P.vida[k];
    let s = 0;
    if (pc) {
      const ex = x - pc.o[0], ey = y - pc.o[1];
      s = ex * pc.h[0] + ey * pc.h[1];
      if (Math.abs(ex * pc.n[0] + ey * pc.n[1]) > FRANJA * 1.2) fuera = true;
    } else if (capa && Math.abs(z - zc) > 0.15) {
      fuera = true;
    }
    if (fuera) {
      siembra(v, P, k);
      x = P.x[k];
      y = P.y[k];
      z = P.z[k];
      if (pc) s = (x - pc.o[0]) * pc.h[0] + (y - pc.o[1]) * pc.h[1];
    } else {
      P.x[k] = x;
      P.y[k] = y;
      P.z[k] = z;
    }
    const i = k * ESTELA + P.cab;
    if (pc) {
      P.hx[i] = X(s);
      P.hy[i] = Y(z);
    } else {
      P.hx[i] = X(x);
      P.hy[i] = Y(y);
    }
    P.cuenta[k] = Math.min(ESTELA, P.cuenta[k] + 1);
  }
}

// Estelas a píxel: primero un halo de 3x3 del color del papel, luego la tinta encima.
function rasterParticulas(v) {
  const P = v.P;
  if (!P || !v.c32) return false;
  const W = v.w, H = v.h, buf = v.c32;
  buf.fill(0);
  const pix = P.pix, alfa = P.alfa;
  let n = 0;
  const cap = pix.length;
  for (let k = 0; k < P.n; k++) {
    const cnt = P.cuenta[k];
    if (cnt < 1) continue;
    const base = k * ESTELA;
    let ix = base + P.cab;
    let x1 = P.hx[ix], y1 = P.hy[ix];
    for (let a = 0; a < cnt; a++) {
      const al = (235 * (1 - a / ESTELA)) | 0;
      let x0 = x1, y0 = y1;
      if (a + 1 < cnt) {
        ix = base + ((P.cab - a - 1 + ESTELA) % ESTELA);
        x0 = P.hx[ix];
        y0 = P.hy[ix];
      }
      const pasos = Math.min(8, Math.max(1, Math.ceil(Math.max(Math.abs(x0 - x1), Math.abs(y0 - y1)))));
      for (let q = 0; q < pasos && n < cap; q++) {
        const t = q / pasos;
        const px = (x1 + (x0 - x1) * t) | 0, py = (y1 + (y0 - y1) * t) | 0;
        if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) continue;
        pix[n] = py * W + px;
        alfa[n++] = al;
      }
      x1 = x0;
      y1 = y0;
      if (a + 1 >= cnt) break;
    }
  }
  const [hr, hg, hb] = T.haloRgb, [tr, tg, tb] = T.tintaRgb;
  const haloRgb = (hb << 16) | (hg << 8) | hr;
  for (let q = 0; q < n; q++) {
    const ah = (alfa[q] * 0.55) | 0;
    const p0 = pix[q] - W - 1;
    for (let f = 0; f < 3; f++) {
      const pf = p0 + f * W;
      for (let e = 0; e < 3; e++) {
        const ex = buf[pf + e] >>> 24;
        if (ex < ah) buf[pf + e] = ((ah << 24) | haloRgb) >>> 0;
      }
    }
  }
  for (let q = 0; q < n; q++) {
    const p = pix[q], ai = alfa[q] / 255;
    const e = buf[p], ea = (e >>> 24) / 255;
    const oa = ai + ea * (1 - ai);
    const ke = (ea * (1 - ai)) / oa, ki = ai / oa;
    const r = tr * ki + (e & 255) * ke, g = tg * ki + ((e >>> 8) & 255) * ke, b = tb * ki + ((e >>> 16) & 255) * ke;
    buf[p] = (((oa * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  v.cctx.putImageData(v.cimg, 0, 0);
  return true;
}

function dibujaFlechas(c, v) {
  if (!snap.uc) return;
  if (!v.flechas || v.flechas.n !== nSnap) {
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
      const pc = v.pc;
      for (let s = pc.h0 + 0.1; s < pc.h1; s += 0.2) {
        for (let z = 0.075; z < H; z += 0.15) {
          velEn(pc.o[0] + s * pc.h[0], pc.o[1] + s * pc.h[1], z, vel);
          una(s, z, vel[0] * pc.h[0] + vel[1] * pc.h[1], vel[2]);
        }
      }
    }
    v.flechas = { n: nSnap, p, cabezas };
  }
  const { p, cabezas } = v.flechas;
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
  if (est.capas.part && v.P) {
    c.imageSmoothingEnabled = true;
    c.drawImage(v.capa, 0, 0, v.w, v.h);
  }
  c.drawImage(v.over, 0, 0, v.w, v.h);
}

// ---------- gráfica ----------

const graf = { canvas: $("c-grafica"), w: 0, h: 0, dpr: 1, m: { l: 44, r: 12, t: 24, b: 26 }, xMax: 30, yMax: 1.5 };
graf.ctx = graf.canvas.getContext("2d");

function dimensionaGrafica() {
  const w = graf.canvas.parentElement.clientWidth;
  const h = window.innerWidth < 760 ? 180 : 200;
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

  const yp = pasoBonito(yMax / 4);
  for (let y = 0; y <= yMax + 1e-9; y += yp) {
    trazo(c, [[m.l, Y(y)], [w - m.r, Y(y)]], T.linea, 1);
    texto(c, y.toFixed(yp < 0.1 ? 2 : 1), m.l - 6, Y(y), { tam: 11, mono: true, alinea: "right", color: T.tinta2, halo: false });
  }
  for (let t = 0; t <= xMax; t += xp) {
    texto(c, String(t), X(t), h - m.b + 12, { tam: 11, mono: true, alinea: "center", color: T.tinta2, halo: false });
  }
  texto(c, "min", w - m.r, h - 5, { tam: 11, alinea: "right", color: T.tinta3, halo: false });
  texto(c, "mg/L", m.l - 6, 8, { tam: 11, alinea: "right", color: T.tinta3, halo: false });

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
  const marcas = [];
  const tf = corrida?.formula;
  if (tf && dosisT.length && tf + dosisT[0] / 60 <= xMax) marcas.push([dosisT[0] / 60 + tf, "fórmula", [1, 3]]);
  if (est.modo === "firmware" && apagaEn / 60 <= xMax) marcas.push([apagaEn / 60, "bomba se apaga", [4, 3]]);
  marcas.sort((a, b) => a[0] - b[0]);
  let finIzq = -Infinity;
  for (const [tm, etq, guion] of marcas) {
    const xm = X(tm);
    trazo(c, [[xm, m.t], [xm, h - m.b]], T.tinta3, 1, guion);
    const tw = anchoTexto(c, etq, 11);
    const derecha = xm + 3 + tw <= w - m.r;
    const x0 = derecha ? xm + 3 : xm - 3 - tw;
    const y = x0 < finIzq + 4 ? m.t + 18 : m.t + 6;
    texto(c, etq, derecha ? xm + 3 : xm - 3, y, { tam: 11, color: T.tinta2, alinea: derecha ? "left" : "right" });
    finIzq = Math.max(finIzq, x0 + tw);
  }
  for (const td of dosisT) {
    const xd = X(td / 60);
    c.beginPath();
    c.moveTo(xd - 5, m.t - 8);
    c.lineTo(xd + 5, m.t - 8);
    c.lineTo(xd, m.t);
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

function pon(id, html) {
  const el = $(id);
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

function pintaLecturas() {
  if (!sim) return;
  const tm = (sim.t - tDosis) / 60;
  pon("l-tiempo", fmtMin(tm));
  const st = ultimo.stats, so = ultimo.sondas, cf = sim.cFinal;
  if (st) {
    const ok = st.cov < 0.05;
    pon("l-cov", `${st.cov.toFixed(2)}<span class="chip ${ok ? "ok" : "no"}">${ok ? "mezclada" : "falta"}</span>`);
    pon("l-rango", `${Math.round(st.cmin * 100)} a ${Math.round(st.cmax * 100)} <small>%</small>`);
  }
  pon("l-meta", `${cf.toFixed(2)} <small>mg/L</small>`);
  if (so) {
    Object.keys(so).slice(0, 3).forEach((n, k) => pon(`l-s${k}`, `${so[n].toFixed(2)} <small>mg/L</small>`));
  }
  let estado;
  if (est.modo === "siempre") estado = "encendida <small class=\"bloque\">siempre</small>";
  else if (est.modo === "apagada") estado = "apagada";
  else estado = bombaEncendida()
    ? `encendida <small class="bloque">se apaga en ${Math.max(0, Math.ceil((apagaEn - sim.t) / 60))} min</small>`
    : "apagada <small class=\"bloque\">pasaron 45 min</small>";
  pon("l-estado", estado);
  const op = operacion();
  if (op) {
    pon("l-q", `${Math.round(op.q_lh)} <small>L/h</small>`);
    pon("l-u", `${op.u_ms.toFixed(2)} <small>m/s</small>`);
    pon("l-m", `${(op.m_m4s2 * 1e4).toFixed(1)}<small>×10⁻⁴ m⁴/s²</small>`);
    pon("l-formula", fmtMin(tiempoMezclaS(volumen(), op.m_m4s2) / 60));
  }
  pon("l-sim5", deteccion.cov5 != null ? fmtMin(deteccion.cov5) : `<small>aún no</small>`);
  pon("l-sim10", deteccion.todo10 != null ? fmtMin(deteccion.todo10) : `<small>aún no</small>`);
  const pb = geo.pos_bomba;
  if (cfg.pos_bomba) {
    const hdist = Math.hypot(pb[0] - cfg.boca[0], pb[1] - cfg.boca[1]);
    const dz = cfg.z_tapa - pb[2];
    pon("l-montaje", `tubo de ${Math.hypot(hdist, dz).toFixed(2)} m a ${Math.round(Math.atan2(dz, hdist) / RAD)}° <small>desde el travesaño</small>`);
  } else {
    const ltubo = (cfg.z_tapa - pb[2]) / Math.sin(cfg.angulo_tubo * RAD);
    pon("l-montaje", `mástil a ${cfg.angulo_tubo}°, bomba a ${ltubo.toFixed(2)} m <small>del travesaño por el tubo</small>`);
  }
  $("reloj-t").textContent = `${(sim.t / 60).toFixed(1)} min`;
  const v = perf.vSim;
  $("reloj-v").textContent = !est.corriendo ? "en pausa" : timerReinicio ? "aplicando el cambio" : v > 0 ? `simula a ${v < 10 ? v.toFixed(1) : Math.round(v)}x` : "arrancando";
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
  $("rendimiento").textContent = `Dibujo a ${Math.round(perf.fps)} cuadros/s. Motor en ${perf.motor}: `
    + `${perf.motorPasoMs.toFixed(1)} ms por paso, malla de ${sim.nx}x${sim.ny}x${sim.nz}.`;
}

function pintaMotor() {
  $("d-motor").textContent = perf.motor === "worker" ? "CFD 3D en segundo plano" : "CFD 3D en el hilo principal";
}

function pintaAvisos() {
  const out = [];
  if (errorMotor) out.push(`<p class="aviso peligro"><b>El motor se detuvo.</b> ${errorMotor}. Recarga la página.</p>`);
  if (errorCfg) out.push(`<p class="aviso peligro"><b>No se aplicó el cambio.</b> ${errorCfg}. Sigue corriendo la configuración anterior.</p>`);
  const ray = rayoChorro();
  if (ray.dist < DIST_REJILLA) {
    out.push(`<p class="aviso"><b>El chorro pasa a ${cm(ray.dist)} cm de la rejilla de la bomba de pozo.</b> Mantenlo a más de ${cm(DIST_REJILLA)} cm: el cloro sin mezclar se iría directo a la casa.</p>`);
  }
  if (ray.donde === "fondo") {
    out.push(`<p class="aviso"><b>El chorro pega en el fondo</b> a ${cm(ray.t)} cm de la boquilla, a unos ${ray.uFin.toFixed(2)} m/s (estimado como chorro redondo libre): puede levantar lodo. Inclínalo menos o sube la bomba.</p>`);
  }
  pon("avisos", out.join(""));
}

function pintaCorridas() {
  const celda = (r, x) => x != null ? `${x.toFixed(1)} min` : r.activa ? "corriendo" : `&gt; ${r.tMax.toFixed(0)} min`;
  pon("corridas", corridas.map((r) => `<tr class="${r === corrida ? "actual" : ""}">
    <td class="num">${r.n}</td><td>${r.bomba}</td><td>${r.chorro}</td><td>${r.dosis}</td>
    <td class="num">${r.formula != null ? r.formula.toFixed(1) + " min" : "-"}</td>
    <td class="num">${celda(r, r.cov5)}</td><td class="num">${celda(r, r.todo10)}</td></tr>`).join(""));
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

function cambiaConsumo() {
  motor?.manda({ tipo: "consumo", consumo_lpm: cfg.consumo_lpm });
  for (const v of Object.values(vistas)) v.sucio = true;
}

function syncControles() {
  for (const [id, r] of Object.entries(rangos)) {
    const v = r.get();
    if (document.activeElement !== $(id)) $(id).value = v;
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
  dimensiona(vistas.corte);
  syncControles();
  errorCfg = valida();
  pintaAvisos();
  pintaLecturas();
  pintaSubtitulos();
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
  $("play").setAttribute("aria-pressed", String(!est.corriendo));
  mandaControl();
  pintaLecturas();
});
$("reiniciar").addEventListener("click", () => {
  clearTimeout(timerReinicio);
  timerReinicio = 0;
  arranca();
});
$("echar").addEventListener("click", echaCloro);
$("velocidad").addEventListener("change", (e) => {
  est.velocidad = Number(e.target.value);
  mandaControl();
});
$("modo-bomba").addEventListener("change", (e) => {
  est.modo = e.target.value;
  mandaControl();
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
  vistas.planta.flechas = null;
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
});

$("z-planta").addEventListener("input", (e) => {
  est.zPlanta = Number(e.target.value) / 100;
  $("o-z-planta").textContent = `${e.target.value} cm`;
  vistas.planta.flechas = null;
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
  const [, pd] = proy(planoCorte(), cfg.pozo[0], cfg.pozo[1]);
  $("pie-corte").textContent = (est.corte === "largo"
    ? "Corte a lo largo por la bomba de mezcla."
    : "Corte por el plano del chorro: arrastra la punta de la flecha para inclinarlo.")
    + " Arrastra la bomba para subirla o bajarla. Partículas a ±25 cm del corte."
    + (Math.abs(pd) > 0.3 ? ` La bomba de pozo queda a ${cm(Math.abs(pd))} cm del corte y se ve tenue.` : "");
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
      cfg.elevacion = clamp(Math.round(Math.atan2(b - p[2], Math.max(a - hp, 0.001)) / RAD), -90, 90);
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

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", leeTokens);
new MutationObserver(leeTokens).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
document.fonts?.ready.then(() => {
  for (const v of Object.values(vistas)) v.sucio = true;
  graficaSucia = true;
});
document.addEventListener("visibilitychange", mandaControl);

graf.canvas.addEventListener("pointermove", hoverGrafica);
graf.canvas.addEventListener("pointerdown", hoverGrafica);
graf.canvas.addEventListener("pointerleave", () => {
  graf.hover = null;
  $("tip").hidden = true;
  graficaSucia = true;
});

let tAnterior = performance.now();
let tFondo = 0, tLecturas = 0, tCorridas = 0, snapFondo = -1;

function cuadro(ahora) {
  const t0 = performance.now();
  const dtReal = Math.min(0.1, Math.max(0, (ahora - tAnterior) / 1000));
  if (dtReal > 0) media("fps", 1 / dtReal);
  tAnterior = ahora;
  if (sim && ((nSnap !== snapFondo && ahora - tFondo > 100) || fondoSucio)) {
    const tf = performance.now();
    pintaFondoPlanta(vistas.planta);
    pintaFondoCorte(vistas.corte);
    media("fondoMs", performance.now() - tf);
    tFondo = ahora;
    snapFondo = nSnap;
    fondoSucio = false;
  }
  const dtp = est.corriendo ? Math.min(DT_PART_MAX, perf.vSim * dtReal) : 0;
  if (sim && est.capas.part) {
    const tp = performance.now();
    for (const v of Object.values(vistas)) {
      if (!v.visible) continue;
      if (dtp > 0 || !v.P || !v.capaLista) {
        mueveParticulas(v, dtp, dtReal);
        v.capaLista = rasterParticulas(v);
      }
    }
    media("particulasMs", performance.now() - tp);
  }
  const tv = performance.now();
  for (const v of Object.values(vistas)) dibujaVista(v);
  if (graficaSucia) {
    dibujaGrafica();
    graficaSucia = false;
  }
  media("vistasMs", performance.now() - tv);
  if (ahora - tLecturas > 250) {
    pintaLecturas();
    tLecturas = ahora;
  }
  if (ahora - tCorridas > 1000) {
    pintaCorridas();
    tCorridas = ahora;
  }
  media("cuadroMs", performance.now() - t0);
  requestAnimationFrame(cuadro);
}

leeTokens();
for (const v of Object.values(vistas)) enlazaVista(v);
redimensiona();
syncControles();
pintaSubtitulos();
iniciaMotor();
pintaMotor();
arranca();
requestAnimationFrame(cuadro);

// Revisión de rótulos para las pruebas: pares de rótulos encimados y rótulos sobre piezas.
function choques() {
  const out = {};
  for (const [nombre, R] of Object.entries(rotulosVista)) {
    const v = vistas[nombre];
    const lista = [];
    const ps = R.puestos;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a[0] < 0 || a[1] < 0 || a[2] > v.w || a[3] > v.h) lista.push(`${a.p.txt} se sale`);
      for (let j = i + 1; j < ps.length; j++) {
        const ar = inter(a, ps[j]);
        if (ar > 2) lista.push(`${a.p.txt} / ${ps[j].p.txt}: ${Math.round(ar)} px2`);
      }
      let sobre = 0;
      for (const o of R.obst) if (o[4] >= 3 && o[5] !== a.p) sobre += inter(a, o);
      if (sobre > 6) lista.push(`${a.p.txt} sobre piezas: ${Math.round(sobre)} px2`);
    }
    out[nombre] = lista;
  }
  return out;
}

window.visor = {
  get sim() { return sim; }, cfg, est, perf, choques,
  get vSim() { return perf.vSim; }, get costoPaso() { return perf.motorPasoMs; },
  aplica(cambios) {
    Object.assign(cfg, cambios);
    cambioCfg();
  },
};
