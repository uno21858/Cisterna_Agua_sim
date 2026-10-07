// Pruebas y capturas del visor con Playwright (Chromium sin GPU).
// Uso: npx http-server web -p 8080 -c-1 (en otra terminal) y luego
//   node web/capturas.mjs               capturas en web/test/capturas: escritorio y teléfono, claro y oscuro (la
//                                       cisterna redonda de Erick) y la rectangular del documento en escritorio
//   node web/capturas.mjs controles     arrastres, sliders, editar cisterna (forma, diámetro, medidas), corte,
//                                       velocidad, pausa, reiniciar, y los casos de la revisión
//   node web/capturas.mjs revision      casos de la revisión del visor (config rechazada, dosis, serie larga) y de
//                                       la redonda (cloro y partículas solo en el agua, cuerda del corte, rayo)
//   node web/capturas.mjs rotulos       rótulos encimados en varias configuraciones redondas y rectangulares y anchos
//   node web/capturas.mjs rendimiento   cuadros por segundo, costo por cuadro y velocidad de la simulación
//   node web/capturas.mjs contrato      reglas del artifact: esqueleto, temas, foco, movimiento reducido, 400 px
//   node web/capturas.mjs todo
// Variables: URL (dev.html por omisión), PLAYWRIGHT (ruta del paquete).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "/opt/node22/lib/node_modules/playwright");
const base = process.env.URL ?? "http://localhost:8080/dev.html";
const salida = join(dirname(fileURLToPath(import.meta.url)), "test", "capturas");

const modo = process.argv[2] ?? "capturas";
const navegador = await chromium.launch();
let fallas = 0;

// El diseño del documento (rectangular, mástil a 60°) y la cisterna de Erick (los DEFAULTS).
const RECT_DOC = {
  forma: "rectangular", largo: 3.4, ancho: 2.45, boca: [1.2, 1.0], pozo: [0.9, 1.0, 0.45], llenado: [0.25, 1.2, 1.1],
  angulo_tubo: 60, azimut: null, elevacion: null, pos_bomba: null, z_bomba: 0.5, lugar_dosis: "llenado", nivel: 1.2,
};
const REDONDA = {
  forma: "redonda", diametro: 3.26, boca: [1.63, 1.63], pozo: [1.33, 1.63, 0.45], llenado: [1.33, 1.88, 1.1],
  angulo_tubo: 90, azimut: 0, elevacion: 0, pos_bomba: null, z_bomba: 0.5, lugar_dosis: "llenado", nivel: 1.2,
};
const radio = (p, k) => Math.hypot(p[0] - k.cx, p[1] - k.cy);

async function abre({ w, h, dpr = 1, movil = false, tema = "light", antes = null }) {
  const ctx = await navegador.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: movil, hasTouch: movil });
  const page = await ctx.newPage();
  const errores = [];
  page.on("console", (m) => m.type() === "error" && errores.push(m.text()));
  page.on("pageerror", (e) => errores.push(e.message));
  if (antes) await page.addInitScript(antes);
  await page.emulateMedia({ colorScheme: tema });
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => window.visor?.sim?.t > 3, null, { timeout: 60000 });
  return { ctx, page, errores };
}

// Cuadros por segundo medidos con requestAnimationFrame durante seg segundos.
const midePagina = (page, seg) => page.evaluate(async (seg) => {
  const largas = window.__largas ?? [];
  largas.length = 0;
  const t0 = performance.now(), s0 = window.visor.sim.t;
  let n = 0, peor = 0, prev = t0;
  await new Promise((ok) => {
    const f = (t) => {
      n++;
      peor = Math.max(peor, t - prev);
      prev = t;
      if (t - t0 < seg * 1000) requestAnimationFrame(f);
      else ok();
    };
    requestAnimationFrame(f);
  });
  const dt = (performance.now() - t0) / 1000;
  const p = window.visor.perf;
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    fps: r1(n / dt), peorCuadroMs: r1(peor), simulaX: r1((window.visor.sim.t - s0) / dt),
    jsPorCuadroMs: r1(p.cuadroMs), particulasMs: r1(p.particulasMs), piezasMs: r1(p.overlayMs), pasoMotorMs: r1(p.motorPasoMs),
    tareasLargas: largas.length, motor: p.motor,
  };
}, seg);

const vigilaLargas = () => {
  window.__largas = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__largas.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
  } catch {}
};

// ---------- capturas ----------

