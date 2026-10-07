// Barrido de la propuesta de Erick (7 oct) en su cisterna redonda: tubo vertical parado en el piso
// bajo la boca, bomba con el cuerpo vertical (toma arriba) a ~50 cm y el chorro horizontal; sonda ORP
// a 20 cm de lado. El flotador y la boca B quedan junto a la bomba de pozo, así que el cloro cae casi
// en su succión.
//
//   node web/propuesta.mjs              corre lo que falte (3 hilos) y escribe el reporte
//   node web/propuesta.mjs --reporte    solo el reporte
//
// Resultados en web/resultados_propuesta/casos.jsonl; al relanzar se salta lo ya hecho.

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cisterna, validar } from "./solver.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(AQUI, "resultados_propuesta");
const JSONL = path.join(DIR, "casos.jsonl");
const REPORTE = path.join(DIR, "reporte.md");
const HILOS = 3;
const MUESTRA_S = 10;
const CORTO_S = 600;

// Los DEFAULTS de solver.js del 7 oct, fijos aquí para que el barrido no cambie si cambian los
// defaults. Supuestos: diámetro (10 m3 a 1.20 m), boca al centro, pozo a 30 cm de la boca.
const BASE = { forma: "redonda", diametro: 3.26, nivel: 1.20, boca: [1.63, 1.63], pozo: [1.33, 1.63, 0.45], dx: 0.10,
  angulo_tubo: 90, z_bomba: 0.50, z_orp: 0.20, azimut: 0, elevacion: 0 };
// Erick dijo que el llenado queda junto a la bomba de pozo, no de qué lado: a un lado (+y, el default)
// o entre el pozo y la pared. Con este último todo es simétrico respecto a y = 1.63.
const LLENADOS = { lado: [1.33, 1.88, 1.10], pared: [1.08, 1.63, 1.10] };
const MASTIL = [1.63, 1.63]; // tubo vertical bajo la boca
// Grados en planta desde +x: 0 = hacia fuera lejos del pozo, ±90 = de lado (perpendicular a la línea
// boca-pozo), 180 = hacia el pozo. Desde el centro todo chorro es radial respecto a la pared.
const AZIMUTS = [0, 45, -45, 90, -90, 135, -135, 180];
const ELEVACIONES = [-15, 0, 15];
// Referencia tangencial: bomba a 30 cm de la pared del lado opuesto al pozo, chorro horizontal
// tangente (giro antihorario visto desde arriba). La distancia a la pared es supuesta.
const TANGENCIAL = { pos: [2.96, 1.63], az: 90 };

const rad = (g) => (g * Math.PI) / 180;
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);

export function caso(p) {
  const c = { z: 0.5, el: 0, consumo: 0, bomba_min: 45, minutos: 90, ...p };
  const cfg = { ...BASE, llenado: LLENADOS[c.llenado], lugar_dosis: "llenado", consumo_lpm: c.consumo };
  if (c.tipo === "propuesta") {
    // la bomba va pegada al tubo, ~6 cm del eje, del lado hacia donde escupe
    cfg.pos_bomba = [MASTIL[0] + 0.06 * Math.cos(rad(c.az)), MASTIL[1] + 0.06 * Math.sin(rad(c.az)), c.z];
    cfg.azimut = c.az;
    cfg.elevacion = c.el;
  } else if (c.tipo === "doc") {
    // mástil diagonal a 60 grados desde la boca hacia el lado opuesto al pozo, chorro a lo largo del tubo
    Object.assign(cfg, { angulo_tubo: 60, z_bomba: c.z, azimut: null, elevacion: null });
  } else if (c.tipo === "tangencial") {
    cfg.pos_bomba = [...TANGENCIAL.pos, c.z];
    cfg.azimut = TANGENCIAL.az;
    cfg.elevacion = 0;
  }
  if (c.sin_bomba) c.bomba_min = 0;
  c.id = [c.tipo, c.llenado, `z${Math.round(c.z * 100)}`, c.tipo === "propuesta" ? `a${c.az}_e${c.el}` : "",
    c.consumo ? `q${c.consumo}` : "", c.sin_bomba ? "sinbomba" : ""].filter(Boolean).join("_");
  c.cfg = cfg;
  validar(cfg);
  return c;
}

