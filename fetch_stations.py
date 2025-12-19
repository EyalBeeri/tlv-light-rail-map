
import requests
import json
import time

stations = [
    "Petah Tikva Central Bus Station",
    "Pinsker station, Petah Tikva",
    "Krol station",
    "Dankner station",
    "Beilinson station",
    "Shaham station",
    "Shenkar station",
    "Kiryat Arye station",
    "Gesher Em HaMoshavot station",
    "Aharonovich station",
    "Ben Gurion station, Bnei Brak",
    "Bialik station, Ramat Gan",
    "Abba Hillel station",
    "Arlozorov station, Tel Aviv",
    "Sha'ul HaMelech station",
    "Yehudit station",
    "Carlebach station",
    "Allenby station",
    "Elifelet station",
    "Shalma station",
    "Bloomfield Stadium station",
    "Ehrlich station",
    "Isakov station",
    "HaBesht station",
    "Mahrozet station",
    "Ha'Atsma'ut station, Bat Yam",
    "Rothschild station, Bat Yam",
    "Jabotinsky station, Bat Yam",
    "Balfour station, Bat Yam",
    "Binyamin station, Bat Yam",
    "Yoseftal station, Bat Yam",
    "Kaf Tet BeNovember station",
    "He'Amal station",
    "HaKomemiyut station"
]

# Manual overrides or specific search queries to ensure accuracy
search_queries = {
    "Petah Tikva Central Bus Station": "Petah Tikva Central Bus Station, Israel",
    "Pinsker station, Petah Tikva": "Pinsker, Petah Tikva, Israel",
    "Krol station": "Krol, Petah Tikva, Israel",
    "Dankner station": "Dankner, Petah Tikva, Israel",
    "Beilinson station": "Beilinson Light Rail Station, Petah Tikva, Israel",
    "Shaham station": "Shaham, Petah Tikva, Israel",
    "Shenkar station": "Shenkar, Petah Tikva, Israel",
    "Kiryat Arye station": "Kiryat Arye Railway Station, Israel",
    "Gesher Em HaMoshavot station": "Gesher Em HaMoshavot, Bnei Brak, Israel",
    "Aharonovich station": "Aharonovich, Bnei Brak, Israel",
    "Ben Gurion station, Bnei Brak": "Ben Gurion, Bnei Brak, Israel",
    "Bialik station, Ramat Gan": "Bialik, Ramat Gan, Israel",
    "Abba Hillel station": "Abba Hillel, Ramat Gan, Israel",
    "Arlozorov station, Tel Aviv": "Tel Aviv Savidor Central Railway Station, Israel", # Closest major landmark for the light rail
    "Sha'ul HaMelech station": "Sha'ul HaMelech, Tel Aviv, Israel",
    "Yehudit station": "Yehudit, Tel Aviv, Israel",
    "Carlebach station": "Carlebach, Tel Aviv, Israel",
    "Allenby station": "Allenby, Tel Aviv, Israel",
    "Elifelet station": "Elifelet, Tel Aviv, Israel",
    "Shalma station": "Shalma, Tel Aviv, Israel",
    "Bloomfield Stadium station": "Bloomfield Stadium, Tel Aviv, Israel",
    "Ehrlich station": "Ehrlich, Tel Aviv, Israel",
    "Isakov station": "Isakov, Tel Aviv, Israel",
    "HaBesht station": "HaBesht, Tel Aviv, Israel",
    "Mahrozet station": "Mahrozet, Tel Aviv, Israel",
    "Ha'Atsma'ut station, Bat Yam": "Ha'Atsma'ut, Bat Yam, Israel",
    "Rothschild station, Bat Yam": "Rothschild, Bat Yam, Israel",
    "Jabotinsky station, Bat Yam": "Jabotinsky, Bat Yam, Israel",
    "Balfour station, Bat Yam": "Balfour, Bat Yam, Israel",
    "Binyamin station, Bat Yam": "Binyamin, Bat Yam, Israel",
    "Yoseftal station, Bat Yam": "Yoseftal, Bat Yam, Israel",
    "Kaf Tet BeNovember station": "Kaf Tet BeNovember, Bat Yam, Israel",
    "He'Amal station": "He'Amal, Bat Yam, Israel",
    "HaKomemiyut station": "HaKomemiyut, Bat Yam, Israel"
}

results = []

print("Fetching station coordinates...")

for station in stations:
    query = search_queries.get(station, station + ", Israel")
    url = f"https://nominatim.openstreetmap.org/search?q={query}&format=json"
    headers = {
        'User-Agent': 'TelAvivLightRailMap/1.0'
    }
    
    try:
        response = requests.get(url, headers=headers)
        data = response.json()
        
        if data:
            # Take the first result
            lat = data[0]['lat']
            lon = data[0]['lon']
            results.append({
                "name": station.replace(" station", "").replace(", Petah Tikva", "").replace(", Bnei Brak", "").replace(", Ramat Gan", "").replace(", Tel Aviv", "").replace(", Bat Yam", ""),
                "full_name": station,
                "lat": float(lat),
                "lon": float(lon)
            })
            print(f"Found: {station}")
        else:
            print(f"NOT FOUND: {station}")
            
    except Exception as e:
        print(f"Error fetching {station}: {e}")
    
    time.sleep(1.1) # Respect Nominatim rate limits

with open('stations.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, indent=4, ensure_ascii=False)

print(f"Done. Saved {len(results)} stations to stations.json")
