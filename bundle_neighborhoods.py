import json
import requests
import os
import time

OUTPUT_FILE = 'neighborhoods.json'
HEADERS = {
    'User-Agent': 'TLV_Light_Rail_Mapper/1.0 (contact: map_dev@example.com)'
}

def bundle_data():
    print("Starting Bulk Neighborhood Fetch (Overpass + Polygons Service)...")
    
    # 1. Get Elements from Overpass
    # We ask for:
    # - Relations (Tag info only)
    # - Ways (Geometry directly because for Ways it's simple)
    bbox = "32.00,34.73,32.13,34.92"
    
    overpass_query = f"""
    [out:json][timeout:60];
    (
      relation["admin_level"~"9|10"]({bbox});
      relation["place"~"suburb|quarter|neighbourhood"]({bbox});
      way["place"~"suburb|quarter|neighbourhood"]({bbox});
    );
    out geom;
    """
    url_overpass = "https://overpass-api.de/api/interpreter"
    
    try:
        print("1. Querying Overpass...")
        response = requests.get(url_overpass, params={'data': overpass_query}, headers=HEADERS)
        if response.status_code != 200:
             print(f"Overpass Error: {response.status_code}")
             return
             
        data = response.json()
        elements = data.get('elements', [])
        print(f"   Found {len(elements)} elements.")
        
        neighborhoods = {}
        count = 0
        
        for el in elements:
            e_id = el.get('id')
            e_type = el.get('type')
            tags = el.get('tags', {})
            name = tags.get('name:he') or tags.get('name')
            
            if not name: continue
            if tags.get('admin_level') == '8': continue # Skip cities

            # Case A: Way (Geometry is inside)
            if e_type == 'way':
                # Parse 'geometry' field: [{'lat':..., 'lon':...}, ...]
                geom_points = el.get('geometry', [])
                if geom_points:
                    coords = [[p['lon'], p['lat']] for p in geom_points]
                    # Ensure closed loop
                    if coords[0] != coords[-1]:
                        coords.append(coords[0])
                        
                    neighborhoods[name] = {
                        "type": "Polygon",
                        "coordinates": [coords]
                    }
                    print(f"   [Way] {name}: OK")
                    count += 1
            
            # Case B: Relation (Fetch from Service)
            elif e_type == 'relation':
                # Use reliable external service for relations
                poly_url = f"http://polygons.openstreetmap.fr/get_geojson.py?id={e_id}&params=0"
                try:
                    resp = requests.get(poly_url, timeout=5)
                    if resp.status_code == 200:
                        geojson = resp.json()
                        neighborhoods[name] = geojson
                        print(f"   [Rel] {name}: OK")
                        count += 1
                    else:
                        print(f"   [Rel] {name}: Failed to fetch Poly (HTTP {resp.status_code})")
                        # Fallback? No, just skip.
                except Exception as e:
                    print(f"   [Rel] {name}: Error {e}")
                
                time.sleep(0.5) # Be nice to the service

        # Write result
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(neighborhoods, f, ensure_ascii=False, indent=2)
            
        print(f"\nBundle complete. Saved {len(neighborhoods)} polygons.")

    except Exception as e:
        print(f"Fatal Error: {e}")

if __name__ == "__main__":
    bundle_data()