function desde(t, falla) {
  if (!falla.length || falla[falla.length - 1]) return null;
  let ultimo = -1;
  for (let q = 0; q < falla.length; q++) if (falla[q]) ultimo = q;
  return ultimo < 0 ? 0 : t[ultimo + 1];
}

// Promedios en el agua: velocidad tangencial (+ antihoraria, vista desde arriba) y rapidez, m/s.
function giro(sim) {
  const { nx, ny, nz, dx, dy, u, v, w, agua } = sim;
  const [cx, cy] = sim.geo.centro;
  let st = 0, sr = 0, n = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!agua[i * ny + j]) continue;
      const rx = (i + 0.5) * dx - cx, ry = (j + 0.5) * dy - cy, r = Math.hypot(rx, ry);
      for (let k = 0; k < nz; k++) {
        const m = (i * ny + j) * nz + k, iv = (i * (ny + 1) + j) * nz + k, iw = (i * ny + j) * (nz + 1) + k;
        const a = 0.5 * (u[m] + u[m + ny * nz]), b = 0.5 * (v[iv] + v[iv + nz]), e = 0.5 * (w[iw] + w[iw + 1]);
        if (r > 0) st += (rx * b - ry * a) / r;
        sr += Math.hypot(a, b, e);
        n++;
      }
    }
  }
  return [st / n, sr / n];
}

export function simula(c) {
  const t0r = performance.now();
  const sim = new Cisterna(c.cfg);
  sim.dosificaCfg();
  const masa = sim.stats().masa_mg;
  const cf = sim.cFinal;
  const tApaga = c.bomba_min * 60, tFin = c.minutos * 60;
  const [px, py, pz] = c.cfg.pozo;
  const zFondo = sim.dz / 2;
  const t = [], cov = [], cmin = [], cmax = [];
  let corto = 0, vfSuma = 0, giroSuma = 0, rapSuma = 0, nOn = 0, prox = 0, sale10 = null, sale45 = null;
  for (;;) {
    if (sim.t >= prox - 1e-9) {
      const s = sim.stats();
      t.push(sim.t / 60);
      cov.push(s.cov);
      cmin.push(s.cmin);
      cmax.push(s.cmax);
      if (sim.t < tApaga && sim.t >= 120) {
        const pl = sim.planta("vel", zFondo).data;
        let vf = 0;
        for (let q = 0; q < pl.length; q++) vf = Math.max(vf, pl[q]);
        const [gt, gr] = giro(sim);
        vfSuma += vf;
        giroSuma += gt;
        rapSuma += gr;
        nOn++;
      }
      if (sale10 == null && sim.t >= 600 - 1e-9) sale10 = sim.salida_mg / masa;
      if (sale45 == null && sim.t >= 2700 - 1e-9) sale45 = sim.salida_mg / masa;
      prox += MUESTRA_S;
    }
    if (sim.t >= tFin - 1e-9) break;
    const on = sim.t < tApaga - 1e-9;
    let dt = Math.min(sim.dtFlujo(), prox - sim.t, tFin - sim.t);
    if (on) dt = Math.min(dt, tApaga - sim.t);
    sim.avanza(Math.max(dt, 1e-6), { bomba: on });
    if (sim.t <= CORTO_S + 1e-9) corto = Math.max(corto, sim.muestrea("c", px, py, pz) / cf);
  }
  const i45 = t.findIndex((x) => x >= 45 - 1e-9);
  return {
    id: c.id, tipo: c.tipo, llenado: c.llenado, z: c.z, az: c.az ?? null, el: c.el, consumo: c.consumo,
    sin_bomba: !!c.sin_bomba,
    pos_bomba: sim.geo.pos_bomba.map(r3),
    t95: desde(t, cov.map((v) => v > 0.05)),
    t10: desde(t, cmin.map((v, q) => v < 0.9 || cmax[q] > 1.1)),
    cov45: r3(cov[i45]),
    corto: r3(corto),
    vf_med: nOn ? r3(vfSuma / nOn) : null,
    giro: nOn ? Math.round((giroSuma / nOn) * 1e4) / 1e4 : null,
    rapidez: nOn ? Math.round((rapSuma / nOn) * 1e4) / 1e4 : null,
    sale10: sale10 == null ? null : r3(sale10),
    sale45: sale45 == null ? null : r3(sale45),
    seg: r3((performance.now() - t0r) / 1000),
  };
}

// ---- plan por etapas (cada etapa elige con lo ya corrido) ----

