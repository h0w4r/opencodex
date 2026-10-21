# Presupuesto dinámico de tokens Chat

## Fuentes y alcance

- `src/providers/model-token-limits.ts` conecta `customModels[].contextWindow`
  al proveedor resuelto de `src/router.ts`, antes de capturar su política estática.
- `src/adapters/openai-chat/summary-budget.ts` aplica los máximos por destino
  tanto al adaptador traducido como a `src/adapters/openai-chat/passthrough.ts`.
- `src/lib/request-input-estimate.ts` contiene el estimador compartido por el
  adaptador y `src/server/responses/input-admission.ts`.

La fila se busca por proveedor y modelo final exactos. El objeto proyectado es
local a la petición: no modifica configuración, otros modelos ni credenciales.
Una cota explícita del proveedor sólo puede estrechar la ventana conocida.
Cambiar el modelo o sus metadatos recalcula la proyección y la reserva.

## Presupuesto

La salida respeta el menor valor entre la petición, la cota de salida conocida
y el contexto restante. `modelMaxInputTokens` permanece una cota exclusiva de
entrada: no se confunde con el contexto total disponible para entrada y salida.
El estimador incluye instrucciones —también el prompt externo ya reemplazado—,
historial, herramientas y contenido multimodal. Mantiene la misma estimación de
imágenes y documentos que la admisión, sin contarlos como texto base64 completo.

La reserva de entrada añade 25% proporcional a la estimación. Es margen operativo,
no una capacidad atribuida al modelo ni un conteo exacto de su tokenizer. El
upstream sigue siendo la autoridad de conteo y puede rechazar una entrada que
no quepa. La tolerancia de admisión existente no cambia.

No hay una ventana o salida global para Claude CLI. Una cota desconocida sigue
siendo desconocida: no se inventan máximos de salida ni ventanas de contexto.
Un límite de salida explícito menor del cliente no se eleva por esta política.
La compatibilidad especial de resúmenes tampoco puede superar una cota conocida.

Chat nativo conserva sus mensajes y campos, y limita sólo los máximos realmente
enviados. Si la forma nativa no puede traducirse para estimación, aplica sólo la
cota de salida declarada, sin inventar un conteo. Anthropic nativo no usa este
adaptador y Codex desvinculado de OpenCodex permanece fuera de este recorrido.

## Verificación

`tests/adapters/openai/openai-chat-glm-summary.test.ts` contrasta ventanas 32K y
1M, salida declarada 64K, modelos desconocidos, cap exclusivo de entrada,
recalculo de metadatos y paridad entre los dos constructores Chat. Estos casos
no sustituyen la aceptación con inferencias autenticadas del bundle desplegado.
