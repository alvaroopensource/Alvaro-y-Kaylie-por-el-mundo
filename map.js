import { supabase, isSupabaseEnabled } from './supabase-config.js';

const BARRANQUILLA = {
    lat: 10.9878,
    lng: -74.7889,
    name: 'Barranquilla, Colombia'
};

const CATEGORY_META = {
    cronica: { label: 'Cronica', className: 'cultura' },
    guia: { label: 'Guia', className: 'movilidad' },
    memoria: { label: 'Memoria', className: 'alerta' },
    escena: { label: 'Escena local', className: 'comunidad' }
};

const threads = [];
const SUPABASE_TABLES = {
    spots: 'map_spots',
    entries: 'map_entries',
    photos: 'map_photos',
    drafts: 'map_entry_drafts'
};
const SUPABASE_STORAGE = {
    galleryBucket: 'map-gallery'
};
const AUTH_USER_EMAILS = {
    Alvaro: 'alvaro@mi-mapa.com',
    Kaylie: 'kaylie@mi-mapa.com'
};
const AUTHOR_NAME_STORAGE_KEY = 'map-author-name-by-id';
const ENTRY_DRAFTS_STORAGE_KEY = 'map-entry-drafts-v2';
const ENTRY_EDITOR_PLACEHOLDER_HTML = '<p>Empieza a escribir aqui tu cronica...</p>';
const SPOT_MARKER_SCALE_CONFIG = {
    minZoom: 10,
    maxZoom: 18,
    minScale: 0.42,
    maxScale: 1.2,
    hideBelowZoom: 12,
    growthExponent: 1.65
};

let map;
let markers = [];
let activeThreadId = null;
let draftLocationMarker;
let draftDragState = null;
let isDraftPlacementMode = false;
let pendingDraftLatLng = null;
let draftSpotName = '';
let nextLocalSpotId = 1;
const createdSpotMarkers = new Map();
let pendingRenameSpotId = null;
let pendingConfirmAction = null;
let pendingConfirmResolver = null;
let pendingConfirmAccepted = false;
let activeComposerContext = null;
let activeGalleryContext = null;
let activeReadEntryId = null;
let activeGlobalGalleryMode = false;
let activeDraftsMode = false;
let activeEntriesSpotFilter = null;
let activeEntriesSearchQuery = '';
let activeInlinePhotoEdit = null;
let currentManualUser = null;
let currentSessionUserId = null;
let masonryResizeTimer = null;
const entryDraftsBySpot = new Map();
let isSyncingDraftsFromSupabase = false;
let draftSyncCounter = 0;
const galleryPhotosBySpot = new Map();
const globalGalleryPhotos = [];
const publishedEntries = [];
const knownAuthorNamesById = loadKnownAuthorNamesById();
let nextLocalEntryId = 1;

// Keep the backend client reachable from devtools.
window.projectDb = supabase;

function initMap() {
    map = L.map('map', {
        center: [BARRANQUILLA.lat, BARRANQUILLA.lng],
        zoom: 13,
        zoomControl: false,
        attributionControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
        className: 'forum-tiles'
    }).addTo(map);
    bindSpotMarkerZoomScaling();
    loadEntryDraftsFromStorage();

    renderCategories();
    renderThreads();
    renderMarkers();
    renderThreadDetail(activeThreadId);
    renderHomeEntriesFeed();
    bindStaticUi();
    updateLoginButtonState();

    void hydrateAuthState();
    void hydrateFromSupabase();
}

function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function computeSpotMarkerScale(zoomLevel) {
    const { minZoom, maxZoom, minScale, maxScale, growthExponent } = SPOT_MARKER_SCALE_CONFIG;
    const ratio = clampNumber((zoomLevel - minZoom) / (maxZoom - minZoom), 0, 1);
    const easedRatio = Math.pow(ratio, growthExponent);
    return minScale + ((maxScale - minScale) * easedRatio);
}

function updateSpotMarkerScale(zoomLevel) {
    if (!map) return;
    const targetZoom = Number.isFinite(zoomLevel) ? zoomLevel : map.getZoom();
    const nextScale = computeSpotMarkerScale(targetZoom).toFixed(3);
    const container = map.getContainer();
    const shouldHideSpots = targetZoom < SPOT_MARKER_SCALE_CONFIG.hideBelowZoom;

    container.style.setProperty('--spot-marker-scale', nextScale);
    container.classList.toggle('spots-hidden-by-zoom', shouldHideSpots);
}

function bindSpotMarkerZoomScaling() {
    if (!map) return;

    updateSpotMarkerScale(map.getZoom());
    map.on('zoom', function() {
        updateSpotMarkerScale(map.getZoom());
    });
    map.on('zoomanim', function(event) {
        if (!event || typeof event.zoom !== 'number') return;
        updateSpotMarkerScale(event.zoom);
    });
}

function isBackendReady() {
    return Boolean(supabase && isSupabaseEnabled);
}

function isManualAuthenticated() {
    return Boolean(currentManualUser);
}

function getAuthEmailForUser(userName) {
    if (!userName) return '';
    return AUTH_USER_EMAILS[userName] || '';
}

function getUserNameFromEmail(emailValue) {
    const normalized = String(emailValue || '').trim().toLowerCase();
    if (!normalized) return '';

    return Object.keys(AUTH_USER_EMAILS).find((key) => {
        return String(AUTH_USER_EMAILS[key] || '').trim().toLowerCase() === normalized;
    }) || '';
}

function normalizeManualUserName(userName) {
    const normalized = String(userName || '').trim().toLowerCase();
    if (normalized === 'alvaro') return 'Alvaro';
    if (normalized === 'kaylie') return 'Kaylie';
    return '';
}

function loadKnownAuthorNamesById() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return new Map();
    }

    try {
        const raw = window.localStorage.getItem(AUTHOR_NAME_STORAGE_KEY);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return new Map();

        const map = new Map();
        Object.entries(parsed).forEach(([userId, userName]) => {
            const canonical = normalizeManualUserName(userName);
            if (canonical && userId) {
                map.set(String(userId), canonical);
            }
        });
        return map;
    } catch (_error) {
        return new Map();
    }
}

function persistKnownAuthorNamesById() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    const serializable = {};
    knownAuthorNamesById.forEach((userName, userId) => {
        serializable[String(userId)] = userName;
    });
    window.localStorage.setItem(AUTHOR_NAME_STORAGE_KEY, JSON.stringify(serializable));
}

function rememberAuthorName(userId, userName) {
    const canonical = normalizeManualUserName(userName);
    if (!userId || !canonical) {
        return;
    }

    knownAuthorNamesById.set(String(userId), canonical);
    persistKnownAuthorNamesById();
}

function loadEntryDraftsFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    try {
        const raw = window.localStorage.getItem(ENTRY_DRAFTS_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;

        Object.entries(parsed).forEach(([draftKey, draftValue]) => {
            if (!draftKey || !draftValue || typeof draftValue !== 'object') {
                return;
            }
            entryDraftsBySpot.set(String(draftKey), {
                title: String(draftValue.title || ''),
                content: String(draftValue.content || ''),
                spotKey: String(draftValue.spotKey || ''),
                spotName: String(draftValue.spotName || 'Spot'),
                owner: normalizeManualUserName(draftValue.owner) || 'Anonimo',
                ownerKey: String(draftValue.ownerKey || ''),
                mode: draftValue.mode === 'edit' ? 'edit' : 'compose',
                entryId: draftValue.entryId ? String(draftValue.entryId) : null,
                updatedAt: draftValue.updatedAt || new Date().toISOString()
            });
        });
    } catch (_error) {
        // Ignore malformed local storage payload.
    }
}

function persistEntryDraftsToStorage() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return;
    }

    const serializable = {};
    entryDraftsBySpot.forEach((draftValue, draftKey) => {
        serializable[String(draftKey)] = {
            title: String(draftValue && draftValue.title ? draftValue.title : ''),
            content: String(draftValue && draftValue.content ? draftValue.content : ''),
            spotKey: String(draftValue && draftValue.spotKey ? draftValue.spotKey : ''),
            spotName: String(draftValue && draftValue.spotName ? draftValue.spotName : 'Spot'),
            owner: normalizeManualUserName(draftValue && draftValue.owner) || 'Anonimo',
            ownerKey: String(draftValue && draftValue.ownerKey ? draftValue.ownerKey : ''),
            mode: draftValue && draftValue.mode === 'edit' ? 'edit' : 'compose',
            entryId: draftValue && draftValue.entryId ? String(draftValue.entryId) : null,
            updatedAt: draftValue && draftValue.updatedAt ? draftValue.updatedAt : new Date().toISOString()
        };
    });
    window.localStorage.setItem(ENTRY_DRAFTS_STORAGE_KEY, JSON.stringify(serializable));
}

function getDraftOwnerName() {
    return normalizeManualUserName(currentManualUser) || 'Anonimo';
}

function getDraftOwnerKey() {
    return getDraftOwnerName().toLowerCase();
}

function createLocalComposeDraftKey(spotKey, ownerKey = getDraftOwnerKey()) {
    const safeSpotKey = String(spotKey || 'draft');
    const safeOwnerKey = String(ownerKey || 'anonimo');
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return `${safeOwnerKey}::compose:${safeSpotKey}:${nonce}`;
}

function toRemoteDraftKey(localDraftKey, ownerKey = getDraftOwnerKey()) {
    const raw = String(localDraftKey || '');
    const prefix = `${ownerKey}::`;
    if (raw.startsWith(prefix)) {
        return raw.slice(prefix.length);
    }

    const otherOwnerMatch = raw.match(/^[^:]+::(.+)$/);
    if (otherOwnerMatch && otherOwnerMatch[1]) {
        return otherOwnerMatch[1];
    }

    return raw;
}

function toLocalDraftKey(remoteDraftKey, ownerKey = getDraftOwnerKey()) {
    const normalizedOwnerKey = String(ownerKey || 'anonimo');
    const raw = String(remoteDraftKey || '');
    const prefix = `${normalizedOwnerKey}::`;
    if (raw.startsWith(prefix)) {
        return raw;
    }
    return `${prefix}${raw || 'spot:draft'}`;
}

function isCurrentComposerDirty() {
    const titleInput = document.getElementById('entryTitleInput');
    const editor = document.getElementById('entryBodyEditor');
    if (!titleInput || !editor) {
        return false;
    }

    if (String(titleInput.value || '').trim()) {
        return true;
    }

    const currentHtml = String(editor.innerHTML || '').trim();
    if (!currentHtml || currentHtml === ENTRY_EDITOR_PLACEHOLDER_HTML) {
        return false;
    }

    const plainText = getPlainTextFromHtml(currentHtml);
    return plainText && plainText !== 'Empieza a escribir aqui tu cronica...';
}

function mapDraftRowToLocalDraft(draftRow, ownerName, ownerKey) {
    const remoteDraftKey = toRemoteDraftKey(draftRow.draft_key, ownerKey);
    const inferredMode = remoteDraftKey.startsWith('entry:') ? 'edit' : 'compose';
    const inferredEntryId = inferredMode === 'edit' ? remoteDraftKey.slice('entry:'.length) : null;
    const inferredSpotKey = remoteDraftKey.startsWith('spot:')
        ? remoteDraftKey.slice('spot:'.length)
        : String(draftRow.spot_key || 'draft');

    return {
        localDraftKey: toLocalDraftKey(remoteDraftKey, ownerKey),
        value: {
            title: String(draftRow.title || ''),
            content: String(draftRow.content_html || ''),
            spotKey: String(inferredSpotKey || 'draft'),
            spotName: String(draftRow.spot_name || 'Spot'),
            owner: ownerName,
            ownerKey,
            mode: inferredMode,
            entryId: inferredEntryId ? String(inferredEntryId) : null,
            updatedAt: draftRow.updated_at || new Date().toISOString()
        }
    };
}

async function syncEntryDraftsFromSupabase(options = {}) {
    if (isSyncingDraftsFromSupabase) {
        return;
    }
    if (!isBackendReady() || !isManualAuthenticated()) {
        return;
    }

    const userId = await getCurrentUserId();
    if (!userId) {
        return;
    }

    const shouldRender = Boolean(options.render);
    const ownerName = getDraftOwnerName();
    const ownerKey = getDraftOwnerKey();
    const syncId = ++draftSyncCounter;
    isSyncingDraftsFromSupabase = true;

    const { data, error } = await supabase
        .from(SUPABASE_TABLES.drafts)
        .select('draft_key, spot_key, spot_name, title, content_html, updated_at')
        .eq('created_by', userId)
        .order('updated_at', { ascending: false });

    isSyncingDraftsFromSupabase = false;

    if (syncId !== draftSyncCounter) {
        return;
    }

    if (error) {
        logSupabaseError('No se pudieron sincronizar borradores', error);
        return;
    }

    let changed = false;
    (data || []).forEach((draftRow) => {
        const mapped = mapDraftRowToLocalDraft(draftRow, ownerName, ownerKey);
        const existing = entryDraftsBySpot.get(mapped.localDraftKey);
        const nextUpdatedAt = new Date(mapped.value.updatedAt).getTime();
        const existingUpdatedAt = existing && existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
        if (!existing || nextUpdatedAt >= existingUpdatedAt) {
            entryDraftsBySpot.set(mapped.localDraftKey, mapped.value);
            changed = true;
        }
    });

    if (changed) {
        persistEntryDraftsToStorage();
        if (shouldRender || activeDraftsMode) {
            renderThreads();
        }
    }
}

async function hydrateEntryDraftForComposer(context) {
    if (!context || !isBackendReady() || !isManualAuthenticated()) {
        return;
    }

    const ownerKey = getDraftOwnerKey();
    const localDraftKey = getEntryDraftKey(context, ownerKey);
    if (entryDraftsBySpot.has(localDraftKey)) {
        return;
    }

    const userId = await getCurrentUserId();
    if (!userId) {
        return;
    }

    const remoteDraftKey = toRemoteDraftKey(localDraftKey, ownerKey);
    const { data, error } = await supabase
        .from(SUPABASE_TABLES.drafts)
        .select('draft_key, spot_key, spot_name, title, content_html, updated_at')
        .eq('created_by', userId)
        .eq('draft_key', remoteDraftKey)
        .maybeSingle();

    if (error) {
        logSupabaseError('No se pudo cargar el borrador', error);
        return;
    }

    if (!data) {
        return;
    }

    const activeKey = activeComposerContext ? getEntryDraftKey(activeComposerContext, ownerKey) : null;
    if (activeKey !== localDraftKey) {
        return;
    }

    if (isCurrentComposerDirty()) {
        return;
    }

    const mapped = mapDraftRowToLocalDraft(data, getDraftOwnerName(), ownerKey);
    entryDraftsBySpot.set(mapped.localDraftKey, mapped.value);
    persistEntryDraftsToStorage();
    renderThreads();
}

