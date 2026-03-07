import { db } from './firebase-config.js';

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

let map;
let markers = [];
let activeThreadId = null;
let draftLocationMarker;
let draftDragState = null;
let isDraftPlacementMode = false;
let pendingDraftLatLng = null;
let draftSpotName = '';
let nextCreatedSpotId = 1;
const createdSpotMarkers = new Map();
let pendingRenameSpotId = null;
let pendingConfirmAction = null;
let activeComposerContext = null;
let activeGalleryContext = null;
const entryDraftsBySpot = new Map();
const galleryPhotosBySpot = new Map();
const publishedEntries = [];
let nextPublishedEntryId = 1;

// Keep the Firestore instance reachable for the next persistence step.
window.projectDb = db;

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

    renderCategories();
    renderThreads();
    renderMarkers();
    renderThreadDetail(activeThreadId);
    renderHomeEntriesFeed();
    bindStaticUi();
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
    const toggleAuthPassword = document.getElementById('toggleAuthPassword');

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
            setDraftPlacementMode(!isDraftPlacementMode);
        });
    }

    if (loginLauncher) {
        loginLauncher.addEventListener('click', openAuthModal);
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
            if (pendingConfirmAction) {
                pendingConfirmAction();
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

    if (toggleAuthPassword) {
        toggleAuthPassword.addEventListener('click', toggleAuthPasswordVisibility);
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
                        <span class="draft-action-icon" aria-hidden="true">✎</span>
                    </button>
                    <button type="button" class="draft-location-action" data-draft-action="entries">Entradas</button>
                    <button type="button" class="draft-location-action" data-draft-action="gallery">Galeria</button>
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
                        <span class="draft-action-icon" aria-hidden="true">✎</span>
                    </button>
                    <button type="button" class="draft-location-action" data-created-action="entries" data-spot-id="${spotId}">Entradas</button>
                    <button type="button" class="draft-location-action" data-created-action="gallery" data-spot-id="${spotId}">Galeria</button>
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

function handleSpotModalSubmit(event) {
    event.preventDefault();

    const input = document.getElementById('spotNameInput');
    if (!input || !pendingDraftLatLng) return;

    const value = input.value.trim();
    draftSpotName = value || 'Nuevo spot';

    if (pendingRenameSpotId) {
        renameCreatedSpot(pendingRenameSpotId, draftSpotName);
        updateComposerLocation(pendingDraftLatLng, `Spot renombrado: ${draftSpotName}`);
        closeSpotModal({ preserveMarker: true });
        return;
    }

    if (!draftLocationMarker) {
        placeDraftLocationMarker(pendingDraftLatLng);
    }

    finalizeDraftSpot();
    updateComposerLocation(pendingDraftLatLng, `Spot: ${draftSpotName}`);
    closeSpotModal({ preserveMarker: true });
}

function finalizeDraftSpot() {
    if (!draftLocationMarker) {
        return;
    }

    const spotId = String(nextCreatedSpotId++);
    const spotName = draftSpotName || 'Nuevo spot';

    draftLocationMarker.setIcon(createSavedSpotIcon(spotName, spotId));
    createdSpotMarkers.set(spotId, {
        marker: draftLocationMarker,
        name: spotName
    });

    bindCreatedSpotActions(draftLocationMarker, spotId);
    draftLocationMarker = null;
    draftSpotName = '';
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
            latlng
        });
        updateComposerLocation(latlng, 'Nueva entrada en');
        closeAllSpotMenus();
        return;
    }

    if (action === 'entries') {
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
            latlng
        });
        updateComposerLocation(latlng, `Nueva entrada en ${name}`);
        closeAllSpotMenus();
        return;
    }

    if (action === 'entries') {
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
                map.removeLayer(marker);
                createdSpotMarkers.delete(spotId);
                closeAllSpotMenus();
            }
        );
    }
}

