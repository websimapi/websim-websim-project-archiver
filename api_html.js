import { API_BASE } from './core.js';

export async function getProjectHtml(projectId, version) {
    // 1. Priority: Fetch Revision Data (Metadata + potential content)
    try {
        const response = await fetch(`${API_BASE}/projects/${projectId}/revisions/${version}`);
        if (response.ok) {
            const data = await response.json();
            const rev = data.revision || data; 
            
            if (rev.html) return rev.html;
            if (rev.content && typeof rev.content === 'string') return rev.content;
            if (rev.content && rev.content.html) return rev.content.html;
            if (rev.source) return rev.source;
            if (rev.code) return rev.code;
            if (rev.files && rev.files['index.html']) {
                 const f = rev.files['index.html'];
                 return typeof f === 'string' ? f : f.content;
            }
        }
    } catch (e) {
        console.warn("[API] Revision metadata fetch error:", e);
    }

    // 2. Fallback: Dedicated HTML Endpoint
    try {
        const response = await fetch(`${API_BASE}/projects/${projectId}/revisions/${version}/html`);
        if (response.ok) {
            const text = await response.text();
            if (text.trim().startsWith('{')) {
                try {
                    const json = JSON.parse(text);
                    if (json.content) return json.content;
                    if (json.html) return json.html;
                    return null; 
                } catch(e) {
                    return null;
                }
            }
            return text;
        }
    } catch (e) {
        console.warn("[API] HTML fetch error:", e);
    }

    return null;
}