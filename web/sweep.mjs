// Barridos de colocación de la bomba de mezcla en Node, con varios hilos.
//
//   node web/sweep.mjs                    corre todas las etapas (3 hilos)
//   node web/sweep.mjs --etapas tamizado  solo esa etapa (separadas por coma)
//   node web/sweep.mjs --plan             muestra qué casos faltan, sin correr
//   node web/sweep.mjs --reporte          tablas en Markdown con lo ya corrido
//
// Cada caso: la dosis cae al arrancar la bomba, la bomba se apaga a los 45 min (firmware) y se
// simulan 90 min. Cada resultado se agrega a resultados_barrido/casos.jsonl al terminar; al
// relanzar se saltan los casos ya hechos. Las etapas posteriores eligen sus candidatos con los
// resultados de las anteriores (regla fija, así el plan sale igual tras un reinicio).

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cisterna, geometria, validar } from "./solver.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(AQUI, "resultados_barrido");
const JSONL = path.join(DIR, "casos.jsonl");
const CSV = path.join(DIR, "casos.csv");
const RESUMEN = path.join(DIR, "resumen.json");

const MUESTRA_S = 10;
const SERIE_S = 60;
const CORTO_S = 600;
const MAX_HILOS = 3;
const DECAY_CHORRO = 6.2; // u_eje / u0 = 6.2 d / x, chorro redondo turbulento libre (Rajaratnam)
const ABRE_CHORRO = 0.2; // radio exterior del chorro / distancia (medio ángulo ~11 grados, supuesto)
const DIST_REJILLA = 0.5;

const AZIMUTS = [0, 45, 90, 135, 180, 225, 270, 315]; // relativos a la diagonal del mástil
const ELEVACIONES = [-60, -30, -15, 0, 15];
const ALTURAS = [0.2, 0.3, 0.5, 0.7, 0.9];
const DOC = { pos: "mastil", z: 0.5, az: 0, el: -60 };

// Plantas de 10 m3 a 1.20 m. "base" es la del simulador; las demás prueban que la regla no
// dependa de una geometría inventada. Boca, pozo y llenado son supuestos.
const GEOMETRIAS = {
  base: { largo: 3.40, ancho: 2.45, boca: [1.20, 1.00], pozo: [0.90, 1.00, 0.45], llenado: [0.25, 1.20, 1.10] },
  cuadrada: { largo: 2.90, ancho: 2.90, boca: [1.02, 1.18], pozo: [0.72, 1.18, 0.45], llenado: [0.25, 1.42, 1.10] },
  alargada: { largo: 4.00, ancho: 2.10, boca: [1.41, 0.86], pozo: [1.11, 0.86, 0.45], llenado: [0.25, 1.03, 1.10] },
  pozo_lado: { largo: 3.40, ancho: 2.45, boca: [1.20, 1.00], pozo: [1.20, 0.72, 0.45], llenado: [3.15, 0.30, 1.10] },
  boca_esquina: { largo: 3.40, ancho: 2.45, boca: [0.75, 0.70], pozo: [0.75, 0.42, 0.45], llenado: [3.15, 2.20, 1.10] },
};

const BASE_OP = { geom: "base", dosis: "llenado", nivel: 1.2, dx: 0.1, pre: 0, bomba_min: 45, minutos: 90, daz: 0 };

// ---- geometría de cada caso ----

const grados = (r) => (r * 180) / Math.PI;
const rad = (g) => (g * Math.PI) / 180;
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);
const r4 = (x) => Number(x.toPrecision(4));

function geoBase(g) {
  return { largo: g.largo, ancho: g.ancho, boca: g.boca, pozo: g.pozo, llenado: g.llenado };
}