async function capturas() {
  mkdirSync(salida, { recursive: true });
  const casos = [
    { nombre: "escritorio_claro", w: 1280, h: 800, tema: "light" },
    { nombre: "escritorio_oscuro", w: 1280, h: 800, tema: "dark" },
    { nombre: "telefono_claro", w: 400, h: 860, dpr: 2, tema: "light", movil: true },
    { nombre: "telefono_oscuro", w: 400, h: 860, dpr: 2, tema: "dark", movil: true },
    { nombre: "escritorio_rectangular", w: 1280, h: 800, tema: "light", cfg: RECT_DOC },
  ];
  const reporte = [];
  for (const caso of casos) {
    const { ctx, page, errores } = await abre({ ...caso, antes: vigilaLargas });
    if (caso.cfg) {
      await page.evaluate((c) => window.visor.aplica(c), caso.cfg);
      await page.waitForFunction(() => window.visor.sim.redonda === false && window.visor.sim.t > 3, null, { timeout: 60000 });
    }
    // Estado de trabajo: flujo desarrollado y el cloro a medio mezclar (unos 10 min tras la dosis).
    await page.selectOption("#velocidad", "120");
    await page.waitForFunction(() => window.visor.sim.t > 600, null, { timeout: 120000 });
    await page.selectOption("#velocidad", "30");
    await page.waitForTimeout(2500);
    const datos = await midePagina(page, 3);
    const doc = await page.evaluate(() => ({ anchoDoc: document.documentElement.scrollWidth, anchoVentana: innerWidth, choques: window.visor.choques() }));
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: join(salida, `${caso.nombre}.png`) });
    await page.screenshot({ path: join(salida, `${caso.nombre}_completa.png`), fullPage: true });
    reporte.push({ caso: caso.nombre, ...datos, ...doc, errores });
    if (errores.length || doc.anchoDoc > doc.anchoVentana) fallas++;
    await ctx.close();
  }
  console.log(JSON.stringify(reporte, null, 1));
}

// ---------- controles ----------

