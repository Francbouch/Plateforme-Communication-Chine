import type { Account, Project } from "./types";

// Deliberately isolated browser data: no fetch, JWT, D1 binding or real identity.
export const isDemo =
  typeof location !== "undefined" &&
  (location.pathname === "/demo" || location.pathname.startsWith("/demo/"));
const account: Account = {
  profile: {
    id: "demo",
    name: "Visiteur démo",
    language: "fr-CA",
    timezone: "America/Toronto",
  },
  organizations: [
    { id: "demo-org", name: "Atelier démonstration", role: "owner" },
  ],
};
const projects: Project[] = [
  {
    id: "demo-project-1",
    organization_id: "demo-org",
    code: "FB-001",
    name: "Collection mobilier",
    description:
      "Coordination des prototypes et des échanges avec les fournisseurs.",
    status: "active",
    updated_at: "2026-10-29T12:00:00Z",
  },
  {
    id: "demo-project-2",
    organization_id: "demo-org",
    code: "FB-002",
    name: "Composants métalliques",
    description: "Préparation des spécifications et suivi de fabrication.",
    status: "paused",
    updated_at: "2026-10-28T12:00:00Z",
  },
];
export async function demoRequest<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const route = path.split("?")[0];
  const verb = method ?? (body ? "POST" : "GET");
  if (route === "me" && verb === "GET") return structuredClone(account) as T;
  if (route === "me" && verb === "PATCH") {
    Object.assign(account.profile, body);
    return structuredClone(account.profile) as T;
  }
  if (route === "projects" && verb === "GET")
    return structuredClone(projects) as T;
  if (route === "projects" && verb === "POST") {
    const input = body as Project;
    const existing = projects.find((p) => p.id === input.id);
    const project = {
      ...input,
      id: existing?.id ?? crypto.randomUUID(),
      organization_id: "demo-org",
      updated_at: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, project);
    else projects.push(project);
    return structuredClone(project) as T;
  }
  if (verb === "GET") return [] as T;
  throw new Error(
    "Cette action nécessite l’espace privé. L’aperçu utilise uniquement des données fictives.",
  );
}
