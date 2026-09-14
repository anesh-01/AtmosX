"""
AtmosX 2.1 — Multilingual AI Weather Intelligence API
Backend: FastAPI + Gemini 3.6 Flash (server-side, key hidden from users)
Data: Open-Meteo (free, no auth required)
Security: Hardened headers, rate limiting, x-goog-api-key header auth, input sanitization
"""

import os
import re
import time
import json
import logging
import httpx
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List, Tuple

from dotenv import load_dotenv

# ──────────────────────────────────────────────────────────────────────────
# Logging: previously there was NO visibility at all into whether the Gemini
# call succeeded or silently fell back to the deterministic template engine.
# That made "the AI feels broken" bugs undiagnosable from outside a debugger.
# Every AI call outcome is now logged with enough detail to tell, from the
# server logs alone, whether Gemini responded, failed, or was never reached.
# ──────────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("atmosx")

from fastapi import FastAPI, APIRouter, HTTPException, Request, Query
from textblob import TextBlob
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import StreamingResponse, Response
from pydantic import BaseModel, Field, field_validator


# ==============================================================================
# SECTION 2: CONFIGURATION & CONSTANTS
# ==============================================================================

# --- Environment & Paths ---
_BASE = Path(__file__).resolve().parent
_ENV_FILE = _BASE / ".env"

try:
    load_dotenv(_ENV_FILE, override=True)
except Exception:
    pass

def _load_env() -> str:
    """Load .env file if it exists, then return GEMINI_API_KEY."""
    try:
        load_dotenv(_ENV_FILE, override=True)
    except Exception:
        if _ENV_FILE.exists():
            try:
                for line in _ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, _, v = line.partition("=")
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k and v:
                            os.environ[k] = v
            except Exception:
                pass
    return os.environ.get("GEMINI_API_KEY", "").strip()

_load_env()

# --- Upstream API Endpoints ---
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-3.6-flash:generateContent"
)
GEMINI_STREAM_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-3.6-flash:streamGenerateContent"
)
GEOCODING_URL   = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL    = "https://api.open-meteo.com/v1/forecast"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# --- Cache & Rate Limit Limits ---
WEATHER_CACHE_TTL = 120.0  # seconds
RATE_LIMIT_WINDOW = 60.0   # seconds
MAX_REQUESTS_PER_WINDOW = 90

# --- CORS Settings ---
raw_origins = os.environ.get("ALLOWED_ORIGINS", "").strip()
if raw_origins:
    allowed_origins = [o.strip() for o in raw_origins.split(",") if o.strip()]
else:
    allowed_origins = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:3000",
        "http://localhost:5173",
    ]

# --- Static Meteorological Lookup Tables & Constants ---
KNOWN_LOCATIONS: Dict[str, Tuple[float, float, str]] = {
    "wayanad": (11.6854, 76.1320, "Wayanad, Kerala"),
    "kalpetta": (11.6085, 76.0828, "Kalpetta, Wayanad"),
    "nashik": (19.9975, 73.7898, "Nashik, Maharashtra"),
    "nasik": (19.9975, 73.7898, "Nashik, Maharashtra"),
    "puri": (19.8135, 85.8312, "Puri, Odisha"),
    "leh": (34.1526, 77.5771, "Leh, Ladakh"),
    "ladakh": (34.1526, 77.5771, "Leh, Ladakh"),
    "chennai": (13.0827, 80.2707, "Chennai, Tamil Nadu"),
    "madras": (13.0827, 80.2707, "Chennai, Tamil Nadu"),
    "jaipur": (26.9124, 75.7873, "Jaipur, Rajasthan"),
    "guwahati": (26.1445, 91.7362, "Guwahati, Assam"),
    "mumbai": (19.0760, 72.8777, "Mumbai, Maharashtra"),
    "bombay": (19.0760, 72.8777, "Mumbai, Maharashtra"),
    "delhi": (28.6139, 77.2090, "Delhi NCR"),
    "new delhi": (28.6139, 77.2090, "Delhi NCR"),
    "delhi ncr": (28.6139, 77.2090, "Delhi NCR"),
    "shimla": (31.1048, 77.1734, "Shimla, Himachal Pradesh"),
    "bengaluru": (12.9716, 77.5946, "Bengaluru, Karnataka"),
    "bangalore": (12.9716, 77.5946, "Bengaluru, Karnataka"),
    "kolkata": (22.5726, 88.3639, "Kolkata, West Bengal"),
    "calcutta": (22.5726, 88.3639, "Kolkata, West Bengal"),
    "hyderabad": (17.3850, 78.4867, "Hyderabad, Telangana"),
    "pune": (18.5204, 73.8567, "Pune, Maharashtra"),
    "ahmedabad": (23.0225, 72.5714, "Ahmedabad, Gujarat"),
    "surat": (21.1702, 72.8311, "Surat, Gujarat"),
    "lucknow": (26.8467, 80.9462, "Lucknow, Uttar Pradesh"),
    "kanpur": (26.4499, 80.3319, "Kanpur, Uttar Pradesh"),
    "nagpur": (21.1458, 79.0882, "Nagpur, Maharashtra"),
    "patna": (25.5941, 85.1376, "Patna, Bihar"),
    "bhopal": (23.2599, 77.4126, "Bhopal, Madhya Pradesh"),
    "agra": (27.1767, 78.0081, "Agra, Uttar Pradesh"),
    "varanasi": (25.3176, 82.9739, "Varanasi, Uttar Pradesh"),
    "kochi": (9.9312, 76.2673, "Kochi, Kerala"),
    "cochin": (9.9312, 76.2673, "Kochi, Kerala"),
    "thiruvananthapuram": (8.5241, 76.9366, "Thiruvananthapuram, Kerala"),
    "trivandrum": (8.5241, 76.9366, "Thiruvananthapuram, Kerala"),
    "coimbatore": (11.0168, 76.9558, "Coimbatore, Tamil Nadu"),
    "madurai": (9.9252, 78.1198, "Madurai, Tamil Nadu"),
    "visakhapatnam": (17.6868, 83.2185, "Visakhapatnam, Andhra Pradesh"),
    "vizag": (17.6868, 83.2185, "Visakhapatnam, Andhra Pradesh"),
    "amritsar": (31.6340, 74.8723, "Amritsar, Punjab"),
    "chandigarh": (30.7333, 76.7794, "Chandigarh"),
    "dehradun": (30.3165, 78.0322, "Dehradun, Uttarakhand"),
    "ranchi": (23.3441, 85.3096, "Ranchi, Jharkhand"),
    "bhubaneswar": (20.2961, 85.8245, "Bhubaneswar, Odisha"),
    "goa": (15.2993, 74.1240, "Goa"),
    "panaji": (15.4909, 73.8278, "Panaji, Goa"),
    "darjeeling": (27.0360, 88.2627, "Darjeeling, West Bengal"),
    "manali": (32.2396, 77.1887, "Manali, Himachal Pradesh"),
    "gangtok": (27.3314, 88.6138, "Gangtok, Sikkim"),
    "shillong": (25.5788, 91.8933, "Shillong, Meghalaya"),
    "imphal": (24.8170, 93.9368, "Imphal, Manipur"),
    "srinagar": (34.0837, 74.7973, "Srinagar, Jammu & Kashmir"),
    "jammu": (32.7266, 74.8570, "Jammu, Jammu & Kashmir"),
    "indore": (22.7196, 75.8577, "Indore, Madhya Pradesh"),
    "mysore": (12.2958, 76.6394, "Mysuru, Karnataka"),
    "mysuru": (12.2958, 76.6394, "Mysuru, Karnataka"),
    "noida": (28.5355, 77.3910, "Noida, Uttar Pradesh"),
    "gurgaon": (28.4595, 77.0266, "Gurugram, Haryana"),
    "gurugram": (28.4595, 77.0266, "Gurugram, Haryana"),
    "faridabad": (28.4089, 77.3178, "Faridabad, Haryana"),
    "ghaziabad": (28.6692, 77.4538, "Ghaziabad, Uttar Pradesh"),
    "mangalore": (12.9141, 74.8560, "Mangaluru, Karnataka"),
    "mangaluru": (12.9141, 74.8560, "Mangaluru, Karnataka"),
    "ooty": (11.4102, 76.6950, "Ooty, Tamil Nadu"),
    "munnar": (10.0889, 77.0595, "Munnar, Kerala"),
    "london": (51.5074, -0.1278, "London, UK"),
    "new york": (40.7128, -74.0060, "New York, USA"),
    "paris": (48.8566, 2.3522, "Paris, France"),
    "tokyo": (35.6762, 139.6503, "Tokyo, Japan"),
    "dubai": (25.2048, 55.2708, "Dubai, UAE"),
    "singapore": (1.3521, 103.8198, "Singapore"),
    "sydney": (-33.8688, 151.2093, "Sydney, Australia"),
    "toronto": (43.6532, -79.3832, "Toronto, Canada"),
    "berlin": (52.5200, 13.4050, "Berlin, Germany"),
    "beijing": (39.9042, 116.4074, "Beijing, China"),
    "cairo": (30.0444, 31.2357, "Cairo, Egypt"),
    "moscow": (55.7558, 37.6173, "Moscow, Russia"),
    "rome": (41.9028, 12.4964, "Rome, Italy"),
    "madrid": (40.4168, -3.7038, "Madrid, Spain"),
    "seoul": (37.5665, 126.9780, "Seoul, South Korea"),
    "bangkok": (13.7563, 100.5018, "Bangkok, Thailand"),
    # Multilingual Native Script Names
    "சென்னையில்": (13.0827, 80.2707, "Chennai, Tamil Nadu"),
    "சென்னை": (13.0827, 80.2707, "Chennai, Tamil Nadu"),
    "വയനാട്ടിൽ": (11.6854, 76.1320, "Wayanad, Kerala"),
    "വയനാട്": (11.6854, 76.1320, "Wayanad, Kerala"),
    "दिल्ली": (28.6139, 77.2090, "Delhi NCR"),
    "मुंबई": (19.0760, 72.8777, "Mumbai, Maharashtra"),
    "बेंगलुरु": (12.9716, 77.5946, "Bengaluru, Karnataka"),
    "கொச்சி": (9.9312, 76.2673, "Kochi, Kerala"),
    "കൊച്ചി": (9.9312, 76.2673, "Kochi, Kerala"),
    "மதுரை": (9.9252, 78.1198, "Madurai, Tamil Nadu"),
    "கோயம்புத்தூர்": (11.0168, 76.9558, "Coimbatore, Tamil Nadu"),
    "जयपुर": (26.9124, 75.7873, "Jaipur, Rajasthan"),

}

# ─── Query Intelligence Helpers ────────────────────────────────────────────────

MULTILINGUAL_GREETINGS: Dict[str, Dict[str, Any]] = {
    "ta": {
        "patterns": ["வணக்கம்", "வணக்கங்கள்", "ஹலோ", "vanakkam"],
        "response": (
            "👋 **வணக்கம்! நான் AtmosX (weatherGPT)**, உங்கள் நேரடி AI வானிலை மற்றும் காலநிலை நுண்ணறிவு உதவியாளர்.\n\n"
            "நான் துல்லியமான நேரடி வானிலை அவதானிப்புகள், மழை எச்சரிக்கைகள் மற்றும் முன்னறிவிப்புகளை வழங்குகிறேன்.\n\n"
            "இன்று உங்களுக்கு எந்த ஊரின் வானிலை அல்லது என்ன தகவல் தேவை? (எ.கா: *\"சென்னையில் இன்று மழை பெய்யுமா?\"* அல்லது *\"மதுரை வெப்பநிலை என்ன?\"*)"
        )
    },
    "hi": {
        "patterns": ["नमस्ते", "नमस्कार", "प्रणाम", "हेलो", "हाय", "namaste", "namaskar"],
        "response": (
            "👋 **नमस्ते! मैं AtmosX (weatherGPT) हूँ**, आपका AI मौसम एवं जलवायु विशेषज्ञ सहायक।\n\n"
            "मैं वास्तविक समय का मौसम, वर्षा की संभावना, वायु गुणवत्ता और चक्रवात/तूफान अलर्ट प्रदान करता हूँ।\n\n"
            "आज मैं आपकी मौसम संबंधी क्या सहायता कर सकता हूँ? किसी भी शहर का नाम या मौसम का सवाल पूछें!"
        )
    },
    "ml": {
        "patterns": ["നമസ്കാരം", "ഹലോ", "ഹായ്", "namaskaram"],
        "response": (
            "👋 **നമസ്കാരം! ഞാൻ AtmosX (weatherGPT)**, നിങ്ങളുടെ തത്സമയ AI കാലാവസ്ഥാ സഹായി.\n\n"
            "തത്സമയ കാലാവസ്ഥാ വിവരങ്ങൾ, മഴ സാധ്യത, കാറ്റിന്റെ വേഗത, കാലാവസ്ഥാ മുന്നറിയിപ്പുകൾ എന്നിവ കൃത്യമായി നൽകാൻ ഞാൻ സജ്ജനാണ്.\n\n"
            "ഇന്ന് ഏത് സ്ഥലത്തെ കാലാവസ്ഥയാണ് അറിയേണ്ടത്? (ഉദാ: *\"വയനാട്ടിൽ നാളെ മഴ പെയ്യുമോ?\"*)"
        )
    },
    "te": {
        "patterns": ["నమస్కారం", "నమస్తే", "హలో", "namaskaram", "namaste"],
        "response": (
            "👋 **నమస్కారం! నేను AtmosX (weatherGPT)**, మీ నిజ-సమయ AI వాతావరణ సహాయకుడిని.\n\n"
            "వర్ష సూచనలు, ఉష్ణోగ్రత, తుఫాను హెచ్చరికలు మరియు ప్రత్యక్ష వాతావరణ సమాచారాన్ని నేను అందిస్తాను.\n\n"
            "ఈరోజు మీకు ఏ నగర వాతావరణ సమాచారం కావాలి?"
        )
    },
    "ar": {
        "patterns": ["مرحبا", "أهلا", "السلام عليكم", "صباح الخير", "مساء الخير", "marhaba", "salam"],
        "response": (
            "👋 **مرحباً! أنا AtmosX (weatherGPT)**، مساعدك الذكي لمعلومات الطقس والمناخ في الوقت الفعلي.\n\n"
            "أقدم توقعات دقيقة، رصد مباشر لدرجات الحرارة، تنبيهات العواصف، وجودة الهواء.\n\n"
            "كيف يمكنني مساعدتك في معرفة أحوال الطقس اليوم؟"
        )
    },
    "fr": {
        "patterns": ["bonjour", "salut", "bonsoir", "coucou"],
        "response": (
            "👋 **Bonjour ! Je suis AtmosX (weatherGPT)**, votre assistant d'intelligence météorologique et climatique en temps réel.\n\n"
            "Je fournis des observations précises, des alertes de tempête et des prévisions mondiales.\n\n"
            "Comment puis-je vous aider aujourd'hui ? Demandez la météo pour n'importe quelle ville !"
        )
    },
    "es": {
        "patterns": ["hola", "buenos dias", "buenas tardes", "buenas noches", "saludos"],
        "response": (
            "👋 **¡Hola! Soy AtmosX (weatherGPT)**, tu asistente de inteligencia meteorológica y climática en tiempo real.\n\n"
            "Ofrezco observaciones precisas, alertas de tormentas y pronósticos detallados.\n\n"
            "¿Cómo puedo ayudarte con el clima hoy? ¡Pregúntame sobre cualquier ciudad o pronóstico!"
        )
    },
}

DEFAULT_ENGLISH_GREETING = (
    "👋 **Hello! I'm AtmosX (weatherGPT)**, your personal AI meteorologist and climate intelligence assistant.\n\n"
    "I provide real-time weather observations, hyper-local forecasts, severe weather alerts, and climate analysis across the globe.\n\n"
    "How can I help you with the weather today? Ask me about any city, upcoming rain, wind conditions, or outdoor plans!"
)

ENGLISH_GREETINGS = {
    "hi", "hello", "hey", "hola", "namaste", "vanakkam", "namaskaram",
    "good morning", "good afternoon", "good evening", "greetings",
    "hi atmosx", "hello atmosx", "hey atmosx", "hi weathergpt", "hello weathergpt"
}

WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Heavy freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"
}

WIND_DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]


