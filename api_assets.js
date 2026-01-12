import { makeRequest, fetchRaw } from './core.js';

const EMPTY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

const EMPTY_WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00
]);

async function mapLimit(items, limit, fn) {
    const results = [];
    const chunks = [];
    for (let i = 0; i < items.length; i += limit) {
        chunks.push(items.slice(i, i + limit));
    }
    for (const chunk of chunks) {
        const chunkResults = await Promise.all(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

export async function getAssetMetadata(projectId, version, path) {
    try {
        return await makeRequest(`/projects/${projectId}/revisions/${version}/assets/${encodeURIComponent(path)}`);
    } catch(e) {
        return null;
    }
}

export async function getAssets(projectId, version) {
    let allAssets = [];
    let nextCursor = null;
    let hasNext = true;
    let page = 0;
    
    while(hasNext && page < 50) {
        const params = new URLSearchParams();
        params.set('first', '50');
        if (nextCursor) params.set('after', nextCursor);

        try {
            const res = await makeRequest(`/projects/${projectId}/revisions/${version}/assets?${params}`);
            
            let pageData = [];
            let meta = null;

            if (Array.isArray(res)) {
                pageData = res;
                hasNext = false; 
            } else if (res.assets && Array.isArray(res.assets)) {
                pageData = res.assets;
                hasNext = false;
            } else if (res.assets && res.assets.data && Array.isArray(res.assets.data)) {
                pageData = res.assets.data;
                meta = res.assets.meta;
            } else if (res.data && Array.isArray(res.data)) {
                pageData = res.data;
                meta = res.meta;
            }

            if (pageData.length > 0) allAssets.push(...pageData);

            if (meta && meta.has_next_page && meta.end_cursor) {
                nextCursor = meta.end_cursor;
            } else {
                hasNext = false;
            }
        } catch(e) {
            hasNext = false;
        }
        page++;
    }
    return allAssets;
}

export async function getAssetContent(projectId, version, path) {
    const ab = await fetchRaw(`/projects/${projectId}/revisions/${version}/assets/${encodeURIComponent(path)}/content`);
    try {
        const text = new TextDecoder().decode(ab);
        if (text.trim().startsWith('{')) {
            const json = JSON.parse(text);
            const content = json.content || json.data;
            if (content && typeof content === 'string') {
                return new TextEncoder().encode(content).buffer;
            }
        }
    } catch(e) {}
    return ab;
}

export async function processAssets(assetList, projectId, version) {
    const files = {};
    const encoder = new TextEncoder();

    if (!assetList || !Array.isArray(assetList)) {
        return files;
    }

    const processItem = async (asset) => {
        if (!asset.path) return;
        
        const path = asset.path.replace(/^(\.|\/)+/, '');
        if (path.endsWith('/')) return;

        if (typeof asset.content === 'string' && asset.content.length > 0) {
            files[path] = encoder.encode(asset.content);
            return;
        }
        if (asset.content && typeof asset.content === 'object') {
            files[path] = encoder.encode(JSON.stringify(asset.content));
            return;
        }

        const isText = /\.(html|js|mjs|jsx|ts|tsx|css|json|txt|md|xml|svg|csv)$/i.test(path);
        let url = asset.url || asset.src || asset.uri || asset.download_url;
        
        if (!url && !isText && projectId && version) {
            const filename = path.split('/').pop();
            if (filename) {
                const ts = Date.now();
                url = `https://${projectId}.c.websim.com/${encodeURIComponent(filename)}?v=${version}&t=${ts}`;
            }
        }
        
        if (!url && !isText) {
             const meta = await getAssetMetadata(projectId, version, path);
             if (meta) {
                 url = meta.url || meta.src || meta.download_url;
             }
        }

        const isAbsolute = url && url.startsWith('http');
        
        const tryFetchContent = async () => {
             if (!projectId || !version) return null;
             try {
                 const ab = await getAssetContent(projectId, version, path);
                 if (ab && ab.byteLength > 0) return new Uint8Array(ab);
             } catch(e) { }
             return null;
        };

        if (isText) {
            const content = await tryFetchContent();
            if (content) {
                files[path] = content;
                return;
            }
        }

        if (isAbsolute) {
            try {
                await new Promise(r => setTimeout(r, Math.random() * 50));
                
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                
                const blob = await res.arrayBuffer();
                files[path] = new Uint8Array(blob);
                return;

            } catch(e) {
                // proceed fallback
            }
        }

        if (!files[path] && !isText) {
             const content = await tryFetchContent();
             if (content) {
                 files[path] = content;
                 return;
             }
        }

        if (isText) {
             files[path] = encoder.encode(`// Missing file: ${path}\n// Failed to download from WebSim.`);
        }

        if (/\.(mp3|wav|ogg)$/i.test(path)) {
            files[path] = EMPTY_WAV;
        } else if (/\.(png|jpg|jpeg|gif)$/i.test(path)) {
            files[path] = EMPTY_PNG;
        }
    };

    await mapLimit(assetList, 5, processItem);
    return files;
}