async function upsertEntryDraftToSupabase(localDraftKey, draftValue) {
    if (!isBackendReady() || !isManualAuthenticated() || !draftValue) {
        return false;
    }

    const userId = await getCurrentUserId();
    if (!userId) {
        return false;
    }

    const ownerKey = String(draftValue.ownerKey || getDraftOwnerKey());
    const remoteDraftKey = toRemoteDraftKey(localDraftKey, ownerKey);
    const payload = {
        draft_key: remoteDraftKey,
        spot_key: String(draftValue.spotKey || 'draft'),
        spot_name: String(draftValue.spotName || 'Spot'),
        title: String(draftValue.title || ''),
        content_html: String(draftValue.content || ''),
        created_by: userId
    };

    const { error } = await supabase
        .from(SUPABASE_TABLES.drafts)
        .upsert(payload, { onConflict: 'created_by,draft_key' });

    if (error) {
        logSupabaseError('No se pudo guardar el borrador en Supabase', error);
        return false;
    }

    return true;
}

async function deleteEntryDraftFromSupabase(localDraftKey, ownerKey = getDraftOwnerKey()) {
    if (!isBackendReady() || !isManualAuthenticated()) {
        return false;
    }

    const userId = await getCurrentUserId();
    if (!userId) {
        return false;
    }

    const remoteDraftKey = toRemoteDraftKey(localDraftKey, ownerKey);
    const { error } = await supabase
        .from(SUPABASE_TABLES.drafts)
        .delete()
        .eq('created_by', userId)
        .eq('draft_key', remoteDraftKey);

    if (error) {
        logSupabaseError('No se pudo eliminar el borrador en Supabase', error);
        return false;
    }

    return true;
}

function resolveEntryAuthorName(createdBy, fallbackName) {
    const fallbackCanonical = normalizeManualUserName(fallbackName);
    if (fallbackCanonical) {
        return fallbackCanonical;
    }

    const raw = String(createdBy || '').trim();
    if (!raw) {
        return 'Anonimo';
    }

    const directCanonical = normalizeManualUserName(raw);
    if (directCanonical) {
        return directCanonical;
    }

    const fromEmail = getUserNameFromEmail(raw);
    if (fromEmail) {
        const emailCanonical = normalizeManualUserName(fromEmail);
        return emailCanonical || fromEmail;
    }

    const cachedName = knownAuthorNamesById.get(raw);
    if (cachedName) {
        return cachedName;
    }

    if (currentSessionUserId && currentManualUser && raw === currentSessionUserId) {
        const currentCanonical = normalizeManualUserName(currentManualUser);
        if (currentCanonical) {
            rememberAuthorName(raw, currentCanonical);
            return currentCanonical;
        }
    }

    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    return looksLikeUuid ? 'Autor' : raw;
}

function refreshPublishedEntriesAuthorNames() {
    publishedEntries.forEach((entry) => {
        entry.createdBy = resolveEntryAuthorName(entry.createdById, entry.createdBy);
    });
    renderHomeEntriesFeed();
    if (activeReadEntryId) {
        renderThreads();
    }
}

function ensureManualAuth(featureLabel) {
    if (isManualAuthenticated()) {
        return true;
    }

    const suffix = featureLabel ? ` para ${featureLabel}` : '';
    notify(`Debes iniciar sesion${suffix}.`, 'Acceso requerido');
    openAuthModal();
    return false;
}

async function hydrateAuthState() {
    if (!isBackendReady()) {
        currentManualUser = null;
        updateLoginButtonState();
        return;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error) {
        logSupabaseError('No se pudo leer la sesion inicial', error);
    }

    const user = data && data.session ? data.session.user : null;
    const userEmail = user ? (user.email || '') : '';
    const userName = getUserNameFromEmail(userEmail);
    currentSessionUserId = user ? user.id : null;
    currentManualUser = userName || (user ? (user.email || user.id) : null);
    if (currentSessionUserId && currentManualUser) {
        rememberAuthorName(currentSessionUserId, currentManualUser);
    }
    refreshPublishedEntriesAuthorNames();
    updateLoginButtonState();
    if (currentSessionUserId && currentManualUser) {
        void syncEntryDraftsFromSupabase({ render: activeDraftsMode });
    }

    supabase.auth.onAuthStateChange((_event, session) => {
        const nextUser = session && session.user ? session.user : null;
        const nextUserEmail = nextUser ? (nextUser.email || '') : '';
        const nextUserName = getUserNameFromEmail(nextUserEmail);
        currentSessionUserId = nextUser ? nextUser.id : null;
        currentManualUser = nextUserName || (nextUser ? (nextUser.email || nextUser.id) : null);
        if (currentSessionUserId && currentManualUser) {
            rememberAuthorName(currentSessionUserId, currentManualUser);
        }
        refreshPublishedEntriesAuthorNames();
        updateLoginButtonState();
        if (currentSessionUserId && currentManualUser) {
            void syncEntryDraftsFromSupabase({ render: activeDraftsMode || Boolean(activeComposerContext) });
        }
    });
}

function nextLocalSpotKey() {
    return `local-${nextLocalSpotId++}`;
}

function nextLocalEntryKey() {
    return `local-entry-${nextLocalEntryId++}`;
}

function logSupabaseError(action, error) {
    const message = error && error.message ? error.message : error;
    console.error(`[Supabase] ${action}`, message);
}

function notify(message, title = 'Notificacion') {
    const overlay = document.getElementById('noticeModalOverlay');
    const titleNode = document.getElementById('noticeModalTitle');
    const copyNode = document.getElementById('noticeModalCopy');
    if (!overlay || !copyNode) {
        console.warn('[notify] Modal no disponible:', message);
        return;
    }

    if (titleNode) {
        titleNode.textContent = title;
    }
    copyNode.textContent = String(message || '');
    overlay.hidden = false;
}

function closeNoticeModal() {
    const overlay = document.getElementById('noticeModalOverlay');
    const titleNode = document.getElementById('noticeModalTitle');
    const copyNode = document.getElementById('noticeModalCopy');
    if (overlay) {
        overlay.hidden = true;
    }
    if (titleNode) {
        titleNode.textContent = 'Notificacion';
    }
    if (copyNode) {
        copyNode.textContent = '';
    }
}

function mapEntryRecordToViewModel(entryRecord, fallback = {}) {
    const spotId = String(entryRecord.spot_id || fallback.spotKey || 'draft');
    const linkedSpot = createdSpotMarkers.get(spotId);
    const spotName = entryRecord.spot_name || fallback.spotName || (linkedSpot ? linkedSpot.name : 'Spot');
    const content = entryRecord.content_html || fallback.content || '';
    const excerpt = entryRecord.excerpt || fallback.excerpt || getPlainTextFromHtml(content).slice(0, 180);

    return {
        id: String(entryRecord.id || fallback.id || nextLocalEntryKey()),
        spotKey: spotId,
        spotName,
        title: entryRecord.title || fallback.title || `Entrada en ${spotName}`,
        createdById: entryRecord.created_by || fallback.createdById || null,
        createdBy: resolveEntryAuthorName(entryRecord.created_by, fallback.createdBy),
        excerpt,
        content,
        createdAt: entryRecord.created_at || fallback.createdAt || new Date().toISOString()
    };
}

function getPhotoPublicUrl(filePath) {
    if (!isBackendReady() || !filePath) {
        return '';
    }

    const { data } = supabase.storage
        .from(SUPABASE_STORAGE.galleryBucket)
        .getPublicUrl(filePath);
    return data && data.publicUrl ? data.publicUrl : '';
}

