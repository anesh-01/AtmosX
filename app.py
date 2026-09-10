import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict, Any
from datetime import datetime
from pathlib import Path

app = FastAPI(
    title="WeatherGPT Engine - AtmosX",
    description="Conversational Climate Intelligence & Real-Time Disaster Advisory API",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

class WeatherQueryRequest(BaseModel):
    query: str
    location_name: str
    user_role: Optional[str] = "farmer"

class WeatherResponse(BaseModel):
    location: str
    latitude: float
    longitude: float
    raw_weather: Dict[str, Any]
    daily_weather: Dict[str, Any] = {}
    hourly_weather: Dict[str, Any] = {}
    warning_flag: bool
    official_warning: Optional[str]
    actionable_advisory: str
    grounding_metadata: Dict[str, Any]

# Built-in coordinates for the stations shipped with the AtmosX prototype.
# This avoids a fragile dependency on geocoding for known dashboard stations.
KNOWN_LOCATIONS = {
    "wayanad": (11.6854, 76.1320, "Wayanad, Kerala"),
    "nashik": (19.9975, 73.7898, "Nashik, Maharashtra"),
    "puri": (19.8135, 85.8312, "Puri, Odisha"),
    "leh": (34.1526, 77.5771, "Leh, Ladakh"),
    "chennai": (13.0827, 80.2707, "Chennai, Tamil Nadu"),
    "jaipur": (26.9124, 75.7873, "Jaipur, Rajasthan"),
    "guwahati": (26.1445, 91.7362, "Guwahati, Assam"),
    "mumbai": (19.0760, 72.8777, "Mumbai, Maharashtra"),
    "delhi ncr": (28.6139, 77.2090, "Delhi NCR"),
    "delhi": (28.6139, 77.2090, "Delhi NCR"),
    "shimla": (31.1048, 77.1734, "Shimla, Himachal Pradesh"),
    "bengaluru": (12.9716, 77.5946, "Bengaluru, Karnataka"),
    "bangalore": (12.9716, 77.5946, "Bengaluru, Karnataka"),
    "kolkata": (22.5726, 88.3639, "Kolkata, West Bengal"),
}

async def resolve_coordinates(location_name: str) -> tuple[float, float, str]:
    normalized = " ".join(str(location_name or "").lower().split())
    if normalized in KNOWN_LOCATIONS:
        return KNOWN_LOCATIONS[normalized]

    # Try Open-Meteo geocoding for locations outside the built-in station set.
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(
                GEOCODING_URL,
                params={"name": location_name, "count": 1, "language": "en", "format": "json"}
            )
            if res.status_code == 200 and res.json().get("results"):
                result = res.json()["results"][0]
                return result["latitude"], result["longitude"], f"{result['name']}, {result.get('admin1', '')}".strip(", ")
    except httpx.HTTPError:
        pass

    raise HTTPException(status_code=404, detail=f"Location '{location_name}' could not be resolved. Try a supported station such as Wayanad, Nashik, Puri, Chennai, Jaipur or Mumbai.")

async def fetch_live_weather(lat: float, lon: float) -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        params = {
            "latitude": lat,
            "longitude": lon,
            "current": (
                "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,"
                "apparent_temperature,surface_pressure,wind_direction_10m,cloud_cover,weather_code"
            ),
            "hourly": "precipitation_probability,temperature_2m,wind_speed_10m,weather_code",
            "daily": "uv_index_max,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weather_code,wind_speed_10m_max",
            "forecast_days": 7,
            "timezone": "auto"
        }
        res = await client.get(FORECAST_URL, params=params)
        if res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch weather data.")
        return res.json()

def weather_code_description(code: Any) -> str:
    try:
        code = int(code)
    except (TypeError, ValueError):
        return "Unknown conditions"
    mapping = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
        56: "Light freezing drizzle", 57: "Dense freezing drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
        66: "Light freezing rain", 67: "Heavy freezing rain", 71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
        77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
        85: "Slight snow showers", 86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"
    }
    return mapping.get(code, f"Weather code {code}")

