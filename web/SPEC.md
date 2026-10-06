# Visor y motor JS: especificación compartida

Fuente de verdad de la física: `cisterna_sim/` (Python). El motor JS es un port 1:1 de
`cisterna_sim/solver.py` + `config.py` + `bomba.py`, más las extensiones de abajo.
Todo texto visible en español de México. Nunca usar el carácter "—" (em dash) ni "–".

## Archivos

```
web/
  solver.js        motor (ES module, sin DOM; corre en navegador y en Node >= 18)
  index.html       visor (página del artifact; sin <!doctype>/<html>/<head>/<body>)
  app.js           lógica del visor (ES module, importa ./solver.js)
  sweep.mjs        barridos en Node (posición, ángulo, etc.)
  test/            pruebas en Node (node --test web/test/)
```

El visor se publica como artifact con `files: {"solver.js": ..., "app.js": ...}`, y se
carga con `<script type="module" src="app.js">`. Sin librerías externas (canvas 2D puro).
Debe funcionar abierto con `npx http-server web` para probarlo con Playwright.

## Coordenadas y unidades

SI. x a lo largo (0..largo), y a lo ancho (0..ancho), z hacia arriba desde el fondo
(0..nivel). Azimut en planta en grados desde +x hacia +y. Elevación en grados, + arriba.
Concentración de cloro en mg/L. Caudales de entrada en L/h o L/min según el nombre.

## Config (mismos nombres que Python, snake_case)

```js
export const DEFAULTS = {
  largo: 3.40, ancho: 2.45, nivel: 1.20, z_tapa: 1.35, dx: 0.10,
  q_max_lh: 800, h_max_m: 5, salida_mm: 8, boquilla_mm: 8, k_salida: 1.0,
  boca: [1.20, 1.00], angulo_tubo: 60, z_bomba: 0.50, z_orp: 0.20,
  pos_bomba: null, azimut: null, elevacion: null,
  pozo: [0.90, 1.00, 0.45], llenado: [0.25, 1.20, 1.10],
  dosis_ml: 150, cloralex_mg_ml: 50, lugar_dosis: "llenado",   // "llenado" | "mastil" | [x,y,z]
  cfl: 0.4, cs: 0.17, c_nu: 0.02, sc_t: 0.7,
  // extensiones JS (no existen en Python):
  consumo_lpm: 0,        // agua que usa la casa: sumidero en la rejilla del pozo y fuente igual en el llenado
  llenado_mm: 13,        // diámetro del chorro de llenado (flotador), para su flujo de momento
  c_llenado_mg_l: 0,     // cloro del agua que entra (0: el SIAPA llega sin cloro libre)
};
```

Geometría derivada idéntica a Python: `rumbo()`, `punto_tubo(z)`, `pos_bomba_xyz()`,
`dir_chorro()`, `plano_chorro()`, `punto_dosis()`, `sondas()` (superficie bajo la boca a
nivel-0.10, llave de la casa = pozo, sonda ORP = punto_tubo(z_orp)), y `validar()` con los
mismos chequeos (mensajes en español, lanza `Error`).

Bomba: `puntoOperacion(q_max_lh, h_max_m, boquilla_mm, salida_mm, k_salida)` y
`tiempoMezclaS(V, M)` = 10.2 V^(2/3)/sqrt(M), idénticos a `bomba.py`.

## Algoritmo (port de solver.py, no cambiar sin avisar)

Malla MAC: nx = max(4, round(largo/dx)) (redondeo de Python: mitad a par), igual ny, nz;
dx = largo/nx, etc. u (nx+1,ny,nz), v (nx,ny+1,nz), w (nx,ny,nz+1), c y p (nx,ny,nz).
Arreglos planos Float64Array, índice (i*NY + j)*NZ + k con las dimensiones propias de cada
arreglo. Paso de flujo: nu = 1e-6 + Smagorinsky + (bomba encendida ? c_nu*sqrt(M) : 0);
advección semi-lagrangiana RK2 con interpolación trilineal que sujeta índices al borde;
difusión explícita con celdas fantasma (paredes y fondo sin deslizamiento, tapa desliza);
fuerza del chorro gaussiana (sigma 0.6*delta, centro boquilla + dir*delta, normalizada por
componente excluyendo caras de pared, integral = M*dir); proyección con DCT-II ortonormal
(en JS: matrices de cosenos precalculadas por eje, exacto). Cloro: flujo MUSCL van Leer +
difusión nu/sc_t, SSP-RK2, sub-pasos con dt_cloro. dt_flujo = min(0.5, 0.4/(nu_max*Σ1/h²),
0.9/courant). Mismas constantes: NU_AGUA 1e-6, DT_MAX 0.5, CFL_FLUJO 0.9.

### Extensión: consumo de la casa (consumo_lpm > 0)

