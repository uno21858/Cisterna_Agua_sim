// Motor de prueba con la misma API que solver.js (ver SPEC.md).
// La geometría, la bomba y la validación son idénticas a cisterna_sim; el flujo es FALSO:
// remolinos analíticos que crecen con el tiempo, y el cloro se transporta con upwind y
// difusión. Sirve para desarrollar el visor sin el CFD; no sirve para decidir nada.

export const DEFAULTS = {
  largo: 3.40, ancho: 2.45, nivel: 1.20, z_tapa: 1.35, dx: 0.10,
  q_max_lh: 800, h_max_m: 5, salida_mm: 8, boquilla_mm: 8, k_salida: 1.0,
  boca: [1.20, 1.00], angulo_tubo: 60, z_bomba: 0.50, z_orp: 0.20,
  pos_bomba: null, azimut: null, elevacion: null,
  pozo: [0.90, 1.00, 0.45], llenado: [0.25, 1.20, 1.10],
  dosis_ml: 150, cloralex_mg_ml: 50, lugar_dosis: "llenado",
  cfl: 0.4, cs: 0.17, c_nu: 0.02, sc_t: 0.7,
  consumo_lpm: 0, llenado_mm: 13, c_llenado_mg_l: 0,
};

const G = 9.81;
const K_MEZCLA = 10.2;
const RAD = Math.PI / 180;

function completa(cfg) {
  return { ...DEFAULTS, ...cfg };
}

