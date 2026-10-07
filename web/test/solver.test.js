// Pruebas propias del motor JS: invariantes del esquema y extensión de consumo.
import assert from "node:assert/strict";
import test from "node:test";

import {
  Cisterna, DEFAULTS, G, configura, geometria, matrizDct, puntoOperacion, redondeaPy, tiempoMezclaS, validar,
} from "../solver.js";

// Planta rectangular con el mástil diagonal del doc (los defaults de antes de la cisterna redonda).
const RECT = Object.freeze({
  forma: "rectangular", largo: 3.40, ancho: 2.45, boca: [1.20, 1.00], angulo_tubo: 60, azimut: null, elevacion: null,
  pozo: [0.90, 1.00, 0.45], llenado: [0.25, 1.20, 1.10],
});
const rect = (kw = {}) => ({ ...RECT, ...kw });
const sim02 = (kw = {}) => new Cisterna(rect({ dx: 0.2, ...kw })); // malla 17x12x6: rápida

function corre(sim, pasos, opts) {
  for (let q = 0; q < pasos; q++) sim.avanza(sim.dtFlujo(), opts);
}

function maxAbs(a) {
  let m = 0;
  for (const x of a) m = Math.max(m, Math.abs(x));
  return m;
}

function suma(a) {
  let s = 0;
  for (const x of a) s += x;
  return s;
}

test("redondeo como Python y malla 17x12x6 con dx 0.2", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 12.25, 12.5, 13.5, 16.999999].map(redondeaPy), [0, 2, 2, 12, 12, 14, 17]);
  const sim = sim02();
  assert.deepEqual([sim.nx, sim.ny, sim.nz], [17, 12, 6]);
  assert.equal(sim.u.length, 18 * 12 * 6);
  assert.equal(sim.v.length, 17 * 13 * 6);
  assert.equal(sim.w.length, 17 * 12 * 7);
});

test("la DCT por matrices es ortonormal", () => {
  for (const n of [4, 5, 12, 17]) {
    const { C } = matrizDct(n);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += C[a * n + j] * C[b * n + j];
        assert.ok(Math.abs(s - (a === b ? 1 : 0)) < 1e-14);
      }
    }
  }
});

test("flujo sin divergencia y cloro conservado", () => {
  const sim = sim02();
  sim.dosifica(7500.0, sim.geo.punto_dosis);
  const m0 = sim.masaCloroMg();
  corre(sim, 60);
  assert.ok(maxAbs(sim.divergencia()) < 1e-10);
  assert.ok(Math.abs(sim.masaCloroMg() - m0) <= 1e-10 * m0);
  let cmin = Infinity, cmax = -Infinity;
  for (const x of sim.c) {
    cmin = Math.min(cmin, x);
    cmax = Math.max(cmax, x);
  }
  assert.ok(cmin > -1e-9 * cmax);
  assert.ok(sim.energiaCinetica() > 0);
});

test("concentración uniforme se queda uniforme", () => {
  const sim = sim02();
  corre(sim, 30, { cloro: false });
  sim.c.fill(0.75);
  corre(sim, 30);
  for (const x of sim.c) assert.ok(Math.abs(x - 0.75) <= 1e-12);
});

test("la fuerza del chorro integra M * dir", () => {
  const sim = sim02();
  const d = sim.geo.dir_chorro;
  [sim.fU, sim.fV, sim.fW].forEach((f, q) => {
    const total = suma(f) * sim.volCelda, esperado = sim.bomba.m_m4s2 * d[q];
    assert.ok(Math.abs(total - esperado) <= 1e-15 + 1e-12 * Math.abs(esperado), `componente ${q}`);
  });
});

test("el chorro empuja en su dirección", () => {
  const sim = sim02();
  corre(sim, 40, { cloro: false });
  const d = sim.geo.dir_chorro;
  const p = sim.geo.punto_tubo(sim.cfg.z_bomba).map((q, i) => q + 0.2 * d[i]);
  const vel = sim.velocidadEn(...p);
  assert.ok(vel[0] * d[0] + vel[1] * d[1] + vel[2] * d[2] > 0);
});