async function controles(caso) {
  const { ctx, page, errores } = await abre(caso);
  let bien = 0, mal = 0;
  const revisa = (nombre, cond, extra = "") => {
    cond ? bien++ : mal++;
    console.log(`${cond ? "bien" : "MAL "} ${nombre} ${extra}`);
  };
  const ev = (f, a) => page.evaluate(f, a);
  const espera = (ms) => page.waitForTimeout(ms);
  const st = () => ev(() => ({
    t: window.visor.sim.t, id: window.visor.sim.id, cfg: structuredClone(window.visor.cfg),
    est: structuredClone(window.visor.est), corridas: window.visor.corridas,
  }));
  async function arrastra(vista, id, dx, dy) {
    const canvas = page.locator(vista === "planta" ? "#c-planta" : "#c-corte");
    await canvas.scrollIntoViewIfNeeded();
    await espera(200);
    const caja = await canvas.boundingBox();
    const m = (await ev((v) => window.visor.manijas(v), vista)).find((q) => q.id === id);
    if (!m) return false;
    const x0 = caja.x + m.x, y0 = caja.y + m.y;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (dx * i) / 8, y0 + (dy * i) / 8);
    await page.mouse.up();
    return true;
  }

  // Arrastrar la bomba de mezcla en la planta y girar el chorro con la punta de la flecha
  let a = await st();
  revisa("arranca en el mástil", a.cfg.pos_bomba === null);
  await arrastra("planta", "bomba", 90, 40);
  let b = await st();
  revisa("arrastrar la bomba la deja libre", Array.isArray(b.cfg.pos_bomba), JSON.stringify(b.cfg.pos_bomba));
  revisa("el montaje dice libre", (await page.textContent("#estado-montaje")) === "libre");
  await espera(1200);
  b = await st();
  revisa("al soltar reinicia la corrida", b.id > a.id && b.corridas > a.corridas, `id ${a.id} a ${b.id}`);
  a = await st();
  await arrastra("planta", "chorro", -60, 60);
  b = await st();
  revisa("la punta de la flecha cambia el azimut", b.cfg.azimut != null && b.cfg.azimut !== a.cfg.azimut, `${a.cfg.azimut} a ${b.cfg.azimut}`);

  // Sliders
  for (const [id, valor, ok] of [
    ["altura", "30", (s) => Math.abs((s.cfg.pos_bomba ? s.cfg.pos_bomba[2] : s.cfg.z_bomba) - 0.3) < 1e-9],
    ["azimut", "120", (s) => s.cfg.azimut === 120],
    ["elevacion", "-20", (s) => s.cfg.elevacion === -20],
    ["caudal", "650", (s) => s.cfg.q_max_lh === 650],
    ["boquilla", "10", (s) => s.cfg.boquilla_mm === 10],
    ["nivel", "100", (s) => Math.abs(s.cfg.nivel - 1) < 1e-9],
    ["dosis", "200", (s) => s.cfg.dosis_ml === 200],
  ]) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.fill(`#${id}`, valor);
    revisa(`slider ${id}`, ok(await st()), `muestra "${await page.textContent(`#o-${id}`)}"`);
  }
  await espera(1500);
  revisa("tras los sliders la corrida reinicia", (await st()).t < 60);
  await page.click("#montar");
  await page.click("#seguir");
  a = await st();
  revisa("montar en el tubo y chorro recomendado (horizontal, contrario al flotador)",
    a.cfg.pos_bomba === null && Number.isFinite(a.cfg.azimut) && a.cfg.elevacion === 0);

  // Consumo de la casa: cambia sin reiniciar
  await espera(1500);
  a = await st();
  await page.locator("#consumo").scrollIntoViewIfNeeded();
  await page.fill("#consumo", "20");
  await espera(1500);
  b = await st();
  revisa("consumo de la casa sin reiniciar", b.cfg.consumo_lpm === 20 && b.id === a.id && b.t > a.t, `t ${a.t.toFixed(0)} a ${b.t.toFixed(0)} s`);

  // Corte lateral
  await page.click("label[for=corte-chorro]");
  a = await st();
  revisa("corte por el plano del chorro", a.est.corte === "chorro" && (await page.textContent("#t-corte-sub")).includes("chorro"));
  await espera(300);
  await arrastra("corte", "chorro-el", 0, -50);
  b = await st();
  revisa("la punta en el corte cambia la elevación", b.cfg.elevacion != null && b.cfg.elevacion !== a.cfg.elevacion, `${a.cfg.elevacion} a ${b.cfg.elevacion}`);
  a = b;
  await arrastra("corte", "bomba-z", 0, -30);
  b = await st();
  revisa("arrastrar la bomba en el corte cambia la altura", b.cfg.z_bomba > a.cfg.z_bomba, `${a.cfg.z_bomba} a ${b.cfg.z_bomba} m`);
  await page.click("label[for=corte-largo]");
  revisa("corte a lo largo", (await st()).est.corte === "largo");

  // Velocidad
  await page.locator("#velocidad").scrollIntoViewIfNeeded();
  await page.selectOption("#velocidad", "120");
  await espera(3000);
  const v120 = await ev(() => window.visor.vSim);
  revisa("velocidad 120x (el motor da lo que puede)", (await st()).est.velocidad === 120 && v120 > 35, `simula a ${v120.toFixed(0)}x`);
  await page.selectOption("#velocidad", "5");
  await espera(3000);
  const v5 = await ev(() => window.visor.vSim);
  revisa("velocidad 5x", Math.abs(v5 - 5) < 1.5, `simula a ${v5.toFixed(1)}x`);
  await page.selectOption("#velocidad", "30");

  // Pausa, cloro y reinicio
  await page.click("#play");
  await espera(300);
  a = await st();
  await espera(1500);
  b = await st();
  revisa("pausa detiene el reloj", Math.abs(b.t - a.t) < 0.01 && (await page.textContent("#play")) === "Seguir");
  await page.click("#play");
  await espera(1500);
  revisa("seguir lo reanuda", (await st()).t > b.t + 5);
  const meta0 = await page.textContent("#l-meta");
  await page.click("#echar");
  await espera(800);
  const meta1 = await page.textContent("#l-meta");
  revisa("echar cloro sube la meta", parseFloat(meta1) > parseFloat(meta0), `${meta0} a ${meta1}`);
  revisa("el tiempo desde la dosis vuelve a cero", parseFloat(await page.textContent("#l-tiempo")) < 1.5);
  await espera(2000);
  a = await st();
  await page.click("#reiniciar");
  await espera(800);
  b = await st();
  revisa("reiniciar", b.id > a.id && b.t < a.t && b.corridas === Math.min(12, a.corridas + 1), `t ${a.t.toFixed(0)} a ${b.t.toFixed(0)} s`);

  // Editar la cisterna: la redonda pide el diámetro; las piezas no salen del círculo
  const medida = async (id, valor) => {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.fill(`#${id}`, valor);
    await page.press(`#${id}`, "Enter");
    await page.locator(`#${id}`).blur();
    await espera(2500);
  };
  const malla = () => ev(() => [window.visor.sim.nx, window.visor.sim.ny, window.visor.sim.redonda]);
  await page.locator("#editar").scrollIntoViewIfNeeded();
  await page.check("#editar");
  revisa("editar muestra la forma y el diámetro", await page.isVisible("#forma") && await page.isVisible("#diametro") && !(await page.isVisible("#largo")));
  await ev(() => scrollTo(0, 0));
  a = await st();
  await arrastra("planta", "boca", 30, 10);
  await arrastra("planta", "pozo", -20, 30);
  await arrastra("planta", "llenado", 0, -40);
  b = await st();
  revisa("arrastrar la boca", b.cfg.boca[0] !== a.cfg.boca[0], `${a.cfg.boca} a ${b.cfg.boca}`);
  revisa("arrastrar la bomba de pozo", b.cfg.pozo[1] !== a.cfg.pozo[1], `${a.cfg.pozo} a ${b.cfg.pozo}`);
  revisa("arrastrar el flotador", b.cfg.llenado[1] !== a.cfg.llenado[1], `${a.cfg.llenado} a ${b.cfg.llenado}`);
  // Lo bastante para salir del círculo sin salir de la ventana (a 400 px el círculo llega casi al borde).
  await arrastra("planta", "pozo", -170, 0);
  await arrastra("planta", "boca", 0, 250);
  await espera(1500);
  b = await st();
  let k = await ev(() => window.visor.caja);
  revisa("arrastrar fuera del círculo deja las piezas adentro",
    radio(b.cfg.pozo, k) <= k.R - 0.1 && radio(b.cfg.pozo, k) > k.R - 0.13 && radio(b.cfg.boca, k) <= k.R - 0.42 && !(await page.textContent("#avisos")).includes("No se aplicó"),
    `pozo a ${radio(b.cfg.pozo, k).toFixed(3)} m del centro, boca a ${radio(b.cfg.boca, k).toFixed(3)} (R ${k.R})`);
  await medida("diametro", "300");
  b = await st();
  k = await ev(() => window.visor.caja);
  let nm = await malla();
  revisa("cambiar el diámetro rehace la malla y recorre las piezas", Math.abs(b.cfg.diametro - 3) < 1e-9 && nm[0] === 30 && nm[1] === 30 && nm[2]
    && radio(b.cfg.pozo, k) <= k.R - 0.1, `malla ${nm}, pozo a ${radio(b.cfg.pozo, k).toFixed(3)} m del centro`);
  await page.selectOption("#forma", "rectangular");
  await espera(2500);
  nm = await malla();
  revisa("forma rectangular: largo y ancho, malla de la caja", await page.isVisible("#largo") && !(await page.isVisible("#diametro")) && nm[0] === 34 && nm[1] === 24 && nm[2] === false,
    `malla ${nm}`);
  revisa("el corte vuelve a ser a lo largo", (await page.textContent("label[for=corte-largo]")) === "A lo largo");
  await medida("largo", "300");
  b = await st();
  nm = await malla();
  revisa("cambiar el largo rehace la malla", Math.abs(b.cfg.largo - 3) < 1e-9 && nm[0] === 30, `nx ${nm[0]}`);
  await page.click("#medidas-doc");
  await espera(2500);
  nm = await malla();
  b = await st();
  revisa("regresar a las medidas supuestas: la redonda de 3.26 m", b.cfg.forma === "redonda" && b.cfg.diametro === 3.26 && nm[0] === 33 && nm[2] === true
    && (await page.inputValue("#forma")) === "redonda", `malla ${nm}`);
  await page.uncheck("#editar");

  // Capas, planta a una altura y dosis donde se toca
  await page.locator("label[for=fondo-vel]").scrollIntoViewIfNeeded();
  await page.click("label[for=fondo-vel]");
  revisa("fondo de rapidez", (await page.textContent("#leyenda-nombre")) === "Rapidez");
  await page.click("label[for=fondo-c]");
  await page.click("label[for=planta-z]");
  revisa("planta a una altura muestra su slider", await page.isVisible("#z-planta"));
  await page.click("label[for=planta-prom]");
  await page.click("label[for=lugar-clic]");
  await ev(() => scrollTo(0, 0));
  await espera(300);
  const caja = await page.locator("#c-planta").boundingBox();
  // Afuera del círculo (la esquina de la caja) no cuenta; adentro sí.
  let [qx, qy] = await ev(() => window.visor.aPantalla(0.15, 0.15));
  await page.mouse.click(caja.x + qx, caja.y + qy);
  b = await st();
  revisa("tocar fuera del agua no pone la dosis", !Array.isArray(b.cfg.lugar_dosis), JSON.stringify(b.cfg.lugar_dosis));
  [qx, qy] = await ev(() => window.visor.aPantalla(2.3, 2.0));
  await page.mouse.click(caja.x + qx, caja.y + qy);
  b = await st();
  revisa("tocar la planta pone el punto de la dosis", Array.isArray(b.cfg.lugar_dosis) && Math.abs(b.cfg.lugar_dosis[0] - 2.3) < 0.02, JSON.stringify(b.cfg.lugar_dosis));

  const ch = await ev(() => window.visor.choques());
  revisa("rótulos sin choques", !ch.planta.length && !ch.corte.length, JSON.stringify(ch));
  revisa("sin errores de consola", !errores.length, errores.join(" | "));
  console.log(`${caso.w} px: ${bien} bien, ${mal} mal`);
  fallas += mal;
  await ctx.close();
}