def wind_direction_label(degrees: Any) -> str:
    try:
        degrees = float(degrees)
    except (TypeError, ValueError):
        return "Unknown"
    directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return directions[round(degrees / 22.5) % 16]

def apply_warning_guardrails(current_data: Dict[str, Any], daily_data: Optional[Dict[str, Any]] = None) -> tuple[bool, Optional[str]]:
    wind_speed = float(current_data.get("wind_speed_10m") or 0)
    precip = float(current_data.get("precipitation") or 0)
    weather_code = int(current_data.get("weather_code") or 0)

    if wind_speed > 35.0:
        return True, "HIGH WIND WARNING: Severe wind speeds (>35 km/h) detected. Postpone field activities immediately."
    if precip > 10.0:
        return True, "HEAVY RAINFALL ALERT: Risk of soil saturation and flooding in progress."
    if weather_code in {95, 96, 99}:
        return True, "THUNDERSTORM ALERT: Thunderstorm conditions are present. Avoid exposed outdoor activities and field work."

    if daily_data:
        probs = daily_data.get("precipitation_probability_max") or []
        sums = daily_data.get("precipitation_sum") or []
        if probs and float(probs[0] or 0) >= 90 and sums and float(sums[0] or 0) >= 20:
            return True, "HEAVY RAINFALL FORECAST ALERT: High rain probability and substantial rainfall are forecast. Plan field work accordingly."

    return False, None

def _first(values, default=None):
    return values[0] if values else default

def _hourly_rain_probability(hourly: Dict[str, Any], target_index: int = 0) -> Optional[float]:
    values = hourly.get("precipitation_probability") or []
    if not values:
        return None
    target_index = max(0, min(target_index, len(values) - 1))
    return float(values[target_index])

def generate_advisory(role: str, question: str, current_data: Dict[str, Any], daily_data: Dict[str, Any], hourly_data: Dict[str, Any], warning: Optional[str]) -> str:
    q = (question or "").lower()
    temp = float(current_data.get("temperature_2m") or 0)
    feels = float(current_data.get("apparent_temperature") or temp)
    humidity = float(current_data.get("relative_humidity_2m") or 0)
    wind = float(current_data.get("wind_speed_10m") or 0)
    rain_now = float(current_data.get("precipitation") or 0)
    condition = weather_code_description(current_data.get("weather_code"))
    rain_prob = _hourly_rain_probability(hourly_data, 13)  # afternoon window in the returned local-day series

    if warning:
        return f"CRITICAL NOTICE: {warning}"

    probs = daily_data.get("precipitation_probability_max") or []
    sums = daily_data.get("precipitation_sum") or []
    max_probs = [float(x or 0) for x in probs[:3]]
    rain_sum = float(_first(sums, 0) or 0)

    asks_spray = any(word in q for word in ["spray", "pesticide", "fungicide", "fertilizer", "chemical"])
    asks_tomorrow = "tomorrow" in q
    asks_rain = any(word in q for word in ["rain", "shower", "precipitation", "wet"])
    asks_forecast = asks_tomorrow or any(word in q for word in ["forecast", "later", "tonight", "morning", "afternoon", "evening"])
    asks_heat = any(word in q for word in ["hot", "heat", "temperature", "feels like"])

    if role.lower() == "farmer" and asks_spray:
        if asks_tomorrow and len(max_probs) > 1:
            tomorrow_prob = max_probs[1]
            if tomorrow_prob >= 60:
                return f"Avoid spraying tomorrow: the forecast rain probability is {tomorrow_prob:.0f}%, so rain wash-off risk is high. Recheck conditions before applying chemicals."
            return f"Spraying tomorrow may be feasible if field conditions remain dry: forecast rain probability is {tomorrow_prob:.0f}%. Avoid spraying if wind rises or rain begins."
        if wind > 15:
            return f"Conditions are UNSUITABLE for crop spraying because wind is {wind:.1f} km/h, which can cause spray drift."
        if rain_now > 0:
            return f"Postpone spraying: {rain_now:.1f} mm of precipitation is currently being observed."
        return f"Current conditions are potentially suitable for spraying: {wind:.1f} km/h wind and {rain_now:.1f} mm precipitation. Recheck the forecast immediately before application."

    if asks_rain or asks_forecast:
        today_prob = max_probs[0] if max_probs else (rain_prob if rain_prob is not None else 0)
        tomorrow_prob = max_probs[1] if len(max_probs) > 1 else None
        if asks_tomorrow and tomorrow_prob is not None:
            return f"Tomorrow's maximum precipitation probability is {tomorrow_prob:.0f}%. Today's current condition is {condition}, with {rain_now:.1f} mm precipitation now."
        return f"Current condition: {condition}, {rain_now:.1f} mm precipitation and {today_prob:.0f}% maximum rain probability today."

    if asks_heat:
        return f"Current temperature is {temp:.1f}°C, feels like {feels:.1f}°C, with {humidity:.0f}% humidity."

    return f"Current conditions are {condition}: {temp:.1f}°C (feels like {feels:.1f}°C), {humidity:.0f}% humidity, and wind at {wind:.1f} km/h from the {wind_direction_label(current_data.get('wind_direction_10m'))}."