test("chorro configurable", () => {
  const g = geometria(rect({ azimut: 90.0, elevacion: 0.0, pos_bomba: [1.0, 1.0, 0.6] }));
  g.dir_chorro.forEach((q, i) => assert.ok(Math.abs(q - [0, 1, 0][i]) < 1e-12));
  const sim = sim02({ azimut: 90.0, elevacion: 0.0, pos_bomba: [1.0, 1.0, 0.6] });
  assert.ok(suma(sim.fV) > 0 && Math.abs(suma(sim.fU)) < 1e-12 && Math.abs(suma(sim.fW)) < 1e-12);
});

test("bomba apagada y agua quieta: nada se mueve", () => {
  const sim = sim02();
  sim.avanza(0.5, { bomba: false, cloro: false });
  assert.equal(maxAbs(sim.u) + maxAbs(sim.v) + maxAbs(sim.w), 0);
  assert.equal(sim.nuMax, 1e-6);
});

test("con consumo: div(u) = s y el balance de masa cierra", () => {
  const sim = sim02({ consumo_lpm: 25, c_llenado_mg_l: 0.2 });
  const q = 25 / 60000;
  const s = sim.divergenciaObjetivo();
  assert.ok(Math.abs(suma(s) * sim.volCelda) < 1e-12 * q);
  sim.dosificaCfg();
  const m0 = sim.masaCloroMg();
  corre(sim, 60);
  const div = sim.divergencia();
  for (let m = 0; m < div.length; m++) assert.ok(Math.abs(div[m] - s[m]) < 1e-10);
  const dm = sim.masaCloroMg() - m0, balance = sim.entrada_mg - sim.salida_mg;
  assert.ok(sim.salida_mg > 0 && sim.entrada_mg > 0);
  assert.ok(Math.abs(dm - balance) <= 1e-6 * Math.max(sim.entrada_mg, sim.salida_mg), `${dm} contra ${balance}`);
  const entradaEsperada = q * 1000 * 0.2 * sim.t;
  assert.ok(Math.abs(sim.entrada_mg - entradaEsperada) <= 1e-12 * entradaEsperada);
});

test("con consumo: el primer paso saca Q * c * dt (llenado lejos del pozo)", () => {
  const sim = sim02({ consumo_lpm: 30, llenado: [3.2, 2.3, 1.1] });
  sim.c.fill(1.0);
  const m0 = sim.masaCloroMg(), dt = 0.5;
  sim.avanza(dt);
  const esperado = -(30 / 60000) * 1000 * 1.0 * dt;
  assert.ok(Math.abs(sim.masaCloroMg() - m0 - esperado) <= 1e-6 * Math.abs(esperado));
});

test("con consumo: agua uniforme igual a la del llenado se queda uniforme", () => {
  const sim = sim02({ consumo_lpm: 30, c_llenado_mg_l: 0.75 });
  sim.c.fill(0.75);
  corre(sim, 30);
  for (const x of sim.c) assert.ok(Math.abs(x - 0.75) <= 1e-12);
});

test("el chorro del llenado empuja hacia abajo con M = Q^2 / A", () => {
  const sim = sim02({ consumo_lpm: 20, llenado_mm: 13 });
  const q = 20 / 60000, area = Math.PI * 0.013 ** 2 / 4;
  assert.ok(Math.abs(sim.mLlenado - q * q / area) <= 1e-15);
  const total = suma(sim.fLlenado) * sim.volCelda;
  assert.ok(Math.abs(total + q * q / area) <= 1e-12 * (q * q / area));
  assert.equal(sim02().fLlenado, null);
});

test("validar rechaza los mismos casos que tests/test_solver.py", () => {
  const invalidos = [
    { nivel: 0.55 }, { lugar_dosis: "tinaco" }, { dx: 0.7 }, { angulo_tubo: 0 }, { boca: [5.0, 1.0] },
    { cfl: 0.9 }, { c_nu: -0.01 }, { dosis_ml: 0 }, { elevacion: 120 }, { pos_bomba: [1.0, 1.0, 1.15] },
    { sc_t: 0 }, { boca: [3.45, 1.0] }, { c_nu: NaN }, { consumo_lpm: NaN }, { cs: NaN },
  ];
  for (const kw of invalidos) assert.throws(() => validar(rect(kw)), Error, JSON.stringify(kw));
  assert.throws(() => new Cisterna(rect({ nivel: 0.55 })), /casi en seco/);
  validar(RECT);
  validar(rect({ lugar_dosis: "mastil" }));
  validar(rect({ lugar_dosis: [2.0, 1.0, 0.5] }));
});