Q = consumo_lpm/60000 m³/s. Sumidero gaussiano en `pozo` y fuente gaussiana en el
llenado (z = min(llenado.z, nivel-0.05)), cada uno con pesos normalizados (suma = 1) en
celdas, sigma = delta. Divergencia objetivo s = Q*w/Vcelda (+ fuente, - sumidero), suma 0.
Proyección: resolver lap(p) = (div(u*) - s)/dt. Chorro del llenado: fuerza hacia abajo con
M_ll = Q²/A(llenado_mm), repartida igual que la fuente. Cloro, forma conservativa:
dc/dt = -div(F) + s⁺·c_llenado_mg_l + s⁻·c (s⁻ es negativo: el sumidero saca cloro a la
concentración local). Masa: d(masa)/dt = Q·c_in - Q·c(pozo) (verificar en test).
Viscosidad de fondo con consumo: c_nu·sqrt((bomba encendida ? M : 0) + M_ll), porque el chorro
del llenado tampoco se resuelve; sin esto, apagar la bomba "mezclaba mejor" (revisión del 6 oct).
Con consumo, stats().cov es desviación / media actual (sin consumo es igual a std(c/cFinal)).

## API de solver.js

```js
export const DEFAULTS
export function validar(cfg)                       // lanza Error con todos los problemas
export function geometria(cfg) -> { rumbo, punto_tubo(z), pos_bomba, dir_chorro, plano_chorro, punto_dosis, sondas }
export function puntoOperacion(...) -> { q_m3s, q_lh, u_ms, m_m4s2, h_m }
export function tiempoMezclaS(vol_m3, m)
export class Cisterna {
  constructor(cfgParcial)         // mezcla con DEFAULTS, valida
  cfg, nx, ny, nz, dx, dy, dz, volCelda, bomba, t, cFinal (mg/L si mezcla perfecta, 0 antes de dosificar)
  u, v, w, c                      // Float64Array
  dtFlujo()
  avanza(dt, { cloro = true, bomba = true } = {})
  correr(segundos, opts)          // varios pasos con dt estable; regresa pasos
  dosifica(masa_mg, punto, sigma) // suma una nube gaussiana; acumula cFinal
  dosificaCfg()                   // usa dosis_ml*cloralex_mg_ml en punto_dosis()
  muestrea(campo, x, y, z)        // campo: "u"|"v"|"w"|"c"; trilineal
  velocidadEn(x, y, z) -> [u, v, w]
  stats() -> { cov, cmin, cmax, masa_mg, ek, vmax }   // cov, cmin, cmax relativos a cFinal
  valoresSondas() -> { "superficie (tapa)": mg/L, ... }
  planta(campo, z | "promedio") -> { nx, ny, data: Float32Array(nx*ny) }  // campo: "c" | "vel"
  corte(eje, posicion) -> { ni, nk, data }  // corte vertical: eje "x" (plano y=posicion) o "y"
  seccionChorro(campo) -> { s: Float32Array, z: Float32Array, data }       // plano del chorro
}
```

## Visor (index.html + app.js)

Página de una sola pantalla, en español, que en el primer cuadro ya muestra la cisterna
con la configuración por defecto y el flujo desarrollándose. Debe:

1. **Vista superior** (planta a escala): contorno de la cisterna, boca de la tapa, bomba de
   pozo (cuerpo y rejilla), flotador/llenado, mástil, bomba de mezcla con flecha del chorro,
   sonda ORP. Fondo: concentración de cloro (promedio vertical) o rapidez; encima,
   partículas trazadoras que siguen el flujo (cientos, con estela corta) a la profundidad
   elegida o en 3D proyectadas.
2. **Vista lateral** (corte vertical, a escala en ambos ejes): elegir corte a lo largo
   (plano y = bomba) o por el plano del chorro. Dibujar nivel del agua, fondo, tapa y boca,
   bomba de pozo colgando con su rejilla a 45 cm, flotador, mástil diagonal, bomba de
   mezcla, sonda ORP, cotas en cm. Mismo fondo y partículas.
3. **Controles**: arrastrar la bomba de mezcla en la vista superior; altura (slider);
   azimut (arrastrar la punta de la flecha o slider); elevación (-90 a +90); caudal real
   (L/h) y boquilla (mm); nivel del agua; lugar de la dosis (llenado, mástil, o clic en la
   planta); botón "Echar cloro"; play/pausa; velocidad (1x a 120x tiempo real); reiniciar;
   consumo de la casa (0 a 40 L/min); capas visibles. Modo "editar cisterna": medidas y
   arrastrar boca, bomba de pozo y llenado.
4. **Lecturas**: minutos desde la dosis, CoV, rango min/max en % de la meta, mg/L en
   superficie / llave de la casa / sonda ORP, Q, u, M y tiempo de la fórmula; mini gráfica
   de las sondas contra el tiempo. Advertencia visible si el chorro apunta a menos de ~0.5 m
   de la rejilla de la bomba de pozo o al fondo (levanta lodo).
5. Corre el motor en el hilo principal con presupuesto de tiempo por cuadro (~8-10 ms) o en
   un Web Worker cargado desde archivo propio; nunca congela la página. 60 fps de dibujo.
6. Reglas de artifact: `<title>` corto (2 a 4 palabras), tokens de color en `:root` con
   modo oscuro por `prefers-color-scheme` (guardado con `:root:not([data-theme="light"])`)
   y repetido en `:root[data-theme="dark"]`, `body` con fondo explícito, funciona a 400 px
   de ancho sin scroll horizontal (vistas apiladas), tipografía de Google Fonts con fallback.
