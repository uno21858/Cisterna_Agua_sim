// Capturas del visor con Playwright: escritorio y teléfono, claro y oscuro.
// Uso: npx http-server web -p 8080 (en otra terminal) y luego node web/capturas.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "/opt/node22/lib/node_modules/playwright");
const base = process.env.URL ?? "http://localhost:8080/dev.html";
const salida = join(dirname(fileURLToPath(import.meta.url)), "test", "capturas");
mkdirSync(salida, { recursive: true });

const casos = [
  { nombre: "escritorio_claro", w: 1280, h: 800, tema: "light" },
  { nombre: "escritorio_oscuro", w: 1280, h: 800, tema: "dark" },
  { nombre: "telefono_claro", w: 400, h: 860, tema: "light", movil: true },
  { nombre: "telefono_oscuro", w: 400, h: 860, tema: "dark", movil: true },
];

const navegador = await chromium.launch();
const errores = [];
const reporte = [];
for (const caso of casos) {
  const ctx = await navegador.newContext({
    viewport: { width: caso.w, height: caso.h }, deviceScaleFactor: caso.movil ? 2 : 1,
    isMobile: !!caso.movil, hasTouch: !!caso.movil,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errores.push(`${caso.nombre}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errores.push(`${caso.nombre}: ${e.message}`));
  await page.emulateMedia({ colorScheme: caso.tema });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.visor?.sim?.t > 20, null, { timeout: 60000 });
  await page.waitForTimeout(6000);
  const datos = await page.evaluate(async () => {
    const t0 = performance.now();
    let n = 0;
    await new Promise((ok) => {
      const f = () => (++n < 120 ? requestAnimationFrame(f) : ok());
      requestAnimationFrame(f);
    });
    const fps = n / ((performance.now() - t0) / 1000);
    const doc = document.documentElement;
    return {
      fps, t: window.visor.sim.t, vSim: window.visor.vSim, costoPaso: window.visor.costoPaso,
      anchoDoc: doc.scrollWidth, anchoVentana: window.innerWidth,
    };
  });
  reporte.push({ caso: caso.nombre, ...datos });
  await page.screenshot({ path: join(salida, `${caso.nombre}.png`), fullPage: !!caso.movil });
  if (!caso.movil) await page.screenshot({ path: join(salida, `${caso.nombre}_completa.png`), fullPage: true });
  await ctx.close();
}
await navegador.close();
console.log(JSON.stringify({ reporte, errores }, null, 2));
