document.addEventListener('DOMContentLoaded', () => {
	// Initialize map centered on Tel Aviv
	// Locked to the Red Line area (approx bounds: Bat Yam south to Petah Tikva east)
	const map = L.map('map', {
		minZoom: 12, // Prevent zooming out to world view
		maxBounds: [
			[31.95, 34.7], // South-West (Bat Yam / Rishon border)
			[32.15, 34.95] // North-East (Petah Tikva edge)
		]
	}).setView([32.06, 34.80], 13);

	// Move zoom control to left for RTL layout
	map.zoomControl.setPosition('topleft');

	// Zoom Listener for Labels
	map.on('zoomend', () => {
		if (map.getZoom() >= 14) {
			document.getElementById('map').classList.add('show-labels');
		} else {
			document.getElementById('map').classList.remove('show-labels');
		}
	});

	// --- Custom Icons ---
	// Tram/Metro Icon (White on Red)
	const stationIcon = L.divIcon({
		className: 'station-icon',
		html: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h0"/><path d="M16 15h0"/></svg>`,
		iconSize: [24, 24], // Slightly larger for the icon
		iconAnchor: [12, 12]
	});

	// Home/User Icon (White on Blue)
	const userIcon = L.divIcon({
		className: 'reset-transform user-icon',
		html: `<div class="user-icon-inner"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>`,
		className: 'user-icon',
		iconSize: [36, 36],
		iconAnchor: [18, 36],
		popupAnchor: [0, -36]
	});

	L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
		subdomains: 'abcd',
		maxZoom: 20
	}).addTo(map);

	let stationsData = [];
	let stationCircles = []; // Store circle references
	let currentRouteLine = null;
	let currentPin = null;

	// Default Walking Parameters
	let walkingMinutes = 5;
	const METERS_PER_MINUTE = 80; // ~4.8 km/h
	const DETOUR_FACTOR = 1.3; // Urban detour factor

	// Fetch station data with cache busting
	fetch('stations.json?v=' + new Date().getTime())
		.then(response => response.json())
		.then(stations => {
			stationsData = stations;
			const loading = document.getElementById('loading');
			if (loading) loading.style.display = 'none';

			const stationGroup = L.featureGroup().addTo(map);

			stations.forEach(station => {
				const displayName = station.name_he || station.name;

				const marker = L.marker([station.lat, station.lon], {
					title: displayName,
					icon: stationIcon
				}).addTo(stationGroup);

				// Add Label (Tooltip)
				marker.bindTooltip(displayName, {
					permanent: true,
					direction: 'bottom',
					className: 'station-label',
					offset: [0, 5]
				});

				// Initial Popup
				// Radius is scaled down by detour factor
				const radius = (walkingMinutes * METERS_PER_MINUTE) / DETOUR_FACTOR;
				marker.bindPopup(getPopupContent(displayName, walkingMinutes, radius), { className: 'custom-popup' });
				marker.on('click', () => {
					// Update popup content dynamically on click to ensure it matches current slider
					const rad = (walkingMinutes * METERS_PER_MINUTE) / DETOUR_FACTOR;
					marker.setPopupContent(getPopupContent(displayName, walkingMinutes, rad));

					// Fixed Zoom & Focus
					map.setView([station.lat, station.lon], 16);
				});

				const circle = L.circle([station.lat, station.lon], {
					color: '#e63946',
					fillColor: '#e63946',
					fillOpacity: 0.15,
					radius: radius,
					weight: 1,
					interactive: false
				}).addTo(map);

				stationCircles.push(circle);
			});
		})
		.catch(error => {
			console.error('Error fetching stations:', error);
		});

	// --- Neighborhood Visualization ---
	let currentNeighborhoodLayer = null;
	const neighborhoodCache = new Map();

	// Pre-load bundled neighborhoods
	fetch('neighborhoods.json?v=' + new Date().getTime())
		.then(res => res.json())
		.then(data => {
			Object.keys(data).forEach(key => {
				neighborhoodCache.set(key, data[key]);
			});
			console.log("Loaded bundled neighborhoods:", neighborhoodCache.size);
		})
		.catch(err => console.warn("Could not load bundled neighborhoods:", err));

	// Manual Polygons for areas missing in Nominatim (e.g., "The New North")
	function fetchNeighborhoodBoundary(neighborhood, city) {
		if (!neighborhood) return;


		// Try variations of the key to catch mismatches
		const keysToCheck = generateCacheKeys(neighborhood, city);

		// 1. Check Cache for ANY match
		for (const key of keysToCheck) {
			console.log(`[Cache Check] Requesting: '${key}'`);
			if (neighborhoodCache.has(key)) {
				console.log("[Cache HIT] Using bundled/cached neighborhood:", key);
				drawNeighborhood(neighborhoodCache.get(key));
				return;
			}
		}

		console.log("[Cache MISS] Fetching from API...");

		// If not found, fetch using the provided exact values
		// Search specifically for the boundary
		const query = `${neighborhood}, ${city || 'Tel Aviv'}`;
		const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&polygon_geojson=1&limit=1`;

		// Use the canonical key for storing the result of this specific query
		const canonicalCacheKey = `${neighborhood}_${city || 'Tel Aviv'}`;

		console.log("Fetching neighborhood:", canonicalCacheKey);

		fetch(url)
			.then(res => res.json())
			.then(data => {
				if (data && data.length > 0) {
					const result = data[0];
					const geojson = result.geojson;

					if (geojson && (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon')) {
						// 2. Save to Cache
						neighborhoodCache.set(canonicalCacheKey, geojson);
						drawNeighborhood(geojson);
					} else {
						console.warn("No valid polygon found for:", canonicalCacheKey);
					}
				} else {
					console.warn("No results found for neighborhood:", canonicalCacheKey);
				}
			})
			.catch(err => console.error("Error fetching neighborhood:", err));
	}

	function drawNeighborhood(geojson) {
		// If we decided to ignore zoom, we might still want to DRAW the neighborhood?
		// User said "instead of zooming in to the neighborhood we should zoom in to the radius".
		// They didn't say "don't show the neighborhood".
		// But zooming to radius usually implies focus there. 
		// If we draw the neighborhood boundary, it might be huge and distracting if we are zoomed in tight.
		// Let's draw it but NOT fitBounds if ignoreNeighborhoodZoom is true.

		if (currentNeighborhoodLayer) {
			map.removeLayer(currentNeighborhoodLayer);
		}

		currentNeighborhoodLayer = L.geoJSON(geojson, {
			style: {
				color: '#ff9f1c', // Orange-ish
				weight: 4, // Thicker
				dashArray: '10, 10', // Larger dashes
				fillColor: '#ff9f1c',
				fillOpacity: 0.1 // More visible fill
			}
		}).addTo(map);

		// Fixed Zoom Logic: 
		// We do NOT zoom to the neighborhood bounds anymore. 
		// We stay centered on the pin (which is set in handleLocationSelect).

		// Reset flag? No, it needs to persist for this interaction. 
		// Should reset when starting a new interaction.
	}

	function getPopupContent(name, minutes, radius) {
		return `
            <div class="station-popup-title">${name}</div>
            <div class="station-popup-detail">רדיוס הליכה: ${minutes} דקות (~${Math.round(radius)} מ')</div>
        `;
	}

	// --- Slider Logic ---
	const slider = document.getElementById('radius-slider');
	const radiusValue = document.getElementById('radius-value');

	slider.addEventListener('input', (e) => {
		walkingMinutes = parseInt(e.target.value);
		radiusValue.textContent = walkingMinutes;

		const newRadius = (walkingMinutes * METERS_PER_MINUTE) / DETOUR_FACTOR;

		// Update all circles
		stationCircles.forEach(circle => {
			circle.setRadius(newRadius);
		});
	});


	// --- Custom Auto-Complete Search ---
	const searchInput = document.getElementById('search-input');
	const searchResults = document.getElementById('search-results');
	let debounceTimer;

	searchInput.addEventListener('input', (e) => {
		const query = e.target.value;

		clearTimeout(debounceTimer);

		if (query.length < 3) {
			searchResults.innerHTML = '';
			searchResults.classList.add('hidden');
			return;
		}

		debounceTimer = setTimeout(() => {
			performSearch(query);
		}, 300);
	});

	function performSearch(query) {
		// Query param: q=query, format=json, countrycodes=il, accept-language=he, limit=5, addressdetails=1, polygon_geojson=1
		const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&countrycodes=il&accept-language=he&limit=5&addressdetails=1&polygon_geojson=1`;

		fetch(url)
			.then(res => res.json())
			.then(data => {
				displayResults(data);
			})
			.catch(err => {
				console.error("Search error:", err);
			});
	}

	function displayResults(data) {
		searchResults.innerHTML = '';

		if (!data || data.length === 0) {
			searchResults.classList.add('hidden');
			return;
		}

		data.forEach(item => {
			const li = document.createElement('li');
			li.classList.add('search-result-item');

			// Format Display Address
			let label = item.display_name;
			if (item.address) {
				const addr = item.address;
				const street = addr.road || addr.pedestrian || "";
				const number = addr.house_number || "";
				const neighborhood = addr.neighbourhood || addr.suburb || "";
				const city = addr.city || addr.town || addr.village || "";

				let simpleAddr = "";
				if (street) simpleAddr += street;
				if (number) simpleAddr += " " + number;

				let extra = [];
				if (neighborhood) extra.push(neighborhood);
				if (city && !city.includes("תל אביב")) extra.push(city);

				if (extra.length > 0) {
					simpleAddr += simpleAddr ? ` (${extra.join(', ')})` : extra.join(', ');
				}

				if (simpleAddr.trim()) label = simpleAddr;
			}

			li.textContent = label;

			li.addEventListener('click', () => {
				selectResult(item, label);
			});

			searchResults.appendChild(li);
		});

		searchResults.classList.remove('hidden');
	}

	function selectResult(item, formattedLabel) {
		// Clear Search
		searchResults.innerHTML = '';
		searchResults.classList.add('hidden');
		searchInput.value = formattedLabel || item.display_name;

		// Clear previous neighborhood
		if (currentNeighborhoodLayer) {
			map.removeLayer(currentNeighborhoodLayer);
			currentNeighborhoodLayer = null;
		}

		// Move Map
		const lat = item.lat;
		const lon = item.lon;
		// setView is handled in handleLocationSelect now for consistency, but we can call it here too
		// or just let handleLocationSelect do it.

		// Neighborhood Logic
		if (item.geojson && (item.geojson.type === 'Polygon' || item.geojson.type === 'MultiPolygon')) {
			drawNeighborhood(item.geojson);
		} else if (item.address && (item.address.neighbourhood || item.address.suburb || item.address.residential || item.address.quarter)) {
			// It's a point, so fetch the containing neighborhood
			const hood = item.address.neighbourhood || item.address.suburb || item.address.residential || item.address.quarter;
			const city = item.address.city || item.address.town || 'Tel Aviv';
			fetchNeighborhoodBoundary(hood, city);
		}

		// Add Pin & Route
		handleLocationSelect(lat, lon, formattedLabel || item.display_name);
	}

	// Hide results when clicking outside
	document.addEventListener('click', (e) => {
		if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
			searchResults.classList.add('hidden');
		}
	});


	// --- Click to Route ---
	map.on('click', function (e) {
		const lat = e.latlng.lat;
		const lng = e.latlng.lng;

		// 0. RESET: Always clear the previous neighborhood immediately!
		if (currentNeighborhoodLayer) {
			map.removeLayer(currentNeighborhoodLayer);
			currentNeighborhoodLayer = null;
		}

		// 1. Immediate Feedback: Check local cache for neighborhood
		// This makes the outline appear INSTANTLY before network requests
		const cachedGeoJSON = findNeighborhoodLocally(lat, lng);
		if (cachedGeoJSON) {
			console.log("[Local Hit] Found neighborhood in cache");
			drawNeighborhood(cachedGeoJSON);
		}

		// Start with a loading state
		handleLocationSelect(lat, lng, "מאתר כתובת...");

		// Reverse Geocode
		// We use default zoom (or 18) to get the specific address.
		// We cannot get both specific address and neighborhood polygon in one call reliably.
		const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=he`;
		fetch(url)
			.then(res => res.json())
			.then(data => {
				let label = "כתובת לא נמצאה";
				if (data && data.address) {
					const addr = data.address;
					const street = addr.road || addr.pedestrian || "";
					const number = addr.house_number || "";
					const neighborhood = addr.neighbourhood || addr.suburb || "";
					const city = addr.city || addr.town || addr.village || "";
					let formattedAddr = "";
					if (street) formattedAddr += street;
					if (number) formattedAddr += " " + number;
					if (neighborhood) formattedAddr += ` (${neighborhood})`;
					if (city && !city.includes("תל אביב")) formattedAddr += `, ${city}`;

					if (!formattedAddr.trim()) formattedAddr = data.display_name.split(',').slice(0, 3).join(',');
					label = formattedAddr;
				} else if (data && data.display_name) {
					label = data.display_name;
				}

				if (currentPin) {
					currentPin.setPopupContent(label);
					currentPin.openPopup();
				}

				// Fetch Neighborhood Boundary (Only if NOT found locally)
				if (!cachedGeoJSON && data && data.address) {
					const hood = data.address.neighbourhood || data.address.suburb || data.address.residential || data.address.quarter;
					const city = data.address.city || data.address.town || 'Tel Aviv';
					if (hood) {
						fetchNeighborhoodBoundary(hood, city);
					}
				}
			})
			.catch(err => console.error("Reverse geocoding failed", err));
	});

	function generateCacheKeys(hood, city) {
		const keys = [];
		// 1. Exact match
		keys.push(`${hood}_${city || 'Tel Aviv'}`);

		// 2. Tel Aviv variations
		if (city && (city.includes('Tel Aviv') || city.includes('תל אביב') || city.includes('תל־אביב'))) {
			keys.push(`${hood}_תל אביב`);
			keys.push(`${hood}_תל־אביב–יפו`);
			keys.push(`${hood}_Tel Aviv`);
		}

		return keys;
	}

	function findNeighborhoodLocally(lat, lng) {
		if (!turf) {
			console.error("[Turf Check] Turf.js is NOT loaded!");
			return null;
		}

		console.time("LocalLookup");
		const start = performance.now();
		const pt = turf.point([lng, lat]);

		let foundKey = null;
		let smallestArea = Infinity;

		// Iterate ALL cached neighborhoods (Map is iterable)
		for (const [key, geojson] of neighborhoodCache) {
			// Basic check: is it a valid polygon?
			if (!geojson || (geojson.type !== 'Polygon' && geojson.type !== 'MultiPolygon')) continue;

			try {
				if (turf.booleanPointInPolygon(pt, geojson)) {
					// Calculate area to find the most specific one (smallest)
					const area = turf.area(geojson);
					if (area < smallestArea) {
						smallestArea = area;
						foundKey = key;
					}
				}
			} catch (err) {
				// Ignore invalid geometry errors
			}
		}

		const end = performance.now();
		console.log(`LocalLookup: ${end - start} ms`);

		if (foundKey) {
			console.log(`[Local Hit] Found: ${foundKey} (Area: ${Math.round(smallestArea)} m2)`);
			return neighborhoodCache.get(foundKey); // Return the actual geojson
		}

		console.log(`[Local Miss] Point [${lat}, ${lng}] not found in ${neighborhoodCache.size} cached polygons.`);
		return null;
	}

	function handleLocationSelect(lat, lng, label) {
		// 1. Remove previous route/pin
		if (currentRouteLine) map.removeLayer(currentRouteLine);
		if (currentPin) map.removeLayer(currentPin);

		// Fixed Zoom Center & Focus
		// flyTo is smoother and more insistent than setView
		map.flyTo([lat, lng], 16, {
			animate: true,
			duration: 0.8 // Faster animation
		});

		// 2. Add new pin
		currentPin = L.marker([lat, lng], { icon: userIcon }).addTo(map)
			.bindPopup(label)
			.openPopup();

		// Show Clear Button
		document.getElementById('clear-map-btn').classList.remove('hidden');

		// 3. Find closest station
		if (stationsData.length === 0) return;

		let closestStation = null;
		let closestStationIndex = -1;
		let minDist = Infinity;

		stationsData.forEach((station, index) => {
			const dist = map.distance([lat, lng], [station.lat, station.lon]);
			if (dist < minDist) {
				minDist = dist;
				closestStation = station;
				closestStationIndex = index;
			}
		});

		// 4. Calculate Walking Route
		getWalkingRoute(lat, lng, closestStation);
	}

	function getWalkingRoute(startLat, startLng, station) {
		// Use Hebrew name
		const stationName = station.name_he || station.name;

		// We'll update a specific container inside info-panel instead of replacing everything
		// Note: We need to preserve the slider.
		// Let's grab the route-info div.
		let routeInfoDiv = document.getElementById('route-info');
		if (!routeInfoDiv) {
			// Fallback if structure missing (though we added it in HTML)
			const panel = document.querySelector('.info-panel');
			routeInfoDiv = document.createElement('div');
			routeInfoDiv.id = 'route-info';
			panel.appendChild(routeInfoDiv);
		}

		routeInfoDiv.innerHTML = `
            <h3>מחשב מסלול...</h3>
            <p> מוצא דרך אל <strong>${stationName}</strong>...</p>
        `;

		const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${startLng},${startLat};${station.lon},${station.lat}?overview=full&geometries=geojson`;

		fetch(url)
			.then(res => res.json())
			.then(data => {
				if (!data.routes || data.routes.length === 0) {
					routeInfoDiv.innerHTML = `<h3>שגיאה</h3><p>לא נמצא מסלול הליכה.</p>`;
					return;
				}

				const route = data.routes[0];
				const distanceMeters = route.distance;
				const durationSeconds = route.duration;
				const durationMinutes = Math.round(durationSeconds / 60);

				// Draw route line
				currentRouteLine = L.geoJSON(route.geometry, {
					style: {
						color: '#457b9d',
						weight: 4,
						opacity: 0.8,
						dashArray: '10, 10'
					}
				}).addTo(map);

				// Update UI based on current walkingMinutes global
				const isClose = durationMinutes <= walkingMinutes;
				const statusColor = isClose ? '#2a9d8f' : '#e63946';
				const statusText = isClose ? `מצויין! בטווח ${walkingMinutes} דקות.` : `יותר מ-${walkingMinutes} דקות הליכה.`;

				routeInfoDiv.innerHTML = `
                    <h3>פרטי מסלול</h3>
                    <p><strong>יעד:</strong> ${stationName}</p>
                    <p><strong>זמן הליכה:</strong> <span style="font-size: 1.2rem; font-weight: bold;">${durationMinutes} דק'</span></p>
                    <p><strong>מרחק:</strong> ${Math.round(distanceMeters)} מטרים</p>
                    <p style="color: ${statusColor}; font-weight: 600; margin-top: 10px;">${statusText}</p>
                `;
			})
			.catch(err => {
				console.error(err);
				routeInfoDiv.innerHTML = `<h3>שגיאה</h3><p>חישוב המסלול נכשל.</p>`;
			});
	}

	// --- Clear Map Logic ---
	const clearBtn = document.getElementById('clear-map-btn');
	clearBtn.addEventListener('click', () => {
		// Remove Layers
		if (currentPin) map.removeLayer(currentPin);
		if (currentRouteLine) map.removeLayer(currentRouteLine);
		if (currentNeighborhoodLayer) map.removeLayer(currentNeighborhoodLayer);

		currentPin = null;
		currentRouteLine = null;
		currentNeighborhoodLayer = null;

		// Reset UI
		document.getElementById('search-input').value = '';
		clearBtn.classList.add('hidden');

		// Reset Info Panel content (optional) or just leave as is
		// Maybe go back to default view?
		const routeInfoDiv = document.getElementById('route-info');
		if (routeInfoDiv) routeInfoDiv.innerHTML = '<div id="loading" style="display:none"></div>'; // Clear text

		// Reset View? 
		// map.setView([32.06, 34.80], 13); // Optional: Reset view on clear
	});
});