// Posición en planta de la bomba: sobre el mástil del doc, o colgada en otro punto alcanzable
// desde la boca (mástil más inclinado o vertical). null = sobre el mástil a 60 grados.
function posicion(nombre, z, g) {
  const geo = geometria(geoBase(g));
  const [hx, hy] = geo.rumbo;
  const [bx, by] = g.boca;
  if (nombre === "mastil") return null;
  if (nombre === "boca") {
    const ex = bx - g.pozo[0], ey = by - g.pozo[1], n = Math.hypot(ex, ey);
    return [bx + (0.25 * ex) / n, by + (0.25 * ey) / n, z];
  }
  if (nombre === "lejos") return [bx + 1.2 * hx, by + 1.2 * hy, z];
  if (nombre === "lateral") {
    const opciones = [[-hy, hx], [hy, -hx]].map(([px, py]) => {
      const lim = [px > 0 ? (g.largo - bx) / px : px < 0 ? -bx / px : Infinity,
        py > 0 ? (g.ancho - by) / py : py < 0 ? -by / py : Infinity];
      return { px, py, espacio: Math.min(...lim) };
    });
    const o = opciones[0].espacio >= opciones[1].espacio ? opciones[0] : opciones[1];
    const s = Math.min(1.0, o.espacio - 0.4);
    return [bx + s * o.px, by + s * o.py, z];
  }
  throw new Error(`posición desconocida: ${nombre}`);
}

function idCaso(c) {
  const f = (x, n) => (x < 0 ? "-" : "+") + String(Math.round(Math.abs(x))).padStart(n, "0");
  return [c.geom, c.pos, `z${Math.round(c.z * 100)}`, `a${f(c.az, 3)}`, `e${f(c.el, 2)}`, c.dosis,
    `n${Math.round(c.nivel * 100)}`, `dx${Math.round(c.dx * 100)}`, `pre${c.pre}`, `b${c.bomba_min}`,
    c.daz ? `da${f(c.daz, 1)}` : ""].filter(Boolean).join("_");
}

function caso(p) {
  const c = { ...BASE_OP, ...p };
  const g = GEOMETRIAS[c.geom];
  const geo = geometria(geoBase(g));
  const rumbo = grados(Math.atan2(geo.rumbo[1], geo.rumbo[0]));
  const cfg = { ...geoBase(g), nivel: c.nivel, dx: c.dx, lugar_dosis: c.dosis, z_bomba: c.z,
    pos_bomba: posicion(c.pos, c.z, g), azimut: rumbo + c.az + c.daz, elevacion: c.el };
  c.id = idCaso(c);
  c.cfg = cfg;
  try {
    validar(cfg);
  } catch (e) {
    c.infactible = e.message;
  }
  return c;
}

// Recorrido del eje del chorro hasta la primera pared, el fondo o la superficie.
function ejeChorro(cfg) {
  const geo = geometria(cfg);
  const p = geo.pos_bomba, d = geo.dir_chorro;
  const lim = [cfg.largo, cfg.ancho, cfg.nivel];
  let sMax = Infinity, cara = "";
  const nombres = [["pared x=0", "pared x=L"], ["pared y=0", "pared y=A"], ["fondo", "superficie"]];
  for (let q = 0; q < 3; q++) {
    if (Math.abs(d[q]) < 1e-12) continue;
    const s = d[q] > 0 ? (lim[q] - p[q]) / d[q] : -p[q] / d[q];
    if (s < sMax) {
      sMax = s;
      cara = nombres[q][d[q] > 0 ? 1 : 0];
    }
  }
  const pz = cfg.pozo;
  const proy = Math.min(Math.max((pz[0] - p[0]) * d[0] + (pz[1] - p[1]) * d[1] + (pz[2] - p[2]) * d[2], 0), sMax);
  const dist = Math.hypot(p[0] + proy * d[0] - pz[0], p[1] + proy * d[1] - pz[1], p[2] + proy * d[2] - pz[2]);
  return { recorrido_m: sMax, choca_con: cara, dist_rejilla_m: dist, pos: p, dir: d };
}

// ---- simulación de un caso (corre en un hilo) ----

function desde(t, falla) {
  if (!falla.length || falla[falla.length - 1]) return null;
  let ultimo = -1;
  for (let q = 0; q < falla.length; q++) if (falla[q]) ultimo = q;
  return ultimo < 0 ? 0 : t[ultimo + 1];
}

