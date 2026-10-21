/** Estimador compartido de entrada: instrucciones, historial, herramientas y contenido multimodal. */
import { estimateTokens } from "./token-estimate";
import { modelInList, type OcxContentPart, type OcxParsedRequest, type OcxProviderConfig } from "../types";

// Son estimaciones del formato de entrada, no ventanas ni límites de salida inventados.
const REMOTE_IMAGE_TOKENS = 850;
const IMAGE_BYTES_PER_TOKEN = 750;

function imageTokens(imageUrl: string): number {
  if (!imageUrl.startsWith("data:")) return REMOTE_IMAGE_TOKENS;
  const comma = imageUrl.indexOf(",");
  if (comma < 0) return REMOTE_IMAGE_TOKENS;
  const payload = imageUrl.length - comma - 1;
  if (payload <= 0) return 0;
  const decoded = Math.floor((payload * 3) / 4);
  return Math.max(1, Math.ceil(decoded / IMAGE_BYTES_PER_TOKEN));
}

function contentPartTokens(part: OcxContentPart, modelId: string): number {
  if (part.type === "image") return imageTokens(part.imageUrl);
  if (part.type === "video") return imageTokens(part.videoUrl);
  // An inline document is a base64 payload, not a sentence: estimating it from its marker would
  // admit a request whose real input is orders of magnitude larger. Counted arithmetically —
  // rebuilding the data URL here would materialize a second request-sized string just to measure it.
  if (part.type === "document") return base64PayloadTokens(part.data);
  return estimateTokens(part.text, modelId);
}

function base64PayloadTokens(base64: string): number {
  if (base64.length === 0) return 0;
  const decoded = Math.floor((base64.length * 3) / 4);
  return Math.max(1, Math.ceil(decoded / IMAGE_BYTES_PER_TOKEN));
}

function contentTokens(content: string | readonly OcxContentPart[], modelId: string): number {
  if (typeof content === "string") return estimateTokens(content, modelId);
  let total = 0;
  for (const part of content) total += contentPartTokens(part, modelId);
  return total;
}

/**
 * Estimate the input tokens of a parsed request.
 *
 * Walks the whole `OcxMessage` union rather than user text alone. Assistant turns carry
 * their content as `OcxAssistantContentPart[]` — text, thinking blocks, and tool calls whose
 * JSON arguments are frequently the largest single item in an agent conversation. A walk
 * that counted only `{type:"text"}` would undercount exactly the turns that trigger this
 * gate. The routed provider determines whether replayed thinking reaches the wire.
 */
export function estimateInputTokens(parsed: OcxParsedRequest, modelId: string, provider?: OcxProviderConfig): number {
  const { context } = parsed;
  const countThinking = provider?.adapter !== "openai-chat"
    || modelInList(provider.preserveReasoningContentModels, parsed.modelId);
  let total = 0;

  for (const prompt of context.systemPrompt ?? []) total += estimateTokens(prompt, modelId);

  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") total += estimateTokens(part.text, modelId);
        else if (part.type === "thinking") {
          if (countThinking) total += estimateTokens(part.thinking, modelId);
        }
        else total += estimateTokens(part.name, modelId) + estimateTokens(JSON.stringify(part.arguments), modelId);
      }
      // Opaque provider blob replayed verbatim upstream, so it costs real input tokens.
      if (message.kiroRedactedReasoning) total += estimateTokens(message.kiroRedactedReasoning, modelId);
      continue;
    }
    total += contentTokens(message.content, modelId);
  }

  // Tool schemas ride every turn: name, description, and the JSON parameter schema all
  // reach the upstream, and a large MCP catalog can dominate a short conversation.
  for (const tool of context.tools ?? []) {
    total += estimateTokens(tool.name, modelId)
      + estimateTokens(tool.description, modelId)
      + estimateTokens(JSON.stringify(tool.parameters), modelId);
  }

  return total;
}
