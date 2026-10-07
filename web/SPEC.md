# Visor y motor JS: especificación compartida

Fuente de verdad de la física: `cisterna_sim/` (Python). El motor JS es un port 1:1 de
`cisterna_sim/solver.py` + `config.py` + `bomba.py`, más las extensiones de abajo.
Todo texto visible en español de México. Nunca usar la raya larga (U+2014) ni la media (U+2013).

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
export const DEFAULTS = {          // la cisterna de Erick; supuestos en "Defaults" abajo
  forma: "redonda", diametro: 3.26,
  largo: 3.40, ancho: 2.45, nivel: 1.20, z_tapa: 1.35, dx: 0.10,   // largo y ancho: solo en la rectangular
  q_max_lh: 800, h_max_m: 5, salida_mm: 8, boquilla_mm: 8, k_salida: 1.0,
  boca: [1.63, 1.63], angulo_tubo: 90, z_bomba: 0.50, z_orp: 0.20,
  pos_bomba: null, azimut: 0, elevacion: 0,
  pozo: [1.33, 1.63, 0.45], llenado: [1.33, 1.88, 1.10],
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
export const DEFAULTS, FORMAS, TOL_PRESION (1e-8), MAX_IT_PRESION (300)
export function validar(cfg)                       // lanza Error con todos los problemas
export function geometria(cfg) -> { rumbo, punto_tubo(z), pos_bomba, dir_chorro, plano_chorro, punto_dosis, sondas,
                                    fuente_llenado, forma, centro: [cx, cy], radio (null en la rectangular),
                                    volumen_m3 (geométrico: largo*ancho*nivel o pi R^2 nivel) }
export function puntoOperacion(...) -> { q_m3s, q_lh, u_ms, m_m4s2, h_m }
export function tiempoMezclaS(vol_m3, m)
export class Cisterna {
  constructor(cfgParcial)         // mezcla con DEFAULTS, valida
  cfg, nx, ny, nz, dx, dy, dz, volCelda, bomba, t, cFinal (mg/L si mezcla perfecta, 0 antes de dosificar)
  u, v, w, c                      // Float64Array
  redonda                         // forma === "redonda"
  agua                            // Uint8Array(nx*ny), 1 si la columna i*ny+j es agua (en la rectangular, todo 1)
  nAgua, volumenAgua              // celdas de agua y su volumen discreto nAgua*volCelda (m3)
  p, tolPresion, presion          // redonda: presión guardada (arranque del siguiente paso), tolerancia del
                                  // gradiente conjugado (atributo, no config) y { iteraciones, residuo, total,
                                  // proyecciones } del último paso y acumulado; en la rectangular p = null
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
   bomba de pozo colgando con su rejilla a 45 cm, flotador, mástil diagonal (o el tubo vertical con
   `angulo_tubo` 90, ver "Visor de la redonda"), bomba de mezcla, sonda ORP, cotas en cm. Mismo fondo y
   partículas.
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

## Cisterna redonda (forma = "redonda")

La cisterna real es cilíndrica. Mismo solver MAC sobre la caja que la contiene, con una máscara.
Debe implementarse igual en `web/solver.js` y en `cisterna_sim/` (paridad < 1e-6 en un caso de
referencia, con la presión resuelta a tolerancia estricta). Con `forma = "rectangular"` todo debe
quedar bit a bit como hoy (las pruebas de referencia actuales no cambian).

Config nueva: `forma` ("rectangular" | "redonda", default "redonda" desde el 7 oct, ver "Defaults") y
`diametro` (m). Con "redonda": `largo = ancho = diametro` (se ignoran los que
vengan), centro `(D/2, D/2)`, radio `R = D/2`.

1. **Celdas de agua**: `fluido[i][j] = (xc - cx)² + (yc - cy)² <= R²` con `xc = (i + 0.5)·dx`,
   `yc = (j + 0.5)·dy`; vale para toda la columna k.
2. **Caras abiertas**: cara u (i, j, k) abierta si `1 <= i <= nx-1` y `fluido[i-1][j]` y `fluido[i][j]`;
   cara v igual en j; cara w (i, j, k) abierta si `1 <= k <= nz-1` y `fluido[i][j]`. Las demás
   están cerradas y valen 0 después de cada sub-paso (advección, difusión + fuerza, proyección).
3. **Difusión de momento**: el mismo laplaciano de 7 puntos; un vecino que es cara cerrada vale 0, y
   además, por cada vecino tangencial que sea cara cerrada dentro de la caja, se suma `-u/h²`
   (equivale a fantasma `-u`: sin deslizamiento en la pared escalonada). En las paredes de la caja
   sigue el manejo actual. Solo se actualizan caras abiertas.
4. **Presión**: sobre celdas de agua, `A p = Σ_{caras abiertas f} (p_vecino - p)/h_f²`, `b = div(u*)/dt`
   (div con caras cerradas en 0), quitando a `b` su media sobre celdas de agua. Resolver `(-A) p = -b`
   con gradiente conjugado precondicionado: `z = M(r)` = solución exacta por DCT de la caja de
   `(-lap_caja) z = r` con r extendida con 0 fuera del agua, luego z = 0 fuera del agua y restar a z
   su media sobre el agua. Arranque con la p del paso anterior (guardarla). Parar cuando
   `max|r| <= tol · max|b|` con `tol = 1e-8` (o 300 iteraciones; si se llega, avisar una vez por
   consola). Corrección: `u_f -= dt·(p_vecino - p)/h` solo en caras abiertas.
5. **Cloro**: flujo advectivo y difusivo cero en caras cerradas. En la pendiente MUSCL, un vecino
   fuera del agua toma el valor de la celda propia (gradiente cero, como en las paredes de la caja).
   El cloro en celdas fuera del agua es siempre 0.
6. **Gaussianas** (fuerza del chorro, dosis, sumidero y fuente del consumo): pesos solo en caras
   abiertas o celdas de agua, normalizados ahí (la integral se conserva: M·dir, masa de la dosis, Q).
7. **Estadísticas** (cov, cmin, cmax, media, masa, energía, vmax) y `cFinal`: solo sobre celdas de
   agua; `cFinal = masa / (n_agua · Vcelda · 1000)`. Volumen discreto `n_agua·Vcelda` y volumen
   geométrico `π R² nivel` ambos disponibles.
8. **Validación**: cada punto (bomba, sonda ORP, pozo, dosis, boca/superficie, llenado con consumo)
   debe quedar a distancia radial `<= R - 0.5·dx` del centro y con `0 < z < nivel`; además
   `diametro / dx >= 8`.
9. **Geometría**: `rumbo()` con forma redonda = unitario de la boca hacia el centro (si la boca está
   a menos de 1 mm del centro, `(1, 0)`): el "lado opuesto" sustituye a la "esquina opuesta".
10. **Visor**: planta circular a escala, fuera del círculo se pinta como muro; el corte lateral es la
   cuerda que pasa por la bomba (paredes en `cx ± sqrt(R² - (y - cy)²)`); en "editar cisterna" se
   elige forma y, si es redonda, diámetro en vez de largo y ancho. Las partículas no salen del agua.

### Decisiones de la implementación (huecos de la lista de arriba)

Resueltas en `web/solver.js` y seguidas en `cisterna_sim/` (commits "Redonda: el cloro se interpola ..." y
"Redonda: viscosidad solo en el agua ..."). Comprobación rápida, que no sustituye la prueba de paridad: dos casos
redondos a dx 0.2 (por defecto y con chorro propio), 60 pasos de 0.5 s con la bomba apagada a los 45 y
tolerancia 1e-13, dan u, v, w, c, dtFlujo y sondas iguales a Python con error relativo <= 2e-15.

- **Consumo en la redonda**: `b = (div(u*) - s)/dt` (el punto 4 omite s). Sumidero, fuente y chorro del llenado
  van con pesos solo en celdas de agua / caras w abiertas (punto 6), así que `s` sigue sumando 0 en el agua.
- **Viscosidad**: Smagorinsky solo en celdas de agua (las derivadas centradas ven velocidad 0 en las secas, como
  `np.gradient` en la caja); fuera del agua `nu = NU_AGUA` y no entra en `nuMax` (`dtFlujo`, `dtCloro`), porque
  ninguna cara abierta la usa. Tomar el máximo en toda la caja casi nunca cambia el paso (en 6 corridas de 5 min,
  con el chorro por defecto, al muro y rozando la pared, a dx 0.2 y 0.1, el máximo siempre cayó en el agua), pero
  la regla es "solo agua".
- **Muestreo del cloro** (`muestrea("c")`, sondas, `corte`, `seccionChorro`): trilineal solo con las columnas de
  agua del estencil 2x2 en planta, pesos renormalizados; si las 4 son agua es la trilineal de siempre. Sin esto,
  una sonda válida a `R - 0.5·dx` lee hasta la mitad de lo real por los ceros del muro. Las velocidades usan la
  trilineal simple (valen 0 en la pared, que es lo físico). Python hace lo mismo en `muestrea` de campos de
  centros.
- **Sección del chorro**: en la redonda es la cuerda del círculo por la bomba (igual que Python).
- **Difusión (punto 3)**: el vecino tangencial cerrado se escribe como fantasma `-u` (mismo número que "vale 0 y
  se suma -u/h²"), con banderas por columna; las caras de la caja son el mismo caso.
- **Frontera exacta**: la distancia radial de la validación (punto 8) se compara con cuadrados,
  `ox·ox + oy·oy <= rMax·rMax`, y la máscara (punto 1) usa `R·R`, solo con multiplicaciones y sumas, que dan el mismo
  bit en Python y JS. Con `hypot` (y `R**2`) no: `math.hypot` y `Math.hypot` redondean distinto, y de 4000 puntos
  construidos sobre `R - 0.5·dx` 121 tenían veredicto distinto en los dos. Con cuadrados: 0 de 4000, 0 de 6000
  configuraciones al azar y 300 máscaras iguales.
- **Validación**: `diametro/dx >= 8` y `R - 0.5·dx` usan el `dx` de la config, no el de la malla. El llenado se
  valida con consumo y también cuando es el lugar de la dosis (como ya pasaba). `diametro` debe ser > 0 siempre.
- **copiaEstado**: solo entre cisternas de la misma forma y malla; copia también `p`.
- **Advección**: el punto de salida semi-lagrangiano se interpola en la caja completa (las caras cerradas valen 0),
  igual que en Python.
- **Tolerancia estricta** para la paridad: atributo de la instancia, `sim.tolPresion` en JS y `sim.tol_cg` en
  Python (no es parámetro de la config).

Rendimiento medido en Node 22 (un hilo, 30 s de bomba antes de medir, luego dosis y 150 pasos completos):

| caso | malla | ms por paso | iteraciones de GC por paso |
|---|---|---|---|
| rectangular 3.40 x 2.45, dx 0.10 | 34x24x12 | 5.1 | (DCT directa) |
| rectangular 3.26 x 3.26, dx 0.10 | 33x33x12 | 6.6 | (DCT directa) |
| redonda D 3.26, dx 0.10, arranque en caliente | 33x33x12 | 11.0 | 3.9 |
| redonda D 3.26, dx 0.10, arranque en frío (p = 0) | 33x33x12 | 15.7 | 7.0 |
| redonda D 3.26, dx 0.05, arranque en caliente (10 s antes, 30 pasos) | 65x65x24 | 97 | 3.1 |
| rectangular 3.40 x 2.45, dx 0.05 (10 s antes, 30 pasos) | 68x49x24 | 47 | (DCT directa) |

De los 11 ms de la redonda, 6.4 son la presión y casi todo es la DCT del precondicionador (1.45 ms por
aplicación); aplicar `-A` cuesta 0.06 ms. Con la caja llena como máscara el gradiente conjugado converge en una
iteración y da la proyección de la DCT directa a 3e-16 (el operador, el precondicionador y la corrección cuadran). Las caras y celdas secas no se calculan en advección, difusión y
cloro. Cero asignaciones por paso: todos los vectores del gradiente conjugado están prealocados.

### Defaults: la cisterna de Erick (7 oct)

Iguales en `cisterna_sim/config.py` y en `DEFAULTS` de `web/solver.js` (la prueba "DEFAULTS iguales a los de
cisterna_sim/config.py" compara los valores por defecto de los campos de la dataclass contra `DEFAULTS`).

| parámetro | valor | origen |
|---|---|---|
| `forma`, `nivel` | "redonda", 1.20 m | dicho por Erick (redonda) y documento (nivel del flotador) |
| `diametro` | 3.26 m | supuesto: el cilindro de 10 m3 a 1.20 m (π 1.63² 1.20 = 10.0) |
| `boca` | (1.63, 1.63), al centro | supuesto |
| `angulo_tubo`, `z_bomba`, `z_orp` | 90 (tubo vertical bajo la boca), 0.50 m, 0.20 m | propuesta de Erick |
| `azimut`, `elevacion` | 0 (hacia +x, lejos del pozo), 0 (chorro horizontal) | horizontal: Erick; hacia +x: supuesto |
| `pozo` | (1.33, 1.63, 0.45) | supuesto: 30 cm de la boca del lado -x; rejilla a 45 cm (documento) |
| `llenado` | (1.33, 1.88, 1.10) | junto al pozo (Erick); el lado +y es supuesto |

- `azimut` o `elevacion` en `null` siguen queriendo decir "a lo largo del tubo"; con el tubo vertical eso es un
  chorro hacia el fondo (elevación -90). Para el diseño del documento hay que pasar `forma: "rectangular"`,
  `angulo_tubo: 60`, `azimut: null`, `elevacion: null` y la geometría vieja (`largo` 3.40, `ancho` 2.45, `boca`
  (1.20, 1.00), `pozo` (0.90, 1.00, 0.45), `llenado` (0.25, 1.20, 1.10)).
- Con la boca al centro, `rumbo()` es (1, 0) (punto 9). Con el tubo vertical el rumbo no mueve la bomba ni la
  sonda ORP; solo cuenta si el chorro sigue el tubo (`null`) o es casi vertical (`plano_chorro`).
- La boquilla queda a 30 cm de la rejilla del pozo (0.50 contra 0.45 de altura): la advertencia del visor de
  "< 0.5 m de la rejilla" sale con los defaults. Es la geometría supuesta, no un error.
- Los casos de `web/test/gen_ref.py`, las pruebas rectangulares (`tests/test_solver.py`,
  `web/test/solver.test.js`), `web/sweep.mjs` y `web/propuesta.mjs` fijan su forma y geometría, así que dan lo
  mismo que antes del cambio: los campos de referencia rectangulares salieron idénticos bit a bit, y las 12000
  configuraciones del barrido y las 324 de la propuesta salen iguales (`configura`) con el solver viejo y el nuevo.

### Paridad Python contra JS de la redonda (prueba formal)

Caso "redonda" de `web/test/gen_ref.py`: diámetro 3.26, dx 0.2 (malla 16x16x6, 1248 celdas de agua), boca al
centro con tubo vertical, bomba en (1.69, 1.64, 0.50) con chorro horizontal a azimut 10 (sin simetría de espejo),
dosis en el llenado, 80 pasos de 0.5 s con la bomba apagada desde el paso 60 y la presión a tolerancia 1e-12 en
los dos lados (`sim.tol_cg` y `sim.tolPresion`, guardada en el caso como `tol_presion`).
`web/test/referencia.test.js` lo compara con error relativo < 1e-6 en u, v, w, c, estadísticas, sondas, muestras
junto a la pared y fuera del agua, sección del chorro, `dtFlujo` y `dtCloro`. Resultado: error relativo máximo
1.35e-15 (c; u, v, w <= 9.3e-16) y el mismo número de iteraciones del gradiente conjugado en cada paso (897 en
total); la prueba exige que el total no difiera más de 2 %. `validar()` se compara con 28 configuraciones que los
dos rechazan (12 rectangulares y 16 redondas) y 10 que los dos aceptan (en los límites: medio dx de la pared,
`diametro/dx` = 8.15 y 8 exacto, llenado fuera del círculo cuando no es la dosis, y 6 puntos sobre `R - 0.5·dx` al
último bit, ver "Frontera exacta"); `tests/test_referencia.py` revisa que `ref_py.json` esté al día con esas
listas y con los defaults de `config.py`. Los campos no pidieron cambios en ningún solver; la validación sí (cuadrados
en vez de `hypot`, en los dos).

### Lado Python (`cisterna_sim/`)

- **Precisión simple**: `TOL_CG` es 1e-8 en f64 (punto 4) y 1e-6 en f32. En f32 apretar más no cambia la solución
  (manda el redondeo: contra f64, c difiere 4e-7 con 1e-6 y 2e-7 con 1e-7 o menos) y solo cuesta iteraciones. JS
  solo corre en f64. Con `sim.tol_cg = 1e-12` converge en ~10 iteraciones.
- **Agua quieta**: si `max|b| = 0` exacto, `p = 0` sin iterar (igual que JS); con la p anterior distinta de 0 nunca
  se cumpliría `max|r| <= 0`.
- **Interpolación con agua**: en `muestrea`, cualquier campo de centros (`off == OFF_C`) usa las columnas de agua;
  las caras, la trilineal simple.
- **Para un caso redondo en `gen_ref.py`**: estadísticas con `sim.en_agua(sim.c)` y
  `c_final = masa / (sim.volumen_m3 · 1000)` (`sim.volumen_m3` es el discreto, `cfg.volumen_m3` el geométrico).
- Sin consumo (no existe en Python).

Rendimiento en CPU con numpy (un hilo, 30 pasos antes de medir y 150 medidos con cloro, chorro por defecto):

| caso | malla | f64 ms/paso | f32 ms/paso | iteraciones de GC (f64 / f32) |
|---|---|---|---|---|
| rectangular 3.40 x 2.45, dx 0.10 | 34x24x12 | 17.7 | 10.9 | (DCT directa) |
| redonda D 3.26, dx 0.10 | 33x33x12 | 27.1 | 14.5 | 4.1 / 1.4 |

De los 27.1 ms, 3.4 son la presión (0.40 ms por aplicación del precondicionador); el resto escala con las celdas
de la caja, que en Python sí se calculan aunque estén secas. Los productos punto van con `(a * b).sum()`: el
`ddot` de OpenBLAS se reparte en hilos con 13 mil celdas y subía el paso a 33.5 ms.

### Visor de la redonda (punto 10)

En `web/app.js`; con `forma = "rectangular"` y el mástil a 60° los lienzos salen iguales que antes, píxel por píxel,
salvo un halo claro bajo la línea punteada de la boca para que se vea sobre el cloro oscuro (comparado en 16 vistas,
planta y corte, a 1280 y 400 px). Huecos del punto 10 y cómo se resolvieron:

- **Muro**: un anillo de `MURO` (15 cm, supuesto de dibujo, como en la rectangular) alrededor del círculo; más afuera
  es papel, porque la caja de cálculo no existe físicamente. El cloro se recorta al círculo verdadero y cada columna
  seca toma el cloro de la columna de agua más cercana (búsqueda en anchura sobre la máscara `agua`, que el worker
  manda con cada instantánea junto con `redonda`): sin eso, el suavizado mezcla los ceros del muro y deja un borde
  claro que no es real. La rapidez sí usa los ceros: velocidad 0 en la pared es lo físico.
- **Corte**: dos opciones, "Cuerda por la bomba" (y = bomba, paredes en `cx ± sqrt(R² - (y - cy)²)`) y el plano del
  chorro recortado al círculo (la misma cuerda que `seccionChorro`). Una cuerda que no pasa por el centro corta el
  muro en diagonal: se dibuja con su grueso aparente `sqrt((R + MURO)² - e²) - sqrt(R² - e²)` (e: distancia de la
  cuerda al centro). La cota de abajo dice `Ø 326` por el centro y `305 de cuerda` fuera de él. La vista abarca
  siempre el diámetro con sus muros, centrada en el eje del cilindro: la escala y el alto del lienzo no cambian al
  mover la bomba (con la cuerda ajustada a la vista, al arrastrar la bomba el lienzo cambiaba de alto en cada cuadro
  y la página brincaba), y una cuerda fuera del centro se ve con las paredes más juntas, como un corte de verdad. Al
  cambiar la escala o el plano las partículas conservan su posición en metros y solo se borran sus estelas.
- **Cotas de la planta**: el diámetro abajo (líneas de referencia desde las tangentes, fuera del muro) y la distancia
  de la bomba al muro por el radio, en lugar de las distancias a las dos paredes más cercanas. Con la bomba al centro
  la línea va perpendicular al chorro, del lado contrario al pozo y al flotador.
- **Chorro**: el rayo pega en el cilindro (`|p + t d - centro| = R` en planta), en el fondo o en la superficie.
- **Partículas y flechas**: se siembran solo dentro del círculo y se resiembran al salir de él; las del corte, dentro
  de la cuerda y su franja de ±25 cm. El tocado de la dosis fuera del agua no cuenta.
- **Tubo vertical** (`angulo_tubo` 90, en cualquier forma): de la tapa (la losa) al piso con un pie, sin travesaño;
  en la planta, un círculo. La bomba se dibuja amarrada a un lado del tubo, de pie (desde arriba se ve la toma: un
  círculo), del lado del chorro y con dos cinchos en el corte; la flecha sale de ahí. La sonda ORP "mirando de lado" se
  dibuja perpendicular al chorro, del lado contrario al pozo y al flotador (el lado es supuesto): en un corte que
  la ve de frente queda sobre el tubo. En la planta la sonda de superficie va del lado contrario al chorro para no
  tapar el tubo. Todo eso es dibujo: el motor pone bomba y sondas en el eje del tubo, a menos de una celda; las cotas
  de altura y el rayo usan el punto del motor. Con otro ángulo sigue el mástil colgado del travesaño de siempre.
- **Editar cisterna**: forma (redonda o rectangular) y diámetro; `largo` y `ancho` se guardan para volver a la
  rectangular. Al arrastrar o al cambiar forma o medidas, la boca queda a `R - 0.42` del centro o menos (su cuadro de
  60 cm no sale del círculo) y el pozo, el flotador, la bomba libre y el punto tocado de la dosis a `R - 0.10` o
  menos (media celda de la malla de 20 cm, la más gruesa del menú, para que ningún cambio de malla los deje fuera;
  8 mm de holgura para el redondeo al cm). En la rectangular los márgenes son los de antes (30 y 5 cm); el recorte
  ahora también mueve la bomba libre y la dosis tocada, que antes dejaban la config rechazada.
- **Volumen y fórmula**: el geométrico, `π R² nivel` (10.0 m³ con los defaults), como en la cartela.