function simula(c) {
  const t0r = performance.now();
  const sim = new Cisterna(c.cfg);
  if (c.pre > 0) sim.correr(c.pre, { cloro: false });
  const t0 = sim.t;
  sim.dosificaCfg();
  const cf = sim.cFinal;
  const tApaga = t0 + c.bomba_min * 60, tFin = t0 + c.minutos * 60;
  const [px, py, pz] = c.cfg.pozo;
  const nombresSondas = Object.keys(sim.geo.sondas);
  const zFondo = sim.dz / 2;

  const m = { t: [], cov: [], cmin: [], cmax: [], sup: [], llave: [], orp: [], vf: [] };
  const serie = { t_min: [], cov: [], cmin: [], cmax: [], superficie: [], llave: [], orp: [], v_fondo: [] };
  let corto = 0, tCorto = 0, vfMax = 0, vfSuma = 0, vfN = 0, pasos = 0;
  let prox = t0, proxSerie = t0;

  const registra = () => {
    const tm = (sim.t - t0) / 60;
    const s = sim.stats();
    const son = sim.valoresSondas();
    const pl = sim.planta("vel", zFondo).data;
    let vf = 0;
    for (let q = 0; q < pl.length; q++) if (pl[q] > vf) vf = pl[q];
    const enc = sim.t < tApaga - 1e-9 || Math.abs(sim.t - tApaga) < 1e-9;
    if (enc) {
      vfMax = Math.max(vfMax, vf);
      if (sim.t - t0 >= 120) {
        vfSuma += vf;
        vfN++;
      }
    }
    m.t.push(tm);
    m.cov.push(s.cov);
    m.cmin.push(s.cmin);
    m.cmax.push(s.cmax);
    m.sup.push(son[nombresSondas[0]] / cf);
    m.llave.push(son[nombresSondas[1]] / cf);
    m.orp.push(son[nombresSondas[2]] / cf);
    m.vf.push(vf);
    if (sim.t >= proxSerie - 1e-9) {
      serie.t_min.push(r4(tm));
      serie.cov.push(r4(s.cov));
      serie.cmin.push(r4(s.cmin));
      serie.cmax.push(r4(s.cmax));
      serie.superficie.push(r4(son[nombresSondas[0]] / cf));
      serie.llave.push(r4(son[nombresSondas[1]] / cf));
      serie.orp.push(r4(son[nombresSondas[2]] / cf));
      serie.v_fondo.push(r4(vf));
      proxSerie += SERIE_S;
    }
  };

  for (;;) {
    if (sim.t >= prox - 1e-9) {
      registra();
      prox += MUESTRA_S;
    }
    if (sim.t >= tFin - 1e-9) break;
    const on = sim.t < tApaga - 1e-9;
    let dt = sim.dtFlujo();
    if (on) dt = Math.min(dt, tApaga - sim.t);
    dt = Math.min(dt, prox - sim.t, tFin - sim.t);
    sim.avanza(Math.max(dt, 1e-6), { bomba: on });
    pasos++;
    if (sim.t - t0 <= CORTO_S + 1e-9) {
      const r = sim.muestrea("c", px, py, pz) / cf;
      if (r > corto) {
        corto = r;
        tCorto = (sim.t - t0) / 60;
      }
    }
  }

  const fuera = (lo, hi) => m.cmin.map((v, q) => v < lo || m.cmax[q] > hi);
  const lejos = (a, tol) => a.map((v) => Math.abs(v - 1) > tol);
  const en = (min) => {
    let q = 0;
    while (q < m.t.length - 1 && m.t[q] < min - 1e-9) q++;
    return q;
  };
  const i45 = en(45);
  const eje = ejeChorro(c.cfg);
  const bomba = sim.bomba;
  // Distancia a la que la orilla del chorro toca el fondo antes de chocar con otra cosa, y la
  // velocidad del eje ahí (cota superior de lo que barre el fondo).
  const den = ABRE_CHORRO - eje.dir[2];
  const sToque = den > 0 ? eje.pos[2] / den : Infinity;
  const toca = sToque < eje.recorrido_m;
  const uToque = toca ? Math.min(bomba.u_ms, (DECAY_CHORRO * bomba.u_ms * sim.cfg.boquilla_mm) / 1000 / sToque) : null;
  return {
    id: c.id,
    geom: c.geom, pos: c.pos, z: c.z, az: c.az, el: c.el, dosis: c.dosis, nivel: c.nivel, dx: c.dx,
    pre: c.pre, bomba_min: c.bomba_min, minutos: c.minutos, daz: c.daz,
    azimut_abs: r3(((c.cfg.azimut % 360) + 360) % 360),
    pos_bomba: sim.geo.pos_bomba.map(r3),
    malla: [sim.nx, sim.ny, sim.nz],
    q_lh: r3(bomba.q_lh), u_ms: r3(bomba.u_ms), m_m4s2: bomba.m_m4s2,
    c_final_mg_l: r4(cf),
    t95: desde(m.t, m.cov.map((v) => v > 0.05)),
    t10: desde(m.t, fuera(0.9, 1.1)),
    t05: desde(m.t, fuera(0.95, 1.05)),
    cov45: r4(m.cov[i45]),
    cmin45: r4(m.cmin[i45]),
    cmax45: r4(m.cmax[i45]),
    cov90: r4(m.cov[m.cov.length - 1]),
    t_orp10: desde(m.t, lejos(m.orp, 0.1)),
    t_llave10: desde(m.t, lejos(m.llave, 0.1)),
    corto: r4(corto),
    t_corto_min: r3(tCorto),
    vf_max: r4(vfMax),
    vf_med: vfN ? r4(vfSuma / vfN) : null,
    recorrido_m: r3(eje.recorrido_m),
    choca_con: eje.choca_con,
    dist_rejilla_m: r3(eje.dist_rejilla_m),
    s_toque_fondo: toca ? r3(sToque) : null,
    u_toque_fondo: uToque == null ? null : r3(uToque),
    pasos,
    seg_computo: r3((performance.now() - t0r) / 1000),
    serie,
  };
}


