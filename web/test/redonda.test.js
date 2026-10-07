// Cisterna redonda (forma "redonda"): máscara, presión por gradiente conjugado e invariantes.
import assert from "node:assert/strict";
import test from "node:test";

import { Cisterna, MAX_IT_PRESION, TOL_PRESION, configura, geometria, validar } from "../solver.js";

const D = 3.26, R = D / 2;
const red = (kw = {}) => new Cisterna({ forma: "redonda", diametro: D, dx: 0.2, ...kw }); // 16x16x6

function corre(sim, pasos, opts) {
  for (let q = 0; q < pasos; q++) sim.avanza(sim.dtFlujo(), opts);
}

function suma(a) {
  let s = 0;
  for (const x of a) s += x;
  return s;
}

// Máscara calculada aquí desde la especificación, sin usar la del motor.
function fluido(sim) {
  const { nx, ny, dx, dy } = sim;
  return (i, j) => i >= 0 && i < nx && j >= 0 && j < ny &&
    ((i + 0.5) * dx - R) ** 2 + ((j + 0.5) * dy - R) ** 2 <= R * R;
}

// Recorre las caras con su estado (abierta o cerrada) según SPEC "Cisterna redonda", punto 2.
function caras(sim, fn) {
  const { nx, ny, nz } = sim;
  const f = fluido(sim);
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j < ny; j++) {
      const ab = i >= 1 && i <= nx - 1 && f(i - 1, j) && f(i, j);
      for (let k = 0; k < nz; k++) fn("u", (i * ny + j) * nz + k, ab);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const ab = j >= 1 && j <= ny - 1 && f(i, j - 1) && f(i, j);
      for (let k = 0; k < nz; k++) fn("v", (i * (ny + 1) + j) * nz + k, ab);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k <= nz; k++) fn("w", (i * ny + j) * (nz + 1) + k, k >= 1 && k <= nz - 1 && f(i, j));
    }
  }
}

function celdas(sim, fn) {
  const { nx, ny, nz } = sim;
  const f = fluido(sim);
  for (let i = 0, m = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++, m++) fn(m, f(i, j));
  }
}

// max|div| en el agua relativo a vmax / h (lo que da una velocidad típica en una celda).
function divRelativa(sim) {
  const div = sim.divergencia();
  let mx = 0, fuera = 0;
  celdas(sim, (m, agua) => {
    if (agua) mx = Math.max(mx, Math.abs(div[m]));
    else fuera = Math.max(fuera, Math.abs(div[m]));
  });
  return { rel: mx * Math.min(sim.dx, sim.dz) / sim.stats().vmax, fuera };
}

test("redonda: largo = ancho = diámetro, máscara de la especificación y volúmenes", () => {
  const cfg = configura({ forma: "redonda", diametro: 3.0, largo: 9, ancho: 1 });
  assert.equal(cfg.largo, 3.0);
  assert.equal(cfg.ancho, 3.0);
  const sim = red();
  assert.deepEqual([sim.nx, sim.ny, sim.nz], [16, 16, 6]);
  assert.ok(sim.redonda);
  const f = fluido(sim);
  let n = 0;
  for (let i = 0; i < sim.nx; i++) {
    for (let j = 0; j < sim.ny; j++) {
      assert.equal(sim.agua[i * sim.ny + j], f(i, j) ? 1 : 0, `columna ${i},${j}`);
      if (f(i, j)) n++;
    }
  }
  assert.equal(sim.nAgua, n * sim.nz);
  assert.ok(Math.abs(sim.volumenAgua - sim.nAgua * sim.volCelda) < 1e-12);
  const g = sim.geo;
  assert.equal(g.forma, "redonda");
  assert.deepEqual(g.centro, [R, R]);
  assert.equal(g.radio, R);
  assert.ok(Math.abs(g.volumen_m3 - Math.PI * R * R * 1.2) < 1e-12);
  assert.ok(Math.abs(g.volumen_m3 - 10.0) < 0.02, "10 m3 a 1.20 m");
  assert.ok(Math.abs(sim.volumenAgua / g.volumen_m3 - 1) < 0.05);
  const fino = new Cisterna({ forma: "redonda", diametro: D, dx: 0.1 });
  assert.ok(Math.abs(fino.volumenAgua / g.volumen_m3 - 1) < 0.01);
  const rect = new Cisterna({ dx: 0.2 });
  assert.equal(rect.nAgua, rect.nx * rect.ny * rect.nz);
  assert.equal(rect.redonda, false);
  assert.equal(rect.p, null);
});

