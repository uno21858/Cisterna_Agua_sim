// Barrido de la propuesta de Erick (7 oct): tubo vertical parado en el piso bajo la boca, bomba con
// el cuerpo vertical (toma arriba) a ~50 cm y el chorro horizontal; sonda ORP a 20 cm de lado. El
// flotador y la boca B quedan junto a la bomba de pozo, así que el cloro cae casi en su succión.
//
//   node web/propuesta.mjs              corre lo que falte (4 hilos) y escribe el reporte
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
const HILOS = 4;
const MUESTRA_S = 10;
const CORTO_S = 600;

// Planta, boca y pozo son los mismos supuestos de siempre. Lo nuevo (dicho por Erick): el llenado
// queda junto a la bomba de pozo; no sabemos de qué lado, así que se prueban dos.
// Planta rectangular y mástil del doc fijos (los defaults ya son la cisterna redonda).
const BASE = { forma: "rectangular", largo: 3.40, ancho: 2.45, nivel: 1.20, boca: [1.20, 1.00], pozo: [0.90, 1.00, 0.45],
  dx: 0.10, angulo_tubo: 60, azimut: null, elevacion: null };
const LLENADOS = { lado: [0.90, 1.25, 1.10], pared: [0.65, 1.00, 1.10] };
const MASTIL = [1.20, 1.00]; // tubo vertical bajo la boca, a 30 cm de la bomba de pozo
const AZIMUTS = [0, 30, -30, 60, -60, 90, -90, 180]; // grados en planta desde +x (0 = a lo largo, lejos del pozo)
const ELEVACIONES = [-15, 0, 15];

const rad = (g) => (g * Math.PI) / 180;
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);

function caso(p) {
  const c = { z: 0.5, el: 0, consumo: 0, bomba_min: 45, minutos: 90, ...p };
  const cfg = { ...BASE, llenado: LLENADOS[c.llenado], lugar_dosis: "llenado", consumo_lpm: c.consumo };
  if (c.tipo === "propuesta") {
    // la bomba va pegada al tubo, ~6 cm del eje, del lado hacia donde escupe
    cfg.angulo_tubo = 90;
    cfg.pos_bomba = [MASTIL[0] + 0.06 * Math.cos(rad(c.az)), MASTIL[1] + 0.06 * Math.sin(rad(c.az)), c.z];
    cfg.azimut = c.az;
    cfg.elevacion = c.el;
  } else if (c.tipo === "doc") {
    // mástil diagonal a 60 grados con el chorro a lo largo del tubo (diseño del documento)
  } else if (c.tipo === "lateral") {
    // la mejor del barrido anterior: a 1 m de la boca, horizontal a lo largo
    cfg.pos_bomba = [0.65, 1.835, c.z];
    cfg.azimut = 348.4;
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

function simula(c) {
  const t0r = performance.now();
  const sim = new Cisterna(c.cfg);
  sim.dosificaCfg();
  const masa = sim.stats().masa_mg;
  const cf = sim.cFinal;
  const tApaga = c.bomba_min * 60, tFin = c.minutos * 60;
  const [px, py, pz] = c.cfg.pozo;
  const zFondo = sim.dz / 2;
  const t = [], cov = [], cmin = [], cmax = [];
  let corto = 0, vfSuma = 0, vfN = 0, prox = 0, sale10 = null, sale45 = null;
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
        vfSuma += vf;
        vfN++;
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
    vf_med: vfN ? r3(vfSuma / vfN) : null,
    sale10: sale10 == null ? null : r3(sale10),
    sale45: sale45 == null ? null : r3(sale45),
    seg: r3((performance.now() - t0r) / 1000),
  };
}

// ---- plan por etapas (cada etapa elige con lo ya corrido) ----

const costo = (r) => (r.t95 ?? 90 + 100 * (r.cov45 ?? 1)) + 20 * Math.max(0, r.corto - 1.5);

function mejores(hechos, llenado, n) {
  return [...hechos.values()]
    .filter((r) => r.tipo === "propuesta" && r.llenado === llenado && r.z === 0.5 && !r.consumo)
    .sort((a, b) => costo(a) - costo(b)).slice(0, n);
}

function plan(hechos) {
  const etapas = [];
  const tamizado = [];
  for (const llenado of Object.keys(LLENADOS)) {
    for (const az of AZIMUTS) for (const el of ELEVACIONES) tamizado.push(caso({ tipo: "propuesta", llenado, az, el }));
    tamizado.push(caso({ tipo: "doc", llenado }), caso({ tipo: "lateral", llenado }));
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

function reporte(hechos) {
  const L = [];
  const todos = [...hechos.values()];
  for (const llenado of Object.keys(LLENADOS)) {
    L.push(`## Llenado ${llenado === "lado" ? "al lado de la bomba de pozo (0.90, 1.25)" : "entre la bomba de pozo y la pared (0.65, 1.00)"}`, "");
    L.push("t95 en min (CoV < 5 % de ahí en adelante). Entre paréntesis, pico de cloro en la rejilla del pozo en los primeros 10 min / meta.", "");
    L.push(`| azimut | ${ELEVACIONES.map((e) => `el ${e}`).join(" | ")} |`, `|---|${ELEVACIONES.map(() => "---").join("|")}|`);
    for (const az of AZIMUTS) {
      const celdas = ELEVACIONES.map((el) => {
        const r = hechos.get(caso({ tipo: "propuesta", llenado, az, el }).id);
        return r ? `${fmt(r.t95)} (${r.corto.toFixed(2)})` : "";
      });
      L.push(`| ${az} | ${celdas.join(" | ")} |`);
    }
    const ref = (tipo) => hechos.get(caso({ tipo, llenado }).id);
    const d = ref("doc"), la = ref("lateral");
    L.push("");
    if (d) L.push(`Diseño del doc (mástil a 60°, chorro -60°): t95 ${fmt(d.t95)}, ±10 % ${fmt(d.t10)}, pico ${d.corto}, fondo ${d.vf_med} m/s.`);
    if (la) L.push(`Lateral del barrido anterior (a 1 m de la boca): t95 ${fmt(la.t95)}, ±10 % ${fmt(la.t10)}, pico ${la.corto}, fondo ${la.vf_med} m/s.`);
    const alt = todos.filter((r) => r.tipo === "propuesta" && r.llenado === llenado && !r.consumo && r.z !== 0.5);
    if (alt.length) {
      L.push("", "Alturas (t95 / ±10 %):", "");
      const dirs = [...new Set(alt.map((r) => `${r.az}|${r.el}`))];
      for (const k of dirs) {
        const [az, el] = k.split("|").map(Number);
        const fila = [0.35, 0.5, 0.65, 0.8].map((z) => {
          const r = hechos.get(caso({ tipo: "propuesta", llenado, az, el, z }).id);
          return r ? `z ${z}: ${fmt(r.t95)} / ${fmt(r.t10)}` : "";
        });
        L.push(`- az ${az} el ${el}: ${fila.filter(Boolean).join("; ")}`);
      }
    }
    const con = todos.filter((r) => r.llenado === llenado && r.consumo);
    if (con.length) {
      L.push("", "Con la casa usando 15 L/min desde que se echa el cloro:", "",
        "| caso | t95 | cloro que se fue a la casa en 10 min | en 45 min |", "|---|---|---|---|");
      for (const r of con) {
        const nombre = r.tipo === "doc" ? "diseño del doc" : r.sin_bomba ? "sin bomba de mezcla" : `propuesta az ${r.az} el ${r.el}`;
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
