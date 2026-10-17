# Actualizaciones gestionadas de Windows

`src/update/managed-dashboard.ts` reconoce únicamente el bundle activo registrado
por el gestor local; un checkout ordinario o Linux no obtiene esta capacidad.
`GET/POST /api/update/managed` usa la autenticación y la comprobación de origen
normales de la API de administración y aparece en su registro de rutas.

## Descubrimiento y decisión

El aviso global `gui/src/components/ManagedUpdateNotice.tsx` consulta estado al
abrir y cada cinco segundos. El backend deduplica la consulta al registro npm
oficial: como máximo una cada quince minutos, con reintento acotado tras fallo.
El canal es siempre latest estable. El operador también puede pedir una consulta
inmediata. Un dato antiguo conserva su fecha y el fallo se muestra explícitamente.
GET nunca instala software. No se compara la versión instalada con una constante
fija ni se deduce que todo checkout de fuente pueda instalarse automáticamente.

La GUI muestra versión activa, latest, fecha, disponibilidad y trabajo persistido.
Ofrece actualizar cuando hay una versión superior o una receta local pendiente.
El botón oficial del sidebar abre el mismo estado en una instalación gestionada.
Comprobar instalación ejecuta la decisión real del gestor: si la versión y la
receta ya están activas, este puede finalizar sin reinstalar ni reiniciar.

## Trabajo independiente

`src/update/managed-worker.ts` se lanza con PowerShell del sistema mediante
Start-Process oculto. No hereda el listener y sobrevive a su sustitución.
Ejecuta el gestor registrado con una versión estable obtenida del registro, nunca
con comandos, paths o versiones arbitrarias del body. No invoca npm global.
La entrada pasa solamente action=check/update/revalidate; un downgrade se rechaza.

El estado conserva PID, objetivo, fase, fechas y último evento de salida real.
No persiste ni publica salida libre del instalador ni credenciales. Un worker
muerto pasa a fallo recuperable; uno vivo no se cancela por antigüedad. No existe
un timeout total del trabajo; las consultas atómicas y el arranque están acotados.
Solo se declara éxito tras salida cero del gestor y lectura coherente del estado
activo y health de la versión objetivo. Un parche incompatible queda identificado;
no se fuerza la instalación ni se afirma que una receta futura sea compatible.

El gestor conserva los gates de código, navegador e inferencia, los bundles y
la recuperación de servicio. Los tests de `tests/update/managed-dashboard.test.ts`
cubren reconocimiento, versión, PID y consulta al registro; no sustituyen los
recorridos reales del operador ni acreditan una versión que aún no se publicó.