// Arrastre con el dedo en el teléfono y respaldo sin Worker.
async function toqueYRespaldo() {
  {
    const { ctx, page } = await abre({ w: 400, h: 860, dpr: 2, movil: true });
    const caja = await page.locator("#c-planta").boundingBox();
    const m = (await page.evaluate(() => window.visor.manijas("planta"))).find((q) => q.id === "bomba");
    const cdp = await ctx.newCDPSession(page);
    const toca = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const x0 = caja.x + m.x, y0 = caja.y + m.y;
    await toca("touchStart", x0, y0);
    for (let i = 1; i <= 10; i++) await toca("touchMove", x0 + 8 * i, y0 + 5 * i);
    await toca("touchEnd");
    const r = await page.evaluate(() => ({ pos: window.visor.cfg.pos_bomba, scroll: scrollY }));
    const ok = Array.isArray(r.pos) && r.scroll === 0;
    console.log(`${ok ? "bien" : "MAL "} arrastre con el dedo mueve la bomba sin mover la página`);
    if (!ok) fallas++;
    await toca("touchStart", caja.x + 40, caja.y + caja.height - 30);
    for (let i = 1; i <= 10; i++) await toca("touchMove", caja.x + 40, caja.y + caja.height - 30 - 25 * i);
    await toca("touchEnd");
    await page.waitForTimeout(500);
    const desliza = await page.evaluate(() => scrollY);
    console.log(`${desliza > 0 ? "bien" : "MAL "} deslizar fuera de una manija recorre la página (${desliza} px)`);
    if (!(desliza > 0)) fallas++;
    await ctx.close();
  }
  {
    const { ctx, page, errores } = await abre({
      w: 1280, h: 800, antes: () => { window.Worker = function () { throw new Error("sin workers"); }; },
    });
    await page.waitForFunction(() => window.visor.sim.t > 10, null, { timeout: 60000 });
    const r = await midePagina(page, 3);
    const ok = r.motor === "hilo principal" && r.simulaX > 5 && !errores.length;
    console.log(`${ok ? "bien" : "MAL "} sin Worker corre en el hilo principal: ${JSON.stringify(r)}`);
    if (!ok) fallas++;
    await ctx.close();
  }
}

// ---------- casos de la revisión del visor ----------