test("redonda: rumbo hacia el centro (el lado opuesto sustituye a la esquina opuesta)", () => {
  const base = { forma: "redonda", diametro: D };
  for (const boca of [[1.0, 2.0], [2.5, 1.2], [1.2, 1.0]]) {
    const g = geometria({ ...base, boca });
    const hx = R - boca[0], hy = R - boca[1], n = Math.hypot(hx, hy);
    assert.ok(Math.abs(g.rumbo[0] - hx / n) < 1e-12 && Math.abs(g.rumbo[1] - hy / n) < 1e-12);
    const cfg = configura({ ...base, boca });
    const [x, y] = g.pos_bomba;
    const s = (cfg.z_tapa - cfg.z_bomba) / Math.tan(Math.PI / 3);
    assert.ok(Math.abs(Math.hypot(x - boca[0], y - boca[1]) - s) < 1e-12);
    assert.ok(Math.hypot(x - R, y - R) < n, "la bomba queda más cerca del centro que la boca");
    const az = Math.atan2(g.dir_chorro[1], g.dir_chorro[0]);
    assert.ok(Math.abs(az - Math.atan2(hy, hx)) < 1e-12);
  }
  assert.deepEqual(geometria({ ...base, boca: [R + 0.0005, R] }).rumbo, [1, 0]);
  assert.deepEqual(geometria({ ...base, boca: [R, R] }).rumbo, [1, 0]);
});

test("redonda: validar rechaza puntos fuera del círculo y acepta los de adentro", () => {
  const base = { forma: "redonda", diametro: D, dx: 0.1 };
  const rMax = R - 0.05;
  const en = (r, ang, z) => [R + r * Math.cos(ang), R + r * Math.sin(ang), z];
  const dentro = rMax - 1e-3, fuera = rMax + 1e-3;
  for (const ang of [0, 0.7, 2.4, 3.9, 5.5]) {
    validar({ ...base, pozo: en(dentro, ang, 0.45) });
    validar({ ...base, pos_bomba: en(dentro, ang, 0.5) });
    validar({ ...base, lugar_dosis: en(dentro, ang, 0.8) });
    validar({ ...base, consumo_lpm: 10, llenado: en(dentro, ang, 1.1) });
    assert.throws(() => validar({ ...base, pozo: en(fuera, ang, 0.45) }), /pozo .* queda fuera/);
    assert.throws(() => validar({ ...base, pos_bomba: en(fuera, ang, 0.5) }), /bomba .* queda fuera/);
    assert.throws(() => validar({ ...base, lugar_dosis: en(fuera, ang, 0.8) }), /dosis .* queda fuera/);
    assert.throws(() => validar({ ...base, consumo_lpm: 10, llenado: en(fuera, ang, 1.1) }), /llenado .* queda fuera/);
  }
  // esquina de la caja: adentro de la rectangular de 3.26 x 3.26, afuera del círculo
  assert.throws(() => validar({ ...base, pozo: [0.25, 0.25, 0.45] }), /pozo/);
  validar({ largo: D, ancho: D, pozo: [0.25, 0.25, 0.45] });
  // el llenado solo cuenta con consumo
  validar({ ...base, lugar_dosis: "mastil", llenado: [0.2, 0.2, 1.1] });
  // la boca (sonda de superficie) y la sonda ORP sobre el tubo
  assert.throws(() => validar({ ...base, boca: [0.03, R] }), /boca/);
  validar({ ...base, boca: [0.06, R], pos_bomba: [1.6, 1.6, 0.5], angulo_tubo: 90 });
  // tubo muy acostado: cruza el centro y la punta (sonda ORP) sale por el otro lado
  assert.throws(() => validar({ ...base, boca: [1.0, R], angulo_tubo: 20, pos_bomba: [1.6, 1.6, 0.5] }), /sonda ORP/);
  assert.throws(() => validar({ ...base, pozo: en(1.0, 1.0, 1.25) }), /pozo/);
  assert.throws(() => validar({ ...base, dx: 0.45 }), /al menos 8 celdas/);
  validar({ ...base, dx: 0.4, lugar_dosis: "mastil" });
  assert.throws(() => validar({ ...base, forma: "cuadrada" }), /forma debe ser/);
  assert.throws(() => validar({ ...base, diametro: 0 }), /diametro debe ser > 0/);
  validar(base);
});

