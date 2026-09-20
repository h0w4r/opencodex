/** Circuito real con Featherless y el servidor aislado 10101; nunca intercepta respuestas. */
export async function runJourney({ page, expect, record, viewport }) {
  const search = page.getByRole('searchbox', { name: 'Buscar modelos Featherless' });
  const status = page.locator('.fl-results [role=status]');
  await expect(status).toContainText('modelos admitidos');
  record({ fase: 'catalogo-publico', viewport, estado: await status.innerText() });
  const filterToggle = page.getByRole('button', { name: 'Filtros del catálogo', exact: true });
  if (viewport === 'mobile') await filterToggle.click();
  // Recorre todas las familias de filtros con vocabulario remoto real.
  for (const [group, label] of [['Arquitectura', 'Arquitecturas'], ['Idioma', 'Idiomas'], ['Dominio', 'Dominios'], ['Entrenamiento', 'Método de entrenamiento'], ['Licencia', 'Licencias']]) {
    await page.getByRole('button', { name: group, exact: true }).click();
    await expect(page.getByRole('textbox', { name: `Filtrar opciones: ${label}`, exact: true })).toBeVisible();
    await expect(page.locator('.fl-buckets button').first()).toBeVisible();
  }
  await page.getByRole('button', { name: 'Principal', exact: true }).click();
  if (viewport === 'mobile') await filterToggle.click();
  await page.getByRole('spinbutton', { name: 'Página del catálogo' }).fill('2');
  await page.getByRole('button', { name: 'Ir', exact: true }).click();
  await expect(status).toContainText('página 2 de');
  record({ fase: 'pagina-2-no-recortada', estado: await status.innerText() });
  await search.fill('Qwen/Qwen3-0.6B');
  await expect(page.getByText('No hay modelos admitidos que coincidan con estos filtros.', { exact: true })).toBeVisible();
  await expect(page.locator('.fl-model')).toHaveCount(0);
  record({ fase: 'modelo-pequeno-excluido', estado: await status.innerText() });
  // Tamaño suficiente no puede saltarse el requisito de herramientas.
  await search.fill('google/gemma-3-27b-it');
  await expect(page.getByText('No hay modelos admitidos que coincidan con estos filtros.', { exact: true })).toBeVisible();
  await expect(page.locator('.fl-model')).toHaveCount(0);
  record({ fase: 'modelo-27B-sin-herramientas-excluido' });
  const exception = 'huihui-ai/Huihui-Qwen3-VL-4B-Instruct-abliterated';
  await search.fill(exception);
  await expect(page.getByRole('link', { name: exception, exact: true })).toBeVisible();
  await expect(page.locator('.fl-model').filter({ hasText: exception })).toContainText('Incluido por excepción declarada');
  record({ fase: 'excepcion-real-4B', modelo: exception });
  const id = 'Qwen/Qwen3.8-27B';
  await search.fill(id);
  await expect(page.getByRole('link', { name: id, exact: true })).toBeVisible();
  await expect(page.locator('.fl-policy')).toContainText('Sólo modelos con tool calling');
  await expect(page.locator('.fl-model').filter({ hasText: id })).toContainText('Tool calling declarado');
  const off = page.getByRole('button', { name: `Deshabilitar: ${id}`, exact: true });
  if (await off.count()) await off.click();
  await page.getByRole('button', { name: `Habilitar: ${id}`, exact: true }).click();
  await expect(off).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(off).toHaveAttribute('aria-pressed', 'true');
  await expect(search).toHaveValue(id);
  // En móvil encuadra la tarjeta y sus controles; el cuerpo es el contenedor de scroll real.
  if (viewport === 'mobile') await page.locator('.fl-model').scrollIntoViewIfNeeded();
  record({ fase: 'seleccion-persistida-tras-recarga', modelo: id, habilitado: true });
}
