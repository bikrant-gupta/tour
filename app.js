/* ============================================
   TOUR EXPLORER — Application Logic
   v2.0 — Theme + Search + Timeline + Tagged Images
   ============================================ */

(function () {
  'use strict';

  // ---------- State ----------
  let appData = null;
  let map = null;
  let markers = {};
  let _tileLayers = [];
  let activeLocationId = null;
  let activeEventIndex = 0;
  let lightboxImages = [];
  let lightboxIndex = 0;
  let currentTheme = 'dark';
  let activeView = 'map'; // 'map' | 'timeline'
  let _searchDebounce = null;
  let _searchIndex = [];

  // ---------- DOM References ----------
  const elements = {};

  // ============================================
  // IMAGE UTILITIES (HEIC support)
  // ============================================
  const _imgCache = new Map();
  const BLANK_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  function isHeic(src) {
    if (!src) return false;
    const ext = src.split('.').pop().split('?')[0].toLowerCase();
    return ext === 'heic' || ext === 'heif';
  }

  async function getDisplayUrl(src) {
    if (!src) return null;
    if (_imgCache.has(src)) return _imgCache.get(src);
    if (!isHeic(src)) { _imgCache.set(src, src); return src; }
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      if (typeof heic2any === 'undefined') throw new Error('heic2any not loaded');
      const result = await heic2any({ blob, toType: 'image/jpeg', quality: 0.85 });
      const jpegBlob = Array.isArray(result) ? result[0] : result;
      const url = URL.createObjectURL(jpegBlob);
      _imgCache.set(src, url);
      return url;
    } catch (err) {
      console.warn('[HEIC]', src, err);
      return null;
    }
  }

  async function loadImageEl(imgEl) {
    const src = imgEl.dataset.src;
    if (!src) return;
    imgEl.style.opacity = '0';
    imgEl.parentElement?.classList.add('shimmer');
    const url = await getDisplayUrl(src);
    if (url) {
      imgEl.src = url;
      imgEl.onload = () => {
        imgEl.style.opacity = '1';
        imgEl.style.transition = 'opacity 0.3s ease';
        imgEl.parentElement?.classList.remove('shimmer');
      };
      imgEl.onerror = () => _showImgPlaceholder(imgEl);
    } else {
      _showImgPlaceholder(imgEl);
    }
  }

  function _showImgPlaceholder(imgEl) {
    const parent = imgEl.parentElement;
    if (!parent) return;
    parent.classList.remove('shimmer');
    const name = imgEl.alt || 'Image';
    if (parent.classList.contains('group-card__hero') || parent.classList.contains('timeline__card-photo')) {
      parent.innerHTML = '<div class="group-card__hero-placeholder">🏔️</div>';
    } else if (parent.classList.contains('group-card__thumb')) {
      parent.innerHTML = `<div class="group-card__thumb-placeholder">${name.split('.')[0]}</div>`;
    } else if (parent.classList.contains('lightbox__image-wrapper') || parent.id === 'lightbox-image-wrapper') {
      parent.innerHTML = `<div class="lightbox__image-placeholder"><div class="lightbox__image-placeholder-icon">🖼️</div><div class="lightbox__image-placeholder-text">${name}</div></div>`;
    }
  }

  function processImages(container) {
    container.querySelectorAll('img[data-src]').forEach(img => loadImageEl(img));
  }

  // ============================================
  // THEME
  // ============================================
  function initTheme() {
    const saved = localStorage.getItem('_tour_theme') || 'dark';
    applyTheme(saved, false);
  }

  function applyTheme(theme, save = true) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    if (save) localStorage.setItem('_tour_theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.innerHTML = theme === 'dark'
        ? '<span class="theme-toggle__icon">☀️</span><span class="theme-toggle__label">Light</span>'
        : '<span class="theme-toggle__icon">🌙</span><span class="theme-toggle__label">Dark</span>';
      btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
    if (map) swapMapTiles();
  }

  function toggleTheme() {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  function swapMapTiles() {
    const mapConfig = appData.map_config || {};
    const showBoundaries = mapConfig.show_boundaries !== false;
    const isDark = currentTheme === 'dark';

    _tileLayers.forEach(layer => map.removeLayer(layer));
    _tileLayers = [];

    const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>';
    const tileOpts = { attribution, subdomains: 'abcd', maxZoom: 20 };

    if (showBoundaries) {
      const url = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
      _tileLayers = [L.tileLayer(url, tileOpts).addTo(map)];
    } else {
      const baseUrl = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
      const labelsUrl = isDark
        ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';
      const base = L.tileLayer(baseUrl, { ...tileOpts, className: isDark ? 'map-tiles--clean' : '' }).addTo(map);
      const labels = L.tileLayer(labelsUrl, tileOpts).addTo(map);
      _tileLayers = [base, labels];
    }
  }

  // ============================================
  // SEARCH
  // ============================================
  function norm(str) {
    return (str || '').toLowerCase().replace(/\s+/g, '');
  }

  function trigrams(str) {
    const s = '  ' + str + ' ';
    const tg = new Set();
    for (let i = 0; i < s.length - 2; i++) tg.add(s.slice(i, i + 3));
    return tg;
  }

  function trigramSimilarity(a, b) {
    if (!a || !b) return 0;
    const ta = trigrams(a);
    const tb = trigrams(b);
    let common = 0;
    ta.forEach(t => { if (tb.has(t)) common++; });
    return (2 * common) / (ta.size + tb.size);
  }

  function matchesQuery(searchables, q) {
    if (!q) return true;
    for (const s of searchables) { if (s.includes(q)) return true; }
    for (const s of searchables) { if (trigramSimilarity(s, q) >= 0.3) return true; }
    return false;
  }

  function buildSearchIndex() {
    _searchIndex = [];
    Object.entries(appData.locations).forEach(([locationId, location]) => {
      const locationTags = (location.tags || []).map(t => norm(t));
      const entry = {
        locationId,
        searchable: [
          norm(locationId),
          norm(location.name),
          ...locationTags,
        ],
      };
      // Also index group fields
      (location.events || []).forEach(event => {
        (event.event_groups || []).forEach(group => {
          const groupSearchables = [
            norm(group.group_id),
            norm(group.group_name),
            ...(group.images || []).flatMap(img => (img.tags || []).map(t => norm(t))),
          ];
          entry.searchable.push(...groupSearchables);
        });
      });
      // Deduplicate
      entry.searchable = [...new Set(entry.searchable.filter(Boolean))];
      _searchIndex.push(entry);
    });
  }

  function applySearch(query) {
    const q = norm(query);
    const matchedLocations = new Set();

    if (!q) {
      Object.keys(appData.locations).forEach(id => matchedLocations.add(id));
    } else {
      _searchIndex.forEach(entry => {
        if (matchesQuery(entry.searchable, q)) matchedLocations.add(entry.locationId);
      });
    }

    // Show/hide markers
    Object.entries(markers).forEach(([locationId, marker]) => {
      const el = marker.getElement();
      if (!el) return;
      if (matchedLocations.has(locationId)) {
        el.style.display = '';
        el.style.opacity = '1';
        el.style.transition = 'opacity 0.3s ease';
      } else {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.3s ease';
        setTimeout(() => { if (el) el.style.display = 'none'; }, 300);
      }
    });

    // Close panel if active location hidden
    if (activeLocationId && !matchedLocations.has(activeLocationId)) closePanel(false);

    // Snackbar on no match
    if (q && matchedLocations.size === 0) showSnackbar('No results found');
  }

  function showSnackbar(msg) {
    let sb = document.getElementById('snackbar');
    if (!sb) {
      sb = document.createElement('div');
      sb.id = 'snackbar';
      sb.className = 'snackbar';
      document.body.appendChild(sb);
    }
    sb.textContent = msg;
    sb.classList.add('snackbar--visible');
    clearTimeout(sb._timer);
    sb._timer = setTimeout(() => sb.classList.remove('snackbar--visible'), 3000);
  }

  // ============================================
  // TIMELINE
  // ============================================
  function openTimeline() {
    if (activeLocationId) closePanel(false);
    activeView = 'timeline';
    elements.map.style.display = 'none';
    elements.overlay.style.display = 'none';
    elements.timelineView.style.display = 'flex';
    renderTimeline();
    const btn = document.getElementById('timeline-toggle');
    if (btn) btn.classList.add('navbar__timeline-btn--active');
  }

  function closeTimeline() {
    activeView = 'map';
    elements.map.style.display = '';
    elements.overlay.style.display = '';
    elements.timelineView.style.display = 'none';
    const btn = document.getElementById('timeline-toggle');
    if (btn) btn.classList.remove('navbar__timeline-btn--active');
  }

  function getAllEventsSorted() {
    const events = [];
    Object.entries(appData.locations).forEach(([locationId, location]) => {
      (location.events || []).forEach(event => {
        events.push({
          ...event,
          locationId,
          locationName: location.name,
          locationTags: location.tags || [],
        });
      });
    });
    return events.sort((a, b) => new Date(b.event_start) - new Date(a.event_start));
  }

  function getDurationDays(start, end) {
    const diff = new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00');
    return Math.max(1, Math.round(diff / 86400000) + 1);
  }

  function renderTimeline() {
    const events = getAllEventsSorted();
    if (events.length === 0) {
      elements.timelineView.innerHTML = `
        <div class="timeline__empty">
          <div class="empty-state__icon">📭</div>
          <div class="empty-state__text">No trips recorded yet.</div>
        </div>`;
      return;
    }

    elements.timelineView.innerHTML = `
      <div class="timeline__header">
        <button class="timeline__back-btn" id="timeline-close">
          <span>←</span> Back to Map
        </button>
        <div class="timeline__header-text">
          <h2 class="timeline__title">Journey Timeline</h2>
          <p class="timeline__subtitle">${events.length} trip${events.length !== 1 ? 's' : ''} · ${Object.keys(appData.locations).length} destinations</p>
        </div>
      </div>
      <div class="timeline__track">
        <div class="timeline__line"></div>
        ${events.map((event, i) => renderTimelineCard(event, i)).join('')}
      </div>
    `;

    processImages(elements.timelineView);

    // Entrance animations via IntersectionObserver
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('timeline__card--visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    elements.timelineView.querySelectorAll('.timeline__card').forEach(c => io.observe(c));

    document.getElementById('timeline-close').addEventListener('click', closeTimeline);

    // "View Details" buttons
    elements.timelineView.querySelectorAll('.timeline__card-cta').forEach(btn => {
      btn.addEventListener('click', () => {
        const locId = btn.dataset.locationId;
        closeTimeline();
        setTimeout(() => openLocation(locId), 50);
      });
    });
  }

  function renderTimelineCard(event, index) {
    const isLeft = index % 2 === 0;
    const heroGroup = event.event_groups?.[0];
    const heroImg = heroGroup?.images?.[0];
    const heroSrc = heroImg ? heroGroup.group_image_path + heroImg.file_name : null;
    const duration = getDurationDays(event.event_start, event.event_end);
    const totalPhotos = (event.event_groups || []).reduce((s, g) => s + (g.images || []).length, 0);
    const groupCount = (event.event_groups || []).length;

    return `
      <div class="timeline__card ${isLeft ? 'timeline__card--left' : 'timeline__card--right'}">
        <div class="timeline__dot"></div>
        <div class="timeline__card-inner">
          ${heroSrc ? `
            <div class="timeline__card-photo">
              <img data-src="${heroSrc}" alt="${event.locationName}" src="${BLANK_SRC}">
            </div>` : ''}
          <div class="timeline__card-body">
            <div class="timeline__card-location">📍 ${event.locationName}</div>
            <div class="timeline__card-date">${formatDate(event.event_start)} — ${formatDate(event.event_end)}</div>
            <div class="timeline__card-chips">
              <span class="timeline__chip">${duration} day${duration !== 1 ? 's' : ''}</span>
              <span class="timeline__chip">${groupCount} place${groupCount !== 1 ? 's' : ''}</span>
              ${totalPhotos > 0 ? `<span class="timeline__chip">📷 ${totalPhotos}</span>` : ''}
            </div>
            ${event.locationTags.length > 0 ? `
              <div class="timeline__card-tags">
                ${event.locationTags.map(t => `<span class="timeline__tag">${t}</span>`).join('')}
              </div>` : ''}
            <button class="timeline__card-cta" data-location-id="${event.locationId}">
              View Details →
            </button>
          </div>
        </div>
      </div>`;
  }

  // ============================================
  // INITIALIZATION
  // ============================================
  function init() {
    appData = window.__tourData || { author: 'Explorer', locations: {} };
    cacheElements();
    initTheme();
    updateNavbar();
    initMap();
    renderMarkers();
    buildSearchIndex();
    setupEventListeners();
    handleRoute();
    window.addEventListener('popstate', handleRoute);
  }

  // ---------- Element Caching ----------
  function cacheElements() {
    elements.app = document.getElementById('app');
    elements.map = document.getElementById('map');
    elements.overlay = document.getElementById('overlay');
    elements.panel = document.getElementById('location-panel');
    elements.lightbox = document.getElementById('lightbox');
    elements.timelineView = document.getElementById('timeline-view');
    elements.authorName = document.getElementById('author-name');
    elements.authorInitial = document.getElementById('author-initial');
    elements.locationCount = document.getElementById('location-count');
    elements.panelLocationName = document.getElementById('panel-location-name');
    elements.panelCoords = document.getElementById('panel-coords');
    elements.panelTags = document.getElementById('panel-tags');
    elements.panelTabs = document.getElementById('panel-tabs');
    elements.panelContent = document.getElementById('panel-content');
    elements.lightboxImageWrapper = document.getElementById('lightbox-image-wrapper');
    elements.lightboxCaption = document.getElementById('lightbox-caption');
    elements.lightboxCounter = document.getElementById('lightbox-counter');
    elements.lightboxTags = document.getElementById('lightbox-tags');
    elements.searchInput = document.getElementById('search-input');
  }

  // ---------- Navbar ----------
  function updateNavbar() {
    if (appData.author) {
      elements.authorName.textContent = appData.author;
      elements.authorInitial.textContent = appData.author.charAt(0).toUpperCase();
    }
    elements.locationCount.textContent = Object.keys(appData.locations).length;
  }

  // ---------- Map Initialization ----------
  function initMap() {
    map = L.map('map', {
      center: [22.5, 80], zoom: 5,
      zoomControl: false, attributionControl: true,
      minZoom: 3, maxZoom: 18,
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    swapMapTiles(); // uses currentTheme set by initTheme()
  }

  // ---------- Marker Rendering ----------
  function renderMarkers() {
    Object.entries(appData.locations).forEach(([locationId, location]) => {
      const pinHtml = `
        <div class="map-pin" data-location-id="${locationId}">
          <div class="map-pin__marker">
            <div class="map-pin__pulse"></div>
            <div class="map-pin__dot"></div>
            <div class="map-pin__label">${location.name}</div>
          </div>
        </div>`;
      const icon = L.divIcon({ html: pinHtml, className: 'map-pin-container', iconSize: [40, 40], iconAnchor: [20, 20] });
      const marker = L.marker([location.lat, location.long], { icon }).addTo(map);
      marker.on('click', () => openLocation(locationId));
      markers[locationId] = marker;
    });
  }

  // ---------- Routing ----------
  function handleRoute() {
    const hash = window.location.hash;
    const pathMatch = window.location.pathname.match(/\/location\/([^/]+)/);
    const hashMatch = hash.match(/#\/location\/([^/]+)/);
    const locationId = (pathMatch || hashMatch || [])[1];
    if (locationId && appData.locations[locationId]) openLocation(locationId, false);
    else closePanel(false);
  }

  // ---------- Open Location ----------
  function openLocation(locationId, pushState = true) {
    if (!appData.locations[locationId]) return;

    // If timeline is open, close it first
    if (activeView === 'timeline') closeTimeline();

    activeLocationId = locationId;
    activeEventIndex = 0;
    const location = appData.locations[locationId];

    if (window.__tracker && window.__authUser)
      window.__tracker.logActivity(window.__authUser, 'opened_location', `${location.name} (${locationId})`);

    if (pushState) history.pushState({ locationId }, '', `#/location/${locationId}/`);

    elements.panelLocationName.textContent = location.name;
    elements.panelCoords.textContent = `${location.lat.toFixed(4)}°N, ${location.long.toFixed(4)}°E`;

    // Location tags
    if (elements.panelTags) {
      const tags = location.tags || [];
      elements.panelTags.innerHTML = tags.map(t => `<span class="panel__location-tag">${t}</span>`).join('');
      elements.panelTags.style.display = tags.length > 0 ? 'flex' : 'none';
    }

    renderEventTabs(location.events);
    renderEventContent(location.events[0]);

    document.querySelectorAll('.map-pin').forEach(p => p.classList.remove('map-pin--active'));
    document.querySelector(`.map-pin[data-location-id="${locationId}"]`)?.classList.add('map-pin--active');

    elements.overlay.classList.add('overlay--visible');
    elements.panel.classList.add('location-panel--open');
    map.flyTo([location.lat, location.long], 7, { duration: 1.2, easeLinearity: 0.25 });
  }

  // ---------- Event Tabs ----------
  function renderEventTabs(events) {
    if (!events?.length) { elements.panelTabs.innerHTML = ''; return; }
    elements.panelTabs.innerHTML = events.map((event, index) => `
      <button class="panel__tab ${index === activeEventIndex ? 'panel__tab--active' : ''}"
              data-event-index="${index}" id="tab-event-${index}">
        <span class="panel__tab-icon">📅</span>
        ${formatDate(event.event_start)} — ${formatDate(event.event_end)}
      </button>`).join('');

    elements.panelTabs.querySelectorAll('.panel__tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const index = parseInt(tab.dataset.eventIndex, 10);
        activeEventIndex = index;
        elements.panelTabs.querySelectorAll('.panel__tab').forEach(t => t.classList.remove('panel__tab--active'));
        tab.classList.add('panel__tab--active');
        elements.panelContent.style.opacity = '0';
        elements.panelContent.style.transform = 'translateY(12px)';
        setTimeout(() => {
          renderEventContent(appData.locations[activeLocationId].events[index]);
          elements.panelContent.style.opacity = '1';
          elements.panelContent.style.transform = 'translateY(0)';
        }, 200);
      });
    });
  }

  // ---------- Event Content ----------
  function renderEventContent(event) {
    if (!event?.event_groups?.length) {
      elements.panelContent.innerHTML = `<div class="empty-state"><div class="empty-state__icon">📭</div><div class="empty-state__text">No tour details available.</div></div>`;
      return;
    }
    elements.panelContent.innerHTML = `
      <div class="panel__section-title">Tour Places</div>
      ${event.event_groups.map((group, gi) => renderGroupCard(group, gi)).join('')}`;
    processImages(elements.panelContent);

    elements.panelContent.querySelectorAll('[data-lightbox]').forEach(el => {
      el.addEventListener('click', () => {
        const images = JSON.parse(el.dataset.lightboxImages);
        openLightbox(images, parseInt(el.dataset.lightboxIndex, 10), el.dataset.lightboxGroup);
      });
    });
  }

  // ---------- Group Card (new image format: {file_name, tags}) ----------
  function renderGroupCard(group, groupIndex) {
    const maxThumbs = 4;
    const images = group.images || [];
    const displayImages = images.slice(0, maxThumbs);
    const remaining = images.length - maxThumbs;

    // Build lightbox data with tags
    const imageDataForLightbox = JSON.stringify(
      images.map(img => ({
        src: group.group_image_path + img.file_name,
        name: img.file_name,
        tags: img.tags || [],
      }))
    ).replace(/"/g, '&quot;');

    const heroSrc = images.length > 0 ? group.group_image_path + images[0].file_name : null;

    return `
      <div class="group-card" id="group-${group.group_id}" style="animation-delay: ${groupIndex * 100}ms">
        <div class="group-card__hero">
          ${heroSrc
        ? `<img data-src="${heroSrc}" alt="${group.group_name}" src="${BLANK_SRC}">`
        : '<div class="group-card__hero-placeholder">🏔️</div>'}
          <div class="group-card__hero-overlay">
            <div class="group-card__hero-title">${group.group_name}</div>
          </div>
        </div>
        <div class="group-card__body">
          <div class="group-card__meta">
            <span class="group-card__badge">${group.group_id}</span>
            <span class="group-card__image-count">📷 ${images.length} photos</span>
          </div>
          <div class="group-card__gallery">
            ${displayImages.map((img, i) => `
              <div class="group-card__thumb" data-lightbox
                   data-lightbox-images="${imageDataForLightbox}"
                   data-lightbox-index="${i}"
                   data-lightbox-group="${group.group_name}">
                <img data-src="${group.group_image_path}${img.file_name}" alt="${img.file_name}" src="${BLANK_SRC}">
              </div>`).join('')}
            ${remaining > 0 ? `
              <div class="group-card__view-all" data-lightbox
                   data-lightbox-images="${imageDataForLightbox}"
                   data-lightbox-index="${maxThumbs}"
                   data-lightbox-group="${group.group_name}">
                <span class="group-card__view-all-icon">+${remaining}</span>
                <span>more</span>
              </div>` : ''}
          </div>
        </div>
      </div>`;
  }

  // ---------- Lightbox ----------
  function openLightbox(images, startIndex, groupName) {
    lightboxImages = images;
    lightboxIndex = startIndex;
    if (window.__tracker && window.__authUser) {
      const img = images[startIndex];
      window.__tracker.logActivity(window.__authUser, 'viewed_photo', `${groupName} → ${img?.name || 'unknown'}`);
    }
    updateLightboxImage();
    elements.lightbox.classList.add('lightbox--visible');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    elements.lightbox.classList.remove('lightbox--visible');
    document.body.style.overflow = activeLocationId ? 'hidden' : '';
  }

  async function updateLightboxImage() {
    const img = lightboxImages[lightboxIndex];
    if (!img) return;

    elements.lightboxImageWrapper.innerHTML = `
      <div class="lightbox__image-placeholder shimmer">
        <div class="lightbox__image-placeholder-icon">⏳</div>
        <div class="lightbox__image-placeholder-text">Loading…</div>
      </div>`;

    elements.lightboxCaption.textContent = img.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    elements.lightboxCounter.textContent = `${lightboxIndex + 1} of ${lightboxImages.length}`;

    // Tags
    if (elements.lightboxTags) {
      const tags = img.tags || [];
      elements.lightboxTags.innerHTML = tags.map(t => `<span class="lightbox__tag">${t}</span>`).join('');
      elements.lightboxTags.style.display = tags.length > 0 ? 'flex' : 'none';
    }

    const url = await getDisplayUrl(img.src);
    if (url) {
      const imgEl = document.createElement('img');
      imgEl.alt = img.name;
      imgEl.onload = () => { elements.lightboxImageWrapper.innerHTML = ''; elements.lightboxImageWrapper.appendChild(imgEl); };
      imgEl.onerror = () => {
        elements.lightboxImageWrapper.innerHTML = `<div class="lightbox__image-placeholder"><div class="lightbox__image-placeholder-icon">🖼️</div><div class="lightbox__image-placeholder-text">${img.name}</div></div>`;
      };
      imgEl.src = url;
    } else {
      elements.lightboxImageWrapper.innerHTML = `<div class="lightbox__image-placeholder"><div class="lightbox__image-placeholder-icon">🖼️</div><div class="lightbox__image-placeholder-text">${img.name}</div></div>`;
    }
  }

  function lightboxPrev() { lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length; animateLightboxTransition('right'); }
  function lightboxNext() { lightboxIndex = (lightboxIndex + 1) % lightboxImages.length; animateLightboxTransition('left'); }

  function animateLightboxTransition(dir) {
    const wrapper = elements.lightboxImageWrapper;
    wrapper.style.transform = `translateX(${dir === 'left' ? '-30px' : '30px'})`;
    wrapper.style.opacity = '0';
    setTimeout(() => {
      updateLightboxImage();
      wrapper.style.transform = `translateX(${dir === 'left' ? '30px' : '-30px'})`;
      requestAnimationFrame(() => {
        wrapper.style.transition = 'transform 300ms cubic-bezier(0.16,1,0.3,1), opacity 300ms ease';
        wrapper.style.transform = 'translateX(0)';
        wrapper.style.opacity = '1';
        setTimeout(() => { wrapper.style.transition = ''; }, 300);
      });
    }, 150);
  }

  // ---------- Panel Close ----------
  function closePanel(pushState = true) {
    activeLocationId = null;
    elements.overlay.classList.remove('overlay--visible');
    elements.panel.classList.remove('location-panel--open');
    document.querySelectorAll('.map-pin').forEach(p => p.classList.remove('map-pin--active'));
    if (pushState) history.pushState({}, '', '#/');
    map.flyTo([22.5, 80], 5, { duration: 1, easeLinearity: 0.25 });
  }

  // ---------- Event Listeners ----------
  function setupEventListeners() {
    document.getElementById('panel-close').addEventListener('click', () => closePanel());
    elements.overlay.addEventListener('click', () => closePanel());
    document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('lightbox-prev').addEventListener('click', lightboxPrev);
    document.getElementById('lightbox-next').addEventListener('click', lightboxNext);
    elements.lightbox.addEventListener('click', e => { if (e.target === elements.lightbox) closeLightbox(); });

    document.addEventListener('keydown', e => {
      if (elements.lightbox.classList.contains('lightbox--visible')) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') lightboxPrev();
        if (e.key === 'ArrowRight') lightboxNext();
      } else if (elements.panel.classList.contains('location-panel--open')) {
        if (e.key === 'Escape') closePanel();
      } else if (activeView === 'timeline') {
        if (e.key === 'Escape') closeTimeline();
      }
    });

    elements.panelContent.style.transition = 'opacity 200ms ease, transform 200ms ease';
    document.getElementById('navbar-brand').addEventListener('click', e => { e.preventDefault(); closePanel(); });

    // Theme toggle
    document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

    // Timeline toggle
    document.getElementById('timeline-toggle')?.addEventListener('click', () => {
      if (activeView === 'timeline') closeTimeline(); else openTimeline();
    });

    // Search
    if (elements.searchInput) {
      elements.searchInput.addEventListener('input', e => {
        clearTimeout(_searchDebounce);
        _searchDebounce = setTimeout(() => applySearch(e.target.value), 200);
      });
      elements.searchInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') { elements.searchInput.value = ''; applySearch(''); elements.searchInput.blur(); }
      });
    }
  }

  // ---------- Helpers ----------
  function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---------- Expose for auth.js ----------
  window.__tourApp = Object.freeze({ start: init });

})();
