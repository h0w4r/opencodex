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

No se impone un mínimo de contexto ni un requisito de tool calling. La ficha
expone contexto publicado, soporte declarado de herramientas y estado, incluidos
`not_deployed` y `unknown`, sin convertir su presencia en disponibilidad de cuenta.

## Paginación, filtros y eficiencia

`GET /api/featherless/models` acepta `page`, `query`, `sort`, filtros repetidos de
modalidad, parámetros, familia, capacidad, arquitectura, idioma, dominio,
creatividad, entrenamiento, licencia y popularidad. Admite además exclusividad,
tendencia, prioridad de modelos cargados y recencia de publicación.

Conserva los seis órdenes del sitio: tendencia, descargas, favoritos, fecha,
tamaño y valoración. La consulta va al índice del proveedor, no a los cien
modelos que casualmente se encuentren en la memoria del cliente.

Una página remota contiene hasta 100 filas. Esto es un tamaño de página, **no un
máximo total**: el usuario puede recorrer todas las páginas o saltar a cualquiera.
La política local se aplica antes de enviar las filas al navegador. Una página
puede quedar vacía sin que eso signifique que terminó el catálogo.

Los totales y contadores de facetas pertenecen al catálogo remoto antes de la
política local. La interfaz identifica separadamente los examinados, admitidos,
excluidos por tamaño y desconocidos de cada página. No inventa un total global
de admitidos que no haya calculado.

La búsqueda espera 400 ms de inactividad al escribir. Las respuestas obsoletas
no reemplazan la consulta actual. El servidor deduplica consultas idénticas,
mantiene hasta 64 páginas durante 120 segundos y admite como máximo 16 consultas
concurrentes. No descarga 50.000 filas para filtrar una sola interacción.

El límite de 30 segundos se aplica a una petición atómica de página, no a un
recorrido completo ni a una inferencia. Cambiar de página no inicia una tarea
global con un timeout total oculto.

## Habilitación y persistencia

`POST /api/featherless/selection` recibe `provider`, `id` y `enabled`. Al habilitar:

1. Reconsulta el identificador y verifica la regla de inclusión.
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
modelos, su aptitud para herramientas ni su disponibilidad en un plan concreto.

## Distribución local Windows

`src/update/managed-featherless.ts` delega las actualizaciones de esta distribución
al gestor instalado en LOCALAPPDATA/AgentStack/opencodex-catalog/manager.
No sustituye silenciosamente el paquete modificado por el paquete npm oficial.
El gestor externo prepara un checkout versionado, aplica el parche, ejecuta
typecheck, pruebas, build y el gate real antes de cambiar el servicio oculto.
`scripts/verify-featherless-gateway.ts` acredita además una inferencia real mínima
y el rechazo HTTP 422 de un modelo pequeño sin excepción. Una incompatibilidad
de parche o de contrato conserva la versión activa y produce un informe local.
El modelo de acreditación se puede elegir con FEATHERLESS_VERIFY_MODEL; no es una
lista de modelos permitidos ni sustituye la política del catálogo.
