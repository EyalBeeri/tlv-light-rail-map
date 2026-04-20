#!/usr/bin/env python3
"""Generate real pedestrian isochrones for planned stations via Valhalla.

Output format matches station_isochrones.json:
{
  "station-key": {
    "1": <GeoJSON feature>,
    ...
    "20": <GeoJSON feature>
  }
}
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import requests

VALHALLA_URL = "https://valhalla1.openstreetmap.de/isochrone"

CONTOUR_BATCHES = [
    [{"time": 1}, {"time": 2}, {"time": 3}, {"time": 4}],
    [{"time": 5}, {"time": 6}, {"time": 7}, {"time": 8}],
    [{"time": 9}, {"time": 10}, {"time": 11}, {"time": 12}],
    [{"time": 13}, {"time": 14}, {"time": 15}, {"time": 16}],
    [{"time": 17}, {"time": 18}, {"time": 19}, {"time": 20}],
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate planned station isochrones")
    parser.add_argument(
        "--stations",
        type=Path,
        default=Path("planned_stations.json"),
        help="Input planned stations JSON",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("planned_station_isochrones.json"),
        help="Output isochrones JSON",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.65,
        help="Delay (seconds) between Valhalla requests",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="Request timeout in seconds",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Retries per contour batch request",
    )
    parser.add_argument(
        "--start-index",
        type=int,
        default=0,
        help="Start index in planned stations list (for partial runs)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional limit for number of stations to process (0 = all)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Ignore existing output and regenerate from scratch",
    )
    return parser.parse_args()


def station_name(station: dict[str, Any]) -> str:
    return str(station.get("name_he") or station.get("name") or "תחנה מתוכננת")


def isochrone_key(station: dict[str, Any]) -> str:
    line = str(station.get("line") or "planned")
    return f"planned:{line}:{station_name(station)}"


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_batch(
    session: requests.Session,
    *,
    lat: float,
    lon: float,
    contours: list[dict[str, int]],
    timeout: float,
    max_retries: int,
) -> dict[str, Any] | None:
    payload = {
        "locations": [{"lat": lat, "lon": lon}],
        "costing": "pedestrian",
        "contours": contours,
        "polygons": True,
    }

    for attempt in range(1, max_retries + 1):
        try:
            response = session.post(VALHALLA_URL, json=payload, timeout=timeout)
            if response.status_code == 200:
                return response.json()

            print(f"    HTTP {response.status_code} on attempt {attempt}: {response.text[:180]}")
        except Exception as exc:  # noqa: BLE001
            print(f"    Request error on attempt {attempt}: {exc}")

        if attempt < max_retries:
            time.sleep(min(4.0, 0.7 * attempt))

    return None


def extract_contours(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for feature in data.get("features", []):
        contour = feature.get("properties", {}).get("contour")
        if contour is None:
            continue

        try:
            minute = int(float(contour))
        except (TypeError, ValueError):
            continue

        if minute <= 0:
            continue

        results[str(minute)] = feature

    return results


def main() -> None:
    args = parse_args()

    stations = load_json(args.stations, default=[])
    if not isinstance(stations, list) or not stations:
        raise SystemExit(f"No stations found in {args.stations}")

    existing: dict[str, Any]
    if args.overwrite:
        existing = {}
    else:
        existing = load_json(args.output, default={})
        if not isinstance(existing, dict):
            existing = {}

    start = max(0, args.start_index)
    stop = len(stations) if args.limit <= 0 else min(len(stations), start + args.limit)

    print(f"Loaded {len(stations)} planned stations.")
    print(f"Processing range: [{start}:{stop})")
    print(f"Output file: {args.output}")

    session = requests.Session()
    session.headers.update({"User-Agent": "tlv-light-rail-map/planned-isochrones"})

    processed = 0
    completed = 0

    for idx in range(start, stop):
        station = stations[idx]
        key = isochrone_key(station)
        name = station_name(station)

        lat = station.get("lat")
        lon = station.get("lon")
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            print(f"[{idx + 1}/{stop}] Skip {name}: invalid coordinates")
            continue

        current = existing.get(key)
        if isinstance(current, dict) and len(current) >= 20:
            print(f"[{idx + 1}/{stop}] Skip {name}: already has {len(current)} contours")
            completed += 1
            continue

        print(f"[{idx + 1}/{stop}] Fetch {name} ({station.get('line', 'planned')})")
        station_polys = dict(current) if isinstance(current, dict) else {}

        for contour_batch in CONTOUR_BATCHES:
            needed = [str(item["time"]) for item in contour_batch if str(item["time"]) not in station_polys]
            if not needed:
                continue

            data = fetch_batch(
                session,
                lat=lat,
                lon=lon,
                contours=contour_batch,
                timeout=args.timeout,
                max_retries=args.max_retries,
            )
            if data is None:
                print(f"    Failed contour batch {needed}")
                time.sleep(args.sleep)
                continue

            extracted = extract_contours(data)
            station_polys.update(extracted)
            print(f"    Received contours: {', '.join(sorted(extracted.keys(), key=int)) or 'none'}")
            time.sleep(args.sleep)

        if station_polys:
            existing[key] = station_polys
            save_json(args.output, existing)
            print(f"    Saved {len(station_polys)} contours for key: {key}")
            if len(station_polys) >= 20:
                completed += 1

        processed += 1

    print("Done.")
    print(f"Stations processed this run: {processed}")
    print(f"Stations with full 1..20 contours: {completed}")
    print(f"Total keys in output: {len(existing)}")


if __name__ == "__main__":
    main()
