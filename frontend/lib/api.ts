type RequestOptions = RequestInit & {
  json?: unknown;
  /**
   * Per-request timeout. Defaults to 60s — the planner can take ~45s under
   * Gemini fallback chains, so anything shorter chops legitimate work. If
   * the caller passes its own AbortController via `signal`, we respect it
   * and skip the auto-timeout (caller knows their own timing constraints).
   */
  timeoutMs?: number;
};

const DEFAULT_API_TIMEOUT_MS = 60_000;

export async function apiRequest<T>(path: string, options: RequestOptions = {}) {
  const { json, headers, timeoutMs, signal: callerSignal, ...rest } = options;

  // Auto-timeout to defend against a stuck backend: without it a hung
  // request leaves the calling component spinning indefinitely. We only
  // arm the timeout if the caller didn't pass their own AbortSignal.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let signal = callerSignal;
  if (!callerSignal) {
    const ctrl = new AbortController();
    signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
  }

  try {
    const response = await fetch(path, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      signal
    });

    if (!response.ok) {
      let message = `Request failed with ${response.status}`;

      try {
        const error = await response.json();
        message = error.error || error.message || message;
      } catch {
        // ignore JSON parse failures
      }

      throw new Error(message);
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && timer) {
      throw new Error(`Request to ${path} timed out after ${(timeoutMs ?? DEFAULT_API_TIMEOUT_MS) / 1000}s`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
