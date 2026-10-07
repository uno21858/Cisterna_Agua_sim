// Motor de la cisterna en JavaScript: port 1:1 de cisterna_sim (solver.py, config.py, bomba.py).
//
// Malla MAC: velocidades en las caras, presión y cloro en los centros. Cada paso:
//   1. viscosidad turbulenta de Smagorinsky más la de fondo c_nu * sqrt(M)
//   2. advección semi-lagrangiana (RK2) de la velocidad
//   3. difusión explícita y fuerza del chorro
//   4. proyección de presión exacta con DCT-II ortonormal (matrices de cosenos por eje)
//   5. transporte del cloro en forma conservativa (MUSCL + van Leer, SSP-RK2)
//
// Extensión que no existe en Python: consumo de la casa (consumo_lpm > 0). Sale agua por la
// rejilla del pozo y entra la misma por el llenado; la proyección impone div(u) = s.
//
// Arreglos planos Float64Array con índice (i * NY + j) * NZ + k, cada uno con sus dimensiones:
// u (nx+1, ny, nz), v (nx, ny+1, nz), w (nx, ny, nz+1), c (nx, ny, nz).
// Sin DOM: corre en el navegador y en Node >= 18.

export const NU_AGUA = 1.0e-6; // m2/s, ~20 C
export const DT_MAX = 0.5; // s
export const CFL_FLUJO = 0.9;
export const G = 9.81;
export const K_MEZCLA = 10.2;
export const LUGARES_DOSIS = Object.freeze(["llenado", "mastil"]);
export const FORMAS = Object.freeze(["rectangular", "redonda"]);
// Presión de la cisterna redonda: gradiente conjugado hasta max|r| <= TOL_PRESION * max|b|.
export const TOL_PRESION = 1e-8;
export const MAX_IT_PRESION = 300;

// La cisterna de Erick (7 oct): redonda, tubo vertical bajo la boca con la bomba a 50 cm y el
// chorro horizontal, sonda ORP a 20 cm, flotador junto a la bomba de pozo. Supuestos (sin medir):
// diámetro (el cilindro de 10 m3 con 1.20 m de agua), boca al centro, pozo a 30 cm de la boca,
// lado del llenado y chorro hacia +x (lejos del pozo). largo y ancho solo cuentan en la rectangular.
export const DEFAULTS = Object.freeze({
  forma: "redonda", diametro: 3.26,
  largo: 3.40, ancho: 2.45, nivel: 1.20, z_tapa: 1.35, dx: 0.10,
  q_max_lh: 800, h_max_m: 5, salida_mm: 8, boquilla_mm: 8, k_salida: 1.0,
  boca: Object.freeze([1.63, 1.63]), angulo_tubo: 90, z_bomba: 0.50, z_orp: 0.20,
  pos_bomba: null, azimut: -40, elevacion: 0,
  pozo: Object.freeze([1.33, 1.63, 0.45]), llenado: Object.freeze([1.33, 1.88, 1.10]),
  dosis_ml: 150, cloralex_mg_ml: 50, lugar_dosis: "llenado",
  cfl: 0.4, cs: 0.17, c_nu: 0.02, sc_t: 0.7,
  consumo_lpm: 0,
  llenado_mm: 13,
  c_llenado_mg_l: 0,
});

// Parámetros de corrida de Python (correr) que se aceptan y se validan si vienen.
const EXTRA_PY = ["minutos", "bomba_min", "precalentar_s", "cada_s", "cuadro_s"];

const OFF_U = [0.0, 0.5, 0.5];
const OFF_V = [0.5, 0.0, 0.5];
const OFF_W = [0.5, 0.5, 0.0];
const OFF_C = [0.5, 0.5, 0.5];