function mapPhotoRecordToViewModel(photoRecord, fallback = {}) {
    const filePath = photoRecord.file_path || fallback.storagePath || '';
    const createdAt = photoRecord.created_at || fallback.createdAt || new Date().toISOString();
    const spotKey = photoRecord.spot_id || fallback.spotKey || null;
    const scope = photoRecord.scope || fallback.scope || (spotKey ? 'spot' : 'global');

    return {
        id: String(photoRecord.id || fallback.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        scope,
        spotKey: spotKey ? String(spotKey) : null,
        src: fallback.src || getPhotoPublicUrl(filePath),
        name: photoRecord.file_name || fallback.name || 'Foto',
        description: photoRecord.description || fallback.description || '',
        addedBy: photoRecord.uploaded_by || fallback.addedBy || '',
        addedAt: fallback.addedAt || formatEntryDate(createdAt),
        createdAt,
        storagePath: filePath,
        persisted: Boolean(photoRecord.id)
    };
}

function sanitizePathPart(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'unknown';
}

function getFileExtension(fileName) {
    const parts = String(fileName || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : 'jpg';
}

async function uploadGalleryFiles(files, context = {}) {
    const { scope = 'global', spotKey = null } = context;
    const uploadedItems = [];
    const canPersistInBackend =
        isBackendReady() &&
        (scope === 'global' || isPersistedSpot(String(spotKey || '')));

    for (const file of files) {
        const localFallback = await readFileAsLocalPhoto(file, context);
        if (!localFallback) {
            continue;
        }

        if (!canPersistInBackend) {
            uploadedItems.push(localFallback);
            continue;
        }

        const createdBy = currentManualUser || null;
        const ext = getFileExtension(file.name);
        const segment = scope === 'spot' ? sanitizePathPart(spotKey) : 'global';
        const storagePath = `${scope}/${segment}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from(SUPABASE_STORAGE.galleryBucket)
            .upload(storagePath, file, { upsert: false });

        if (uploadError) {
            logSupabaseError('No se pudo subir una foto al storage', uploadError);
            uploadedItems.push(localFallback);
            continue;
        }

        const insertPayload = {
            scope,
            spot_id: scope === 'spot' ? String(spotKey || '') : null,
            file_path: storagePath,
            file_name: file.name,
            description: '',
            uploaded_by: createdBy
        };

        const { data, error: insertError } = await supabase
            .from(SUPABASE_TABLES.photos)
            .insert(insertPayload)
            .select('id, scope, spot_id, file_path, file_name, description, uploaded_by, created_at')
            .single();

        if (insertError) {
            logSupabaseError('No se pudo guardar metadata de foto', insertError);
            uploadedItems.push({
                ...localFallback,
                src: getPhotoPublicUrl(storagePath) || localFallback.src,
                storagePath,
                persisted: false
            });
            continue;
        }

        uploadedItems.push(
            mapPhotoRecordToViewModel(data, {
                spotKey,
                scope
            })
        );
    }

    return uploadedItems;
}

async function readFileAsLocalPhoto(file, context = {}) {
    const { scope = 'global', spotKey = null } = context;
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(loadEvent) {
            resolve({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                scope,
                spotKey,
                src: String(loadEvent.target && loadEvent.target.result ? loadEvent.target.result : ''),
                name: file.name,
                description: '',
                addedBy: currentManualUser || '',
                addedAt: formatEntryDate(new Date().toISOString()),
                createdAt: new Date().toISOString(),
                storagePath: '',
                persisted: false
            });
        };
        reader.onerror = function() {
            resolve(null);
        };
        reader.readAsDataURL(file);
    });
}

async function deleteGalleryPhoto(photo) {
    if (!photo) return false;

    if (isBackendReady() && photo.persisted) {
        const { error: rowDeleteError } = await supabase
            .from(SUPABASE_TABLES.photos)
            .delete()
            .eq('id', photo.id);

        if (rowDeleteError) {
            logSupabaseError('No se pudo eliminar la foto de la base de datos', rowDeleteError);
            return false;
        }

        if (photo.storagePath) {
            const { error: storageDeleteError } = await supabase.storage
                .from(SUPABASE_STORAGE.galleryBucket)
                .remove([photo.storagePath]);
            if (storageDeleteError) {
                logSupabaseError('No se pudo eliminar la foto del storage', storageDeleteError);
            }
        }
    }

    return true;
}

function addSpotMarkerFromRecord(spotRecord) {
    const spotId = String(spotRecord.id || '');
    if (!spotId || createdSpotMarkers.has(spotId)) {
        return;
    }

    const lat = Number(spotRecord.lat);
    const lng = Number(spotRecord.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
    }

    const spotName = String(spotRecord.name || 'Nuevo spot');
    const marker = L.marker([lat, lng], {
        icon: createSavedSpotIcon(spotName, spotId)
    }).addTo(map);

    createdSpotMarkers.set(spotId, {
        marker,
        name: spotName,
        persisted: true
    });
    bindCreatedSpotActions(marker, spotId);
}

async function hydrateFromSupabase() {
    if (!isBackendReady()) {
        return;
    }

    const { data: spotRows, error: spotsError } = await supabase
        .from(SUPABASE_TABLES.spots)
        .select('id, name, lat, lng, created_at')
        .order('created_at', { ascending: true });

    if (spotsError) {
        logSupabaseError('No se pudieron cargar los spots', spotsError);
    } else {
        (spotRows || []).forEach(addSpotMarkerFromRecord);
    }

    const { data: entryRows, error: entriesError } = await supabase
        .from(SUPABASE_TABLES.entries)
        .select('id, spot_id, spot_name, title, excerpt, content_html, created_at, created_by')
        .order('created_at', { ascending: false });

    if (entriesError) {
        logSupabaseError('No se pudieron cargar las entradas', entriesError);
        return;
    }

    publishedEntries.length = 0;
    (entryRows || []).forEach((entryRecord) => {
        publishedEntries.push(mapEntryRecordToViewModel(entryRecord));
    });

    const { data: photoRows, error: photosError } = await supabase
        .from(SUPABASE_TABLES.photos)
        .select('id, scope, spot_id, file_path, file_name, description, uploaded_by, created_at')
        .order('created_at', { ascending: false });

    if (photosError) {
        logSupabaseError('No se pudieron cargar las fotos', photosError);
    } else {
        globalGalleryPhotos.length = 0;
        galleryPhotosBySpot.clear();

        (photoRows || []).forEach((photoRecord) => {
            const photo = mapPhotoRecordToViewModel(photoRecord);
            if (!photo.src) {
                return;
            }

            if (photo.scope === 'global') {
                globalGalleryPhotos.push(photo);
                return;
            }

            const spotKey = String(photo.spotKey || '');
            if (!spotKey) {
                return;
            }
            const existing = galleryPhotosBySpot.get(spotKey) || [];
            existing.push(photo);
            galleryPhotosBySpot.set(spotKey, existing);
        });
    }

    renderHomeEntriesFeed();
    renderThreads();
}

function isPersistedSpot(spotId) {
    const createdSpot = createdSpotMarkers.get(String(spotId));
    return Boolean(createdSpot && createdSpot.persisted);
}

async function getCurrentUserId() {
    if (!isBackendReady()) {
        return null;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error) {
        const message = String(error && error.message ? error.message : '');
        if (!message.toLowerCase().includes('session missing')) {
            logSupabaseError('No se pudo consultar la sesion', error);
        }
        return null;
    }

    const user = data && data.session && data.session.user ? data.session.user : null;
    currentSessionUserId = user ? user.id : null;
    if (currentSessionUserId && currentManualUser) {
        rememberAuthorName(currentSessionUserId, currentManualUser);
    }
    return currentSessionUserId;
}

function bindStaticUi() {
    const launcher = document.getElementById('draftMarkerLauncher');
    const loginLauncher = document.getElementById('loginLauncher');
    const spotModalForm = document.getElementById('spotModalForm');
    const spotModalCancel = document.getElementById('spotModalCancel');
    const spotModalOverlay = document.getElementById('spotModalOverlay');
    const confirmModalOverlay = document.getElementById('confirmModalOverlay');
    const confirmModalCancel = document.getElementById('confirmModalCancel');
    const confirmModalAccept = document.getElementById('confirmModalAccept');
    const authModalOverlay = document.getElementById('authModalOverlay');
    const authModalCancel = document.getElementById('authModalCancel');
    const authModalForm = document.getElementById('authModalForm');
    const noticeModalOverlay = document.getElementById('noticeModalOverlay');
    const noticeModalClose = document.getElementById('noticeModalClose');
    const toggleAuthPassword = document.getElementById('toggleAuthPassword');
    const navHomeLink = document.getElementById('navHomeLink');
    const navGalleryLink = document.getElementById('navGalleryLink');
    const navDraftsLink = document.getElementById('navDraftsLink');

    map.on('mousemove', function(event) {
        if (!isDraftPlacementMode || !event.containerPoint) return;
        updateDraftCrosshairPosition(event.containerPoint.x, event.containerPoint.y);
    });

    map.on('click', function(event) {
        if (isDraftPlacementMode) {
            placeDraftLocationMarker(event.latlng);
            updateComposerLocation(event.latlng, 'Nueva entrada ubicada');
            openSpotModal(event.latlng);
            setDraftPlacementMode(false);
            return;
        }

        updateComposerLocation(event.latlng, 'Ubicacion sugerida');
    });

    if (launcher) {
        launcher.addEventListener('click', function() {
            if (!ensureManualAuth('crear spots')) {
                return;
            }
            setDraftPlacementMode(!isDraftPlacementMode);
        });
    }

    if (loginLauncher) {
        loginLauncher.addEventListener('click', function() {
            if (!isManualAuthenticated()) {
                openAuthModal();
                return;
            }

            const shouldLogout = window.confirm('Ya hay una sesion activa. Quieres cerrar sesion?');
            if (!shouldLogout) {
                return;
            }

            if (isBackendReady()) {
                void supabase.auth.signOut();
            }
            currentManualUser = null;
            updateLoginButtonState();
        });
    }

    if (spotModalForm) {
        spotModalForm.addEventListener('submit', handleSpotModalSubmit);
    }

    if (spotModalCancel) {
        spotModalCancel.addEventListener('click', closeSpotModal);
    }

    if (spotModalOverlay) {
        spotModalOverlay.addEventListener('click', function(event) {
            if (event.target === spotModalOverlay) {
                closeSpotModal();
            }
        });
    }

    if (confirmModalOverlay) {
        confirmModalOverlay.addEventListener('click', function(event) {
            if (event.target === confirmModalOverlay) {
                closeConfirmModal();
            }
        });
    }

    if (confirmModalCancel) {
        confirmModalCancel.addEventListener('click', closeConfirmModal);
    }

    if (confirmModalAccept) {
        confirmModalAccept.addEventListener('click', function() {
            pendingConfirmAccepted = true;
            if (pendingConfirmAction) {
                pendingConfirmAction();
            }
            if (pendingConfirmResolver) {
                pendingConfirmResolver(true);
            }
            closeConfirmModal();
        });
    }

    if (authModalCancel) {
        authModalCancel.addEventListener('click', closeAuthModal);
    }

    if (authModalOverlay) {
        authModalOverlay.addEventListener('click', function(event) {
            if (event.target === authModalOverlay) {
                closeAuthModal();
            }
        });
    }

    if (authModalForm) {
        authModalForm.addEventListener('submit', handleAuthModalSubmit);
    }

    if (noticeModalClose) {
        noticeModalClose.addEventListener('click', closeNoticeModal);
    }

    if (noticeModalOverlay) {
        noticeModalOverlay.addEventListener('click', function(event) {
            if (event.target === noticeModalOverlay) {
                closeNoticeModal();
            }
        });
    }

    if (toggleAuthPassword) {
        toggleAuthPassword.addEventListener('click', toggleAuthPasswordVisibility);
    }

    window.addEventListener('resize', handleMasonryResize);

    if (navHomeLink) {
        navHomeLink.addEventListener('click', function(event) {
            event.preventDefault();
            activeGlobalGalleryMode = false;
            activeComposerContext = null;
            activeGalleryContext = null;
            activeReadEntryId = null;
            activeDraftsMode = false;
            setNavMode('home');
            renderThreads();
        });
    }

    if (navGalleryLink) {
        navGalleryLink.addEventListener('click', function(event) {
            event.preventDefault();
            if (!ensureManualAuth('abrir la galerÃ­a')) {
                return;
            }
            openGlobalGalleryPane();
        });
    }

    if (navDraftsLink) {
        navDraftsLink.addEventListener('click', function(event) {
            event.preventDefault();
            if (!ensureManualAuth('abrir borradores')) {
                return;
            }
            openDraftsPane();
        });
    }

    const entriesSearchInput = document.getElementById('entriesSearchInput');
    if (entriesSearchInput) {
        entriesSearchInput.addEventListener('input', function(event) {
            activeEntriesSearchQuery = event.target.value || '';
            renderHomeEntriesFeed();
        });
    }

    document.addEventListener('click', function(event) {
        if (!event.target.closest('.draft-location-shell')) {
            closeAllSpotMenus();
        }
    });
}

function setDraftPlacementMode(nextActive) {
    isDraftPlacementMode = Boolean(nextActive);

    const launcher = document.getElementById('draftMarkerLauncher');
    if (launcher) {
        launcher.classList.toggle('is-active', isDraftPlacementMode);
    }

    if (!isDraftPlacementMode) {
        hideDraftCrosshair();
        return;
    }

    const crosshair = document.getElementById('draftCrosshair');
    if (crosshair) {
        crosshair.hidden = false;
    }

    if (map) {
        const center = map.getSize().divideBy(2);
        updateDraftCrosshairPosition(center.x, center.y);
    }
}

function updateComposerLocation(latlng, label = 'Ubicacion elegida') {
    if (activeComposerContext) {
        activeComposerContext.latlng = latlng;
    }

    const subtitle = document.getElementById('entryLocationHint');
    if (subtitle) {
        subtitle.textContent = `${label}: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
        subtitle.classList.add('pulse');
        window.setTimeout(() => {
            subtitle.classList.remove('pulse');
        }, 800);
    }
}

function startDraftMarkerDrag(event) {
    const launcher = event.currentTarget;
    if (!launcher) return;

    event.preventDefault();

    const mapBounds = map.getContainer().getBoundingClientRect();
    const launcherBounds = launcher.getBoundingClientRect();
    const pin = launcher.querySelector('.draft-marker-pin');
    const pinBounds = pin ? pin.getBoundingClientRect() : launcherBounds;
    const tipClientX = pinBounds.left + (pinBounds.width / 2);
    const tipClientY = pinBounds.bottom;

    draftDragState = {
        pointerId: event.pointerId,
        launcher,
        mapBounds,
        tipOffsetX: tipClientX - launcherBounds.left,
        tipOffsetY: tipClientY - launcherBounds.top,
        crosshair: document.getElementById('draftCrosshair'),
        crosshairX: document.getElementById('draftCrosshairX'),
        crosshairY: document.getElementById('draftCrosshairY')
    };

    launcher.setPointerCapture(event.pointerId);
    launcher.classList.add('dragging');
    map.dragging.disable();

    if (draftDragState.crosshair) {
        draftDragState.crosshair.hidden = false;
        updateDraftCrosshairPosition(event.clientX, event.clientY);
    }

    window.addEventListener('pointermove', handleDraftMarkerMove);
    window.addEventListener('pointerup', finishDraftMarkerDrag);
    window.addEventListener('pointercancel', finishDraftMarkerDrag);
}

function handleDraftMarkerMove(event) {
    if (!draftDragState || event.pointerId !== draftDragState.pointerId) {
        return;
    }

    const { launcher, mapBounds, tipOffsetX, tipOffsetY } = draftDragState;
    const left = event.clientX - mapBounds.left - tipOffsetX;
    const top = event.clientY - mapBounds.top - tipOffsetY;

    launcher.style.left = `${left}px`;
    launcher.style.top = `${top}px`;
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';

    updateDraftCrosshairPosition(event.clientX, event.clientY);
}

function finishDraftMarkerDrag(event) {
    if (!draftDragState || event.pointerId !== draftDragState.pointerId) {
        return;
    }

    const { launcher } = draftDragState;
    const mapContainer = map.getContainer();
    const mapBounds = mapContainer.getBoundingClientRect();
    const insideMap =
        event.clientX >= mapBounds.left &&
        event.clientX <= mapBounds.right &&
        event.clientY >= mapBounds.top &&
        event.clientY <= mapBounds.bottom;

    launcher.classList.remove('dragging');
    launcher.releasePointerCapture(event.pointerId);
    launcher.removeAttribute('style');
    map.dragging.enable();
    hideDraftCrosshair();

    if (insideMap) {
        const containerPoint = L.point(
            event.clientX - mapBounds.left,
            event.clientY - mapBounds.top
        );
        const latlng = map.containerPointToLatLng(containerPoint);
        placeDraftLocationMarker(latlng);
        updateComposerLocation(latlng, 'Nueva entrada ubicada');
        openSpotModal(latlng);
    }

    draftDragState = null;
    window.removeEventListener('pointermove', handleDraftMarkerMove);
    window.removeEventListener('pointerup', finishDraftMarkerDrag);
    window.removeEventListener('pointercancel', finishDraftMarkerDrag);
}

function updateDraftCrosshairPosition(containerX, containerY) {
    const crosshairX = document.getElementById('draftCrosshairX');
    const crosshairY = document.getElementById('draftCrosshairY');
    if (!crosshairX || !crosshairY) return;

    crosshairY.style.left = `${containerX}px`;
    crosshairX.style.top = `${containerY}px`;
}

function hideDraftCrosshair() {
    const crosshair = document.getElementById('draftCrosshair');
    if (!crosshair) return;
    crosshair.hidden = true;
    const x = document.getElementById('draftCrosshairX');
    const y = document.getElementById('draftCrosshairY');
    if (x) x.removeAttribute('style');
    if (y) y.removeAttribute('style');
}

function placeDraftLocationMarker(latlng) {
    if (!draftLocationMarker) {
        draftLocationMarker = L.marker(latlng, {
            icon: createDraftLocationIcon()
        }).addTo(map);

        bindDraftLocationMarkerActions();
    } else {
        draftLocationMarker.setLatLng(latlng);
        draftLocationMarker.setIcon(createDraftLocationIcon());
        bindDraftLocationMarkerActions();
    }

    map.panTo(latlng, {
        animate: true,
        duration: 0.5
    });
}

function createDraftLocationIcon() {
    return L.divIcon({
        className: 'draft-location-wrapper',
        html: `
            <div class="draft-location-shell">
                <div class="draft-location-actions">
                    <button type="button" class="draft-location-action draft-location-action-primary" data-draft-action="write" aria-label="Nueva entrada" title="Nueva entrada">
                        <span class="draft-action-icon" aria-hidden="true">+</span>
                    </button>
                    <button type="button" class="draft-location-action" data-draft-action="entries">Entradas</button>
                    <button type="button" class="draft-location-action" data-draft-action="rename">Renombrar</button>
                    <button type="button" class="draft-location-action" data-draft-action="remove">Eliminar</button>
                </div>
                <div class="draft-location-meta">
                    <span class="draft-location-label">${draftSpotName || 'Nuevo spot'}</span>
                    <span class="draft-location-pin" aria-hidden="true"></span>
                </div>
            </div>
        `,
        iconSize: [160, 92],
        iconAnchor: [80, 92]
    });
}

function createSavedSpotIcon(spotName, spotId) {
    return L.divIcon({
        className: 'draft-location-wrapper saved-spot-wrapper',
        html: `
            <div class="draft-location-shell saved-spot-shell">
                <div class="draft-location-actions">
                    <button type="button" class="draft-location-action draft-location-action-primary" data-created-action="new-entry" data-spot-id="${spotId}" aria-label="Nueva entrada" title="Nueva entrada">
                        <span class="draft-action-icon" aria-hidden="true">+</span>
                    </button>
                    <button type="button" class="draft-location-action" data-created-action="entries" data-spot-id="${spotId}">Entradas</button>
                    <button type="button" class="draft-location-action" data-created-action="rename" data-spot-id="${spotId}">Renombrar</button>
                    <button type="button" class="draft-location-action" data-created-action="remove" data-spot-id="${spotId}">Eliminar</button>
                </div>
                <div class="draft-location-meta">
                    <span class="draft-location-label">${spotName}</span>
                    <span class="draft-location-pin" aria-hidden="true"></span>
                </div>
            </div>
        `,
        iconSize: [160, 92],
        iconAnchor: [80, 92]
    });
}

function openSpotModal(latlng, options = {}) {
    const { mode = 'create', initialName = '', spotId = null } = options;
    pendingDraftLatLng = latlng;
    pendingRenameSpotId = mode === 'rename' ? spotId : null;

    const overlay = document.getElementById('spotModalOverlay');
    const input = document.getElementById('spotNameInput');
    const title = document.getElementById('spotModalTitle');
    if (!overlay || !input) return;

    if (title) {
        title.textContent = mode === 'rename' ? 'Renombra este spot' : 'Como se llama este spot?';
    }

    overlay.hidden = false;
    input.value = initialName || draftSpotName;

    window.setTimeout(() => {
        input.focus();
        input.select();
    }, 0);
}

function closeSpotModal(options = {}) {
    const { preserveMarker = false } = options;
    const overlay = document.getElementById('spotModalOverlay');
    const input = document.getElementById('spotNameInput');
    const title = document.getElementById('spotModalTitle');

    if (overlay) {
        overlay.hidden = true;
    }

    if (input) {
        input.value = '';
    }

    if (!preserveMarker && draftLocationMarker && pendingDraftLatLng) {
        map.removeLayer(draftLocationMarker);
        draftLocationMarker = null;
        draftSpotName = '';
    }

    if (title) {
        title.textContent = 'Como se llama este spot?';
    }

    pendingDraftLatLng = null;
    pendingRenameSpotId = null;
}

async function handleSpotModalSubmit(event) {
    event.preventDefault();

    const input = document.getElementById('spotNameInput');
    if (!input || !pendingDraftLatLng) return;
    if (!ensureManualAuth('crear spots')) return;

    const value = input.value.trim();
    draftSpotName = value || 'Nuevo spot';

    if (pendingRenameSpotId) {
        await renameCreatedSpot(pendingRenameSpotId, draftSpotName);
        updateComposerLocation(pendingDraftLatLng, `Spot renombrado: ${draftSpotName}`);
        closeSpotModal({ preserveMarker: true });
        return;
    }

    if (!draftLocationMarker) {
        placeDraftLocationMarker(pendingDraftLatLng);
    }

    const saved = await finalizeDraftSpot();
    if (!saved) {
        return;
    }
    updateComposerLocation(pendingDraftLatLng, `Spot: ${draftSpotName}`);
    closeSpotModal({ preserveMarker: true });
}

async function finalizeDraftSpot() {
    if (!draftLocationMarker) {
        return false;
    }

    const spotName = draftSpotName || 'Nuevo spot';
    const latlng = draftLocationMarker.getLatLng();
    let spotId = '';
    let persisted = false;

    if (isBackendReady()) {
        const createdBy = await getCurrentUserId();
        if (!createdBy) {
            notify('Para crear spots necesitas iniciar sesion con una cuenta autenticada en Supabase.', 'Acceso requerido');
            openAuthModal();
            return false;
        }
        const { data, error } = await supabase
            .from(SUPABASE_TABLES.spots)
            .insert({
                name: spotName,
                lat: latlng.lat,
                lng: latlng.lng,
                created_by: createdBy
            })
            .select('id')
            .single();

        if (error) {
            logSupabaseError('No se pudo guardar el spot', error);
            notify('No se pudo guardar el spot. Verifica tu sesion y permisos.', 'Error al guardar');
            return false;
        } else {
            spotId = String(data.id);
            persisted = true;
        }
    } else {
        notify('La configuracion de Supabase no esta lista. No se pueden crear spots.', 'Configuracion');
        return false;
    }

    draftLocationMarker.setIcon(createSavedSpotIcon(spotName, spotId));
    createdSpotMarkers.set(spotId, {
        marker: draftLocationMarker,
        name: spotName,
        persisted
    });

    bindCreatedSpotActions(draftLocationMarker, spotId);
    draftLocationMarker = null;
    draftSpotName = '';
    return true;
}

function bindDraftLocationMarkerActions() {
    if (!draftLocationMarker) return;

    const element = draftLocationMarker.getElement();
    if (!element || element.dataset.boundActions === 'true') {
        return;
    }

    element.dataset.boundActions = 'true';
    element.addEventListener('click', handleDraftLocationActionClick);
    element.addEventListener('click', handleSpotShellClick);
}

function handleDraftLocationActionClick(event) {
    const actionButton = event.target.closest('[data-draft-action]');
    if (!actionButton || !draftLocationMarker) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const action = actionButton.dataset.draftAction;
    const latlng = draftLocationMarker.getLatLng();

    if (action === 'write') {
        openEntryComposer({
            spotName: draftSpotName || 'Nuevo spot',
            spotKey: 'draft',
            latlng,
            forceNew: true
        });
        updateComposerLocation(latlng, 'Nueva entrada en');
        closeAllSpotMenus();
        return;
    }

    if (action === 'entries') {
        focusEntriesBySpot('draft', draftSpotName || 'Nuevo spot');
        updateComposerLocation(latlng, `Entradas en ${draftSpotName || 'Nuevo spot'}`);
        closeAllSpotMenus();
        return;
    }

    if (action === 'gallery') {
        openGalleryPane({
            spotName: draftSpotName || 'Nuevo spot',
            spotKey: 'draft',
            latlng
        });
        updateComposerLocation(latlng, `Galeria de ${draftSpotName || 'Nuevo spot'}`);
        closeAllSpotMenus();
        return;
    }

    if (action === 'rename') {
        openSpotModal(latlng, {
            mode: 'rename',
            initialName: draftSpotName || 'Nuevo spot'
        });
        closeAllSpotMenus();
        return;
    }

    if (action === 'remove') {
        openConfirmModal(
            'Si eliminas este spot, se perdera su ubicacion guardada y cualquier nueva entrada asociada tendra que crearse otra vez desde cero.',
            function() {
                map.removeLayer(draftLocationMarker);
                draftLocationMarker = null;
                draftSpotName = '';

                const composer = document.querySelector('.composer-box .composer-subtitle');
                if (composer) {
                    composer.textContent = 'Toca el mapa para asociar la entrada a una ubicacion.';
                }

                closeAllSpotMenus();
            }
        );
    }
}

function bindCreatedSpotActions(marker, spotId) {
    const element = marker.getElement();
    if (!element || element.dataset.createdActionsBound === 'true') {
        return;
    }

    element.dataset.createdActionsBound = 'true';
    element.dataset.createdSpotId = spotId;
    element.addEventListener('click', handleCreatedSpotActionClick);
    element.addEventListener('click', handleSpotShellClick);
}

function handleCreatedSpotActionClick(event) {
    const actionButton = event.target.closest('[data-created-action]');
    if (!actionButton) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const spotId = actionButton.dataset.spotId;
    const createdSpot = createdSpotMarkers.get(spotId);
    if (!createdSpot) {
        return;
    }

    const { marker, name } = createdSpot;
    const latlng = marker.getLatLng();
    const action = actionButton.dataset.createdAction;

    if (action === 'new-entry') {
        openEntryComposer({
            spotName: name,
            spotKey: spotId,
            latlng,
            forceNew: true
        });
        updateComposerLocation(latlng, `Nueva entrada en ${name}`);
        closeAllSpotMenus();
        return;
    }

    if (action === 'entries') {
        focusEntriesBySpot(spotId, name);
        updateComposerLocation(latlng, `Entradas en ${name}`);
        closeAllSpotMenus();
        return;
    }

    if (action === 'gallery') {
        openGalleryPane({
            spotName: name,
            spotKey: spotId,
            latlng
        });
        updateComposerLocation(latlng, `Galeria de ${name}`);
        closeAllSpotMenus();
        return;
    }

    if (action === 'rename') {
        openSpotModal(latlng, {
            mode: 'rename',
            initialName: name,
            spotId
        });
        closeAllSpotMenus();
        return;
    }

    if (action === 'remove') {
        openConfirmModal(
            `Si eliminas "${name}", el spot desaparecera del mapa y las futuras entradas tendran que volver a ubicarse manualmente.`,
            function() {
                void removeCreatedSpot(spotId);
                closeAllSpotMenus();
            }
        );
    }
}

async function renameCreatedSpot(spotId, nextName) {
    const createdSpot = createdSpotMarkers.get(spotId);
    if (!createdSpot) {
        return;
    }

    createdSpot.name = nextName;
    createdSpot.marker.setIcon(createSavedSpotIcon(nextName, spotId));
    bindCreatedSpotActions(createdSpot.marker, spotId);

    if (!createdSpot.persisted || !isBackendReady()) {
        return;
    }

    const { error } = await supabase
        .from(SUPABASE_TABLES.spots)
        .update({ name: nextName })
        .eq('id', spotId);

    if (error) {
        logSupabaseError('No se pudo renombrar el spot', error);
    }
}

async function removeCreatedSpot(spotId) {
    const createdSpot = createdSpotMarkers.get(spotId);
    if (!createdSpot) {
        return;
    }

    if (createdSpot.persisted && isBackendReady()) {
        const { error } = await supabase
            .from(SUPABASE_TABLES.spots)
            .delete()
            .eq('id', spotId);

        if (error) {
            logSupabaseError('No se pudo eliminar el spot', error);
            return;
        }
    }

    map.removeLayer(createdSpot.marker);
    createdSpotMarkers.delete(spotId);

    const nextEntries = publishedEntries.filter((entry) => String(entry.spotKey) !== String(spotId));
    if (nextEntries.length !== publishedEntries.length) {
        publishedEntries.length = 0;
        publishedEntries.push(...nextEntries);
        renderHomeEntriesFeed();
    }
}

function handleSpotShellClick(event) {
    const actionButton = event.target.closest('[data-draft-action], [data-created-action]');
    if (actionButton) {
        return;
    }

    const shell = event.target.closest('.draft-location-shell');
    if (!shell) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const isOpen = shell.classList.contains('menu-open');
    closeAllSpotMenus();

    if (!isOpen) {
        shell.classList.add('menu-open');
    }
}

function closeAllSpotMenus() {
    document.querySelectorAll('.draft-location-shell.menu-open').forEach((shell) => {
        shell.classList.remove('menu-open');
    });
}

function openConfirmModal(message, onConfirm, options = {}) {
    const overlay = document.getElementById('confirmModalOverlay');
    const copy = document.getElementById('confirmModalCopy');
    const title = document.getElementById('confirmModalTitle');
    const accept = document.getElementById('confirmModalAccept');
    if (!overlay || !copy) {
        return;
    }

    const modalTitle = options.title || 'Confirmacion';
    const acceptLabel = options.acceptLabel || 'Eliminar';
    overlay.classList.toggle('is-right-confirm', options.side === 'right');
    copy.textContent = message;
    if (title) {
        title.textContent = modalTitle;
    }
    if (accept) {
        accept.textContent = acceptLabel;
    }
    pendingConfirmAction = onConfirm;
    pendingConfirmResolver = typeof options.onDecision === 'function' ? options.onDecision : null;
    pendingConfirmAccepted = false;
    overlay.hidden = false;
}

function closeConfirmModal() {
    const overlay = document.getElementById('confirmModalOverlay');
    const copy = document.getElementById('confirmModalCopy');
    const title = document.getElementById('confirmModalTitle');
    const accept = document.getElementById('confirmModalAccept');
    if (overlay) {
        overlay.hidden = true;
        overlay.classList.remove('is-right-confirm');
    }
    if (copy) {
        copy.textContent = '';
    }
    if (title) {
        title.textContent = 'Confirmacion';
    }
    if (accept) {
        accept.textContent = 'Eliminar';
    }
    if (pendingConfirmResolver && !pendingConfirmAccepted) {
        pendingConfirmResolver(false);
    }
    pendingConfirmAction = null;
    pendingConfirmResolver = null;
    pendingConfirmAccepted = false;
}

function openAuthModal() {
    const overlay = document.getElementById('authModalOverlay');
    const userInput = document.getElementById('authUserInput');
    if (!overlay) return;

    overlay.hidden = false;
    window.setTimeout(() => {
        if (userInput) {
            userInput.value = '';
            userInput.focus();
        }
    }, 0);
}

function closeAuthModal() {
    const overlay = document.getElementById('authModalOverlay');
    const form = document.getElementById('authModalForm');
    const userInput = document.getElementById('authUserInput');
    const passwordInput = document.getElementById('authPasswordInput');
    const toggleButton = document.getElementById('toggleAuthPassword');
    if (overlay) {
        overlay.hidden = true;
    }
    if (form) {
        form.reset();
    }
    if (userInput) {
        userInput.value = '';
    }
    if (passwordInput) {
        passwordInput.type = 'password';
    }
    if (toggleButton) {
        toggleButton.textContent = 'Ver';
        toggleButton.setAttribute('aria-pressed', 'false');
        toggleButton.setAttribute('aria-label', 'Mostrar contraseÃ±a');
    }
}

async function handleAuthModalSubmit(event) {
    event.preventDefault();

    const form = document.getElementById('authModalForm');
    const userInput = document.getElementById('authUserInput');
    const passwordInput = document.getElementById('authPasswordInput');
    if (!form || !userInput || !passwordInput) {
        closeAuthModal();
        return;
    }

    if (!isBackendReady()) {
        notify('Configura Supabase para iniciar sesion.', 'Configuracion');
        return;
    }

    const selectedUserName = userInput.value.trim();
    if (!selectedUserName) {
        notify('Selecciona un usuario para iniciar sesion.', 'Acceso');
        return;
    }

    const email = getAuthEmailForUser(selectedUserName);
    if (!email) {
        notify('No existe un correo configurado para este usuario. Revisa AUTH_USER_EMAILS en map.js.', 'Configuracion');
        return;
    }

    if (email.toLowerCase().endsWith('@tu-dominio.com')) {
        notify('Debes actualizar AUTH_USER_EMAILS en map.js con los correos reales de Supabase Auth.', 'Configuracion');
        return;
    }

    const password = passwordInput.value;
    const submitButton = form.querySelector('button[type="submit"]');
    const defaultLabel = submitButton ? submitButton.textContent : 'Entrar';

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Validando...';
    }

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = defaultLabel;
    }

    if (error || !data || !data.user) {
        notify(`No se pudo iniciar sesion: ${error ? error.message : 'credenciales invalidas'}`, 'Acceso');
        return;
    }

    const resolvedUserName = getUserNameFromEmail(data.user.email || email);
    currentSessionUserId = data.user.id || null;
    currentManualUser = resolvedUserName || selectedUserName || data.user.email || data.user.id;
    if (currentSessionUserId && currentManualUser) {
        rememberAuthorName(currentSessionUserId, currentManualUser);
    }
    updateLoginButtonState();
    closeAuthModal();
}