const costo = (r) => (r.t95 ?? 90 + 100 * (r.cov45 ?? 1)) + 20 * Math.max(0, r.corto - 1.5);

// Con el llenado entre el pozo y la pared, az y -az son el mismo caso en espejo: cuenta una vez.
function mejores(hechos, llenado, n) {
  const vistos = new Set();
  return [...hechos.values()]
    .filter((r) => r.tipo === "propuesta" && r.llenado === llenado && r.z === 0.5 && !r.consumo)
    .sort((a, b) => costo(a) - costo(b) || Math.abs(a.az) - Math.abs(b.az) || b.az - a.az)
    .filter((r) => {
      const k = llenado === "pared" ? `${Math.abs(r.az)}|${r.el}` : `${r.az}|${r.el}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    })
    .slice(0, n);
}

function plan(hechos) {
  const etapas = [];
  const tamizado = [];
  for (const llenado of Object.keys(LLENADOS)) {
    for (const az of AZIMUTS) for (const el of ELEVACIONES) tamizado.push(caso({ tipo: "propuesta", llenado, az, el }));
    tamizado.push(caso({ tipo: "doc", llenado }), caso({ tipo: "tangencial", llenado }));
  }
  etapas.push(["tamizado (8 direcciones x 3 inclinaciones a 50 cm, y las referencias)", tamizado]);
  const listo = tamizado.every((c) => hechos.has(c.id));
  if (!listo) return etapas;
  const alturas = [], consumo = [];
  for (const llenado of Object.keys(LLENADOS)) {
    const top = mejores(hechos, llenado, 2);
    for (const r of top) for (const z of [0.35, 0.65, 0.8]) alturas.push(caso({ tipo: "propuesta", llenado, az: r.az, el: r.el, z }));
    const m = top[0];
    for (const q of [15]) {
      consumo.push(caso({ tipo: "propuesta", llenado, az: m.az, el: m.el, consumo: q }));
      consumo.push(caso({ tipo: "doc", llenado, consumo: q }));
      consumo.push(caso({ tipo: "tangencial", llenado, consumo: q }));
      consumo.push(caso({ tipo: "propuesta", llenado, az: m.az, el: m.el, consumo: q, sin_bomba: true }));
    }
  }
  etapas.push(["alturas de las 2 mejores direcciones por llenado", alturas]);
  etapas.push(["con la casa usando 15 L/min desde la dosis", consumo]);
  return etapas;
}

// ---- hilos ----

function corre(casos, hechos) {
  return new Promise((resolve) => {
    const cola = casos.filter((c) => !hechos.has(c.id));
    if (!cola.length) return resolve();
    let vivos = 0, listos = 0;
    const total = cola.length;
    const sig = (w) => {
      const c = cola.shift();
      if (!c) {
        w.terminate();
        if (--vivos === 0) resolve();
        return;
      }
      w.postMessage(c);
    };
    for (let q = 0; q < Math.min(HILOS, cola.length); q++) {
      const w = new Worker(new URL(import.meta.url));
      vivos++;
      w.on("message", (msg) => {
        listos++;
        if (msg.ok) {
          hechos.set(msg.r.id, msg.r);
          fs.appendFileSync(JSONL, JSON.stringify(msg.r) + "\n");
          const r = msg.r;
          console.log(`  [${listos}/${total}] ${r.id}: t95 ${r.t95 ?? ">90"} corto ${r.corto} sale10 ${r.sale10 ?? "-"} (${r.seg.toFixed(0)} s)`);
        } else {
          console.error(`  falló ${msg.id}: ${msg.error}`);
        }
        sig(w);
      });
      w.on("error", (e) => {
        console.error("  error en un hilo:", e);
        if (--vivos === 0) resolve();
      });
      sig(w);
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

const fmt = (x) => (x == null ? ">90" : x.toFixed(1));
const cm = (x) => (x == null ? "-" : (100 * x).toFixed(1));

function reporte(hechos) {
  const L = [];
  const todos = [...hechos.values()];
  const nombres = {
    lado: `a un lado de la bomba de pozo (${LLENADOS.lado.slice(0, 2).join(", ")})`,
    pared: `entre la bomba de pozo y la pared (${LLENADOS.pared.slice(0, 2).join(", ")})`,
  };
  for (const llenado of Object.keys(LLENADOS)) {
    L.push(`## Llenado ${nombres[llenado]}`, "");
    L.push("t95 en min (CoV < 5 % de ahí en adelante). Entre paréntesis, pico de cloro en la rejilla del pozo en los primeros 10 min / meta.", "");
    L.push(`| azimut | ${ELEVACIONES.map((e) => `el ${e}`).join(" | ")} |`, `|---|${ELEVACIONES.map(() => "---").join("|")}|`);
    for (const az of AZIMUTS) {
      const celdas = ELEVACIONES.map((el) => {
        const r = hechos.get(caso({ tipo: "propuesta", llenado, az, el }).id);
        return r ? `${fmt(r.t95)} (${r.corto.toFixed(2)})` : "";
      });
      L.push(`| ${az} | ${celdas.join(" | ")} |`);
    }
    L.push("", "Detalle (t95 / ±10 % en min, pico, rapidez máxima en el fondo, giro medio y rapidez media del agua en cm/s):", "",
      "| caso | t95 | ±10 % | pico | fondo m/s | giro cm/s | rapidez cm/s |", "|---|---|---|---|---|---|---|");
    const fila = (nombre, r) => L.push(`| ${nombre} | ${fmt(r.t95)} | ${fmt(r.t10)} | ${r.corto.toFixed(2)} | ${r.vf_med} | ${cm(r.giro)} | ${cm(r.rapidez)} |`);
    const props = todos.filter((r) => r.tipo === "propuesta" && r.llenado === llenado && r.z === 0.5 && !r.consumo)
      .sort((a, b) => costo(a) - costo(b));
    for (const r of props.slice(0, 4)) fila(`propuesta az ${r.az} el ${r.el}`, r);
    const ref = (tipo) => hechos.get(caso({ tipo, llenado }).id);
    const d = ref("doc"), ta = ref("tangencial");
    if (d) fila("diseño del doc (mástil a 60°, chorro -60°)", d);
    if (ta) fila("tangencial junto a la pared", ta);
    const alt = todos.filter((r) => r.tipo === "propuesta" && r.llenado === llenado && !r.consumo && r.z !== 0.5);
    if (alt.length) {
      L.push("", "Alturas (t95 / ±10 %):", "");
      const dirs = [...new Set(alt.map((r) => `${r.az}|${r.el}`))];
      for (const k of dirs) {
        const [az, el] = k.split("|").map(Number);
        const celdas = [0.35, 0.5, 0.65, 0.8].map((z) => {
          const r = hechos.get(caso({ tipo: "propuesta", llenado, az, el, z }).id);
          return r ? `z ${z}: ${fmt(r.t95)} / ${fmt(r.t10)}` : "";
        });
        L.push(`- az ${az} el ${el}: ${celdas.filter(Boolean).join("; ")}`);
      }
    }
    const con = todos.filter((r) => r.llenado === llenado && r.consumo);
    if (con.length) {
      L.push("", "Con la casa usando 15 L/min desde que se echa el cloro:", "",
        "| caso | t95 | cloro que se fue a la casa en 10 min | en 45 min |", "|---|---|---|---|");
      for (const r of con) {
        const nombre = r.tipo === "doc" ? "diseño del doc" : r.tipo === "tangencial" ? "tangencial junto a la pared"
          : r.sin_bomba ? "sin bomba de mezcla" : `propuesta az ${r.az} el ${r.el}`;
        L.push(`| ${nombre} | ${fmt(r.t95)} | ${(100 * r.sale10).toFixed(1)} % | ${(100 * r.sale45).toFixed(1)} % |`);
      }
    }
    L.push("");
  }
  fs.writeFileSync(REPORTE, L.join("\n"));
  console.log(L.join("\n"));
}

function carga() {
  const hechos = new Map();
  if (fs.existsSync(JSONL)) {
    for (const linea of fs.readFileSync(JSONL, "utf8").split("\n")) if (linea.trim()) {
      const r = JSON.parse(linea);
      hechos.set(r.id, r);
    }
  }
  return hechos;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const hechos = carga();
  if (!process.argv.includes("--reporte")) {
    for (let vuelta = 0; vuelta < 3; vuelta++) {
      for (const [nombre, casos] of plan(hechos)) {
        const faltan = casos.filter((c) => !hechos.has(c.id)).length;
        console.log(`Etapa ${nombre}: ${casos.length} casos, faltan ${faltan}`);
        await corre(casos, hechos);
      }
    }
  }
  reporte(hechos);
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
