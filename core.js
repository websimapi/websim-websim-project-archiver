export const API_BASE = 'https://api.websim.com/api/v1';

export async function makeRequest(path, options = {}) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
}

export async function fetchRaw(path) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.arrayBuffer();
}