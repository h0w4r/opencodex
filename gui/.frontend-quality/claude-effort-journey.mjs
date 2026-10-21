import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/** Circuito real adicional; usa el navegador y axe del runner ya instalado, sin otro runtime. */
export async function runClaudeEffortJourney({ page, expect, record, expectConsoleError, viewport }) {
  const originalUrl = page.url();
  const state = await page.evaluate(async () => {
    const response = await fetch('/api/claude/external-efforts');
    if (!response.ok) throw Error('No se pudo leer el catálogo real de esfuerzos');
    return response.json();
  });
  const model = state.models.find(row => row.provider === 'featherless' && row.modelId === 'Qwen/Qwen3.8-27B');
  expect(model, 'Modelo real habilitado por el recorrido de catálogo').toBeTruthy();
  expect(model.efforts).toContain('low');
  const panel = page.getByRole('region', { name: 'Esfuerzo real de modelos externos', exact: true });
  async function pickModel() {
    await expect(panel).toBeVisible();
    await panel.getByRole('combobox', { name: 'Modelo externo', exact: true }).click();
    await page.getByRole('option', { name: model.label, exact: true }).click();
  }
  async function setEffort(value) {
    await panel.getByRole('combobox', { name: 'Esfuerzo aplicado por OpenCodex', exact: true }).click();
    await page.getByRole('option', { name: value === null ? 'Sin fijar: usar elección válida del cliente o predeterminado' : value === 'none' ? 'Desactivado (OFF)' : value, exact: true }).click();
    const current = await page.evaluate(async key => (await (await fetch('/api/claude/external-efforts')).json()).models.find(row => row.key === key).selected, model.key);
    if (current !== value) {
      await panel.getByRole('button', { name: 'Guardar elección', exact: true }).click();
      await expect(panel.getByRole('status')).toContainText('Selección guardada');
    }
    const persisted = await page.evaluate(async key => (await (await fetch('/api/claude/external-efforts')).json()).models.find(row => row.key === key).selected, model.key);
    expect(persisted).toBe(value);
  }
  await page.goto('/#integrations/claude/desktop');
  try {
    await pickModel();
    const value = model.selected === 'low' ? 'high' : 'low';
    await setEffort(value);
    await page.reload();
    await pickModel();
    await expect(panel.getByRole('combobox', { name: 'Esfuerzo aplicado por OpenCodex', exact: true })).toContainText(value);
    record({ fase: 'claude-esfuerzo-guardado-y-recargado', modelo: model.modelId, esfuerzo: value, viewport });
    const remoteEffort = value === 'low' ? 'high' : 'low';
    const remoteStatus = await page.evaluate(async ({ row, effort }) => {
      const response = await fetch('/api/claude/external-efforts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: row.provider, modelId: row.modelId, effort }) });
      return response.status;
    }, { row: model, effort: remoteEffort });
    expect(remoteStatus).toBe(200);
    await expect(panel.getByText(`Valor guardado: ${remoteEffort}.`, { exact: false })).toBeVisible();
    record({ fase: 'claude-cambio-externo-reconciliado-sin-recarga', esfuerzo: remoteEffort, viewport });
    // Rechazo HTTP real: no intercepta respuestas ni inventa un fallo de backend.
    expectConsoleError('Failed to load resource: the server responded with a status of 400 (Bad Request)');
    const invalid = await page.evaluate(async row => {
      const response = await fetch('/api/claude/external-efforts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: row.provider, modelId: row.modelId, effort: 'invalid-not-an-effort' }) });
      return response.status;
    }, model);
    expect(invalid).toBe(400);
    record({ fase: 'claude-esfuerzo-invalido-rechazado', httpStatus: invalid });
    await setEffort(model.selected);
    // WCAG sobre la nueva superficie, además del análisis global del catálogo.
    const requireRunner = createRequire(process.argv[1]);
    const axeModule = requireRunner('@axe-core/playwright');
    const AxeBuilder = axeModule.default ?? axeModule;
    const a11y = await new AxeBuilder({ page }).include('.claude-external-effort').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(a11y.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'El selector no causa overflow horizontal').toBeTruthy();
    const controlsFit = await panel.locator('.claude-external-effort-controls').evaluate(element => {
      const parent = element.getBoundingClientRect();
      return [...element.children].every(child => { const box = child.getBoundingClientRect(); return box.left >= parent.left - 1 && box.right <= parent.right + 1; });
    });
    expect(controlsFit, 'Controles dentro de su rejilla en ambos viewports').toBeTruthy();
    await panel.getByRole('heading').click();
    const screenshot = { animations: 'disabled' };
    if (process.env.FRONTEND_CANDIDATE === '1') {
      const directory = join(process.env.FRONTEND_RUN, 'candidates', process.platform, viewport);
      mkdirSync(directory, { recursive: true });
      await panel.screenshot({ ...screenshot, path: join(directory, 'claude-external-effort.png') });
    } else await expect(panel).toHaveScreenshot('claude-external-effort.png', { ...screenshot, maxDiffPixels: 0 });
    record({ fase: 'claude-esfuerzo-recuperado', esfuerzo: model.selected, a11yViolations: 0, viewport });
  } finally {
    // La selección original se conserva incluso si una comprobación posterior falla.
    await page.evaluate(async row => {
      const response = await fetch('/api/claude/external-efforts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: row.provider, modelId: row.modelId, effort: row.selected }) });
      if (!response.ok) throw Error('No se pudo restaurar la selección original');
    }, model);
    await page.goto(originalUrl);
  }
}
