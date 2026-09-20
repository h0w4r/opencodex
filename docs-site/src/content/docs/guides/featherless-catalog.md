---
title: Catálogo agéntico de Featherless
description: Explorar el catálogo completo, filtrar modelos compatibles con herramientas y habilitar sólo una selección explícita.
---

## Alcance de esta ampliación

La pestaña **Models → Featherless** permite buscar y recorrer el catálogo remoto
por páginas, sin confundir el tamaño de página de 100 con un máximo de modelos.
Recupera conjuntos restringidos en origen, conserva un índice admitido y mantiene separadas
la exploración y la selección que se publica para inferencia.

No es una modificación del código de Codex Desktop ni requiere copiar sus
credenciales, prompts, skills o MCPs. El proveedor se configura por los mecanismos
habituales de OpenCodex. Consultar el catálogo público no requiere una API key;
ejecutar modelos sí requiere las credenciales y permisos correspondientes.

## Regla de admisión

El modelo debe cumplir **ambas** condiciones:

1. Featherless declara compatibilidad con tool calling mediante un indicador
   booleano: `supports_tool_calling=true` o `features.tool_use=true`.
2. Tiene al menos **16B de parámetros totales**, o presenta una excepción
   declarada de ajustes de censura o especialización en ciberseguridad.

Un indicador negativo prevalece ante datos contradictorios. Los valores ausentes
o textuales no se consideran confirmación. Las etiquetas genéricas `agent`,
`instruct`, nombres de familias y los nombres comerciales no sustituyen al
indicador de herramientas. Las excepciones de tamaño tampoco lo sustituyen.

Se usan parámetros totales publicados, no los parámetros activos de un MoE ni
cifras adivinadas del identificador. No se impone un mínimo de contexto.

Los MCPs y las skills son funciones del harness. El filtro comprueba una
declaración del proveedor; **no certifica la calidad agéntica ni todos los
MCPs, herramientas y skills en cada modelo**. Para acreditar un modelo concreto
hay que ejecutar una interacción real con herramientas y su continuación.

## Navegación y selección

- La búsqueda, el orden y las facetas se consultan en el índice remoto.
- El filtro remoto `capabilities=tool-use` permanece activo al restablecer la UI.
- También se verifican localmente los indicadores de cada fila.
- Las restricciones son obligatorias y preceden a cualquier filtro de navegación.
- Los contadores, facetas y páginas pertenecen sólo al índice admitido. La GUI no
  recibe los 49.000 modelos para descartarlos después.
- La primera preparación muestra progreso real. Las consultas posteriores operan
  sobre una caché persistente de seis horas, sin repetir la descarga completa.
- Se consultan >=16B+tools y conjuntos de excepción+tools; nunca se recorre el
  catálogo general para construir la vista del navegador.
- Si un refresco falla se conserva el último índice completo, con fecha y error.
- La popularidad es relativa al conjunto admitido. Los órdenes de tendencia y
  valoración conservan orden publicado por conjuntos: el proveedor no expone
  puntuaciones globales que permitan una mezcla exacta sin recorrer su universo.
- El botón **Habilitar** revalida la política en el backend y guarda el modelo
  en `OcxConfig.customModels`. Una petición directa no omite esa comprobación.
- Deshabilitar una selección previa funciona aunque ya no exista en el catálogo.
- `OcxProviderConfig.liveModels=false` evita que el descubrimiento heredado
  reintroduzca una primera página distinta en la selección activa.

## Selecciones anteriores

Desde el checkout del código, `bun scripts/adopt-featherless-catalog.ts` revisa
los modelos ya configurados de proveedores con la URL oficial de Featherless.
Consulta metadatos reales y deshabilita los incompatibles sin borrar definiciones
ni credenciales. Una caída de red aborta antes de guardar cambios parciales.
Los proveedores con destinos personalizados no se modifican por su nombre.

## Validación y limitaciones

Las pruebas unitarias de política están en
`tests/providers/featherless-catalog-policy.test.ts`.
`scripts/verify-featherless-live.ts` verifica búsqueda y paginación reales.
`scripts/verify-featherless-gateway.ts` comprueba selección durable, rechazo de
modelos incompatibles, una inferencia y un circuito de tool calling con lectura
real de un archivo temporal y devolución de su contenido al modelo.

Los scripts de validación escriben evidencias en `.tmp/`, fuera del código
versionado. No deben publicarse homes, tokens, claves, logs de conversaciones
ni archivos de configuración personales.

La búsqueda facetada utiliza la API pública del sitio de Featherless; no tiene
la misma garantía de estabilidad que la API documentada de inferencia. Ante un
fallo de red o un contrato desconocido se informa del error: no se sustituye
silenciosamente el catálogo por una lista parcial ni por respuestas simuladas.