// ---- etapas del plan ----

const costo = (r) => (r.t95 != null ? r.t95 : 90 + 100 * (r.cov90 - 0.05));
const clave = (r) => `${r.pos}|${r.z}|${r.az}|${r.el}`;
const esDoc = (r) => r.pos === DOC.pos && r.z === DOC.z && r.az === DOC.az && r.el === DOC.el;
const LIM_CORTO = 1.5;

// Apto: el eje del chorro pasa a más de 0.5 m de la rejilla, no manda un golpe de cloro a la
// casa y la bomba queda sumergida con la cisterna a 0.70 m.
const apto = (r) => r.dist_rejilla_m >= DIST_REJILLA && r.corto <= LIM_CORTO && r.z <= 0.5;

function principales(hechos) {
  const out = [];
  for (const r of hechos.values()) {
    if (r.geom === "base" && r.dosis === "llenado" && r.nivel === 1.2 && r.dx === 0.1 && r.pre === 0 &&
      r.bomba_min === 45 && !r.daz) out.push(r);
  }
  return out.sort((a, b) => costo(a) - costo(b));
}

function mejores(lista, n, filtro = () => true) {
  const vistos = new Set(), out = [];
  for (const r of lista) {
    if (!filtro(r) || vistos.has(clave(r))) continue;
    vistos.add(clave(r));
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

function candidatos(hechos) {
  const top = mejores(principales(hechos), 5, (r) => apto(r) && !esDoc(r));
  return [DOC, ...top.map((r) => ({ pos: r.pos, z: r.z, az: r.az, el: r.el }))];
}

const ETAPAS = [
  {
    nombre: "tamizado",
    texto: "mástil del doc a 0.50 m: 8 azimuts x 5 elevaciones",
    plan: () => AZIMUTS.flatMap((az) => ELEVACIONES.map((el) => caso({ pos: "mastil", z: 0.5, az, el }))),
  },
  {
    nombre: "alturas",
    texto: "las 6 mejores direcciones del tamizado y la del doc a 0.20, 0.30, 0.70 y 0.90 m",
    plan: (h) => {
      const tam = principales(h).filter((r) => r.pos === "mastil" && r.z === 0.5);
      const top = mejores(tam, 6, (r) => r.dist_rejilla_m >= DIST_REJILLA && r.corto <= LIM_CORTO && !esDoc(r));
      return [DOC, ...top].flatMap((r) => ALTURAS.filter((z) => z !== 0.5)
        .map((z) => caso({ pos: "mastil", z, az: r.az, el: r.el })));
    },
  },
  {
    nombre: "posiciones",
    texto: "boca, lejos y lateral: 8 azimuts con la mejor altura (<= 0.50 m) y elevación",
    plan: (h) => {
      const mast = principales(h).filter((r) => r.pos === "mastil" && apto(r) && !esDoc(r));
      if (!mast.length) return [];
      const { z, el } = mast[0];
      return ["boca", "lejos", "lateral"].flatMap((pos) => AZIMUTS.map((az) => caso({ pos, z, az, el })));
    },
  },
  {
    nombre: "posiciones2",
    texto: "las 3 mejores de otras posiciones con las elevaciones vecinas",
    plan: (h) => {
      const otras = principales(h).filter((r) => r.pos !== "mastil");
      return mejores(otras, 3, apto).flatMap((r) => {
        const i = ELEVACIONES.indexOf(r.el);
        return [ELEVACIONES[i - 1], ELEVACIONES[i + 1]].filter((el) => el !== undefined && el !== -60)
          .map((el) => caso({ pos: r.pos, z: r.z, az: r.az, el }));
      });
    },
  },
  {
    nombre: "confirmacion",
    texto: "5 mejores y el doc: malla 0.09 y 0.11, azimut +-5 grados",
    plan: (h) => candidatos(h).flatMap((k) => [
      caso({ ...k, dx: 0.09 }), caso({ ...k, dx: 0.11 }), caso({ ...k, daz: -5 }), caso({ ...k, daz: 5 }),
    ]),
  },
  {
    nombre: "operacion",
    texto: "dosis en el mástil, nivel 0.70, bomba sin apagar, bomba 5 min antes de la dosis",
    plan: (h) => candidatos(h).flatMap((k) => [
      caso({ ...k, dosis: "mastil" }), caso({ ...k, nivel: 0.7 }), caso({ ...k, nivel: 0.7, dosis: "mastil" }),
      caso({ ...k, bomba_min: 90 }), caso({ ...k, pre: 300 }),
    ]),
  },
  {
    nombre: "geometrias",
    texto: "plantas 2.90x2.90 y 4.00x2.10; pozo y llenado en otro lado; boca cerca de una esquina",
    plan: (h) => candidatos(h).flatMap((k) =>
      ["cuadrada", "alargada", "pozo_lado", "boca_esquina"].map((geom) => caso({ ...k, geom }))),
  },
];

// ---- archivos ----

function carga() {
  const hechos = new Map();
  if (!fs.existsSync(JSONL)) return hechos;
  for (const linea of fs.readFileSync(JSONL, "utf8").split("\n")) {
    if (!linea.trim()) continue;
    try {
      const r = JSON.parse(linea);
      hechos.set(r.id, r);
    } catch {
      // línea cortada por un reinicio: el caso se vuelve a correr
    }
  }
  return hechos;
}

const COLUMNAS = ["id", "geom", "pos", "z", "az", "el", "azimut_abs", "dosis", "nivel", "dx", "pre", "bomba_min",
  "daz", "pos_x", "pos_y", "pos_z", "t95", "t10", "t05", "cov45", "cmin45", "cmax45", "cov90", "t_orp10",
  "t_llave10", "corto", "t_corto_min", "vf_max", "vf_med", "recorrido_m", "choca_con", "dist_rejilla_m",
  "s_toque_fondo", "u_toque_fondo", "q_lh", "m_m4s2", "c_final_mg_l", "pasos", "seg_computo"];

function escribeCsv(hechos) {
  const filas = [COLUMNAS.join(",")];
  for (const r of [...hechos.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const x = { ...r, pos_x: r.pos_bomba[0], pos_y: r.pos_bomba[1], pos_z: r.pos_bomba[2] };
    filas.push(COLUMNAS.map((k) => (x[k] == null ? "" : x[k])).join(","));
  }
  fs.writeFileSync(CSV, filas.join("\n") + "\n");
}

// ---- hilos ----

function corre(casos, hilos, hechos, alTerminar) {
  return new Promise((resolve) => {
    const cola = casos.slice();
    if (!cola.length) return resolve();
    let vivos = 0, listos = 0;
    const t0 = performance.now();
    const siguiente = (w) => {
      const c = cola.shift();
      if (!c) {
        w.terminate();
        if (--vivos === 0) resolve();
        return;
      }
      w.postMessage({ ...c });
    };
    for (let q = 0; q < Math.min(hilos, cola.length); q++) {
      const w = new Worker(new URL(import.meta.url));
      vivos++;
      w.on("message", (msg) => {
        listos++;
        if (msg.ok) {
          hechos.set(msg.r.id, msg.r);
          fs.appendFileSync(JSONL, JSON.stringify(msg.r) + "\n");
          alTerminar(hechos);
          const r = msg.r;
          const falta = ((performance.now() - t0) / listos) * (casos.length - listos) / 60000;
          console.log(`  [${listos}/${casos.length}] ${r.id}: t95 ${r.t95 ?? ">90"} t10 ${r.t10 ?? ">90"} ` +
            `cov45 ${r.cov45} corto ${r.corto} vf ${r.vf_med} (${r.seg_computo.toFixed(0)} s, faltan ~${falta.toFixed(0)} min)`);
        } else {
          console.error(`  falló ${msg.id}: ${msg.error}`);
        }
        siguiente(w);
      });
      w.on("error", (e) => {
        console.error("  error en un hilo:", e);
        if (--vivos === 0) resolve();
      });
      siguiente(w);
    }
  });
}

if (!isMainThread) {
  parentPort.on("message", (c) => {
    try {
      parentPort.postMessage({ ok: true, r: simula(c) });
    } catch (e) {
      parentPort.postMessage({ ok: false, id: c.id, error: String((e && e.stack) || e) });
    }
  });
}

// ---- reporte ----

const media = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const desv = (a) => (a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - media(a)) ** 2, 0) / (a.length - 1)) : 0);
const fmtT = (t) => (t == null ? ">90" : t.toFixed(1));
const fmtN = (x, d = 2) => (x == null ? "" : Number(x).toFixed(d));
const nombreCfg = (k) => `${k.pos} z ${k.z.toFixed(2)} az ${k.az >= 0 ? "+" : ""}${k.az} el ${k.el >= 0 ? "+" : ""}${k.el}`;

