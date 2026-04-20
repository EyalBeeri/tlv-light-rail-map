var __neighborhoodCache = new Map();

document.addEventListener('DOMContentLoaded', () => {
	// Initialize map centered on Tel Aviv
	const map = L.map('map', {
		minZoom: 12,
		maxBounds: [
			[31.95, 34.7],
			[32.15, 34.95]
		]
	}).setView([32.06, 34.80], 13);

	map.zoomControl.setPosition('topleft');

	// --- Tiles ---
	L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
		attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
		subdomains: 'abcd',
		maxZoom: 20
	}).addTo(map);

	// --- DOM ---
	const routeInfoDiv = document.getElementById('route-info');
	const slider = document.getElementById('radius-slider');
	const radiusValue = document.getElementById('radius-value');
	const clearMapBtn = document.getElementById('clear-map-btn');
	const searchInput = document.getElementById('search-input');
	const clearSearchBtn = document.getElementById('clear-search-btn');
	const searchResults = document.getElementById('search-results');
	const locateBtn = document.getElementById('locate-me-btn');
	const plannedGreenToggle = document.getElementById('toggle-planned-green');
	const plannedPurpleToggle = document.getElementById('toggle-planned-purple');

	searchInput.setAttribute('aria-expanded', 'false');

	// --- State ---
	let stationsData = [];
	let plannedStationsData = [];
	let isochroneData = {};
	let walkingMinutes = parseInt(slider.value, 10) || 5;
	const plannedStationsByLine = { green: [], purple: [] };
	const plannedLayerByLine = { green: L.layerGroup(), purple: L.layerGroup() };
	const activePlannedLines = { green: false, purple: false };

	let currentIsochroneLayerGroup = L.layerGroup().addTo(map);
	let currentNeighborhoodLayer = null;
	let currentRouteLine = null;
	let currentPin = null;

	let activeSelectionId = 0;
	let currentSelectionLocation = null;
	let routeCandidates = [];
	let selectedRouteStationKey = '';
	let currentRouteStats = null;

	let activeRouteController = null;

	const neighborhoodCache = new Map();
	__neighborhoodCache = neighborhoodCache;

	// Search state
	let searchDebounceId = null;
	let activeSearchController = null;
	let activeSearchRequestId = 0;
	let renderedSearchItems = [];
	let highlightedSearchIndex = -1;

	// --- Icons ---
	const stationIcon = L.divIcon({
		className: 'station-icon',
		html: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h0"/><path d="M16 15h0"/></svg>`,
		iconSize: [24, 24],
		iconAnchor: [12, 12]
	});

	const plannedStationSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h0"/><path d="M16 15h0"/></svg>`;

	const plannedGreenIcon = L.divIcon({
		className: 'station-icon planned-station-icon planned-station-green',
		html: plannedStationSvg,
		iconSize: [24, 24],
		iconAnchor: [12, 12]
	});

	const plannedPurpleIcon = L.divIcon({
		className: 'station-icon planned-station-icon planned-station-purple',
		html: plannedStationSvg,
		iconSize: [24, 24],
		iconAnchor: [12, 12]
	});

	const userIcon = L.divIcon({
		className: 'user-icon',
		html: `<div class="user-icon-inner"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>`,
		iconSize: [36, 36],
		iconAnchor: [18, 36],
		popupAnchor: [0, -36]
	});

	function getPlannedLineLabel(line) {
		if (line === 'green') return 'ירוק';
		if (line === 'purple') return 'סגול';
		return 'עתידי';
	}

	function getPlannedIcon(line) {
		return line === 'purple' ? plannedPurpleIcon : plannedGreenIcon;
	}

	function getStationDisplayName(station) {
		const baseName = station.name_he || station.name || 'תחנה';
		if (station.isPlanned) {
			return `${baseName} (קו ${getPlannedLineLabel(station.line)} מתוכנן)`;
		}
		if (baseName === 'שלמה') return 'שלמה (סלמה)';
		return baseName;
	}

	function getStationIsochroneName(station) {
		return station.name_he || station.name || '';
	}

	function getStationKey(station) {
		const baseKey = station.full_name || station.name_he || station.name || '';
		if (station.isPlanned) {
			return `${station.line || 'planned'}::${baseKey}`;
		}
		return baseKey;
	}

	function escapeHtml(value) {
		return String(value || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function toFiniteNumber(value) {
		const num = Number(value);
		return Number.isFinite(num) ? num : null;
	}

	function normalizeText(value) {
		return String(value || '')
			.toLowerCase()
			.replace(/[\u0591-\u05C7]/g, '')
			.replace(/['"`,./\\-]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function normalizeSearchText(value) {
		return normalizeText(value)
			.replace(/[ך]/g, 'כ')
			.replace(/[ם]/g, 'מ')
			.replace(/[ן]/g, 'נ')
			.replace(/[ף]/g, 'פ')
			.replace(/[ץ]/g, 'צ')
			.replace(/י{2,}/g, 'י')
			.replace(/ו{2,}/g, 'ו');
	}

	function getGeojsonCenter(geojson) {
		if (!window.turf || !geojson) return null;
		try {
			const center = turf.centerOfMass(geojson);
			return {
				lat: center.geometry.coordinates[1],
				lon: center.geometry.coordinates[0]
			};
		} catch (error) {
			return null;
		}
	}

	function formatAddress(data) {
		const addr = data.address || {};
		const street = addr.road || addr.pedestrian || '';
		const number = addr.house_number || '';
		const neighborhood = addr.neighbourhood || addr.suburb || addr.residential || addr.quarter || '';
		const city = addr.city || addr.town || addr.village || '';

		let streetPart = street;
		if (number) streetPart += ` ${number}`;

		const components = [];
		if (streetPart) components.push(streetPart);
		if (neighborhood) components.push(neighborhood);
		if (city) components.push(city);

		if (components.length === 0) {
			const displayName = typeof data.display_name === 'string' ? data.display_name : '';
			const fallback = displayName.split(',')[0] || '';
			return fallback || 'מיקום במפה';
		}

		return components.join(', ');
	}

	function formatSearchAddress(item) {
		const address = item.address || {};
		const street = address.road || address.pedestrian || address.footway || address.path || '';
		const houseNumber = address.house_number || '';
		const neighborhood = address.neighbourhood || address.suburb || address.residential || address.quarter || '';
		const city = address.city || address.town || address.village || address.municipality || '';

		const primary = (street ? `${street}${houseNumber ? ` ${houseNumber}` : ''}` : '').trim();

		const displayParts = String(item.display_name || '')
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean);

		const label = primary || displayParts[0] || 'כתובת';

		const secondaryParts = [];
		if (neighborhood && normalizeText(neighborhood) !== normalizeText(label)) secondaryParts.push(neighborhood);
		if (city && normalizeText(city) !== normalizeText(label) && normalizeText(city) !== normalizeText(neighborhood)) {
			secondaryParts.push(city);
		}

		const secondaryLabel = secondaryParts.length > 0
			? secondaryParts.join(', ')
			: displayParts.slice(1, 3).join(', ');

		return { label, secondaryLabel };
	}

	function getSearchItemKey(item) {
		return `${item.type}|${normalizeSearchText(item.label)}|${normalizeSearchText(item.secondaryLabel)}`;
	}

	function scoreSearchItem(item, normalizedQuery) {
		const label = normalizeSearchText(item.label);
		const secondary = normalizeSearchText(item.secondaryLabel);
		let score = 0;

		if (label === normalizedQuery) score += 120;
		else if (label.startsWith(normalizedQuery)) score += 80;
		else if (label.includes(normalizedQuery)) score += 50;

		if (secondary.includes(normalizedQuery)) score += 20;
		if (item.type === 'station') score += 35;
		if (item.type === 'neighborhood') score += 25;

		return score;
	}

	function getActivePlannedStations() {
		const active = [];
		if (activePlannedLines.green) active.push(...plannedStationsByLine.green);
		if (activePlannedLines.purple) active.push(...plannedStationsByLine.purple);
		return active;
	}

	function getSearchableStations() {
		return [...stationsData, ...getActivePlannedStations()];
	}

	function applyPlannedLayersVisibility() {
		Object.keys(plannedLayerByLine).forEach((line) => {
			const shouldShow = Boolean(activePlannedLines[line]);
			const layer = plannedLayerByLine[line];
			const isShowing = map.hasLayer(layer);

			if (shouldShow && !isShowing) layer.addTo(map);
			if (!shouldShow && isShowing) map.removeLayer(layer);
		});
	}

	function clearRouteLine() {
		if (currentRouteLine) {
			map.removeLayer(currentRouteLine);
			currentRouteLine = null;
		}
	}

	function abortActiveRouteRequest() {
		if (activeRouteController) {
			activeRouteController.abort();
			activeRouteController = null;
		}
	}

	function setRouteDetailsHtml(html) {
		const routeDetails = document.getElementById('route-details');
		if (routeDetails) routeDetails.innerHTML = html;
	}

	function renderRouteDetails(stationName, distanceMeters) {
		const minutes = Math.max(1, Math.round(distanceMeters / 80));
		const isClose = minutes <= walkingMinutes;

		setRouteDetailsHtml(`
			<p><strong>יעד:</strong> ${escapeHtml(stationName)}</p>
			<p><strong>זמן הליכה:</strong> <span style="font-size: 1.2rem; font-weight: bold;">${minutes} דק'</span></p>
			<p><strong>מרחק:</strong> ${distanceMeters} מטרים</p>
			<p style="color: ${isClose ? '#2a9d8f' : '#e63946'}; font-weight: 600; margin-top: 10px;">
				${isClose ? `מצויין! בטווח ${walkingMinutes} דקות.` : `יותר מ-${walkingMinutes} דקות הליכה.`}
			</p>
		`);
	}

	function highlightRouteStation(stationKey) {
		const stationButtons = routeInfoDiv.querySelectorAll('.route-station-btn');
		stationButtons.forEach((button) => {
			const isActive = button.dataset.stationKey === stationKey;
			button.classList.toggle('active', isActive);
		});
	}

	function updateRouteOriginLabel(label) {
		const routeOrigin = document.getElementById('route-origin-label');
		if (routeOrigin) {
			routeOrigin.innerHTML = `<strong>נקודת מוצא:</strong> ${escapeHtml(label)}`;
		}
	}

	function buildRouteCandidates(lat, lng, limit = 6) {
		const sorted = getSearchableStations()
			.map((station) => {
				const stationLat = toFiniteNumber(station.lat);
				const stationLon = toFiniteNumber(station.lon);
				const directDistance = stationLat !== null && stationLon !== null
					? Math.round(map.distance([lat, lng], [stationLat, stationLon]))
					: Number.POSITIVE_INFINITY;

				return {
					...station,
					lat: stationLat,
					lon: stationLon,
					displayName: getStationDisplayName(station),
					key: getStationKey(station),
					directDistance
				};
			})
			.filter((station) => station.lat !== null && station.lon !== null)
			.sort((a, b) => a.directDistance - b.directDistance);

		const deduped = [];
		const seenNames = new Set();
		for (const station of sorted) {
			const dedupeName = normalizeText(station.name_he || station.name || station.displayName || '');
			if (dedupeName && seenNames.has(dedupeName)) continue;
			if (dedupeName) seenNames.add(dedupeName);

			deduped.push(station);
			if (deduped.length >= limit) break;
		}

		return deduped;
	}

	function renderRoutePanel(originLabel, candidates, selectedStationKey) {
		if (!candidates.length) {
			routeInfoDiv.innerHTML = '<p>אין תחנות זמינות כרגע.</p>';
			return;
		}

		const stationsHtml = candidates.map((station, index) => {
			const isActive = station.key === selectedStationKey;
			return `
				<button
					type="button"
					class="route-station-btn${isActive ? ' active' : ''}"
					data-route-index="${index}"
					data-station-key="${escapeHtml(station.key)}"
				>
					<span class="route-station-name">${escapeHtml(station.displayName)}</span>
					<span class="route-station-distance">~${station.directDistance} מ'</span>
				</button>
			`;
		}).join('');

		routeInfoDiv.innerHTML = `
			<h3>מסלולי הליכה לתחנות</h3>
			<p class="route-origin" id="route-origin-label"><strong>נקודת מוצא:</strong> ${escapeHtml(originLabel)}</p>
			<div class="route-stations-list">${stationsHtml}</div>
			<div id="route-details"><div id="loading">מחשב מסלול...</div></div>
		`;
	}

	function refreshRouteCandidatesForCurrentSelection() {
		if (!currentSelectionLocation) return;

		routeCandidates = buildRouteCandidates(currentSelectionLocation.lat, currentSelectionLocation.lng, 7);
		const preferredStation = routeCandidates.find((station) => station.key === selectedRouteStationKey) || routeCandidates[0];

		selectedRouteStationKey = preferredStation ? preferredStation.key : '';
		renderRoutePanel(currentSelectionLocation.label, routeCandidates, selectedRouteStationKey);

		if (preferredStation) {
			calculateRoute(
				currentSelectionLocation.lat,
				currentSelectionLocation.lng,
				preferredStation,
				currentSelectionLocation.selectionId
			);
		} else {
			clearRouteLine();
			setRouteDetailsHtml('<p>אין תחנות זמינות כרגע.</p>');
		}
	}

	function getIsochroneStyle(station) {
		if (station && station.isPlanned) {
			if (station.line === 'purple') {
				return { color: '#7e22ce', fillColor: '#a855f7', fillOpacity: 0.16, weight: 2, interactive: false };
			}
			return { color: '#16a34a', fillColor: '#34d399', fillOpacity: 0.16, weight: 2, interactive: false };
		}

		return { color: '#34d399', fillColor: '#34d399', fillOpacity: 0.2, weight: 2, interactive: false };
	}

	function updateIsochrones(minutes) {
		currentIsochroneLayerGroup.clearLayers();
		const activeStations = [...stationsData, ...getActivePlannedStations()];
		activeStations.forEach((station) => {
			const name = getStationIsochroneName(station);
			const polys = isochroneData[name];
			if (polys && polys[minutes]) {
				L.geoJSON(polys[minutes], {
					style: getIsochroneStyle(station),
					interactive: false
				}).addTo(currentIsochroneLayerGroup);
				return;
			}

			if (station.isPlanned) {
				const lat = toFiniteNumber(station.lat);
				const lon = toFiniteNumber(station.lon);
				if (lat === null || lon === null) return;

				L.circle([lat, lon], {
					...getIsochroneStyle(station),
					radius: Math.max(120, minutes * 80)
				}).addTo(currentIsochroneLayerGroup);
			}
		});
	}

	function calculateRoute(lat, lng, station, selectionId) {
		if (!station) return;

		selectedRouteStationKey = station.key;
		highlightRouteStation(station.key);
		setRouteDetailsHtml('<div id="loading">מחשב מסלול...</div>');

		abortActiveRouteRequest();
		activeRouteController = new AbortController();

		const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${lng},${lat};${station.lon},${station.lat}?overview=full&geometries=geojson`;
		fetch(url, { signal: activeRouteController.signal })
			.then((res) => {
				if (!res.ok) throw new Error(`Routing API failed: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (selectionId !== activeSelectionId) return;
				if (!(data.routes && data.routes[0])) throw new Error('No route returned');

				const route = data.routes[0];
				const distanceMeters = Math.round(route.distance);

				currentRouteStats = {
					stationKey: station.key,
					stationName: station.displayName,
					distanceMeters
				};

				renderRouteDetails(station.displayName, distanceMeters);

				clearRouteLine();
				currentRouteLine = L.geoJSON(route.geometry, {
					style: { color: '#3b82f6', weight: 5, opacity: 0.8 }
				}).addTo(map);
			})
			.catch((error) => {
				if (error.name === 'AbortError') return;
				if (selectionId !== activeSelectionId) return;
				console.error('Route calculation error:', error);

				currentRouteStats = null;
				clearRouteLine();
				setRouteDetailsHtml('<p>לא הצלחנו לחשב מסלול הליכה כרגע. נסו שוב בעוד רגע.</p>');
			})
			.finally(() => {
				if (selectionId === activeSelectionId) {
					activeRouteController = null;
				}
			});
	}

	function handleLocationSelect(latRaw, lngRaw, label, options = {}) {
		const lat = toFiniteNumber(latRaw);
		const lng = toFiniteNumber(lngRaw);
		if (lat === null || lng === null) return null;

		activeSelectionId += 1;
		const selectionId = activeSelectionId;

		clearRouteLine();
		abortActiveRouteRequest();
		currentRouteStats = null;

		if (currentPin) map.removeLayer(currentPin);

		map.flyTo([lat, lng], 16, { duration: 0.8 });
		currentPin = L.marker([lat, lng], { icon: userIcon }).addTo(map).bindPopup(label).openPopup();
		clearMapBtn.classList.remove('hidden');

		currentSelectionLocation = { lat, lng, label, selectionId };

		if (stationsData.length === 0) {
			routeInfoDiv.innerHTML = '<p>טוען תחנות...</p>';
			return selectionId;
		}

		routeCandidates = buildRouteCandidates(lat, lng, 7);
		const preferredStationKey = options.preferredStationKey || selectedRouteStationKey;
		const preferredStation = routeCandidates.find((station) => station.key === preferredStationKey);
		const initialStation = preferredStation || routeCandidates[0];

		selectedRouteStationKey = initialStation ? initialStation.key : '';
		renderRoutePanel(label, routeCandidates, selectedRouteStationKey);

		if (initialStation) {
			calculateRoute(lat, lng, initialStation, selectionId);
		}

		return selectionId;
	}

	function findNeighborhoodLocally(lat, lng) {
		if (!window.turf) return null;
		const pt = turf.point([lng, lat]);
		let best = null;
		let minArea = Infinity;

		for (const poly of neighborhoodCache.values()) {
			try {
				if (turf.booleanPointInPolygon(pt, poly)) {
					const area = turf.area(poly);
					if (area < minArea) {
						minArea = area;
						best = poly;
					}
				}
			} catch (error) {
				// Ignore malformed polygons
			}
		}

		return best;
	}

	function drawNeighborhood(geojson) {
		if (!geojson) return;
		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);
		currentNeighborhoodLayer = L.geoJSON(geojson, {
			style: { color: '#ff9f1c', weight: 4, dashArray: '10, 10', fillColor: '#ff9f1c', fillOpacity: 0.1 }
		}).addTo(map);
	}

	function updateClearSearchButton() {
		if (!clearSearchBtn) return;
		const hasValue = searchInput.value.trim().length > 0;
		clearSearchBtn.classList.toggle('hidden', !hasValue);
	}

	function resetSearchState() {
		renderedSearchItems = [];
		highlightedSearchIndex = -1;

		if (searchDebounceId) {
			clearTimeout(searchDebounceId);
			searchDebounceId = null;
		}

		if (activeSearchController) {
			activeSearchController.abort();
			activeSearchController = null;
		}
	}

	function hideSearchResults() {
		searchResults.innerHTML = '';
		searchResults.classList.add('hidden');
		searchInput.setAttribute('aria-expanded', 'false');
		renderedSearchItems = [];
		highlightedSearchIndex = -1;
	}

	function renderSearchStatus(message, isError = false) {
		searchResults.innerHTML = '';
		const li = document.createElement('li');
		li.className = `search-status${isError ? ' search-status-error' : ''}`;
		li.textContent = message;
		searchResults.appendChild(li);
		searchResults.classList.remove('hidden');
		searchInput.setAttribute('aria-expanded', 'true');
		renderedSearchItems = [];
		highlightedSearchIndex = -1;
	}

	function updateHighlightedResult() {
		const nodes = searchResults.querySelectorAll('.search-result-item');
		nodes.forEach((node, index) => {
			const isActive = index === highlightedSearchIndex;
			node.classList.toggle('active', isActive);
			node.setAttribute('aria-selected', isActive ? 'true' : 'false');
		});
	}

	function selectSearchItem(item) {
		if (!item) return;

		hideSearchResults();
		searchInput.value = item.label || '';
		updateClearSearchButton();

		if (item.geojson) drawNeighborhood(item.geojson);

		const lat = toFiniteNumber(item.lat);
		const lon = toFiniteNumber(item.lon);
		if (lat !== null && lon !== null) {
			handleLocationSelect(lat, lon, item.label || 'בחירה מהמפה');
			return;
		}

		const center = getGeojsonCenter(item.geojson);
		if (center) {
			handleLocationSelect(center.lat, center.lon, item.label || 'בחירה מהמפה');
		}
	}

	function renderSearchResults(items, { appendLoading = false, emptyMessage = '' } = {}) {
		searchResults.innerHTML = '';
		renderedSearchItems = items.slice(0, 10);
		highlightedSearchIndex = -1;

		renderedSearchItems.forEach((item) => {
			const li = document.createElement('li');
			li.className = 'search-result-item';
			li.setAttribute('role', 'option');
			li.setAttribute('aria-selected', 'false');

			const typeLabel = item.typeLabel ? `<span class="search-result-type">${escapeHtml(item.typeLabel)}</span>` : '';
			const secondaryLabel = item.secondaryLabel
				? `<div class="search-result-secondary">${escapeHtml(item.secondaryLabel)}</div>`
				: '';

			li.innerHTML = `
				<div class="search-result-main">${escapeHtml(item.label)}</div>
				${secondaryLabel}
				${typeLabel}
			`;

			li.addEventListener('click', () => selectSearchItem(item));
			searchResults.appendChild(li);
		});

		if (renderedSearchItems.length === 0 && emptyMessage) {
			const li = document.createElement('li');
			li.className = 'search-status';
			li.textContent = emptyMessage;
			searchResults.appendChild(li);
		}

		if (appendLoading) {
			const li = document.createElement('li');
			li.className = 'search-status';
			li.textContent = 'מחפש כתובות נוספות...';
			searchResults.appendChild(li);
		}

		if (searchResults.children.length > 0) {
			searchResults.classList.remove('hidden');
			searchInput.setAttribute('aria-expanded', 'true');
		} else {
			hideSearchResults();
		}
	}

	function buildLocalSearchMatches(query) {
		const normalizedQuery = normalizeSearchText(query);
		const localMatches = [];
		const dedupe = new Set();

		for (const [name, poly] of neighborhoodCache.entries()) {
			const normalizedName = normalizeSearchText(name);
			if (!normalizedName || !normalizedName.includes(normalizedQuery)) continue;

			const key = `neighborhood:${normalizedName}`;
			if (dedupe.has(key)) continue;
			dedupe.add(key);

			const center = getGeojsonCenter(poly);
			localMatches.push({
				label: name,
				secondaryLabel: 'גבול שכונה מקומי',
				lat: center ? center.lat : null,
				lon: center ? center.lon : null,
				geojson: poly,
				type: 'neighborhood',
				typeLabel: 'שכונה'
			});
		}

		getSearchableStations().forEach((station) => {
			const displayName = getStationDisplayName(station);
			const normalizedName = normalizeSearchText(displayName);
			if (!normalizedName || !normalizedName.includes(normalizedQuery)) return;

			const key = `station:${normalizedName}`;
			if (dedupe.has(key)) return;
			dedupe.add(key);

			const secondaryLabel = station.isPlanned
				? `תחנה מתוכננת - קו ${getPlannedLineLabel(station.line)}`
				: 'תחנת רכבת קלה';

			localMatches.push({
				label: displayName,
				secondaryLabel,
				lat: toFiniteNumber(station.lat),
				lon: toFiniteNumber(station.lon),
				geojson: null,
				type: 'station',
				typeLabel: station.isPlanned ? 'תחנה עתידית' : 'תחנה'
			});
		});

		return localMatches;
	}

	function fetchExternalSearchResults(query, localMatches, requestId) {
		if (activeSearchController) activeSearchController.abort();
		activeSearchController = new AbortController();

		const params = new URLSearchParams({
			q: query,
			format: 'jsonv2',
			countrycodes: 'il',
			'accept-language': 'he,en',
			limit: '12',
			addressdetails: '1',
			polygon_geojson: '1',
			dedupe: '1',
			viewbox: '34.70,32.15,34.95,31.93'
		});

		fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
			signal: activeSearchController.signal
		})
			.then((res) => {
				if (!res.ok) throw new Error(`Search API failed: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (requestId !== activeSearchRequestId) return;

				const externalItems = Array.isArray(data)
					? data.map((item) => {
						const formatted = formatSearchAddress(item);
						return {
							label: formatted.label,
							secondaryLabel: formatted.secondaryLabel,
							lat: toFiniteNumber(item.lat),
							lon: toFiniteNumber(item.lon),
							geojson: item.geojson || null,
							type: 'address',
							typeLabel: null
						};
					}).filter((item) => Boolean(item.label))
					: [];

				const mergedMap = new Map();
				[...localMatches, ...externalItems].forEach((item) => {
					const key = getSearchItemKey(item);
					if (!mergedMap.has(key)) mergedMap.set(key, item);
				});

				const normalizedQuery = normalizeSearchText(query);
				const mergedItems = Array.from(mergedMap.values())
					.sort((a, b) => scoreSearchItem(b, normalizedQuery) - scoreSearchItem(a, normalizedQuery))
					.slice(0, 10);

				renderSearchResults(mergedItems, { emptyMessage: 'לא נמצאו תוצאות מתאימות.' });
			})
			.catch((error) => {
				if (error.name === 'AbortError') return;
				console.error('Search error:', error);
				if (requestId !== activeSearchRequestId) return;
				renderSearchResults(localMatches, {
					emptyMessage: 'לא הצלחנו לטעון כתובות כרגע. נסו שוב.'
				});
			})
			.finally(() => {
				if (requestId === activeSearchRequestId) activeSearchController = null;
			});
	}

	function searchLocations(query) {
		const normalizedQuery = normalizeSearchText(query);
		if (normalizedQuery.length < 2) {
			resetSearchState();
			hideSearchResults();
			return;
		}

		const localMatches = buildLocalSearchMatches(query)
			.sort((a, b) => scoreSearchItem(b, normalizedQuery) - scoreSearchItem(a, normalizedQuery))
			.slice(0, 5);

		if (localMatches.length > 0) {
			renderSearchResults(localMatches, { appendLoading: true });
		} else {
			renderSearchStatus('מחפש כתובות...');
		}

		activeSearchRequestId += 1;
		const requestId = activeSearchRequestId;

		if (searchDebounceId) clearTimeout(searchDebounceId);
		searchDebounceId = setTimeout(() => {
			fetchExternalSearchResults(query, localMatches, requestId);
		}, 300);
	}

	function clearMap() {
		activeSelectionId += 1;
		abortActiveRouteRequest();

		if (currentPin) map.removeLayer(currentPin);
		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);
		clearRouteLine();

		currentPin = null;
		currentNeighborhoodLayer = null;
		currentSelectionLocation = null;
		routeCandidates = [];
		selectedRouteStationKey = '';
		currentRouteStats = null;

		clearMapBtn.classList.add('hidden');
		routeInfoDiv.innerHTML = '';
		searchInput.value = '';
		updateClearSearchButton();
		resetSearchState();
		hideSearchResults();
	}

	// --- Data Loading ---
	fetch('stations.json?v=1')
		.then((res) => {
			if (!res.ok) throw new Error(`Failed to load stations (${res.status})`);
			return res.json();
		})
		.then((data) => {
			stationsData = data;
			const stationGroup = L.featureGroup().addTo(map);
			data.forEach((station) => {
				const name = getStationDisplayName(station);
				const marker = L.marker([station.lat, station.lon], { icon: stationIcon }).addTo(stationGroup);
				marker.bindTooltip(name, {
					permanent: true,
					direction: 'bottom',
					className: 'station-label',
					offset: [0, 5]
				});
				marker.bindPopup(`<div class="station-popup-title">${escapeHtml(name)}</div>`, { className: 'custom-popup' });
				marker.on('click', () => map.setView([station.lat, station.lon], 16));
			});

			if (Object.keys(isochroneData).length > 0) {
				updateIsochrones(walkingMinutes);
			}
		})
		.catch((error) => {
			console.error('Failed to load stations:', error);
		});

	fetch('station_isochrones.json?v=1')
		.then((res) => {
			if (!res.ok) throw new Error(`Failed to load isochrones (${res.status})`);
			return res.json();
		})
		.then((data) => {
			isochroneData = data;
			if (stationsData.length > 0) {
				updateIsochrones(walkingMinutes);
			}
		})
		.catch((error) => {
			console.error('Failed to load station isochrones:', error);
		});

	fetch('neighborhoods.json?v=1')
		.then((res) => {
			if (!res.ok) throw new Error(`Failed to load neighborhoods (${res.status})`);
			return res.json();
		})
		.then((data) => {
			Object.keys(data).forEach((key) => neighborhoodCache.set(key, data[key]));
		})
		.catch((error) => {
			console.error('Failed to load neighborhoods:', error);
		});

	fetch('planned_stations.json?v=1')
		.then((res) => {
			if (!res.ok) throw new Error(`Failed to load planned stations (${res.status})`);
			return res.json();
		})
		.then((data) => {
			plannedStationsData = Array.isArray(data) ? data : [];
			plannedStationsByLine.green = [];
			plannedStationsByLine.purple = [];
			plannedLayerByLine.green.clearLayers();
			plannedLayerByLine.purple.clearLayers();

			plannedStationsData.forEach((stationRaw) => {
				const line = stationRaw.line === 'purple' ? 'purple' : stationRaw.line === 'green' ? 'green' : '';
				if (!line) return;

				const lat = toFiniteNumber(stationRaw.lat);
				const lon = toFiniteNumber(stationRaw.lon);
				if (lat === null || lon === null) return;

				const station = {
					...stationRaw,
					lat,
					lon,
					isPlanned: true,
					name: stationRaw.name_he || stationRaw.name || 'תחנה מתוכננת'
				};

				plannedStationsByLine[line].push(station);

				const marker = L.marker([lat, lon], { icon: getPlannedIcon(line) });
				marker.bindTooltip(station.name_he || station.name || 'תחנה מתוכננת', {
					permanent: false,
					direction: 'bottom',
					className: 'station-label planned-station-label',
					offset: [0, 6]
				});

				marker.bindPopup(
					`<div class="station-popup-title">${escapeHtml(station.name_he || station.name || 'תחנה מתוכננת')}</div>` +
					`<div class="station-popup-detail">קו ${escapeHtml(getPlannedLineLabel(line))} • ${escapeHtml(station.status || 'מתוכנן')}</div>`,
					{ className: 'custom-popup' }
				);

				marker.addTo(plannedLayerByLine[line]);
			});

			if (plannedGreenToggle) {
				plannedGreenToggle.disabled = plannedStationsByLine.green.length === 0;
			}
			if (plannedPurpleToggle) {
				plannedPurpleToggle.disabled = plannedStationsByLine.purple.length === 0;
			}

			applyPlannedLayersVisibility();
			updateIsochrones(walkingMinutes);
		})
		.catch((error) => {
			console.error('Failed to load planned stations:', error);
			if (plannedGreenToggle) plannedGreenToggle.disabled = true;
			if (plannedPurpleToggle) plannedPurpleToggle.disabled = true;
		});

	// --- Event Listeners ---
	slider.addEventListener('input', (event) => {
		walkingMinutes = parseInt(event.target.value, 10) || walkingMinutes;
		radiusValue.textContent = String(walkingMinutes);
		updateIsochrones(walkingMinutes);

		if (currentRouteStats) {
			renderRouteDetails(currentRouteStats.stationName, currentRouteStats.distanceMeters);
		}
	});

	routeInfoDiv.addEventListener('click', (event) => {
		const button = event.target.closest('.route-station-btn');
		if (!button || !currentSelectionLocation) return;

		const index = parseInt(button.dataset.routeIndex || '', 10);
		if (!Number.isFinite(index)) return;

		const station = routeCandidates[index];
		if (!station) return;

		calculateRoute(
			currentSelectionLocation.lat,
			currentSelectionLocation.lng,
			station,
			currentSelectionLocation.selectionId
		);
	});

	map.on('click', (event) => {
		const { lat, lng } = event.latlng;

		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);

		const localNeighborhood = findNeighborhoodLocally(lat, lng);
		if (localNeighborhood) drawNeighborhood(localNeighborhood);

		const selectionId = handleLocationSelect(lat, lng, 'מאתר כתובת...');
		if (!selectionId) return;

		fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=he,en`)
			.then((res) => {
				if (!res.ok) throw new Error(`Reverse geocode failed: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (selectionId !== activeSelectionId || !currentPin) return;

				const label = formatAddress(data);
				currentPin.setPopupContent(label).openPopup();

				if (currentSelectionLocation && currentSelectionLocation.selectionId === selectionId) {
					currentSelectionLocation.label = label;
					updateRouteOriginLabel(label);
				}

				const addr = data.address || {};
				const hood = addr.neighbourhood || addr.suburb || addr.residential || addr.quarter;
				if (!localNeighborhood && hood) {
					fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${hood}, תל אביב`)}&format=jsonv2&polygon_geojson=1&limit=1`)
						.then((r) => r.json())
						.then((items) => {
							if (selectionId !== activeSelectionId) return;
							if (items[0] && items[0].geojson) drawNeighborhood(items[0].geojson);
						})
						.catch(() => { });
				}
			})
			.catch((error) => {
				console.error('Reverse geocoding error:', error);
				if (selectionId === activeSelectionId && currentPin) {
					currentPin.setPopupContent(`${lat.toFixed(5)}, ${lng.toFixed(5)}`).openPopup();
				}
			});
	});

	searchInput.addEventListener('input', (event) => {
		const query = event.target.value.trim();
		updateClearSearchButton();
		searchLocations(query);
	});

	searchInput.addEventListener('keydown', (event) => {
		if (searchResults.classList.contains('hidden') || renderedSearchItems.length === 0) {
			if (event.key === 'Escape') hideSearchResults();
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			highlightedSearchIndex = (highlightedSearchIndex + 1) % renderedSearchItems.length;
			updateHighlightedResult();
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			highlightedSearchIndex = highlightedSearchIndex <= 0
				? renderedSearchItems.length - 1
				: highlightedSearchIndex - 1;
			updateHighlightedResult();
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			const picked = highlightedSearchIndex >= 0
				? renderedSearchItems[highlightedSearchIndex]
				: renderedSearchItems[0];
			selectSearchItem(picked);
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			hideSearchResults();
		}
	});

	searchInput.addEventListener('focus', () => {
		const query = searchInput.value.trim();
		if (query.length >= 2 && searchResults.classList.contains('hidden')) {
			searchLocations(query);
		}
	});

	document.addEventListener('click', (event) => {
		if (!event.target.closest('.search-container')) {
			hideSearchResults();
		}
	});

	if (clearSearchBtn) {
		clearSearchBtn.addEventListener('click', (event) => {
			event.preventDefault();
			searchInput.value = '';
			updateClearSearchButton();
			resetSearchState();
			hideSearchResults();
			searchInput.focus();
		});
	}

	if (plannedGreenToggle) {
		activePlannedLines.green = Boolean(plannedGreenToggle.checked);
		plannedGreenToggle.addEventListener('change', () => {
			activePlannedLines.green = Boolean(plannedGreenToggle.checked);
			applyPlannedLayersVisibility();
			updateIsochrones(walkingMinutes);
			refreshRouteCandidatesForCurrentSelection();

			const query = searchInput.value.trim();
			if (query.length >= 2) searchLocations(query);
		});
	}

	if (plannedPurpleToggle) {
		activePlannedLines.purple = Boolean(plannedPurpleToggle.checked);
		plannedPurpleToggle.addEventListener('change', () => {
			activePlannedLines.purple = Boolean(plannedPurpleToggle.checked);
			applyPlannedLayersVisibility();
			updateIsochrones(walkingMinutes);
			refreshRouteCandidatesForCurrentSelection();

			const query = searchInput.value.trim();
			if (query.length >= 2) searchLocations(query);
		});
	}

	clearMapBtn.addEventListener('click', clearMap);

	if (locateBtn) {
		locateBtn.addEventListener('click', () => {
			if (!navigator.geolocation) {
				alert('דפדפן זה אינו תומך בזיהוי מיקום');
				return;
			}

			locateBtn.classList.add('loading');
			navigator.geolocation.getCurrentPosition(
				(position) => {
					locateBtn.classList.remove('loading');
					const { latitude, longitude } = position.coords;
					if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);
					const localNeighborhood = findNeighborhoodLocally(latitude, longitude);
					if (localNeighborhood) drawNeighborhood(localNeighborhood);
					handleLocationSelect(latitude, longitude, 'המיקום הנוכחי שלך');
				},
				(error) => {
					locateBtn.classList.remove('loading');
					console.error('Geolocation error:', error);
					alert('לא ניתן היה למצוא את מיקומך');
				}
			);
		});
	}

	// --- Draggable Mobile Panel ---
	const toggleBtn = document.getElementById('toggle-panel-btn');
	const infoPanel = document.querySelector('.info-panel');
	const header = document.querySelector('.panel-header');
	let isDragging = false;
	let startY = 0;
	let startHeight = 0;

	if (toggleBtn && infoPanel) {
		L.DomEvent.disableClickPropagation(infoPanel);
		L.DomEvent.disableScrollPropagation(infoPanel);

		infoPanel.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });

		toggleBtn.addEventListener('click', (event) => {
			event.preventDefault();
			const isCollapsed = infoPanel.classList.toggle('collapsed');
			toggleBtn.textContent = isCollapsed ? 'הצג פרטים' : 'הסתר פרטים';
			infoPanel.style.maxHeight = isCollapsed ? '70px' : '45vh';
			infoPanel.style.height = isCollapsed ? '70px' : 'auto';
		});
	}

	if (header && infoPanel) {
		const touchStart = (event) => {
			if (event.target === toggleBtn) return;
			isDragging = true;
			startY = event.touches[0].clientY;
			startHeight = infoPanel.offsetHeight;
			infoPanel.style.transition = 'none';
		};

		const touchMove = (event) => {
			if (!isDragging) return;
			if (event.cancelable) event.preventDefault();

			const currentY = event.touches[0].clientY;
			const deltaY = startY - currentY;
			const newHeight = startHeight + deltaY;
			const maxHeight = window.innerHeight * 0.95;
			const minHeight = 70;

			if (newHeight >= minHeight && newHeight <= maxHeight) {
				infoPanel.style.height = `${newHeight}px`;
				infoPanel.style.maxHeight = `${newHeight}px`;
				if (toggleBtn) toggleBtn.textContent = newHeight < 150 ? 'הצג פרטים' : 'הסתר פרטים';
			}
		};

		const touchEnd = () => {
			if (!isDragging) return;
			isDragging = false;
			infoPanel.style.transition = 'all 0.3s ease';

			const height = infoPanel.offsetHeight;
			if (height < 120) {
				infoPanel.classList.add('collapsed');
				infoPanel.style.height = '70px';
				infoPanel.style.maxHeight = '70px';
				if (toggleBtn) toggleBtn.textContent = 'הצג פרטים';
			} else {
				infoPanel.classList.remove('collapsed');
				infoPanel.style.maxHeight = `${height}px`;
				infoPanel.style.height = `${height}px`;
				if (toggleBtn) toggleBtn.textContent = 'הסתר פרטים';
			}
		};

		header.addEventListener('touchstart', touchStart, { passive: true });
		window.addEventListener('touchmove', touchMove, { passive: false });
		window.addEventListener('touchend', touchEnd, { passive: true });
	}

	applyPlannedLayersVisibility();
	updateClearSearchButton();
});