# Explorador completo de Featherless

Ampliación local de OpenCodex 2.59.0. El catálogo navegable está separado de la
selección de modelos que se publica para inferencia. No cambia los adaptadores,
el inicio de sesión, los prompts ni el enrutamiento de los demás proveedores.

## Fuentes y contratos

- `src/providers/featherless-catalog.ts` consulta exclusivamente
  `https://api.featherless.ai/feather/search/models`, el endpoint público usado
  por el explorador web de Featherless, comprobado el 20/09/2026.
- No envía API keys ni cookies a ese endpoint. Un catálogo público no prueba
  que la cuenta esté autenticada ni que tenga derecho a ejecutar un modelo.
- La API de búsqueda del sitio no tiene la misma garantía de estabilidad que
  la API de inferencia documentada. Los errores HTTP y contratos desconocidos
  se muestran explícitamente, sin sustituirlos por una lista recortada.
- `src/server/management/featherless-routes.ts` conserva la autenticación,
  protección de origen y límite de cuerpos del middleware de gestión existente.
- `gui/src/pages/FeatherlessCatalog.tsx` se monta en `#models/featherless`.
  El vocabulario de filtros se recibe del proveedor; no es una lista congelada.

## Política de inclusión

`classifyFeatherlessModel` admite `parameter_size >= 16000000000` o una excepción
declarada en las etiquetas o en el nombre específico del modelo. Usa parámetros
totales publicados, no los parámetros activos de un MoE ni una cifra inferida
del nombre. `model_class.parameter_size` se utiliza cuando falta el dato directo.

Las excepciones abarcan vocabulario de eliminación de rechazos/censura y de
especialización en ciberseguridad. Cada admisión conserva `FeatherlessModel.evidence`.
El namespace de un autor no basta para declarar especializados todos sus modelos.
Los datos de tamaño desconocidos sin excepción quedan separados como `unknown`.
Una etiqueta o un nombre son una declaración del publicador, no una evaluación
del comportamiento real. No se garantiza detectar terminologías futuras todavía
no reconocidas ni información que el proveedor omita o publique incorrectamente.

No se impone un mínimo de contexto. Es obligatorio además que el proveedor
declare tool calling mediante `supports_tool_calling=true` o
`features.tool_use=true`, o que exista una prueba runtime vigente de un recorrido
streaming completo de herramienta y devolución de resultado. Un valor negativo
prevalece ante metadatos contradictorios, pero no ante esa evidencia operativa.
Sin indicador ni prueba se excluye el modelo; las etiquetas `agent`, `instruct`,
nombres o familias sólo priorizan revisión y no sustituyen la prueba. Las
excepciones de tamaño no omiten este requisito. Los MCPs y las skills pertenecen
al harness: no se afirma que el catálogo acredite cada integración.

## Paginación, filtros y eficiencia

`GET /api/featherless/models` acepta `page`, `query`, `sort`, filtros repetidos de
modalidad, parámetros, familia, capacidad, arquitectura, idioma, dominio,
creatividad, entrenamiento, licencia y popularidad. Admite además exclusividad,
tendencia, prioridad de modelos cargados y recencia de publicación.

Conserva los seis órdenes del sitio: tendencia, descargas, favoritos, fecha,
tamaño y valoración. La consulta va al índice del proveedor, no a los cien
modelos que casualmente se encuentren en la memoria del cliente.

El índice persistente recupera primero el conjunto >=16B con
`parameter_size_min=16` y `supports_tool_calling=true` en origen. Los límites
numéricos de esa API se expresan en miles de millones. Después recupera únicamente
conjuntos de excepción (etiquetas especializadas y consultas por nombre), siempre
con herramientas exigidas en origen. Deduplica IDs y verifica los indicadores
antes de persistir. Finalmente, `src/providers/featherless-capability-evidence.ts`
lee pruebas locales sanitizadas y vigentes, reconsulta sólo esos IDs por el API
de detalle y agrega los falsos negativos confirmados. No recorre las 49.000
entradas generales ni convierte descripciones en capacidades.

`src/providers/featherless-index.ts` publica sólo snapshots completos de la
política vigente. `src/providers/featherless-index-query.ts` aplica los filtros
opcionales, recalcula facetas y pagina DESPUÉS de la admisión. El contador sin
filtros es el total permitido; no el remoto general. Cada página, salvo la última,
contiene cien resultados admitidos. Nunca se rellena con modelos descartados.

La primera preparación responde HTTP 202 con páginas consultadas y admitidos.
La GUI muestra esos contadores y consulta progreso, sin un porcentaje inventado.
La caché dura seis horas y se guarda atómicamente bajo OPENCODEX_HOME. Un cambio
de versión de política invalida cachés anteriores. Al refrescar se conserva el
último snapshot completo con fecha/error explícitos; nunca uno a medio construir.

