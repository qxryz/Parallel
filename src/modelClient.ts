export async function localModelRequest(
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return fetch('/api/model', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, headers, ...(body === undefined ? {} : { body }) })
  });
}

export async function localModelGet(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch('/api/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, headers, method: 'GET' })
  });
}

export async function modelError(response: Response, providerName: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as {
    error?: { message?: string } | string;
    message?: string;
  } | null;
  const detail = typeof payload?.error === 'string'
    ? payload.error
    : payload?.error?.message || payload?.message;
  return new Error(providerName + ' 请求失败' + (detail ? '：' + detail : '（HTTP ' + response.status + '）'));
}

export function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