test("validar rechaza también lo propio del motor JS", () => {
  for (const kw of [{ consumo_lpm: -1 }, { llenado_mm: 0 }, { c_llenado_mg_l: -0.1 }, { lugar_dosis: [1, 2] },
    { boca: [1.0] }, { pos_bomba: [1, 1] }, { consumo_lpm: 10, llenado: [4.0, 1.0, 1.0] }]) {
    assert.throws(() => validar(rect(kw)), Error, JSON.stringify(kw));
  }
  assert.throws(() => validar({ nivell: 1.0 }), /parámetro desconocido: nivell/);
  assert.throws(() => validar({ dosis_ml: 0, cfl: 0.9 }), /dosis_ml debe ser > 0; cfl debe estar en/);
});

test("puntoOperacion: mismos casos que tests/test_solver.py", () => {
  const op = puntoOperacion(800, 5, 8, 8);
  assert.ok(Math.abs(op.q_lh - 800) < 1e-9);
  assert.ok(Math.abs(op.u_ms - 800 / 3.6e6 / (Math.PI * 0.004 ** 2)) < 1e-12);
  const red = puntoOperacion(800, 5, 6, 8, 1.0);
  const hBomba = 5 * (1 - red.q_lh / 800);
  const uS = red.q_m3s / (Math.PI * 0.004 ** 2);
  assert.ok(Math.abs(hBomba - (red.u_ms ** 2 - uS ** 2) / (2 * G)) <= 1e-9 * hBomba);
  assert.ok(red.q_lh > 0 && red.q_lh < 800);
  const jt = tiempoMezclaS(10.0, puntoOperacion(700, 5, 12, 12).m_m4s2) / 60;
  assert.ok(jt > 40 && jt < 47);
  const mibee = tiempoMezclaS(10.0, puntoOperacion(800, 5, 8, 8).m_m4s2) / 60;
  assert.ok(mibee > 23 && mibee < 27);
  const t = Object.fromEntries([3, 6, 8, 12].map((b) => [b, tiempoMezclaS(10.0, puntoOperacion(800, 5, b, 8).m_m4s2)]));
  assert.ok(t[8] < t[3] && t[8] < t[12]);
  assert.ok(Math.abs(t[6] - t[8]) / t[8] < 0.05);
  assert.throws(() => puntoOperacion(0, 5, 8), Error);
  assert.throws(() => tiempoMezclaS(10, 0), Error);
});

test("geometría del mástil", () => {
  const cfg = configura(RECT);
  const g = geometria(cfg);
  const [x, y] = g.punto_tubo(cfg.z_bomba);
  const horizontal = Math.hypot(x - cfg.boca[0], y - cfg.boca[1]);
  assert.ok(Math.abs(horizontal - (cfg.z_tapa - cfg.z_bomba) / Math.tan(Math.PI / 3)) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...g.dir_chorro) - 1) < 1e-12);
  assert.deepEqual(Object.keys(g.sondas), ["superficie (tapa)", "llave de la casa (pozo)", "sonda ORP"]);
});

test("DEFAULTS congelado y configura copia los arreglos", () => {
  assert.ok(Object.isFrozen(DEFAULTS) && Object.isFrozen(DEFAULTS.boca));
  const cfg = configura({ nivel: 1.0 });
  cfg.boca[0] = 9;
  assert.equal(DEFAULTS.boca[0], 1.63);
  assert.equal(cfg.nivel, 1.0);
  assert.equal(cfg.pos_bomba, null);
  // null explícito sigue valiendo: chorro por el tubo
  const doc = configura(RECT);
  assert.equal(doc.azimut, null);
  assert.equal(doc.elevacion, null);
});