// Guarda lo que el visor manda al motor (menos control y devoluciones) y el Worker para inyectarle mensajes.
const espiaMotor = () => {
  window.__msgs = [];
  const pm = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) {
    if (m && m.tipo !== "devuelve" && m.tipo !== "control") window.__msgs.push(JSON.parse(JSON.stringify(m)));
    return pm.call(this, m, t);
  };
  const W = window.Worker;
  window.Worker = function (u, o) {
    const w = new W(u, o);
    window.__w = w;
    return w;
  };
  window.Worker.prototype = W.prototype;
};

async function revision() {
  let bien = 0, mal = 0;
  const revisa = (nombre, cond, extra = "") => {
    cond ? bien++ : mal++;
    console.log(`${cond ? "bien" : "MAL "} ${nombre} ${extra}`);
  };
  const ultimaDosis = (page) => page.evaluate(() => window.__msgs.filter((m) => m.tipo === "dosis").at(-1)?.punto);
  {
    const { ctx, page, errores } = await abre({ w: 1280, h: 900, antes: espiaMotor });
    const txt = (id) => page.textContent(`#${id}`);
    await page.waitForFunction(() => document.getElementById("l-formula").textContent.includes("min"));
    const formula0 = await txt("l-formula");
    // Nivel a 55 cm con la bomba a 50: se rechaza y todo sigue con la config que corre.
    await page.fill("#nivel", "55");
    await page.waitForTimeout(800);
    await page.click("#echar");
    await page.waitForTimeout(300);
    const pd = await ultimaDosis(page);
    revisa("cambio rechazado: el control conserva el valor", (await txt("o-nivel")) === "55 cm" && (await txt("avisos")).includes("No se aplicó"));
    revisa("cambio rechazado: volumen y fórmula de la config que corre",
      (await txt("d-volumen")).startsWith("10.0") && (await txt("l-formula")) === formula0 && (await page.evaluate(() => window.visor.sim.H)) === 1.2,
      `${await txt("d-volumen")}, ${await txt("l-formula")} (antes ${formula0})`);
    revisa("cambio rechazado: la dosis sale a 10 cm bajo el nivel que corre", pd && Math.abs(pd[2] - 1.1) < 1e-6, JSON.stringify(pd));
    await page.fill("#altura", "30");
    await page.waitForTimeout(1500);
    revisa("al bajar la bomba se aplica el nivel pendiente", (await page.evaluate(() => window.visor.sim.H)) === 0.55);
    // Planta a una altura: no queda arriba del agua.
    await page.click("label[for=planta-z]");
    await page.fill("#nivel", "100");
    await page.fill("#z-planta", "90");
    await page.fill("#nivel", "60");
    await page.waitForTimeout(300);
    revisa("la planta a una altura baja con el nivel", (await txt("t-planta-sub")) === "a 55 cm del fondo" && (await page.evaluate(() => window.visor.est.zPlanta)) === 0.55, await txt("t-planta-sub"));
    await page.click("label[for=planta-prom]");
    // Dosis tocando la planta: sigue al nivel.
    await page.fill("#nivel", "80");
    await page.waitForTimeout(1500);
    await page.click("label[for=lugar-clic]");
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(300);
    const caja = await page.locator("#c-planta").boundingBox();
    const [qx, qy] = await page.evaluate(() => window.visor.aPantalla(2.3, 2.0));
    await page.mouse.click(caja.x + qx, caja.y + qy);
    await page.fill("#nivel", "120");
    await page.waitForTimeout(1500);
    await page.click("#echar");
    await page.waitForTimeout(300);
    const ld = await page.evaluate(() => window.visor.cfg.lugar_dosis);
    const pd2 = await ultimaDosis(page);
    revisa("el punto tocado sube con el nivel", Array.isArray(ld) && Math.abs(ld[2] - 1.1) < 1e-6 && Math.abs(pd2[2] - 1.1) < 1e-6, `${JSON.stringify(ld)} ${JSON.stringify(pd2)}`);
    // Flecha del chorro casi de frente al corte.
    await page.evaluate(() => window.visor.aplica({ pos_bomba: [1.7, 1.2, 0.5], azimut: 95, elevacion: -10, lugar_dosis: "llenado" }));
    revisa("chorro casi de frente al corte: el pie lo dice", (await txt("pie-corte")).includes("de frente"));
    await page.evaluate(() => window.visor.aplica({ azimut: 60, elevacion: 0 }));
    revisa("chorro a 60°: sin nota de frente", !(await txt("pie-corte")).includes("de frente"));
    // Bomba en el mástil: altura mínima igual al slider.
    await page.click("#montar");
    await page.click("#seguir");
    await page.waitForTimeout(1200);
    await page.locator("#c-corte").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const cc = await page.locator("#c-corte").boundingBox();
    const m = (await page.evaluate(() => window.visor.manijas("corte"))).find((q) => q.id === "bomba-z");
    await page.mouse.move(cc.x + m.x, cc.y + m.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(cc.x + m.x, cc.y + m.y + 25 * i);
    await page.mouse.up();
    const alt = await page.evaluate(() => [window.visor.cfg.z_bomba, document.getElementById("altura").min]);
    revisa("arrastrar la bomba abajo se detiene en el mínimo del slider", alt[0] === 0.08 && alt[1] === "8" && (await txt("o-altura")) === "8 cm", JSON.stringify(alt));
    // Consumo y malla en la tabla de corridas; la meta aclara que no cuenta el consumo.
    await page.selectOption("#malla", "0.15");
    await page.waitForTimeout(1500);
    await page.fill("#consumo", "20");
    await page.dispatchEvent("#consumo", "change");
    await page.waitForTimeout(1200);
    const fila = await page.evaluate(() => document.querySelector("#corridas tr").innerText);
    revisa("la fila anota nivel, consumo y malla", fila.includes("120 cm, 0 y luego 20 L/min") && fila.includes("15 cm"), fila.replace(/\s+/g, " "));
    revisa("con consumo la meta lo aclara", (await txt("l-meta")).includes("si no hubiera consumo"));
    revisa("sin errores de consola", !errores.length, errores.join(" | "));
    await ctx.close();
  }
  {
    // Achicar la cisterna: la boca, el pozo y el flotador se recorren y el cambio se aplica.
    const { ctx, page, errores } = await abre({ w: 1280, h: 900, antes: espiaMotor });
    await page.check("#editar");
    const medida = async (id, valor) => {
      await page.fill(`#${id}`, valor);
      await page.press(`#${id}`, "Enter");
      await page.locator(`#${id}`).blur();
      await page.waitForTimeout(2500);
    };
    await page.evaluate(() => window.visor.aplica({ pos_bomba: [2.6, 2.3, 0.5] }));
    await medida("diametro", "110");
    let r = await page.evaluate(() => ({ L: window.visor.sim.L, cfg: structuredClone(window.visor.cfg), k: window.visor.caja }));
    revisa("achicar la redonda recorre las piezas adentro", r.L === 1.1 && radio(r.cfg.boca, r.k) <= r.k.R - 0.42
      && ["pozo", "llenado", "pos_bomba"].every((p) => radio(r.cfg[p], r.k) <= r.k.R - 0.1),
      ["boca", "pozo", "llenado", "pos_bomba"].map((p) => `${p} ${radio(r.cfg[p], r.k).toFixed(3)}`).join(", ") + ` de R ${r.k.R}`);
    await page.click("#medidas-doc");
    await page.waitForTimeout(500);
    await page.selectOption("#forma", "rectangular");
    await page.waitForTimeout(500);
    await medida("largo", "110");
    r = await page.evaluate(() => ({ L: window.visor.sim.L, boca: window.visor.cfg.boca, redonda: window.visor.sim.redonda }));
    revisa("achicar la rectangular recorre la boca adentro", r.L === 1.1 && r.boca[0] <= 0.8 && r.redonda === false, JSON.stringify(r));
    // Corrida muy larga: 200 mil muestras no truenan la gráfica.
    await page.click("#play");
    await page.waitForTimeout(500);
    const n = await page.evaluate(async () => {
      const s = window.visor.sim, nc = s.nx * s.ny * s.nz;
      const eventos = [];
      for (let i = 0; i < 2e5; i++) {
        eventos.push({ tipo: "muestra", t: s.t + 10 * (i + 1), cFinal: s.cFinal, stats: { cov: 0.01, cmin: 0.99, cmax: 1.01, masa_mg: 0, cmedia: s.cFinal, ek: 0, vmax: 0 }, sondas: { a: s.cFinal, b: s.cFinal, c: s.cFinal } });
      }
      const set = { c: new Float32Array(nc), uc: new Float32Array(nc), vc: new Float32Array(nc), wc: new Float32Array(nc), spd: new Float32Array(nc) };
      window.__w.onmessage({ data: { ...s, tipo: "snap", t: s.t + 2e6, encendida: false, apagaEn: 0, vSim: 0, costoPaso: 1, vmax: 0, vEsc: 0.05, eventos, set } });
      await new Promise((ok) => setTimeout(ok, 1000));
      return window.visor.nSerie;
    }).catch((e) => e.message);
    revisa("200 mil muestras: la serie se diezma y la gráfica sigue", typeof n === "number" && n <= 3000 && !errores.length, `${n} muestras ${errores.join(" | ")}`);
    await ctx.close();
  }
  {
    // La redonda: cloro y partículas solo en el agua, el corte es la cuerda por la bomba y el chorro pega
    // en la pared del cilindro.
    const { ctx, page, errores } = await abre({ w: 1280, h: 900 });
    await page.selectOption("#velocidad", "120");
    await page.waitForTimeout(4000);
    const pixel = (x, y) => page.evaluate(([x, y]) => {
      const [px, py] = window.visor.aPantalla(x, y), c = document.getElementById("c-planta");
      const d = c.getContext("2d").getImageData(Math.round(px * c.width / c.clientWidth), Math.round(py * c.height / c.clientHeight), 1, 1).data;
      const papel = getComputedStyle(document.documentElement).getPropertyValue("--papel").trim().slice(1);
      return { rgb: [...d.slice(0, 3)], papel: [0, 2, 4].map((i) => parseInt(papel.slice(i, i + 2), 16)) };
    }, [x, y]);
    const esquina = await pixel(0.12, 0.12), centro = await pixel(1.63, 2.6);
    const igual = (a, b) => a.every((q, i) => Math.abs(q - b[i]) <= 2);
    revisa("el cloro se pinta solo dentro del círculo", igual(esquina.rgb, esquina.papel) && !igual(centro.rgb, centro.papel), JSON.stringify({ esquina, centro }));
    for (const corte of ["largo", "chorro"]) {
      await page.click(`label[for=corte-${corte}]`);
      for (const c of [{ pos_bomba: null, azimut: 0 }, { pos_bomba: [2.7, 2.2, 0.3], azimut: -150, elevacion: -10 }, { pos_bomba: [0.5, 1.2, 0.6], azimut: 70, elevacion: 0 }]) {
        await page.evaluate((c) => window.visor.aplica(c), c);
        await page.waitForTimeout(2000);
        const q = await page.evaluate(() => {
          const { o, h, h0, h1 } = window.visor.corte, k = window.visor.caja, ray = window.visor.rayo();
          const ext = [h0, h1].map((s) => Math.hypot(o[0] + s * h[0] - k.cx, o[1] + s * h[1] - k.cy) - k.R);
          return { ext, rayo: ray.donde === "pared" ? Math.hypot(ray.fin[0] - k.cx, ray.fin[1] - k.cy) - k.R : 0, fuera: window.visor.fueraDelAgua() };
        });
        const nombre = `${corte}, bomba ${c.pos_bomba ? c.pos_bomba.slice(0, 2) : "en el tubo"}`;
        revisa(`corte por la cuerda (${nombre})`, q.ext.every((e) => Math.abs(e) < 1e-9) && Math.abs(q.rayo) < 1e-9, JSON.stringify(q.ext));
        revisa(`partículas solo en el agua (${nombre})`, q.fuera.n === 0 && q.fuera.total > 200, JSON.stringify(q.fuera));
      }
    }
    revisa("sin errores de consola (redonda)", !errores.length, errores.join(" | "));
    await ctx.close();
  }
  console.log(`revisión: ${bien} bien, ${mal} mal`);
  fallas += mal;
}

// ---------- rótulos ----------

async function rotulos() {
  const redondas = [
    ["por omisión", {}],
    ["chorro a 90°", { azimut: 90 }],
    ["chorro hacia el pozo", { azimut: 180 }],
    ["chorro inclinado", { azimut: 45, elevacion: -25 }],
    ["libre junto a la pared", { pos_bomba: [2.7, 2.2, 0.3], azimut: -150, elevacion: -10 }],
    ["libre del otro lado", { pos_bomba: [0.6, 1.0, 0.6], azimut: 30, elevacion: 0 }],
    ["bomba baja", { z_bomba: 0.15 }],
    ["dosis en la boca", { lugar_dosis: "mastil" }],
    ["dosis libre", { lugar_dosis: [2.4, 0.9, 1.1] }],
    ["nivel a 70 cm", { nivel: 0.7, z_bomba: 0.35 }],
    ["boca a un lado", { boca: [2.2, 1.63], pozo: [1.9, 1.63, 0.45], llenado: [1.9, 1.88, 1.1] }],
    ["diámetro 2.5 m", { diametro: 2.5, boca: [1.25, 1.25], pozo: [0.95, 1.25, 0.45], llenado: [0.95, 1.5, 1.1] }],
  ].map(([n, c]) => [`redonda, ${n}`, { ...REDONDA, ...c }]);
  const rectangulares = [
    ["por omisión", {}],
    ["libre al centro", { pos_bomba: [1.7, 1.2, 0.5], azimut: 0, elevacion: -10 }],
    ["libre en la esquina", { pos_bomba: [3.1, 2.2, 0.3], azimut: -135, elevacion: 0 }],
    ["libre junto al pozo", { pos_bomba: [1.1, 0.7, 0.6], azimut: 90, elevacion: -30 }],
    ["mástil a 30°", { angulo_tubo: 30, z_bomba: 0.4 }],
    ["mástil a 85°, alta", { angulo_tubo: 85, z_bomba: 0.9, elevacion: 0, azimut: 180 }],
    ["bomba baja", { z_bomba: 0.15, elevacion: -20 }],
    ["dosis en la boca", { lugar_dosis: "mastil" }],
    ["dosis libre", { lugar_dosis: [2.5, 0.6, 1.1] }],
    ["nivel a 70 cm", { nivel: 0.7, z_bomba: 0.35 }],
  ].map(([n, c]) => [`rectangular, ${n}`, { ...RECT_DOC, ...c }]);
  const configs = [...redondas, ...rectangulares];
  let total = 0, revisados = 0;
  for (const w of [400, 760, 1024, 1280, 1600]) {
    const { ctx, page } = await abre({ w, h: 860 });
    for (const corte of ["largo", "chorro"]) {
      await page.click(`label[for=corte-${corte}]`);
      for (const [nombre, cambios] of configs) {
        await page.evaluate((c) => window.visor.aplica(c), cambios);
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => window.visor.choques());
        const malos = [...r.planta.map((x) => `planta: ${x}`), ...r.corte.map((x) => `corte: ${x}`)];
        revisados++;
        total += malos.length;
        if (malos.length) console.log(`${w} px, corte ${corte}, ${nombre}: ${malos.join(" | ")}`);
      }
    }
    await ctx.close();
  }
  console.log(`${revisados} vistas revisadas, ${total} rótulos con choque`);
  fallas += total;
}