test("redonda: flujo sin divergencia en el agua y presión a la tolerancia", () => {
  const sim = red();
  sim.dosificaCfg();
  corre(sim, 40);
  const { rel, fuera } = divRelativa(sim);
  assert.ok(rel <= 1e-6, `divergencia relativa ${rel.toExponential(2)}`);
  assert.equal(fuera, 0);
  assert.ok(sim.presion.residuo <= TOL_PRESION);
  assert.ok(sim.presion.iteraciones < MAX_IT_PRESION);
  assert.ok(sim.presion.total / sim.presion.proyecciones < 30, "arranque en caliente");
  assert.ok(sim.stats().vmax > 0.01);
});

test("redonda: campo al azar proyectado, con la tolerancia normal y con una estricta", () => {
  for (const tol of [TOL_PRESION, 1e-12]) {
    const sim = red();
    sim.tolPresion = tol;
    let semilla = 7;
    const azar = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2;
    caras(sim, (campo, m, ab) => {
      if (ab) sim[campo][m] = azar();
    });
    sim.avanza(0.05, { cloro: false, bomba: false });
    const { rel } = divRelativa(sim);
    assert.ok(rel <= 100 * tol, `tol ${tol}: divergencia relativa ${rel.toExponential(2)}`);
    assert.ok(sim.presion.residuo <= tol && sim.presion.iteraciones > 0);
  }
});

test("redonda: caras cerradas siempre en 0 y cloro fuera del agua siempre en 0", () => {
  const sim = red({ consumo_lpm: 20 });
  sim.dosificaCfg();
  let pasos = 0;
  const revisa = () => {
    caras(sim, (campo, m, ab) => {
      if (!ab) assert.ok(sim[campo][m] === 0, `${campo}[${m}] cerrada tras ${pasos} pasos`);
    });
    celdas(sim, (m, agua) => {
      if (!agua) assert.ok(sim.c[m] === 0, `c[${m}] fuera del agua`);
    });
  };
  revisa();
  for (; pasos < 30; pasos++) {
    sim.avanza(sim.dtFlujo(), { bomba: pasos < 20 });
    if (pasos % 5 === 0) revisa();
  }
  revisa();
  // también en los arreglos intermedios de cada sub-paso
  const original = sim._proyecta;
  sim._proyecta = function (dt) {
    caras(this, (campo, m, ab) => {
      if (!ab) assert.ok(this[`_${campo}n`][m] === 0, `${campo} antes de proyectar`);
    });
    original.call(this, dt);
  };
  sim.avanza(sim.dtFlujo());
});

test("redonda: masa de cloro conservada sin consumo", () => {
  const sim = red();
  sim.dosifica(7500.0, sim.geo.punto_dosis);
  const m0 = sim.masaCloroMg();
  assert.ok(Math.abs(m0 - 7500) <= 1e-12 * 7500);
  corre(sim, 60);
  assert.ok(Math.abs(sim.masaCloroMg() - m0) <= 1e-10 * m0, `${sim.masaCloroMg()} contra ${m0}`);
  const st = sim.stats();
  assert.ok(st.cmin > -1e-9 * st.cmax);
});

test("redonda: concentración uniforme en el agua se queda uniforme", () => {
  const sim = red();
  corre(sim, 30, { cloro: false });
  celdas(sim, (m, agua) => {
    if (agua) sim.c[m] = 0.75;
  });
  corre(sim, 30);
  celdas(sim, (m, agua) => {
    if (agua) assert.ok(Math.abs(sim.c[m] - 0.75) <= 1e-6, `c[${m}] = ${sim.c[m]}`);
    else assert.ok(sim.c[m] === 0);
  });
});