function updateLoginButtonState() {
    const loginLauncher = document.getElementById('loginLauncher');
    const galleryLink = document.getElementById('navGalleryLink');
    const draftsLink = document.getElementById('navDraftsLink');
    if (!loginLauncher) return;

    if (currentManualUser) {
        loginLauncher.setAttribute('title', `Sesion iniciada: ${currentManualUser}`);
        loginLauncher.setAttribute('aria-label', `Sesion iniciada: ${currentManualUser}`);
        loginLauncher.classList.add('is-authenticated');
        if (galleryLink) {
            galleryLink.classList.remove('locked');
            galleryLink.setAttribute('aria-disabled', 'false');
            galleryLink.removeAttribute('title');
        }
        if (draftsLink) {
            draftsLink.classList.remove('locked');
            draftsLink.setAttribute('aria-disabled', 'false');
            draftsLink.removeAttribute('title');
        }
    } else {
        loginLauncher.setAttribute('title', 'Iniciar sesion');
        loginLauncher.setAttribute('aria-label', 'Iniciar sesion');
        loginLauncher.classList.remove('is-authenticated');
        if (galleryLink) {
            galleryLink.classList.add('locked');
            galleryLink.setAttribute('aria-disabled', 'true');
            galleryLink.setAttribute('title', 'Inicia sesion para abrir la galeria');
        }
        if (draftsLink) {
            draftsLink.classList.add('locked');
            draftsLink.setAttribute('aria-disabled', 'true');
            draftsLink.setAttribute('title', 'Inicia sesion para abrir borradores');
        }
        if (activeGlobalGalleryMode) {
            activeGlobalGalleryMode = false;
        }
        if (activeDraftsMode) {
            activeDraftsMode = false;
        }
    }

    if (activeGlobalGalleryMode) {
        setNavMode('gallery');
    } else if (activeDraftsMode) {
        setNavMode('drafts');
    } else {
        setNavMode('home');
    }
    renderThreads();
}

function toggleAuthPasswordVisibility() {
    const passwordInput = document.getElementById('authPasswordInput');
    const toggleButton = document.getElementById('toggleAuthPassword');
    if (!passwordInput || !toggleButton) {
        return;
    }

    const nextVisible = passwordInput.type === 'password';
    passwordInput.type = nextVisible ? 'text' : 'password';
    toggleButton.textContent = nextVisible ? 'Ocultar' : 'Ver';
    toggleButton.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
    toggleButton.setAttribute('aria-label', nextVisible ? 'Ocultar contraseÃ±a' : 'Mostrar contraseÃ±a');
}

