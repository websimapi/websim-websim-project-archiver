import { makeRequest } from './core.js';

export function getProjectById(projectId) {
    return makeRequest(`/projects/${projectId}`);
}

export function getProjectBySlug(username, slug) {
    return makeRequest(`/users/${username}/slugs/${slug}`);
}

export function getProjectRevisions(projectId, params = {}) {
    const query = new URLSearchParams(params).toString();
    return makeRequest(`/projects/${projectId}/revisions?${query}`);
}

export function getRevisionDetails(projectId, revisionId) {
    return makeRequest(`/projects/${projectId}/revisions/${revisionId}`);
}

export async function getAllProjectRevisions(projectId) {
    console.log(`[API-Project] getAllProjectRevisions for ${projectId}`);
    let allRevisions = [];
    let hasNextPage = true;
    let afterCursor = null;
    let pageCount = 0;
    const MAX_PAGES = 10;

    while (hasNextPage && pageCount < MAX_PAGES) {
        const params = { first: 50 };
        if (afterCursor) params.after = afterCursor;

        try {
            const response = await getProjectRevisions(projectId, params);
            console.log(`[API-Project] Rev page ${pageCount} response keys:`, Object.keys(response));
            
            let pageData = [];
            let meta = null;

            if (response.revisions) {
                if (Array.isArray(response.revisions)) {
                    pageData = response.revisions;
                } else if (response.revisions.data) {
                    pageData = response.revisions.data;
                    meta = response.revisions.meta;
                }
            } else if (response.data) {
                pageData = response.data;
                meta = response.meta;
            } else if (Array.isArray(response)) {
                pageData = response;
            }

            if (pageData.length > 0) {
                console.log(`[API-Project] Found ${pageData.length} revisions. First item keys:`, Object.keys(pageData[0] || {}));
                // Unwrap revisions if they are nested in project_revision or revision
                const unwrapped = pageData.map(item => {
                    if (item.project_revision) return item.project_revision;
                    if (item.revision) return item.revision;
                    return item;
                }).filter(r => r && r.id); // Ensure we have valid objects with IDs
                
                allRevisions = allRevisions.concat(unwrapped);
            } else {
                console.warn(`[API-Project] Page ${pageCount} returned no revisions.`);
            }
            
            hasNextPage = meta?.has_next_page || false;
            afterCursor = meta?.end_cursor;
            
            if (!afterCursor) hasNextPage = false;
        } catch (e) {
            console.error(`[API-Project] Error fetching revision page ${pageCount}:`, e);
            hasNextPage = false;
        }
        pageCount++;
    }
    return allRevisions;
}

export function parseProjectIdentifier(input) {
    if (!input) return null;
    try {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        const pathname = url.pathname;
        const projectMatch = pathname.match(/^\/p\/([a-z0-9_-]{20})/);
        if (projectMatch) return { type: 'id', value: projectMatch[1] };
        const slugMatch = pathname.match(/^\/(@[^/]+)\/([^/]+)/);
        if (slugMatch) return { type: 'slug', username: slugMatch[1].substring(1), slug: slugMatch[2] };
        const cMatch = pathname.match(/^\/c\/([a-z0-9_-]{20})/);
        if (cMatch) return { type: 'id', value: cMatch[1] };
    } catch (e) { /* Not a URL */ }
    
    const atSlugMatch = input.match(/^@([^/]+)\/([^/]+)/);
    if (atSlugMatch) return { type: 'slug', username: atSlugMatch[1], slug: atSlugMatch[2] };
    
    const slugMatch = input.match(/^([a-zA-Z0-9_]{3,32})\/([a-zA-Z0-9-]{3,50})$/);
    if (slugMatch) return { type: 'slug', username: slugMatch[1], slug: slugMatch[2] };
    
    if (/^[a-z0-9_-]{20}$/.test(input)) return { type: 'id', value: input };
    
    throw new Error(`Invalid project identifier: "${input}".`);
}

export async function fetchProjectMetadata(identifier) {
    if (identifier.type === 'id') {
        return getProjectById(identifier.value);
    } else {
        return getProjectBySlug(identifier.username, identifier.slug);
    }
}