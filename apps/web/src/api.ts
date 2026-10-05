let csrf = "";
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response
      .json()
      .catch(() => ({ error: "Unable to connect" }));
    throw new Error(result.error || "Request failed");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
