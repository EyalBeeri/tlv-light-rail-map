import json
import requests
import time
import os

STATIONS_FILE = 'stations.json'
OUTPUT_FILE = 'station_isochrones.json'

# Valhalla Public Instance
VALHALLA_URL = "https://valhalla1.openstreetmap.de/isochrone"

# Split into batches of 4 (API limit)
CONTOUR_BATCHES = [
    [{"time": 1}, {"time": 2}, {"time": 3}, {"time": 4}],
    [{"time": 5}, {"time": 6}, {"time": 7}, {"time": 8}],
    [{"time": 9}, {"time": 10}, {"time": 11}, {"time": 12}],
    [{"time": 13}, {"time": 14}, {"time": 15}, {"time": 16}],
    [{"time": 17}, {"time": 18}, {"time": 19}, {"time": 20}]
]

def bundle_isochrones():
    print(f"Loading stations from {STATIONS_FILE}...")
    with open(STATIONS_FILE, 'r', encoding='utf-8') as f:
        stations = json.load(f)
        
    print(f"Found {len(stations)} stations. Starting fetch...")
    
    isochrone_data = {} # Key: Station Name -> { "5": geojson, "10": geojson... }
    
    for i, station in enumerate(stations):
        name = station.get('name_he') or station.get('name')
        lat = station['lat']
        lon = station['lon']
        
        print(f"[{i+1}/{len(stations)}] Fetching for {name}...")
        station_polys = {}
        
        for batch in CONTOUR_BATCHES:
            payload = {
                "locations": [{"lat": lat, "lon": lon}],
                "costing": "pedestrian",
                "contours": batch,
                "polygons": True
            }
            
            try:
                resp = requests.post(VALHALLA_URL, json=payload)
                if resp.status_code != 200:
                    print(f"   Error: {resp.status_code} - {resp.text}")
                    continue
                    
                data = resp.json()
                features = data.get('features', [])
                
                for feature in features:
                    props = feature.get('properties', {})
                    minute_val = int(props.get('contour', 0))
                    if minute_val > 0:
                        station_polys[str(minute_val)] = feature
                
                time.sleep(1.0) # Delay between batches

            except Exception as e:
                print(f"   Exception: {e}")
        
        if station_polys:
            isochrone_data[name] = station_polys
            print(f"   Saved {len(station_polys)} contours total.")
            
    print(f"Finished. Saving to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(isochrone_data, f, ensure_ascii=False, indent=0)
    
    print("Done!")

if __name__ == "__main__":
    bundle_isochrones()