test("redonda: la fuerza del chorro integra M * dir sobre las caras abiertas", () => {
  // por defecto y con la bomba junto a la pared apuntando al muro (la gaussiana se recorta)
  const ang = 0.6, rb = R - 0.12;
  for (const kw of [{}, { pos_bomba: [R + rb * Math.cos(ang), R + rb * Math.sin(ang), 0.5], azimut: 0.6 * 180 / Math.PI, elevacion: -10 }]) {
    const sim = red(kw);
    const d = sim.geo.dir_chorro;
    const f = { u: sim.fU, v: sim.fV, w: sim.fW };
    const total = { u: 0, v: 0, w: 0 };
    caras(sim, (campo, m, ab) => {
      if (ab) total[campo] += f[campo][m];
      else assert.ok(f[campo][m] === 0, `fuerza en cara cerrada ${campo}[${m}]`);
    });
    ["u", "v", "w"].forEach((campo, q) => {
      const esperado = sim.bomba.m_m4s2 * d[q];
      assert.ok(Math.abs(total[campo] * sim.volCelda - esperado) <= 1e-15 + 1e-12 * Math.abs(esperado), `${campo} ${JSON.stringify(kw)}`);
    });
  }
});

test("redonda: el chorro empuja en su dirección", () => {
  const sim = red();
  corre(sim, 40, { cloro: false });
  const d = sim.geo.dir_chorro;
  const p = sim.geo.pos_bomba.map((q, i) => q + 0.2 * d[i]);
  const vel = sim.velocidadEn(...p);
  assert.ok(vel[0] * d[0] + vel[1] * d[1] + vel[2] * d[2] > 0);
});

test("redonda: bomba apagada y agua quieta: nada se mueve", () => {
  const sim = red();
  sim.avanza(0.5, { bomba: false, cloro: false });
  let s = 0;
  for (const a of [sim.u, sim.v, sim.w, sim.p]) for (const x of a) s += Math.abs(x);
  assert.equal(s, 0);
  assert.equal(sim.nuMax, 1e-6);
});

test("redonda: dosis, cFinal y estadísticas solo sobre el agua", () => {
  const sim = red();
  sim.dosificaCfg();
  const masa = sim.cfg.dosis_ml * sim.cfg.cloralex_mg_ml;
  assert.ok(Math.abs(sim.masaCloroMg() - masa) <= 1e-12 * masa);
  assert.ok(Math.abs(sim.cFinal - masa / (sim.nAgua * sim.volCelda * 1000)) <= 1e-15);
  const st = sim.stats();
  assert.ok(Math.abs(st.cmedia / sim.cFinal - 1) < 1e-12);
  assert.ok(st.cmax > 1 && st.cmin < 1 && st.cov > 0);
  // agua pareja: cov 0 y cmin = cmax = 1 aunque afuera haya ceros
  celdas(sim, (m, agua) => {
    if (agua) sim.c[m] = sim.cFinal;
  });
  const pareja = sim.stats();
  assert.ok(pareja.cov < 1e-12 && Math.abs(pareja.cmin - 1) < 1e-12 && Math.abs(pareja.cmax - 1) < 1e-12);
  corre(sim, 10, { cloro: false });
  let ek = 0;
  sim._centros();
  celdas(sim, (m, agua) => {
    if (agua) ek += sim._uc[m] ** 2 + sim._vc[m] ** 2 + sim._wc[m] ** 2;
  });
  assert.ok(Math.abs(sim.energiaCinetica() - 0.5 * ek / sim.nAgua) <= 1e-12 * sim.energiaCinetica());
});

test("redonda: el muestreo del cloro junto a la pared no cuenta el muro", () => {
  const sim = red();
  celdas(sim, (m, agua) => {
    if (agua) sim.c[m] = 0.6;
  });
  for (const ang of [0, 0.4, 1.1, 2.0, 3.3, 4.7]) {
    const r = R - 0.5 * sim.cfg.dx;
    const val = sim.muestrea("c", R + r * Math.cos(ang), R + r * Math.sin(ang), 0.3);
    assert.ok(Math.abs(val - 0.6) < 1e-12, `ángulo ${ang}: ${val}`);
  }
  for (const val of Object.values(sim.valoresSondas())) assert.ok(Math.abs(val - 0.6) < 1e-12);
  // adentro, lejos de la pared, igual que la trilineal de siempre
  const { nx, ny, nz, dx, dy, dz } = sim;
  sim.c[(8 * ny + 8) * nz + 3] = 1.6;
  assert.ok(Math.abs(sim.muestrea("c", 8.5 * dx, 8.5 * dy, 3.5 * dz) - 1.6) < 1e-12);
  assert.equal(nx, 16);
});