function busca(hechos, k, op = {}) {
  return hechos.get(caso({ pos: k.pos, z: k.z, az: k.az, el: k.el, ...op }).id);
}

function reporte(hechos) {
  const out = [];
  const L = (s = "") => out.push(s);
  const prin = principales(hechos);
  const resumen = { generado: new Date().toISOString(), casos: hechos.size, candidatos: [] };

  L("## Tamizado: mástil del doc a 0.50 m, dosis por el llenado, nivel 1.20 m");
  L();
  L("t95 en min (CoV < 0.05 de ahí en adelante; >90 = no llega). Entre paréntesis, pico en la rejilla del pozo en los primeros 10 min / meta.");
  L();
  L("| azimut rel. (abs.) | " + ELEVACIONES.map((e) => `el ${e}`).join(" | ") + " |");
  L("|---|" + ELEVACIONES.map(() => "---").join("|") + "|");
  for (const az of AZIMUTS) {
    const fila = ELEVACIONES.map((el) => {
      const r = busca(hechos, { pos: "mastil", z: 0.5, az, el });
      return r ? `${fmtT(r.t95)} (${fmtN(r.corto)})` : "";
    });
    const r0 = busca(hechos, { pos: "mastil", z: 0.5, az, el: 0 });
    L(`| ${az} (${r0 ? r0.azimut_abs.toFixed(0) : "?"}) | ${fila.join(" | ")} |`);
  }
  L();

  L("## Mejores casos de una sola corrida (dosis por el llenado, nivel 1.20 m)");
  L();
  L("| config | t95 | t10 | CoV 45 | corto | v fondo media | v fondo máx | recorrido del eje | dist. eje a rejilla | apto |");
  L("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of prin.slice(0, 25)) {
    L(`| ${nombreCfg(r)}${esDoc(r) ? " (doc)" : ""} | ${fmtT(r.t95)} | ${fmtT(r.t10)} | ${fmtN(r.cov45, 3)} | ` +
      `${fmtN(r.corto)} | ${fmtN(r.vf_med, 3)} | ${fmtN(r.vf_max, 3)} | ${fmtN(r.recorrido_m)} m (${r.choca_con}) | ` +
      `${fmtN(r.dist_rejilla_m)} m | ${apto(r) ? "sí" : "no"} |`);
  }
  const doc = prin.find(esDoc);
  if (doc && !prin.slice(0, 25).includes(doc)) {
    L(`| ${nombreCfg(doc)} (doc, lugar ${prin.indexOf(doc) + 1} de ${prin.length}) | ${fmtT(doc.t95)} | ${fmtT(doc.t10)} | ` +
      `${fmtN(doc.cov45, 3)} | ${fmtN(doc.corto)} | ${fmtN(doc.vf_med, 3)} | ${fmtN(doc.vf_max, 3)} | ` +
      `${fmtN(doc.recorrido_m)} m (${doc.choca_con}) | ${fmtN(doc.dist_rejilla_m)} m | ${apto(doc) ? "sí" : "no"} |`);
  }
  L();

  L("## Alturas");
  L();
  const dirs = [...new Set(prin.filter((r) => r.pos === "mastil" && r.z !== 0.5).map((r) => `${r.az}|${r.el}`))];
  L("| dirección | " + ALTURAS.map((z) => `z ${z.toFixed(2)}`).join(" | ") + " |");
  L("|---|" + ALTURAS.map(() => "---").join("|") + "|");
  for (const d of dirs) {
    const [az, el] = d.split("|").map(Number);
    const fila = ALTURAS.map((z) => {
      const r = busca(hechos, { pos: "mastil", z, az, el });
      return r ? `${fmtT(r.t95)} / ${fmtN(r.vf_med, 3)}` : "";
    });
    L(`| az ${az} el ${el} | ${fila.join(" | ")} |`);
  }
  L();
  L("Cada celda: t95 en min / rapidez media en la primera capa sobre el fondo (m/s).");
  L();

  L("## Otras posiciones en planta");
  L();
  for (const pos of ["boca", "lejos", "lateral"]) {
    const rs = prin.filter((r) => r.pos === pos).sort((a, b) => a.az - b.az || a.el - b.el);
    if (!rs.length) continue;
    L(`${pos} (bomba en ${rs[0].pos_bomba.map((x) => x.toFixed(2)).join(", ")}): ` +
      rs.map((r) => `az ${r.az} el ${r.el}: ${fmtT(r.t95)}`).join("; "));
    L();
  }

  const cands = candidatos(hechos);
  L("## Confirmación: dispersión por malla y por puntería (+-5 grados)");
  L();
  L("| config | t95 base | t95 media ± desv (n) | t95 mín a máx | t10 media ± desv | CoV 45 media | corto máx | v fondo media |");
  L("|---|---|---|---|---|---|---|---|");
  for (const k of cands) {
    const base = busca(hechos, k);
    const pert = [base, busca(hechos, k, { dx: 0.09 }), busca(hechos, k, { dx: 0.11 }),
      busca(hechos, k, { daz: -5 }), busca(hechos, k, { daz: 5 })].filter(Boolean);
    if (!base) continue;
    const t95 = pert.map((r) => r.t95 ?? 90 + 100 * (r.cov90 - 0.05));
    const t10 = pert.map((r) => r.t10 ?? 90);
    const nunca = pert.filter((r) => r.t95 == null).length;
    const ent = {
      config: k, doc: esDoc(k), n: pert.length, t95_base: base.t95, t95_media: media(t95), t95_desv: desv(t95),
      t95_min: Math.min(...t95), t95_max: Math.max(...t95), t95_nunca: nunca, t10_media: media(t10), t10_desv: desv(t10),
      cov45_media: media(pert.map((r) => r.cov45)), corto_max: Math.max(...pert.map((r) => r.corto)),
      vf_med_media: media(pert.map((r) => r.vf_med)), ids: pert.map((r) => r.id),
    };
    resumen.candidatos.push(ent);
    L(`| ${nombreCfg(k)}${ent.doc ? " (doc)" : ""} | ${fmtT(base.t95)} | ${ent.t95_media.toFixed(1)} ± ${ent.t95_desv.toFixed(1)} (${ent.n}${nunca ? `, ${nunca} no llegan` : ""}) | ` +
      `${ent.t95_min.toFixed(1)} a ${ent.t95_max.toFixed(1)} | ${ent.t10_media.toFixed(1)} ± ${ent.t10_desv.toFixed(1)} | ` +
      `${ent.cov45_media.toFixed(3)} | ${ent.corto_max.toFixed(2)} | ${ent.vf_med_media.toFixed(3)} |`);
  }
  L();
  L("Cuando un caso no llega a CoV < 0.05 en 90 min, para la media cuenta como 90 + 100 (CoV a 90 min - 0.05).");
  L();

  L("## Operación: dónde cae la dosis, nivel, bomba sin apagar, bomba antes de la dosis");
  L();
  const ops = [["llenado 1.20", {}], ["mástil 1.20", { dosis: "mastil" }], ["llenado 0.70", { nivel: 0.7 }],
    ["mástil 0.70", { nivel: 0.7, dosis: "mastil" }], ["sin apagar", { bomba_min: 90 }], ["5 min antes", { pre: 300 }]];
  L("| config | " + ops.map(([n]) => n).join(" | ") + " |");
  L("|---|" + ops.map(() => "---").join("|") + "|");
  for (const k of cands) {
    const fila = ops.map(([, op]) => {
      const r = busca(hechos, k, op);
      return r ? `${fmtT(r.t95)} / ${fmtT(r.t10)}` : "";
    });
    L(`| ${nombreCfg(k)}${esDoc(k) ? " (doc)" : ""} | ${fila.join(" | ")} |`);
  }
  L();
  L("Cada celda: t95 / t10 en min.");
  L();

  L("## Otras geometrías (misma regla de colocación)");
  L();
  const geoms = ["base", "cuadrada", "alargada", "pozo_lado", "boca_esquina"];
  L("| config | " + geoms.join(" | ") + " |");
  L("|---|" + geoms.map(() => "---").join("|") + "|");
  for (const k of cands) {
    const fila = geoms.map((geom) => {
      const r = busca(hechos, k, { geom });
      return r ? `${fmtT(r.t95)} (${fmtN(r.corto)})` : "";
    });
    L(`| ${nombreCfg(k)}${esDoc(k) ? " (doc)" : ""} | ${fila.join(" | ")} |`);
  }
  L();
  L("Cada celda: t95 en min (pico en la rejilla / meta).");
  return { texto: out.join("\n"), resumen };
}