function redondeaPar(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function puntoOperacion(q_max_lh, h_max_m, boquilla_mm, salida_mm = boquilla_mm, k_salida = 1.0) {
  if (!(q_max_lh > 0 && h_max_m > 0 && boquilla_mm > 0 && salida_mm > 0) || k_salida < 0) {
    throw new Error("q_max_lh, h_max_m, boquilla_mm y salida_mm deben ser > 0, k_salida >= 0");
  }
  const qMax = q_max_lh / 3.6e6;
  const area = Math.PI * (boquilla_mm / 1000) ** 2 / 4;
  const areaS = Math.PI * (salida_mm / 1000) ** 2 / 4;
  const a = Math.max(0, k_salida / (2 * G) * (1 / area ** 2 - 1 / areaS ** 2));
  const b = h_max_m / qMax;
  const q = a === 0 ? qMax : (-b + Math.sqrt(b * b + 4 * a * h_max_m)) / (2 * a);
  const u = q / area;
  return { q_m3s: q, q_lh: q * 3.6e6, u_ms: u, m_m4s2: q * u, h_m: h_max_m * (1 - q / qMax) };
}

export function tiempoMezclaS(vol_m3, m) {
  if (!(vol_m3 > 0 && m > 0)) throw new Error("volumen y flujo de momento deben ser > 0");
  return K_MEZCLA * vol_m3 ** (2 / 3) / Math.sqrt(m);
}

export function geometria(cfg0) {
  const cfg = completa(cfg0);
  const [bx, by] = cfg.boca;
  const ex = bx < cfg.largo / 2 ? cfg.largo : 0;
  const ey = by < cfg.ancho / 2 ? cfg.ancho : 0;
  const n = Math.hypot(ex - bx, ey - by);
  const rumbo = [(ex - bx) / n, (ey - by) / n];
  const punto_tubo = (z) => {
    const s = (cfg.z_tapa - z) / Math.tan(cfg.angulo_tubo * RAD);
    return [bx + s * rumbo[0], by + s * rumbo[1], z];
  };
  const pos_bomba = cfg.pos_bomba ? [...cfg.pos_bomba] : punto_tubo(cfg.z_bomba);
  const az = cfg.azimut == null ? Math.atan2(rumbo[1], rumbo[0]) : cfg.azimut * RAD;
  const el = cfg.elevacion == null ? -cfg.angulo_tubo * RAD : cfg.elevacion * RAD;
  const dir_chorro = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  const nh = Math.hypot(dir_chorro[0], dir_chorro[1]);
  const plano_chorro = nh > 0.1 ? [dir_chorro[0] / nh, dir_chorro[1] / nh] : rumbo;
  let punto_dosis;
  if (Array.isArray(cfg.lugar_dosis)) punto_dosis = [...cfg.lugar_dosis];
  else if (cfg.lugar_dosis === "mastil") punto_dosis = [bx, by, cfg.nivel - 0.10];
  else punto_dosis = [...cfg.llenado];
  punto_dosis[2] = Math.min(punto_dosis[2], cfg.nivel - 0.10);
  const sondas = {
    "superficie (tapa)": [bx, by, cfg.nivel - 0.10],
    "llave de la casa (pozo)": [...cfg.pozo],
    "sonda ORP": punto_tubo(cfg.z_orp),
  };
  return { rumbo, punto_tubo, pos_bomba, dir_chorro, plano_chorro, punto_dosis, sondas };
}

export function validar(cfg0) {
  const cfg = completa(cfg0);
  let errores = [];
  for (const k of ["largo", "ancho", "nivel", "dx", "q_max_lh", "h_max_m", "salida_mm", "boquilla_mm", "dosis_ml"]) {
    if (!(cfg[k] > 0)) errores.push(`${k} debe ser > 0`);
  }
  if (cfg.k_salida < 0 || cfg.c_nu < 0 || !(cfg.cloralex_mg_ml > 0)) {
    errores.push("k_salida y c_nu deben ser >= 0; cloralex_mg_ml > 0");
  }
  if (!(cfg.angulo_tubo >= 5 && cfg.angulo_tubo <= 90)) errores.push("angulo_tubo debe estar entre 5 y 90 grados");
  if (cfg.elevacion != null && !(cfg.elevacion >= -90 && cfg.elevacion <= 90)) {
    errores.push("elevacion debe estar entre -90 y 90 grados");
  }
  if (!Array.isArray(cfg.lugar_dosis) && !["llenado", "mastil"].includes(cfg.lugar_dosis)) {
    errores.push("lugar_dosis debe ser llenado, mastil o un punto [x, y, z]");
  }
  if (!(cfg.cfl > 0 && cfg.cfl <= 0.5)) errores.push("cfl debe estar en (0, 0.5]");
  if (!(cfg.consumo_lpm >= 0)) errores.push("consumo_lpm debe ser >= 0");
  if (errores.length) throw new Error(errores.join("; "));

  if (Math.min(cfg.largo, cfg.ancho, cfg.nivel) / cfg.dx < 4) {
    errores.push("dx muy grande: se necesitan al menos 4 celdas por eje");
  }
  const g = geometria(cfg);
  const zb = g.pos_bomba[2];
  if (cfg.nivel < zb + 0.10) {
    errores.push(`nivel ${cfg.nivel.toFixed(2)} m deja la bomba (a ${zb.toFixed(2)} m) casi en seco; ` +
      "en la vida real el INA219 la apagaría");
  }
  if (cfg.z_tapa <= cfg.nivel) errores.push("z_tapa debe estar arriba del nivel del agua");
  const puntos = { bomba: g.pos_bomba, "sonda ORP": g.punto_tubo(cfg.z_orp), pozo: cfg.pozo, dosis: g.punto_dosis };
  for (const [nombre, [x, y, z]] of Object.entries(puntos)) {
    if (!(x > 0 && x < cfg.largo && y > 0 && y < cfg.ancho && z > 0 && z < cfg.nivel)) {
      errores.push(`${nombre} (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) queda fuera del agua o de la cisterna`);
    }
  }
  if (errores.length) throw new Error(errores.join("; "));
}

const D_CLORO = 1.5e-3; // difusión falsa, m2/s

export class Cisterna {
  constructor(cfgParcial = {}) {
    const cfg = completa(cfgParcial);
    validar(cfg);
    this.cfg = cfg;
    this.nx = Math.max(4, redondeaPar(cfg.largo / cfg.dx));
    this.ny = Math.max(4, redondeaPar(cfg.ancho / cfg.dx));
    this.nz = Math.max(4, redondeaPar(cfg.nivel / cfg.dx));
    this.dx = cfg.largo / this.nx;
    this.dy = cfg.ancho / this.ny;
    this.dz = cfg.nivel / this.nz;
    this.volCelda = this.dx * this.dy * this.dz;
    this.delta = Math.cbrt(this.volCelda);
    const { nx, ny, nz } = this;
    this.u = new Float64Array((nx + 1) * ny * nz);
    this.v = new Float64Array(nx * (ny + 1) * nz);
    this.w = new Float64Array(nx * ny * (nz + 1));
    this.c = new Float64Array(nx * ny * nz);
    this.bomba = puntoOperacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida);
    this.t = 0;
    this.cFinal = 0;
    this.intensidad = 0;
    this.geo = geometria(cfg);
    this._flujo(0);
  }

  _flujo(fase) {
    const { nx, ny, nz, dx, dy, dz, cfg } = this;
    const L = cfg.largo, W = cfg.ancho, H = cfg.nivel;
    const amp = this.intensidad * Math.sqrt(this.bomba.m_m4s2) * 1.6;
    const [px, py, pz] = this.geo.pos_bomba;
    const d = this.geo.dir_chorro;
    const giro = d[0] * (py - W / 2) - d[1] * (px - L / 2) >= 0 ? 1 : -1;
    const ondula = 1 + 0.15 * Math.sin(fase / 23);
    const campo = (x, y, z) => {
      const sx = Math.sin(Math.PI * x / L), cx = Math.cos(Math.PI * x / L);
      const sy = Math.sin(Math.PI * y / W), cy = Math.cos(Math.PI * y / W);
      const sz = Math.sin(Math.PI * z / H), cz = Math.cos(Math.PI * z / H);
      let a = giro * amp * ondula * (0.6 + 0.4 * sz);
      let u = a * sx * cy * Math.PI / W;
      let v = -a * cx * sy * Math.PI / L;
      let w = 0.35 * amp * cz * sx * Math.sin(2 * Math.PI * y / W + fase / 40) * 0.4;
      u += 0.25 * amp * sx * cz * Math.PI / H * Math.cos(fase / 31);
      w -= 0.25 * amp * cx * sz * Math.PI / L * Math.cos(fase / 31);
      const rx = x - px, ry = y - py, rz = z - pz;
      const s = rx * d[0] + ry * d[1] + rz * d[2];
      if (s > -0.05 && s < 1.5) {
        const r2 = rx * rx + ry * ry + rz * rz - s * s;
        const ancho = 0.05 + 0.12 * Math.max(s, 0);
        const j = amp * 6 * Math.exp(-r2 / (2 * ancho * ancho)) * Math.exp(-Math.max(s, 0) / 0.8);
        u += j * d[0]; v += j * d[1]; w += j * d[2];
      }
      return [u, v, w];
    };
    for (let i = 0; i <= nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const pared = i === 0 || i === nx;
      this.u[(i * ny + j) * nz + k] = pared ? 0 : campo(i * dx, (j + 0.5) * dy, (k + 0.5) * dz)[0];
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k < nz; k++) {
      const pared = j === 0 || j === ny;
      this.v[(i * (ny + 1) + j) * nz + k] = pared ? 0 : campo((i + 0.5) * dx, j * dy, (k + 0.5) * dz)[1];
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k <= nz; k++) {
      const pared = k === 0 || k === nz;
      this.w[(i * ny + j) * (nz + 1) + k] = pared ? 0 : campo((i + 0.5) * dx, (j + 0.5) * dy, k * dz)[2];
    }
  }

  _vmax() {
    let m = 0;
    for (const a of [this.u, this.v, this.w]) for (let n = 0; n < a.length; n++) m = Math.max(m, Math.abs(a[n]));
    return m;
  }

  dtFlujo() {
    const vm = this._vmax();
    return vm > 0 ? Math.min(0.5, 0.9 * this.dx / (3 * vm)) : 0.5;
  }

  avanza(dt, { cloro = true, bomba = true } = {}) {
    const objetivo = bomba ? 1 : 0;
    const tau = bomba ? 90 : 150;
    this.intensidad += (objetivo - this.intensidad) * (1 - Math.exp(-dt / tau));
    this._flujo(this.t);
    if (cloro && this.cFinal > 0) {
      const vm = this._vmax();
      const h = Math.min(this.dx, this.dy, this.dz);
      const lim = Math.min(vm > 0 ? 0.3 * h / vm : Infinity, 0.15 * h * h / D_CLORO);
      const n = Math.max(1, Math.ceil(dt / lim));
      for (let s = 0; s < n; s++) this._pasoCloro(dt / n);
    }
    this.t += dt;
  }

  _pasoCloro(dt) {
    const { nx, ny, nz, dx, dy, dz, c } = this;
    const dc = new Float64Array(c.length);
    const id = (i, j, k) => (i * ny + j) * nz + k;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const a = id(i, j, k);
      if (i + 1 < nx) {
        const b = id(i + 1, j, k);
        const vf = this.u[((i + 1) * ny + j) * nz + k];
        const f = (vf > 0 ? vf * c[a] : vf * c[b]) - D_CLORO * (c[b] - c[a]) / dx;
        dc[a] -= f / dx; dc[b] += f / dx;
      }
      if (j + 1 < ny) {
        const b = id(i, j + 1, k);
        const vf = this.v[(i * (ny + 1) + j + 1) * nz + k];
        const f = (vf > 0 ? vf * c[a] : vf * c[b]) - D_CLORO * (c[b] - c[a]) / dy;
        dc[a] -= f / dy; dc[b] += f / dy;
      }
      if (k + 1 < nz) {
        const b = id(i, j, k + 1);
        const vf = this.w[(i * ny + j) * (nz + 1) + k + 1];
        const f = (vf > 0 ? vf * c[a] : vf * c[b]) - D_CLORO * (c[b] - c[a]) / dz;
        dc[a] -= f / dz; dc[b] += f / dz;
      }
    }
    for (let n = 0; n < c.length; n++) c[n] = Math.max(0, c[n] + dt * dc[n]);
    if (this.cfg.consumo_lpm > 0) {
      const q = this.cfg.consumo_lpm / 60000;
      const [x, y, z] = this.cfg.pozo;
      const a = id(this._ix(x, dx, nx), this._ix(y, dy, ny), this._ix(z, dz, nz));
      c[a] *= Math.max(0, 1 - q * dt / this.volCelda);
    }
  }

  _ix(p, h, n) {
    return Math.min(n - 1, Math.max(0, Math.floor(p / h)));
  }

  correr(segundos, opts) {
    const fin = this.t + segundos;
    let pasos = 0;
    while (this.t < fin - 1e-9) {
      this.avanza(Math.min(this.dtFlujo(), fin - this.t), opts);
      pasos++;
    }
    return pasos;
  }

  dosifica(masa_mg, punto, sigma) {
    const s = sigma || this.delta;
    const { nx, ny, nz, dx, dy, dz } = this;
    const w = new Float64Array(this.c.length);
    let suma = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const r2 = ((i + 0.5) * dx - punto[0]) ** 2 + ((j + 0.5) * dy - punto[1]) ** 2 + ((k + 0.5) * dz - punto[2]) ** 2;
      const n = (i * ny + j) * nz + k;
      w[n] = Math.exp(-r2 / (2 * s * s));
      suma += w[n];
    }
    for (let n = 0; n < w.length; n++) this.c[n] += masa_mg * (w[n] / suma) / (this.volCelda * 1000);
    this.cFinal += masa_mg / (nx * ny * nz * this.volCelda * 1000);
  }

  dosificaCfg() {
    this.dosifica(this.cfg.dosis_ml * this.cfg.cloralex_mg_ml, this.geo.punto_dosis);
  }

  _arreglo(campo) {
    const { nx, ny, nz } = this;
    if (campo === "u") return [this.u, nx + 1, ny, nz, 0, 0.5, 0.5];
    if (campo === "v") return [this.v, nx, ny + 1, nz, 0.5, 0, 0.5];
    if (campo === "w") return [this.w, nx, ny, nz + 1, 0.5, 0.5, 0];
    return [this.c, nx, ny, nz, 0.5, 0.5, 0.5];
  }

  muestrea(campo, x, y, z) {
    const [a, NX, NY, NZ, ox, oy, oz] = this._arreglo(campo);
    const cl = (f, n) => Math.min(Math.max(f, 0), n - 1);
    const fi = cl(x / this.dx - ox, NX), fj = cl(y / this.dy - oy, NY), fk = cl(z / this.dz - oz, NZ);
    const i0 = Math.min(Math.floor(fi), NX - 2), j0 = Math.min(Math.floor(fj), NY - 2), k0 = Math.min(Math.floor(fk), NZ - 2);
    const ti = fi - i0, tj = fj - j0, tk = fk - k0;
    const b = (i0 * NY + j0) * NZ + k0, sx = NY * NZ, sy = NZ;
    const l = (o) => a[b + o] * (1 - tk) + a[b + o + 1] * tk;
    return ((l(0) * (1 - tj) + l(sy) * tj) * (1 - ti) + (l(sx) * (1 - tj) + l(sx + sy) * tj) * ti);
  }

  velocidadEn(x, y, z) {
    return [this.muestrea("u", x, y, z), this.muestrea("v", x, y, z), this.muestrea("w", x, y, z)];
  }

  _centros() {
    const { nx, ny, nz } = this;
    const n = nx * ny * nz;
    const uc = new Float64Array(n), vc = new Float64Array(n), wc = new Float64Array(n);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const m = (i * ny + j) * nz + k;
      uc[m] = 0.5 * (this.u[(i * ny + j) * nz + k] + this.u[((i + 1) * ny + j) * nz + k]);
      vc[m] = 0.5 * (this.v[(i * (ny + 1) + j) * nz + k] + this.v[(i * (ny + 1) + j + 1) * nz + k]);
      wc[m] = 0.5 * (this.w[(i * ny + j) * (nz + 1) + k] + this.w[(i * ny + j) * (nz + 1) + k + 1]);
    }
    return [uc, vc, wc];
  }

  stats() {
    const c = this.c, n = c.length, cf = this.cFinal;
    let suma = 0, suma2 = 0, cmin = Infinity, cmax = -Infinity;
    for (let m = 0; m < n; m++) {
      const r = cf > 0 ? c[m] / cf : c[m];
      suma += r; suma2 += r * r;
      if (r < cmin) cmin = r;
      if (r > cmax) cmax = r;
    }
    const media = suma / n;
    const [uc, vc, wc] = this._centros();
    let ek = 0, vmax = 0;
    for (let m = 0; m < n; m++) {
      const q = uc[m] ** 2 + vc[m] ** 2 + wc[m] ** 2;
      ek += 0.5 * q;
      vmax = Math.max(vmax, Math.sqrt(q));
    }
    let masa = 0;
    for (let m = 0; m < n; m++) masa += c[m];
    return {
      cov: Math.sqrt(Math.max(0, suma2 / n - media * media)), cmin, cmax,
      masa_mg: masa * this.volCelda * 1000, ek: ek / n, vmax,
    };
  }

  valoresSondas() {
    const out = {};
    for (const [nombre, p] of Object.entries(this.geo.sondas)) out[nombre] = this.muestrea("c", ...p);
    return out;
  }

  planta(campo, z) {
    const { nx, ny, nz } = this;
    const data = new Float32Array(nx * ny);
    const [uc, vc, wc] = campo === "vel" ? this._centros() : [];
    const valor = (m) => campo === "vel" ? Math.hypot(uc[m], vc[m], wc[m]) : this.c[m];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      if (z === "promedio") {
        let s = 0;
        for (let k = 0; k < nz; k++) s += valor((i * ny + j) * nz + k);
        data[i * ny + j] = s / nz;
      } else {
        const k = Math.min(nz - 1, Math.max(0, Math.round(z / this.dz - 0.5)));
        data[i * ny + j] = valor((i * ny + j) * nz + k);
      }
    }
    return { nx, ny, data };
  }

  corte(eje, posicion) {
    const { nx, ny, nz } = this;
    const ni = eje === "x" ? nx : ny;
    const data = new Float32Array(ni * nz);
    for (let i = 0; i < ni; i++) for (let k = 0; k < nz; k++) {
      const z = (k + 0.5) * this.dz;
      data[i * nz + k] = eje === "x"
        ? this.muestrea("c", (i + 0.5) * this.dx, posicion, z)
        : this.muestrea("c", posicion, (i + 0.5) * this.dy, z);
    }
    return { ni, nk: nz, data };
  }

  seccionChorro(campo = "c") {
    const cfg = this.cfg;
    const [hx, hy] = this.geo.plano_chorro;
    const [x0, y0] = this.geo.pos_bomba;
    let sMin = -Infinity, sMax = Infinity;
    for (const [p0, h, L] of [[x0, hx, cfg.largo], [y0, hy, cfg.ancho]]) {
      if (Math.abs(h) > 1e-12) {
        const a = (0 - p0) / h, b = (L - p0) / h;
        sMin = Math.max(sMin, Math.min(a, b));
        sMax = Math.min(sMax, Math.max(a, b));
      }
    }
    const ns = Math.max(8, Math.floor((sMax - sMin) / Math.min(this.dx, this.dy)) + 1);
    const s = new Float32Array(ns), z = new Float32Array(this.nz);
    for (let i = 0; i < ns; i++) s[i] = sMin + (sMax - sMin) * i / (ns - 1);
    for (let k = 0; k < this.nz; k++) z[k] = (k + 0.5) * this.dz;
    const data = new Float32Array(ns * this.nz);
    for (let k = 0; k < this.nz; k++) for (let i = 0; i < ns; i++) {
      const x = x0 + s[i] * hx, y = y0 + s[i] * hy;
      if (campo === "c") data[k * ns + i] = this.muestrea("c", x, y, z[k]);
      else {
        const [u, v, w] = this.velocidadEn(x, y, z[k]);
        data[k * ns + i] = Math.hypot(u * hx + v * hy, w);
      }
    }
    return { s, z, data };
  }
}
