// Validación cruzada contra el solver Python: mismos casos que web/test/gen_ref.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Cisterna, geometria, puntoOperacion, tiempoMezclaS, validar } from "../solver.js";

const REF = JSON.parse(readFileSync(new URL("./ref_py.json", import.meta.url), "utf8"));
const TOL = 1e-6;

// Error máximo relativo a la norma infinito del campo de referencia.
function errorRel(js, py) {
  assert.equal(js.length, py.length);
  let num = 0, den = 0;
  for (let q = 0; q < py.length; q++) {
    num = Math.max(num, Math.abs(js[q] - py[q]));
    den = Math.max(den, Math.abs(py[q]));
  }
  return den > 0 ? num / den : num;
}

function cerca(a, b, rel, msg) {
  assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-300), `${msg}: js ${a} py ${b}`);
}

function correCaso(caso) {
  const sim = new Cisterna(caso.cfg);
  sim.dosificaCfg();
  for (let paso = 0; paso < caso.pasos; paso++) {
    sim.avanza(caso.dt, { bomba: caso.apaga_en === null || paso < caso.apaga_en });
  }
  return sim;
}

const errores = {};

for (const [nombre, caso] of Object.entries(REF.casos)) {
  test(`campos finales iguales a Python: ${nombre}`, () => {
    const sim = correCaso(caso);
    assert.deepEqual([sim.nx, sim.ny, sim.nz], caso.malla);
    for (const campo of ["u", "v", "w", "c"]) {
      const e = errorRel(sim[campo], caso[campo]);
      errores[`${nombre}.${campo}`] = e;
      assert.ok(e < TOL, `${campo}: error relativo ${e.toExponential(2)}`);
    }
    const st = sim.stats();
    for (const k of Object.keys(caso.stats)) cerca(st[k], caso.stats[k], TOL, `stats.${k}`);
    cerca(sim.cFinal, caso.c_final, 1e-12, "cFinal");
    cerca(sim.dtFlujo(), caso.dt_flujo, TOL, "dtFlujo");
    cerca(sim.dtCloro(), caso.dt_cloro, TOL, "dtCloro");
    const sondas = sim.valoresSondas();
    for (const [n, val] of Object.entries(caso.sondas)) cerca(sondas[n], val, TOL, `sonda ${n}`);
    for (const [x, y, z, val] of caso.muestras_c) cerca(sim.muestrea("c", x, y, z), val, TOL, `muestra ${x},${y},${z}`);
    const sec = sim.seccionChorro("c");
    assert.equal(sec.s.length, caso.seccion.s.length);
    assert.ok(errorRel(sec.s, caso.seccion.s) < 1e-6);
    assert.ok(errorRel(sec.z, caso.seccion.z) < 1e-6);
    assert.ok(errorRel(sec.data, caso.seccion.c) < TOL, "sección del chorro");
    const ft = [sim.fU, sim.fV, sim.fW].map((f) => f.reduce((a, b) => a + b, 0) * sim.volCelda);
    ft.forEach((f, q) => assert.ok(Math.abs(f - caso.f_total[q]) <= 1e-12 * sim.bomba.m_m4s2));
  });
}

test("geometría igual a Python", () => {
  for (const g of REF.geometrias) {
    const js = geometria(g.cfg);
    const pares = [["rumbo", js.rumbo], ["pos_bomba", js.pos_bomba], ["dir_chorro", js.dir_chorro],
      ["plano_chorro", js.plano_chorro], ["punto_dosis", js.punto_dosis]];
    const cfgZ = { ...g.cfg };
    pares.push(["punto_tubo_bomba", js.punto_tubo(cfgZ.z_bomba ?? 0.5)]);
    for (const [k, val] of pares) {
      val.forEach((q, i) => assert.ok(Math.abs(q - g[k][i]) < 1e-12, `${k}[${i}] ${JSON.stringify(g.cfg)}`));
    }
    for (const [n, p] of Object.entries(g.sondas)) {
      p.forEach((q, i) => assert.ok(Math.abs(q - js.sondas[n][i]) < 1e-12, `sonda ${n}`));
    }
  }
});

test("puntoOperacion igual a Python", () => {
  assert.ok(REF.bombas.length >= 5);
  for (const b of REF.bombas) {
    const op = puntoOperacion(...b.args);
    for (const k of ["q_m3s", "q_lh", "u_ms", "m_m4s2"]) cerca(op[k], b[k], 1e-12, `${k} ${b.args}`);
    assert.ok(Math.abs(op.h_m - b.h_m) < 1e-12, `h_m ${b.args}`);
    cerca(tiempoMezclaS(10.0, op.m_m4s2), b.t_mezcla_10m3_s, 1e-12, `tiempo ${b.args}`);
  }
});

test("validar rechaza lo mismo que Python", () => {
  for (const kw of REF.invalidos) assert.throws(() => validar(kw), Error, JSON.stringify(kw));
  for (const caso of Object.values(REF.casos)) validar(caso.cfg);
  for (const g of REF.geometrias) validar(g.cfg);
});

test.after(() => {
  const peor = Math.max(...Object.values(errores));
  if (Number.isFinite(peor)) console.log(`# error relativo máximo contra Python: ${peor.toExponential(2)}`);
});