// ---- principal ----

async function main() {
  const args = process.argv.slice(2);
  const val = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : d;
  };
  const hilos = Math.min(MAX_HILOS, Math.max(1, Number(val("--hilos", MAX_HILOS))));
  const elegidas = val("--etapas", ETAPAS.map((e) => e.nombre).join(",")).split(",");
  fs.mkdirSync(DIR, { recursive: true });
  const hechos = carga();

  if (args.includes("--reporte")) {
    const { texto, resumen } = reporte(hechos);
    console.log(texto);
    fs.writeFileSync(RESUMEN, JSON.stringify(resumen, null, 1) + "\n");
    return;
  }

  console.log(`${hechos.size} casos ya hechos en ${path.relative(process.cwd(), JSONL)}; ${hilos} hilos`);
  for (const etapa of ETAPAS) {
    if (!elegidas.includes(etapa.nombre)) continue;
    const vistos = new Set();
    const plan = etapa.plan(hechos).filter((c) => !vistos.has(c.id) && vistos.add(c.id));
    for (const c of plan.filter((c) => c.infactible)) console.log(`  se omite ${c.id}: ${c.infactible}`);
    const pendientes = plan.filter((c) => !c.infactible && !hechos.has(c.id));
    console.log(`Etapa ${etapa.nombre} (${etapa.texto}): ${plan.length} casos, faltan ${pendientes.length}`);
    if (args.includes("--plan")) {
      for (const c of pendientes) console.log(`  ${c.id}`);
      continue;
    }
    await corre(pendientes, hilos, hechos, escribeCsv);
  }
  escribeCsv(hechos);
}

export { simula, caso, ejeChorro, posicion };

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