test("defaults: la cisterna de Erick (redonda, tubo vertical, chorro horizontal lejos del pozo)", () => {
  validar({});
  const cfg = configura();
  const g = geometria(cfg);
  assert.equal(cfg.forma, "redonda");
  assert.ok(cfg.largo === cfg.diametro && cfg.ancho === cfg.diametro);
  assert.ok(Math.abs(g.volumen_m3 - 10.0) < 0.02);
  const [bx, by] = cfg.boca;
  [bx, by, 0.5].forEach((q, i) => assert.ok(Math.abs(g.pos_bomba[i] - q) < 1e-12, "bomba sobre el tubo a 50 cm"));
  [bx, by, 0.2].forEach((q, i) => assert.ok(Math.abs(g.sondas["sonda ORP"][i] - q) < 1e-12, "sonda ORP a 20 cm"));
  assert.deepEqual(g.dir_chorro, [1, 0, 0]);
  const hacia = cfg.pozo.map((q, i) => q - g.pos_bomba[i]);
  assert.ok(g.dir_chorro[0] * hacia[0] + g.dir_chorro[1] * hacia[1] + g.dir_chorro[2] * hacia[2] < 0, "lejos del pozo");
  assert.ok(Math.abs(Math.hypot(cfg.pozo[0] - bx, cfg.pozo[1] - by) - 0.30) < 1e-12);
  assert.ok(Math.hypot(cfg.llenado[0] - cfg.pozo[0], cfg.llenado[1] - cfg.pozo[1]) <= 0.30 + 1e-12);
  const sim = new Cisterna({ dx: 0.2 });
  assert.ok(sim.redonda);
  sim.dosificaCfg();
  corre(sim, 20);
  assert.ok(sim.stats().vmax > 0.01 && Math.abs(sim.masaCloroMg() / 7500 - 1) < 1e-10);
});

test("correr avanza exactamente los segundos pedidos", () => {
  const sim = sim02();
  const pasos = sim.correr(7.3, { cloro: false });
  assert.ok(pasos >= 15);
  assert.ok(Math.abs(sim.t - 7.3) < 1e-9);
});

test("dosis: masa, cFinal y estadísticas", () => {
  const sim = sim02();
  assert.equal(sim.cFinal, 0);
  sim.dosificaCfg();
  const masa = DEFAULTS.dosis_ml * DEFAULTS.cloralex_mg_ml;
  assert.ok(Math.abs(sim.masaCloroMg() - masa) <= 1e-12 * masa);
  const vol = sim.nx * sim.ny * sim.nz * sim.volCelda;
  assert.ok(Math.abs(sim.cFinal - masa / (vol * 1000)) <= 1e-15);
  const st = sim.stats();
  assert.ok(Math.abs(st.cmedia / sim.cFinal - 1) < 1e-12);
  assert.ok(st.cmax > 1 && st.cmin < 1 && st.cov > 0);
  assert.ok(Math.abs(st.masa_mg - masa) <= 1e-9 * masa);
  const sondas = sim.valoresSondas();
  assert.deepEqual(Object.keys(sondas), Object.keys(sim.geo.sondas));
});

test("muestreo: centros y caras devuelven el valor del arreglo", () => {
  const sim = sim02();
  sim.dosificaCfg();
  corre(sim, 10);
  const { nx, ny, nz, dx, dy, dz } = sim;
  const i = 5, j = 7, k = 3;
  const m = (i * ny + j) * nz + k;
  assert.ok(Math.abs(sim.muestrea("c", (i + 0.5) * dx, (j + 0.5) * dy, (k + 0.5) * dz) - sim.c[m]) < 1e-12);
  const vel = sim.velocidadEn(i * dx, (j + 0.5) * dy, (k + 0.5) * dz);
  assert.ok(Math.abs(vel[0] - sim.u[m]) < 1e-15);
  const iw = (i * ny + j) * (nz + 1) + k;
  assert.ok(Math.abs(sim.muestrea("w", (i + 0.5) * dx, (j + 0.5) * dy, k * dz) - sim.w[iw]) < 1e-15);
  assert.throws(() => sim.muestrea("p", 1, 1, 1), /campo desconocido/);
  assert.equal(nx, 17);
});

