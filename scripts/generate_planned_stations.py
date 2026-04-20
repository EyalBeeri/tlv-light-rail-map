#!/usr/bin/env python3
"""Generate planned Green/Purple line stations without per-station geocoding.

Approach:
1) Parse station lists from NTA page markdown captures.
2) Resolve as many stations as possible using batched Overpass name lookups.
3) Reuse existing live station coordinates when names overlap.
4) Fill remaining gaps by deterministic interpolation within each city segment.

This avoids the repeated Nominatim 429 issue from one-request-per-station workflows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Iterable

import requests

CITY_HEADING_RE = re.compile(r"^##\s+(.+?)\s+\d+\s+\u05ea\u05d7\u05e0\u05d5\u05ea\s*$")
STATION_ITEM_RE = re.compile(r"^-\s+\[([^\]]+)\]\(")
BBOX = (31.85, 34.68, 32.20, 35.08)  # south, west, north, east

OVERPASS_URLS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

NAME_TAGS = [
    "name",
    "name:he",
    "official_name",
    "official_name:he",
    "alt_name",
    "alt_name:he",
    "short_name",
    "short_name:he",
]

CITY_TAGS = [
    "addr:city",
    "is_in:city",
    "addr:suburb",
    "addr:district",
    "district",
    "region",
]

# Approximate municipality bounding boxes (south, west, north, east).
CITY_BBOXES = {
    "הרצליה": (32.120, 34.760, 32.215, 34.860),
    "תל אביב-יפו": (31.990, 34.730, 32.150, 34.870),
    "חולון": (31.950, 34.740, 32.050, 34.840),
    "ראשון לציון": (31.900, 34.700, 32.060, 34.900),
    "רמת גן": (32.020, 34.780, 32.120, 34.860),
    "קריית אונו": (32.030, 34.830, 32.090, 34.900),
    "גבעת שמואל": (32.060, 34.830, 32.100, 34.880),
    "אור יהודה": (31.980, 34.810, 32.050, 34.920),
    "יהוד מונוסון": (32.000, 34.850, 32.060, 34.930),
}

KNOWN_NAME_VARIANTS = {
    "איינשטין": "איינשטיין",
    "קרית": "קריית",
    "תל אביב": "תל אביב-יפו",
}


@dataclass(frozen=True)
class StationSeed:
    idx: int
    line: str
    city_he: str
    name_he: str


@dataclass(frozen=True)
class Candidate:
    lat: float
    lon: float
    city_text: str
    source: str


@dataclass
class Resolved:
    lat: float
    lon: float
    source: str
    confidence: str


def normalize_text(value: str) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[\u0591-\u05C7]", "", text)
    text = text.replace("\u05f3", "")
    text = text.replace("\u05f4", "")
    text = text.replace("'", " ")
    text = text.replace('"', " ")
    text = re.sub(r"[\-_/.,()]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def name_variants(name: str) -> set[str]:
    variants = {name.strip()}
    collapsed = name.replace("'", "").replace("\u05f3", "").strip()
    if collapsed:
        variants.add(collapsed)

    for needle, repl in KNOWN_NAME_VARIANTS.items():
        if needle in name:
            variants.add(name.replace(needle, repl))
        if repl in name:
            variants.add(name.replace(repl, needle))

    return {variant for variant in variants if variant}


def regex_escape(value: str) -> str:
    return re.sub(r"([\\.^$|?*+()\[\]{}])", r"\\\1", value)


def load_markdown(path: Path) -> str:
    payload = json.loads(path.read_text(encoding="utf-8"))
    web = payload.get("web") or []
    if not web:
        raise ValueError(f"No web results in {path}")
    markdown = web[0].get("markdown")
    if not isinstance(markdown, str) or not markdown.strip():
        raise ValueError(f"No markdown found in {path}")
    return markdown


def extract_station_seeds(markdown: str, line_name: str, start_idx: int) -> list[StationSeed]:
    seeds: list[StationSeed] = []
    current_city: str | None = None
    index = start_idx

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("##"):
            city_match = CITY_HEADING_RE.match(line)
            current_city = city_match.group(1).strip() if city_match else None
            continue

        if not current_city:
            continue

        station_match = STATION_ITEM_RE.match(line)
        if not station_match:
            continue

        station_name = station_match.group(1).strip()
        if not station_name:
            continue

        seeds.append(
            StationSeed(
                idx=index,
                line=line_name,
                city_he=current_city,
                name_he=station_name,
            )
        )
        index += 1

    deduped: list[StationSeed] = []
    seen: set[tuple[str, str, str]] = set()
    for seed in seeds:
        key = (seed.line, seed.city_he, seed.name_he)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(seed)

    return deduped


def chunked(values: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(values), size):
        yield values[i:i + size]


def build_overpass_query(names: list[str]) -> str:
    pattern = "^(" + "|".join(regex_escape(name) for name in names) + ")$"
    south, west, north, east = BBOX

    query = f"""
