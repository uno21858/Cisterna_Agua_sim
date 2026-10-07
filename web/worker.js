// Motor del visor fuera del hilo de dibujo: corre solver.js a la velocidad pedida y manda
// instantáneas (cloro y velocidad en los centros, Float32Array transferibles) al visor.
// Cargado como Worker de tipo módulo; si el navegador no puede, app.js usa creaMotor() en el
// hilo principal con un presupuesto de tiempo menor.
import { Cisterna } from "./solver.js";

const APAGA_S = 45 * 60; // el firmware apaga la bomba de mezcla 45 min después de la dosis
const CADA_S = 10; // una muestra de sondas y estadísticas cada 10 s simulados
const CADA_SNAP_MS = 33;

export function creaMotor(manda, { presupuestoMs = 14, enHiloPrincipal = false } = {}) {
  let sim = null;
  let id = 0;
  let corriendo = true;
  let velocidad = 30;
  let modo = "firmware";
  let apagaEn = APAGA_S;
  let proxMuestra = 0;
  let deuda = 0;
  let tPrev = performance.now();
  let costoPaso = 5;
  let eventos = [];
  let libres = [];
  let enVuelo = false;
  let pendiente = true;
  let tSnap = 0;
  let vSim = 0;
  let ref = { t: 0, real: performance.now() };
  let vEsc = 0.05;
  let tEsc = 0;
  let agendado = false;
  let fresco = false;

  const canal = enHiloPrincipal ? null : new MessageChannel();
  if (canal) canal.port1.onmessage = bucle;

  function agenda(esperaMs = 0) {
    if (agendado) return;
    agendado = true;
    if (canal && esperaMs === 0) canal.port2.postMessage(0);
    else setTimeout(bucle, enHiloPrincipal ? Math.max(1, esperaMs) : esperaMs);
  }

  const encendida = () => modo === "siempre" || (modo === "firmware" && sim.t < apagaEn - 1e-9);

  function muestra() {
    eventos.push({ tipo: "muestra", t: sim.t, cFinal: sim.cFinal, stats: sim.stats(), sondas: sim.valoresSondas() });
    proxMuestra = sim.t + CADA_S;
  }

  function dosifica({ masa, punto }) {
    sim.dosifica(masa, punto);
    apagaEn = sim.t + APAGA_S;
    eventos.push({ tipo: "dosis", t: sim.t });
    muestra();
    pendiente = true;
  }

  function mandaSnap(ahora) {
    const { nx, ny, nz, u, v, w } = sim;
    const n = nx * ny * nz;
    let s = libres.pop();
    while (s && s.c.length !== n) s = libres.pop();
    if (!s) {
      s = { c: new Float32Array(n), uc: new Float32Array(n), vc: new Float32Array(n), wc: new Float32Array(n), spd: new Float32Array(n) };
    }
    s.c.set(sim.c);
    const nyz = ny * nz;
    let vmax = 0;
    for (let i = 0, m = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const iv = (i * (ny + 1) + j) * nz;
        const iw = (i * ny + j) * (nz + 1);
        for (let k = 0; k < nz; k++, m++) {
          const a = 0.5 * (u[m] + u[m + nyz]);
          const b = 0.5 * (v[iv + k] + v[iv + k + nz]);
          const e = 0.5 * (w[iw + k] + w[iw + k + 1]);
          s.uc[m] = a;
          s.vc[m] = b;
          s.wc[m] = e;
          const q = Math.sqrt(a * a + b * b + e * e);
          s.spd[m] = q;
          if (q > vmax) vmax = q;
        }
      }
    }
    if (ahora - tEsc > 500) {
      tEsc = ahora;
      const orden = Float32Array.from(s.spd).sort();
      vEsc = Math.max(0.005, orden[Math.floor(0.98 * (orden.length - 1))]);
    }
    if (ahora - ref.real > 400) {
      const v1 = (sim.t - ref.t) / ((ahora - ref.real) / 1000);
      // Tras cambiar la velocidad pedida, la primera medida reemplaza al promedio.
      vSim = corriendo ? (vSim && !fresco ? 0.6 * vSim + 0.4 * v1 : v1) : 0;
      fresco = false;
      ref = { t: sim.t, real: ahora };
    }
    const msj = {
      tipo: "snap", id, t: sim.t, cFinal: sim.cFinal, encendida: encendida(), apagaEn, vSim, costoPaso,
      nx, ny, nz, dx: sim.dx, dy: sim.dy, dz: sim.dz, volCelda: sim.volCelda,
      L: sim.cfg.largo, W: sim.cfg.ancho, H: sim.cfg.nivel, vmax, vEsc, eventos, set: s,
      redonda: sim.redonda, agua: sim.agua,
    };
    // En el hilo principal la respuesta llega dentro de manda(): el estado va antes.
    eventos = [];
    enVuelo = true;
    pendiente = false;
    tSnap = ahora;
    manda(msj, [s.c.buffer, s.uc.buffer, s.vc.buffer, s.wc.buffer, s.spd.buffer]);
  }

  function bucle() {
    agendado = false;
    if (!sim) return;
    const ahora = performance.now();
    const dtReal = Math.min(0.25, Math.max(0, (ahora - tPrev) / 1000));
    tPrev = ahora;
    let pasos = 0;
    if (corriendo) {
      deuda = Math.min(deuda + dtReal * velocidad, Math.max(0.5, velocidad * 0.25));
      const t0 = performance.now();
      for (;;) {
        const dtF = sim.dtFlujo();
        if (deuda < 0.5 * dtF) break;
        let dt = Math.min(dtF, deuda);
        if (modo === "firmware" && sim.t < apagaEn - 1e-9) dt = Math.min(dt, apagaEn - sim.t);
        dt = Math.max(dt, 1e-4);
        sim.avanza(dt, { cloro: sim.cFinal > 0, bomba: encendida() });
        deuda -= dt;
        pasos++;
        if (sim.t >= proxMuestra - 1e-9) muestra();
        if (performance.now() - t0 > presupuestoMs) break;
      }
      if (pasos) costoPaso = 0.8 * costoPaso + 0.2 * ((performance.now() - t0) / pasos);
    }
    if (pasos) pendiente = true;
    const fin = performance.now();
    if (!enVuelo && pendiente && (fin - tSnap >= CADA_SNAP_MS || eventos.length)) mandaSnap(fin);
    if (corriendo) agenda(pasos && deuda > 0 ? 0 : 6);
    else if (pendiente && !enVuelo) agenda(Math.max(1, CADA_SNAP_MS - (fin - tSnap)));
  }

  return function recibe(m) {
    switch (m.tipo) {
      case "arranca": {
        let nueva;
        try {
          nueva = new Cisterna(m.cfg);
        } catch (e) {
          manda({ tipo: "error", id: m.id, mensaje: e.message });
          return;
        }
        sim = nueva;
        id = m.id;
        deuda = 0;
        eventos = [];
        libres = libres.filter((s) => s.c.length === sim.nx * sim.ny * sim.nz);
        apagaEn = APAGA_S;
        proxMuestra = 0;
        vSim = 0;
        ref = { t: 0, real: performance.now() };
        tEsc = 0;
        if (m.dosis) dosifica(m.dosis);
        else muestra();
        pendiente = true;
        tSnap = 0;
        break;
      }
      case "dosis":
        if (sim) dosifica(m);
        break;
      case "consumo": {
        if (!sim) return;
        let nueva;
        try {
          nueva = new Cisterna({ ...sim.cfg, consumo_lpm: m.consumo_lpm });
        } catch (e) {
          manda({ tipo: "error", id, mensaje: e.message });
          return;
        }
        if (nueva.copiaEstado(sim)) sim = nueva;
        break;
      }
      case "control":
        if (m.velocidad != null && m.velocidad !== velocidad) {
          velocidad = m.velocidad;
          deuda = 0;
          fresco = true;
          ref = { t: sim ? sim.t : 0, real: performance.now() };
        }
        if (m.corriendo != null) {
          corriendo = m.corriendo;
          deuda = 0;
          tPrev = performance.now();
          ref = { t: sim ? sim.t : 0, real: tPrev };
        }
        if (m.modo != null) modo = m.modo;
        pendiente = true;
        break;
      case "devuelve":
        if (m.set) libres.push(m.set);
        enVuelo = false;
        break;
    }
    agenda();
  };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const recibe = creaMotor((datos, transferir) => self.postMessage(datos, transferir));
  self.onmessage = (e) => recibe(e.data);
  self.postMessage({ tipo: "listo" });
}