test("planta, corte y sección del chorro", () => {
  const sim = sim02();
  sim.dosificaCfg();
  corre(sim, 20);
  const { nx, ny, nz, dx, dy, dz } = sim;
  const pr = sim.planta("c", "promedio");
  assert.equal(pr.data.length, nx * ny);
  let s = 0;
  for (const x of pr.data) s += x;
  assert.ok(Math.abs(s / (nx * ny) / sim.stats().cmedia - 1) < 1e-6);
  const k = 2, capa = sim.planta("c", (k + 0.5) * dz);
  const i = 4, j = 9;
  assert.ok(Math.abs(capa.data[i * ny + j] - sim.c[(i * ny + j) * nz + k]) <= 1e-6 * Math.abs(sim.c[(i * ny + j) * nz + k]));
  const pv = sim.planta("vel", 0.45);
  assert.ok(pv.u.length === nx * ny && pv.v.length === nx * ny && pv.w.length === nx * ny);
  for (let q = 0; q < nx * ny; q++) assert.ok(pv.data[q] >= 0);

  const cx = sim.corte("x", (j + 0.5) * dy);
  assert.ok(cx.ni === nx && cx.nk === nz && cx.data.length === nx * nz);
  assert.ok(Math.abs(cx.data[i * nz + k] - sim.c[(i * ny + j) * nz + k]) <= 1e-6 * sim.c[(i * ny + j) * nz + k]);
  const cy = sim.corte("y", (i + 0.5) * dx, "vel");
  assert.ok(cy.ni === ny && cy.uh.length === ny * nz && cy.w.length === ny * nz);
  assert.throws(() => sim.corte("z", 0.5), /eje desconocido/);

  const sc = sim.seccionChorro("c");
  assert.equal(sc.data.length, sc.s.length * nz);
  assert.equal(sc.z.length, nz);
  const sv = sim.seccionChorro("vel");
  assert.equal(sv.w.length, sv.data.length);
});

test("copiaEstado conserva el agua al cambiar la bomba de lugar", () => {
  const a = sim02();
  a.dosificaCfg();
  corre(a, 10);
  const b = sim02({ pos_bomba: [2.5, 0.8, 0.4], azimut: 180, elevacion: -10 });
  assert.ok(b.copiaEstado(a));
  assert.deepEqual(Array.from(b.u), Array.from(a.u));
  assert.equal(b.t, a.t);
  assert.equal(b.cFinal, a.cFinal);
  assert.equal(new Cisterna(rect({ dx: 0.25 })).copiaEstado(a), false);
});


test("bomba en el tope y nivel bajo con malla gruesa son válidos", () => {
  validar(rect({ z_bomba: 1.10 }));
  validar(rect({ dx: 0.2, nivel: 0.65, z_bomba: 0.40, pozo: [0.9, 1.0, 0.30] }));
});

test("con consumo alto, prender la bomba no mezcla más lento que apagada", () => {
  const cov = {};
  for (const bomba of [true, false]) {
    const sim = sim02({ consumo_lpm: 40 });
    sim.dosificaCfg();
    while (sim.t < 20 * 60) sim.avanza(Math.min(sim.dtFlujo(), 20 * 60 - sim.t), { bomba });
    cov[bomba] = sim.stats().cov;
  }
  assert.ok(cov[true] <= cov[false], `CoV a 20 min: bomba ${cov[true].toFixed(3)}, sin bomba ${cov[false].toFixed(3)}`);
});

test("sin consumo, el CoV de stats es std(c / cFinal) como en Python", () => {
  const sim = sim02();
  sim.dosificaCfg();
  for (let k = 0; k < 30; k++) sim.avanza(0.5);
  const n = sim.c.length;
  let s = 0, s2 = 0;
  for (let m = 0; m < n; m++) { const r = sim.c[m] / sim.cFinal; s += r; s2 += r * r; }
  const std = Math.sqrt(s2 / n - (s / n) ** 2);
  assert.ok(Math.abs(sim.stats().cov - std) < 1e-9 * std);
});