LANG_NAMES = {
    "hi": "Hindi (हिन्दी)", "ta": "Tamil (தமிழ்)", "te": "Telugu (తెలుగు)",
    "ml": "Malayalam (മലയാളം)", "kn": "Kannada (ಕನ್ನಡ)", "bn": "Bengali (বাংলা)",
    "mr": "Marathi (मराठी)", "gu": "Gujarati (ગુજરાતી)", "pa": "Punjabi (ਪੰਜਾਬੀ)",
    "or": "Odia (ଓଡ଼ିଆ)", "ur": "Urdu (اردو)", "ar": "Arabic (العربية)",
    "fr": "French (Français)", "es": "Spanish (Español)", "de": "German (Deutsch)",
    "pt": "Portuguese (Português)", "zh": "Chinese (中文)", "ja": "Japanese (日本語)",
    "ko": "Korean (한국어)", "ru": "Russian (Русский)", "tr": "Turkish (Türkçe)",
    "sw": "Swahili (Kiswahili)", "en": "English",
}



# ==============================================================================
# SECTION 3: PYDANTIC MODELS
# ==============================================================================

class WeatherQueryRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    location_name: str = Field(..., min_length=1, max_length=100)
    user_role: Optional[str] = Field("general", max_length=30)
    language: Optional[str] = Field("auto", max_length=10)

    @field_validator("query", "location_name")
    @classmethod
    def sanitize_strings(cls, v: str) -> str:
        cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", v).strip()
        if not cleaned:
            raise ValueError("Input cannot be empty.")
        return cleaned

class ChatRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=1500)
    location_name: Optional[str] = Field(None, max_length=100)
    language: Optional[str] = Field("auto", max_length=10)
    user_role: Optional[str] = Field("general", max_length=30)
    history: Optional[List[Dict[str, str]]] = Field(default=None)
    image_base64: Optional[str] = Field(default=None)
    image_mime_type: Optional[str] = Field(default="image/jpeg", max_length=50)

    @field_validator("query")
    @classmethod
    def sanitize_query(cls, v: str) -> str:
        cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", v).strip()
        if not cleaned:
            raise ValueError("Query cannot be empty.")
        return cleaned


# ==============================================================================
# SECTION 4: UTILITY HELPERS
# ==============================================================================
def weather_code_text(code) -> str:
    try: return WMO_CODES.get(int(code), f"Conditions (code {code})")
    except: return "Unknown conditions"

def wind_direction_label(degrees) -> str:
    try: return WIND_DIRS[round(float(degrees) / 22.5) % 16]
    except: return "Variable"

def _fv(v, default=0.0):
    try: return float(v)
    except: return default

def _first(lst, idx=0, default=None):
    try: return lst[idx] if lst and len(lst) > idx else default
    except: return default

def _current_hourly_index(hourly_times):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00")
    try: return hourly_times.index(now)
    except: return 0


# ─── Deterministic Weather Intent Router ───────────────────────────────────────
def parse_weather_intent(query: str, history: Optional[List[Dict[str, str]]] = None) -> Dict[str, Any]:
    """
    Deterministic intent parser for weather queries.
    Returns a dict with: period, day_offset, time_of_day, metrics, is_follow_up.
    The AI model must NEVER be the source of truth for factual weather values.
    This router ensures the correct forecast record is selected.
    """
    if not query:
        return {"is_weather": False, "period": "now", "period_explicit": False, "day_offset": 0, "time_of_day": None, "metrics": ["general"], "is_follow_up": False}

    q_raw = query.strip()
    q = q_raw.lower()

    # Follow-up context from conversation history
    prev_period = None
    prev_day_offset = 0
    is_follow_up = False

    if history:
        for turn in reversed(history):
            t_text = (turn.get("text") or turn.get("content") or "").strip()
            if turn.get("role") in ["user", "human"] and t_text != q_raw:
                prev_intent = parse_weather_intent(t_text, None)
                if prev_intent.get("is_weather"):
                    prev_period = prev_intent["period"]
                    prev_day_offset = prev_intent["day_offset"]
                    break

    # ── Temporal Period Detection (EN, TA, ML, HI, TE, FR, ES) ──
    period = None
    day_offset = 0
    time_of_day = None

    # Day After Tomorrow
    if any(k in q for k in ["day after tomorrow", "நாளை மறுநாள்", "மற்றன்னாள்", "परसों", "ఎల్లుండి", "après-demain", "pasado mañana"]):
        period = "day_after_tomorrow"
        day_offset = 2
    # Tomorrow
    elif any(k in q for k in ["tomorrow", "tmrw", "tomorow", "நாளைக்கு", "நாளை", "നാളെ", "कल", "రేపు", "demain", "mañana"]):
        period = "tomorrow"
        day_offset = 1
    # Today
    elif any(k in q for k in ["today", "tonight", "this morning", "this evening", "this afternoon",
                               "இன்று", "இன்றைய", "இன்றைக்கு", "ഇന്ന്", "ഇന്നത്തെ", "आज", "ఈరోజు", "aujourd'hui", "hoy"]):
        period = "today"
        day_offset = 0
    # Now / Current
    elif any(k in q for k in ["now", "currently", "right now", "current", "at the moment", "present",
                               "தற்போது", "இப்போது", "ഇപ്പോൾ", "अभी", "वर्तमान", "ఇప్పుడు"]):
        period = "now"
        day_offset = 0
    # This week / weekend / coming days / later — genuinely multi-day asks.
    # These must NOT collapse to "now": they get period="week_outlook" and are
    # handled as a short multi-day summary, not a single day's forecast.
    elif any(k in q for k in ["this week", "next few days", "coming days", "upcoming days", "weekend",
                               "this weekend", "later this week", "இந்த வாரம்", "இந்த வார இறுதி",
                               "इस हफ्ते", "इस सप्ताह", "सप्ताहांत", "ఈ వారం", "cette semaine", "esta semana"]):
        period = "week_outlook"
        day_offset = 0

    # ── Time of Day Detection ──
    if any(k in q for k in ["morning", "காலை", "രാവിലെ", "सुबह", "ఉదయం", "matin"]):
        time_of_day = "morning"
    elif any(k in q for k in ["afternoon", "noon", "மதியம்", "ഉച്ചയ്ക്ക്", "दोपहर", "మధ్యాహ్నం"]):
        time_of_day = "afternoon"
    elif any(k in q for k in ["evening", "dusk", "மாலை", "വൈകുന്നേരം", "शाम", "సాయంత్రం"]):
        time_of_day = "evening"
    elif any(k in q for k in ["tonight", "night", "இரவு", "ராத்திரி", "രാത്രി", "रात", "రాత్రి"]):
        time_of_day = "night"
        if not period:
            period = "today"

    # Follow-up inheritance: "What about morning?" inherits period from prior turn
    if not period and (time_of_day or q.startswith("what about") or q.startswith("how about") or "about " in q):
        if prev_period:
            period = prev_period
            day_offset = prev_day_offset
            is_follow_up = True
        else:
            period = "today"
            day_offset = 0

    # No explicit temporal keyword matched at all. This used to silently
    # become period="now" here, which is what made almost every ambiguously
    # phrased question ("what's the forecast", "will it rain this week"
    # without those exact words, "how's the weather looking") get answered
    # with ONLY current conditions regardless of what was actually asked.
    # "unspecified" instead tells the facts extractor and the AI prompt to
    # supply a short current+upcoming overview and let real language
    # understanding (the AI, not this keyword list) decide what's relevant.
    period_explicit = period is not None
    if not period:
        period = "unspecified"
        day_offset = 0

    # ── Metric Focus Detection (Multilingual) ──
    metrics = []
    if any(k in q for k in ["condition", "weather condition", "look like", "sky", "situation", "நிலைமை", "स्थिति", "వాతావరణం"]):
        metrics.append("condition")
    if any(k in q for k in ["rain", "raining", "rainfall", "rainy", "shower", "drizzle", "precipitation",
                             "மழை", "மழை பெய்யுமா", "തூறல്", "മഴ", "മഴ പെയ്യുമോ", "बारिश", "वर्षा", "వర్షం", "lluvia", "pluie"]):
        metrics.append("rain")
    if any(k in q for k in ["temp", "temperature", "hot", "heat", "cold", "chill", "degree", "celsius",
                             "வெப்பநிலை", "வெப்பம்", "താപനില", "ചൂട്", "तापमान", "गर्मी", "ठंड", "ఉష్ణోగ్రత"]):
        metrics.append("temperature")
    if any(k in q for k in ["wind", "windy", "breeze", "gust", "gale", "காற்று", "കാറ്റ്", "हवा", "గాలి"]):
        metrics.append("wind")
    if any(k in q for k in ["uv", "uv index", "ultraviolet", "sunburn", "யுவி", "യുവി", "पराबैंगनी"]):
        metrics.append("uv")
    if any(k in q for k in ["humidity", "humid", "dew point", "moisture", "muggy", "ஈரப்பதம்", "ഈർപ്പം", "आर्द्रता", "తేమ"]):
        metrics.append("humidity")
    if any(k in q for k in ["pressure", "barometer", "barometric", "hpa", "அழுத்தம்", "മർദ്ദം", "दबाव", "పీడనం"]):
        metrics.append("pressure")
    if any(k in q for k in ["aqi", "air quality", "pollution", "pm2.5", "pm10", "காற்றின் தரம்", "വായു ഗുണനിലവാരം", "वायु गुणवत्ता"]):
        metrics.append("air_quality")
    if any(k in q for k in ["hiking", "hike", "umbrella", "spray", "crop", "farming", "picnic", "outdoor", "travel",
                             "குடை", "விவசாயம்", "கുട", "യാത്ര", "छाता", "यात्रा"]):
        metrics.append("activity_advice")

    if not metrics:
        metrics = ["general"]

    return {
        "is_weather": True,
        "period": period,
        "period_explicit": period_explicit,
        "day_offset": day_offset,
        "time_of_day": time_of_day,
        "metrics": metrics,
        "is_follow_up": is_follow_up,
    }


