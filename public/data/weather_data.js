/**
 * WeatherGPT Meteorological Database — SIH26068
 * Official Grounding Telemetry, Observations, IMD Bulletins, and Multi-Sector Advisories
 */

const WEATHER_STATIONS = Object.freeze([
  {
    id: "wayanad",
    name: "Wayanad",
    state: "Kerala",
    aliases: ["wayanad", "sulthan bathery", "kalpetta", "mananthavady"],
    coordinates: { lat: 11.6854, lon: 76.1320, elevationM: 700 },
    observation: {
      tempC: 22.8,
      feelsLikeC: 24.2,
      humidityPct: 94,
      pressureHpa: 1008.2,
      windKmh: 18,
      windDir: "WSW",
      rainNowMm: 34.5,
      aqi: 22,
      uvIndex: 2,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Kerala Automated Weather Station Network",
      stationType: "Hill Agro-AWS"
    },
    forecast: {
      next24hRainProbPct: 90,
      tempMinC: 20,
      tempMaxC: 25,
      rainfallExpectedMm: "70-115 mm (Heavy to very heavy)",
      windGustMaxKmh: 45,
      condition: "Continuous heavy rain with saturated soil cover",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Regional Meteorological Centre, Thiruvananthapuram"
    },
    warning: {
      type: "Heavy Rainfall & Landslide Vulnerability",
      severity: "Orange",
      headline: "Orange Alert: Isolated heavy to very heavy rainfall (115–204 mm) likely over Wayanad district in the next 24 hours. High risk of debris flow and localized landslips on steep slopes.",
      protocol: "District Disaster Management Authority (DDMA) advises avoiding non-essential travel in hilly ghat corridors; residents along vulnerable slopes must monitor river gauges and stay prepared to shift to relief camps.",
      issuedBy: "IMD RMC Thiruvananthapuram / Kerala State Disaster Management Authority",
      issuedAt: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST"
    },
    advisory: {
      agriculture: "Postpone all fertilizer applications and pesticide spraying in plantation crops (coffee/tea/pepper); clear drainage channels in valleys immediately.",
      travel: "Ghat roads (Thamarassery/Kuttiady pass) prone to minor mudslides; night travel strictly discouraged.",
      disaster: "Keep emergency grab-bags ready; NDRF and local fire rescue units are on standby."
    }
  },
  {
    id: "nashik",
    name: "Nashik",
    state: "Maharashtra",
    aliases: ["nashik", "nasik", "niphad", "dindori"],
    coordinates: { lat: 19.9975, lon: 73.7898, elevationM: 584 },
    observation: {
      tempC: 26.5,
      feelsLikeC: 27.8,
      humidityPct: 54,
      pressureHpa: 1012.4,
      windKmh: 8,
      windDir: "NW",
      rainNowMm: 0,
      aqi: 48,
      uvIndex: 7,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Maharashtra AWS Network",
      stationType: "Agrometeorological Observatory"
    },
    forecast: {
      next24hRainProbPct: 8,
      tempMinC: 19,
      tempMaxC: 32,
      rainfallExpectedMm: "0 mm (Dry)",
      windGustMaxKmh: 18,
      condition: "Clear sky with gentle breeze; warm afternoon",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Agromet Advisory Service, Pune"
    },
    warning: null,
    advisory: {
      agriculture: "Ideal atmospheric conditions for spraying fungicides and nutrients in grape vineyards and onion nurseries between 06:30 and 10:30 AM (wind under 10 km/h, zero rain wash-off risk).",
      travel: "Excellent visibility, no weather-induced travel impediments.",
      disaster: "Normal status across the district."
    }
  },
  {
    id: "puri",
    name: "Puri",
    state: "Odisha",
    aliases: ["puri", "jagannath puri", "konark", "chilika"],
    coordinates: { lat: 19.8135, lon: 85.8312, elevationM: 0 },
    observation: {
      tempC: 28.6,
      feelsLikeC: 34.1,
      humidityPct: 92,
      pressureHpa: 994.8,
      windKmh: 58,
      windDir: "ENE",
      rainNowMm: 48.0,
      aqi: 18,
      uvIndex: 1,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Coastal Radar & High-Speed Doppler AWS, Puri",
      stationType: "Coastal Radar Station"
    },
    forecast: {
      next24hRainProbPct: 98,
      tempMinC: 25,
      tempMaxC: 29,
      rainfallExpectedMm: "150-250 mm (Extremely Heavy Rainfall)",
      windGustMaxKmh: 95,
      condition: "Severe squally storm with sea surge exceeding 1.5 meters",
      issued: "2026-09-08 05:00 IST",
      validUntil: "2026-09-09 05:00 IST",
      source: "IMD Cyclone Warning Centre, Bhubaneswar"
    },
    warning: {
      type: "Severe Cyclonic Storm & Coastal Surge",
      severity: "Red",
      headline: "Red Alert: Severe Cyclonic Storm approaching Odisha coast. Expected to cross between Puri and Paradeep with sustained gale winds 75–85 km/h gusting to 95 km/h within 24–36 hours.",
      protocol: "Total suspension of fishing operations; coastal sea beaches closed; evacuate kutcha houses within 5 km of shoreline to multipurpose cyclone shelters immediately.",
      issuedBy: "IMD Cyclone Warning Centre (CWC) Bhubaneswar",
      issuedAt: "2026-09-08 05:00 IST",
      validUntil: "2026-09-09 17:00 IST"
    },
    advisory: {
      agriculture: "Harvest mature standing paddy immediately if possible; anchor betel vine sheds and store harvested produce in pucca godowns.",
      travel: "All train services in coastal Khurda Road division under review; national highway coastal stretches facing tree-fall disruptions.",
      disaster: "Evacuation protocol in effect. Contact District Emergency Operations Centre (DEOC) at 1077."
    }
  },
  {
    id: "leh",
    name: "Leh",
    state: "Ladakh",
    aliases: ["leh", "ladakh", "nubra", "kargil", "pangong"],
    coordinates: { lat: 34.1526, lon: 77.5771, elevationM: 3500 },
    observation: {
      tempC: 8.5,
      feelsLikeC: 6.2,
      humidityPct: 28,
      pressureHpa: 672.0,
      windKmh: 14,
      windDir: "NNE",
      rainNowMm: 0,
      aqi: 12,
      uvIndex: 9,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD High-Altitude Observatory, Leh",
      stationType: "Trans-Himalayan AWS"
    },
    forecast: {
      next24hRainProbPct: 4,
      tempMinC: 2,
      tempMaxC: 17,
      rainfallExpectedMm: "0 mm (Trace snow on Khardung La pass)",
      windGustMaxKmh: 28,
      condition: "Clear arid skies, freezing night temperatures, intense solar UV",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Meteorological Centre, Srinagar / Leh"
    },
    warning: null,
    advisory: {
      agriculture: "Protect high-altitude greenhouse crops against sub-zero radiation cooling tonight.",
      travel: "High mountain passes (Khardung La, Chang La) open during daylight; carry thermal snow chains and anti-freeze coolant.",
      disaster: "Normal high-altitude desert conditions; hydrate continuously."
    }
  },
  {
    id: "chennai",
    name: "Chennai",
    state: "Tamil Nadu",
    aliases: ["chennai", "madras", "meenambakkam", "nungambakkam"],
    coordinates: { lat: 13.0827, lon: 80.2707, elevationM: 7 },
    observation: {
      tempC: 30.8,
      feelsLikeC: 38.4,
      humidityPct: 79,
      pressureHpa: 1009.1,
      windKmh: 16,
      windDir: "SE",
      rainNowMm: 4.2,
      aqi: 62,
      uvIndex: 8,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Tamil Nadu Mesonet Network",
      stationType: "Coastal Urban AWS"
    },
    forecast: {
      next24hRainProbPct: 65,
      tempMinC: 26,
      tempMaxC: 34,
      rainfallExpectedMm: "25-50 mm (Moderate with isolated intense spells)",
      windGustMaxKmh: 42,
      condition: "Hot and humid forenoon giving way to convective evening thunderstorms",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Regional Meteorological Centre, Chennai"
    },
    warning: {
      type: "Thunderstorm with Intense Lightning",
      severity: "Yellow",
      headline: "Yellow Watch: Thunderstorms with cloud-to-ground lightning and gusty surface winds (35–45 km/h) likely over Chennai and adjacent districts in late afternoon / evening.",
      protocol: "Avoid taking shelter under tall isolated trees or tin sheds during lightning; unplug sensitive electronic devices.",
      issuedBy: "IMD Regional Meteorological Centre, Chennai",
      issuedAt: "2026-09-08 05:30 IST",
      validUntil: "2026-09-08 23:00 IST"
    },
    advisory: {
      agriculture: "Provide staking for horticultural crops and banana plantations to withstand thunderstorm wind squalls.",
      travel: "Expect slow peak-hour road traffic in waterlogging-prone subway passages during evening cloudbursts.",
      disaster: "State Disaster Control Room active; monitoring low-lying urban catchment areas."
    }
  },
  {
    id: "jaipur",
    name: "Jaipur",
    state: "Rajasthan",
    aliases: ["jaipur", "pink city", "sanganer", "amber"],
    coordinates: { lat: 26.9124, lon: 75.7873, elevationM: 431 },
    observation: {
      tempC: 38.4,
      feelsLikeC: 41.2,
      humidityPct: 24,
      pressureHpa: 1006.0,
      windKmh: 12,
      windDir: "WSW",
      rainNowMm: 0,
      aqi: 145,
      uvIndex: 10,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Rajasthan AWS Network",
      stationType: "Semi-Arid Observational Station"
    },
    forecast: {
      next24hRainProbPct: 0,
      tempMinC: 28,
      tempMaxC: 42.5,
      rainfallExpectedMm: "0 mm (Extreme dry heat)",
      windGustMaxKmh: 24,
      condition: "Severe hot dry westerly winds with high insolation",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Meteorological Centre, Jaipur"
    },
    warning: {
      type: "Severe Heatwave Conditions",
      severity: "Orange",
      headline: "Orange Alert: Heatwave conditions with maximum temperatures 4.5°C to 6°C above seasonal normal. High health risk for vulnerable individuals (children, elderly, outdoor workers).",
      protocol: "Avoid direct sun exposure between 12:00 noon and 3:30 PM; maintain oral rehydration with ORS / lemon water; provide shade and water for cattle.",
      issuedBy: "IMD Meteorological Centre, Jaipur",
      issuedAt: "2026-09-08 05:30 IST",
      validUntil: "2026-09-11 05:30 IST"
    },
    advisory: {
      agriculture: "Apply light and frequent surface irrigation during evening hours to maintain soil moisture and mitigate plant heat stress.",
      travel: "High risk of vehicular tyre blowouts on expressways due to excessive tarmac temperature.",
      disaster: "Primary Health Centres alerted with dedicated heat-stroke wards."
    }
  },
  {
    id: "guwahati",
    name: "Guwahati",
    state: "Assam",
    aliases: ["guwahati", "kamrup", "dispur", "brahmaputra"],
    coordinates: { lat: 26.1445, lon: 91.7362, elevationM: 55 },
    observation: {
      tempC: 28.2,
      feelsLikeC: 33.5,
      humidityPct: 88,
      pressureHpa: 1007.8,
      windKmh: 10,
      windDir: "ENE",
      rainNowMm: 22.4,
      aqi: 35,
      uvIndex: 4,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Assam AWS Network",
      stationType: "Riverine Valley AWS"
    },
    forecast: {
      next24hRainProbPct: 75,
      tempMinC: 24,
      tempMaxC: 31,
      rainfallExpectedMm: "60-90 mm (Heavy rainfall)",
      windGustMaxKmh: 35,
      condition: "Widespread monsoon rainfall with high river runoff",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Regional Meteorological Centre, Guwahati"
    },
    warning: {
      type: "Riverine Flood & Inundation",
      severity: "Orange",
      headline: "Orange Alert: Brahmaputra river flowing 0.72 meters above danger level at Guwahati water gauge. Continued heavy catchment precipitation threatens riparian and low-lying urban wards.",
      protocol: "Residents of riverine chars and low-lying floodplains must shift livestock to elevated highland platforms; avoid wading into fast-flowing culverts.",
      issuedBy: "Central Water Commission / IMD RMC Guwahati",
      issuedAt: "2026-09-08 04:00 IST",
      validUntil: "2026-09-09 04:00 IST"
    },
    advisory: {
      agriculture: "Drain inundated paddy fields where water exceeds seedling submergence tolerance; relocate livestock to flood relief shelters.",
      travel: "Ferry services on the Brahmaputra suspended until river velocity subsides.",
      disaster: "SDRF boats positioned at Pandu and Fancy Bazaar ghats."
    }
  },
  {
    id: "mumbai",
    name: "Mumbai",
    state: "Maharashtra",
    aliases: ["mumbai", "bombay", "colaba", "santacruz", "thane"],
    coordinates: { lat: 19.0760, lon: 72.8777, elevationM: 14 },
    observation: {
      tempC: 29.4,
      feelsLikeC: 35.8,
      humidityPct: 83,
      pressureHpa: 1009.6,
      windKmh: 24,
      windDir: "W",
      rainNowMm: 12.0,
      aqi: 55,
      uvIndex: 5,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Mumbai Radar & Coastal AWS",
      stationType: "Coastal Megacity AWS"
    },
    forecast: {
      next24hRainProbPct: 70,
      tempMinC: 25,
      tempMaxC: 31,
      rainfallExpectedMm: "45-75 mm with high tide interaction",
      windGustMaxKmh: 50,
      condition: "Moderate to heavy rain spells coinciding with afternoon astronomical high tide",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Regional Meteorological Centre, Mumbai"
    },
    warning: {
      type: "Tidal Surge & Urban Waterlogging",
      severity: "Yellow",
      headline: "Yellow Watch: Intermittent heavy rain spells coinciding with a 4.28m high tide at 14:18 IST. High probability of localized street waterlogging in low-lying chronic spots (Hindmata, Kurla, Milan subway).",
      protocol: "Citizens advised to check train status and high-tide timings before planning afternoon commutes; stay away from seafront promenades.",
      issuedBy: "IMD RMC Mumbai / Municipal Corporation of Greater Mumbai (MCGM)",
      issuedAt: "2026-09-08 05:30 IST",
      validUntil: "2026-09-08 22:00 IST"
    },
    advisory: {
      agriculture: "Coastal fishers advised not to venture past 12 nautical miles due to rough swell.",
      travel: "Suburban local trains may operate with speed restrictions during downpours.",
      disaster: "Disaster Management Cell operating 24/7 helpline 1916."
    }
  },
  {
    id: "delhi",
    name: "Delhi NCR",
    state: "Delhi",
    aliases: ["delhi", "new delhi", "noida", "gurugram", "safdarjung"],
    coordinates: { lat: 28.6139, lon: 77.2090, elevationM: 216 },
    observation: {
      tempC: 33.2,
      feelsLikeC: 38.0,
      humidityPct: 62,
      pressureHpa: 1008.2,
      windKmh: 11,
      windDir: "ESE",
      rainNowMm: 0.8,
      aqi: 178,
      uvIndex: 7,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Safdarjung Observatory",
      stationType: "National Capital Mesonet"
    },
    forecast: {
      next24hRainProbPct: 40,
      tempMinC: 27,
      tempMaxC: 36,
      rainfallExpectedMm: "5-15 mm (Patchy light to moderate showers)",
      windGustMaxKmh: 30,
      condition: "Partly cloudy with muggy conditions; isolated brief rain shower",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Regional Meteorological Centre, New Delhi"
    },
    warning: null,
    advisory: {
      agriculture: "Monitor rice and maize fields for pest infestation due to high humidity and warm temperatures.",
      travel: "Generally smooth; brief localized ponding possible under outer ring road flyovers.",
      disaster: "Normal monitoring."
    }
  },
  {
    id: "shimla",
    name: "Shimla",
    state: "Himachal Pradesh",
    aliases: ["shimla", "kufri", "solan", "mashobra"],
    coordinates: { lat: 31.1048, lon: 77.1734, elevationM: 2200 },
    observation: {
      tempC: 17.5,
      feelsLikeC: 16.8,
      humidityPct: 86,
      pressureHpa: 785.4,
      windKmh: 15,
      windDir: "SW",
      rainNowMm: 18.0,
      aqi: 19,
      uvIndex: 4,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Himachal Pradesh AWS Network",
      stationType: "Himalayan Ridge AWS"
    },
    forecast: {
      next24hRainProbPct: 75,
      tempMinC: 14,
      tempMaxC: 20,
      rainfallExpectedMm: "35-65 mm (Moderate with isolated intense spells)",
      windGustMaxKmh: 38,
      condition: "Thick fog reducing visibility to 200m; intermittent rain showers",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Meteorological Centre, Shimla"
    },
    warning: {
      type: "Dense Fog & Mountain Flash Flooding",
      severity: "Yellow",
      headline: "Yellow Watch: Dense fog with visibility under 200m and isolated heavy spells likely over Shimla and Solan hills. Risk of rockfall on Shimla-Kalka NH-5.",
      protocol: "Motorists must use fog lights and exercise extreme caution along steep curves; keep safe distance.",
      issuedBy: "IMD MC Shimla / Himachal Pradesh State Disaster Management Authority",
      issuedAt: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST"
    },
    advisory: {
      agriculture: "Apple growers should monitor for scab fungus post-rain; maintain orchard drainage.",
      travel: "Drive at reduced speeds on hilly highway stretches; check landslide updates before heading to upper Shimla.",
      disaster: "Emergency highway patrol deployed along NH-5."
    }
  },
  {
    id: "bengaluru",
    name: "Bengaluru",
    state: "Karnataka",
    aliases: ["bengaluru", "bangalore", "whitefield", "electronic city", "hebbal"],
    coordinates: { lat: 12.9716, lon: 77.5946, elevationM: 920 },
    observation: {
      tempC: 24.6,
      feelsLikeC: 25.4,
      humidityPct: 72,
      pressureHpa: 1010.5,
      windKmh: 14,
      windDir: "W",
      rainNowMm: 2.0,
      aqi: 42,
      uvIndex: 6,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Bengaluru Observatory",
      stationType: "Plateau City AWS"
    },
    forecast: {
      next24hRainProbPct: 55,
      tempMinC: 20,
      tempMaxC: 28,
      rainfallExpectedMm: "15-30 mm (Evening thunderstorms)",
      windGustMaxKmh: 32,
      condition: "Pleasant morning, cumulus clouds building up into late afternoon showers",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Meteorological Centre, Bengaluru"
    },
    warning: null,
    advisory: {
      agriculture: "Favorable conditions for sowing pulses and ragi in surrounding rural districts.",
      travel: "Usual water ponding in low-lying underpasses during evening rush hours.",
      disaster: "Routine civic monitoring."
    }
  },
  {
    id: "kolkata",
    name: "Kolkata",
    state: "West Bengal",
    aliases: ["kolkata", "calcutta", "dum dum", "alipore", "howrah"],
    coordinates: { lat: 22.5726, lon: 88.3639, elevationM: 9 },
    observation: {
      tempC: 31.0,
      feelsLikeC: 39.5,
      humidityPct: 82,
      pressureHpa: 1007.2,
      windKmh: 14,
      windDir: "S",
      rainNowMm: 8.5,
      aqi: 74,
      uvIndex: 7,
      asOf: "2026-09-08 06:00 IST",
      source: "IMD Alipore Observatory",
      stationType: "Deltaic Urban AWS"
    },
    forecast: {
      next24hRainProbPct: 65,
      tempMinC: 26,
      tempMaxC: 33,
      rainfallExpectedMm: "25-45 mm with gusty wind spells",
      windGustMaxKmh: 45,
      condition: "Warm and sultry with one or two intense thunderstorm spells",
      issued: "2026-09-08 05:30 IST",
      validUntil: "2026-09-09 05:30 IST",
      source: "IMD Regional Meteorological Centre, Alipore, Kolkata"
    },
    warning: {
      type: "Squally Thunderstorm / Kalbaishakhi",
      severity: "Yellow",
      headline: "Yellow Watch: Thunderstorm with lightning and gusty winds reaching 40–50 km/h likely over Kolkata and South 24 Parganas.",
      protocol: "Take shelter in safe structures during thunderstorm; avoid open water bodies.",
      issuedBy: "IMD RMC Kolkata",
      issuedAt: "2026-09-08 05:30 IST",
      validUntil: "2026-09-08 22:00 IST"
    },
    advisory: {
      agriculture: "Protect betel-leaf vines and vegetable trellises against gusty squalls in South 24 Parganas.",
      travel: "Ferry crossings across Hooghly river subject to safety halts during squall passages.",
      disaster: "Civil defence units on alert."
    }
  }
]);

// Export for module/worker environments or global window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WEATHER_STATIONS };
}