// ---------- rendimiento ----------

async function rendimiento() {
  for (const caso of [{ w: 1280, h: 800 }, { w: 1920, h: 1080 }, { w: 400, h: 860, dpr: 2, movil: true }]) {
    const { ctx, page } = await abre({ ...caso, antes: vigilaLargas });
    await page.waitForTimeout(4000);
    const nombre = `${caso.w}x${caso.h}@${caso.dpr ?? 1}`;
    console.log(nombre, "a 30x", JSON.stringify(await midePagina(page, 5)));
    await page.selectOption("#velocidad", "120");
    await page.waitForTimeout(2000);
    console.log(nombre, "a 120x", JSON.stringify(await midePagina(page, 5)));
    // Arrastre continuo: la bomba cambia de lugar en cada cuadro.
    const arr = await page.evaluate(async () => {
      const t0 = performance.now();
      let n = 0, peor = 0, prev = t0;
      await new Promise((ok) => {
        const f = (t) => {
          n++;
          peor = Math.max(peor, t - prev);
          prev = t;
          const a = (t - t0) / 1000;
          const k = window.visor.caja;
          window.visor.cfg.pos_bomba = [k.cx + Math.cos(a) * 0.8, k.cy + Math.sin(a) * 0.6, 0.5];
          window.visor.aplica({});
          if (t - t0 < 3000) requestAnimationFrame(f);
          else ok();
        };
        requestAnimationFrame(f);
      });
      return { fps: Math.round((n / ((performance.now() - t0) / 1000)) * 10) / 10, peorCuadroMs: Math.round(peor), piezasMs: Math.round(window.visor.perf.overlayMs * 10) / 10 };
    });
    console.log(nombre, "arrastrando", JSON.stringify(arr));
    await ctx.close();
  }
}