@app.get("/api/v1/dashboard-weather")
async def get_dashboard_weather(latitude: float, longitude: float, location_name: str = "Selected Location"):
    raw_weather = await fetch_live_weather(latitude, longitude)
    current_metrics = raw_weather.get("current", {})
    daily = raw_weather.get("daily", {})
    hourly = raw_weather.get("hourly", {})
    has_warning, warning_msg = apply_warning_guardrails(current_metrics, daily)

    return {
        "location": location_name,
        "latitude": latitude,
        "longitude": longitude,
        "raw_weather": current_metrics,
        "daily_weather": daily,
        "hourly_weather": hourly,
        "condition": weather_code_description(current_metrics.get("weather_code")),
        "wind_direction_label": wind_direction_label(current_metrics.get("wind_direction_10m")),
        "warning_flag": has_warning,
        "official_warning": warning_msg,
        "grounding_metadata": {
            "source": "Open-Meteo Ingestion Pipeline",
            "timestamp": current_metrics.get("time"),
            "latitude": latitude,
            "longitude": longitude
        }
    }

@app.post("/api/v1/query", response_model=WeatherResponse)
async def handle_weather_query(payload: WeatherQueryRequest):
    lat, lon, resolved_name = await resolve_coordinates(payload.location_name)
    raw_weather = await fetch_live_weather(lat, lon)
    current_metrics = raw_weather.get("current", {})
    daily = raw_weather.get("daily", {})
    hourly = raw_weather.get("hourly", {})
    has_warning, warning_msg = apply_warning_guardrails(current_metrics, daily)
    advisory = generate_advisory(payload.user_role or "farmer", payload.query, current_metrics, daily, hourly, warning_msg)

    return WeatherResponse(
        location=resolved_name,
        latitude=lat,
        longitude=lon,
        raw_weather=current_metrics,
        daily_weather=daily,
        hourly_weather=hourly,
        warning_flag=has_warning,
        official_warning=warning_msg,
        actionable_advisory=advisory,
        grounding_metadata={
            "source": "Open-Meteo Ingestion Pipeline",
            "timestamp": current_metrics.get("time"),
            "latitude": lat,
            "longitude": lon
        }
    )


# Serve the AtmosX frontend from the same public deployment service.
BASE_DIR = Path(__file__).resolve().parent
from fastapi.staticfiles import StaticFiles
app.mount("/", StaticFiles(directory=str(BASE_DIR / "public"), html=True), name="frontend")
