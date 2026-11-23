import { getAuthToken } from 'deepspace'

export type ActionResponse<T> = { success: true; data: T } | { success: false; error: string }

/** Call a server action from src/actions with the signed-in user's token. */
export async function callAction<T = unknown>(
  name: string,
  params: Record<string, unknown>,
): Promise<ActionResponse<T>> {
  const token = await getAuthToken()
  if (!token) return { success: false, error: 'Please sign in again' }
  try {
    const res = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
    const json = (await res.json().catch(() => null)) as ActionResponse<T> | { error?: string } | null
    if (json && 'success' in json) return json
    return { success: false, error: json?.error ?? `Request failed (${res.status})` }
  } catch {
    return { success: false, error: 'Network error. Check your connection and try again.' }
  }
}

export function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function makeJoinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
