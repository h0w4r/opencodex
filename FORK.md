# OpenCodex: catálogo admitido de Featherless

Este fork conserva la licencia, atribución e historial público de OpenCodex.
No es una versión oficial del mantenedor original. La base de esta ampliación
es la etiqueta upstream `v2.59.0`.

## Funcionalidad añadida

- Pestaña Models → Featherless con búsqueda, facetas, paginación y selección.
- Restricciones previas: tool calling declarado Y (>=16B o excepción declarada).
- Índice persistente: sólo modelos admitidos; contadores y filtros sobre ese índice.
- Recuperación selectiva en origen y caché, no una descarga de todos los modelos
  en cada navegador o interacción.
- Revalidación al habilitar, rechazo explícito de incompatibles y evidencia
  declarada por modelo. El catálogo no certifica todos los MCPs ni skills.

Documentación funcional:
[Catálogo agéntico](docs-site/src/content/docs/guides/featherless-catalog.md).
Arquitectura: [Índice y restricciones](structure/featherless-catalog.md).

## Instalación desde fuente

Requiere Git y Bun compatibles con las versiones declaradas por OpenCodex.
Clona **este fork y su rama de funcionalidad**, no el paquete npm oficial si
quieres conservar esta ampliación:

```sh
git clone --branch CK/featherless-agentic-catalog https://github.com/h0w4r/opencodex.git
cd opencodex
bun install --frozen-lockfile
bun run build:gui
bun run src/cli/index.ts gui
```

Configura tus propios proveedores mediante la GUI. No se distribuyen API keys,
cuentas, selecciones personales, prompts, MCPs, perfiles ni accesos directos.
El inicio automático y los servicios se configuran por los mecanismos de
OpenCodex apropiados para tu plataforma; no se incluye un gestor particular.

## Actualización sin perder la ampliación

En un checkout limpio de la rama del fork:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run typecheck
bun test tests/providers/featherless-catalog-policy.test.ts tests/providers/featherless-index-query.test.ts
bun run build:gui
```

Reinicia después únicamente la instancia que utiliza ese checkout.
Actualizar con el paquete npm oficial no instala esta rama: por eso el comando
de actualización de esta distribución avisa y no sobrescribe el fork.
Integrar nuevas versiones upstream requiere reconciliar y validar los cambios;
no se promete que cualquier versión futura aplique sin conflictos.

## Validación

Las pruebas unitarias no requieren cuenta. Los scripts `verify-featherless-*`
realizan comprobaciones reales; la inferencia consume la cuenta que configures.
`run-featherless-validation.ts` utiliza homes aislados en `.tmp/` y toma únicamente
la credencial Featherless del perfil local para esa validación voluntaria.
No imprime ni versiona la credencial.

El recorrido de navegador es reutilizable. Las capturas, baselines aprobados,
logs y resultados de una máquina concreta no forman parte del fork público.
El contrato frontend puede servir para generar y revisar baselines propios;
no acredita por sí mismo una ejecución real en otra máquina.

## Publicación y límites

Esta rama contiene sólo código, pruebas y documentación reutilizable. No incluye
el historial privado de adaptación, el gestor local de la instalación privada ni configuración
de otra instalación. Todavía no se ha enviado un pull request al proyecto original.
Los cambios deberán ajustarse a sus requisitos antes de proponer su integración.