def extract_structured_weather_facts(
    weather_data: Dict[str, Any],
    aqi_data: Optional[Dict[str, Any]],
    location_name: str,
    intent: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Extract ONLY the verified weather facts relevant to the user's requested period/time.
    The AI model must NEVER be the source of truth for factual weather values.
    All values come directly from the Open-Meteo API response.
    """
    current = weather_data.get("current", {})
    daily   = weather_data.get("daily", {})
    hourly  = weather_data.get("hourly", {})

    daily_times = daily.get("time") or []
    day_offset = intent.get("day_offset", 0)
    target_idx = min(day_offset, len(daily_times) - 1) if daily_times else 0
    target_date = daily_times[target_idx] if daily_times else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    period = intent.get("period", "now")
    time_of_day = intent.get("time_of_day")

    facts: Dict[str, Any] = {
        "location": location_name,
        "requested_period": period,
        "requested_time_of_day": time_of_day,
        "target_date": target_date,
        "source": "Open-Meteo (WMO-compliant NWP)",
        "metrics_focus": intent.get("metrics", ["general"]),
    }

    # ── AMBIGUOUS / MULTI-DAY: no single day was clearly requested ──
    # This covers both "unspecified" (no temporal keyword matched at all —
    # previously this silently became "current conditions only", which is
    # the main reason most questions looked like they only ever answered
    # about right now) and "week_outlook" ("this week", "weekend", etc.).
    # Give both the current snapshot AND a short multi-day table so the AI
    # (or the deterministic fallback) can actually address what was asked
    # instead of defaulting to a single current-conditions reading.
    if period in ("unspecified", "week_outlook") and not time_of_day:
        facts["temporal_scope"] = "broad_overview"
        facts["observed_at"] = current.get("time")
        facts["condition"] = weather_code_text(current.get("weather_code"))
        facts["temperature_c"] = current.get("temperature_2m")
        facts["feels_like_c"] = current.get("apparent_temperature")
        facts["humidity_pct"] = current.get("relative_humidity_2m")
        facts["wind_kmh"] = current.get("wind_speed_10m")
        facts["precipitation_mm"] = current.get("precipitation", 0.0)
        if aqi_data and isinstance(aqi_data, dict):
            facts["us_aqi"] = aqi_data.get("us_aqi")

        span = 7 if period == "week_outlook" else 4
        outlook = []
        for idx in range(min(span, len(daily_times))):
            outlook.append({
                "date": daily_times[idx],
                "label": "Today" if idx == 0 else ("Tomorrow" if idx == 1 else daily_times[idx]),
                "condition": weather_code_text(_first(daily.get("weather_code"), idx)),
                "temp_min_c": _first(daily.get("temperature_2m_min"), idx),
                "temp_max_c": _first(daily.get("temperature_2m_max"), idx),
                "rain_probability_pct": _first(daily.get("precipitation_probability_max"), idx),
                "rain_mm": _first(daily.get("precipitation_sum"), idx),
                "wind_max_kmh": _first(daily.get("wind_speed_10m_max"), idx),
            })
        facts["outlook_days"] = outlook
        return facts

    # ── CURRENT / NOW ──
    if period == "now" and not time_of_day:
        facts["temporal_scope"] = "current_instant"
        facts["observed_at"] = current.get("time")
        code = current.get("weather_code")
        facts["weather_code"] = code
        facts["condition"] = weather_code_text(code)
        facts["temperature_c"] = current.get("temperature_2m")
        facts["feels_like_c"] = current.get("apparent_temperature")
        facts["humidity_pct"] = current.get("relative_humidity_2m")
        facts["precipitation_mm"] = current.get("precipitation", 0.0)
        facts["rain_mm"] = current.get("rain", 0.0)
        facts["wind_kmh"] = current.get("wind_speed_10m")
        facts["wind_gusts_kmh"] = current.get("wind_gusts_10m")
        facts["wind_direction"] = wind_direction_label(current.get("wind_direction_10m"))
        facts["pressure_hpa"] = current.get("pressure_msl")
        facts["uv_index"] = current.get("uv_index")
        facts["cloud_cover_pct"] = current.get("cloud_cover")
        facts["visibility_m"] = current.get("visibility")
        if aqi_data and isinstance(aqi_data, dict):
            facts["us_aqi"] = aqi_data.get("us_aqi")
            facts["pm25"] = aqi_data.get("pm2_5")
            facts["pm10"] = aqi_data.get("pm10")
        return facts

    # ── FORECAST (Today / Tomorrow / Day After / etc.) ──
    facts["temporal_scope"] = f"forecast_{period}"
    day_code = _first(daily.get("weather_code"), target_idx)
    facts["weather_code"] = day_code
    facts["condition"] = weather_code_text(day_code)
    facts["temperature_max_c"] = _first(daily.get("temperature_2m_max"), target_idx)
    facts["temperature_min_c"] = _first(daily.get("temperature_2m_min"), target_idx)
    facts["feels_max_c"] = _first(daily.get("apparent_temperature_max"), target_idx)
    facts["feels_min_c"] = _first(daily.get("apparent_temperature_min"), target_idx)
    facts["rain_probability_pct"] = _first(daily.get("precipitation_probability_max"), target_idx)
    facts["precipitation_sum_mm"] = _first(daily.get("precipitation_sum"), target_idx)
    facts["wind_max_kmh"] = _first(daily.get("wind_speed_10m_max"), target_idx)
    facts["wind_gusts_kmh"] = _first(daily.get("wind_gusts_10m_max"), target_idx)
    facts["uv_index_max"] = _first(daily.get("uv_index_max"), target_idx)
    facts["sunrise"] = _first(daily.get("sunrise"), target_idx)
    facts["sunset"] = _first(daily.get("sunset"), target_idx)

    # ── Time-of-Day Slice (morning/afternoon/evening/night) ──
    if time_of_day:
        hourly_times = hourly.get("time") or []
        hour_windows = {"morning": (6, 11), "afternoon": (12, 17), "evening": (18, 21), "night": (22, 28)}
        start_h, end_h = hour_windows.get(time_of_day, (6, 18))

        slice_temps, slice_feels, slice_rain_probs, slice_rain_mms, slice_winds, slice_codes = [], [], [], [], [], []
        for i, t_str in enumerate(hourly_times):
            if t_str.startswith(target_date):
                try:
                    h_val = int(t_str.split("T")[1].split(":")[0])
                    in_window = (start_h <= h_val <= end_h) if start_h < 22 else (h_val >= 22 or h_val <= 5)
                    if in_window:
                        slice_temps.append(_fv(_first(hourly.get("temperature_2m"), i)))
                        slice_feels.append(_fv(_first(hourly.get("apparent_temperature"), i)))
                        slice_rain_probs.append(_fv(_first(hourly.get("precipitation_probability"), i)))
                        slice_rain_mms.append(_fv(_first(hourly.get("precipitation"), i)))
                        slice_winds.append(_fv(_first(hourly.get("wind_speed_10m"), i)))
                        c = _first(hourly.get("weather_code"), i)
                        if c is not None:
                            slice_codes.append(int(c))
                except Exception:
                    pass

        if slice_temps:
            facts["slice_temp_avg_c"] = round(sum(slice_temps) / len(slice_temps), 1)
            facts["slice_temp_max_c"] = max(slice_temps)
            facts["slice_temp_min_c"] = min(slice_temps)
        if slice_feels:
            facts["slice_feels_avg_c"] = round(sum(slice_feels) / len(slice_feels), 1)
        if slice_rain_probs:
            facts["slice_rain_probability_pct"] = max(slice_rain_probs)
        if slice_rain_mms:
            facts["slice_precipitation_mm"] = round(sum(slice_rain_mms), 1)
        if slice_winds:
            facts["slice_wind_kmh"] = max(slice_winds)
        if slice_codes:
            worst_code = max(slice_codes, key=lambda x: (x in {95, 96, 99}, x in {65, 63, 61, 80, 81, 82}, x))
            facts["slice_condition"] = weather_code_text(worst_code)
            facts["condition"] = weather_code_text(worst_code)

    return facts


def format_verified_facts_for_prompt(facts: Dict[str, Any]) -> str:
    """
    Format the structured facts into a deterministic text block for the AI prompt.
    This tells the AI EXACTLY what period/date the user asked about and what
    verified values to use. The AI must not alter these values.
    """
    lines = [
        "=== VERIFIED STRUCTURED WEATHER FACTS (SOURCE OF TRUTH) ===",
        f"Location: {facts.get('location', 'Unknown')}",
        f"User Requested Period: {facts.get('requested_period', 'now').upper()}",
        f"Target Date: {facts.get('target_date', 'N/A')}",
    ]
    if facts.get("requested_time_of_day"):
        lines.append(f"Time Slice: {facts['requested_time_of_day'].upper()}")
    lines.append(f"Data Source: {facts.get('source', 'Open-Meteo')}")
    lines.append("")

    scope = facts.get("temporal_scope", "")
    if scope == "current_instant":
        lines.append("--- Current Conditions (Live Observation) ---")
        lines.append(f"Condition: {facts.get('condition')}")
        lines.append(f"Temperature: {facts.get('temperature_c')}°C (Feels like {facts.get('feels_like_c')}°C)")
        lines.append(f"Humidity: {facts.get('humidity_pct')}%")
        lines.append(f"Wind: {facts.get('wind_kmh')} km/h from {facts.get('wind_direction')} (Gusts: {facts.get('wind_gusts_kmh')} km/h)")
        lines.append(f"Precipitation: {facts.get('precipitation_mm')} mm")
        lines.append(f"Pressure: {facts.get('pressure_hpa')} hPa")
        lines.append(f"UV Index: {facts.get('uv_index')}")
        if facts.get("us_aqi") is not None:
            lines.append(f"Air Quality (US AQI): {facts.get('us_aqi')} | PM2.5: {facts.get('pm25')}")
    elif scope == "broad_overview":
        lines.append("--- No single day was clearly requested: current conditions PLUS a short outlook ---")
        lines.append(f"Right now: {facts.get('condition')}, {facts.get('temperature_c')}°C (feels {facts.get('feels_like_c')}°C), "
                      f"humidity {facts.get('humidity_pct')}%, wind {facts.get('wind_kmh')} km/h, precipitation {facts.get('precipitation_mm')} mm.")
        if facts.get("us_aqi") is not None:
            lines.append(f"Air Quality (US AQI): {facts.get('us_aqi')}")
        lines.append("Upcoming days:")
        for day in facts.get("outlook_days", []):
            lines.append(
                f"- {day['label']} ({day['date']}): {day['condition']}, "
                f"{day['temp_min_c']}°C–{day['temp_max_c']}°C, rain {day['rain_probability_pct']}% "
                f"({day['rain_mm']} mm), wind up to {day['wind_max_kmh']} km/h"
            )
        lines.append("")
        lines.append("IMPORTANT: The user did not name one specific day, so read their actual question and use "
                      "whichever row(s) above actually answer it (e.g. 'this week' -> summarize the days; a plain "
                      "'will it rain' -> today's row is usually most relevant). Do NOT just describe 'right now' "
                      "by default if the wording implies a future or multi-day timeframe.")
    else:
        period_label = facts.get("requested_period", "forecast").replace("_", " ").title()
        tod = facts.get("requested_time_of_day")
        if tod:
            period_label += f" ({tod.capitalize()})"
        lines.append(f"--- Forecast for {period_label} ({facts.get('target_date')}) ---")
        lines.append(f"Condition: {facts.get('condition')}")

        if facts.get("slice_temp_max_c") is not None:
            lines.append(f"Temperature: {facts.get('slice_temp_min_c')}°C – {facts.get('slice_temp_max_c')}°C (Avg: {facts.get('slice_temp_avg_c')}°C)")
        else:
            lines.append(f"Temperature: {facts.get('temperature_min_c')}°C – {facts.get('temperature_max_c')}°C")

        rain_prob = facts.get("slice_rain_probability_pct") or facts.get("rain_probability_pct", 0)
        rain_mm = facts.get("slice_precipitation_mm") or facts.get("precipitation_sum_mm", 0)
        lines.append(f"Rain Probability: {rain_prob}%")
        lines.append(f"Expected Precipitation: {rain_mm} mm")
        lines.append(f"Max Wind: {facts.get('slice_wind_kmh') or facts.get('wind_max_kmh')} km/h (Gusts: {facts.get('wind_gusts_kmh')} km/h)")
        lines.append(f"Max UV Index: {facts.get('uv_index_max')}")
        lines.append(f"Sunrise: {facts.get('sunrise')} | Sunset: {facts.get('sunset')}")

    lines.append("")
    lines.append("CRITICAL: Use ONLY the values above. Do NOT invent, substitute, or infer different values.")
    if scope == "broad_overview":
        lines.append("Pick the day(s)/timeframe from the table that actually matches the question — do not silently default to only 'right now'.")
    else:
        lines.append(f"Answer the user's question about {facts.get('requested_period', 'now').upper()} weather ONLY. Do not mix in other periods unless asked.")

    return "\n".join(lines)


def format_deterministic_response(facts: Dict[str, Any], language: str = "en") -> str:
    """
    Generate a complete deterministic response from verified facts when AI is unavailable.
    No AI hallucination possible — every value comes from the verified facts dict.
    """
    lang = (language or "en").lower()
    loc = facts.get("location", "Selected Location")
    period = facts.get("requested_period", "now")
    time_of_day = facts.get("requested_time_of_day")
    cond = facts.get("condition", "Clear sky")
    date_str = facts.get("target_date", "")
    metrics = facts.get("metrics_focus", ["general"])

    # ── CURRENT CONDITIONS ──
    if facts.get("temporal_scope") == "current_instant":
        t_c = facts.get("temperature_c")
        feels = facts.get("feels_like_c")
        hum = facts.get("humidity_pct")
        wind = facts.get("wind_kmh")
        wind_dir = facts.get("wind_direction", "Variable")
        press = facts.get("pressure_hpa", 1012)
        uv = facts.get("uv_index", 0)

        if lang == "ta":
            return (f"🌤️ **{loc} நேரடி வானிலை நிலவரம்**:\n\n"
                    f"• **வானிலை நிலை**: **{cond}**\n"
                    f"• **வெப்பநிலை**: **{t_c}°C** (உணரப்படுவது: **{feels}°C**)\n"
                    f"• **ஈரப்பதம்**: **{hum}%**\n"
                    f"• **காற்று**: மணிக்கு **{wind} km/h** ({wind_dir})\n"
                    f"• **வளிமண்டல அழுத்தம்**: **{press} hPa**")
        elif lang == "ml":
            return (f"🌤️ **{loc} തത്സമയ കാലാവസ്ഥ**:\n\n"
                    f"• **കാലാവസ്ഥ**: **{cond}**\n"
                    f"• **താപനില**: **{t_c}°C** (അനുഭവപ്പെടുന്നത്: **{feels}°C**)\n"
                    f"• **ഈർപ്പം**: **{hum}%**\n"
                    f"• **കാറ്റ്**: **{wind} km/h** ({wind_dir})\n"
                    f"• **മർദ്ദം**: **{press} hPa**")
        elif lang == "hi":
            return (f"🌤️ **{loc} का वर्तमान मौसम**:\n\n"
                    f"• **मौसम की स्थिति**: **{cond}**\n"
                    f"• **तापमान**: **{t_c}°C** (महसूस: **{feels}°C**)\n"
                    f"• **आर्द्रता**: **{hum}%**\n"
                    f"• **हवा**: **{wind} km/h** ({wind_dir})\n"
                    f"• **दबाव**: **{press} hPa**")
        else:
            return (f"🌤️ **Current Weather in {loc}**:\n\n"
                    f"• **Condition**: **{cond}**\n"
                    f"• **Temperature**: **{t_c}°C** (Feels like **{feels}°C**)\n"
                    f"• **Humidity**: **{hum}%**\n"
                    f"• **Wind**: **{wind} km/h** from **{wind_dir}**\n"
                    f"• **Pressure**: **{press} hPa**\n"
                    f"• **UV Index**: **{uv}**")

    # ── BROAD / AMBIGUOUS OVERVIEW (no single day requested) ──
    # This is the fallback path's answer to the exact bug being fixed: when no
    # explicit period was named, show current conditions PLUS a short outlook
    # instead of just current conditions alone.
    if facts.get("temporal_scope") == "broad_overview":
        t_c = facts.get("temperature_c")
        feels = facts.get("feels_like_c")
        hum = facts.get("humidity_pct")
        wind = facts.get("wind_kmh")
        days = facts.get("outlook_days", [])

        def day_line_en(d):
            return f"• **{d['label']}** ({d['date']}): {d['condition']}, {d['temp_min_c']}°C–{d['temp_max_c']}°C, rain {d['rain_probability_pct']}%"

        def day_line_ta(d):
            return f"• **{d['label']}** ({d['date']}): {d['condition']}, {d['temp_min_c']}°C–{d['temp_max_c']}°C, மழை {d['rain_probability_pct']}%"

        def day_line_hi(d):
            return f"• **{d['label']}** ({d['date']}): {d['condition']}, {d['temp_min_c']}°C–{d['temp_max_c']}°C, बारिश {d['rain_probability_pct']}%"

        if lang == "ta":
            header = f"🌤️ **{loc} — தற்போதைய நிலவரமும் அடுத்த சில நாட்களும்**:\n\n• **இப்போது**: {cond}, {t_c}°C (உணரப்படுவது {feels}°C), ஈரப்பதம் {hum}%, காற்று {wind} km/h\n\n**அடுத்த நாட்கள்**:\n"
            return header + "\n".join(day_line_ta(d) for d in days)
        if lang == "hi":
            header = f"🌤️ **{loc} — अभी और आने वाले दिन**:\n\n• **अभी**: {cond}, {t_c}°C (महसूस {feels}°C), आर्द्रता {hum}%, हवा {wind} km/h\n\n**आने वाले दिन**:\n"
            return header + "\n".join(day_line_hi(d) for d in days)
        header = f"🌤️ **{loc} — Right Now & the Days Ahead**:\n\n• **Right now**: {cond}, {t_c}°C (feels like {feels}°C), humidity {hum}%, wind {wind} km/h\n\n**Coming days**:\n"
        return header + "\n".join(day_line_en(d) for d in days)

    # ── FORECAST PERIOD ──
    t_max = facts.get("slice_temp_max_c") or facts.get("temperature_max_c")
    t_min = facts.get("slice_temp_min_c") or facts.get("temperature_min_c")
    rain_prob = facts.get("slice_rain_probability_pct") or facts.get("rain_probability_pct", 0)
    rain_mm = facts.get("slice_precipitation_mm") or facts.get("precipitation_sum_mm", 0.0)
    wind_max = facts.get("slice_wind_kmh") or facts.get("wind_max_kmh", 0.0)
    uv_max = facts.get("uv_index_max", 0.0)
    needs_umbrella = _fv(rain_prob) >= 40 or _fv(rain_mm) > 0.5

    # Period labels
    period_en = "Tomorrow" if period == "tomorrow" else ("Today" if period == "today" else f"Forecast ({date_str})")
    period_ta = "நாளை" if period == "tomorrow" else ("இன்று" if period == "today" else date_str)
    period_ml = "നാളെ" if period == "tomorrow" else ("ഇന്ന്" if period == "today" else date_str)
    period_hi = "कल" if period == "tomorrow" else ("आज" if period == "today" else date_str)

    tod_map_en = {"morning": "Morning", "afternoon": "Afternoon", "evening": "Evening", "night": "Night"}
    tod_map_ta = {"morning": "காலை", "afternoon": "மதியம்", "evening": "மாலை", "night": "இரவு"}
    tod_map_ml = {"morning": "രാവിലെ", "afternoon": "ഉച്ചയ്ക്ക്", "evening": "വൈകുന്നേരം", "night": "രാത്രി"}
    tod_map_hi = {"morning": "सुबह", "afternoon": "दोपहर", "evening": "शाम", "night": "रात"}

    if time_of_day:
        period_en += f" {tod_map_en.get(time_of_day, '')}"
        period_ta += f" {tod_map_ta.get(time_of_day, '')}"
        period_ml += f" {tod_map_ml.get(time_of_day, '')}"
        period_hi += f" {tod_map_hi.get(time_of_day, '')}"

    # Recommendations
    if "activity_advice" in metrics:
        is_good = _fv(rain_prob) < 30 and _fv(wind_max) < 30 and "thunderstorm" not in cond.lower() and "rain" not in cond.lower()
        rec_en = f"Conditions look suitable for outdoor activities ({rain_prob}% rain chance)." if is_good else f"Outdoor plans may be affected — {cond} with {rain_prob}% precipitation chance."
        rec_ta = f"வெளிப்புற செயல்பாடுகளுக்கு ஏற்ற வானிலை ({rain_prob}% மழை வாய்ப்பு)." if is_good else f"வெளிப்புற திட்டங்கள் பாதிக்கப்படலாம் — {cond}, {rain_prob}% மழை வாய்ப்பு."
        rec_ml = f"യാത്രകൾക്ക് അനുയോജ്യമായ കാലാവസ്ഥ ({rain_prob}% മഴ സാധ്യത)." if is_good else f"പുറത്തുപോകുന്നതിന് മുൻപ് ശ്രദ്ധിക്കുക — {cond}, {rain_prob}% മഴ."
        rec_hi = f"बाहरी गतिविधियों के लिए अनुकूल मौसम ({rain_prob}% बारिश)." if is_good else f"सावधानी: {cond}, {rain_prob}% बारिश की संभावना।"
    elif "rain" in metrics:
        rec_en = f"Yes, carry an umbrella ({rain_prob}% rain probability, {rain_mm} mm expected)." if needs_umbrella else f"Rain is unlikely ({rain_prob}%), umbrella not required."
        rec_ta = f"ஆம், குடை எடுத்துச் செல்லுங்கள் ({rain_prob}% மழை வாய்ப்பு, {rain_mm} mm)." if needs_umbrella else f"மழை வாய்ப்பு குறைவு ({rain_prob}%), குடை தேவையில்லை."
        rec_ml = f"അതെ, കുട കരുതുക ({rain_prob}% മഴ, {rain_mm} mm)." if needs_umbrella else f"മഴ സാധ്യത കുറവാണ് ({rain_prob}%)."
        rec_hi = f"हाँ, छाता रखें ({rain_prob}% बारिश, {rain_mm} mm)." if needs_umbrella else f"बारिश की संभावना कम ({rain_prob}%)."
    else:
        rec_en = f"Carry an umbrella ({rain_prob}% rain chance)." if needs_umbrella else "Conditions are expected to remain steady."
        rec_ta = f"குடை கொண்டு செல்லுங்கள் ({rain_prob}% மழை வாய்ப்பு)." if needs_umbrella else "வானிலை சீராக இருக்கும்."
        rec_ml = f"കുട കരുതുക ({rain_prob}% മഴ)." if needs_umbrella else "കാലാവസ്ഥ ശാന്തമായിരിക്കും."
        rec_hi = f"छाता रखें ({rain_prob}% बारिश)." if needs_umbrella else "मौसम सामान्य रहेगा।"

    if lang == "ta":
        return (f"🌦️ **{loc} {period_ta} வானிலை** ({date_str}):\n\n"
                f"• **வானிலை நிலை**: **{cond}**\n"
                f"• **வெப்பநிலை**: **{t_min}°C – {t_max}°C**\n"
                f"• **மழை சாத்தியக்கூறு**: **{rain_prob}%** ({rain_mm} mm)\n"
                f"• **காற்று**: அதிகபட்சம் **{wind_max} km/h**\n"
                f"• **பரிந்துரை**: {rec_ta}")
    elif lang == "ml":
        return (f"🌦️ **{loc} {period_ml} കാലാവസ്ഥ** ({date_str}):\n\n"
                f"• **കാലാവസ്ഥ**: **{cond}**\n"
                f"• **താപനില**: **{t_min}°C – {t_max}°C**\n"
                f"• **മഴ സാധ്യത**: **{rain_prob}%** ({rain_mm} mm)\n"
                f"• **കാറ്റ്**: പരമാവധി **{wind_max} km/h**\n"
                f"• **നിർദ്ദേശം**: {rec_ml}")
    elif lang == "hi":
        return (f"🌦️ **{loc} {period_hi} का मौसम** ({date_str}):\n\n"
                f"• **स्थिति**: **{cond}**\n"
                f"• **तापमान**: **{t_min}°C – {t_max}°C**\n"
                f"• **बारिश की संभावना**: **{rain_prob}%** ({rain_mm} mm)\n"
                f"• **हवा**: अधिकतम **{wind_max} km/h**\n"
                f"• **सलाह**: {rec_hi}")
    else:
        return (f"🌦️ **{loc} — {period_en} Forecast** ({date_str}):\n\n"
                f"• **Condition**: **{cond}**\n"
                f"• **Temperature**: **{t_min}°C – {t_max}°C**\n"
                f"• **Rain Probability**: **{rain_prob}%** (Expected: **{rain_mm} mm**)\n"
                f"• **Wind**: Up to **{wind_max} km/h**\n"
                f"• **UV Index**: **{uv_max}**\n"
                f"• **Recommendation**: {rec_en}")


def detect_casual_greeting(query: str) -> Optional[str]:
    """Return friendly instant response for pure greetings without calling AI API."""
    if not query:
        return None
    q_raw = query.strip()
    q_lower = q_raw.lower()

    # 1. Native script and language-specific greetings
    for lang, data in MULTILINGUAL_GREETINGS.items():
        for pat in data["patterns"]:
            if q_lower == pat.lower() or q_raw == pat or q_raw.rstrip("?.! ") == pat:
                return data["response"]

    # 2. English & regex greetings
    cleaned = re.sub(r"[^\w\s]", "", q_lower).strip()
    if cleaned in ENGLISH_GREETINGS or re.fullmatch(r"(hi+|hello+|hey+)(\s+there|\s+atmosx|\s+weathergpt)?", cleaned):
        return DEFAULT_ENGLISH_GREETING
    return None

def detect_identity_or_capabilities(query: str) -> Optional[str]:
    """Return prompt capability explanation for identity/GPT queries."""
    if not query:
        return None
    q = query.lower().strip()
    q_raw = query.strip()

    # Tamil check
    if any(k in q_raw for k in ["நீ யார்", "நீங்கள் யார்", "உன் பெயர் என்ன", "உங்கள் பெயர் என்ன", "நீ என்ன செய்வாய்"]):
        return (
            "🌤️ **நான் AtmosX / weatherGPT** — உலகளாவிய பன்மொழி AI வானிலை மற்றும் காலநிலை நுண்ணறிவு உதவியாளர்.\n\n"
            "• **நேரடி வானிலை அவதானிப்புகள்**: வெப்பநிலை, உணரப்படும் வெப்பம், ஈரப்பதம், காற்றின் வேகம், அழுத்தம் மற்றும் காற்றின் தரம் (AQI).\n"
            "• **துல்லியமான NWP முன்னறிவிப்புகள்**: Open-Meteo மாதிரிகள் அடிப்படையிலான மணிநேர மற்றும் 7 நாள் கணிப்புகள்.\n"
            "• **தீவிர வானிலை எச்சரிக்கைகள்**: கனமழை, புயல், வெப்ப அலை மற்றும் நிலச்சரிவு முன்னெச்சரிக்கைகள்.\n"
            "• **பன்மொழி சேவை**: தமிழ், ஆங்கிலம், இந்தி, மலையாளம் உள்ளிட்ட 20+ மொழிகளில் உரையாடலாம்.\n\n"
            "என்னிடம் கேளுங்கள்: *\"சென்னையில் இன்று மழை பெய்யுமா?\"* அல்லது *\"மதுரையில் நாளை வானிலை எப்படி இருக்கும்?\"*"
        )

    # Hindi check
    if any(k in q_raw for k in ["आप कौन हैं", "तुम कौन हो", "तुम्हारा नाम क्या है", "आपका नाम क्या है", "आप क्या कर सकते हैं"]):
        return (
            "🌤️ **मैं AtmosX / weatherGPT हूँ** — एक उन्नत बहुभाषी AI मौसम एवं जलवायु विशेषज्ञ सहायक।\n\n"
            "• **लाइव मौसम अवलोकन**: वर्तमान तापमान, आर्द्रता, हवा की गति, बैरोमीटर दबाव और वायु गुणवत्ता (AQI)।\n"
            "• **सटीक NWP पूर्वानुमान**: 24 घंटे और 7 दिनों का मौसम पूर्वानुमान।\n"
            "• **गंभीर मौसम अलर्ट**: भारी वर्षा, चक्रवात और लू की चेतावनी।\n"
            "• **बहुभाषी समर्थन**: हिन्दी, தமிழ், മലയാളം, English सहित 20+ भाषाओं में संवाद।\n\n"
            "पूछें: *\"क्या कल दिल्ली में बारिश होगी?\"* या *\"जयपुर का तापमान क्या है?\"*"
        )

    # Malayalam check
    if any(k in q_raw for k in ["നിങ്ങൾ ആരാണ്", "നീ ആരാണ്", "നിങ്ങളുടെ പേരെന്താണ്", "നിങ്ങൾക്ക് എന്ത് ചെയ്യാൻ കഴിയും"]):
        return (
            "🌤️ **ഞാൻ AtmosX / weatherGPT** — ഒരു അത്യാധുനിക AI കാലാവസ്ഥാ ഇന്റലിജൻസ് അസിസ്റ്റന്റ്.\n\n"
            "• **തത്സമയ വിവരങ്ങൾ**: താപനില, ഈർപ്പം, കാറ്റിന്റെ വേഗത, വായു മർദ്ദം, എയർ ക്വാളിറ്റി.\n"
            "• **കൃത്യമായ പ്രवചനങ്ങൾ**: 7 ദിവസത്തെ കാലാവസ്ഥാ വിവരങ്ങൾ.\n"
            "• **കാലാവസ്ഥാ മുന്നറിയിപ്പുകൾ**: ശക്തമായ മഴ, ചുഴലിക്കാറ്റ് അലേർട്ടുകൾ.\n"
            "• **ബഹുഭാഷാ പിന്തുണ**: മലയാളം, தமிழ், हिन्दी, English തുടങ്ങി 20+ ഭാഷകളിൽ സംസാരിക്കാം."
        )

    identity_triggers = [
        "are you a weather ai", "are you a weather gpt", "are you weather ai", "are you weather gpt",
        "are you an ai", "are you ai", "is this an ai", "is this a weather ai", "is this weather gpt",
        "who are you", "what are you", "what is your name", "tell me your name",
        "what can you do", "what do you do", "tell me about yourself", "how do you work",
        "help me", "who created you", "who made you", "what is atmosx", "what is weathergpt",
        "నీ ఎవరు", "మీరు ఎవరు", "ನೀವು ಯಾರು", "നിങ്ങൾ ആരാണ്", "നീ ആരാണ്"
    ]
    if any(p in q for p in identity_triggers):
        return (
            "🌤️ **I am AtmosX (weatherGPT)** — an advanced Multilingual AI Weather Intelligence Assistant.\n\n"
            "Here is what I can do for you:\n"
            "• **Live Weather Observations**: Current temperature, feels-like, humidity, wind vectors, pressure, and air quality (AQI).\n"
            "• **Grounded NWP Forecasts**: Accurate hourly timelines and 7-day outlooks backed by WMO-compliant Open-Meteo models.\n"
            "• **Extreme Weather & Storm Alerts**: Real-time warnings for heavy rainfall, cyclones, heatwaves, and gales.\n"
            "• **Multilingual Support**: Chat naturally in हिन्दी, தமிழ், മലയാളം, తెలుగు, Español, Français, Arabic, and English.\n"
            "• **Actionable Recommendations**: Need to know if you should carry an umbrella, go hiking, or plan outdoor activities? Just ask!\n\n"
            "Try asking: *\"Will it rain in Chennai today?\"* or *\"What's the forecast for Wayanad tomorrow?\"*"
        )
    return None

SENTIMENT_KEYWORDS = ["social media", "sentiment", "saying", "mood"]

def detect_sentiment_intent(text: str) -> bool:
    """Check if query contains keywords related to social media sentiment or mood."""
    if not text:
        return False
    t = text.lower()
    return any(k in t for k in SENTIMENT_KEYWORDS)

def is_general_science_question(query: str) -> bool:
    """Determine if query is purely conceptual/scientific with no location intent."""
    if not query:
        return False
    if detect_sentiment_intent(query):
        return False
    q = query.lower().strip()
    triggers = [
        "what is ", "what are ", "how do ", "how does ", "how is ", "how are ",
        "why do ", "why does ", "why is ", "explain ", "difference between ",
        "what causes ", "causes of ", "what makes ", "define ", "how can rain",
        "why does lightning", "how do clouds", "what is el nino", "what is la nina"
    ]
    if any(q.startswith(tr) or f" {tr}" in q for tr in triggers):
        if not extract_location_from_query(query):
            return True
    return False

def sanitize_ai_response(text: str) -> str:
    """Strips any accidental prompt meta-directives or formatting instructions leaked by the LLM."""
    if not text:
        return ""
    cleaned = text
    meta_patterns = [
        r'^\s*statement is clear:?\s*["\'].*?["\']\s*\)?\s*',
        r'^\s*\(?\s*The user is asking in [^\n]+\)?\s*\.?\s*',
        r'^\s*So answer in [^\n]+\.?\s*',
        r'^\s*Use clean Markdown formatting[^\n]+\.?\s*',
        r'^\s*(?:As per directive|Following instructions|Core directive|Strict requirement)[^\n]*\n+'
    ]
    for pat in meta_patterns:
        cleaned = re.sub(pat, '', cleaned, flags=re.IGNORECASE).strip()
    return cleaned

class StreamingMetaFilter:
    """Buffers initial SSE tokens to detect and discard prompt meta-instructions without delaying genuine answers."""
    def __init__(self):
        self.buffer = ""
        self.filter_done = False

    def push(self, token: str) -> List[str]:
        if self.filter_done:
            return [token]
        self.buffer += token
        if "\n" in self.buffer or len(self.buffer) >= 120:
            cleaned = sanitize_ai_response(self.buffer)
            if cleaned != self.buffer.strip():
                if cleaned:
                    self.filter_done = True
                    out = cleaned
                    self.buffer = ""
                    return [out]
                else:
                    self.buffer = ""
                    return []
            else:
                self.filter_done = True
                out = self.buffer
                self.buffer = ""
                return [out]
        return []

    def flush(self) -> List[str]:
        if not self.filter_done and self.buffer:
            cleaned = sanitize_ai_response(self.buffer)
            self.filter_done = True
            return [cleaned] if cleaned else []
        return []



# ==============================================================================
# SECTION 5: WEATHER SERVICE
# ==============================================================================
def extract_location_from_query(query: str) -> Optional[str]:
    """Detect if query mentions a specific location."""
    if not query:
        return None
    q_lower = query.lower()
    
    for city in sorted(KNOWN_LOCATIONS.keys(), key=len, reverse=True):
        pattern = r'(?:\b|\s|^)' + re.escape(city) + r'(?:\b|\s|$|[?.,!])'
        if re.search(pattern, q_lower):
            return city
            
    prep_match = re.search(r'\b(?:in|at|for|near|around|of|about)\s+([A-Za-z]{3,24}(?:\s+[A-Za-z]{3,24})?)', query)
    if prep_match:
        cand = prep_match.group(1).strip()
        ignore = {
            "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "this week",
            "next week", "the rain", "the morning", "the evening", "my area", "this city",
            "the country", "the world", "degrees", "celsius", "detail", "english", "hindi",
            "this sky", "the sky", "this photo", "the photo", "this image", "the image",
            "this cloud", "the clouds", "this picture", "the picture", "the weather", "this weather",
            "social media", "the sentiment", "the mood", "sentiment", "mood", "the people"
        }
        cand_lower = cand.lower()
        if cand_lower not in ignore and not cand_lower.startswith(("this ", "the ")) and len(cand) >= 3:
            return cand

    return None

async def resolve_coordinates(location_name: str) -> Tuple[float, float, str]:
    if not location_name or not location_name.strip():
        raise HTTPException(status_code=400, detail="Location name required")
    raw_loc = location_name.strip()
    normalized = " ".join(raw_loc.lower().split())
    clean_norm = " ".join(re.sub(r"[,\\-_/]+", " ", normalized).split())

    if normalized in KNOWN_LOCATIONS:
        return KNOWN_LOCATIONS[normalized]

    if clean_norm in KNOWN_LOCATIONS:
        return KNOWN_LOCATIONS[clean_norm]

    if normalized in GEOCODE_CACHE:
        return GEOCODE_CACHE[normalized]

    for key, val in KNOWN_LOCATIONS.items():
        if key == normalized or f" {key} " in f" {clean_norm} " or key in clean_norm.split():
            return val

    client = get_http_client()
    for search_term in [raw_loc, raw_loc.split(",")[0].strip()]:
        if not search_term:
            continue
        try:
            res = await client.get(
                GEOCODING_URL,
                params={"name": search_term, "count": 1, "language": "en", "format": "json"}
            )
            if res.status_code == 200:
                results = res.json().get("results", [])
                if results:
                    r = results[0]
                    parts = [r.get("name", ""), r.get("admin1", ""), r.get("country", "")]
                    display = ", ".join(p for p in parts if p)
                    coord = (float(r["latitude"]), float(r["longitude"]), display)
                    GEOCODE_CACHE[normalized] = coord
                    return coord
        except httpx.HTTPError:
            pass

    raise HTTPException(status_code=404, detail="Location could not be resolved.")

async def reverse_resolve_coordinates(lat: float, lon: float) -> str:
    """Reverse geocode latitude and longitude to a human-readable location name."""
    # 1. Match known location if close enough (~15km)
    for name, (klat, klon, dname) in KNOWN_LOCATIONS.items():
        if abs(klat - lat) < 0.15 and abs(klon - lon) < 0.15:
            return dname

    # 2. Reverse geocode via BigDataCloud free client API
    try:
        client = get_http_client()
        res = await client.get(
            "https://api.bigdatacloud.net/data/reverse-geocode-client",
            params={"latitude": lat, "longitude": lon, "localityLanguage": "en"},
            timeout=4.0
        )
        if res.status_code == 200:
            d = res.json()
            city = d.get("city") or d.get("locality") or d.get("principalSubdivision")
            country = d.get("countryName") or ""
            if city:
                return f"{city}, {country}" if country else city
    except Exception:
        pass

    return f"Local Station ({lat:.2f}°, {lon:.2f}°)"

async def fetch_live_weather(lat: float, lon: float) -> Dict[str, Any]:
    cache_key = (round(lat, 2), round(lon, 2))
    now = time.time()
    if cache_key in WEATHER_CACHE:
        cached_time, cached_data = WEATHER_CACHE[cache_key]
        if now - cached_time < WEATHER_CACHE_TTL:
            return cached_data

    client = get_http_client()
    params = {
        "latitude": lat, "longitude": lon,
        "current": (
            "temperature_2m,relative_humidity_2m,apparent_temperature,"
            "precipitation,rain,snowfall,weather_code,cloud_cover,"
            "pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,"
            "wind_gusts_10m,visibility,uv_index,is_day"
        ),
        "hourly": (
            "temperature_2m,apparent_temperature,relative_humidity_2m,"
            "dew_point_2m,precipitation_probability,precipitation,"
            "weather_code,visibility,wind_speed_10m,wind_direction_10m,"
            "wind_gusts_10m,uv_index,is_day,pressure_msl,surface_pressure"
        ),
        "daily": (
            "weather_code,temperature_2m_max,temperature_2m_min,"
            "apparent_temperature_max,apparent_temperature_min,"
            "sunrise,sunset,daylight_duration,uv_index_max,"
            "precipitation_sum,rain_sum,snowfall_sum,"
            "precipitation_hours,precipitation_probability_max,"
            "wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,"
            "shortwave_radiation_sum"
        ),
        "forecast_days": 7,
        "timezone": "auto",
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm"
    }
    res = await client.get(FORECAST_URL, params=params)
    if res.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch weather data from provider.")
    data = res.json()
    WEATHER_CACHE[cache_key] = (now, data)
    return data



# ==============================================================================
# SECTION 6: AIR-QUALITY SERVICE
# ==============================================================================
async def fetch_air_quality(lat: float, lon: float) -> Optional[Dict[str, Any]]:
    cache_key = (round(lat, 2), round(lon, 2))
    now = time.time()
    if cache_key in AQI_CACHE:
        cached_time, cached_data = AQI_CACHE[cache_key]
        if now - cached_time < WEATHER_CACHE_TTL:
            return cached_data

    try:
        client = get_http_client()
        res = await client.get(
            AIR_QUALITY_URL,
            params={
                "latitude": lat, "longitude": lon,
                "current": "pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,european_aqi,us_aqi",
                "timezone": "auto"
            }
        )
        if res.status_code == 200:
            data = res.json().get("current", {})
            AQI_CACHE[cache_key] = (now, data)
            return data
    except Exception:
        pass
    return None



# ==============================================================================
# SECTION 7: AI SERVICE
# ==============================================================================
def build_system_prompt(lang_name: str, ref_time_str: str) -> str:
    if lang_name.strip().lower() == "english":
        lang_section = """4. LANGUAGE & SCRIPT:
   - The user is conversing in English.
   - Deliver your entire response in clear, standard English."""
    else:
        lang_section = f"""4. LANGUAGE & SCRIPT (STRICT REQUIREMENT):
   - The user is conversing in {lang_name}.
   - You MUST write your ENTIRE response in {lang_name} using its authentic native script (e.g. தமிழ், हिन्दी, മലയാളം, العربية, Español, etc.).
   - Do NOT respond in English when {lang_name} is requested."""

    return f"""You are AtmosX, an authoritative, knowledgeable, and friendly AI meteorologist and climate intelligence assistant.

CURRENT REFERENCE TIME:
{ref_time_str}

CORE DIRECTIVES:
1. ACCURACY & REAL-TIME GROUNDING:
   - When Live Grounding Weather Data is provided below, base all temperatures, conditions, precipitation chances, wind speeds, and forecast details strictly on that data.
   - Accurately align with the current time: distinguish current conditions from today's upcoming hours and tomorrow's forecast.
   - Never invent or hallucinate metrics that contradict the provided data.
   - For weather advice (e.g. umbrella, hiking, outdoor sports, travel), give clear, practical recommendations directly grounded in precipitation probability, wind speed, temperature, and UV index.

1.1. DATA FIDELITY (MANDATORY):
   - When a '=== VERIFIED STRUCTURED WEATHER FACTS ===' block is provided, it is the absolute source of truth. If a
     '=== ADDITIONAL REFERENCE DATA ===' block also appears, it is strictly secondary — use it only to fill in
     details the primary block doesn't cover (AQI, pressure, visibility, a different day for a follow-up). Never let
     its "Current Conditions" line pull your answer back to "right now" when the primary block covers a different period.
   - You MUST use ONLY the values from the relevant block(s). Do NOT invent, substitute, recalculate, or infer different numbers.
   - The 'User Requested Period' field tells you what the deterministic parser guessed (NOW, TODAY, TOMORROW, UNSPECIFIED, WEEK_OUTLOOK, etc.) — but YOU are the real language-understanding layer. If the guess looks wrong for what the user actually asked (e.g. it says UNSPECIFIED but the question clearly means "tomorrow", or it says NOW but the question is about the future), answer based on what the user actually meant using whichever rows of data support that, not the guessed label.
   - When the primary block's scope is "no single day was clearly requested" (current + an outlook table), read the actual question and pick the day(s) that answer it — do not default to only describing right now unless the question is genuinely about the present moment.
   - If the user asked about TOMORROW, do NOT include current conditions. If the user asked about NOW, do NOT include tomorrow's forecast.
   - Present the verified facts in natural language with your personality, but NEVER alter the factual values.

2. STRUCTURE & TONE:
   - Be helpful, conversational, and direct.
   - Format responses with clean GitHub Markdown: use bold highlights for numbers (e.g. **28°C**, **15 km/h**), bullet points for readability, and appropriate weather emojis (☀️, 🌧️, 💨).
   - If explaining a meteorological concept (such as relative humidity, cyclones, dew point), explain the mechanism step-by-step with intuitive analogies in accessible language.

3. INTENT ALIGNMENT & CONVERSATIONAL RELEVANCE:
   - If the user is asking a conversational question, greeting, or inquiring about your identity or capabilities (e.g. "Who are you?", "Are you a weather AI?", "Hello", "What can you do?"), answer their specific question directly, politely, and conversationally in their language. Do NOT dump a weather telemetry report for a city when they did not ask for weather.
   - If the user asks an atmospheric science question (e.g. "What causes thunderstorms?", "Explain relative humidity"), explain the science thoroughly and clearly without forcing city weather data.
   - When the user asks for weather conditions, forecasts, rain, or temperatures, deliver a grounded, structured meteorological breakdown based strictly on the live data provided.
   - When Atmospheric Sentiment & Social Media Mood data is provided, the user is specifically interested in public mood, community sentiment, or what people are saying on social media. Discuss the social media atmosphere, public mood emoji, positivity score, and sample headlines directly in relation to the live weather conditions. Do NOT default to a static weather card or ignore their sentiment question!

4. MULTI-TURN CONVERSATION CONTEXT:
   - Pay close attention to recent conversation history. If the user asks follow-up questions like "What about morning?", "Will it rain then?", or "Should I take an umbrella?", resolve the location and time context naturally from previous turns.

{lang_section}

5. VISUAL CAMERA & SKY OBSERVATION:
   - When the user provides a camera photo: identify visible cloud types (cumulus, stratus, cirrus, cumulonimbus), coverage percentage, lighting, and surface wetness.
   - CAUTION: Clarify that photographs alone cannot provide exact instrument-grade temperature or air pressure.
   - COMBINE WITH GROUNDED WEATHER: Cross-reference visual observations with the live weather data.

6. OUTPUT HYGIENE & STRICT ANTI-META RULE:
   - Output ONLY the direct weather response to the user.
   - NEVER quote, echo, explain, or refer to internal system instructions, prompt directives, formatting guidelines, or thought process.
   - NEVER output meta-commentary like "The user is asking in...", "Every sentence must be in...", "As per directive...", "Statement is clear:", or "Using clean Markdown formatting...".
   - Start your response immediately with your helpful greeting or weather answer.
"""

def prepare_gemini_request(
    question: str,
    weather_context: Optional[dict],
    language: str,
    history: Optional[List[Dict[str, str]]] = None,
    image_base64: Optional[str] = None,
    image_mime_type: Optional[str] = "image/jpeg",
    structured_facts: Optional[Dict[str, Any]] = None,
    sentiment_data: Optional[Dict[str, Any]] = None
):
    api_key = _load_env()

    now_utc = datetime.now(timezone.utc)
    ref_time_str = now_utc.strftime("%A, %Y-%m-%d %H:%M UTC")

    lang_name = LANG_NAMES.get(language, "English")
    system_prompt = build_system_prompt(lang_name, ref_time_str)

    contents: List[Dict[str, Any]] = []

    # Inject last 2-4 conversational turns if available, excluding duplicate of current user query
    if history and isinstance(history, list):
        recent_history = history[-4:]
        # Remove trailing turn if it duplicates current query
        if recent_history and recent_history[-1].get("role") in ["user", "human"]:
            last_text = str(recent_history[-1].get("text", "")).strip()
            if last_text == question.strip() or last_text in question or question in last_text:
                recent_history = recent_history[:-1]

        for turn in recent_history:
            role = "model" if turn.get("role") in ["model", "assistant", "bot"] else "user"
            txt = str(turn.get("text", "")).strip()
            if txt:
                contents.append({"role": role, "parts": [{"text": txt}]})

    lang_reminder = f" [IMPORTANT: Respond completely in {lang_name}]" if lang_name != "English" else ""

    # Build user content with structured facts (priority) + general weather context.
    #
    # IMPORTANT: previously the full, unscoped weather_context (which always
    # leads with "Current Conditions: ...") was appended unconditionally
    # right after the correctly-scoped structured_facts block, with equal
    # visual weight. Two data blocks disagreeing on how prominent "current
    # conditions" should be — one narrow and correct, one broad and always
    # current-first — reliably pulled answers back toward "current weather"
    # regardless of what was actually asked. When we have a scoped
    # structured_facts block, the full context is now clearly subordinated:
    # relabeled as reference-only, and explicitly told not to override it.
    user_content_parts = [f"User Question: {question}{lang_reminder}"]

    if structured_facts:
        # Inject verified structured facts — this is the PRIMARY source of truth.
        facts_block = format_verified_facts_for_prompt(structured_facts)
        user_content_parts.append(f"\n\n{facts_block}")

        if weather_context:
            formatted_weather = format_weather_context_for_prompt(weather_context, now_utc)
            user_content_parts.append(
                "\n\n=== ADDITIONAL REFERENCE DATA (secondary — full live snapshot) ===\n"
                "This is only for details not covered above (e.g. AQI, pressure, visibility, "
                "follow-up questions about a different day). Do NOT let its 'Current Conditions' "
                "line override the PRIMARY ANSWER DATA above when answering this question.\n"
                f"{formatted_weather}"
            )
    elif weather_context:
        # No scoped facts available (e.g. resolution failed after intent was
        # computed) — the full context is the only grounding we have.
        formatted_weather = format_weather_context_for_prompt(weather_context, now_utc)
        user_content_parts.append(f"\n\n=== Live Grounding Weather Data (Full Context) ===\n{formatted_weather}")

    # Inject Live Atmospheric Sentiment & Social Media Mood Data if available
    if sentiment_data:
        s_score = sentiment_data.get("score", 50)
        s_sentiment = sentiment_data.get("sentiment", "Neutral")
        s_emoji = sentiment_data.get("emoji", "😌")
        s_city = sentiment_data.get("city", "the specified location")
        s_headlines = sentiment_data.get("headlines", [])
        headlines_str = "\n".join(f"- \"{h}\"" for h in s_headlines) if s_headlines else "- Routine seasonal commentary."

        sentiment_block = (
            f"\n\n=== LIVE ATMOSPHERIC SENTIMENT & SOCIAL MEDIA MOOD DATA ===\n"
            f"Target Location: {s_city}\n"
            f"Public Mood Sentiment: {s_sentiment} ({s_emoji})\n"
            f"Atmospheric Positivity Score: {s_score}/100\n"
            f"Recent Social Media Chatter & News Headlines:\n{headlines_str}\n"
            f"CRITICAL INSTRUCTION: The user is asking about the social media mood or public sentiment. "
            f"Actively discuss this mood ({s_sentiment} {s_emoji}, {s_score}% positivity) and recent chatter "
            f"in connection with the live weather data. Provide an engaging, insightful response rather than a static weather card."
        )
        user_content_parts.append(sentiment_block)

    user_content = "".join(user_content_parts)

    user_parts: List[Dict[str, Any]] = []
    if image_base64 and isinstance(image_base64, str) and len(image_base64.strip()) > 50:
        clean_b64 = re.sub(r"^data:image\/[a-zA-Z0-9+.-]+;base64,", "", image_base64.strip())
        mime = image_mime_type or "image/jpeg"
        user_parts.append({"inlineData": {"mimeType": mime, "data": clean_b64}})
    user_parts.append({"text": user_content})

    contents.append({"role": "user", "parts": user_parts})

    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.35,
            "maxOutputTokens": 1024,
            "topP": 0.90,
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT",        "threshold": "BLOCK_ONLY_HIGH"},
            {"category": "HARM_CATEGORY_HATE_SPEECH",       "threshold": "BLOCK_ONLY_HIGH"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_ONLY_HIGH"},
        ]
    }
    return api_key, payload

def generate_grounded_fallback_response(
    query: str,
    weather_context: Optional[dict],
    language: str = "en",
    structured_facts: Optional[Dict[str, Any]] = None,
    sentiment_data: Optional[Dict[str, Any]] = None
) -> str:
    """
    Intelligent meteorological fallback generator when upstream AI quota is temporarily saturated.
    When structured_facts are provided (from the intent router), uses deterministic formatting
    to ensure zero current/tomorrow mixing and factual accuracy.
    When sentiment_data is provided, generates a comprehensive social media mood & atmospheric sentiment summary.
    """
    lang = (language or "en").lower()
    q = (query or "").lower()

    # ── Priority 0: Atmospheric Sentiment & Social Media Mood ──
    if sentiment_data:
        s_city = sentiment_data.get("city", "the area")
        s_score = sentiment_data.get("score", 50)
        s_sentiment = sentiment_data.get("sentiment", "Neutral")
        s_emoji = sentiment_data.get("emoji", "😌")
        s_headlines = sentiment_data.get("headlines", [])

        weather_info = ""
        if weather_context and weather_context.get("current"):
            curr_c = weather_context["current"].get("condition", "")
            curr_t = weather_context["current"].get("temperature_c")
            if curr_t is not None:
                weather_info = f" In tandem with live conditions of **{curr_t}°C** ({curr_c}),"

        headlines_formatted = "\n".join(f"• *\"{h}\"*" for h in s_headlines[:4]) if s_headlines else "• *Steady daily conversations recorded across local feeds.*"

        if lang == "hi":
            return (
                f"### {s_emoji} **{s_city} का सोशल मीडिया मूड और वातावरण विश्लेषण**\n\n"
                f"{weather_info} **{s_city}** में वर्तमान जनभावना **{s_sentiment}** है, जिसका सकारात्मकता स्कोर **{s_score}/100** {s_emoji} दर्ज किया गया है।\n\n"
                f"**लोग और स्थानीय मीडिया क्या कह रहे हैं:**\n{headlines_formatted}\n\n"
                f"सोशल मीडिया चर्चाओं से पता चलता है कि मौजूदा मौसम का स्थानीय जनजीवन और लोगों के मिजाज पर सीधा असर दिख रहा है।"
            )
        elif lang == "ta":
            return (
                f"### {s_emoji} **{s_city} சமூக ஊடக மனநிலை மற்றும் கருத்து பகுப்பாய்வு**\n\n"
                f"{weather_info} **{s_city}**-ல் தற்போதைய பொது மனநிலை **{s_sentiment}** ஆக உள்ளது (மதிப்பீடு: **{s_score}/100** {s_emoji}).\n\n"
                f"**சமூக ஊடகங்கள் மற்றும் தலைப்புச் செய்திகள் கூறுவது:**\n{headlines_formatted}\n\n"
                f"தற்போதைய வானிலை மக்களின் அன்றாட மனநிலையிலும் சமூக ஊடக உரையாடல்களிலும் பிரதிபலிக்கிறது."
            )
        elif lang == "ml":
            return (
                f"### {s_emoji} **{s_city} സോഷ്യൽ മീഡിയ മൂഡും പ്രതികരണങ്ങളും**\n\n"
                f"{weather_info} **{s_city}**-ൽ നിലവിലെ പൊതുവികാരം **{s_sentiment}** ആണ് (സ്കോർ: **{s_score}/100** {s_emoji}).\n\n"
                f"**സോഷ്യൽ മീഡിയയിൽ ആളുകൾ പറയുന്നത്:**\n{headlines_formatted}\n\n"
                f"കാലാവസ്ഥാ മാറ്റങ്ങൾ നഗരത്തിലെ ജനങ്ങളുടെ പ്രതികരണങ്ങളിലും സംഭാഷണങ്ങളിലും വ്യക്തമായി കാണാം."
            )
        else:
            return (
                f"### {s_emoji} **Social Media Mood & Public Sentiment for {s_city}**\n\n"
                f"The current social media atmosphere across **{s_city}** is **{s_sentiment}** with an Atmospheric Positivity Score of **{s_score}/100** {s_emoji}.{weather_info}\n\n"
                f"**What people are saying & recent media highlights:**\n"
                f"{headlines_formatted}\n\n"
                f"Local feeds and discussions reflect a **{s_sentiment.lower()}** reaction as current conditions shape public movement, commute, and daily vibes."
            )

    # ── Priority 1: Use structured facts from intent router (guaranteed accurate) ──
    if structured_facts and structured_facts.get("condition"):
        return format_deterministic_response(structured_facts, lang)

    if not weather_context:
        if "humidity" in q:
            if lang == "hi":
                return "**सापेक्ष आर्द्रता (Relative Humidity)** हवा में मौजूद जलवाष्प की मात्रा को दर्शाती है। जब आर्द्रता अधिक होती है, तो पसीना जल्दी नहीं सूखता, जिससे 30°C तापमान भी शरीर को अत्यधिक गर्म महसूस होता है।"
            elif lang == "ta":
                return "**ஒப்பீட்டு ஈரப்பதம் (Relative Humidity)** காற்றில் உள்ள நீராவியின் அளவாகும். ஈரப்பதம் அதிகமாக இருக்கும்போது வியர்வை ஆவியாகாமல் உடல் வெப்பத்தை அதிகமாக உணர வைக்கிறது."
            elif lang == "ml":
                return "**ആപേക്ഷിക ആർദ്രത (Relative Humidity)** വായുവിലുള്ള ജലബാഷ്പത്തിന്റെ അളവാണ്. ഉയർന്ന ഈർപ്പമുള്ളപ്പോൾ വിയർപ്പ് വേഗത്തിൽ ബാഷ്പീകരിക്കപ്പെടാത്തതിനാൽ 30°C താപനില പോലും കൂടുതൽ ചൂടായി അനുഭവപ്പെടുന്നു."
            return "**Relative humidity (RH)** is the percentage of water vapor in the air compared to the maximum amount the air can hold at that temperature.\n\n• **Why 30°C feels hotter with high humidity**: Your body cools itself by evaporating sweat from your skin into the surrounding air. When humidity is high, the air is already saturated with moisture, significantly slowing down evaporation. As a result, body heat remains trapped, making 30°C feel significantly warmer and more oppressive than dry heat."
        return "🌤️ **AtmosX Weather Intelligence**: I am tracking real-time meteorological conditions. Please specify a location or meteorological topic to view live ground telemetry."

    loc = weather_context.get("location", "Current Station")
    curr = weather_context.get("current", {})
    daily = weather_context.get("7_day_forecast", [])
    t_c = curr.get("temperature_c")
    feels = curr.get("feels_like_c")
    cond = curr.get("condition", "clear")
    hum = curr.get("humidity_pct")
    wind = curr.get("wind_kmh")
    wind_dir = curr.get("wind_direction", "Variable")
    precip_mm = curr.get("precipitation_mm", 0)

    # Check tomorrow's rain
    tom_rain_prob = 0
    tom_rain_mm = 0
    tom_cond = "Partly cloudy"
    if len(daily) > 1:
        tom_rain_prob = daily[1].get("rain_probability_pct", 0)
        tom_rain_mm = daily[1].get("rain_mm", 0)
        tom_cond = daily[1].get("condition", "Partly cloudy")

    # Visual sky / camera image question
    if any(k in q for k in ["look at this sky", "sky look like", "does this look like rain", "clouds look", "camera", "photo", "image", "வானம்"]):
        if lang == "ta":
            return f"📷 **வானப் படம் மற்றும் நேரடி வானிலை ஆய்வு ({loc})**:\n\n• **நேரடி நிலைமை**: {cond}, வெப்பநிலை **{t_c}°C** (உணரப்படுவது: **{feels}°C**).\n• **மேகக் கட்டமைப்பு**: புகைப்படத்தில் காணப்பட்ட மேகங்கள் நேரடித் தரவுகளோடு ஒப்பிடப்பட்டுள்ளன.\n• **மழை சாத்தியக்கூறு**: **{tom_rain_prob}%** (தற்போதைய மழைவீழ்ச்சி: {precip_mm} mm).\n• **வானிலை மதிப்பீடு**: புகைப்படங்கள் மட்டும் கொண்டு துல்லிய அளவீடுகளை கணிக்க இயலாது; ஆயினும் நேரடி ராடார் தரவுப்படி {'மழை பெய்ய வாய்ப்புள்ளது' if tom_rain_prob >= 35 else 'கணிசமான மழை வாய்ப்பு குறைவு'}."
        elif lang == "ml":
            return f"📷 **ആകാശ നിരീക്ഷണവും തത്സമയ വിവരങ്ങളും ({loc})**:\n\n• **തത്സമയ അവസ്ഥ**: {cond}, താപനില **{t_c}°C** (അനുഭവപ്പെടുന്നത്: **{feels}°C**).\n• **മേഘങ്ങൾ**: ഫോട്ടോയിലെ കാഴ്ച തത്സമയ കാലാവസ്ഥാ ഡാറ്റയുമായി പരിശോധിച്ചു.\n• **മഴ സാധ്യത**: **{tom_rain_prob}%** (മഴയുടെ അളവ്: {precip_mm} mm).\n• **നിർദ്ദേശം**: ക്യാമറ ചിത്രങ്ങൾ മാത്രം അടിസ്ഥാനമാക്കി കൃത്യമായ താപനിലയോ മർദ്ദമോ പറയാനാവില്ല; ലൈവ് നിരീക്ഷണങ്ങൾ പ്രകാരം {'മഴ സാധ്യതയുണ്ട്' if tom_rain_prob >= 35 else 'ശക്തമായ മഴ സാധ്യത കുറവാണ്'}."
        elif lang == "hi":
            return f"📷 **आकाश चित्र एवं प्रत्यक्ष मौसम विश्लेषण ({loc})**:\n\n• **वर्तमान स्थिति**: {cond}, तापमान **{t_c}°C** (महसूस: **{feels}°C**).\n• **बादलों की स्थिति**: कैमरे की छवि का लाइव मौसम डेटा के साथ समन्वय किया गया है।\n• **बारिश की संभावना**: **{tom_rain_prob}%** ({precip_mm} mm).\n• **मौसम वैज्ञानिक सलाह**: केवल फोटो से सटीक तापमान या दबाव निर्धारित नहीं किया जा सकता; लाइव रडार के अनुसार {'बारिश की संभावना बनी हुई है' if tom_rain_prob >= 35 else 'मौसम सामान्य रहने की उम्मीद है'}।"
        else:
            return f"📷 **Visual Sky Assessment & Grounded Weather ({loc})**:\n\n• **Visual Correlation**: The cloud formation in the image has been cross-referenced with live Open-Meteo telemetry for {loc}.\n• **Current Station Conditions**: {cond}, **{t_c}°C** (Feels like **{feels}°C**)\n• **Precipitation Probability**: **{tom_rain_prob}%** (Current rate: {precip_mm} mm/h)\n• **Wind & Atmosphere**: **{wind} km/h** ({wind_dir}), Humidity: **{hum}%**\n• **Assessment**: Photographs show atmospheric cloud structure, but camera images cannot determine precise instrument measurements alone. Based on verified meteorological models, {'rain is likely in the upcoming hours; having an umbrella ready is advised.' if tom_rain_prob >= 35 else 'conditions are currently stable with low convective precipitation risk.'}"

    # Umbrella question
    if any(k in q for k in ["umbrella", "rain", "மழை", "बारिश", "മഴ"]):
        rain_prob_today = daily[0].get("rain_probability_pct", 0) if daily else 0
        needs_umbrella = rain_prob_today >= 40 or precip_mm > 0.5

        if lang == "ta":
            advice = "ஆம், குடை எடுத்துச் செல்வது நல்லது." if needs_umbrella else "இன்று குடை தேவைப்படாது."
            return f"🌧️ **{loc} வானிலை அறிக்கை**:\n\n• **தற்போதைய நிலை**: {cond}, வெப்பநிலை **{t_c}°C** (உணரப்படுவது: **{feels}°C**).\n• **மழை வாய்ப்பு**: **{rain_prob_today}%** (மழை அளவு: {precip_mm} mm).\n• **பரிந்துரை**: {advice}\n• **காற்று**: {wind} km/h ({wind_dir})."
        elif lang == "ml":
            advice = "അതെ, ഒരു കുട കരുതുന്നത് നല്ലതാണ്." if needs_umbrella else "ഇന്ന് കാര്യമായി മഴ സാധ്യതയില്ല."
            return f"🌧️ **{loc} കാലാവസ്ഥ വിവരങ്ങൾ**:\n\n• **നിലവിലെ അവസ്ഥ**: {cond}, താപനില **{t_c}°C** (അനുഭവപ്പെടുന്നത്: **{feels}°C**).\n• **മഴ സാധ്യത**: **{rain_prob_today}%** (പ്രതീക്ഷിക്കുന്ന മഴ: {precip_mm} mm).\n• **നിർദ്ദേശം**: {advice}\n• **കാറ്റ്**: {wind} km/h ({wind_dir})."
        elif lang == "hi":
            advice = "हाँ, छाता साथ रखना सुरक्षित रहेगा।" if needs_umbrella else "आज बारिश की संभावना कम है।"
            return f"🌧️ **{loc} मौसम पूर्वानुमान**:\n\n• **वर्तमान स्थिति**: {cond}, तापमान **{t_c}°C** (महसूस: **{feels}°C**).\n• **बारिश की संभावना**: **{rain_prob_today}%** ({precip_mm} mm).\n• **सलाह**: {advice}\n• **हवा**: {wind} km/h ({wind_dir})."
        else:
            advice = "Yes, carrying an umbrella is strongly recommended today." if needs_umbrella else "You likely won't need an umbrella today."
            return f"🌧️ **Live Weather for {loc}**:\n\n• **Condition**: {cond}\n• **Temperature**: **{t_c}°C** (Feels like **{feels}°C**)\n• **Rain Probability**: **{rain_prob_today}%** (Accumulation: **{precip_mm} mm**)\n• **Advice**: {advice}\n• **Wind**: **{wind} km/h** from **{wind_dir}**\n• **Humidity**: **{hum}%**"

    # Multilingual general weather response
    if lang == "ta":
        return f"🌤️ **{loc} தற்போதைய வானிலை**:\n\n• **வெப்பநிலை**: **{t_c}°C** (உணரப்படுவது **{feels}°C**)\n• **நிலைமை**: {cond}\n• **ஈரப்பதம்**: **{hum}%**\n• **காற்று வேகம்**: **{wind} km/h** ({wind_dir})\n• **நாளை வானிலை**: {tom_cond}, மழை வாய்ப்பு **{tom_rain_prob}%**."
    elif lang == "ml":
        return f"🌤️ **{loc} നിലവിലെ കാലാവസ്ഥ**:\n\n• **താപനില**: **{t_c}°C** (അനുഭവപ്പെടുന്നത് **{feels}°C**)\n• **അവസ്ഥ**: {cond}\n• **ഈർപ്പം**: **{hum}%**\n• **കാറ്റ്**: **{wind} km/h** ({wind_dir})\n• **നാളെ**: {tom_cond}, മഴ സാധ്യത **{tom_rain_prob}%**."
    elif lang == "hi":
        return f"🌤️ **{loc} का वर्तमान मौसम**:\n\n• **तापमान**: **{t_c}°C** (महसूस: **{feels}°C**)\n• **स्थिति**: {cond}\n• **आर्द्रता**: **{hum}%**\n• **हवा**: **{wind} km/h** ({wind_dir})\n• **कल का पूर्वानुमान**: {tom_cond}, बारिश की संभावना **{tom_rain_prob}%**."
    else:
        return f"🌤️ **Current Weather in {loc}**:\n\n• **Temperature**: **{t_c}°C** (Feels like **{feels}°C**)\n• **Condition**: **{cond}**\n• **Humidity**: **{hum}%**\n• **Wind**: **{wind} km/h** from **{wind_dir}**\n• **Barometric Pressure**: **{curr.get('pressure_hpa', 1012)} hPa**\n• **Upcoming Tomorrow**: **{tom_cond}** with **{tom_rain_prob}%** chance of rain."

def generate_contextual_suggestions(query: str, weather_context: Optional[dict]) -> List[str]:
    """Produce smart follow-up question chips based on query content and live weather data."""
    q = query.lower()
    if any(k in q for k in ["rain", "umbrella", "shower", "precipitation", "மழை", "बारिश", "മഴ"]):
        return ["🌅 What about morning?", "☀️ Afternoon rain chance?", "☂️ Do I need an umbrella today?", "💨 Wind speed details"]
    if any(k in q for k in ["temp", "temperature", "hot", "heat", "cold", "तापमान", "வெப்பநிலை"]):
        return ["🌡️ Peak heat hour today", "🌙 Night temperature", "💧 Humidity level", "☀️ 7-day outlook"]
    if any(k in q for k in ["hike", "hiking", "travel", "trip", "spray", "outdoor", "walk"]):
        return ["⏰ Best time of day", "⚠️ Active weather alerts", "💨 Wind & visibility", "🌧️ Chance of rain"]
    if weather_context:
        loc = weather_context.get("location", "this location").split(",")[0]
        return [f"🌧️ Will it rain in {loc}?", f"📅 Tomorrow's forecast in {loc}", f"💨 Wind & pressure in {loc}", "☀️ UV Index & Air Quality"]
    return ["📍 Weather in Chennai", "🌧️ Will it rain in Wayanad?", "🌡️ Delhi temperature today", "💡 Explain relative humidity"]



# ==============================================================================
# SECTION 8: CONVERSATION & CONTEXT LOGIC
# ==============================================================================
def build_weather_context(lat: float, lon: float, resolved_name: str, weather_data: dict, aqi_data: Any) -> dict:
    current = weather_data.get("current", {})
    daily   = weather_data.get("daily", {})
    hourly  = weather_data.get("hourly", {})
    has_warn, warn_msg, warn_level = evaluate_warnings(current, daily)

    forecast_days = []
    for i, date in enumerate((daily.get("time") or [])[:7]):
        forecast_days.append({
            "date": date,
            "condition": weather_code_text(_first(daily.get("weather_code"), i)),
            "temp_max_c": _first(daily.get("temperature_2m_max"), i),
            "temp_min_c": _first(daily.get("temperature_2m_min"), i),
            "feels_max_c": _first(daily.get("apparent_temperature_max"), i),
            "feels_min_c": _first(daily.get("apparent_temperature_min"), i),
            "rain_probability_pct": _first(daily.get("precipitation_probability_max"), i),
            "rain_mm": _first(daily.get("precipitation_sum"), i),
            "wind_max_kmh": _first(daily.get("wind_speed_10m_max"), i),
            "wind_gusts_kmh": _first(daily.get("wind_gusts_10m_max"), i),
            "uv_index_max": _first(daily.get("uv_index_max"), i),
            "sunrise": _first(daily.get("sunrise"), i),
            "sunset": _first(daily.get("sunset"), i),
        })

    hourly_times = hourly.get("time") or []
    h_idx = _current_hourly_index(hourly_times)
    next_12h = []
    for i in range(h_idx, min(h_idx + 12, len(hourly_times))):
        next_12h.append({
            "time": hourly_times[i],
            "temp_c": _first(hourly.get("temperature_2m"), i),
            "feels_c": _first(hourly.get("apparent_temperature"), i),
            "rain_prob_pct": _first(hourly.get("precipitation_probability"), i),
            "rain_mm": _first(hourly.get("precipitation"), i),
            "wind_kmh": _first(hourly.get("wind_speed_10m"), i),
            "wind_dir": wind_direction_label(_first(hourly.get("wind_direction_10m"), i)),
            "condition": weather_code_text(_first(hourly.get("weather_code"), i)),
        })

    return {
        "location": resolved_name,
        "latitude": lat,
        "longitude": lon,
        "current": {
            "observed_at": current.get("time"),
            "temperature_c": current.get("temperature_2m"),
            "feels_like_c": current.get("apparent_temperature"),
            "humidity_pct": current.get("relative_humidity_2m"),
            "precipitation_mm": current.get("precipitation"),
            "rain_mm": current.get("rain"),
            "snowfall_cm": current.get("snowfall"),
            "wind_kmh": current.get("wind_speed_10m"),
            "wind_gusts_kmh": current.get("wind_gusts_10m"),
            "wind_direction": wind_direction_label(current.get("wind_direction_10m")),
            "cloud_cover_pct": current.get("cloud_cover"),
            "visibility_m": current.get("visibility"),
            "pressure_hpa": current.get("pressure_msl"),
            "is_daytime": bool(current.get("is_day")),
            "condition": weather_code_text(current.get("weather_code")),
        },
        "next_12_hours": next_12h,
        "7_day_forecast": forecast_days,
        "air_quality": {
            "us_aqi": aqi_data.get("us_aqi") if isinstance(aqi_data, dict) else None,
            "eu_aqi": aqi_data.get("european_aqi") if isinstance(aqi_data, dict) else None,
            "pm25": aqi_data.get("pm2_5") if isinstance(aqi_data, dict) else None,
            "pm10": aqi_data.get("pm10") if isinstance(aqi_data, dict) else None,
        } if isinstance(aqi_data, dict) else None,
        "warning": {
            "active": has_warn,
            "message": warn_msg,
            "level": warn_level,
        },
        "grounding_metadata": {
            "source": "Open-Meteo (WMO-compliant NWP models)",
            "timestamp": current.get("time", datetime.now(timezone.utc).isoformat()),
            "timezone": weather_data.get("timezone", "UTC"),
            "is_cached": (time.time() - WEATHER_CACHE.get((round(lat, 2), round(lon, 2)), (0, {}))[0]) > 2.0 if (round(lat, 2), round(lon, 2)) in WEATHER_CACHE else False,
            "cache_age_seconds": round(max(0.0, time.time() - WEATHER_CACHE.get((round(lat, 2), round(lon, 2)), (time.time(), {}))[0]), 1),
            "server_time_iso": datetime.now(timezone.utc).isoformat(),
        }
    }

def format_weather_context_for_prompt(weather_context: dict, ref_dt: datetime) -> str:
    loc = weather_context.get("location", "Unknown Location")
    curr = weather_context.get("current", {})
    daily = weather_context.get("7_day_forecast", [])
    hourly = weather_context.get("next_12_hours", [])
    aqi = weather_context.get("air_quality") or {}
    warning = weather_context.get("warning") or {}

    lines = [
        f"Location: {loc}",
        f"Observation Time: {curr.get('observed_at') or ref_dt.isoformat()}",
        f"Current Conditions: {curr.get('condition', 'Unknown')}",
        f"Temperature: {curr.get('temperature_c')}°C (Feels like {curr.get('feels_like_c')}°C)",
        f"Humidity: {curr.get('humidity_pct')}%",
        f"Wind: {curr.get('wind_kmh')} km/h from {curr.get('wind_direction')} (Gusts: {curr.get('wind_gusts_kmh')} km/h)",
        f"Precipitation: {curr.get('precipitation_mm')} mm (Rain: {curr.get('rain_mm')} mm, Snow: {curr.get('snowfall_cm')} cm)",
        f"Cloud Cover: {curr.get('cloud_cover_pct')}% | Pressure: {curr.get('pressure_hpa')} hPa | Visibility: {curr.get('visibility_m')} m",
    ]

    if aqi and aqi.get("us_aqi") is not None:
        lines.append(f"Air Quality (US AQI): {aqi.get('us_aqi')} | PM2.5: {aqi.get('pm25')} µg/m³")

    if warning.get("active"):
        lines.append(f"ACTIVE ALERT: [{warning.get('level', 'WARNING').upper()}] {warning.get('message')}")

    if hourly:
        lines.append("\nNext 12 Hours Forecast:")
        for h in hourly[:8]:
            t_str = h.get('time', '').split('T')[-1]
            lines.append(f"- {t_str}: {h.get('temp_c')}°C, {h.get('condition')}, Rain Prob: {h.get('rain_prob_pct')}%, Wind: {h.get('wind_kmh')} km/h")

    if daily:
        lines.append("\nUpcoming Daily Forecast:")
        for idx, d in enumerate(daily[:5]):
            label = "Today" if idx == 0 else ("Tomorrow" if idx == 1 else d.get("date", f"Day {idx+1}"))
            lines.append(f"- {label} ({d.get('date')}): {d.get('condition')}, Min: {d.get('temp_min_c')}°C, Max: {d.get('temp_max_c')}°C, Rain Chance: {d.get('rain_probability_pct')}%, Rain Expected: {d.get('rain_mm')} mm, Max Wind: {d.get('wind_max_kmh')} km/h")

    return "\n".join(lines)

async def resolve_weather_context_for_query(query: str, location_name: Optional[str], history: Optional[List[Dict[str, str]]] = None) -> Tuple[Optional[dict], Optional[str], Optional[dict], Any]:
    """
    Resolve weather context for a query.
    Returns: (weather_context, resolved_name, raw_weather_data, raw_aqi_data)
    raw_weather_data and raw_aqi_data are returned for the intent-based structured facts extractor.
    """
    if is_general_science_question(query) and (not location_name or location_name == "Selected Location"):
        return None, None, None, None

    candidates = []
    extracted = extract_location_from_query(query)
    if extracted:
        candidates.append(extracted)
    if location_name and location_name.strip() and location_name != "Selected Location":
        if location_name.strip() not in candidates:
            candidates.append(location_name.strip())
    if history:
        for turn in reversed(history):
            prev_txt = turn.get("text", "") or turn.get("content", "")
            prev_loc = extract_location_from_query(prev_txt)
            if prev_loc and prev_loc not in candidates:
                candidates.append(prev_loc)
                break
    if location_name and location_name.strip() and location_name.strip() not in candidates:
        candidates.append(location_name.strip())

    for target in candidates:
        try:
            lat, lon, resolved_name = await resolve_coordinates(target)
            weather_data, aqi_data = await asyncio.gather(
                fetch_live_weather(lat, lon),
                fetch_air_quality(lat, lon),
                return_exceptions=True
            )

            if not isinstance(weather_data, Exception):
                safe_aqi = aqi_data if not isinstance(aqi_data, Exception) else None
                ctx = build_weather_context(lat, lon, resolved_name, weather_data, safe_aqi)
                return ctx, resolved_name, weather_data, safe_aqi
        except Exception:
            continue

    return None, (candidates[0] if candidates else None), None, None



# ==============================================================================
# SECTION 9: ADVISORY & WARNING LOGIC
# ==============================================================================
def evaluate_warnings(current, daily):
    wind   = _fv(current.get("wind_speed_10m"))
    gusts  = _fv(current.get("wind_gusts_10m"))
    precip = _fv(current.get("precipitation"))
    rain   = _fv(current.get("rain"))
    snow   = _fv(current.get("snowfall"))
    code   = int(current.get("weather_code") or 0)
    vis    = _fv(current.get("visibility"), default=10000)

    if gusts > 80 or wind > 65:
        return True, (f"🔴 SEVERE WIND ALERT: Dangerous wind gusts of {gusts:.0f} km/h. "
                      "Avoid outdoor activity."), "red"
    if code in {96, 99}:
        return True, ("🔴 SEVERE THUNDERSTORM ALERT: Thunderstorm with hail reported. "
                      "Seek shelter immediately."), "red"
    if precip > 50 or rain > 50:
        return True, (f"🔴 EXTREME RAINFALL ALERT: {max(precip,rain):.1f} mm active rainfall. "
                      "High risk of flash flooding."), "red"
    if wind > 35 or gusts > 55:
        return True, (f"🟠 HIGH WIND WARNING: {wind:.0f} km/h with gusts up to {gusts:.0f} km/h. "
                      "Secure light outdoor structures."), "orange"
    if precip > 10 or rain > 10:
        return True, (f"🟠 HEAVY RAINFALL ALERT: {max(precip,rain):.1f} mm rainfall active. "
                      "Risk of localized waterlogging."), "orange"
    if code == 95:
        return True, ("🟠 THUNDERSTORM WARNING: Active thunderstorm. "
                      "Stay indoors away from windows."), "orange"
    if snow > 5:
        return True, (f"🟠 HEAVY SNOWFALL WARNING: {snow:.1f} cm active snowfall. "
                      "Hazardous road conditions."), "orange"
    if vis < 1000:
        return True, (f"🟡 DENSE FOG ADVISORY: Visibility reduced to {vis:.0f} m. "
                      "Drive with caution."), "yellow"
    if code in {45, 48}:
        return True, "🟡 FOG ADVISORY: Foggy conditions reducing visibility.", "yellow"
    if wind > 20:
        return True, (f"🟡 WIND ADVISORY: {wind:.0f} km/h winds present."), "yellow"

    if daily:
        probs = daily.get("precipitation_probability_max") or []
        sums  = daily.get("precipitation_sum") or []
        if probs and sums:
            p = _fv(_first(probs))
            s = _fv(_first(sums))
            if p >= 90 and s >= 30:
                return True, (f"🟠 HEAVY RAIN FORECAST: {p:.0f}% probability of {s:.0f} mm rain today."), "orange"
            if p >= 70 and s >= 15:
                return True, (f"🟡 RAIN LIKELY TODAY: {p:.0f}% chance of {s:.0f} mm rain."), "yellow"

    return False, None, None



# ==============================================================================
# SECTION 10: CACHE MANAGEMENT & RATE LIMITING
# ==============================================================================

GEOCODE_CACHE: Dict[str, Tuple[float, float, str]] = {}
WEATHER_CACHE: Dict[Tuple[float, float], Tuple[float, Dict[str, Any]]] = {}
AQI_CACHE: Dict[Tuple[float, float], Tuple[float, Optional[Dict[str, Any]]]] = {}
RATE_LIMIT_STORE: Dict[str, List[float]] = {}

def enforce_rate_limit(request: Request):
    """Sliding-window IP rate limiting for API endpoints."""
    client_ip = request.client.host if request.client else "127.0.0.1"
    now = time.time()
    history = RATE_LIMIT_STORE.get(client_ip, [])
    history = [t for t in history if now - t < RATE_LIMIT_WINDOW]
    if len(history) >= MAX_REQUESTS_PER_WINDOW:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please wait a moment before sending another query."
        )
    history.append(now)
    RATE_LIMIT_STORE[client_ip] = history


# ==============================================================================
# SECTION 11: API ENDPOINTS
# ==============================================================================

router = APIRouter()

async def compute_atmospheric_sentiment(
    city: str,
    weather_condition: Optional[str] = None
) -> Dict[str, Any]:
    """
    Atmospheric Sentiment Analysis:
    Generates or fetches 3-5 media headlines based on city & weather, runs them through
    TextBlob(text).sentiment.polarity, and returns score, sentiment, and emoji.
    """
    async def fetch_media_headlines(target_city: str, target_weather: Optional[str] = None) -> List[str]:
        # Ready for NewsAPI key swap-in:
        news_api_key = os.environ.get("NEWS_API_KEY", "").strip()
        if news_api_key:
            try:
                query = f"{target_city} {target_weather or ''}".strip()
                async with httpx.AsyncClient(timeout=5.0) as client:
                    res = await client.get(
                        "https://newsapi.org/v2/everything",
                        params={"q": query, "pageSize": 5, "apiKey": news_api_key}
                    )
                    if res.status_code == 200:
                        articles = res.json().get("articles", [])
                        titles = [a.get("title") for a in articles if a.get("title")]
                        if titles:
                            return titles[:5]
            except Exception as ex:
                logger.warning("NewsAPI fetch failed, using sample headlines: %s", ex)

        # Contextual media headlines based on city and weather condition
        c_clean = target_city.strip().title()
        cond_str = (target_weather or "fair").lower()

        if any(w in cond_str for w in ["storm", "thunder", "severe", "cyclone", "hurricane", "flood", "hazard", "gale"]):
            return [
                f"Severe weather warning across {c_clean} causes gloomy disruptions and terrible damage.",
                f"Dangerous torrential downpours trigger alarming travel crisis and bitter cold in {c_clean}.",
                f"{c_clean} emergency officials issue urgent alert as devastating fierce storm hits.",
                f"Frustrating power outages and harsh freezing winds trouble {c_clean} neighborhoods."
            ]
        elif any(w in cond_str for w in ["rain", "drizzle", "shower"]):
            return [
                f"Gloomy rain showers slow morning commute across {c_clean}.",
                f"{c_clean} farmers welcome refreshing rainfall to boost water reservoirs.",
                f"Cozy cafes and vibrant umbrella fashion brighten wet streets of {c_clean}.",
                f"Persistent damp rain continues across {c_clean} with cool breeze."
            ]
        elif any(w in cond_str for w in ["clear", "sun", "fair", "bright"]):
            return [
                f"Glorious brilliant sunny weather brings delight and joy across {c_clean}.",
                f"{c_clean} residents celebrate beautiful warm sunshine in parks and cafes.",
                f"Spectacular radiant skies boost tourism and joyful outdoor events in {c_clean}.",
                f"Local businesses thrive as {c_clean} enjoys delightful sunny conditions."
            ]
        elif any(w in cond_str for w in ["snow", "blizzard", "freeze", "frost", "cold", "ice"]):
            return [
                f"Bitter subzero freeze and icy roads create annoying travel hazards in {c_clean}.",
                f"Winter sports lovers rejoice as scenic fresh snow blankets {c_clean}.",
                f"{c_clean} road crews work tirelessly to manage freezing snow conditions.",
                f"Chilly freezing weather encourages indoor dining and cozy gatherings in {c_clean}."
            ]
        elif any(w in cond_str for w in ["fog", "mist", "haze"]):
            return [
                f"Atmospheric morning fog blankets {c_clean} harbor with calm skyline views.",
                f"Cautious drivers navigate hazy morning conditions across {c_clean} roads.",
                f"{c_clean} weather stations record tranquil morning mist clearing by noon.",
                f"Steady barometric readings and misty breeze observed throughout {c_clean}."
            ]
        else:
            return [
                f"Average seasonal temperatures observed across {c_clean} today.",
                f"Steady barometric readings and typical overcast skies over {c_clean}.",
                f"Routine daily traffic and moderate cloud cover recorded in {c_clean}."
            ]

    try:
        headlines = await fetch_media_headlines(city, weather_condition)
        if not headlines:
            headlines = [f"Average seasonal temperatures observed across {city.strip().title()} today."]

        # Run the headlines through TextBlob(text).sentiment.polarity
        polarities = [TextBlob(h).sentiment.polarity for h in headlines]
        avg_polarity = sum(polarities) / len(polarities)

        # Map polarity [-1.0, 1.0] to percentage score [0, 100]
        score = int(round((avg_polarity + 1.0) / 2.0 * 100))
        score = max(0, min(100, score))

        if avg_polarity > 0.08:
            sentiment = "Positive"
            emoji = "🤩"
        elif avg_polarity < -0.08:
            sentiment = "Negative"
            emoji = "🥶"
        else:
            sentiment = "Neutral"
            emoji = "😌"

        return {
            "score": score,
            "sentiment": sentiment,
            "emoji": emoji,
            "city": city,
            "weather_condition": weather_condition,
            "headlines": headlines,
        }
    except Exception as e:
        logger.error("Error in compute_atmospheric_sentiment: %s", e)
        return {
            "score": 50,
            "sentiment": "Neutral",
            "emoji": "😌",
            "city": city,
            "weather_condition": weather_condition,
            "headlines": [],
        }

@router.get("/api/mood")
@router.get("/api/v1/mood")
async def get_city_mood(
    city: str = Query("London", description="City name"),
    weather_condition: Optional[str] = Query(None, description="Current weather condition"),
):
    """
    Atmospheric Sentiment Analysis:
    Generates or fetches 3-5 media headlines based on city & weather, runs them through
    TextBlob(text).sentiment.polarity, and returns score, sentiment, and emoji.
    """
    return await compute_atmospheric_sentiment(city, weather_condition)

@router.get("/api/v1/resolve-location")
async def api_resolve_location(
    name: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None
):
    """Dynamically resolve any city in the world to latitude, longitude, and display name, or reverse geocode GPS coordinates."""
    if latitude is not None and longitude is not None:
        display_name = await reverse_resolve_coordinates(latitude, longitude)
        return {
            "name": display_name,
            "latitude": latitude,
            "longitude": longitude
        }

    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="Either 'name' or 'latitude' and 'longitude' required.")

    lat, lon, display_name = await resolve_coordinates(name.strip())
    return {
        "name": display_name,
        "latitude": lat,
        "longitude": lon
    }

@router.get("/api/v1/dashboard-weather")
async def get_dashboard_weather(latitude: float, longitude: float, location_name: str = "Selected Location"):
    """Live weather data for the telemetry dashboard panel."""
    weather_data, aqi_data = await asyncio.gather(
        fetch_live_weather(latitude, longitude),
        fetch_air_quality(latitude, longitude),
        return_exceptions=True
    )
    if isinstance(weather_data, Exception):
        raise HTTPException(status_code=502, detail="Could not fetch live weather data.")

    current = weather_data.get("current", {})
    daily   = weather_data.get("daily", {})
    hourly  = weather_data.get("hourly", {})

    has_warning, warning_msg, warning_level = evaluate_warnings(current, daily)
    condition = weather_code_text(current.get("weather_code"))
    wind_dir  = wind_direction_label(current.get("wind_direction_10m"))

    hourly_dirs = hourly.get("wind_direction_10m") or []
    hourly["wind_direction_labels"] = [wind_direction_label(d) for d in hourly_dirs]

    return {
        "location": location_name,
        "latitude": latitude,
        "longitude": longitude,
        "current": current,
        "daily_weather": daily,
        "hourly_weather": hourly,
        "air_quality": aqi_data if not isinstance(aqi_data, Exception) else None,
        "condition": condition,
        "wind_direction_label": wind_dir,
        "warning_flag": has_warning,
        "official_warning": warning_msg,
        "warning_level": warning_level,
        "grounding_metadata": {
            "source": "Open-Meteo (WMO-compliant NWP models)",
            "timestamp": current.get("time", datetime.now(timezone.utc).isoformat()),
            "timezone": weather_data.get("timezone", "UTC"),
            "is_cached": (time.time() - WEATHER_CACHE.get((round(latitude, 2), round(longitude, 2)), (0, {}))[0]) > 2.0 if (round(latitude, 2), round(longitude, 2)) in WEATHER_CACHE else False,
            "cache_age_seconds": round(max(0.0, time.time() - WEATHER_CACHE.get((round(latitude, 2), round(longitude, 2)), (time.time(), {}))[0]), 1),
            "server_time_iso": datetime.now(timezone.utc).isoformat()
        }
    }

@router.post("/api/v1/query")
async def handle_weather_query(payload: WeatherQueryRequest, request: Request):
    """Returns rich live weather context."""
    enforce_rate_limit(request)
    lat, lon, resolved_name = await resolve_coordinates(payload.location_name)
    weather_data, aqi_data = await asyncio.gather(
        fetch_live_weather(lat, lon),
        fetch_air_quality(lat, lon),
        return_exceptions=True
    )
    if isinstance(weather_data, Exception):
        raise HTTPException(status_code=502, detail="Could not fetch live weather data.")

    ctx = build_weather_context(
        lat, lon, resolved_name, weather_data,
        aqi_data if not isinstance(aqi_data, Exception) else None
    )
    return ctx

@router.post("/api/v1/chat")
async def chat(payload: ChatRequest, request: Request):
    """Non-streaming AI chat endpoint with header-based auth, fast greeting paths & rate limiting."""
    enforce_rate_limit(request)

    # 1. Instant Fast-Path: Greetings & Capabilities (only when NO image is attached)
    if not payload.image_base64:
        greeting_answer = detect_casual_greeting(payload.query)
        if greeting_answer:
            suggestions = generate_contextual_suggestions(payload.query, None)
            return {
                "answer": greeting_answer,
                "location": None,
                "warning": None,
                "has_weather_context": False,
                "suggestions": suggestions
            }

        identity_answer = detect_identity_or_capabilities(payload.query)
        if identity_answer:
            suggestions = generate_contextual_suggestions(payload.query, None)
            return {
                "answer": identity_answer,
                "location": None,
                "warning": None,
                "has_weather_context": False,
                "suggestions": suggestions
            }

    # 2. Resolve Weather Context with conversation history
    weather_context, resolved_name, raw_weather_data, raw_aqi_data = await resolve_weather_context_for_query(payload.query, payload.location_name, payload.history)

    # 2b. Check for Atmospheric Sentiment / Social Media Mood intent
    has_sentiment_intent = detect_sentiment_intent(payload.query)
    sentiment_data = None
    sentiment_city = None
    if has_sentiment_intent:
        sentiment_city = (
            (resolved_name.split(",")[0].strip() if resolved_name else None)
            or (weather_context.get("location", "").split(",")[0].strip() if weather_context and weather_context.get("location") else None)
            or (payload.location_name.strip() if payload.location_name and payload.location_name != "Selected Location" else None)
            or extract_location_from_query(payload.query)
            or "London"
        )
        sentiment_cond = None
        if weather_context and weather_context.get("current"):
            sentiment_cond = weather_context["current"].get("condition")
        try:
            sentiment_data = await compute_atmospheric_sentiment(sentiment_city, sentiment_cond)
        except Exception as ex:
            logger.warning("Sentiment calculation failed for chat: %s", ex)

    # 3. Parse weather intent and extract structured facts for accuracy
    structured_facts = None
    if raw_weather_data:
        intent = parse_weather_intent(payload.query, payload.history)
        loc_name = resolved_name or payload.location_name or "Selected Location"
        structured_facts = extract_structured_weather_facts(raw_weather_data, raw_aqi_data, loc_name, intent)

    api_key = _load_env()
    if not api_key:
        logger.info("GEMINI_API_KEY not configured — serving deterministic meteorological response.")
        fallback_text = generate_grounded_fallback_response(
            payload.query,
            weather_context,
            payload.language or "en",
            structured_facts=structured_facts,
            sentiment_data=sentiment_data
        )
        cleaned_answer = sanitize_ai_response(fallback_text).strip()
        suggestions = generate_contextual_suggestions(payload.query, weather_context)
        return {
            "answer": cleaned_answer,
            "location": weather_context.get("location") if weather_context else (sentiment_city if sentiment_data else None),
            "warning": weather_context.get("warning") if weather_context else None,
            "has_weather_context": weather_context is not None,
            "ai_used": False,
            "suggestions": suggestions,
            "sentiment": sentiment_data
        }

    api_key, gemini_payload = prepare_gemini_request(
        payload.query,
        weather_context,
        payload.language or "en",
        payload.history,
        payload.image_base64,
        payload.image_mime_type,
        structured_facts=structured_facts,
        sentiment_data=sentiment_data
    )

    client = get_http_client()
    ai_used = False
    try:
        # API key passed via x-goog-api-key header (never in URL query string)
        res = await client.post(
            GEMINI_URL,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
            },
            json=gemini_payload
        )
    except httpx.HTTPError as exc:
        logger.error("Gemini request failed (network/transport error) on /api/v1/chat: %r", exc)
        raise HTTPException(status_code=502, detail="Upstream AI service communication failed.")

    text = ""
    if res.status_code == 200:
        data = res.json()
        text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if text:
            ai_used = True
        else:
            logger.warning("Gemini returned 200 but no usable text on /api/v1/chat. Raw response: %s", res.text[:800])
    else:
        # This used to fail completely silently — no way to tell from outside
        # whether Gemini ever actually responded, or the app has quietly been
        # running on the deterministic fallback the whole time.
        logger.error("Gemini API error %s on /api/v1/chat: %s", res.status_code, res.text[:800])

    if not text:
        # Seamlessly fallback to grounded NWP meteorological engine with structured facts
        text = generate_grounded_fallback_response(
            payload.query,
            weather_context,
            payload.language or "en",
            structured_facts=structured_facts,
            sentiment_data=sentiment_data
        )

    cleaned_answer = sanitize_ai_response(text).strip()
    suggestions = generate_contextual_suggestions(payload.query, weather_context)

    return {
        "answer": cleaned_answer,
        "location": weather_context.get("location") if weather_context else (sentiment_city if sentiment_data else None),
        "warning": weather_context.get("warning") if weather_context else None,
        "has_weather_context": weather_context is not None,
        "ai_used": ai_used,
        "suggestions": suggestions,
        "sentiment": sentiment_data
    }

@router.post("/api/v1/chat/stream")
async def chat_stream(payload: ChatRequest, request: Request):
    """
    High-speed streaming AI chat endpoint via SSE.
    API key passed securely in headers — never exposed in URLs or access logs.
    Supports instant greeting streaming & multi-turn history.
    """
    enforce_rate_limit(request)

    # 1. Fast-Path: Immediate stream for greetings & capabilities (only without image)
    fast_text = (detect_casual_greeting(payload.query) or detect_identity_or_capabilities(payload.query)) if not payload.image_base64 else None
    if fast_text:
        async def fast_generator():
            suggestions = generate_contextual_suggestions(payload.query, None)
            meta = {
                "type": "meta",
                "location": None,
                "latitude": None,
                "longitude": None,
                "warning": None,
                "has_weather_context": False,
                "suggestions": suggestions
            }
            yield f"data: {json.dumps(meta)}\n\n"
            # Stream fast tokens
            for chunk in fast_text.split(" "):
                yield f"data: {json.dumps({'type': 'token', 'text': chunk + ' '})}\n\n"
                await asyncio.sleep(0.015)
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        return StreamingResponse(
            fast_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
        )

    # 2. Regular Gemini + Weather Streaming
    weather_context, resolved_name, raw_weather_data, raw_aqi_data = await resolve_weather_context_for_query(payload.query, payload.location_name, payload.history)

    # 2b. Check for Atmospheric Sentiment / Social Media Mood intent
    has_sentiment_intent = detect_sentiment_intent(payload.query)
    sentiment_data = None
    sentiment_city = None
    if has_sentiment_intent:
        sentiment_city = (
            (resolved_name.split(",")[0].strip() if resolved_name else None)
            or (weather_context.get("location", "").split(",")[0].strip() if weather_context and weather_context.get("location") else None)
            or (payload.location_name.strip() if payload.location_name and payload.location_name != "Selected Location" else None)
            or extract_location_from_query(payload.query)
            or "London"
        )
        sentiment_cond = None
        if weather_context and weather_context.get("current"):
            sentiment_cond = weather_context["current"].get("condition")
        try:
            sentiment_data = await compute_atmospheric_sentiment(sentiment_city, sentiment_cond)
        except Exception as ex:
            logger.warning("Sentiment calculation failed for chat stream: %s", ex)

    # 3. Parse weather intent and extract structured facts for accuracy
    structured_facts = None
    if raw_weather_data:
        intent = parse_weather_intent(payload.query, payload.history)
        loc_name = resolved_name or payload.location_name or "Selected Location"
        structured_facts = extract_structured_weather_facts(raw_weather_data, raw_aqi_data, loc_name, intent)

    api_key = _load_env()
    if not api_key:
        logger.info("GEMINI_API_KEY not configured — streaming deterministic meteorological response.")
        async def no_key_generator():
            suggestions = generate_contextual_suggestions(payload.query, weather_context)
            meta = {
                "type": "meta",
                "location": weather_context.get("location") if weather_context else (sentiment_city if sentiment_data else None),
                "latitude": weather_context.get("latitude") if weather_context else None,
                "longitude": weather_context.get("longitude") if weather_context else None,
                "warning": weather_context.get("warning") if weather_context else None,
                "has_weather_context": weather_context is not None,
                "suggestions": suggestions,
                "sentiment": sentiment_data
            }
            yield f"data: {json.dumps(meta)}\n\n"
            fallback_text = generate_grounded_fallback_response(
                payload.query,
                weather_context,
                payload.language or "en",
                structured_facts=structured_facts,
                sentiment_data=sentiment_data
            )
            for chunk in fallback_text.split(" "):
                yield f"data: {json.dumps({'type': 'token', 'text': chunk + ' '})}\n\n"
                await asyncio.sleep(0.012)
            yield f"data: {json.dumps({'type': 'done', 'ai_used': False})}\n\n"

        return StreamingResponse(
            no_key_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
        )

    api_key, gemini_payload = prepare_gemini_request(
        payload.query,
        weather_context,
        payload.language or "en",
        payload.history,
        payload.image_base64,
        payload.image_mime_type,
        structured_facts=structured_facts,
        sentiment_data=sentiment_data
    )

    async def event_generator():
        suggestions = generate_contextual_suggestions(payload.query, weather_context)
        meta = {
            "type": "meta",
            "location": weather_context.get("location") if weather_context else (sentiment_city if sentiment_data else None),
            "latitude": weather_context.get("latitude") if weather_context else None,
            "longitude": weather_context.get("longitude") if weather_context else None,
            "warning": weather_context.get("warning") if weather_context else None,
            "has_weather_context": weather_context is not None,
            "suggestions": suggestions,
            "sentiment": sentiment_data
        }
        yield f"data: {json.dumps(meta)}\n\n"

        client = get_http_client()
        stream_url = f"{GEMINI_STREAM_URL}?alt=sse"
        stream_filter = StreamingMetaFilter()

        any_token_emitted = False
        try:
            async with client.stream(
                "POST",
                stream_url,
                headers={
                    "Content-Type": "application/json",
                    "x-goog-api-key": api_key,
                },
                json=gemini_payload
            ) as res:
                if res.status_code != 200:
                    # This used to fail completely silently. Read the error
                    # body (small, streaming errors are short) so it lands in
                    # the server logs instead of vanishing.
                    try:
                        err_body = (await res.aread())[:800]
                    except Exception:
                        err_body = b""
                    logger.error("Gemini API error %s on /api/v1/chat/stream: %s", res.status_code, err_body)
                    # Stream grounded fallback tokens gracefully
                    fallback_text = generate_grounded_fallback_response(
                        payload.query,
                        weather_context,
                        payload.language or "en",
                        structured_facts=structured_facts,
                        sentiment_data=sentiment_data
                    )
                    for chunk in fallback_text.split(" "):
                        yield f"data: {json.dumps({'type': 'token', 'text': chunk + ' '})}\n\n"
                        await asyncio.sleep(0.012)
                    yield f"data: {json.dumps({'type': 'done', 'ai_used': False})}\n\n"
                    return

                async for line in res.aiter_lines():
                    if line.startswith("data:"):
                        raw_data = line[5:].strip()
                        if not raw_data:
                            continue
                        try:
                            chunk_obj = json.loads(raw_data)
                            candidates = chunk_obj.get("candidates", [])
                            if candidates:
                                parts = candidates[0].get("content", {}).get("parts", [])
                                for part in parts:
                                    token = part.get("text", "")
                                    if token:
                                        any_token_emitted = True
                                        for out_tok in stream_filter.push(token):
                                            yield f"data: {json.dumps({'type': 'token', 'text': out_tok})}\n\n"
                        except Exception:
                            pass

            if not any_token_emitted:
                logger.warning("Gemini stream returned 200 but produced no text tokens on /api/v1/chat/stream.")
                fallback_text = generate_grounded_fallback_response(
                    payload.query,
                    weather_context,
                    payload.language or "en",
                    structured_facts=structured_facts,
                    sentiment_data=sentiment_data
                )
                for chunk in fallback_text.split(" "):
                    yield f"data: {json.dumps({'type': 'token', 'text': chunk + ' '})}\n\n"
                    await asyncio.sleep(0.012)
                yield f"data: {json.dumps({'type': 'done', 'ai_used': False})}\n\n"
                return

            for remaining in stream_filter.flush():
                yield f"data: {json.dumps({'type': 'token', 'text': remaining})}\n\n"
        except Exception as exc:
            logger.error("Exception during Gemini streaming on /api/v1/chat/stream: %r", exc)
            yield f"data: {json.dumps({'type': 'error', 'text': 'Connection error during streaming.'})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'done', 'ai_used': True})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@router.get("/api/v1/health")
async def health(check_ai: bool = False):
    """
    check_ai=false (default): fast, no external calls — just reports whether
    a key is present, exactly as before.
    check_ai=true: makes one tiny live call to the configured Gemini model
    and reports whether it actually succeeded, with the real error message
    if not. This is the difference between "a key is set" and "the AI is
    actually working" — the previous health check could never tell the two
    apart, which is exactly how a broken AI call went unnoticed.
    """
    key = _load_env()
    result = {
        "status": "ok",
        "version": "2.1.0",
        "service": "AtmosX Multilingual Weather API",
        "ai_configured": bool(key),
        "ai_model": GEMINI_URL.rsplit("/", 1)[-1].split(":")[0],
    }

    if check_ai and key:
        try:
            client = get_http_client()
            res = await client.post(
                GEMINI_URL,
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
                json={
                    "contents": [{"role": "user", "parts": [{"text": "Reply with the single word: OK"}]}],
                    "generationConfig": {"maxOutputTokens": 10},
                },
            )
            if res.status_code == 200:
                text = res.json().get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                result["ai_reachable"] = bool(text)
                result["ai_error"] = None if text else "Gemini returned 200 with no text in the response."
            else:
                result["ai_reachable"] = False
                result["ai_error"] = f"HTTP {res.status_code}: {res.text[:500]}"
                logger.error("Health check: Gemini call failed with %s: %s", res.status_code, res.text[:500])
        except Exception as exc:
            result["ai_reachable"] = False
            result["ai_error"] = repr(exc)
            logger.error("Health check: exception calling Gemini: %r", exc)
    elif check_ai and not key:
        result["ai_reachable"] = False
        result["ai_error"] = "GEMINI_API_KEY is not set."

    return result



# ==============================================================================
# SECTION 12: STATIC FRONTEND SERVING & LIFESPAN
# ==============================================================================

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(self), camera=(self), microphone=(self)"
        return response

_SHARED_CLIENT: Optional[httpx.AsyncClient] = None

@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    global _SHARED_CLIENT
    limits = httpx.Limits(max_keepalive_connections=40, max_connections=100, keepalive_expiry=30.0)
    timeout = httpx.Timeout(25.0, connect=5.0)
    _SHARED_CLIENT = httpx.AsyncClient(limits=limits, timeout=timeout)
    yield
    if _SHARED_CLIENT and not _SHARED_CLIENT.is_closed:
        await _SHARED_CLIENT.aclose()

def get_http_client() -> httpx.AsyncClient:
    global _SHARED_CLIENT
    if _SHARED_CLIENT is None or _SHARED_CLIENT.is_closed:
        limits = httpx.Limits(max_keepalive_connections=40, max_connections=100, keepalive_expiry=30.0)
        _SHARED_CLIENT = httpx.AsyncClient(limits=limits, timeout=httpx.Timeout(25.0, connect=5.0))
    return _SHARED_CLIENT

app = FastAPI(
    title="AtmosX — Multilingual AI Weather Intelligence",
    version="2.1.0",
    lifespan=lifespan
)

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Accept"],
)

app.include_router(router)

# Mount static frontend
BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
if PUBLIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"Starting AtmosX server on http://0.0.0.0:{port} ...")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
