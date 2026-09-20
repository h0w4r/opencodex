/** El fork fuente no debe desaparecer por una actualización npm de otra distribución. */
export async function runManagedFeatherlessUpdate(): Promise<boolean> {
  throw new Error("Esta distribución incluye el catálogo Featherless del fork. Actualiza el checkout de tu fork con git pull --ff-only, instala con bun install --frozen-lockfile y reconstruye con bun run build:gui. Revisa FORK.md; no se ejecutará una actualización npm que elimine esta ampliación.");
}