Las pruebas runtime se guardan en
`featherless-catalog/capability-evidence.json`, con proveedor oficial, transporte,
fecha de observación, vencimiento y hash SHA-256 del resultado sanitizado. Un
archivo ausente, dañado, vencido o dirigido a otro endpoint no admite modelos.
La selección vuelve a leer la prueba y los metadatos: un snapshot antiguo no
mantiene autorización después de que la evidencia venza.

La búsqueda y las facetas habituales no hacen llamadas remotas tras indexar.
Las vistas de tendencia, valoración, exclusividad y prioridad de modelos cargados
preparan variantes restringidas, con caché independiente. Popularidad es relativa
al conjunto admitido. El proveedor no publica puntuaciones globales de tendencia
ni valoración; esos órdenes conservan el orden remoto por conjuntos, no inventan
un score comparable. Descargas, favoritos, fecha y tamaño usan valores publicados.

Dos recuperadores de páginas limitan concurrencia. El timeout de 30 segundos es
por consulta atómica, nunca para toda la indexación. La validación muestra latidos.
Los metadatos dinámicos de fecha y contador se excluyen de la comparación visual;
las pruebas de interacción verifican esos contadores contra respuestas reales.

`scripts/adopt-featherless-catalog.ts` revisa selecciones anteriores con metadatos
reales y deshabilita entradas incompatibles sin borrar sus definiciones. Un fallo
de red aborta la adopción antes de escribir. Habilitar revalida el detalle remoto,
aunque el ID figure en el índice, para detectar una retirada de soporte.

## Habilitación y persistencia

`POST /api/featherless/selection` recibe `provider`, `id` y `enabled`. Al habilitar:

1. Reconsulta el identificador recorriendo todas las páginas de la búsqueda si
   existen muchos derivados, y verifica la regla de inclusión. Etiquetas de
   licencia/familia no acreditan una excepción de descensura.
2. Revalida que el proveedor siga usando el destino oficial y `openai-chat`.
3. Comprueba colisiones mediante el codec canónico de slugs.
4. Registra sólo ese modelo en `OcxConfig.customModels` con el ID upstream exacto.
5. Activa la configuración estática existente `OcxProviderConfig.liveModels=false`,
   evitando que la ruta heredada de primera página reinserte otros cien modelos.
6. Conserva las selecciones previas y actualiza `OcxConfig.disabledModels` mediante
   `routedSlug`/`slugEquals`, sin aproximar la codificación de barras.
7. Persiste mediante el writer existente y solicita convergencia de catálogo.

Deshabilitar un modelo ya configurado no requiere que siga disponible en la API
pública. Los proveedores con otro destino no son interceptados por llamarse
`featherless`. Las integraciones desactivadas permanecen desactivadas; seleccionar
un modelo no redirige por sí solo Codex Desktop a OpenCodex.

## Validación y límites

- `tests/providers/featherless-catalog-policy.test.ts` cubre el límite inclusivo,
  MoE, tamaños desconocidos, términos y namespaces, paginación y destino fijo.
- `scripts/verify-featherless-live.ts` consulta páginas, búsqueda y filtros reales,
  conservando evidencia pública sanitizada en `.tmp/featherless-evidence`.
- `scripts/run-featherless-validation.ts` arranca el runtime real en 10101 (o el
  puerto de `OPENCODEX_VALIDATION_PORT`) con
  homes aislados. Copia sólo la credencial de Featherless necesaria, nunca la
  imprime y no cambia el perfil nativo de Codex.
- `gui/.frontend-quality/journey.mjs` prueba navegación desktop/móvil, página 2,
  exclusión de un modelo pequeño, excepción de 4B, selección y lectura posterior.
  La aceptación incluye axe, geometría, consola y comparación visual revisada.

Un resultado satisfactorio de catálogo no acredita la ejecución de todos los
modelos, su calidad agéntica ni su disponibilidad en un plan concreto.
`scripts/verify-featherless-gateway.ts` verifica también tool_calls estructurados,
lectura real de un archivo local y continuación del modelo con el resultado.

## Distribución pública desde fuente

Este fork no contiene gestores particulares de Windows ni depende de la instalación privada.
`src/update/managed-featherless.ts` impide reemplazar accidentalmente la ampliación
por una distribución npm distinta. La actualización desde fuente se explica en
FORK.md. El modelo de acreditación se configura con FEATHERLESS_VERIFY_MODEL;
no es una lista de modelos permitidos ni sustituye las restricciones del catálogo.
