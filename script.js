var __neighborhoodCache = new Map(); // Global backup if needed

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

	// --- State ---
	let stationsData = [];
	let isochroneData = {};
	let currentIsochroneLayerGroup = L.layerGroup().addTo(map);
	let currentNeighborhoodLayer = null;
	let currentRouteLine = null;
	let currentPin = null;
	let walkingMinutes = 5;
	const neighborhoodCache = new Map();

	// --- Icons ---
	const stationIcon = L.divIcon({
		className: 'station-icon',
		html: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h0"/><path d="M16 15h0"/></svg>`,
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

	// --- Data Loading ---
	fetch('stations.json?v=1')
		.then(res => res.json())
		.then(data => {
			stationsData = data;
			const stationGroup = L.featureGroup().addTo(map);
			data.forEach(station => {
				const name = station.name_he || station.name;
				const marker = L.marker([station.lat, station.lon], { icon: stationIcon }).addTo(stationGroup);
				marker.bindTooltip(name, { permanent: true, direction: 'bottom', className: 'station-label', offset: [0, 5] });
				marker.bindPopup(`<div class="station-popup-title">${name}</div>`, { className: 'custom-popup' });
				marker.on('click', () => map.setView([station.lat, station.lon], 16));
			});
			if (Object.keys(isochroneData).length > 0) updateIsochrones(walkingMinutes);
		});

	fetch('station_isochrones.json?v=1')
		.then(res => res.json())
		.then(data => {
			isochroneData = data;
			if (stationsData.length > 0) updateIsochrones(walkingMinutes);
		});

	fetch('neighborhoods.json?v=1')
		.then(res => res.json())
		.then(data => Object.keys(data).forEach(k => neighborhoodCache.set(k, data[k])));

	// --- Core Logic ---
	function updateIsochrones(minutes) {
		currentIsochroneLayerGroup.clearLayers();
		stationsData.forEach(station => {
			const name = station.name_he || station.name;
			const polys = isochroneData[name];
			if (polys && polys[minutes]) {
				L.geoJSON(polys[minutes], {
					style: { color: '#34d399', fillColor: '#34d399', fillOpacity: 0.2, weight: 2 },
					interactive: false
				}).addTo(currentIsochroneLayerGroup);
			}
		});
	}

	function handleLocationSelect(lat_raw, lng_raw, label) {
		const lat = parseFloat(lat_raw);
		const lng = parseFloat(lng_raw);
		if (currentRouteLine) map.removeLayer(currentRouteLine);
		if (currentPin) map.removeLayer(currentPin);
		const routeInfoDiv = document.getElementById('route-info');
		routeInfoDiv.innerHTML = '<div id="loading">מחשב...</div>';

		map.flyTo([lat, lng], 16, { duration: 0.8 });
		currentPin = L.marker([lat, lng], { icon: userIcon }).addTo(map).bindPopup(label).openPopup();
		document.getElementById('clear-map-btn').classList.remove('hidden');

		if (stationsData.length === 0) return;
		let closest = null; let minDist = Infinity;
		stationsData.forEach(s => {
			const d = map.distance([lat, lng], [s.lat, s.lon]);
			if (d < minDist) { minDist = d; closest = s; }
		});
		if (closest) calculateRoute(lat, lng, closest);
	}

	function calculateRoute(lat, lng, station) {
		const name = station.name_he || station.name;
		// Use routing.openstreetmap.de for consistency with Valhalla data
		const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${lng},${lat};${station.lon},${station.lat}?overview=full&geometries=geojson`;
		fetch(url).then(res => res.json()).then(data => {
			if (data.routes && data.routes[0]) {
				const route = data.routes[0];
				const dist = Math.round(route.distance);

				// Enforce consistency: 80 meters per minute (Human walking speed)
				const minutes = Math.max(1, Math.round(dist / 80));
				const isClose = minutes <= walkingMinutes;

				document.getElementById('route-info').innerHTML = `
					<h3>פרטי מסלול</h3>
					<p><strong>יעד:</strong> ${name}</p>
					<p><strong>זמן הליכה:</strong> <span style="font-size: 1.2rem; font-weight: bold;">${minutes} דק'</span></p>
					<p><strong>מרחק:</strong> ${dist} מטרים</p>
					<p style="color: ${isClose ? '#2a9d8f' : '#e63946'}; font-weight: 600; margin-top: 10px;">
						${isClose ? `מצויין! בטווח ${walkingMinutes} דקות.` : `יותר מ-${walkingMinutes} דקות הליכה.`}
					</p>
				`;
				if (currentRouteLine) map.removeLayer(currentRouteLine);
				currentRouteLine = L.geoJSON(route.geometry, { style: { color: '#3b82f6', weight: 5, opacity: 0.8 } }).addTo(map);
			}
		});
	}

	// --- Neighborhoods ---
	function findNeighborhoodLocally(lat, lng) {
		if (!window.turf) return null;
		const pt = turf.point([lng, lat]);
		let best = null; let minArea = Infinity;
		for (const [key, poly] of neighborhoodCache) {
			try {
				if (turf.booleanPointInPolygon(pt, poly)) {
					const area = turf.area(poly);
					if (area < minArea) { minArea = area; best = poly; }
				}
			} catch (e) { }
		}
		return best;
	}

	function drawNeighborhood(geojson) {
		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);
		currentNeighborhoodLayer = L.geoJSON(geojson, {
			style: { color: '#ff9f1c', weight: 4, dashArray: '10, 10', fillColor: '#ff9f1c', fillOpacity: 0.1 }
		}).addTo(map);
	}

	function formatAddress(data) {
		const addr = data.address || {};
		const street = addr.road || addr.pedestrian || "";
		const number = addr.house_number || "";
		const neighborhood = addr.neighbourhood || addr.suburb || addr.residential || addr.quarter || "";
		const city = addr.city || addr.town || addr.village || "";

		let streetPart = street;
		if (number) streetPart += " " + number;

		let components = [];
		if (streetPart) components.push(streetPart);
		if (neighborhood) components.push(neighborhood);
		if (city) components.push(city);

		if (components.length === 0) return data.display_name.split(',')[0];
		return components.join(', ');
	}

	// --- Event Listeners ---
	const slider = document.getElementById('radius-slider');
	const radiusValue = document.getElementById('radius-value');
	slider.addEventListener('input', (e) => {
		walkingMinutes = parseInt(e.target.value);
		radiusValue.textContent = walkingMinutes;
		updateIsochrones(walkingMinutes);
		// Update existing route info if pin exists
		if (currentPin) {
			const latlng = currentPin.getLatLng();
			handleLocationSelect(latlng.lat, latlng.lng, currentPin.getPopup().getContent());
		}
	});

	map.on('click', (e) => {
		const { lat, lng } = e.latlng;
		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);
		const local = findNeighborhoodLocally(lat, lng);
		if (local) drawNeighborhood(local);

		handleLocationSelect(lat, lng, "מאתר כתובת...");
		fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=he`)
			.then(res => res.json())
			.then(data => {
				const label = formatAddress(data);
				currentPin.setPopupContent(label).openPopup();

				const addr = data.address || {};
				const hood = addr.neighbourhood || addr.suburb || addr.residential || addr.quarter;
				if (!local && hood) {
					// Minimal boundary fetch if local miss
					fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(hood + ', תל אביב')}&format=json&polygon_geojson=1&limit=1`)
						.then(r => r.json()).then(d => { if (d[0] && d[0].geojson) drawNeighborhood(d[0].geojson); });
				}
			});
	});

	// --- Search ---
	const searchInput = document.getElementById('search-input');
	const results = document.getElementById('search-results');

	searchInput.addEventListener('input', (e) => {
		const q = e.target.value.trim();
		if (q.length < 3) { results.innerHTML = ''; results.classList.add('hidden'); return; }

		// 1. Quick Local Search (Instant)
		const localMatches = [];
		const normalizedQ = q.toLowerCase();

		// Check neighborhoods
		for (const [name, poly] of neighborhoodCache) {
			if (name.toLowerCase().includes(normalizedQ)) {
				localMatches.push({ label: name, lat: null, lon: null, geojson: poly, type: 'neighborhood' });
			}
		}

		// Check stations
		stationsData.forEach(s => {
			const name = s.name_he || s.name;
			if (name.toLowerCase().includes(normalizedQ)) {
				localMatches.push({ label: name, lat: s.lat, lon: s.lon, type: 'station' });
			}
		});

		// Render internal matches immediately
		const renderResults = (items, isExternal = false) => {
			if (!isExternal) results.innerHTML = '';
			items.forEach(item => {
				const li = document.createElement('li');
				li.className = 'search-result-item';
				li.textContent = item.label;
				li.onclick = () => {
					results.classList.add('hidden');
					searchInput.value = item.label;
					if (item.geojson) drawNeighborhood(item.geojson);
					if (item.lat) handleLocationSelect(item.lat, item.lon, item.label);
					else if (item.geojson && window.turf) {
						const center = turf.centerOfMass(item.geojson);
						handleLocationSelect(center.geometry.coordinates[1], center.geometry.coordinates[0], item.label);
					}
				};
				results.appendChild(li);
			});
			if (items.length > 0) results.classList.remove('hidden');
		};

		renderResults(localMatches.slice(0, 3));

		// 2. Optimized External Search (Debounced)
		clearTimeout(window._searchT);
		window._searchT = setTimeout(() => {
			// Center on Tel Aviv, Israel
			const viewbox = "34.74,32.16,34.85,32.03";
			const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&countrycodes=il&accept-language=he&limit=5&addressdetails=1&polygon_geojson=1&viewbox=${viewbox}&bounded=1`;

			fetch(url).then(r => r.json()).then(data => {
				if (!data.length) return;
				const externalItems = data.map(item => ({
					label: formatAddress(item),
					lat: item.lat,
					lon: item.lon,
					geojson: item.geojson,
					type: 'address'
				}));

				// Append external results to local ones
				renderResults(externalItems, true);
			});
		}, 150); // Faster debounce
	});

	function clearMap() {
		if (currentPin) map.removeLayer(currentPin);
		if (currentRouteLine) map.removeLayer(currentRouteLine);
		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);
		currentPin = currentRouteLine = currentNeighborhoodLayer = null;
		document.getElementById('clear-map-btn').classList.add('hidden');
		document.getElementById('route-info').innerHTML = '';
		searchInput.value = '';
	}

	document.getElementById('clear-map-btn').onclick = clearMap;

	// --- Geolocation ---
	const locateBtn = document.getElementById('locate-me-btn');
	if (locateBtn) {
		locateBtn.onclick = () => {
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
					const local = findNeighborhoodLocally(latitude, longitude);
					if (local) drawNeighborhood(local);
					handleLocationSelect(latitude, longitude, "המיקום הנוכחי שלך");
				},
				(error) => {
					locateBtn.classList.remove('loading');
					console.error('Geolocation error:', error);
					alert('לא ניתן היה למצוא את מיקומך');
				}
			);
		};
	}

	// --- Draggable Mobile Panel ---
	const toggleBtn = document.getElementById('toggle-panel-btn');
	const infoPanel = document.querySelector('.info-panel');
	const header = document.querySelector('.panel-header');
	let isDragging = false;
	let startY = 0;
	let startHeight = 0;

	if (toggleBtn && infoPanel) {
		// Prevent map from receiving clicks/scrolls when interacting with the panel
		L.DomEvent.disableClickPropagation(infoPanel);
		L.DomEvent.disableScrollPropagation(infoPanel);

		// Broadly block touchstart from bubbling to the map's drag handler
		infoPanel.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

		toggleBtn.onclick = (e) => {
			e.preventDefault();
			const isCollapsed = infoPanel.classList.toggle('collapsed');
			toggleBtn.textContent = isCollapsed ? 'הצג פרטים' : 'הסתר פרטים';
			infoPanel.style.maxHeight = isCollapsed ? '70px' : '45vh';
			infoPanel.style.height = isCollapsed ? '70px' : 'auto';
		};
	}

	if (header && infoPanel) {
		const touchStart = (e) => {
			if (e.target === toggleBtn) return;
			isDragging = true;
			startY = e.touches[0].clientY;
			startHeight = infoPanel.offsetHeight;
			infoPanel.style.transition = 'none';
		};

		const touchMove = (e) => {
			if (!isDragging) return;
			if (e.cancelable) e.preventDefault();

			const currentY = e.touches[0].clientY;
			const deltaY = startY - currentY;
			const newHeight = startHeight + deltaY;
			const maxHeight = window.innerHeight * 0.95;
			const minHeight = 70;

			if (newHeight >= minHeight && newHeight <= maxHeight) {
				infoPanel.style.height = `${newHeight}px`;
				infoPanel.style.maxHeight = `${newHeight}px`;
				if (newHeight < 150) {
					if (toggleBtn) toggleBtn.textContent = 'הצג פרטים';
				} else {
					if (toggleBtn) toggleBtn.textContent = 'הסתר פרטים';
				}
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
				// Stay at user dragged height. 
				// We keep height specifically set during the drag's end to avoid "auto" jumping
				infoPanel.style.maxHeight = `${height}px`;
				infoPanel.style.height = `${height}px`;
				if (toggleBtn) toggleBtn.textContent = 'הסתר פרטים';
			}
		};

		header.addEventListener('touchstart', touchStart, { passive: true });
		window.addEventListener('touchmove', touchMove, { passive: false });
		window.addEventListener('touchend', touchEnd, { passive: true });
	}
});