// round() de Python: la mitad va al par.
export function redondeaPy(x) {
  const f = Math.floor(x);
  const r = x - f;
  if (r > 0.5) return f + 1;
  if (r < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// ---- configuración y geometría (config.py) ----

export function configura(parcial = {}) {
  const desconocidos = Object.keys(parcial).filter((k) => !(k in DEFAULTS) && !EXTRA_PY.includes(k));
  if (desconocidos.length) throw new Error(`parámetro desconocido: ${desconocidos.join(", ")}`);
  const cfg = {};
  for (const k of [...Object.keys(DEFAULTS), ...EXTRA_PY]) {
    const v = parcial[k] !== undefined ? parcial[k] : DEFAULTS[k];
    if (v !== undefined) cfg[k] = Array.isArray(v) ? v.slice() : v;
  }
  if (cfg.forma === "redonda") cfg.largo = cfg.ancho = cfg.diametro;
  return cfg;
}

function rad(g) {
  return g * (Math.PI / 180);
}

// Hacia la esquina opuesta a la boca; en la redonda, hacia el lado opuesto (por el centro).
function rumbo(c) {
  const [bx, by] = c.boca;
  if (c.forma === "redonda") {
    const hx = c.diametro / 2 - bx, hy = c.diametro / 2 - by;
    const n = Math.hypot(hx, hy);
    return n < 1e-3 ? [1.0, 0.0] : [hx / n, hy / n];
  }
  const ex = bx < c.largo / 2 ? c.largo : 0.0;
  const ey = by < c.ancho / 2 ? c.ancho : 0.0;
  const hx = ex - bx, hy = ey - by;
  const n = Math.hypot(hx, hy);
  return [hx / n, hy / n];
}

function puntoTubo(c, z) {
  const a = rad(c.angulo_tubo);
  const [hx, hy] = rumbo(c);
  const s = (c.z_tapa - z) / Math.tan(a);
  return [c.boca[0] + s * hx, c.boca[1] + s * hy, z];
}

function posBomba(c) {
  return c.pos_bomba != null ? c.pos_bomba.slice() : puntoTubo(c, c.z_bomba);
}

function dirChorro(c) {
  const [hx, hy] = rumbo(c);
  const az = c.azimut == null ? Math.atan2(hy, hx) : rad(c.azimut);
  const el = c.elevacion == null ? -rad(c.angulo_tubo) : rad(c.elevacion);
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

function planoChorro(c) {
  const [dx, dy] = dirChorro(c);
  const n = Math.hypot(dx, dy);
  return n > 0.1 ? [dx / n, dy / n] : rumbo(c);
}

function puntoDosis(c) {
  let x, y, z;
  if (c.lugar_dosis === "mastil") {
    [x, y] = c.boca;
    z = c.nivel - 0.10;
  } else if (Array.isArray(c.lugar_dosis)) {
    [x, y, z] = c.lugar_dosis;
  } else {
    [x, y, z] = c.llenado;
  }
  return [x, y, Math.min(z, c.nivel - 0.10)];
}

function fuenteLlenado(c) {
  return [c.llenado[0], c.llenado[1], Math.min(c.llenado[2], c.nivel - 0.05)];
}

function sondas(c) {
  return {
    "superficie (tapa)": [c.boca[0], c.boca[1], c.nivel - 0.10],
    "llave de la casa (pozo)": c.pozo.slice(),
    "sonda ORP": puntoTubo(c, c.z_orp),
  };
}

export function geometria(cfgParcial = {}) {
  const c = configura(cfgParcial);
  const redonda = c.forma === "redonda", r = c.diametro / 2;
  return {
    forma: c.forma,
    centro: [c.largo / 2, c.ancho / 2],
    radio: redonda ? r : null,
    rumbo: rumbo(c),
    punto_tubo: (z) => puntoTubo(c, z),
    pos_bomba: posBomba(c),
    dir_chorro: dirChorro(c),
    plano_chorro: planoChorro(c),
    punto_dosis: puntoDosis(c),
    sondas: sondas(c),
    fuente_llenado: fuenteLlenado(c),
    volumen_m3: redonda ? Math.PI * r * r * c.nivel : c.largo * c.ancho * c.nivel,
  };
}

function esPunto(p, n) {
  return Array.isArray(p) && p.length === n && p.every((q) => typeof q === "number" && Number.isFinite(q));
}

function fmt(x) {
  return Number(x).toFixed(2);
}

export function validar(cfgParcial = {}) {
  const c = configura(cfgParcial);
  const errores = [];
  const positivos = ["diametro", "largo", "ancho", "nivel", "dx", "q_max_lh", "h_max_m", "salida_mm", "boquilla_mm",
    "minutos", "dosis_ml"];
  for (const nombre of positivos) {
    if (c[nombre] === undefined) continue;
    if (!(c[nombre] > 0)) errores.push(`${nombre} debe ser > 0`);
  }
  // en forma negada para que NaN también falle
  const noNeg = (v) => v === undefined || v >= 0;
  if (!(noNeg(c.k_salida) && noNeg(c.precalentar_s) && noNeg(c.bomba_min) && c.c_nu >= 0 && c.cs >= 0 &&
        c.cloralex_mg_ml > 0 && c.sc_t > 0)) {
    errores.push("k_salida, precalentar_s, bomba_min, c_nu y cs deben ser >= 0; cloralex_mg_ml y sc_t > 0");
  }
  if (!(c.angulo_tubo >= 5 && c.angulo_tubo <= 90)) errores.push("angulo_tubo debe estar entre 5 y 90 grados");
  if (c.elevacion != null && !(c.elevacion >= -90 && c.elevacion <= 90)) {
    errores.push("elevacion debe estar entre -90 y 90 grados");
  }
  if (!FORMAS.includes(c.forma)) errores.push('forma debe ser "rectangular" o "redonda"');
  if (!LUGARES_DOSIS.includes(c.lugar_dosis) && !esPunto(c.lugar_dosis, 3)) {
    errores.push('lugar_dosis debe ser "llenado", "mastil" o un punto [x, y, z]');
  }
  if (!(c.cfl > 0 && c.cfl <= 0.5)) errores.push("cfl debe estar en (0, 0.5]");
  if (!esPunto(c.boca, 2)) errores.push("boca debe ser [x, y]");
  for (const nombre of ["pozo", "llenado"]) {
    if (!esPunto(c[nombre], 3)) errores.push(`${nombre} debe ser [x, y, z]`);
  }
  if (c.pos_bomba != null && !esPunto(c.pos_bomba, 3)) errores.push("pos_bomba debe ser null o [x, y, z]");
  if (!(c.consumo_lpm >= 0 && c.c_llenado_mg_l >= 0)) errores.push("consumo_lpm y c_llenado_mg_l deben ser >= 0");
  if (!(c.llenado_mm > 0)) errores.push("llenado_mm debe ser > 0");
  if (errores.length) throw new Error(errores.join("; "));

  // en z la malla usa max(4, ...) por sí sola, así que la regla solo aplica en planta
  const redonda = c.forma === "redonda";
  if (redonda && c.diametro / c.dx < 8) {
    errores.push("dx muy grande: se necesitan al menos 8 celdas a lo largo del diámetro");
  } else if (Math.min(c.largo, c.ancho) / c.dx < 4) {
    errores.push("dx muy grande: se necesitan al menos 4 celdas a lo largo y a lo ancho");
  }
  const zb = posBomba(c)[2];
  if (c.nivel < zb + 0.10 - 1e-9) {
    errores.push(`nivel ${fmt(c.nivel)} m deja la bomba (a ${fmt(zb)} m) casi en seco; ` +
      "en la vida real el INA219 la apagaría");
  }
  if (c.z_tapa <= c.nivel) errores.push("z_tapa debe estar arriba del nivel del agua");
  const puntos = {
    bomba: posBomba(c), "sonda ORP": puntoTubo(c, c.z_orp), pozo: c.pozo, dosis: puntoDosis(c),
    "boca (sonda de superficie)": [c.boca[0], c.boca[1], c.nivel - 0.10],
  };
  if (c.consumo_lpm > 0) puntos.llenado = fuenteLlenado(c);
  // en la redonda, a media celda o más de la pared; con cuadrados y no con Math.hypot, que redondea
  // distinto que Python: así los dos dan el mismo veredicto en la frontera
  const r = c.diametro / 2, rMax = r - 0.5 * c.dx;
  for (const [nombre, [x, y, z]] of Object.entries(puntos)) {
    const enPlanta = redonda ? (x - r) * (x - r) + (y - r) * (y - r) <= rMax * rMax
      : x > 0 && x < c.largo && y > 0 && y < c.ancho;
    if (!(enPlanta && z > 0 && z < c.nivel)) {
      errores.push(`${nombre} (${fmt(x)}, ${fmt(y)}, ${fmt(z)}) queda fuera del agua o de la cisterna`);
    }
  }
  if (errores.length) throw new Error(errores.join("; "));
}

// ---- bomba (bomba.py) ----

export function puntoOperacion(q_max_lh, h_max_m, boquilla_mm, salida_mm = null, k_salida = 1.0) {
  if (salida_mm == null) salida_mm = boquilla_mm;
  if (q_max_lh <= 0 || h_max_m <= 0 || boquilla_mm <= 0 || salida_mm <= 0 || k_salida < 0) {
    throw new Error("q_max_lh, h_max_m, boquilla_mm y salida_mm deben ser > 0, k_salida >= 0");
  }
  const q_max = q_max_lh / 3.6e6;
  const area = Math.PI * (boquilla_mm / 1000) ** 2 / 4;
  const area_s = Math.PI * (salida_mm / 1000) ** 2 / 4;
  // h_max * (1 - Q/q_max) = k * Q^2 / (2 g) * (1/A^2 - 1/A_s^2)  ->  a Q^2 + b Q - h_max = 0
  const a = Math.max(0.0, k_salida / (2 * G) * (1 / area ** 2 - 1 / area_s ** 2));
  const b = h_max_m / q_max;
  const q = a === 0 ? q_max : (-b + Math.sqrt(b * b + 4 * a * h_max_m)) / (2 * a);
  const u = q / area;
  return { q_m3s: q, q_lh: q * 3.6e6, u_ms: u, m_m4s2: q * u, h_m: h_max_m * (1 - q / q_max) };
}

export function tiempoMezclaS(vol_m3, m) {
  if (vol_m3 <= 0 || m <= 0) throw new Error("volumen y flujo de momento deben ser > 0");
  return K_MEZCLA * vol_m3 ** (2 / 3) / Math.sqrt(m);
}

// ---- utilidades numéricas ----

// Interpolación trilineal en índices fraccionarios; fuera del arreglo toma el valor del borde.
function tri(a, ni, nj, nk, fi, fj, fk) {
  if (fi < 0) fi = 0; else if (fi > ni - 1) fi = ni - 1;
  if (fj < 0) fj = 0; else if (fj > nj - 1) fj = nj - 1;
  if (fk < 0) fk = 0; else if (fk > nk - 1) fk = nk - 1;
  let i0 = Math.floor(fi), j0 = Math.floor(fj), k0 = Math.floor(fk);
  if (i0 > ni - 2) i0 = ni - 2;
  if (j0 > nj - 2) j0 = nj - 2;
  if (k0 > nk - 2) k0 = nk - 2;
  const ti = fi - i0, tj = fj - j0, tk = fk - k0;
  const sy = nk, sx = nj * nk;
  const b = i0 * sx + j0 * sy + k0;
  const c00 = a[b] * (1 - tk) + a[b + 1] * tk;
  const c01 = a[b + sy] * (1 - tk) + a[b + sy + 1] * tk;
  const c10 = a[b + sx] * (1 - tk) + a[b + sx + 1] * tk;
  const c11 = a[b + sx + sy] * (1 - tk) + a[b + sx + sy + 1] * tk;
  return (c00 * (1 - tj) + c01 * tj) * (1 - ti) + (c10 * (1 - tj) + c11 * tj) * ti;
}

// Pesos gaussianos normalizados (suma 1) en los puntos de un arreglo; normal >= 0 excluye
// las caras de pared de ese eje y col (columnas i * nj + j, bit 1 = abierta) las cerradas.
function gaussNormalizado(dst, dims, off, h, centro, sigma, normal = -1, col = null) {
  const [ni, nj, nk] = dims;
  const den = 2 * sigma ** 2;
  let suma = 0;
  let m = 0;
  for (let i = 0; i < ni; i++) {
    const rx = (i + off[0]) * h[0] - centro[0];
    for (let j = 0; j < nj; j++) {
      const ry = (j + off[1]) * h[1] - centro[1];
      const cerrada = col !== null && !(col[i * nj + j] & 1);
      for (let k = 0; k < nk; k++, m++) {
        const rz = (k + off[2]) * h[2] - centro[2];
        const pared = cerrada || (normal === 0 && (i === 0 || i === ni - 1)) ||
          (normal === 1 && (j === 0 || j === nj - 1)) || (normal === 2 && (k === 0 || k === nk - 1));
        const wv = pared ? 0 : Math.exp(-(rx ** 2 + ry ** 2 + rz ** 2) / den);
        dst[m] = wv;
        suma += wv;
      }
    }
  }
  for (let q = 0; q < dst.length; q++) dst[q] /= suma;
  return dst;
}

// DCT-II ortonormal de largo n: C[k][j] = s_k cos(pi k (2j + 1) / 2n), inversa = transpuesta.
// Por la simetría C[k][n-1-j] = (-1)^k C[k][j] se guardan solo las mitades: las k pares actúan
// sobre x_j + x_(n-1-j) y las impares sobre x_j - x_(n-1-j), con la mitad de multiplicaciones.
export function matrizDct(n) {
  const C = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const s = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    for (let j = 0; j < n; j++) C[k * n + j] = s * Math.cos((Math.PI * ((k * (2 * j + 1)) % (4 * n))) / (2 * n));
  }
  const h = n >> 1, hm = n - h;
  const pe = new Float64Array(hm * hm), po = new Float64Array(h * h);
  const ie = new Float64Array(hm * hm), io = new Float64Array(h * h);
  for (let a = 0; a < hm; a++) {
    for (let j = 0; j < hm; j++) {
      pe[a * hm + j] = C[2 * a * n + j];
      ie[j * hm + a] = C[2 * a * n + j];
    }
  }
  for (let a = 0; a < h; a++) {
    for (let j = 0; j < h; j++) {
      po[a * h + j] = C[(2 * a + 1) * n + j];
      io[j * h + a] = C[(2 * a + 1) * n + j];
    }
  }
  return { n, C, pe, po, ie, io };
}

// dst[out + p] = sum_j M[fila + j] * src[e0 + j * de + p], p < interno (desenrollado de 4 en 4).
function combina(dst, out, src, M, fila, nn, e0, de, interno) {
  for (let p = 0; p < interno; p++) dst[out + p] = 0;
  let j = 0;
  for (; j + 3 < nn; j += 4) {
    const c0 = M[fila + j], c1 = M[fila + j + 1], c2 = M[fila + j + 2], c3 = M[fila + j + 3];
    const ea = e0 + j * de, eb = ea + de, ec = eb + de, ed = ec + de;
    for (let p = 0; p < interno; p++) {
      dst[out + p] += c0 * src[ea + p] + c1 * src[eb + p] + c2 * src[ec + p] + c3 * src[ed + p];
    }
  }
  for (; j < nn; j++) {
    const c = M[fila + j], e = e0 + j * de;
    for (let p = 0; p < interno; p++) dst[out + p] += c * src[e + p];
  }
}

// DCT (o su inversa) a lo largo del eje del medio de un arreglo (externo, n, interno).
// La directa destruye src (ahí arma sumas y diferencias); el resultado queda en dst.
function dctEje(src, dst, D, externo, interno, inversa) {
  const { n, pe, po, ie, io } = D;
  const h = n >> 1, hm = n - h;
  for (let o = 0; o < externo; o++) {
    const base = o * n * interno;
    if (!inversa) {
      for (let j = 0; j < h; j++) {
        const a0 = base + j * interno, b0 = base + (n - 1 - j) * interno;
        for (let p = 0; p < interno; p++) {
          const a = src[a0 + p], b = src[b0 + p];
          src[a0 + p] = a + b;
          src[b0 + p] = a - b;
        }
      }
      if (interno === 1) {
        for (let a = 0; a < hm; a++) {
          let s = 0;
          for (let j = 0; j < hm; j++) s += pe[a * hm + j] * src[base + j];
          dst[base + 2 * a] = s;
        }
        for (let a = 0; a < h; a++) {
          let s = 0;
          for (let j = 0; j < h; j++) s += po[a * h + j] * src[base + n - 1 - j];
          dst[base + 2 * a + 1] = s;
        }
      } else {
        // pares con las sumas (fila j), impares con las diferencias (fila n-1-j)
        for (let a = 0; a < hm; a++) combina(dst, base + 2 * a * interno, src, pe, a * hm, hm, base, interno, interno);
        for (let a = 0; a < h; a++) {
          combina(dst, base + (2 * a + 1) * interno, src, po, a * h, h, base + (n - 1) * interno, -interno, interno);
        }
      }
    } else if (interno === 1) {
      for (let j = 0; j < hm; j++) {
        let e = 0, od = 0;
        for (let a = 0; a < hm; a++) e += ie[j * hm + a] * src[base + 2 * a];
        if (j < h) {
          for (let a = 0; a < h; a++) od += io[j * h + a] * src[base + 2 * a + 1];
          dst[base + j] = e + od;
          dst[base + n - 1 - j] = e - od;
        } else {
          dst[base + j] = e;
        }
      }
    } else {
      // parte par en la fila j, impar en la n-1-j; luego se combinan
      for (let j = 0; j < hm; j++) combina(dst, base + j * interno, src, ie, j * hm, hm, base, 2 * interno, interno);
      for (let j = 0; j < h; j++) {
        combina(dst, base + (n - 1 - j) * interno, src, io, j * h, h, base + interno, 2 * interno, interno);
      }
      for (let j = 0; j < h; j++) {
        const a0 = base + j * interno, b0 = base + (n - 1 - j) * interno;
        for (let p = 0; p < interno; p++) {
          const e = dst[a0 + p], od = dst[b0 + p];
          dst[a0 + p] = e + od;
          dst[b0 + p] = e - od;
        }
      }
    }
  }
}

// Derivada como np.gradient con espaciado uniforme: centrada adentro, de un lado en los bordes.
function derivada(a, m, pos, n, paso, h) {
  if (pos === 0) return (a[m + paso] - a[m]) / h;
  if (pos === n - 1) return (a[m] - a[m - paso]) / h;
  return (a[m + paso] - a[m - paso]) / (2 * h);
}

// ---- solver (solver.py) ----

export class Cisterna {
  constructor(cfgParcial = {}) {
    const cfg = configura(cfgParcial);
    validar(cfg);
    this.cfg = cfg;
    const nx = Math.max(4, redondeaPy(cfg.largo / cfg.dx));
    const ny = Math.max(4, redondeaPy(cfg.ancho / cfg.dx));
    const nz = Math.max(4, redondeaPy(cfg.nivel / cfg.dx));
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.dx = cfg.largo / nx;
    this.dy = cfg.ancho / ny;
    this.dz = cfg.nivel / nz;
    this.volCelda = this.dx * this.dy * this.dz;
    this.delta = this.volCelda ** (1 / 3);
    const nc = nx * ny * nz;
    const nU = (nx + 1) * ny * nz, nV = nx * (ny + 1) * nz, nW = nx * ny * (nz + 1);
    this.nCeldas = nc;

    this.u = new Float64Array(nU);
    this.v = new Float64Array(nV);
    this.w = new Float64Array(nW);
    this.c = new Float64Array(nc); // cloro, mg/L
    this.nu = new Float64Array(nc).fill(NU_AGUA);
    this.nuMax = NU_AGUA;
    this.t = 0.0;
    this.cFinal = 0.0;
    this.geo = geometria(cfg);

    const h = [this.dx, this.dy, this.dz];
    this._h = h;
    this._mascaras(cfg);
    this.bomba = puntoOperacion(cfg.q_max_lh, cfg.h_max_m, cfg.boquilla_mm, cfg.salida_mm, cfg.k_salida);
    // Aceleración del chorro en cada cara; su integral en el volumen es M * dir.
    const boq = this.geo.pos_bomba, d = this.geo.dir_chorro;
    const centro = [0, 1, 2].map((q) => boq[q] + d[q] * this.delta);
    const sigma = 0.6 * this.delta;
    const m = this.bomba.m_m4s2;
    const fuerza = (n, dims, off, eje) => {
      const col = this.redonda ? [this._cu, this._cv, this._cw][eje] : null;
      const f = gaussNormalizado(new Float64Array(n), dims, off, h, centro, sigma, eje, col);
      for (let q = 0; q < n; q++) f[q] = m * d[eje] * f[q] / this.volCelda;
      return f;
    };
    this.fU = fuerza(nU, [nx + 1, ny, nz], OFF_U, 0);
    this.fV = fuerza(nV, [nx, ny + 1, nz], OFF_V, 1);
    this.fW = fuerza(nW, [nx, ny, nz + 1], OFF_W, 2);

    // Consumo de la casa: sumidero en la rejilla del pozo, fuente y chorro en el llenado.
    this.q = cfg.consumo_lpm / 60000;
    this.entrada_mg = 0.0;
    this.salida_mg = 0.0;
    this._fUon = this.fU;
    this._fVon = this.fV;
    this._fWon = this.fW;
    this._fUoff = new Float64Array(nU);
    this._fVoff = new Float64Array(nV);
    this._fWoff = new Float64Array(nW);
    this._sDiv = null;
    if (this.q > 0) {
      const fuente = this.geo.fuente_llenado, col = this._colAgua;
      const wPozo = gaussNormalizado(new Float64Array(nc), [nx, ny, nz], OFF_C, h, cfg.pozo, this.delta, -1, col);
      const wLl = gaussNormalizado(new Float64Array(nc), [nx, ny, nz], OFF_C, h, fuente, this.delta, -1, col);
      this._wPozo = wPozo;
      this._sMas = new Float64Array(nc);
      this._sMenos = new Float64Array(nc);
      this._sDiv = new Float64Array(nc);
      for (let q = 0; q < nc; q++) {
        this._sMas[q] = this.q * wLl[q] / this.volCelda;
        this._sMenos[q] = -this.q * wPozo[q] / this.volCelda;
        this._sDiv[q] = this._sMas[q] + this._sMenos[q];
      }
      this._tasaMax = 0;
      for (let q = 0; q < nc; q++) this._tasaMax = Math.max(this._tasaMax, -this._sMenos[q]);
      const area = Math.PI * (cfg.llenado_mm / 1000) ** 2 / 4;
      this.mLlenado = this.q * this.q / area;
      const wLlW = gaussNormalizado(new Float64Array(nW), [nx, ny, nz + 1], OFF_W, h, fuente, this.delta, 2, col);
      this._fWon = new Float64Array(nW);
      for (let q = 0; q < nW; q++) {
        this._fWoff[q] = -this.mLlenado * wLlW[q] / this.volCelda;
        this._fWon[q] = this.fW[q] + this._fWoff[q];
      }
    } else {
      this.mLlenado = 0;
    }
    this.fLlenado = this.q > 0 ? this._fWoff : null; // aceleración del chorro del llenado en las caras w
    // Turbulencia que la malla no resuelve: nu = C * sqrt(M) (ver config.c_nu), con M la suma de los
    // chorros que andan: la bomba y, con consumo, el del llenado (si no, apagar la bomba "mezclaría mejor").
    this.nuFondo = cfg.c_nu * Math.sqrt(this.bomba.m_m4s2 + this.mLlenado);
    this.nuFondoSinBomba = cfg.c_nu * Math.sqrt(this.mLlenado);

    // Autovalores del laplaciano discreto con Neumann (base de la DCT-II).
    this._lam = new Float64Array(nc);
    const lx = Array.from({ length: nx }, (_, i) => (2 * Math.cos((Math.PI * i) / nx) - 2) / this.dx ** 2);
    const ly = Array.from({ length: ny }, (_, j) => (2 * Math.cos((Math.PI * j) / ny) - 2) / this.dy ** 2);
    const lz = Array.from({ length: nz }, (_, k) => (2 * Math.cos((Math.PI * k) / nz) - 2) / this.dz ** 2);
    for (let i = 0, q = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++, q++) this._lam[q] = lx[i] + ly[j] + lz[k];
    }
    this._lam[0] = 1.0; // modo constante: presión definida salvo constante
    this._dct = [matrizDct(nx), matrizDct(ny), matrizDct(nz)];
    this.invH2 = 1 / this.dx ** 2 + 1 / this.dy ** 2 + 1 / this.dz ** 2;

    // Redonda: presión por gradiente conjugado con la DCT de la caja como precondicionador.
    this.p = null;
    this.tolPresion = TOL_PRESION;
    this.presion = { iteraciones: 0, residuo: 0, total: 0, proyecciones: 0 };
    this._avisoPresion = false;
    if (this.redonda) {
      this.p = new Float64Array(nc);
      this._b = new Float64Array(nc);
      this._r = new Float64Array(nc);
      this._z = new Float64Array(nc);
      this._d = new Float64Array(nc);
      this._q = new Float64Array(nc);
      // (-lap_caja) z = r  ->  z^ = r^ / (-lam), sin el modo constante
      this._invLamNeg = new Float64Array(nc);
      for (let q = 1; q < nc; q++) this._invLamNeg[q] = -1 / this._lam[q];
    }

    this._uc = new Float64Array(nc);
    this._vc = new Float64Array(nc);
    this._wc = new Float64Array(nc);
    this._un = new Float64Array(nU);
    this._vn = new Float64Array(nV);
    this._wn = new Float64Array(nW);
    this._t1 = new Float64Array(nc);
    this._t2 = new Float64Array(nc);
    this._flx = new Float64Array(nU);
    this._fly = new Float64Array(nV);
    this._flz = new Float64Array(nW);
    this._k = new Float64Array(nc);
    this._c1 = new Float64Array(nc);
    this._dif = new Float64Array(nc);
  }

  // Celdas de agua y caras abiertas por columna (la máscara no depende de k). En la rectangular
  // todo es agua y solo cierran las paredes de la caja, así que los mismos ciclos dan lo de siempre.
  //   agua[i*ny+j]          1 si la columna es agua
  //   _cw[i*ny+j]           bits: 1 agua, 2 (i-1) agua, 4 (i+1), 8 (j-1), 16 (j+1)
  //   _cu[i*ny+j]           cara u: 1 abierta, 2 cara (i, j-1) abierta, 4 (i, j+1)
  //   _cv[i*(ny+1)+j]       cara v: 1 abierta, 2 cara (i-1, j) abierta, 4 (i+1, j)
  //   _j0[i], _j1[i]        columnas de agua de la fila i: j0 <= j < j1 (el círculo es convexo)
  _mascaras(cfg) {
    const { nx, ny, nz, dx, dy } = this;
    this.redonda = cfg.forma === "redonda";
    const agua = new Uint8Array(nx * ny);
    const cx = cfg.largo / 2, cy = cfg.ancho / 2, r = cfg.diametro / 2, r2 = r * r;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const xc = (i + 0.5) * dx - cx, yc = (j + 0.5) * dy - cy;
        agua[i * ny + j] = !this.redonda || xc * xc + yc * yc <= r2 ? 1 : 0;
      }
    }
    const es = (i, j) => (i >= 0 && i < nx && j >= 0 && j < ny && agua[i * ny + j] === 1 ? 1 : 0);
    const abreU = (i, j) => (i >= 1 && i <= nx - 1 && j >= 0 && j < ny ? es(i - 1, j) & es(i, j) : 0);
    const abreV = (i, j) => (j >= 1 && j <= ny - 1 && i >= 0 && i < nx ? es(i, j - 1) & es(i, j) : 0);
    this._cw = new Uint8Array(nx * ny);
    this._cu = new Uint8Array((nx + 1) * ny);
    this._cv = new Uint8Array(nx * (ny + 1));
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) {
        if (i < nx && j < ny) {
          this._cw[i * ny + j] = es(i, j) | es(i - 1, j) << 1 | es(i + 1, j) << 2 | es(i, j - 1) << 3 | es(i, j + 1) << 4;
        }
        if (j < ny) this._cu[i * ny + j] = abreU(i, j) | abreU(i, j - 1) << 1 | abreU(i, j + 1) << 2;
        if (i < nx) this._cv[i * (ny + 1) + j] = abreV(i, j) | abreV(i - 1, j) << 1 | abreV(i + 1, j) << 2;
      }
    }
    this._j0 = new Int32Array(nx);
    this._j1 = new Int32Array(nx);
    let n = 0;
    for (let i = 0; i < nx; i++) {
      let j0 = ny, j1 = 0;
      for (let j = 0; j < ny; j++) {
        if (agua[i * ny + j]) {
          j0 = Math.min(j0, j);
          j1 = j + 1;
          n++;
        }
      }
      if (j1 === 0) j0 = 0;
      for (let j = j0; j < j1; j++) if (!agua[i * ny + j]) throw new Error("máscara de agua no convexa");
      this._j0[i] = j0;
      this._j1[i] = j1;
    }
    this.agua = agua;
    this._colAgua = this.redonda ? this._cw : null;
    this.nAgua = n * nz;
    this.volumenAgua = this.nAgua * this.volCelda; // discreto; el geométrico es geo.volumen_m3
  }

  // ---- muestreo ----

  _arreglo(campo) {
    switch (campo) {
      case "u": return [this.u, this.nx + 1, this.ny, this.nz, OFF_U];
      case "v": return [this.v, this.nx, this.ny + 1, this.nz, OFF_V];
      case "w": return [this.w, this.nx, this.ny, this.nz + 1, OFF_W];
      case "c": return [this.c, this.nx, this.ny, this.nz, OFF_C];
      default: throw new Error(`campo desconocido: ${campo}`);
    }
  }

  // En la redonda el cloro se interpola solo con las columnas de agua (pesos renormalizados): junto
  // a la pared el muro no cuenta como agua sin cloro. Las velocidades sí valen 0 en la pared.
  muestrea(campo, x, y, z) {
    const [a, ni, nj, nk, off] = this._arreglo(campo);
    const fi = x / this.dx - off[0], fj = y / this.dy - off[1], fk = z / this.dz - off[2];
    return this.redonda && campo === "c" ? this._cEnAgua(fi, fj, fk) : tri(a, ni, nj, nk, fi, fj, fk);
  }

  _cEnAgua(fi, fj, fk) {
    const { nx, ny, nz, agua, c } = this;
    fi = Math.min(Math.max(fi, 0), nx - 1);
    fj = Math.min(Math.max(fj, 0), ny - 1);
    const i0 = Math.min(Math.floor(fi), nx - 2), j0 = Math.min(Math.floor(fj), ny - 2);
    const ti = fi - i0, tj = fj - j0;
    if (agua[i0 * ny + j0] && agua[i0 * ny + j0 + 1] && agua[(i0 + 1) * ny + j0] && agua[(i0 + 1) * ny + j0 + 1]) {
      return tri(c, nx, ny, nz, fi, fj, fk);
    }
    fk = Math.min(Math.max(fk, 0), nz - 1);
    const k0 = Math.min(Math.floor(fk), nz - 2), tk = fk - k0;
    let s = 0, sp = 0;
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        if (!agua[(i0 + a) * ny + j0 + b]) continue;
        const peso = (a ? ti : 1 - ti) * (b ? tj : 1 - tj);
        const m = ((i0 + a) * ny + j0 + b) * nz + k0;
        s += peso * (c[m] * (1 - tk) + c[m + 1] * tk);
        sp += peso;
      }
    }
    return sp > 0 ? s / sp : 0;
  }

  velocidadEn(x, y, z, out = [0, 0, 0]) {
    const { nx, ny, nz, dx, dy, dz } = this;
    out[0] = tri(this.u, nx + 1, ny, nz, x / dx, y / dy - 0.5, z / dz - 0.5);
    out[1] = tri(this.v, nx, ny + 1, nz, x / dx - 0.5, y / dy, z / dz - 0.5);
    out[2] = tri(this.w, nx, ny, nz + 1, x / dx - 0.5, y / dy - 0.5, z / dz);
    return out;
  }

  valoresSondas() {
    const r = {};
    for (const [nombre, p] of Object.entries(this.geo.sondas)) r[nombre] = this.muestrea("c", p[0], p[1], p[2]);
    return r;
  }

  indiceZ(z) {
    return Math.min(Math.max(redondeaPy(z / this.dz - 0.5), 0), this.nz - 1);
  }

  // ---- flujo ----

  // Velocidad en los centros; regresa el Courant por segundo (máximo de |u|/dx + |v|/dy + |w|/dz).
  _centros() {
    const { u, v, w, nx, ny, nz, dx, dy, dz } = this;
    const uc = this._uc, vc = this._vc, wc = this._wc;
    const nyz = ny * nz;
    let cou = 0;
    for (let i = 0, m = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const iv = (i * (ny + 1) + j) * nz;
        const iw = (i * ny + j) * (nz + 1);
        for (let k = 0; k < nz; k++, m++) {
          const a = 0.5 * (u[m + nyz] + u[m]);
          const b = 0.5 * (v[iv + k + nz] + v[iv + k]);
          const e = 0.5 * (w[iw + k + 1] + w[iw + k]);
          uc[m] = a;
          vc[m] = b;
          wc[m] = e;
          const q = Math.abs(a) / dx + Math.abs(b) / dy + Math.abs(e) / dz;
          if (q > cou) cou = q;
        }
      }
    }
    return cou;
  }

  _nuTurbulenta(fondo) {
    const { u, v, w, nx, ny, nz, dx, dy, dz } = this;
    const uc = this._uc, vc = this._vc, wc = this._wc, nu = this.nu, agua = this.agua;
    const nyz = ny * nz;
    const cd2 = (this.cfg.cs * this.delta) ** 2;
    let nuMax = 0;
    // fuera del agua nu se queda en NU_AGUA: ninguna cara abierta la usa y no limita el paso
    for (let i = 0, m = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!agua[i * ny + j]) {
          m += nz;
          continue;
        }
        const iv = (i * (ny + 1) + j) * nz;
        const iw = (i * ny + j) * (nz + 1);
        for (let k = 0; k < nz; k++, m++) {
          const dudx = (u[m + nyz] - u[m]) / dx;
          const dvdy = (v[iv + k + nz] - v[iv + k]) / dy;
          const dwdz = (w[iw + k + 1] - w[iw + k]) / dz;
          const dudy = derivada(uc, m, j, ny, nz, dy), dudz = derivada(uc, m, k, nz, 1, dz);
          const dvdx = derivada(vc, m, i, nx, nyz, dx), dvdz = derivada(vc, m, k, nz, 1, dz);
          const dwdx = derivada(wc, m, i, nx, nyz, dx), dwdy = derivada(wc, m, j, ny, nz, dy);
          const s2 = 2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) +
            (dudy + dvdx) ** 2 + (dudz + dwdx) ** 2 + (dvdz + dwdy) ** 2;
          const val = NU_AGUA + cd2 * Math.sqrt(s2) + fondo;
          nu[m] = val;
          if (val > nuMax) nuMax = val;
        }
      }
    }
    this.nuMax = nuMax;
  }

  // Advección semi-lagrangiana RK2 de un arreglo de caras; salta las caras de pared del eje normal
  // y pone en 0 las columnas cerradas (col[i * nj + j], bit 1 = abierta).
  // Es la misma interpolación de tri(), escrita en línea: V8 no la integra sola y cada llamada
  // con argumentos double asignaría memoria.
  _advecta(dst, a, ni, nj, nk, off, normal, dt, col) {
    const { u, v, w, nx, ny, nz, dx, dy, dz } = this;
    const sxU = ny * nz, sxV = (ny + 1) * nz, syW = nz + 1, sxW = ny * (nz + 1), sxA = nj * nk;
    const o0 = off[0], o1 = off[1], o2 = off[2];
    const hdt = 0.5 * dt;
    const i0 = normal === 0 ? 1 : 0, i1 = normal === 0 ? ni - 1 : ni;
    const j0 = normal === 1 ? 1 : 0, j1 = normal === 1 ? nj - 1 : nj;
    const k0 = normal === 2 ? 1 : 0, k1 = normal === 2 ? nk - 1 : nk;
    for (let i = i0; i < i1; i++) {
      const x = (i + o0) * dx;
      for (let j = j0; j < j1; j++) {
        const y = (j + o1) * dy;
        let m = (i * nj + j) * nk + k0;
        if (!(col[i * nj + j] & 1)) {
          dst.fill(0, m, m + k1 - k0);
          continue;
        }
        for (let k = k0; k < k1; k++, m++) {
          const z = (k + o2) * dz;
          // Velocidad en la propia cara: la trilineal de Python cae justo en promedios de 4 caras.
          let vu, vv, vw;
          if (normal === 0) {
            const iv = ((i - 1) * (ny + 1) + j) * nz + k, iw = ((i - 1) * ny + j) * syW + k;
            vu = u[m];
            vv = 0.25 * ((v[iv] + v[iv + nz]) + (v[iv + sxV] + v[iv + sxV + nz]));
            vw = 0.25 * ((w[iw] + w[iw + 1]) + (w[iw + sxW] + w[iw + sxW + 1]));
          } else if (normal === 1) {
            const iu = (i * ny + j - 1) * nz + k, iw = (i * ny + j - 1) * syW + k;
            vu = 0.25 * ((u[iu] + u[iu + nz]) + (u[iu + sxU] + u[iu + sxU + nz]));
            vv = v[m];
            vw = 0.25 * ((w[iw] + w[iw + 1]) + (w[iw + syW] + w[iw + syW + 1]));
          } else {
            const iu = (i * ny + j) * nz + k - 1, iv = (i * (ny + 1) + j) * nz + k - 1;
            vu = 0.25 * ((u[iu] + u[iu + 1]) + (u[iu + sxU] + u[iu + sxU + 1]));
            vv = 0.25 * ((v[iv] + v[iv + 1]) + (v[iv + nz] + v[iv + nz + 1]));
            vw = w[m];
          }
          {
            const px = x - hdt * vu, py = y - hdt * vv, pz = z - hdt * vw;
            const X = px / dx, Y = py / dy, Z = pz / dz;
            // Por eje: A sin desfase (arreglo con n + 1 puntos), B con desfase de media celda (n puntos).
            let f = X < 0 ? 0 : X > nx ? nx : X;
            let iA = f | 0;
            if (iA > nx - 1) iA = nx - 1;
            const tiA = f - iA;
            f = X - 0.5;
            f = f < 0 ? 0 : f > nx - 1 ? nx - 1 : f;
            let iB = f | 0;
            if (iB > nx - 2) iB = nx - 2;
            const tiB = f - iB;
            f = Y < 0 ? 0 : Y > ny ? ny : Y;
            let jA = f | 0;
            if (jA > ny - 1) jA = ny - 1;
            const tjA = f - jA;
            f = Y - 0.5;
            f = f < 0 ? 0 : f > ny - 1 ? ny - 1 : f;
            let jB = f | 0;
            if (jB > ny - 2) jB = ny - 2;
            const tjB = f - jB;
            f = Z < 0 ? 0 : Z > nz ? nz : Z;
            let kA = f | 0;
            if (kA > nz - 1) kA = nz - 1;
            const tkA = f - kA;
            f = Z - 0.5;
            f = f < 0 ? 0 : f > nz - 1 ? nz - 1 : f;
            let kB = f | 0;
            if (kB > nz - 2) kB = nz - 2;
            const tkB = f - kB;

            let b = (iA * ny + jB) * nz + kB;
            let c00 = u[b] * (1 - tkB) + u[b + 1] * tkB;
            let c01 = u[b + nz] * (1 - tkB) + u[b + nz + 1] * tkB;
            let c10 = u[b + sxU] * (1 - tkB) + u[b + sxU + 1] * tkB;
            let c11 = u[b + sxU + nz] * (1 - tkB) + u[b + sxU + nz + 1] * tkB;
            vu = (c00 * (1 - tjB) + c01 * tjB) * (1 - tiA) + (c10 * (1 - tjB) + c11 * tjB) * tiA;

            b = (iB * (ny + 1) + jA) * nz + kB;
            c00 = v[b] * (1 - tkB) + v[b + 1] * tkB;
            c01 = v[b + nz] * (1 - tkB) + v[b + nz + 1] * tkB;
            c10 = v[b + sxV] * (1 - tkB) + v[b + sxV + 1] * tkB;
            c11 = v[b + sxV + nz] * (1 - tkB) + v[b + sxV + nz + 1] * tkB;
            vv = (c00 * (1 - tjA) + c01 * tjA) * (1 - tiB) + (c10 * (1 - tjA) + c11 * tjA) * tiB;

            b = (iB * ny + jB) * syW + kA;
            c00 = w[b] * (1 - tkA) + w[b + 1] * tkA;
            c01 = w[b + syW] * (1 - tkA) + w[b + syW + 1] * tkA;
            c10 = w[b + sxW] * (1 - tkA) + w[b + sxW + 1] * tkA;
            c11 = w[b + sxW + syW] * (1 - tkA) + w[b + sxW + syW + 1] * tkA;
            vw = (c00 * (1 - tjB) + c01 * tjB) * (1 - tiB) + (c10 * (1 - tjB) + c11 * tjB) * tiB;
          }

          let fi = (x - dt * vu) / dx - o0, fj = (y - dt * vv) / dy - o1, fk = (z - dt * vw) / dz - o2;
          fi = fi < 0 ? 0 : fi > ni - 1 ? ni - 1 : fi;
          fj = fj < 0 ? 0 : fj > nj - 1 ? nj - 1 : fj;
          fk = fk < 0 ? 0 : fk > nk - 1 ? nk - 1 : fk;
          let ia = fi | 0, ja = fj | 0, ka = fk | 0;
          if (ia > ni - 2) ia = ni - 2;
          if (ja > nj - 2) ja = nj - 2;
          if (ka > nk - 2) ka = nk - 2;
          const ti = fi - ia, tj = fj - ja, tk = fk - ka;
          const b = (ia * nj + ja) * nk + ka;
          const c00 = a[b] * (1 - tk) + a[b + 1] * tk;
          const c01 = a[b + nk] * (1 - tk) + a[b + nk + 1] * tk;
          const c10 = a[b + sxA] * (1 - tk) + a[b + sxA + 1] * tk;
          const c11 = a[b + sxA + nk] * (1 - tk) + a[b + sxA + nk + 1] * tk;
          dst[m] = (c00 * (1 - tj) + c01 * tj) * (1 - ti) + (c10 * (1 - tj) + c11 * tj) * ti;
        }
      }
    }
  }

  // Difusión explícita con celdas fantasma (-1 sin deslizamiento, +1 desliza) y fuerza, solo en
  // caras abiertas. Un vecino tangencial cerrado (pared de la caja o escalón del círculo) es
  // fantasma -u; uno normal cerrado vale 0 en el arreglo.
  _difundeU(dt, f) {
    const { nx, ny, nz } = this;
    const a = this.u, dst = this._un, nu = this.nu, cu = this._cu;
    const dx2 = this.dx ** 2, dy2 = this.dy ** 2, dz2 = this.dz ** 2;
    const nyz = ny * nz;
    for (let i = 1; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const g = cu[i * ny + j];
        if (!(g & 1)) continue;
        const jmOk = g & 2, jpOk = g & 4;
        let m = (i * ny + j) * nz;
        for (let k = 0; k < nz; k++, m++) {
          const a0 = a[m];
          const jm = jmOk ? a[m - nz] : -a0, jp = jpOk ? a[m + nz] : -a0;
          const km = k > 0 ? a[m - 1] : -a0, kp = k < nz - 1 ? a[m + 1] : a0;
          const lap = (a[m + nyz] - 2 * a0 + a[m - nyz]) / dx2 + (jp - 2 * a0 + jm) / dy2 + (kp - 2 * a0 + km) / dz2;
          dst[m] += dt * (0.5 * (nu[m] + nu[m - nyz]) * lap + f[m]);
        }
      }
    }
  }

  _difundeV(dt, f) {
    const { nx, ny, nz } = this;
    const a = this.v, dst = this._vn, nu = this.nu, cv = this._cv;
    const dx2 = this.dx ** 2, dy2 = this.dy ** 2, dz2 = this.dz ** 2;
    const si = (ny + 1) * nz;
    for (let i = 0; i < nx; i++) {
      for (let j = 1; j < ny; j++) {
        const g = cv[i * (ny + 1) + j];
        if (!(g & 1)) continue;
        const imOk = g & 2, ipOk = g & 4;
        let m = (i * (ny + 1) + j) * nz;
        let mc = (i * ny + j) * nz;
        for (let k = 0; k < nz; k++, m++, mc++) {
          const a0 = a[m];
          const im = imOk ? a[m - si] : -a0, ip = ipOk ? a[m + si] : -a0;
          const km = k > 0 ? a[m - 1] : -a0, kp = k < nz - 1 ? a[m + 1] : a0;
          const lap = (ip - 2 * a0 + im) / dx2 + (a[m + nz] - 2 * a0 + a[m - nz]) / dy2 + (kp - 2 * a0 + km) / dz2;
          dst[m] += dt * (0.5 * (nu[mc] + nu[mc - nz]) * lap + f[m]);
        }
      }
    }
  }

  _difundeW(dt, f) {
    const { nx, ny, nz } = this;
    const a = this.w, dst = this._wn, nu = this.nu, cw = this._cw;
    const dx2 = this.dx ** 2, dy2 = this.dy ** 2, dz2 = this.dz ** 2;
    const nz1 = nz + 1, si = ny * nz1;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const g = cw[i * ny + j];
        if (!(g & 1)) continue;
        const imOk = g & 2, ipOk = g & 4, jmOk = g & 8, jpOk = g & 16;
        let m = (i * ny + j) * nz1 + 1;
        let mc = (i * ny + j) * nz + 1;
        for (let k = 1; k < nz; k++, m++, mc++) {
          const a0 = a[m];
          const im = imOk ? a[m - si] : -a0, ip = ipOk ? a[m + si] : -a0;
          const jm = jmOk ? a[m - nz1] : -a0, jp = jpOk ? a[m + nz1] : -a0;
          const lap = (ip - 2 * a0 + im) / dx2 + (jp - 2 * a0 + jm) / dy2 + (a[m + 1] - 2 * a0 + a[m - 1]) / dz2;
          dst[m] += dt * (0.5 * (nu[mc] + nu[mc - 1]) * lap + f[m]);
        }
      }
    }
  }

  _ceroParedes() {
    const { nx, ny, nz } = this;
    const un = this._un, vn = this._vn, wn = this._wn;
    const nyz = ny * nz;
    for (let q = 0; q < nyz; q++) {
      un[q] = 0;
      un[nx * nyz + q] = 0;
    }
    for (let i = 0; i < nx; i++) {
      const b = i * (ny + 1) * nz;
      for (let k = 0; k < nz; k++) {
        vn[b + k] = 0;
        vn[b + ny * nz + k] = 0;
      }
    }
    for (let b = 0; b < nx * ny * (nz + 1); b += nz + 1) {
      wn[b] = 0;
      wn[b + nz] = 0;
    }
  }

  // DCT-II ortonormal en 3D (o su inversa); src y dst se usan de ida y vuelta, el resultado queda en dst.
  _dct3(src, dst, inversa) {
    const { nx, ny, nz } = this;
    const d = this._dct;
    dctEje(src, dst, d[0], 1, ny * nz, inversa);
    dctEje(dst, src, d[1], nx, nz, inversa);
    dctEje(src, dst, d[2], nx * ny, 1, inversa);
  }

  // Resuelve lap(p) = (div(u*) - s) / dt y corrige: div(u) = s (s = 0 sin consumo).
  _proyecta(dt) {
    if (this.redonda) {
      this._proyectaRedonda(dt);
      return;
    }
    const { nx, ny, nz, dx, dy, dz } = this;
    const un = this._un, vn = this._vn, wn = this._wn;
    const rhs = this._t1, ph = this._t2, s = this._sDiv;
    const nyz = ny * nz;
    for (let i = 0, m = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const iv = (i * (ny + 1) + j) * nz;
        const iw = (i * ny + j) * (nz + 1);
        for (let k = 0; k < nz; k++, m++) {
          const div = (un[m + nyz] - un[m]) / dx + (vn[iv + k + nz] - vn[iv + k]) / dy + (wn[iw + k + 1] - wn[iw + k]) / dz;
          rhs[m] = s === null ? div / dt : (div - s[m]) / dt;
        }
      }
    }
    this._dct3(rhs, ph, false);
    const lam = this._lam;
    for (let m = 0; m < ph.length; m++) ph[m] /= lam[m];
    ph[0] = 0.0;
    this._dct3(ph, rhs, true);
    const p = rhs;
    for (let i = 1; i < nx; i++) {
      for (let m = i * nyz; m < (i + 1) * nyz; m++) un[m] -= dt * (p[m] - p[m - nyz]) / dx;
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 1; j < ny; j++) {
        const iv = (i * (ny + 1) + j) * nz, mc = (i * ny + j) * nz;
        for (let k = 0; k < nz; k++) vn[iv + k] -= dt * (p[mc + k] - p[mc + k - nz]) / dy;
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const iw = (i * ny + j) * (nz + 1), mc = (i * ny + j) * nz;
        for (let k = 1; k < nz; k++) wn[iw + k] -= dt * (p[mc + k] - p[mc + k - 1]) / dz;
      }
    }
  }

  // out = -A p en las celdas de agua, con A p = suma sobre caras abiertas de (p_vecino - p) / h^2.
  // Un vecino cerrado apunta a la propia celda (desplazamiento 0) y no aporta.
  _menosA(p, out) {
    const { nx, ny, nz } = this;
    const cw = this._cw, j0 = this._j0, j1 = this._j1;
    const ix2 = 1 / this.dx ** 2, iy2 = 1 / this.dy ** 2, iz2 = 1 / this.dz ** 2;
    const nyz = ny * nz;
    for (let i = 0; i < nx; i++) {
      for (let j = j0[i]; j < j1[i]; j++) {
        const g = cw[i * ny + j];
        const oxm = g & 2 ? -nyz : 0, oxp = g & 4 ? nyz : 0, oym = g & 8 ? -nz : 0, oyp = g & 16 ? nz : 0;
        let m = (i * ny + j) * nz;
        for (let k = 0; k < nz; k++, m++) {
          const p0 = p[m];
          let a = ((p[m + oxm] - p0) + (p[m + oxp] - p0)) * ix2 + ((p[m + oym] - p0) + (p[m + oyp] - p0)) * iy2;
          if (k > 0) a += (p[m - 1] - p0) * iz2;
          if (k < nz - 1) a += (p[m + 1] - p0) * iz2;
          out[m] = -a;
        }
      }
    }
  }

  // Precondicionador: (-lap_caja) z = r con r extendida con 0 fuera del agua (DCT exacta), luego
  // z = 0 fuera del agua y sin su media sobre el agua.
  _precondiciona(r, z) {
    const { ny, nz } = this;
    const t1 = this._t1, t2 = this._t2, il = this._invLamNeg, j0 = this._j0, j1 = this._j1;
    t1.set(r);
    this._dct3(t1, t2, false);
    for (let m = 0; m < t2.length; m++) t2[m] *= il[m];
    this._dct3(t2, t1, true);
    let s = 0;
    for (let i = 0; i < this.nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) s += t1[m];
    }
    const media = s / this.nAgua;
    for (let i = 0; i < this.nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) z[m] = t1[m] - media;
    }
  }

  _puntoAgua(a, b) {
    const { ny, nz } = this;
    const j0 = this._j0, j1 = this._j1;
    let s = 0;
    for (let i = 0; i < this.nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) s += a[m] * b[m];
    }
    return s;
  }

  // Cisterna redonda: (-A) p = -b en las celdas de agua con gradiente conjugado precondicionado,
  // arrancando de la p del paso anterior; b = (div(u*) - s) / dt sin su media sobre el agua.
  // Los vectores del gradiente conjugado solo se escriben en el agua: afuera siempre valen 0.
  _proyectaRedonda(dt) {
    const { nx, ny, nz, dx, dy, dz } = this;
    const un = this._un, vn = this._vn, wn = this._wn, s = this._sDiv;
    const p = this.p, b = this._b, r = this._r, z = this._z, d = this._d, q = this._q;
    const cu = this._cu, cv = this._cv, j0 = this._j0, j1 = this._j1;
    const nyz = ny * nz;
    let suma = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = j0[i]; j < j1[i]; j++) {
        let m = (i * ny + j) * nz;
        const iv = (i * (ny + 1) + j) * nz;
        const iw = (i * ny + j) * (nz + 1);
        for (let k = 0; k < nz; k++, m++) {
          const div = (un[m + nyz] - un[m]) / dx + (vn[iv + k + nz] - vn[iv + k]) / dy + (wn[iw + k + 1] - wn[iw + k]) / dz;
          const val = s === null ? div / dt : (div - s[m]) / dt;
          b[m] = val;
          suma += val;
        }
      }
    }
    const media = suma / this.nAgua;
    let bMax = 0;
    for (let i = 0; i < nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) {
        b[m] -= media;
        const a = Math.abs(b[m]);
        if (a > bMax) bMax = a;
      }
    }
    const est = this.presion;
    est.proyecciones++;
    if (bMax === 0) {
      p.fill(0);
      est.iteraciones = 0;
      est.residuo = 0;
      return;
    }

    // r = -b - (-A) p
    this._menosA(p, q);
    let rMax = 0;
    for (let i = 0; i < nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) {
        r[m] = -b[m] - q[m];
        const a = Math.abs(r[m]);
        if (a > rMax) rMax = a;
      }
    }
    const lim = this.tolPresion * bMax;
    let it = 0;
    if (rMax > lim) {
      this._precondiciona(r, z);
      d.set(z);
      let rz = this._puntoAgua(r, z);
      for (;;) {
        it++;
        this._menosA(d, q);
        const alfa = rz / this._puntoAgua(d, q);
        rMax = 0;
        for (let i = 0; i < nx; i++) {
          for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) {
            p[m] += alfa * d[m];
            r[m] -= alfa * q[m];
            const a = Math.abs(r[m]);
            if (a > rMax) rMax = a;
          }
        }
        if (rMax <= lim || it >= MAX_IT_PRESION) break;
        this._precondiciona(r, z);
        const rzNuevo = this._puntoAgua(r, z);
        const beta = rzNuevo / rz;
        rz = rzNuevo;
        for (let i = 0; i < nx; i++) {
          for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) d[m] = z[m] + beta * d[m];
        }
      }
    }
    est.iteraciones = it;
    est.residuo = rMax / bMax;
    est.total += it;
    if (rMax > lim && !this._avisoPresion) {
      this._avisoPresion = true;
      console.warn(`presión: el gradiente conjugado no llegó a la tolerancia en ${MAX_IT_PRESION} iteraciones ` +
        `(residuo relativo ${est.residuo.toExponential(2)})`);
    }

    for (let i = 1; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!(cu[i * ny + j] & 1)) continue;
        const m0 = (i * ny + j) * nz;
        for (let m = m0; m < m0 + nz; m++) un[m] -= dt * (p[m] - p[m - nyz]) / dx;
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 1; j < ny; j++) {
        if (!(cv[i * (ny + 1) + j] & 1)) continue;
        const iv = (i * (ny + 1) + j) * nz, mc = (i * ny + j) * nz;
        for (let k = 0; k < nz; k++) vn[iv + k] -= dt * (p[mc + k] - p[mc + k - nz]) / dy;
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = j0[i]; j < j1[i]; j++) {
        const iw = (i * ny + j) * (nz + 1), mc = (i * ny + j) * nz;
        for (let k = 1; k < nz; k++) wn[iw + k] -= dt * (p[mc + k] - p[mc + k - 1]) / dz;
      }
    }
  }

  _pasoFlujo(dt, encendida) {
    const { nx, ny, nz } = this;
    this._centros();
    this._nuTurbulenta(encendida ? this.nuFondo : this.nuFondoSinBomba);
    this._advecta(this._un, this.u, nx + 1, ny, nz, OFF_U, 0, dt, this._cu);
    this._advecta(this._vn, this.v, nx, ny + 1, nz, OFF_V, 1, dt, this._cv);
    this._advecta(this._wn, this.w, nx, ny, nz + 1, OFF_W, 2, dt, this._cw);
    this._difundeU(dt, encendida ? this._fUon : this._fUoff);
    this._difundeV(dt, encendida ? this._fVon : this._fVoff);
    this._difundeW(dt, encendida ? this._fWon : this._fWoff);
    this._ceroParedes();
    this._proyecta(dt);
    this.u.set(this._un);
    this.v.set(this._vn);
    this.w.set(this._wn);
  }

  divergencia() {
    const { u, v, w, nx, ny, nz, dx, dy, dz } = this;
    const out = new Float64Array(this.nCeldas);
    const nyz = ny * nz;
    for (let i = 0, m = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const iv = (i * (ny + 1) + j) * nz;
        const iw = (i * ny + j) * (nz + 1);
        for (let k = 0; k < nz; k++, m++) {
          out[m] = (u[m + nyz] - u[m]) / dx + (v[iv + k + nz] - v[iv + k]) / dy + (w[iw + k + 1] - w[iw + k]) / dz;
        }
      }
    }
    return out;
  }

  // Divergencia objetivo s (1/s) en cada celda; ceros sin consumo.
  divergenciaObjetivo() {
    return this._sDiv ? this._sDiv.slice() : new Float64Array(this.nCeldas);
  }

  // ---- cloro ----

  // Flujo MUSCL con limitador van Leer: solo hace falta la pendiente de la celda de barlovento.
  // Pendiente de van Leer: 2ab/(a+b) si a y b tienen el mismo signo; un vecino fuera del agua (o
  // de la caja) toma el valor de la celda propia. Las caras cerradas nunca se escriben: flujo 0.
  _dcdt(c, out) {
    const { u, v, w, nx, ny, nz, dx, dy, dz } = this;
    const d = this._dif, fx = this._flx, fy = this._fly, fz = this._flz;
    const cu = this._cu, cv = this._cv, cw = this._cw;
    const nyz = ny * nz, ny1 = ny + 1, nz1 = nz + 1;

    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < ny; j++) {
        if (!(cu[(i + 1) * ny + j] & 1)) continue;
        const atrasOk = cw[i * ny + j] & 2, adelanteOk = cw[(i + 1) * ny + j] & 4;
        let m = (i * ny + j) * nz;
        for (let k = 0; k < nz; k++, m++) {
          const mp = m + nyz, c0 = c[m], c1 = c[mp], vf = u[mp];
          let cf;
          if (vf > 0) {
            const a = atrasOk ? c0 - c[m - nyz] : 0, b = c1 - c0, ab = a * b;
            cf = c0 + 0.5 * (ab > 0 ? 2 * ab / (a + b) : 0.0);
          } else {
            const a = c1 - c0, b = adelanteOk ? c[mp + nyz] - c1 : 0, ab = a * b;
            cf = c1 - 0.5 * (ab > 0 ? 2 * ab / (a + b) : 0.0);
          }
          fx[mp] = vf * cf - 0.5 * (d[m] + d[mp]) * (c1 - c0) / dx;
        }
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny - 1; j++) {
        if (!(cv[i * ny1 + j + 1] & 1)) continue;
        const atrasOk = cw[i * ny + j] & 8, adelanteOk = cw[i * ny + j + 1] & 16;
        let m = (i * ny + j) * nz;
        const iv = (i * ny1 + j + 1) * nz;
        for (let k = 0; k < nz; k++, m++) {
          const mp = m + nz, c0 = c[m], c1 = c[mp], vf = v[iv + k];
          let cf;
          if (vf > 0) {
            const a = atrasOk ? c0 - c[m - nz] : 0, b = c1 - c0, ab = a * b;
            cf = c0 + 0.5 * (ab > 0 ? 2 * ab / (a + b) : 0.0);
          } else {
            const a = c1 - c0, b = adelanteOk ? c[mp + nz] - c1 : 0, ab = a * b;
            cf = c1 - 0.5 * (ab > 0 ? 2 * ab / (a + b) : 0.0);
          }
          fy[iv + k] = vf * cf - 0.5 * (d[m] + d[mp]) * (c1 - c0) / dy;
        }
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!(cw[i * ny + j] & 1)) continue;
        const mb = (i * ny + j) * nz;
        const iw = (i * ny + j) * nz1 + 1;
        for (let k = 0; k < nz - 1; k++) {
          const m = mb + k, mp = m + 1, c0 = c[m], c1 = c[mp], vf = w[iw + k];
          let cf;
          if (vf > 0) {
            const a = k > 0 ? c0 - c[m - 1] : 0, b = c1 - c0, ab = a * b;
            cf = c0 + 0.5 * (ab > 0 ? 2 * ab / (a + b) : 0.0);
          } else {
            const a = c1 - c0, b = k < nz - 2 ? c[mp + 1] - c1 : 0, ab = a * b;
            cf = c1 - 0.5 * (ab > 0 ? 2 * ab / (a + b) : 0.0);
          }
          fz[iw + k] = vf * cf - 0.5 * (d[m] + d[mp]) * (c1 - c0) / dz;
        }
      }
    }

    const consumo = this.q > 0;
    const sMas = this._sMas, sMenos = this._sMenos, cin = this.cfg.c_llenado_mg_l;
    for (let i = 0, m = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!(cw[i * ny + j] & 1)) {
          out.fill(0, m, m + nz);
          m += nz;
          continue;
        }
        const iv = (i * ny1 + j) * nz;
        const iw = (i * ny + j) * nz1;
        for (let k = 0; k < nz; k++, m++) {
          let o = -((fx[m + nyz] - fx[m]) / dx);
          o -= (fy[iv + k + nz] - fy[iv + k]) / dy;
          o -= (fz[iw + k + 1] - fz[iw + k]) / dz;
          if (consumo) o += sMas[m] * cin + sMenos[m] * c[m];
          out[m] = o;
        }
      }
    }
  }

  _cPozo(c) {
    const wp = this._wPozo;
    let s = 0;
    for (let m = 0; m < c.length; m++) s += wp[m] * c[m];
    return s;
  }

  _pasoCloro(dt) {
    const c = this.c, c1 = this._c1, k = this._k, n = c.length;
    this._dcdt(c, k);
    for (let m = 0; m < n; m++) c1[m] = c[m] + dt * k[m];
    if (this.q > 0) {
      // d(masa)/dt = Q c_in - Q c(pozo), integrado con los mismos pesos de SSP-RK2.
      const qL = this.q * 1000.0;
      this.entrada_mg += dt * qL * this.cfg.c_llenado_mg_l;
      this.salida_mg += 0.5 * dt * qL * (this._cPozo(c) + this._cPozo(c1));
    }
    this._dcdt(c1, k);
    for (let m = 0; m < n; m++) c[m] = 0.5 * (c[m] + c1[m] + dt * k[m]);
  }

  dosifica(masa_mg, punto, sigma) {
    const { nx, ny, nz } = this;
    const wv = gaussNormalizado(this._c1, [nx, ny, nz], OFF_C, this._h, punto, sigma || this.delta, -1, this._colAgua);
    const c = this.c, den = this.volCelda * 1000.0;
    for (let m = 0; m < c.length; m++) c[m] += masa_mg * wv[m] / den; // mg / L
    this.cFinal += masa_mg / (this.nAgua * this.volCelda * 1000.0);
  }

  dosificaCfg() {
    this.dosifica(this.cfg.dosis_ml * this.cfg.cloralex_mg_ml, this.geo.punto_dosis);
  }

  // Toma el flujo y el cloro de otra cisterna con la misma malla (p. ej. al mover la bomba sin
  // reiniciar el agua). Regresa false y no copia nada si las mallas no coinciden.
  copiaEstado(otra) {
    if (otra.nx !== this.nx || otra.ny !== this.ny || otra.nz !== this.nz || otra.redonda !== this.redonda) return false;
    if (this.redonda) this.p.set(otra.p);
    this.u.set(otra.u);
    this.v.set(otra.v);
    this.w.set(otra.w);
    this.c.set(otra.c);
    this.nu.set(otra.nu);
    this.nuMax = otra.nuMax;
    this.t = otra.t;
    this.cFinal = otra.cFinal;
    this.entrada_mg = otra.entrada_mg;
    this.salida_mg = otra.salida_mg;
    return true;
  }

  // ---- control de paso ----

  // La advección semi-lagrangiana aguanta Courant ~1; la difusión explícita no.
  dtFlujo() {
    const dt = Math.min(DT_MAX, 0.4 / (this.nuMax * this.invH2));
    const cou = this._centros();
    return cou > 0 ? Math.min(dt, CFL_FLUJO / cou) : dt;
  }

  // MUSCL explícito: Courant total <= cfl y difusión estable (y sumidero estable con consumo).
  dtCloro() {
    let dt = 0.4 / (this.nuMax / this.cfg.sc_t * this.invH2);
    const cou = this._centros();
    if (cou > 0) dt = Math.min(dt, this.cfg.cfl / cou);
    if (this.q > 0) dt = Math.min(dt, 0.5 / this._tasaMax);
    return dt;
  }

  avanza(dt, opts) {
    const cloro = opts === undefined || opts.cloro === undefined ? true : !!opts.cloro;
    const bomba = opts === undefined || opts.bomba === undefined ? true : !!opts.bomba;
    this._pasoFlujo(dt, bomba);
    if (cloro) {
      const dtc = this.dtCloro();
      if (!(dtc > 0 && Number.isFinite(dtc))) throw new Error(`paso del cloro inválido (${dtc}): revisa sc_t y c_nu`);
      const n = Math.max(1, Math.ceil(dt / dtc));
      const nu = this.nu, dif = this._dif, sc = this.cfg.sc_t;
      for (let m = 0; m < nu.length; m++) dif[m] = nu[m] / sc;
      for (let q = 0; q < n; q++) this._pasoCloro(dt / n);
    }
    this.t += dt;
  }

  correr(segundos, opts) {
    let pasos = 0;
    const fin = this.t + segundos;
    while (this.t < fin - 1e-9) {
      const dt = Math.min(this.dtFlujo(), fin - this.t);
      this.avanza(Math.max(dt, 1e-6), opts);
      pasos++;
    }
    return pasos;
  }

  // ---- diagnósticos ----

  masaCloroMg() {
    let s = 0;
    for (let m = 0; m < this.c.length; m++) s += this.c[m];
    return s * this.volCelda * 1000.0;
  }

  energiaCinetica() {
    this._centros();
    const uc = this._uc, vc = this._vc, wc = this._wc, { ny, nz } = this, j0 = this._j0, j1 = this._j1;
    let s = 0;
    for (let i = 0; i < this.nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) s += uc[m] ** 2 + vc[m] ** 2 + wc[m] ** 2;
    }
    return 0.5 * (s / this.nAgua);
  }

  // Solo sobre las celdas de agua. cov = desviación / media actual (con consumo la media baja);
  // cmin y cmax relativos a cFinal (en mg/L si todavía no hay dosis); cmedia en mg/L.
  stats() {
    const c = this.c, n = this.nAgua, cf = this.cFinal, { nx, ny, nz } = this, j0 = this._j0, j1 = this._j1;
    let sumaC = 0, suma = 0, cmin = Infinity, cmax = -Infinity;
    for (let i = 0; i < nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) {
        const r = cf > 0 ? c[m] / cf : c[m];
        sumaC += c[m];
        suma += r;
        if (r < cmin) cmin = r;
        if (r > cmax) cmax = r;
      }
    }
    const media = suma / n;
    let var2 = 0;
    for (let i = 0; i < nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) {
        var2 += ((cf > 0 ? c[m] / cf : c[m]) - media) ** 2;
      }
    }
    this._centros();
    const uc = this._uc, vc = this._vc, wc = this._wc;
    let ek = 0, v2max = 0;
    for (let i = 0; i < nx; i++) {
      for (let m = (i * ny + j0[i]) * nz, fin = (i * ny + j1[i]) * nz; m < fin; m++) {
        const q = uc[m] ** 2 + vc[m] ** 2 + wc[m] ** 2;
        ek += q;
        if (q > v2max) v2max = q;
      }
    }
    return {
      cov: media > 0 ? Math.sqrt(var2 / n) / media : 0, cmin, cmax,
      masa_mg: sumaC * this.volCelda * 1000.0,
      ek: 0.5 * (ek / n), vmax: Math.sqrt(v2max),
      cmedia: sumaC / n,
    };
  }

  // Planta: data[i * ny + j] en los centros de celda. campo "c" (mg/L) o "vel" (rapidez 3D, m/s,
  // más u, v, w); z en m (interpola entre capas) o "promedio" (promedio de la columna).
  planta(campo = "c", z = "promedio") {
    const { nx, ny, nz } = this;
    const vel = campo === "vel";
    if (!vel && campo !== "c") throw new Error(`campo desconocido: ${campo}`);
    let pesos;
    if (z === "promedio") {
      pesos = new Float64Array(nz).fill(1 / nz);
    } else {
      pesos = new Float64Array(nz);
      const fk = Math.min(Math.max(z / this.dz - 0.5, 0), nz - 1);
      const k0 = Math.min(Math.floor(fk), nz - 2), t = fk - k0;
      pesos[k0] = 1 - t;
      pesos[k0 + 1] = t;
    }
    const data = new Float32Array(nx * ny);
    const pu = vel ? new Float32Array(nx * ny) : null;
    const pv = vel ? new Float32Array(nx * ny) : null;
    const pw = vel ? new Float32Array(nx * ny) : null;
    if (vel) this._centros();
    const uc = this._uc, vc = this._vc, wc = this._wc, c = this.c;
    for (let q = 0; q < nx * ny; q++) {
      let s = 0, su = 0, sv = 0, sw = 0;
      for (let k = 0; k < nz; k++) {
        const pk = pesos[k];
        if (pk === 0) continue;
        const m = q * nz + k;
        if (vel) {
          s += pk * Math.sqrt(uc[m] ** 2 + vc[m] ** 2 + wc[m] ** 2);
          su += pk * uc[m];
          sv += pk * vc[m];
          sw += pk * wc[m];
        } else {
          s += pk * c[m];
        }
      }
      data[q] = s;
      if (vel) {
        pu[q] = su;
        pv[q] = sv;
        pw[q] = sw;
      }
    }
    const r = { nx, ny, data };
    if (vel) Object.assign(r, { u: pu, v: pv, w: pw });
    return r;
  }

  // Corte vertical: eje "x" (a lo largo, plano y = posicion) o "y" (a lo ancho, plano x = posicion).
  // data[i * nk + k] en los centros de celda; con campo "vel" data es la rapidez 3D, uh la
  // componente horizontal a lo largo del corte y w la vertical.
  corte(eje, posicion, campo = "c") {
    const { nx, ny, nz, dx, dy, dz } = this;
    if (eje !== "x" && eje !== "y") throw new Error(`eje desconocido: ${eje}`);
    const vel = campo === "vel";
    if (!vel && campo !== "c") throw new Error(`campo desconocido: ${campo}`);
    const ni = eje === "x" ? nx : ny, nk = nz;
    const hh = eje === "x" ? dx : dy;
    const h = new Float32Array(ni), zs = new Float32Array(nk);
    for (let i = 0; i < ni; i++) h[i] = (i + 0.5) * hh;
    for (let k = 0; k < nk; k++) zs[k] = (k + 0.5) * dz;
    const data = new Float32Array(ni * nk);
    const uh = vel ? new Float32Array(ni * nk) : null;
    const ww = vel ? new Float32Array(ni * nk) : null;
    const vv = [0, 0, 0];
    for (let i = 0; i < ni; i++) {
      const x = eje === "x" ? (i + 0.5) * dx : posicion;
      const y = eje === "x" ? posicion : (i + 0.5) * dy;
      for (let k = 0; k < nk; k++) {
        const z = (k + 0.5) * dz;
        if (vel) {
          this.velocidadEn(x, y, z, vv);
          data[i * nk + k] = Math.hypot(vv[0], vv[1], vv[2]);
          uh[i * nk + k] = eje === "x" ? vv[0] : vv[1];
          ww[i * nk + k] = vv[2];
        } else {
          data[i * nk + k] = this.muestrea("c", x, y, z);
        }
      }
    }
    const r = { ni, nk, h, z: zs, data };
    if (vel) Object.assign(r, { uh, w: ww });
    return r;
  }

  // Corte vertical por el plano del chorro: data[k * ns + m] (nz filas, ns columnas), como Python.
  // campo "c" (mg/L) o "vel": data = componente horizontal en el plano, w = vertical.
  seccionChorro(campo = "c") {
    const cfg = this.cfg;
    const [hx, hy] = this.geo.plano_chorro;
    const [x0, y0] = this.geo.pos_bomba;
    let sMin = -Infinity, sMax = Infinity;
    if (this.redonda) {
      // cuerda del círculo por la bomba: |o + s h - centro| = R
      const r = cfg.diametro / 2, ox = x0 - r, oy = y0 - r;
      const bb = ox * hx + oy * hy, raiz = Math.sqrt(Math.max(bb * bb - (ox * ox + oy * oy - r * r), 0));
      sMin = -bb - raiz;
      sMax = -bb + raiz;
    } else {
      for (const [p0, hh, L] of [[x0, hx, cfg.largo], [y0, hy, cfg.ancho]]) {
        if (Math.abs(hh) > 1e-12) {
          const a = (0 - p0) / hh, b = (L - p0) / hh;
          sMin = Math.max(sMin, Math.min(a, b));
          sMax = Math.min(sMax, Math.max(a, b));
        }
      }
    }
    const ns = Math.max(8, Math.trunc((sMax - sMin) / Math.min(this.dx, this.dy)) + 1);
    const nz = this.nz;
    const s = new Float64Array(ns);
    const paso = (sMax - sMin) / (ns - 1);
    for (let m = 0; m < ns; m++) s[m] = m * paso + sMin;
    s[ns - 1] = sMax;
    const data = new Float32Array(nz * ns);
    const vel = campo !== "c";
    const ww = vel ? new Float32Array(nz * ns) : null;
    const zs = new Float32Array(nz);
    const vv = [0, 0, 0];
    for (let k = 0; k < nz; k++) {
      const z = (k + 0.5) * this.dz;
      zs[k] = z;
      for (let m = 0; m < ns; m++) {
        const x = x0 + s[m] * hx, y = y0 + s[m] * hy;
        if (vel) {
          this.velocidadEn(x, y, z, vv);
          data[k * ns + m] = vv[0] * hx + vv[1] * hy;
          ww[k * ns + m] = vv[2];
        } else {
          data[k * ns + m] = this.muestrea("c", x, y, z);
        }
      }
    }
    const r = { s: Float32Array.from(s), z: zs, data, ns, nz, origen: [x0, y0], dir: [hx, hy] };
    if (vel) r.w = ww;
    return r;
  }
}
