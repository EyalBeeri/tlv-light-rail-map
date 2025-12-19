import requests
import json

def test_valhalla():
    url = "https://valhalla1.openstreetmap.de/isochrone"
    payload = {
        "locations": [{"lat": 32.0853, "lon": 34.7818}], # Tel Aviv / Arlozorov
        "costing": "pedestrian",
        "contours": [{"time": 10}, {"time": 20}] # 10 and 20 min walks
    }
    
    print(f"Testing {url}...")
    try:
        resp = requests.post(url, json=payload)
        print(f"Status: {resp.status_code}")
        if resp.status_code == 200:
             print("Success! JSON keys:", resp.json().keys())
             # print sample
             print(str(resp.json())[:100])
        else:
             print("Failed:", resp.text)
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_valhalla()