// ---------- contrato del artifact ----------

async function contrato() {
  const { readFileSync } = await import("node:fs");
  const dir = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const app = readFileSync(join(dir, "app.js"), "utf8");
  const todo = html + app + readFileSync(join(dir, "worker.js"), "utf8");
  const revisa = (nombre, ok, extra = "") => {
    if (!ok) fallas++;
    console.log(`${ok ? "bien" : "MAL "} ${nombre} ${extra}`);
  };
  revisa("empieza con <title> de 2 a 4 palabras", /^<title>(\S+\s){1,3}\S+<\/title>/.test(html));
  revisa("sin doctype, html, head ni body", !/<!doctype|<(html|head|body)[\s>]/i.test(html));
  revisa("modo oscuro guardado y repetido", html.includes('@media (prefers-color-scheme: dark)') && html.includes(':root:not([data-theme="light"])') && html.includes(':root[data-theme="dark"]'));
  revisa("body con fondo de token", /body\s*\{[^}]*background:\s*var\(--/.test(html));
  revisa("sin scripts externos", !/<script[^>]+src="(https?:)?\/\//.test(html));
  revisa("sin alert, confirm ni prompt", !/\b(alert|confirm|prompt)\(/.test(todo));
  revisa("Worker desde archivo propio como módulo", /new Worker\(new URL\("\.\/worker\.js", import\.meta\.url\), \{ type: "module" \}\)/.test(app));
  revisa("sin rayas largas ni medias", !/[\u2013\u2014]/.test(todo));
  revisa("movimiento reducido en CSS y JS", html.includes("prefers-reduced-motion") && app.includes("prefers-reduced-motion"));
  revisa("foco visible", html.includes(":focus-visible"));

  for (const tema of ["light", "dark"]) {
    const { ctx, page, errores } = await abre({ w: 400, h: 860, dpr: 2, movil: true, tema });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ ancho: document.documentElement.scrollWidth, ventana: innerWidth, fondo: getComputedStyle(document.body).backgroundColor }));
    revisa(`400 px sin scroll horizontal (${tema})`, r.ancho <= r.ventana, `${r.ancho} de ${r.ventana}`);
    // data-theme manda sobre el sistema
    const contrario = tema === "light" ? "dark" : "light";
    const fondo2 = await page.evaluate(async (t) => {
      document.documentElement.dataset.theme = t;
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      return getComputedStyle(document.body).backgroundColor;
    }, contrario);
    revisa(`data-theme="${contrario}" cambia el tema sobre el sistema ${tema}`, fondo2 !== r.fondo, `${r.fondo} a ${fondo2}`);
    revisa(`sin errores (${tema})`, !errores.length, errores.join(" | "));
    await ctx.close();
  }
  {
    const { ctx, page } = await abre({ w: 1280, h: 800 });
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement, cs = getComputedStyle(el);
      return { id: el.id, estilo: cs.outlineStyle, ancho: cs.outlineWidth };
    });
    revisa("el primer Tab llega a un control con contorno visible", f.id && f.estilo !== "none" && parseFloat(f.ancho) >= 2, JSON.stringify(f));
    await ctx.close();
  }
  {
    const ctx = await navegador.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForFunction(() => window.visor?.sim?.t > 1, null, { timeout: 60000 });
    const capas = await page.evaluate(() => window.visor.est.capas);
    revisa("con movimiento reducido: flechas en vez de partículas", !capas.part && capas.flechas, JSON.stringify(capas));
    await ctx.close();
  }
}

if (modo === "contrato" || modo === "todo") await contrato();
if (modo === "capturas" || modo === "todo") await capturas();
if (modo === "controles" || modo === "todo") {
  await controles({ w: 1280, h: 800 });
  await controles({ w: 400, h: 860, dpr: 2, movil: true });
  await toqueYRespaldo();
  await revision();
}
if (modo === "revision") await revision();
if (modo === "rotulos" || modo === "todo") await rotulos();
if (modo === "rendimiento" || modo === "todo") await rendimiento();
await navegador.close();
process.exit(fallas ? 1 : 0);
