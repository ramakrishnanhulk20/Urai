/**
 * The one model id policy, used by the lint check and by buildRequest (C24): SERV model ids are
 * lowercase, so a config typed "GPT-6-Luna" is checked and sent as the same id.
 */
export function normaliseModelId(id: string): string {
  return id.trim().toLowerCase();
}
