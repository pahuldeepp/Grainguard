export async function checkHealth(
  path: string,
  service: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(path, { signal });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "service" in body &&
      body.service === service &&
      "status" in body &&
      body.status === "ready"
    );
  } catch {
    return false;
  }
}