function renameCreatedSpot(spotId, nextName) {
    const createdSpot = createdSpotMarkers.get(spotId);
    if (!createdSpot) {
        return;
    }

    createdSpot.name = nextName;
    createdSpot.marker.setIcon(createSavedSpotIcon(nextName, spotId));
    bindCreatedSpotActions(createdSpot.marker, spotId);
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

function openConfirmModal(message, onConfirm) {
    const overlay = document.getElementById('confirmModalOverlay');
    const copy = document.getElementById('confirmModalCopy');
    if (!overlay || !copy) {
        return;
    }

    copy.textContent = message;
    pendingConfirmAction = onConfirm;
    overlay.hidden = false;
}

function closeConfirmModal() {
    const overlay = document.getElementById('confirmModalOverlay');
    const copy = document.getElementById('confirmModalCopy');
    if (overlay) {
        overlay.hidden = true;
    }
    if (copy) {
        copy.textContent = '';
    }
    pendingConfirmAction = null;
}

function openAuthModal() {
    const overlay = document.getElementById('authModalOverlay');
    const emailInput = document.getElementById('authEmailInput');
    if (!overlay) return;

    overlay.hidden = false;
    window.setTimeout(() => {
        if (emailInput) {
            emailInput.focus();
        }
    }, 0);
}

function closeAuthModal() {
    const overlay = document.getElementById('authModalOverlay');
    const form = document.getElementById('authModalForm');
    const passwordInput = document.getElementById('authPasswordInput');
    const toggleButton = document.getElementById('toggleAuthPassword');
    if (overlay) {
        overlay.hidden = true;
    }
    if (form) {
        form.reset();
    }
    if (passwordInput) {
        passwordInput.type = 'password';
    }
    if (toggleButton) {
        toggleButton.textContent = 'Ver';
        toggleButton.setAttribute('aria-pressed', 'false');
        toggleButton.setAttribute('aria-label', 'Mostrar contraseña');
    }
}

function handleAuthModalSubmit(event) {
    event.preventDefault();
    closeAuthModal();
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
    toggleButton.setAttribute('aria-label', nextVisible ? 'Ocultar contraseña' : 'Mostrar contraseña');
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
        renderEntryComposer(feedContent, activeComposerContext);
        return;
    }

    if (activeGalleryContext) {
        document.body.classList.remove('compose-mode');
        document.body.classList.add('gallery-mode');
        renderGalleryPane(feedContent, activeGalleryContext);
        return;
    }

    document.body.classList.remove('compose-mode');
    document.body.classList.remove('gallery-mode');

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
    activeComposerContext = context;
    activeGalleryContext = null;
    document.body.classList.add('compose-mode');
    document.body.classList.remove('gallery-mode');
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
    document.body.classList.remove('compose-mode');
    document.body.classList.add('gallery-mode');
    renderThreads();

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

function renderGalleryPane(feedContent, context) {
    const photos = galleryPhotosBySpot.get(context.spotKey) || [];

    feedContent.innerHTML = `
        <section class="gallery-panel" aria-label="Galeria del spot">
            <header class="gallery-head">
                <div>
                    <p class="gallery-kicker">Galeria</p>
                    <h3>${escapeHtml(context.spotName)}</h3>
                    <p class="gallery-count">${photos.length} foto${photos.length === 1 ? '' : 's'}</p>
                </div>
                <div class="gallery-head-actions">
                    <button class="ghost-btn" type="button" id="closeGalleryBtn">Volver al feed</button>
                    <button class="primary-btn" type="button" id="addGalleryPhotoBtn">Agregar fotos</button>
                    <input id="galleryPhotoInput" type="file" accept="image/*" multiple hidden>
                </div>
            </header>

            <div class="gallery-view-tabs" role="tablist" aria-label="Vistas de galeria">
                <button type="button" class="feed-tab ${context.view === 'pinterest' ? 'active' : ''}" data-gallery-view="pinterest">Pinterest</button>
                <button type="button" class="feed-tab ${context.view === 'grid' ? 'active' : ''}" data-gallery-view="grid">Cuadricula</button>
                <button type="button" class="feed-tab ${context.view === 'list' ? 'active' : ''}" data-gallery-view="list">Lista</button>
            </div>

            <div class="gallery-feed gallery-view-${context.view}">
                ${photos.length
                    ? photos.map((photo) => `
                        <article class="gallery-item" data-photo-id="${photo.id}">
                            <img src="${photo.src}" alt="${escapeHtml(photo.name || 'Foto de galeria')}">
                            <div class="gallery-item-meta">
                                <strong>${escapeHtml(photo.name || 'Foto')}</strong>
                                <span>${escapeHtml(photo.addedAt || '')}</span>
                            </div>
                        </article>
                    `).join('')
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
}

function setGalleryView(view) {
    if (!activeGalleryContext) return;
    activeGalleryContext.view = view;
    renderThreads();
}

function appendPhotosToGallery(context, files) {
    const existing = galleryPhotosBySpot.get(context.spotKey) || [];
    const readers = files.map((file) => {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = function(loadEvent) {
                resolve({
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    src: String(loadEvent.target && loadEvent.target.result ? loadEvent.target.result : ''),
                    name: file.name,
                    addedAt: new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'short', day: 'numeric' })
                });
            };
            reader.onerror = function() {
                resolve(null);
            };
            reader.readAsDataURL(file);
        });
    });

    Promise.all(readers).then((items) => {
        const validItems = items.filter((item) => item && item.src);
        if (!validItems.length) return;
        galleryPhotosBySpot.set(context.spotKey, [...validItems, ...existing]);
        renderThreads();
    });
}

function renderEntryComposer(feedContent, context) {
    const draft = entryDraftsBySpot.get(context.spotKey) || {
        title: '',
        content: ''
    };

    feedContent.innerHTML = `
        <section class="entry-editor-panel" aria-label="Editor de nueva entrada">
            <header class="entry-editor-head">
                <div>
                    <h3>${context.spotName}</h3>
                </div>
                <div class="entry-editor-actions">
                    <button class="ghost-btn" type="button" id="closeComposerBtn">Descartar entrada</button>
                    <button class="ghost-btn" type="button" id="saveDraftBtn">Guardar borrador</button>
                    <button class="primary-btn" type="button" id="publishEntryBtn">Publicar</button>
                </div>
            </header>

            <div class="doc-toolbar" role="toolbar" aria-label="Formato del texto">
                <button type="button" class="doc-tool" data-command="undo" title="Deshacer">↶</button>
                <button type="button" class="doc-tool" data-command="redo" title="Rehacer">↷</button>
                <button type="button" class="doc-tool" data-command="bold"><strong>B</strong></button>
                <button type="button" class="doc-tool" data-command="italic"><em>I</em></button>
                <button type="button" class="doc-tool" data-command="underline"><u>U</u></button>
                <select class="doc-select" id="blockFormatSelect" aria-label="Tipo de bloque">
                    <option value="p">Parrafo</option>
                    <option value="h1">H1</option>
                    <option value="h2">H2</option>
                    <option value="h3">H3</option>
                    <option value="blockquote">Cita</option>
                </select>
                <button type="button" class="doc-tool" data-command="formatBlock" data-value="blockquote">"</button>
                <button type="button" class="doc-tool" data-command="insertUnorderedList">Lista</button>
                <button type="button" class="doc-tool" data-command="insertOrderedList">1.</button>
                <button type="button" class="doc-tool" data-command="justifyLeft" title="Alinear izquierda">Izq</button>
                <button type="button" class="doc-tool" data-command="justifyCenter" title="Alinear centro">Centro</button>
                <button type="button" class="doc-tool" data-command="justifyRight" title="Alinear derecha">Der</button>
                <button type="button" class="doc-tool" data-command="justifyFull" title="Justificar">Just</button>
                <button type="button" class="doc-tool" data-action="checklist">Checklist</button>
                <label class="doc-color-control" title="Color de texto">
                    <span>A</span>
                    <input type="color" id="textColorPicker" value="#171717" aria-label="Color de texto">
                </label>
                <label class="doc-color-control" title="Resaltado">
                    <span>Res</span>
                    <input type="color" id="highlightColorPicker" value="#fff2a8" aria-label="Color de resaltado">
                </label>
                <button type="button" class="doc-tool" data-command="createLink" data-needs-url="true">Link</button>
                <button type="button" class="doc-tool" data-action="insert-image">Imagen</button>
                <button type="button" class="doc-tool" data-action="insert-table">Tabla</button>
                <button type="button" class="doc-tool" data-command="insertHorizontalRule">---</button>
                <button type="button" class="doc-tool" data-action="copy-format">Copiar formato</button>
                <button type="button" class="doc-tool" data-command="removeFormat">Limpiar</button>
                <span class="doc-word-count" id="docWordCount">0 palabras</span>
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
                >${draft.content || '<p>Empieza a escribir aqui tu cronica...</p>'}</article>
            </div>
        </section>
    `;

    bindEntryComposerUi(context);
}

function bindEntryComposerUi(context) {
    const closeBtn = document.getElementById('closeComposerBtn');
    const saveDraftBtn = document.getElementById('saveDraftBtn');
    const publishBtn = document.getElementById('publishEntryBtn');
    const titleInput = document.getElementById('entryTitleInput');
    const editor = document.getElementById('entryBodyEditor');
    const toolbar = document.querySelector('.doc-toolbar');
    const wordCountNode = document.getElementById('docWordCount');
    const blockFormatSelect = document.getElementById('blockFormatSelect');
    const textColorPicker = document.getElementById('textColorPicker');
    const highlightColorPicker = document.getElementById('highlightColorPicker');
    let copiedFormatState = null;
    let painterArmed = false;

    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            entryDraftsBySpot.delete(context.spotKey);
            closeEntryComposer();
        });
    }

    if (saveDraftBtn) {
        saveDraftBtn.addEventListener('click', function() {
            saveEntryDraft(context, titleInput, editor);
            saveDraftBtn.textContent = 'Guardado';
            window.setTimeout(() => {
                saveDraftBtn.textContent = 'Guardar borrador';
            }, 1200);
        });
    }

    if (publishBtn) {
        publishBtn.addEventListener('click', function() {
            const published = publishEntry(context, titleInput, editor);
            if (!published) {
                return;
            }
            publishBtn.textContent = 'Publicado';
            window.setTimeout(() => {
                publishBtn.textContent = 'Publicar';
            }, 1200);
        });
    }

    if (blockFormatSelect && editor) {
        blockFormatSelect.addEventListener('change', function() {
            editor.focus();
            document.execCommand('formatBlock', false, blockFormatSelect.value);
            refreshToolbarState(editor, toolbar, blockFormatSelect);
        });
    }

    if (textColorPicker && editor) {
        textColorPicker.addEventListener('input', function() {
            editor.focus();
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('foreColor', false, textColorPicker.value);
            refreshToolbarState(editor, toolbar, blockFormatSelect);
        });
    }

    if (highlightColorPicker && editor) {
        highlightColorPicker.addEventListener('input', function() {
            editor.focus();
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('hiliteColor', false, highlightColorPicker.value);
            refreshToolbarState(editor, toolbar, blockFormatSelect);
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
                } else if (action === 'copy-format') {
                    copiedFormatState = captureCurrentFormat(editor);
                    painterArmed = Boolean(copiedFormatState);
                    actionButton.classList.toggle('is-active', painterArmed);
                }

                refreshToolbarState(editor, toolbar, blockFormatSelect);
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
                refreshToolbarState(editor, toolbar, blockFormatSelect);
                return;
            }

            document.execCommand(command, false, value);
            refreshToolbarState(editor, toolbar, blockFormatSelect);
            updateWordCount(editor, wordCountNode);
        });
    }

    if (editor) {
        editor.addEventListener('input', function() {
            updateWordCount(editor, wordCountNode);
            refreshToolbarState(editor, toolbar, blockFormatSelect);
        });

        editor.addEventListener('keyup', function() {
            refreshToolbarState(editor, toolbar, blockFormatSelect);
        });

        editor.addEventListener('mouseup', function() {
            refreshToolbarState(editor, toolbar, blockFormatSelect);
            if (!painterArmed || !copiedFormatState) {
                return;
            }

            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) {
                return;
            }

            applyFormatState(copiedFormatState);
            painterArmed = false;
            copiedFormatState = null;
            const copyButton = toolbar ? toolbar.querySelector('[data-action="copy-format"]') : null;
            if (copyButton) {
                copyButton.classList.remove('is-active');
            }
            refreshToolbarState(editor, toolbar, blockFormatSelect);
            updateWordCount(editor, wordCountNode);
        });
    }

    updateWordCount(editor, wordCountNode);
    refreshToolbarState(editor, toolbar, blockFormatSelect);
}

function saveEntryDraft(context, titleInput, editor) {
    if (!context || !titleInput || !editor) return;

    entryDraftsBySpot.set(context.spotKey, {
        title: titleInput.value.trim(),
        content: editor.innerHTML.trim()
    });
}

function publishEntry(context, titleInput, editor) {
    if (!context || !titleInput || !editor) return false;

    const title = titleInput.value.trim() || `Entrada en ${context.spotName}`;
    const html = editor.innerHTML.trim();
    const plainText = getPlainTextFromHtml(html);
    const excerpt = plainText.slice(0, 180);

    if (!plainText) {
        return false;
    }

    const createdAt = new Date();
    publishedEntries.unshift({
        id: nextPublishedEntryId++,
        spotKey: context.spotKey,
        spotName: context.spotName,
        title,
        excerpt,
        content: html,
        createdAt
    });

    saveEntryDraft(context, titleInput, editor);
    renderHomeEntriesFeed();
    return true;
}

function renderHomeEntriesFeed() {
    const container = document.getElementById('homeEntriesFeed');
    const counter = document.getElementById('homeEntriesCount');
    if (!container) return;

    if (counter) {
        counter.textContent = `${publishedEntries.length} publicadas`;
    }

    if (!publishedEntries.length) {
        container.innerHTML = `
            <article class="home-entry-empty">
                <h4>Aún no hay entradas publicadas</h4>
                <p>Publica tu primera historia y aparecerá aquí, con lo más reciente siempre arriba.</p>
            </article>
        `;
        return;
    }

    container.innerHTML = publishedEntries
        .map((entry) => `
            <article class="home-entry-card" data-published-entry-id="${entry.id}">
                <div class="home-entry-meta">
                    <span>${escapeHtml(entry.spotName)}</span>
                    <span>${formatEntryDate(entry.createdAt)}</span>
                </div>
                <h4>${escapeHtml(entry.title)}</h4>
                <p>${escapeHtml(entry.excerpt)}${entry.excerpt.length >= 180 ? '...' : ''}</p>
            </article>
        `)
        .join('');
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
    const words = text.trim().match(/\S+/g);
    const count = words ? words.length : 0;
    wordCountNode.textContent = `${count} palabra${count === 1 ? '' : 's'}`;
}

function refreshToolbarState(editor, toolbar, blockFormatSelect) {
    if (!editor || !toolbar) return;

    const toggleCommands = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'];
    toggleCommands.forEach((command) => {
        const button = toolbar.querySelector(`[data-command="${command}"]`);
        if (!button) return;
        const isActive = document.queryCommandState(command);
        button.classList.toggle('is-active', Boolean(isActive));
    });

    if (blockFormatSelect) {
        const currentBlock = normalizeBlockValue(document.queryCommandValue('formatBlock'));
        if (currentBlock) {
            blockFormatSelect.value = currentBlock;
        }
    }
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
                `<strong>${thread.title}</strong><br>${thread.area} · ${category.label}`,
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
