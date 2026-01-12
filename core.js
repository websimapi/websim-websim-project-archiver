export const API_BASE = 'https://api.websim.com/api/v1';

export async function makeRequest(path, options = {}) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    console.log(`[Core] Requesting: ${url}`);
    
    try {
        const res = await fetch(url, options);
        if (!res.ok) {
            const text = await res.text();
            console.error(`[Core] Request failed (${res.status}): ${url}`, text);
            try {
                const jsonErr = JSON.parse(text);
                console.error("[Core] Error Details:", jsonErr);
            } catch(e) {}
            throw new Error(`Request failed: ${res.status} - ${text}`);
        }
        return await res.json();
    } catch (e) {
        console.error(`[Core] Network error for ${url}:`, e);
        throw e;
    }
}

export async function fetchRaw(path) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    console.log(`[Core] Fetching raw: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.arrayBuffer();
}