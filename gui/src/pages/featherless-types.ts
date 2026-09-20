/** DTO público: no contiene claves ni configuración privada del proveedor. */
export interface FeatherlessRow {
  id: string; parameterSize: number | null; contextLength: number | null;
  toolUse: boolean | null; status: string; tags: Record<string, string[]>;
  reason: "parameters" | "exception"; evidence: string[];
}
export interface FeatherlessResult {
  items: FeatherlessRow[];
  pagination: { current_page: number; total_items: number; total_pages: number };
  facets: Record<string, Array<{ value: string; count: number }>>;
  providers: string[]; enabled: Record<string, string[]>;
  inspected: number; excluded: number; unknown: number; fetchedAt: string;
}
/** El query string no incluye secretos; permite conservar navegación al recargar. */
export const FL_STATE_KEY = "opencodex.featherless.filters.v1";
export function initialFeatherlessQuery(): URLSearchParams {
  try { return new URLSearchParams(sessionStorage.getItem(FL_STATE_KEY) ?? "sort=-trending_rank"); }
  catch { return new URLSearchParams("sort=-trending_rank"); }
}
export function compactNumber(value: number | null): string {
  if (value === null) return "—";
  for (const [threshold, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value >= threshold) return `${Number((value / threshold).toFixed(2))}${suffix}`;
  }
  return String(value);
}