test("redonda: la sección del chorro es la cuerda del círculo", () => {
  const sim = red({ pos_bomba: [2.2, 1.1, 0.5], azimut: 35, elevacion: 0 });
  sim.dosificaCfg();
  const sc = sim.seccionChorro("c");
  const [x0, y0] = sc.origen, [hx, hy] = sc.dir;
  for (const s of [sc.s[0], sc.s[sc.s.length - 1]]) {
    assert.ok(Math.abs(Math.hypot(x0 + s * hx - R, y0 + s * hy - R) - R) < 1e-6);
  }
  assert.ok(sc.s[0] < 0 && sc.s[sc.s.length - 1] > 0);
  assert.equal(sc.data.length, sc.s.length * sim.nz);
});

test("redonda con consumo: div(u) = s en el agua y el balance de masa cierra", () => {
  const sim = red({ consumo_lpm: 25, c_llenado_mg_l: 0.2 });
  const q = 25 / 60000;
  const s = sim.divergenciaObjetivo();
  assert.ok(Math.abs(suma(s) * sim.volCelda) < 1e-12 * q);
  let sMas = 0, sMenos = 0;
  celdas(sim, (m, agua) => {
    if (!agua) assert.ok(s[m] === 0 && sim._sMas[m] === 0 && sim._sMenos[m] === 0);
    sMas += sim._sMas[m];
    sMenos += sim._sMenos[m];
  });
  assert.ok(Math.abs(sMas * sim.volCelda - q) <= 1e-12 * q, "la fuente da Q");
  assert.ok(Math.abs(sMenos * sim.volCelda + q) <= 1e-12 * q, "el sumidero saca Q");
  sim.dosificaCfg();
  const m0 = sim.masaCloroMg();
  corre(sim, 60);
  const div = sim.divergencia();
  let err = 0;
  celdas(sim, (m, agua) => {
    if (agua) err = Math.max(err, Math.abs(div[m] - s[m]));
  });
  assert.ok(err * Math.min(sim.dx, sim.dz) / sim.stats().vmax <= 1e-6, `div - s: ${err.toExponential(2)}`);
  const dm = sim.masaCloroMg() - m0, balance = sim.entrada_mg - sim.salida_mg;
  assert.ok(sim.salida_mg > 0 && sim.entrada_mg > 0);
  assert.ok(Math.abs(dm - balance) <= 1e-6 * Math.max(sim.entrada_mg, sim.salida_mg), `${dm} contra ${balance}`);
  const entradaEsperada = q * 1000 * 0.2 * sim.t;
  assert.ok(Math.abs(sim.entrada_mg - entradaEsperada) <= 1e-12 * entradaEsperada);
});

test("redonda con consumo: agua uniforme igual a la del llenado se queda uniforme", () => {
  const sim = red({ consumo_lpm: 30, c_llenado_mg_l: 0.75 });
  celdas(sim, (m, agua) => {
    if (agua) sim.c[m] = 0.75;
  });
  corre(sim, 30);
  celdas(sim, (m, agua) => {
    if (agua) assert.ok(Math.abs(sim.c[m] - 0.75) <= 1e-6);
    else assert.ok(sim.c[m] === 0);
  });
});

test("redonda: copiaEstado solo entre cisternas de la misma forma", () => {
  const a = red();
  a.dosificaCfg();
  corre(a, 5);
  const b = red({ pos_bomba: [2.0, 1.4, 0.4], azimut: 180, elevacion: -10 });
  assert.ok(b.copiaEstado(a));
  assert.deepEqual(Array.from(b.p), Array.from(a.p));
  assert.equal(b.cFinal, a.cFinal);
  const rect = new Cisterna({ dx: 0.2, largo: D, ancho: D });
  assert.deepEqual([rect.nx, rect.ny, rect.nz], [a.nx, a.ny, a.nz]);
  assert.equal(rect.copiaEstado(a), false);
  assert.equal(a.copiaEstado(rect), false);
});

test("redonda: la bomba mezcla (el CoV baja con el tiempo)", () => {
  const sim = red();
  sim.dosificaCfg();
  const cov0 = sim.stats().cov;
  sim.correr(120);
  const cov2 = sim.stats().cov;
  sim.correr(240);
  const cov6 = sim.stats().cov;
  assert.ok(cov2 < cov0 && cov6 < cov2, `CoV ${cov0.toFixed(2)} -> ${cov2.toFixed(2)} -> ${cov6.toFixed(2)}`);
});
