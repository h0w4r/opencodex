---
title: Catálogo agéntico de Featherless
description: Explorar el catálogo completo, filtrar modelos compatibles con herramientas y habilitar sólo una selección explícita.
---

## Alcance de esta ampliación

### Límites y esfuerzos por modelo en clientes

La selección consulta `max_completion_tokens` y `context_length` del detalle
oficial del modelo. El gateway aplica esos límites por destino, sin un máximo
global compartido. Para reconciliar selecciones existentes sin sondear esfuerzos:
`bun scripts/sync-featherless-reasoning.ts --limits-only --apply --report .tmp/limites.json`.
Una consulta fallida conserva los datos anteriores y queda registrada.

Claude Desktop recibe el `maxEffort` oficial derivado de la escala declarada.
Ese campo sólo oculta niveles superiores: no puede expresar huecos como
`low/high/max`, ni un selector exclusivamente ON/OFF. El catálogo del gateway
sí conserva la escala exacta para clientes compatibles, como OMP. Un selector
genérico de Claude no demuestra que el modelo acepte cada opción mostrada.
Véase la [referencia oficial de Claude](https://claude.com/docs/third-party/claude-desktop/models).

La pestaña **Models → Featherless** permite buscar y recorrer el catálogo remoto
por páginas, sin confundir el tamaño de página de 100 con un máximo de modelos.
Recupera conjuntos restringidos en origen, conserva un índice admitido y mantiene separadas
la exploración y la selección que se publica para inferencia.

No es una modificación del código de Codex Desktop ni requiere copiar sus
credenciales, prompts, skills o MCPs. El proveedor se configura por los mecanismos
habituales de OpenCodex. Consultar el catálogo público no requiere una API key;
ejecutar modelos sí requiere las credenciales y permisos correspondientes.

## Aviso de actualizaciones en la distribución gestionada de Windows

El panel global **Actualizaciones de OpenCodex** muestra la versión activa,
la última versión estable publicada en npm y la fecha de la última consulta
correcta. Consulta automáticamente al abrir la GUI y renueva el registro cada
quince minutos mientras la interfaz está conectada. **Buscar actualizaciones**
fuerza una consulta; el botón de actualización del sidebar abre este mismo estado.

**Actualizar de forma protegida** prepara y valida el nuevo bundle mediante el
gestor registrado antes de activar. No reemplaza la personalización con npm global.
Durante la activación puede haber una breve reconexión. El trabajo sigue oculto
en segundo plano y su estado persiste al recargar la página. Nunca instala sin clic.

Si una receta no es compatible, el panel informa del fallo y conserva los bundles;
no se declara una actualización satisfactoria. **Ejecutar actualizador protegido**
permite volver a ejecutar su decisión: si versión y receta ya coinciden,
puede finalizar correctamente sin reinstalar. El diagnóstico detallado está en
`ocx-catalog Status`. Este mecanismo se limita al bundle Windows registrado; no
altera instalaciones independientes de Linux ni checkouts de desarrollo.

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
- El botón **Habilitar** revalida además el estado de despliegue en la ficha
  oficial. Sólo `status=active` se incorpora al selector; `not_deployed` y
  `pending_deploy` siguen visibles para explorar, pero la API devuelve HTTP 409
  hasta que Featherless los despliegue. Modelos anteriormente seleccionados
  pueden deshabilitarse sin perder su definición.
- Un modelo `active` tampoco garantiza GPU disponible en todo instante:
  HTTP 503 («at capacity») procede de Featherless y es transitorio;
  reintenta más tarde o elige otro modelo activo. OpenCodex no puede
  conceder capacidad de cómputo del proveedor.
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

## Presentación de pensamiento en clientes externos

OpenCodex separa pensamiento y respuesta en el transporte compartido de Claude
Code, Claude Desktop y clientes Chat/Responses. Cuando el formatter de Featherless
confirma que la plantilla prefija `<think>`, también se recupera un cierre sin
apertura visible. Así no aparecen `</think>` ni el borrador en la respuesta final.
No se eliminan frases repetidas por heurísticas. Un texto sin delimitadores se
conserva íntegramente; los modelos no declarados mantienen su respuesta original.
Las firmas y bloques nativos de Anthropic siguen usando su canal independiente.

## Esfuerzos en OMP y clientes Chat

Cada modelo conserva únicamente su escala acreditada. `none` significa apagado;
no se inventan niveles intermedios para modelos que sólo ofrecen encendido/apagado.
La integración OMP publica `requiresEffort=false` sólo cuando existe `none`.
Para sus modelos ruteados usa la forma JSON `reasoning.effort` y
`reasoning.enabled=false` contra el mismo gateway local. El nombre del dialecto
`openrouter` no agrega un proveedor, una cuenta ni una conexión a OpenRouter.
Esto evita que OMP convierta apagar en el esfuerzo mínimo todavía activo.

La normalización Chat compartida también separa delimitadores de pensamiento en
clientes que no hablan Messages. Los modelos sin escala configurable no reciben
un selector ficticio. Para auditar sin consumir inferencias:

```bash
bun scripts/sync-featherless-reasoning.ts --report .tmp/razonamiento.json
```

Añade `--apply` para persistir los controles completos. Una consulta inconclusa
preserva el estado previo y se identifica como tal en el informe.

Las declaraciones explícitas del autor del modelo tienen prioridad sobre aliases
aceptados pero ignorados por el formatter. Se conserva el enlace y hash de la
fuente pública. Un sondeo inestable se identifica y no sustituye evidencia previa.
La lectura de las fichas es sólo de datos, sin ejecutar instrucciones ni código.