[out:json][timeout:120];
(
  nwr["name"~"{pattern}"]({south},{west},{north},{east});
  nwr["name:he"~"{pattern}"]({south},{west},{north},{east});
  nwr["official_name"~"{pattern}"]({south},{west},{north},{east});
  nwr["official_name:he"~"{pattern}"]({south},{west},{north},{east});
  nwr["alt_name"~"{pattern}"]({south},{west},{north},{east});
  nwr["alt_name:he"~"{pattern}"]({south},{west},{north},{east});
  nwr["short_name"~"{pattern}"]({south},{west},{north},{east});
  nwr["short_name:he"~"{pattern}"]({south},{west},{north},{east});
);
out center;
""".strip()
    return query


def post_overpass(session: requests.Session, names: list[str]) -> dict:
    query = build_overpass_query(names)
    last_error: Exception | None = None

    for endpoint in OVERPASS_URLS:
        try:
            response = session.post(
                endpoint,
                data=query.encode("utf-8"),
                headers={"Content-Type": "text/plain; charset=utf-8"},
                timeout=140,
            )
            if response.status_code >= 400:
                raise RuntimeError(f"{endpoint} HTTP {response.status_code}")
            return response.json()
        except Exception as error:  # noqa: BLE001
            last_error = error
            continue

    raise RuntimeError(f"All Overpass endpoints failed for chunk of {len(names)} names: {last_error}")


def element_lat_lon(element: dict) -> tuple[float | None, float | None]:
    if "lat" in element and "lon" in element:
        try:
            return float(element["lat"]), float(element["lon"])
        except (TypeError, ValueError):
            return None, None

    center = element.get("center") or {}
    try:
        return float(center.get("lat")), float(center.get("lon"))
    except (TypeError, ValueError):
        return None, None


def element_name_values(tags: dict) -> set[str]:
    names: set[str] = set()
    for key in NAME_TAGS:
        value = tags.get(key)
        if isinstance(value, str) and value.strip():
            names.add(value.strip())
    return names


def element_city_text(tags: dict) -> str:
    parts: list[str] = []
    for key in CITY_TAGS:
        value = tags.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    return " | ".join(parts)


def collect_overpass_candidates(seeds: list[StationSeed], chunk_size: int) -> dict[str, list[Candidate]]:
    lookup: dict[str, list[Candidate]] = {}

    all_names_set: set[str] = set()
    for seed in seeds:
        all_names_set.add(seed.name_he)
        all_names_set.update(name_variants(seed.name_he))

    all_names = sorted(all_names_set)
    session = requests.Session()
    session.headers.update({"User-Agent": "tlv-light-rail-map/overpass-station-resolver"})

    print(f"Overpass lookup for {len(all_names)} unique names in chunks of {chunk_size}...")

    for chunk_index, names_chunk in enumerate(chunked(all_names, chunk_size), start=1):
        print(f"  chunk {chunk_index}: {len(names_chunk)} names")
        try:
            payload = post_overpass(session, names_chunk)
        except Exception as error:  # noqa: BLE001
            print(f"    chunk failed: {error}")
            continue

        elements = payload.get("elements") or []
        for element in elements:
            lat, lon = element_lat_lon(element)
            if lat is None or lon is None:
                continue

            tags = element.get("tags") or {}
            names = element_name_values(tags)
            if not names:
                continue

            city_text = element_city_text(tags)
            candidate = Candidate(
                lat=lat,
                lon=lon,
                city_text=city_text,
                source="OSM Overpass",
            )

            for name in names:
                key = normalize_text(name)
                if not key:
                    continue
                lookup.setdefault(key, []).append(candidate)

    return lookup


def city_match_score(seed_city: str, candidate_city_text: str) -> float:
    seed_norm = normalize_text(seed_city)
    cand_norm = normalize_text(candidate_city_text)
    if not seed_norm or not cand_norm:
        return 0.0

    if seed_norm in cand_norm:
        return 40.0

    if "תל אביב" in seed_norm and ("תל אביב" in cand_norm or "יפו" in cand_norm):
        return 30.0

    if "קריית" in seed_norm and "קרית" in cand_norm:
        return 20.0

    return 0.0


def bbox_for_city(city_he: str) -> tuple[float, float, float, float] | None:
    for key, bbox in CITY_BBOXES.items():
        if key in city_he:
            return bbox
    return None


def in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    south, west, north, east = bbox
    return south <= lat <= north and west <= lon <= east


def pick_best_candidate(seed: StationSeed, candidates: list[Candidate]) -> Resolved | None:
    if not candidates:
        return None

    unique: dict[tuple[float, float], Candidate] = {}
    for candidate in candidates:
        unique[(round(candidate.lat, 7), round(candidate.lon, 7))] = candidate

    city_bbox = bbox_for_city(seed.city_he)
    scored: list[tuple[float, Candidate]] = []
    for candidate in unique.values():
        score = 10.0
        score += city_match_score(seed.city_he, candidate.city_text)

        if city_bbox:
            if in_bbox(candidate.lat, candidate.lon, city_bbox):
                score += 60.0
            else:
                score -= 35.0

        scored.append((score, candidate))

    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, best = scored[0]

    if best_score >= 70:
        confidence = "high"
    elif best_score >= 35:
        confidence = "medium"
    else:
        confidence = "low"
    return Resolved(lat=best.lat, lon=best.lon, source=best.source, confidence=confidence)


def load_existing_station_lookup(path: Path) -> dict[str, Resolved]:
    if not path.exists():
        return {}

    payload = json.loads(path.read_text(encoding="utf-8"))
    lookup: dict[str, Resolved] = {}

    for item in payload:
        try:
            lat = float(item.get("lat"))
            lon = float(item.get("lon"))
        except (TypeError, ValueError):
            continue

        for key_name in (item.get("name_he"), item.get("name"), item.get("full_name")):
            if not isinstance(key_name, str) or not key_name.strip():
                continue
            lookup[normalize_text(key_name)] = Resolved(
                lat=lat,
                lon=lon,
                source="Existing live station",
                confidence="high",
            )

    return lookup


def compute_city_centers(seeds: list[StationSeed], resolved: dict[int, Resolved]) -> dict[str, tuple[float, float]]:
    city_points: dict[str, list[tuple[float, float]]] = {}
    for seed in seeds:
        item = resolved.get(seed.idx)
        if not item:
            continue
        city_points.setdefault(seed.city_he, []).append((item.lat, item.lon))

    centers: dict[str, tuple[float, float]] = {}
    for city, points in city_points.items():
        centers[city] = (mean(point[0] for point in points), mean(point[1] for point in points))
    return centers


def fallback_city_center(city_he: str) -> tuple[float, float]:
    # Deterministic pseudo-random tiny offset around TLV center.
    base_lat, base_lon = 32.0600, 34.8000
    digest = hashlib.md5(city_he.encode("utf-8")).hexdigest()  # noqa: S324
    a = int(digest[:8], 16) / 0xFFFFFFFF
    b = int(digest[8:16], 16) / 0xFFFFFFFF
    lat = base_lat + (a - 0.5) * 0.08
    lon = base_lon + (b - 0.5) * 0.08
    return lat, lon


def geo_distance_meters(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    # Fast enough and accurate enough for outlier detection.
    radius = 6_371_000.0
    phi1 = math.radians(a_lat)
    phi2 = math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dlambda = math.radians(b_lon - a_lon)

    x = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    y = 2 * math.atan2(math.sqrt(x), math.sqrt(max(0.0, 1 - x)))
    return radius * y


def prune_group_outliers(group: list[StationSeed], resolved: dict[int, Resolved]) -> None:
    for idx, seed in enumerate(group):
        current = resolved.get(seed.idx)
        if not current or current.source != "OSM Overpass":
            continue

        prev_point: Resolved | None = None
        next_point: Resolved | None = None

        for prev_idx in range(idx - 1, -1, -1):
            candidate = resolved.get(group[prev_idx].idx)
            if candidate:
                prev_point = candidate
                break

        for next_idx in range(idx + 1, len(group)):
            candidate = resolved.get(group[next_idx].idx)
            if candidate:
                next_point = candidate
                break

        if not prev_point or not next_point:
            continue

        d_prev = geo_distance_meters(current.lat, current.lon, prev_point.lat, prev_point.lon)
        d_next = geo_distance_meters(current.lat, current.lon, next_point.lat, next_point.lon)
        d_span = geo_distance_meters(prev_point.lat, prev_point.lon, next_point.lat, next_point.lon)

        # Remove points that are far from both neighbors and distort local geometry.
        if d_prev > 5000 and d_next > 5000 and d_span < 9000:
            resolved.pop(seed.idx, None)
            continue

        if (d_prev + d_next) > max(10000, d_span * 2.8) and max(d_prev, d_next) > 7000:
            resolved.pop(seed.idx, None)
            continue


def interpolate_group(
    group: list[StationSeed],
    resolved: dict[int, Resolved],
    city_centers: dict[str, tuple[float, float]],
) -> None:
    known_positions = [
        idx for idx, seed in enumerate(group)
        if seed.idx in resolved
    ]

    if not known_positions:
        city = group[0].city_he
        center = city_centers.get(city) or fallback_city_center(city)
        for local_idx, seed in enumerate(group):
            offset = (local_idx - (len(group) - 1) / 2.0) * 0.0012
            resolved[seed.idx] = Resolved(
                lat=center[0] + offset * 0.35,
                lon=center[1] + offset,
                source="Interpolated city fallback",
                confidence="low",
            )
        return

    # Interior interpolation between known anchors.
    for pos in range(len(known_positions) - 1):
        left = known_positions[pos]
        right = known_positions[pos + 1]
        if right - left <= 1:
            continue

        left_seed = group[left]
        right_seed = group[right]
        left_point = resolved[left_seed.idx]
        right_point = resolved[right_seed.idx]

        span = right - left
        for gap_index in range(1, span):
            target = left + gap_index
            target_seed = group[target]
            t = gap_index / span
            lat = left_point.lat + (right_point.lat - left_point.lat) * t
            lon = left_point.lon + (right_point.lon - left_point.lon) * t
            resolved[target_seed.idx] = Resolved(
                lat=lat,
                lon=lon,
                source="Interpolated between known stations",
                confidence="low",
            )

    # Prefix before first known.
    first_known = known_positions[0]
    if first_known > 0:
        first_seed = group[first_known]
        first_point = resolved[first_seed.idx]

        if len(known_positions) >= 2:
            second_seed = group[known_positions[1]]
            second_point = resolved[second_seed.idx]
            step_lat = (second_point.lat - first_point.lat) / max(1, known_positions[1] - first_known)
            step_lon = (second_point.lon - first_point.lon) / max(1, known_positions[1] - first_known)
        else:
            step_lat, step_lon = 0.0, 0.001

        for i in range(first_known - 1, -1, -1):
            distance = first_known - i
            target_seed = group[i]
            resolved[target_seed.idx] = Resolved(
                lat=first_point.lat - step_lat * distance,
                lon=first_point.lon - step_lon * distance,
                source="Interpolated prefix",
                confidence="low",
            )

    # Suffix after last known.
    last_known = known_positions[-1]
    if last_known < len(group) - 1:
        last_seed = group[last_known]
        last_point = resolved[last_seed.idx]

        if len(known_positions) >= 2:
            prev_seed = group[known_positions[-2]]
            prev_point = resolved[prev_seed.idx]
            step_lat = (last_point.lat - prev_point.lat) / max(1, last_known - known_positions[-2])
            step_lon = (last_point.lon - prev_point.lon) / max(1, last_known - known_positions[-2])
        else:
            step_lat, step_lon = 0.0, 0.001

        for i in range(last_known + 1, len(group)):
            distance = i - last_known
            target_seed = group[i]
            resolved[target_seed.idx] = Resolved(
                lat=last_point.lat + step_lat * distance,
                lon=last_point.lon + step_lon * distance,
                source="Interpolated suffix",
                confidence="low",
            )


def resolve_all(
    seeds: list[StationSeed],
    stations_path: Path,
    chunk_size: int,
) -> dict[int, Resolved]:
    resolved: dict[int, Resolved] = {}

    existing_lookup = load_existing_station_lookup(stations_path)
    overpass_lookup = collect_overpass_candidates(seeds, chunk_size=chunk_size)

    for seed in seeds:
        candidates: list[Candidate] = []
        for variant in name_variants(seed.name_he):
            key = normalize_text(variant)
            if key and key in overpass_lookup:
                candidates.extend(overpass_lookup[key])

        picked = pick_best_candidate(seed, candidates)
        if picked and not (picked.source == "OSM Overpass" and picked.confidence == "low"):
            resolved[seed.idx] = picked
            continue

        for variant in name_variants(seed.name_he):
            existing = existing_lookup.get(normalize_text(variant))
            if existing:
                resolved[seed.idx] = existing
                break

    grouped: dict[tuple[str, str], list[StationSeed]] = {}
    for seed in seeds:
        grouped.setdefault((seed.line, seed.city_he), []).append(seed)

    for group in grouped.values():
        prune_group_outliers(group, resolved)

    city_centers = compute_city_centers(seeds, resolved)

    for group in grouped.values():
        interpolate_group(group, resolved, city_centers)

    return resolved


def build_output_records(seeds: list[StationSeed], resolved: dict[int, Resolved]) -> list[dict]:
    records: list[dict] = []
    for seed in sorted(seeds, key=lambda item: item.idx):
        item = resolved.get(seed.idx)
        if not item:
            # This should not happen due interpolation fallback.
            continue

        records.append(
            {
                "name_he": seed.name_he,
                "line": seed.line,
                "city_he": seed.city_he,
                "status": "planned",
                "source": item.source,
                "confidence": item.confidence,
                "lat": round(item.lat, 7),
                "lon": round(item.lon, 7),
            }
        )
    return records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate planned stations dataset")
    parser.add_argument("--green", required=True, type=Path, help="Path to green line Firecrawl content.json")
    parser.add_argument("--purple", required=True, type=Path, help="Path to purple line Firecrawl content.json")
    parser.add_argument("--stations", default=Path("stations.json"), type=Path, help="Existing stations JSON")
    parser.add_argument("--output", required=True, type=Path, help="Output JSON file path")
    parser.add_argument("--chunk-size", type=int, default=14, help="Names per Overpass regex batch")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    green_md = load_markdown(args.green)
    green_seeds = extract_station_seeds(green_md, "green", start_idx=0)

    purple_md = load_markdown(args.purple)
    purple_seeds = extract_station_seeds(purple_md, "purple", start_idx=len(green_seeds))

    seeds = green_seeds + purple_seeds
    print(f"Parsed {len(green_seeds)} green and {len(purple_seeds)} purple stations ({len(seeds)} total)")

    resolved = resolve_all(seeds, stations_path=args.stations, chunk_size=max(6, args.chunk_size))
    records = build_output_records(seeds, resolved)

    args.output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")

    by_conf: dict[str, int] = {}
    by_source: dict[str, int] = {}
    for record in records:
        by_conf[record["confidence"]] = by_conf.get(record["confidence"], 0) + 1
        by_source[record["source"]] = by_source.get(record["source"], 0) + 1

    print(f"Wrote {len(records)} records to {args.output}")
    print("Confidence breakdown:")
    for confidence, count in sorted(by_conf.items()):
        print(f"  {confidence}: {count}")
    print("Source breakdown:")
    for source, count in sorted(by_source.items(), key=lambda kv: kv[0]):
        print(f"  {source}: {count}")


if __name__ == "__main__":
    main()