function renderCategories() {
    const counts = threads.reduce((accumulator, thread) => {
        accumulator[thread.category] = (accumulator[thread.category] || 0) + 1;
        return accumulator;
    }, {});

    const categoryList = document.getElementById('categoryList');
    if (categoryList) {
        categoryList.innerHTML = Object.entries(CATEGORY_META)
            .map(([key, meta]) => `
                <button class="channel-item" type="button">
                    <span class="channel-left">
                        <span class="channel-dot ${meta.className}"></span>
                        <span>${meta.label}</span>
                    </span>
                    <strong>${counts[key] || 0}</strong>
                </button>
            `)
            .join('');
    }
}

function renderThreads() {
    const feedContent = document.getElementById('feedContent');
    const feedCount = document.getElementById('feedCount');
    if (!feedContent) return;

    if (activeComposerContext) {
        document.body.classList.add('compose-mode');
        document.body.classList.remove('gallery-mode');
        document.body.classList.remove('read-mode');
        document.body.classList.remove('global-gallery-mode');
        document.body.classList.remove('drafts-mode');
        renderEntryComposer(feedContent, activeComposerContext);
        return;
    }

    if (activeGalleryContext) {
        document.body.classList.remove('compose-mode');
        document.body.classList.add('gallery-mode');
        document.body.classList.remove('read-mode');
        document.body.classList.remove('global-gallery-mode');
        document.body.classList.remove('drafts-mode');
        renderGalleryPane(feedContent, activeGalleryContext);
        return;
    }

    if (activeGlobalGalleryMode) {
        document.body.classList.remove('compose-mode');
        document.body.classList.remove('gallery-mode');
        document.body.classList.remove('read-mode');
        document.body.classList.add('global-gallery-mode');
        document.body.classList.remove('drafts-mode');
        renderGlobalGalleryPane(feedContent);
        return;
    }

    if (activeDraftsMode) {
        document.body.classList.remove('compose-mode');
        document.body.classList.remove('gallery-mode');
        document.body.classList.remove('read-mode');
        document.body.classList.remove('global-gallery-mode');
        document.body.classList.add('drafts-mode');
        renderDraftsPane(feedContent);
        return;
    }

    if (activeReadEntryId) {
        document.body.classList.remove('compose-mode');
        document.body.classList.remove('gallery-mode');
        document.body.classList.add('read-mode');
        document.body.classList.remove('global-gallery-mode');
        document.body.classList.remove('drafts-mode');
        renderEntryReaderPane(feedContent, activeReadEntryId);
        return;
    }

    document.body.classList.remove('compose-mode');
    document.body.classList.remove('gallery-mode');
    document.body.classList.remove('read-mode');
    document.body.classList.remove('global-gallery-mode');
    document.body.classList.remove('drafts-mode');

    if (feedCount) feedCount.textContent = `${threads.length} publicadas`;
    feedContent.innerHTML = threads
        .map((thread) => {
            const category = CATEGORY_META[thread.category];
            const isActive = thread.id === activeThreadId;

            return `
                <article class="thread-card ${isActive ? 'active' : ''}" data-thread-id="${thread.id}">
                    <div class="thread-meta">
                        <span class="thread-tag ${category.className}">${category.label}</span>
                        <span>${thread.time}</span>
                    </div>
                    <h4>${thread.title}</h4>
                    <p>${thread.excerpt}</p>
                    <div class="thread-footer">
                        <div>
                            <strong>${thread.area}</strong>
                            <span>${thread.author} ${thread.handle}</span>
                        </div>
                        <div class="thread-stats">
                            <span>${thread.replies} notas</span>
                            <span>${thread.reactions} lecturas</span>
                        </div>
                    </div>
                </article>
            `;
        })
        .join('');

    Array.from(feedContent.querySelectorAll('.thread-card')).forEach((card) => {
        card.addEventListener('click', () => {
            const threadId = Number(card.dataset.threadId);
            focusThread(threadId);
        });
    });
}

