// Benchmark del motor en Node: ms por paso completo (flujo + cloro) con dx 0.10 y 0.05.
//   node web/test/bench.js            (precalienta 30 s de bomba antes de medir)
// No es una prueba: bajo `node --test` no hace nada.
import { Cisterna } from "../solver.js";

function mide(dx, pasos, precalentar) {
  const sim = new Cisterna({ dx });
  sim.correr(precalentar, { cloro: false });
  sim.dosificaCfg();
  for (let q = 0; q < 5; q++) sim.avanza(sim.dtFlujo());

  let subpasos = 0;
  const original = sim._pasoCloro;
  sim._pasoCloro = function (dt) {
    subpasos++;
    original.call(this, dt);
  };
  let t0 = performance.now(), simulado = 0;
  for (let q = 0; q < pasos; q++) {
    const dt = sim.dtFlujo();
    sim.avanza(dt);
    simulado += dt;
  }
  const completo = (performance.now() - t0) / pasos;
  sim._pasoCloro = original;

  t0 = performance.now();
  for (let q = 0; q < pasos; q++) sim.avanza(sim.dtFlujo(), { cloro: false });
  const flujo = (performance.now() - t0) / pasos;
  return {
    dx, malla: `${sim.nx}x${sim.ny}x${sim.nz}`, completo, flujo,
    subpasos: subpasos / pasos, dtMedio: simulado / pasos, vecesTiempoReal: simulado / pasos / (completo / 1000),
  };
}

if (!process.env.NODE_TEST_CONTEXT) {
  const precalentar = Number(process.argv[2] ?? 30);
  console.log(`Node ${process.version}, ${precalentar} s de bomba antes de medir`);
  for (const [dx, pasos] of [[0.10, 200], [0.05, 30]]) {
    const r = mide(dx, pasos, precalentar);
    console.log(`dx ${r.dx.toFixed(2)} (${r.malla}): ${r.completo.toFixed(2)} ms por paso completo, ` +
      `${r.flujo.toFixed(2)} ms solo flujo, ${r.subpasos.toFixed(1)} subpasos de cloro, ` +
      `dt medio ${r.dtMedio.toFixed(3)} s, ${r.vecesTiempoReal.toFixed(0)}x tiempo real a CPU completa`);
  }
}