function openEntryComposer(context) {
    const nextContext = { ...(context || {}) };
    if (nextContext.forceNew && !nextContext.draftKey) {
        nextContext.draftKey = createLocalComposeDraftKey(nextContext.spotKey);
    }

    activeComposerContext = nextContext;
    activeGalleryContext = null;
    activeReadEntryId = null;
    activeGlobalGalleryMode = false;
    activeDraftsMode = false;
    document.body.classList.add('compose-mode');
    document.body.classList.remove('gallery-mode');
    document.body.classList.remove('read-mode');
    setNavMode('home');
    renderThreads();

    const feedContent = document.getElementById('feedContent');
    if (feedContent) {
        feedContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function closeEntryComposer() {
    activeComposerContext = null;
    document.body.classList.remove('compose-mode');
    renderThreads();
}

function openGalleryPane(context) {
    const currentView = activeGalleryContext && activeGalleryContext.spotKey === context.spotKey
        ? activeGalleryContext.view
        : 'pinterest';

    activeGalleryContext = {
        ...context,
        view: currentView
    };
    activeComposerContext = null;
    activeReadEntryId = null;
    activeGlobalGalleryMode = false;
    activeDraftsMode = false;
    document.body.classList.remove('compose-mode');
    document.body.classList.add('gallery-mode');
    document.body.classList.remove('read-mode');
    setNavMode('home');
    renderThreads();
    void hydrateEntryDraftForComposer(context);

    const feedContent = document.getElementById('feedContent');
    if (feedContent) {
        feedContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function closeGalleryPane() {
    activeGalleryContext = null;
    document.body.classList.remove('gallery-mode');
    renderThreads();
}

function openEntryReader(entryId) {
    activeReadEntryId = String(entryId);
    activeComposerContext = null;
    activeGalleryContext = null;
    activeGlobalGalleryMode = false;
    activeDraftsMode = false;
    document.body.classList.remove('compose-mode');
    document.body.classList.remove('gallery-mode');
    document.body.classList.add('read-mode');
    setNavMode('home');
    renderThreads();

    const entry = publishedEntries.find((item) => String(item.id) === activeReadEntryId);
    if (entry) {
        centerMapOnEntry(entry);
    }

    const feedContent = document.getElementById('feedContent');
    if (feedContent) {
        feedContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function closeEntryReader() {
    activeReadEntryId = null;
    document.body.classList.remove('read-mode');
    renderThreads();
}

function isPersistedEntry(entry) {
    if (!entry || !entry.id) return false;
    return !String(entry.id).startsWith('local-entry-');
}

function confirmEntryDeletion(entryTitle) {
    const safeTitle = entryTitle ? `"${entryTitle}"` : 'esta entrada';
    return new Promise((resolve) => {
        openConfirmModal(
            `Seguro que deseas eliminar ${safeTitle}? Esta accion no se puede deshacer.`,
            null,
            {
                title: 'Eliminar entrada?',
                acceptLabel: 'Eliminar',
                side: 'right',
                onDecision: resolve
            }
        );
    });
}

async function editPublishedEntry(entryId) {
    if (!ensureManualAuth('editar entradas')) {
        return;
    }

    const entry = publishedEntries.find((item) => String(item.id) === String(entryId));
    if (!entry) {
        return;
    }

    openEntryComposer({
        mode: 'edit',
        entryId: String(entry.id),
        spotKey: String(entry.spotKey || 'draft'),
        spotName: entry.spotName || 'Spot'
    });
}

async function removePublishedEntry(entryId) {
    if (!ensureManualAuth('eliminar entradas')) {
        return;
    }

    const index = publishedEntries.findIndex((item) => String(item.id) === String(entryId));
    if (index < 0) {
        return;
    }

    const target = publishedEntries[index];
    if (!(await confirmEntryDeletion(target.title))) {
        return;
    }

    if (isBackendReady() && isPersistedEntry(target)) {
        const { error } = await supabase
            .from(SUPABASE_TABLES.entries)
            .delete()
            .eq('id', target.id);

        if (error) {
            logSupabaseError('No se pudo eliminar la entrada', error);
            notify('No se pudo eliminar la entrada en Supabase.', 'Error al eliminar');
            return;
        }
    }

    publishedEntries.splice(index, 1);
    void removeEntryDraft({
        mode: 'edit',
        entryId: String(target.id),
        spotKey: String(target.spotKey || 'draft'),
        spotName: String(target.spotName || 'Spot')
    });
    renderHomeEntriesFeed();

    if (activeReadEntryId && String(activeReadEntryId) === String(entryId)) {
        closeEntryReader();
        return;
    }

    renderThreads();
}

function openGlobalGalleryPane() {
    activeGlobalGalleryMode = true;
    activeDraftsMode = false;
    activeComposerContext = null;
    activeGalleryContext = null;
    activeReadEntryId = null;
    document.body.classList.remove('compose-mode');
    document.body.classList.remove('gallery-mode');
    document.body.classList.remove('read-mode');
    setNavMode('gallery');
    renderThreads();
}

function openDraftsPane() {
    if (!ensureManualAuth('abrir borradores')) {
        return;
    }

    activeGlobalGalleryMode = false;
    activeDraftsMode = true;
    activeComposerContext = null;
    activeGalleryContext = null;
    activeReadEntryId = null;
    document.body.classList.remove('compose-mode');
    document.body.classList.remove('gallery-mode');
    document.body.classList.remove('read-mode');
    document.body.classList.remove('global-gallery-mode');
    setNavMode('drafts');
    renderThreads();
    void syncEntryDraftsFromSupabase({ render: true });
}

function getVisibleDraftEntries() {
    const ownerName = getDraftOwnerName();
    const ownerKey = getDraftOwnerKey();
    const entries = [];

    entryDraftsBySpot.forEach((draft, draftKey) => {
        if (!draft || !draftKey) return;
        const draftOwnerKey = String(draft.ownerKey || '');
        const draftOwnerName = normalizeManualUserName(draft.owner) || 'Anonimo';
        if (draftOwnerKey !== ownerKey && draftOwnerName !== ownerName) {
            return;
        }
        const plainText = getPlainTextFromHtml(String(draft.content || ''));
        entries.push({
            key: String(draftKey),
            title: String(draft.title || '').trim() || `Borrador en ${draft.spotName || 'Spot'}`,
            spotName: String(draft.spotName || 'Spot'),
            updatedAt: draft.updatedAt || new Date().toISOString(),
            excerpt: plainText.slice(0, 180),
            mode: draft.mode === 'edit' ? 'edit' : 'compose',
            entryId: draft.entryId ? String(draft.entryId) : null,
            spotKey: String(draft.spotKey || 'draft')
        });
    });

    entries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return entries;
}

function renderDraftsPane(feedContent) {
    const drafts = getVisibleDraftEntries();

    feedContent.innerHTML = `
        <section class="drafts-panel" aria-label="Borradores guardados">
            <header class="gallery-head">
                <div>
                    <p class="gallery-kicker">Borradores</p>
                    <p class="gallery-count">${drafts.length} borrador${drafts.length === 1 ? '' : 'es'}</p>
                </div>
            </header>
            <div class="home-entries-feed">
                ${drafts.length
                    ? drafts.map((draft) => `
                        <article class="home-entry-card" data-open-draft-key="${escapeHtml(draft.key)}">
                            <div class="home-entry-meta">
                                <span>${escapeHtml(draft.spotName)}</span>
                                <span>${formatEntryDate(draft.updatedAt)}</span>
                            </div>
                            <h4>${escapeHtml(draft.title)}</h4>
                            <p>${escapeHtml(draft.excerpt)}${draft.excerpt.length >= 180 ? '...' : ''}</p>
                        </article>
                    `).join('')
                    : `
                        <article class="home-entry-empty">
                            <h4>No tienes borradores</h4>
                            <p>Guarda una entrada como borrador y aparecera aqui.</p>
                        </article>
                    `
                }
            </div>
        </section>
    `;

    Array.from(feedContent.querySelectorAll('[data-open-draft-key]')).forEach((card) => {
        card.addEventListener('click', function() {
            const draftKey = card.dataset.openDraftKey;
            if (!draftKey) return;
            const draft = entryDraftsBySpot.get(draftKey);
            if (!draft) return;
            const context = {
                spotKey: String(draft.spotKey || 'draft'),
                spotName: String(draft.spotName || 'Spot'),
                draftKey: String(draftKey)
            };
            if (draft.mode === 'edit' && draft.entryId) {
                context.mode = 'edit';
                context.entryId = String(draft.entryId);
            }
            openEntryComposer(context);
        });
    });
}

function renderGlobalGalleryPane(feedContent) {
    const canUpload = isManualAuthenticated();

    feedContent.innerHTML =         `
        <section class="gallery-panel global-gallery-panel" aria-label="Galeria general">
            <header class="gallery-head">
                <div>
                    <p class="gallery-kicker">Galeria</p>
                    <p class="gallery-count">${globalGalleryPhotos.length} foto${globalGalleryPhotos.length === 1 ? '' : 's'}</p>
                </div>
                <div class="gallery-head-actions">
                    <button class="primary-btn" type="button" id="addGlobalGalleryPhotoBtn" ${canUpload ? '' : 'disabled'} title="${canUpload ? 'Agregar fotos' : 'Inicia sesion para agregar fotos'}">Agregar fotos</button>
                    <input id="globalGalleryPhotoInput" type="file" accept="image/*" multiple hidden>
                </div>
            </header>

            <div class="gallery-feed gallery-view-pinterest">
                ${globalGalleryPhotos.length
                    ? globalGalleryPhotos.map((photo) => {
                        const isEditing = isInlinePhotoEditing('global', null, photo.id);
                        const editName = isEditing ? activeInlinePhotoEdit.name : String(photo.name || 'Foto');
                        const editDescription = isEditing ? activeInlinePhotoEdit.description : String(photo.description || '');
                        return `
                        <article class="gallery-item ${isEditing ? 'is-inline-editing' : ''}" data-global-photo-id="${photo.id}">
                            <img src="${photo.src}" alt="${escapeHtml(photo.name || 'Foto de galeria')}">
                            <div class="gallery-item-meta">
                                ${isEditing ? `
                                    <div class="gallery-inline-edit">
                                        <input
                                            type="text"
                                            class="gallery-inline-input"
                                            data-inline-global-name="${photo.id}"
                                            maxlength="80"
                                            value="${escapeHtml(editName)}"
                                            placeholder="Nombre de la foto"
                                        >
                                        <textarea
                                            class="gallery-inline-textarea"
                                            data-inline-global-description="${photo.id}"
                                            maxlength="220"
                                            placeholder="Descripcion (opcional)"
                                        >${escapeHtml(editDescription)}</textarea>
                                        <div class="gallery-inline-actions">
                                            <button type="button" class="gallery-inline-save-btn" data-inline-global-save="${photo.id}">Guardar</button>
                                            <button type="button" class="gallery-inline-cancel-btn" data-inline-global-cancel="${photo.id}">Cancelar</button>
                                        </div>
                                    </div>
                                ` : `
                                    <strong>${escapeHtml(photo.name || 'Foto')}</strong>
                                    ${photo.description ? `<p class="gallery-photo-description">${escapeHtml(photo.description)}</p>` : ''}
                                    <span>${escapeHtml(photo.addedAt || '')}</span>
                                `}
                            </div>
                            ${canUpload ? `
                                <div class="gallery-item-controls">
                                    <button type="button" class="gallery-edit-btn" data-edit-global-photo="${photo.id}">${isEditing ? 'Editando' : 'Editar'}</button>
                                    <button type="button" class="gallery-remove-btn" data-remove-global-photo="${photo.id}">Eliminar</button>
                                </div>
                            ` : ''}
                        </article>
                    `;
                    }).join('')
                    : `
                        <div class="gallery-empty">
                            <h4>No hay fotos aun</h4>
                            <p>Publica fotos para construir el muro tipo Pinterest.</p>
                        </div>
                    `
                }
            </div>
        </section>
    `;

    bindGlobalGalleryPaneUi();
    scheduleMasonryLayout(feedContent);
}

function bindGlobalGalleryPaneUi() {
    const addBtn = document.getElementById('addGlobalGalleryPhotoBtn');
    const input = document.getElementById('globalGalleryPhotoInput');

    if (addBtn && input) {
        addBtn.addEventListener('click', function() {
            if (!ensureManualAuth('agregar fotos')) {
                return;
            }
            input.click();
        });
    }

    if (input) {
        input.addEventListener('change', function(event) {
            const files = Array.from(event.target.files || []);
            if (!files.length) return;
            appendPhotosToGlobalGallery(files);
            input.value = '';
        });
    }

    document.querySelectorAll('[data-edit-global-photo]').forEach((button) => {
        button.addEventListener('click', function() {
            if (!ensureManualAuth('editar fotos')) {
                return;
            }
            startInlinePhotoEdit('global', null, button.dataset.editGlobalPhoto);
        });
    });

    document.querySelectorAll('[data-remove-global-photo]').forEach((button) => {
        button.addEventListener('click', function() {
            if (!ensureManualAuth('eliminar fotos')) {
                return;
            }
            removeGlobalGalleryPhoto(button.dataset.removeGlobalPhoto);
        });
    });

    document.querySelectorAll('[data-inline-global-save]').forEach((button) => {
        button.addEventListener('click', function() {
            if (!ensureManualAuth('editar fotos')) {
                return;
            }
            saveInlineGlobalPhotoEdit(button.dataset.inlineGlobalSave);
        });
    });

    document.querySelectorAll('[data-inline-global-cancel]').forEach((button) => {
        button.addEventListener('click', function() {
            cancelInlinePhotoEdit();
        });
    });
}

function appendPhotosToGlobalGallery(files) {
    if (!ensureManualAuth('agregar fotos')) {
        return;
    }

    void uploadGalleryFiles(files, { scope: 'global', spotKey: null }).then((items) => {
        if (!items.length) return;
        globalGalleryPhotos.unshift(...items);
        renderThreads();
    });
}

function isInlinePhotoEditing(scope, spotKey, photoId) {
    if (!activeInlinePhotoEdit) {
        return false;
    }

    return (
        activeInlinePhotoEdit.scope === scope &&
        String(activeInlinePhotoEdit.photoId) === String(photoId) &&
        (scope !== 'spot' || String(activeInlinePhotoEdit.spotKey || '') === String(spotKey || ''))
    );
}

function startInlinePhotoEdit(scope, spotKey, photoId) {
    if (!photoId) return;

    const sourcePhoto = scope === 'global'
        ? globalGalleryPhotos.find((photo) => String(photo.id) === String(photoId))
        : (galleryPhotosBySpot.get(String(spotKey || '')) || []).find((photo) => String(photo.id) === String(photoId));

    if (!sourcePhoto) return;

    activeInlinePhotoEdit = {
        scope,
        spotKey: scope === 'spot' ? String(spotKey || '') : '',
        photoId: String(photoId),
        name: String(sourcePhoto.name || 'Foto'),
        description: String(sourcePhoto.description || '')
    };
    renderThreads();
}

function cancelInlinePhotoEdit() {
    if (!activeInlinePhotoEdit) {
        return;
    }
    activeInlinePhotoEdit = null;
    renderThreads();
}

function saveInlineGlobalPhotoEdit(photoId) {
    if (!photoId) return;
    const card = document.querySelector(`[data-global-photo-id="${photoId}"]`);
    if (!card) return;

    const nameInput = card.querySelector(`[data-inline-global-name="${photoId}"]`);
    const descriptionInput = card.querySelector(`[data-inline-global-description="${photoId}"]`);
    const edited = {
        name: String(nameInput && nameInput.value ? nameInput.value : '').trim() || 'Foto',
        description: String(descriptionInput && descriptionInput.value ? descriptionInput.value : '').trim()
    };
    editGlobalGalleryPhoto(photoId, edited);
}

function saveInlineSpotPhotoEdit(context, photoId) {
    if (!context || !photoId) return;
    const card = document.querySelector(`[data-spot-photo-id="${photoId}"]`);
    if (!card) return;

    const nameInput = card.querySelector(`[data-inline-spot-name="${photoId}"]`);
    const descriptionInput = card.querySelector(`[data-inline-spot-description="${photoId}"]`);
    const edited = {
        name: String(nameInput && nameInput.value ? nameInput.value : '').trim() || 'Foto',
        description: String(descriptionInput && descriptionInput.value ? descriptionInput.value : '').trim()
    };
    editSpotGalleryPhoto(context, photoId, edited);
}

function confirmPhotoDeletion(photoName) {
    const safeName = photoName ? `"${photoName}"` : 'esta foto';
    notify(`Vas a eliminar ${safeName}.`, 'Confirmacion');
    return window.confirm(`Seguro que deseas eliminar ${safeName}? Esta accion no se puede deshacer.`);
}

function editGlobalGalleryPhoto(photoId, edited) {
    if (!photoId || !edited) return;

    const index = globalGalleryPhotos.findIndex((photo) => String(photo.id) === String(photoId));
    if (index < 0) return;

    globalGalleryPhotos[index] = {
        ...globalGalleryPhotos[index],
        ...edited
    };
    const current = globalGalleryPhotos[index];
    if (isBackendReady() && current.persisted) {
        void supabase
            .from(SUPABASE_TABLES.photos)
            .update({
                file_name: current.name,
                description: current.description
            })
            .eq('id', current.id)
            .then(({ error }) => {
                if (error) {
                    logSupabaseError('No se pudo editar metadata de la foto', error);
                }
            });
    }
    cancelInlinePhotoEdit();
}

function removeGlobalGalleryPhoto(photoId) {
    if (!photoId) return;
    const target = globalGalleryPhotos.find((photo) => String(photo.id) === String(photoId));
    if (!confirmPhotoDeletion(target ? target.name : '')) {
        return;
    }
    void deleteGalleryPhoto(target).then((deleted) => {
        if (!deleted) return;
        const next = globalGalleryPhotos.filter((photo) => String(photo.id) !== String(photoId));
        globalGalleryPhotos.length = 0;
        globalGalleryPhotos.push(...next);
        renderThreads();
    });
}

function scheduleMasonryLayout(root) {
    window.requestAnimationFrame(() => {
        applyMasonryLayout(root);
        bindMasonryImageEvents(root);
    });
}

function bindMasonryImageEvents(root) {
    if (!root) return;
    const images = root.querySelectorAll('.gallery-view-pinterest img');
    images.forEach((image) => {
        if (image.complete) return;
        image.addEventListener('load', () => applyMasonryLayout(root), { once: true });
        image.addEventListener('error', () => applyMasonryLayout(root), { once: true });
    });
}

function applyMasonryLayout(root = document) {
    const feeds = root.querySelectorAll('.gallery-view-pinterest');
    feeds.forEach((feed) => {
        const style = window.getComputedStyle(feed);
        const rowHeight = parseFloat(style.getPropertyValue('--masonry-row-height')) || 8;
        const rowGap = parseFloat(style.rowGap || style.gap) || 12;

        const items = feed.querySelectorAll('.gallery-item');
        items.forEach((item) => {
            item.style.gridRowEnd = 'auto';
            const itemHeight = item.getBoundingClientRect().height;
            const span = Math.max(1, Math.ceil((itemHeight + rowGap) / (rowHeight + rowGap)));
            item.style.gridRowEnd = `span ${span}`;
        });
    });
}

function handleMasonryResize() {
    if (masonryResizeTimer) {
        window.clearTimeout(masonryResizeTimer);
    }

    masonryResizeTimer = window.setTimeout(() => {
        applyMasonryLayout(document);
    }, 90);
}

function setNavMode(mode) {
    const home = document.getElementById('navHomeLink');
    const gallery = document.getElementById('navGalleryLink');
    const drafts = document.getElementById('navDraftsLink');
    if (home) home.classList.toggle('active', mode === 'home');
    if (gallery) gallery.classList.toggle('active', mode === 'gallery');
    if (drafts) drafts.classList.toggle('active', mode === 'drafts');
}

function focusEntriesBySpot(spotKey, spotName) {
    activeEntriesSpotFilter = {
        spotKey: String(spotKey || ''),
        spotName: String(spotName || 'Spot')
    };

    activeComposerContext = null;
    activeGalleryContext = null;
    activeReadEntryId = null;
    activeGlobalGalleryMode = false;
    activeDraftsMode = false;

    setNavMode('home');
    renderThreads();
    renderHomeEntriesFeed();

    const section = document.querySelector('.home-entries-section');
    if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function clearEntriesFilter() {
    if (!activeEntriesSpotFilter) return;
    activeEntriesSpotFilter = null;
    renderHomeEntriesFeed();
}

function centerMapOnEntry(entry) {
    if (!map || !entry) return;

    const spot = createdSpotMarkers.get(String(entry.spotKey));
    if (spot && spot.marker) {
        const latlng = spot.marker.getLatLng();
        map.setView([latlng.lat, latlng.lng], 17, {
            animate: true,
            duration: 0.6
        });
        return;
    }

    if (entry.lat && entry.lng) {
        map.setView([entry.lat, entry.lng], 17, {
            animate: true,
            duration: 0.6
        });
    }
}

function renderEntryReaderPane(feedContent, entryId) {
    const entry = publishedEntries.find((item) => String(item.id) === String(entryId));
    if (!entry) {
        activeReadEntryId = null;
        renderThreads();
        return;
    }
    const canManageEntry = isManualAuthenticated();

    feedContent.innerHTML = `
        <article class="entry-reader-panel" aria-label="Lectura de entrada">
            <header class="entry-reader-head">
                <div class="entry-reader-meta">
                    <span>${escapeHtml(entry.spotName)}</span>
                    <span>${formatEntryDate(entry.createdAt)}</span>
                </div>
                <div class="entry-reader-actions">
                    ${canManageEntry ? `
                        <button class="ghost-btn" type="button" id="editEntryBtn">Editar</button>
                        <button class="ghost-btn entry-danger-btn" type="button" id="deleteEntryBtn">Eliminar</button>
                    ` : ''}
                    <button class="ghost-btn" type="button" id="closeEntryReaderBtn">Volver</button>
                </div>
            </header>
            <p class="entry-author">Por ${escapeHtml(entry.createdBy || 'Anonimo')}</p>
            <h2>${escapeHtml(entry.title)}</h2>
            <section class="entry-reader-body">
                ${entry.content}
            </section>
        </article>
    `;

    const closeBtn = document.getElementById('closeEntryReaderBtn');
    const editBtn = document.getElementById('editEntryBtn');
    const deleteBtn = document.getElementById('deleteEntryBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeEntryReader);
    }
    if (editBtn) {
        editBtn.addEventListener('click', function() {
            void editPublishedEntry(entry.id);
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', function() {
            void removePublishedEntry(entry.id);
        });
    }
}

function renderGalleryPane(feedContent, context) {
    const photos = galleryPhotosBySpot.get(context.spotKey) || [];
    const canUpload = isManualAuthenticated();

    feedContent.innerHTML =         `
        <section class="gallery-panel" aria-label="Galeria del spot">
            <header class="gallery-head">
                <div>
                    <p class="gallery-kicker">Galeria</p>
                    <h3>${escapeHtml(context.spotName)}</h3>
                    <p class="gallery-count">${photos.length} foto${photos.length === 1 ? '' : 's'}</p>
                </div>
                <div class="gallery-head-actions">
                    <button class="ghost-btn" type="button" id="closeGalleryBtn">Volver al feed</button>
                    <button class="primary-btn" type="button" id="addGalleryPhotoBtn" ${canUpload ? '' : 'disabled'} title="${canUpload ? 'Agregar fotos' : 'Inicia sesion para agregar fotos'}">Agregar fotos</button>
                    <input id="galleryPhotoInput" type="file" accept="image/*" multiple hidden>
                </div>
            </header>

            <div class="gallery-view-tabs" role="tablist" aria-label="Vistas de galeria">
                <button type="button" class="feed-tab ${context.view === 'pinterest' ? 'active' : ''}" data-gallery-view="pinterest">Pinterest</button>
                <button type="button" class="feed-tab ${context.view === 'grid' ? 'active' : ''}" data-gallery-view="grid">Cuadricula</button>
                <button type="button" class="feed-tab ${context.view === 'list' ? 'active' : ''}" data-gallery-view="list">Lista</button>
            </div>

            <div class="gallery-feed gallery-view-${escapeHtml(context.view || 'pinterest')}">
                ${photos.length
                    ? photos.map((photo) => {
                        const isEditing = isInlinePhotoEditing('spot', context.spotKey, photo.id);
                        const editName = isEditing ? activeInlinePhotoEdit.name : String(photo.name || 'Foto');
                        const editDescription = isEditing ? activeInlinePhotoEdit.description : String(photo.description || '');
                        return `
                        <article class="gallery-item ${isEditing ? 'is-inline-editing' : ''}" data-spot-photo-id="${photo.id}">
                            <img src="${photo.src}" alt="${escapeHtml(photo.name || 'Foto de galeria')}">
                            <div class="gallery-item-meta">
                                ${isEditing ? `
                                    <div class="gallery-inline-edit">
                                        <input
                                            type="text"
                                            class="gallery-inline-input"
                                            data-inline-spot-name="${photo.id}"
                                            maxlength="80"
                                            value="${escapeHtml(editName)}"
                                            placeholder="Nombre de la foto"
                                        >
                                        <textarea
                                            class="gallery-inline-textarea"
                                            data-inline-spot-description="${photo.id}"
                                            maxlength="220"
                                            placeholder="Descripcion (opcional)"
                                        >${escapeHtml(editDescription)}</textarea>
                                        <div class="gallery-inline-actions">
                                            <button type="button" class="gallery-inline-save-btn" data-inline-spot-save="${photo.id}">Guardar</button>
                                            <button type="button" class="gallery-inline-cancel-btn" data-inline-spot-cancel="${photo.id}">Cancelar</button>
                                        </div>
                                    </div>
                                ` : `
                                    <strong>${escapeHtml(photo.name || 'Foto')}</strong>
                                    ${photo.description ? `<p class="gallery-photo-description">${escapeHtml(photo.description)}</p>` : ''}
                                    <span>${escapeHtml(photo.addedAt || '')}</span>
                                `}
                            </div>
                            ${canUpload ? `
                                <div class="gallery-item-controls">
                                    <button type="button" class="gallery-edit-btn" data-edit-spot-photo="${photo.id}">${isEditing ? 'Editando' : 'Editar'}</button>
                                    <button type="button" class="gallery-remove-btn" data-remove-spot-photo="${photo.id}">Eliminar</button>
                                </div>
                            ` : ''}
                        </article>
                    `;
                    }).join('')
                    : `
                        <div class="gallery-empty">
                            <h4>Tu galeria aun esta vacia</h4>
                            <p>Agrega fotos de este spot para construir un feed visual tipo Pinterest.</p>
                        </div>
                    `
                }
            </div>
        </section>
    `;

    bindGalleryPaneUi(context);
    scheduleMasonryLayout(feedContent);
}

function bindGalleryPaneUi(context) {
    const closeBtn = document.getElementById('closeGalleryBtn');
    const addBtn = document.getElementById('addGalleryPhotoBtn');
    const input = document.getElementById('galleryPhotoInput');

    if (closeBtn) {
        closeBtn.addEventListener('click', closeGalleryPane);
    }

    if (addBtn && input) {
        addBtn.addEventListener('click', function() {
            if (!ensureManualAuth('agregar fotos')) {
                return;
            }
            input.click();
        });
    }

    if (input) {
        input.addEventListener('change', function(event) {
            const files = Array.from(event.target.files || []);
            if (!files.length) return;
            appendPhotosToGallery(context, files);
            input.value = '';
        });
    }

    document.querySelectorAll('[data-gallery-view]').forEach((button) => {
        button.addEventListener('click', function() {
            const view = button.dataset.galleryView;
            if (!view) return;
            setGalleryView(view);
        });
    });

    document.querySelectorAll('[data-edit-spot-photo]').forEach((button) => {
        button.addEventListener('click', function() {
            if (!ensureManualAuth('editar fotos')) {
                return;
            }
            startInlinePhotoEdit('spot', context.spotKey, button.dataset.editSpotPhoto);
        });
    });

    document.querySelectorAll('[data-remove-spot-photo]').forEach((button) => {
        button.addEventListener('click', function() {
            if (!ensureManualAuth('eliminar fotos')) {
                return;
            }
            removeSpotGalleryPhoto(context, button.dataset.removeSpotPhoto);
        });
    });

    document.querySelectorAll('[data-inline-spot-save]').forEach((button) => {
        button.addEventListener('click', function() {
            if (!ensureManualAuth('editar fotos')) {
                return;
            }
            saveInlineSpotPhotoEdit(context, button.dataset.inlineSpotSave);
        });
    });

    document.querySelectorAll('[data-inline-spot-cancel]').forEach((button) => {
        button.addEventListener('click', function() {
            cancelInlinePhotoEdit();
        });
    });
}

function setGalleryView(view) {
    if (!activeGalleryContext) return;
    activeGalleryContext.view = view;
    renderThreads();
}

function appendPhotosToGallery(context, files) {
    if (!ensureManualAuth('agregar fotos')) {
        return;
    }

    const spotKey = String(context.spotKey || '');
    void uploadGalleryFiles(files, { scope: 'spot', spotKey }).then((items) => {
        if (!items.length) return;
        const existing = galleryPhotosBySpot.get(spotKey) || [];
        galleryPhotosBySpot.set(spotKey, [...items, ...existing]);
        renderThreads();
    });
}

function editSpotGalleryPhoto(context, photoId, edited) {
    if (!context || !photoId || !edited) return;

    const current = galleryPhotosBySpot.get(context.spotKey) || [];
    const index = current.findIndex((photo) => String(photo.id) === String(photoId));
    if (index < 0) return;

    const next = [...current];
    next[index] = {
        ...next[index],
        ...edited
    };
    galleryPhotosBySpot.set(context.spotKey, next);
    const updated = next[index];
    if (isBackendReady() && updated.persisted) {
        void supabase
            .from(SUPABASE_TABLES.photos)
            .update({
                file_name: updated.name,
                description: updated.description
            })
            .eq('id', updated.id)
            .then(({ error }) => {
                if (error) {
                    logSupabaseError('No se pudo editar metadata de la foto', error);
                }
            });
    }
    cancelInlinePhotoEdit();
}

function removeSpotGalleryPhoto(context, photoId) {
    if (!context || !photoId) return;

    const current = galleryPhotosBySpot.get(context.spotKey) || [];
    const target = current.find((photo) => String(photo.id) === String(photoId));
    if (!confirmPhotoDeletion(target ? target.name : '')) {
        return;
    }

    void deleteGalleryPhoto(target).then((deleted) => {
        if (!deleted) return;
        const next = current.filter((photo) => String(photo.id) !== String(photoId));
        galleryPhotosBySpot.set(context.spotKey, next);
        renderThreads();
    });
}

function getEntryDraftKey(context, ownerKey = getDraftOwnerKey()) {
    if (context && context.draftKey) {
        return String(context.draftKey);
    }
    if (context && context.mode === 'edit' && context.entryId) {
        return `${ownerKey}::entry:${String(context.entryId)}`;
    }
    return `${ownerKey}::spot:${String(context && context.spotKey ? context.spotKey : 'draft')}`;
}

function getInitialEntryDraft(context) {
    if (context && context.forceNew) {
        return {
            title: '',
            content: ''
        };
    }

    const draftKey = getEntryDraftKey(context);
    const savedDraft = entryDraftsBySpot.get(draftKey);
    if (savedDraft) {
        return savedDraft;
    }

    const legacyDraftKey = context && context.spotKey ? String(context.spotKey) : '';
    const legacyDraft = legacyDraftKey ? entryDraftsBySpot.get(legacyDraftKey) : null;
    if (legacyDraft) {
        return legacyDraft;
    }

    if (context && context.mode === 'edit' && context.entryId) {
        const existingEntry = publishedEntries.find((item) => String(item.id) === String(context.entryId));
        if (existingEntry) {
            return {
                title: existingEntry.title || '',
                content: existingEntry.content || ''
            };
        }
    }

    return {
        title: '',
        content: ''
    };
}
function renderEntryComposer(feedContent, context) {
    const isEditingEntry = Boolean(context && context.mode === 'edit' && context.entryId);
    const draft = getInitialEntryDraft(context);
    const canPublish = isManualAuthenticated();
    const canSaveDraft = isManualAuthenticated();
    const closeLabel = isEditingEntry ? 'Cancelar edicion' : 'Descartar entrada';
    const publishLabel = isEditingEntry ? 'Guardar cambios' : 'Publicar';
    const publishTitle = canPublish
        ? publishLabel
        : `Inicia sesion para ${isEditingEntry ? 'editar' : 'publicar'}`;
    const panelAria = isEditingEntry ? 'Editor de entrada' : 'Editor de nueva entrada';

    feedContent.innerHTML = `
        <section class="entry-editor-panel" aria-label="${panelAria}">
            <header class="entry-editor-head">
                <div>
                    <h3>${context.spotName}</h3>
                </div>
                <div class="entry-editor-actions">
                    <button class="ghost-btn" type="button" id="closeComposerBtn">${closeLabel}</button>
                    <button class="ghost-btn" type="button" id="saveDraftBtn" ${canSaveDraft ? '' : 'disabled'} title="${canSaveDraft ? 'Guardar borrador' : 'Inicia sesion para guardar borradores'}">Guardar borrador</button>
                    <button class="primary-btn" type="button" id="publishEntryBtn" ${canPublish ? '' : 'disabled'} title="${publishTitle}">${publishLabel}</button>
                </div>
            </header>

            <div class="doc-toolbar" role="toolbar" aria-label="Formato del texto">
                <div class="doc-tool-group" aria-label="Formato">
                    <button type="button" class="doc-tool" data-command="bold"><strong>B</strong></button>
                    <button type="button" class="doc-tool" data-command="italic"><em>I</em></button>
                    <button type="button" class="doc-tool" data-command="underline"><u>U</u></button>
                    <label class="doc-color-control" title="Color de texto">
                        <span>A</span>
                        <input type="color" id="textColorPicker" value="#171717" aria-label="Color de texto">
                    </label>
                    <label class="doc-color-control" title="Resaltado">
                        <span>Res</span>
                        <input type="color" id="highlightColorPicker" value="#fff2a8" aria-label="Color de resaltado">
                    </label>
                </div>

                <div class="doc-tool-group" aria-label="Bloques">
                    <select class="doc-select" id="fontSizeSelect" aria-label="Tamano de fuente">
                        <option value="2">12px</option>
                        <option value="3" selected>16px</option>
                        <option value="4">18px</option>
                        <option value="5">24px</option>
                        <option value="6">32px</option>
                    </select>
                    <button type="button" class="doc-tool" data-command="formatBlock" data-value="blockquote">"</button>
                    <button type="button" class="doc-tool" data-command="insertUnorderedList">Lista</button>
                    <button type="button" class="doc-tool" data-command="insertOrderedList">1.</button>
                </div>

                <div class="doc-tool-group" aria-label="Alineacion">
                    <button type="button" class="doc-tool" data-command="justifyLeft" title="Alinear izquierda">Izq</button>
                    <button type="button" class="doc-tool" data-command="justifyCenter" title="Alinear centro">Ctr</button>
                    <button type="button" class="doc-tool" data-command="justifyRight" title="Alinear derecha">Der</button>
                    <button type="button" class="doc-tool" data-command="justifyFull" title="Justificar">Jst</button>
                </div>

                <div class="doc-tool-group" aria-label="Inserciones">
                    <button type="button" class="doc-tool" data-action="checklist">Checklist</button>
                    <button type="button" class="doc-tool" data-command="createLink" data-needs-url="true">Link</button>
                    <button type="button" class="doc-tool" data-action="insert-image">Imagen</button>
                    <button type="button" class="doc-tool" data-action="insert-table">Tabla</button>
                    <button type="button" class="doc-tool" data-command="insertHorizontalRule">---</button>
                </div>

            </div>

            <div class="doc-workspace">
                <input
                    class="doc-title-input"
                    id="entryTitleInput"
                    type="text"
                    maxlength="120"
                    placeholder="Titulo de la entrada"
                    value="${escapeHtml(draft.title)}"
                >
                <article
                    class="doc-sheet"
                    id="entryBodyEditor"
                    contenteditable="true"
                    spellcheck="true"
                    aria-label="Contenido de la entrada"
                >${draft.content || ''}</article>
                <div class="doc-word-count" id="docWordCount">0 palabras | 0 caracteres</div>
            </div>
        </section>
    `;

    bindEntryComposerUi(context);
}

function bindEntryComposerUi(context) {
    const isEditingEntry = Boolean(context && context.mode === 'edit' && context.entryId);
    const draftKey = getEntryDraftKey(context);
    const closeBtn = document.getElementById('closeComposerBtn');
    const saveDraftBtn = document.getElementById('saveDraftBtn');
    const publishBtn = document.getElementById('publishEntryBtn');
    const titleInput = document.getElementById('entryTitleInput');
    const editor = document.getElementById('entryBodyEditor');
    const toolbar = document.querySelector('.doc-toolbar');
    const wordCountNode = document.getElementById('docWordCount');
    const fontSizeSelect = document.getElementById('fontSizeSelect');
    const textColorPicker = document.getElementById('textColorPicker');
    const highlightColorPicker = document.getElementById('highlightColorPicker');

    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            void removeEntryDraft(context, draftKey);
            if (isEditingEntry) {
                openEntryReader(context.entryId);
                return;
            }
            closeEntryComposer();
        });
    }

    if (saveDraftBtn) {
        saveDraftBtn.addEventListener('click', async function() {
            if (!ensureManualAuth('guardar borradores')) {
                return;
            }
            saveDraftBtn.disabled = true;
            saveDraftBtn.textContent = 'Guardando...';
            const saved = await saveEntryDraft(context, titleInput, editor);
            saveDraftBtn.disabled = false;
            saveDraftBtn.textContent = saved.persistedRemotely ? 'Guardado' : 'Guardado local';
            if (isEditingEntry) {
                openEntryReader(context.entryId);
                return;
            }
            closeEntryComposer();
        });
    }

    if (publishBtn) {
        publishBtn.addEventListener('click', async function() {
            const featureLabel = isEditingEntry ? 'editar entradas' : 'publicar entradas';
            if (!ensureManualAuth(featureLabel)) {
                return;
            }
            const idleLabel = isEditingEntry ? 'Guardar cambios' : 'Publicar';
            const pendingLabel = isEditingEntry ? 'Guardando...' : 'Publicando...';
            publishBtn.disabled = true;
            publishBtn.textContent = pendingLabel;
            const published = await publishEntry(context, titleInput, editor);
            publishBtn.disabled = false;
            publishBtn.textContent = idleLabel;
            if (!published) {
                return;
            }
            await removeEntryDraft(context, draftKey);
            if (isEditingEntry) {
                openEntryReader(context.entryId);
                return;
            }
            closeEntryComposer();
        });
    }

    if (fontSizeSelect && editor) {
        fontSizeSelect.addEventListener('change', function() {
            editor.focus();
            document.execCommand('fontSize', false, fontSizeSelect.value);
            refreshToolbarState(editor, toolbar, fontSizeSelect);
        });
    }

    if (textColorPicker && editor) {
        textColorPicker.addEventListener('input', function() {
            editor.focus();
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('foreColor', false, textColorPicker.value);
            refreshToolbarState(editor, toolbar, fontSizeSelect);
        });
    }

    if (highlightColorPicker && editor) {
        highlightColorPicker.addEventListener('input', function() {
            editor.focus();
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('hiliteColor', false, highlightColorPicker.value);
            refreshToolbarState(editor, toolbar, fontSizeSelect);
        });
    }

    if (toolbar && editor) {
        toolbar.addEventListener('click', function(event) {
            const button = event.target.closest('[data-command]');
            const actionButton = event.target.closest('[data-action]');

            if (actionButton) {
                const action = actionButton.dataset.action;
                editor.focus();

                if (action === 'checklist') {
                    insertChecklist(editor);
                } else if (action === 'insert-image') {
                    const imageUrl = window.prompt('Pega la URL de la imagen');
                    if (imageUrl) {
                        document.execCommand('insertImage', false, imageUrl.trim());
                    }
                } else if (action === 'insert-table') {
                    insertSimpleTable(editor);
                }

                refreshToolbarState(editor, toolbar, fontSizeSelect);
                updateWordCount(editor, wordCountNode);
                return;
            }

            if (!button) return;

            const command = button.dataset.command;
            const value = button.dataset.value || null;
            editor.focus();

            if (button.dataset.needsUrl === 'true') {
                const url = window.prompt('Pega la URL del enlace');
                if (url) {
                    document.execCommand(command, false, url.trim());
                }
                refreshToolbarState(editor, toolbar, fontSizeSelect);
                return;
            }

            document.execCommand(command, false, value);
            refreshToolbarState(editor, toolbar, fontSizeSelect);
            updateWordCount(editor, wordCountNode);
        });
    }

    if (editor) {
        editor.addEventListener('input', function() {
            updateWordCount(editor, wordCountNode);
            refreshToolbarState(editor, toolbar, fontSizeSelect);
        });

        editor.addEventListener('keyup', function() {
            refreshToolbarState(editor, toolbar, fontSizeSelect);
        });

        editor.addEventListener('mouseup', function() {
            refreshToolbarState(editor, toolbar, fontSizeSelect);
        });
    }

    updateWordCount(editor, wordCountNode);
    refreshToolbarState(editor, toolbar, fontSizeSelect);
}

async function saveEntryDraft(context, titleInput, editor) {
    if (!context || !titleInput || !editor) {
        return {
            persistedRemotely: false
        };
    }
    if (!isManualAuthenticated()) {
        return {
            persistedRemotely: false
        };
    }
    const draftKey = getEntryDraftKey(context);

    const draftValue = {
        title: titleInput.value.trim(),
        content: editor.innerHTML.trim(),
        spotKey: String(context.spotKey || 'draft'),
        spotName: String(context.spotName || 'Spot'),
        owner: getDraftOwnerName(),
        ownerKey: getDraftOwnerKey(),
        mode: context.mode === 'edit' ? 'edit' : 'compose',
        entryId: context.entryId ? String(context.entryId) : null,
        updatedAt: new Date().toISOString()
    };
    entryDraftsBySpot.set(draftKey, draftValue);
    persistEntryDraftsToStorage();
    const persistedRemotely = await upsertEntryDraftToSupabase(draftKey, draftValue);
    if (activeDraftsMode) {
        renderThreads();
    }
    return {
        persistedRemotely
    };
}

async function removeEntryDraft(context, draftKey = getEntryDraftKey(context)) {
    const existingDraft = entryDraftsBySpot.get(draftKey);
    entryDraftsBySpot.delete(draftKey);
    persistEntryDraftsToStorage();

    const ownerKey = existingDraft && existingDraft.ownerKey
        ? String(existingDraft.ownerKey)
        : getDraftOwnerKey();
    await deleteEntryDraftFromSupabase(draftKey, ownerKey);
}

async function publishEntry(context, titleInput, editor) {
    if (!context || !titleInput || !editor) return false;
    const isEditingEntry = Boolean(context.mode === 'edit' && context.entryId);
    const featureLabel = isEditingEntry ? 'editar entradas' : 'publicar entradas';
    if (!ensureManualAuth(featureLabel)) {
        return false;
    }

    const title = titleInput.value.trim() || `Entrada en ${context.spotName}`;
    const html = editor.innerHTML.trim();
    const plainText = getPlainTextFromHtml(html);
    const excerpt = plainText.slice(0, 180);

    if (!plainText) {
        return false;
    }

    if (isEditingEntry) {
        const entryIndex = publishedEntries.findIndex((item) => String(item.id) === String(context.entryId));
        if (entryIndex < 0) {
            notify('No se encontro la entrada para editar.', 'Edicion');
            return false;
        }

        const currentEntry = publishedEntries[entryIndex];
        if (isBackendReady() && isPersistedEntry(currentEntry)) {
            const { error } = await supabase
                .from(SUPABASE_TABLES.entries)
                .update({
                    title,
                    excerpt,
                    content_html: html
                })
                .eq('id', currentEntry.id);

            if (error) {
                logSupabaseError('No se pudo editar la entrada', error);
                notify('No se pudo guardar la edicion en Supabase.', 'Error al guardar');
                return false;
            }
        }

        publishedEntries[entryIndex] = {
            ...currentEntry,
            title,
            excerpt,
            content: html
        };
        renderHomeEntriesFeed();
        return true;
    }

    const fallbackEntry = {
        id: nextLocalEntryKey(),
        spotKey: context.spotKey,
        spotName: context.spotName,
        title,
        createdById: currentSessionUserId || null,
        createdBy: currentManualUser || 'Anonimo',
        excerpt,
        content: html,
        createdAt: new Date()
    };
    let entryForFeed = fallbackEntry;

    if (isBackendReady() && isPersistedSpot(context.spotKey)) {
        const createdBy = await getCurrentUserId();
        const { data, error } = await supabase
            .from(SUPABASE_TABLES.entries)
            .insert({
                spot_id: context.spotKey,
                spot_name: context.spotName,
                title,
                excerpt,
                content_html: html,
                created_by: createdBy || null
            })
            .select('id, spot_id, spot_name, title, excerpt, content_html, created_at, created_by')
            .single();

        if (error) {
            logSupabaseError('No se pudo publicar la entrada', error);
        } else {
            entryForFeed = mapEntryRecordToViewModel(data, fallbackEntry);
        }
    }

    publishedEntries.unshift(entryForFeed);
    renderHomeEntriesFeed();
    return true;
}

function renderHomeEntriesFeed() {
    const container = document.getElementById('homeEntriesFeed');
    const counter = document.getElementById('homeEntriesCount');
    const searchInput = document.getElementById('entriesSearchInput');
    if (!container) return;
    if (searchInput && searchInput.value !== activeEntriesSearchQuery) {
        searchInput.value = activeEntriesSearchQuery;
    }

    const filteredBySpot = activeEntriesSpotFilter
        ? publishedEntries.filter((entry) => String(entry.spotKey) === activeEntriesSpotFilter.spotKey)
        : publishedEntries;
    const normalizedQuery = String(activeEntriesSearchQuery || '').trim().toLowerCase();
    const filteredEntries = normalizedQuery
        ? filteredBySpot.filter((entry) => {
            const haystack = [
                entry.title,
                entry.excerpt,
                entry.spotName,
                entry.createdBy
            ].map((value) => String(value || '').toLowerCase()).join(' ');
            return haystack.includes(normalizedQuery);
        })
        : filteredBySpot;

    if (counter) {
        counter.textContent = (activeEntriesSpotFilter || normalizedQuery)
            ? `${filteredEntries.length} de ${publishedEntries.length} publicadas`
            : `${publishedEntries.length} publicadas`;
    }

    const filterBanner = activeEntriesSpotFilter
        ? `
            <article class="home-entries-filter">
                <p>Mostrando entradas de: <strong>${escapeHtml(activeEntriesSpotFilter.spotName)}</strong></p>
                <button class="ghost-btn" type="button" id="clearEntriesFilterBtn">Mostrar todas</button>
            </article>
        `
        : ''

    if (!filteredEntries.length) {
        container.innerHTML = `
            ${filterBanner}
            <article class="home-entry-empty">
                <h4>${activeEntriesSpotFilter || normalizedQuery ? 'No hay coincidencias' : 'Aun no hay entradas publicadas'}</h4>
                <p>${activeEntriesSpotFilter || normalizedQuery ? 'Prueba con otro termino o quita los filtros para ver mas entradas.' : 'Publica tu primera historia y aparecera aqui, con lo mas reciente siempre arriba.'}</p>
            </article>
        `;

        const clearFilterBtn = document.getElementById('clearEntriesFilterBtn');
        if (clearFilterBtn) {
            clearFilterBtn.addEventListener('click', clearEntriesFilter);
        }
        return;
    }

    container.innerHTML = `
        ${filterBanner}
        ${filteredEntries.map((entry) => `
            <article class="home-entry-card" data-published-entry-id="${entry.id}">
                <div class="home-entry-meta">
                    <span>${escapeHtml(entry.spotName)}</span>
                    <span>${formatEntryDate(entry.createdAt)}</span>
                </div>
                <p class="entry-author">Por ${escapeHtml(entry.createdBy || 'Anonimo')}</p>
                <h4>${escapeHtml(entry.title)}</h4>
                <p>${escapeHtml(entry.excerpt)}${entry.excerpt.length >= 180 ? '...' : ''}</p>
            </article>
        `).join('')}
    `;

    const clearFilterBtn = document.getElementById('clearEntriesFilterBtn');
    if (clearFilterBtn) {
        clearFilterBtn.addEventListener('click', clearEntriesFilter);
    }

    Array.from(container.querySelectorAll('.home-entry-card')).forEach((card) => {
        card.addEventListener('click', function() {
            const entryId = card.dataset.publishedEntryId;
            if (!entryId) return;
            openEntryReader(entryId);
        });
    });
}

function getPlainTextFromHtml(html) {
    if (!html) return '';
    const helper = document.createElement('div');
    helper.innerHTML = html;
    return (helper.textContent || helper.innerText || '').trim();
}

function formatEntryDate(dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    return date.toLocaleString('es-CO', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function insertChecklist(editor) {
    if (!editor) return;

    const checklistHtml = `
        <ul class="doc-checklist">
            <li><label><input type="checkbox"> <span>Elemento</span></label></li>
            <li><label><input type="checkbox"> <span>Elemento</span></label></li>
        </ul>
    `;

    document.execCommand('insertHTML', false, checklistHtml);
}

function insertSimpleTable(editor) {
    if (!editor) return;

    const rows = Number(window.prompt('Numero de filas (1-8)', '2'));
    const cols = Number(window.prompt('Numero de columnas (1-8)', '2'));

    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 8 || cols > 8) {
        return;
    }

    const bodyRows = Array.from({ length: rows }, () => {
        const cells = Array.from({ length: cols }, () => '<td>Celda</td>').join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    const tableHtml = `<table class="doc-table"><tbody>${bodyRows}</tbody></table><p></p>`;
    document.execCommand('insertHTML', false, tableHtml);
}

function updateWordCount(editor, wordCountNode) {
    if (!editor || !wordCountNode) return;

    const text = editor.innerText || '';
    const normalized = text.trim();
    const words = normalized.match(/\S+/g);
    const wordCount = words ? words.length : 0;
    const charCount = normalized.length;
    wordCountNode.textContent = `${wordCount} palabra${wordCount === 1 ? '' : 's'} | ${charCount} caracter${charCount === 1 ? '' : 'es'}`;
}

function refreshToolbarState(editor, toolbar, fontSizeSelect) {
    if (!editor || !toolbar) return;

    const toggleCommands = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'];
    toggleCommands.forEach((command) => {
        const button = toolbar.querySelector(`[data-command="${command}"]`);
        if (!button) return;
        const isActive = document.queryCommandState(command);
        button.classList.toggle('is-active', Boolean(isActive));
    });

    if (fontSizeSelect) {
        const currentFontSize = normalizeFontSizeValue(document.queryCommandValue('fontSize'));
        if (currentFontSize) {
            fontSizeSelect.value = currentFontSize;
        }
    }
}

function normalizeFontSizeValue(rawValue) {
    const normalized = String(rawValue || '').trim();
    if (['1', '2', '3', '4', '5', '6', '7'].includes(normalized)) {
        return normalized;
    }
    return '3';
}

function normalizeBlockValue(rawValue) {
    if (!rawValue) return 'p';
    const normalized = String(rawValue).replace(/[<>]/g, '').toLowerCase();
    if (['p', 'h1', 'h2', 'h3', 'blockquote'].includes(normalized)) {
        return normalized;
    }
    return 'p';
}

function captureCurrentFormat(editor) {
    if (!editor) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }

    const anchorNode = selection.anchorNode;
    const anchorElement = anchorNode && anchorNode.nodeType === Node.ELEMENT_NODE
        ? anchorNode
        : anchorNode ? anchorNode.parentElement : null;
    const computed = anchorElement ? window.getComputedStyle(anchorElement) : null;

    return {
        block: normalizeBlockValue(document.queryCommandValue('formatBlock')),
        bold: Boolean(document.queryCommandState('bold')),
        italic: Boolean(document.queryCommandState('italic')),
        underline: Boolean(document.queryCommandState('underline')),
        align: getCurrentAlignment(),
        color: computed ? computed.color : null,
        background: computed ? computed.backgroundColor : null
    };
}

function getCurrentAlignment() {
    if (document.queryCommandState('justifyCenter')) return 'justifyCenter';
    if (document.queryCommandState('justifyRight')) return 'justifyRight';
    if (document.queryCommandState('justifyFull')) return 'justifyFull';
    return 'justifyLeft';
}

function applyFormatState(formatState) {
    if (!formatState) return;

    document.execCommand('removeFormat', false);

    if (formatState.block) {
        document.execCommand('formatBlock', false, formatState.block);
    }

    if (formatState.align) {
        document.execCommand(formatState.align, false);
    }

    if (formatState.bold) document.execCommand('bold', false);
    if (formatState.italic) document.execCommand('italic', false);
    if (formatState.underline) document.execCommand('underline', false);

    document.execCommand('styleWithCSS', false, true);
    if (formatState.color) {
        document.execCommand('foreColor', false, formatState.color);
    }
    if (formatState.background && formatState.background !== 'rgba(0, 0, 0, 0)' && formatState.background !== 'transparent') {
        document.execCommand('hiliteColor', false, formatState.background);
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderThreadDetail(threadId) {
    const detail = document.getElementById('threadDetail');
    if (!detail) return;
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    const category = CATEGORY_META[thread.category];

    detail.innerHTML = `
        <div class="detail-header">
            <span class="thread-tag ${category.className}">${category.label}</span>
            <span class="detail-status">${thread.status}</span>
        </div>
        <h3>${thread.title}</h3>
        <p class="detail-tone">${thread.tone}</p>
        <div class="detail-grid">
            <div>
                <span>Lugar</span>
                <strong>${thread.area}</strong>
            </div>
            <div>
                <span>Fecha</span>
                <strong>${thread.time}</strong>
            </div>
            <div>
                <span>Autor</span>
                <strong>${thread.author}</strong>
            </div>
            <div>
                <span>Lectura</span>
                <strong>${thread.reactions} vistas</strong>
            </div>
        </div>
        <div class="comment-preview">
            ${thread.comments.map((comment) => `<p>${comment}</p>`).join('')}
        </div>
        <div class="detail-actions">
            <button class="primary-btn" type="button">Leer entrada</button>
            <button class="ghost-btn" type="button">Copiar ubicacion</button>
        </div>
    `;
}

function renderMarkers() {
    markers.forEach((marker) => map.removeLayer(marker));
    markers = [];

    threads.forEach((thread) => {
        const category = CATEGORY_META[thread.category];
        const marker = L.marker([thread.lat, thread.lng], {
            icon: L.divIcon({
                className: 'forum-marker-wrapper',
                html: `<button class="forum-marker ${category.className}" aria-label="${thread.title}"></button>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                popupAnchor: [0, -14]
            })
        })
            .bindPopup(
                `<strong>${thread.title}</strong><br>${thread.area} Â· ${category.label}`,
                { className: 'artist-popup', maxWidth: 260 }
            )
            .addTo(map);

        marker.on('click', () => {
            focusThread(thread.id);
        });

        markers.push(marker);
    });
}

function focusThread(threadId) {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread) return;
    activeThreadId = threadId;
    renderThreads();
    renderThreadDetail(threadId);

    map.setView([thread.lat, thread.lng], 14, {
        animate: true,
        duration: 0.7
    });

    const activeCard = document.querySelector(`[data-thread-id="${threadId}"]`);
    if (activeCard) {
        activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

window.addEventListener('DOMContentLoaded', initMap);








