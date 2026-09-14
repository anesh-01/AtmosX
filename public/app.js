/**
 * AtmosX 2.0 — Multilingual AI Weather Intelligence
 * 
 * AI runs entirely on the backend (Gemini key hidden from browser).
 * This file handles: UI, voice, language detection, weather dashboard,
 * file scanning, and calls to the AtmosX backend API.
 */

'use strict';

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
const CONFIG = Object.freeze({
  MAX_INPUT_LEN: 400,
  MIN_SEND_GAP_MS: 600,
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024,
  WEATHER_CACHE_TTL_MS: 90 * 1000,
  LIVE_POLL_INTERVAL_MS: 60 * 1000, // 60s background live polling
  API_TIMEOUT_MS: 25000,
});

const API_BASE_URL = window.location.protocol === 'file:'
  ? 'http://localhost:8000'
  : '';

// ── Splash screen state flag ───────────────────────────────────────────────
// Set to false after the 5-second splash completes.
// Prevents any search/fetch overlay from firing during initial load.
let isInitialLoad = true;

// ============================================================================
// 2. LANGUAGE SYSTEM
// ============================================================================
const LANGUAGES = Object.freeze({
  auto: { name: 'Auto-detect',  nativeName: 'Auto',      bcp47: 'auto',  rtl: false },
  en:   { name: 'English',      nativeName: 'English',   bcp47: 'en-IN', rtl: false },
  hi:   { name: 'Hindi',        nativeName: 'हिन्दी',      bcp47: 'hi-IN', rtl: false },
  ta:   { name: 'Tamil',        nativeName: 'தமிழ்',       bcp47: 'ta-IN', rtl: false },
  te:   { name: 'Telugu',       nativeName: 'తెలుగు',      bcp47: 'te-IN', rtl: false },
  ml:   { name: 'Malayalam',    nativeName: 'മലയാളം',     bcp47: 'ml-IN', rtl: false },
  kn:   { name: 'Kannada',      nativeName: 'ಕನ್ನಡ',       bcp47: 'kn-IN', rtl: false },
  bn:   { name: 'Bengali',      nativeName: 'বাংলা',       bcp47: 'bn-IN', rtl: false },
  mr:   { name: 'Marathi',      nativeName: 'मराठी',       bcp47: 'mr-IN', rtl: false },
  gu:   { name: 'Gujarati',     nativeName: 'ગુજરાતી',     bcp47: 'gu-IN', rtl: false },
  pa:   { name: 'Punjabi',      nativeName: 'ਪੰਜਾਬੀ',      bcp47: 'pa-IN', rtl: false },
  or:   { name: 'Odia',         nativeName: 'ଓଡ଼ିଆ',        bcp47: 'or-IN', rtl: false },
  ur:   { name: 'Urdu',         nativeName: 'اردو',        bcp47: 'ur-IN', rtl: true  },
  ar:   { name: 'Arabic',       nativeName: 'العربية',     bcp47: 'ar',    rtl: true  },
  fr:   { name: 'French',       nativeName: 'Français',   bcp47: 'fr-FR', rtl: false },
  es:   { name: 'Spanish',      nativeName: 'Español',    bcp47: 'es-ES', rtl: false },
  de:   { name: 'German',       nativeName: 'Deutsch',    bcp47: 'de-DE', rtl: false },
  pt:   { name: 'Portuguese',   nativeName: 'Português',  bcp47: 'pt-PT', rtl: false },
  zh:   { name: 'Chinese',      nativeName: '中文',         bcp47: 'zh-CN', rtl: false },
  ja:   { name: 'Japanese',     nativeName: '日本語',        bcp47: 'ja-JP', rtl: false },
  ko:   { name: 'Korean',       nativeName: '한국어',        bcp47: 'ko-KR', rtl: false },
  ru:   { name: 'Russian',      nativeName: 'Русский',    bcp47: 'ru-RU', rtl: false },
  tr:   { name: 'Turkish',      nativeName: 'Türkçe',     bcp47: 'tr-TR', rtl: false },
  sw:   { name: 'Swahili',      nativeName: 'Kiswahili',  bcp47: 'sw',    rtl: false },
});

// Detect language from Unicode script of typed text
function detectLangFromScript(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0900 && cp <= 0x097F) return 'hi';
    if (cp >= 0x0B80 && cp <= 0x0BFF) return 'ta';
    if (cp >= 0x0C00 && cp <= 0x0C7F) return 'te';
    if (cp >= 0x0D00 && cp <= 0x0D7F) return 'ml';
    if (cp >= 0x0C80 && cp <= 0x0CFF) return 'kn';
    if (cp >= 0x0980 && cp <= 0x09FF) return 'bn';
    if (cp >= 0x0A80 && cp <= 0x0AFF) return 'gu';
    if (cp >= 0x0A00 && cp <= 0x0A7F) return 'pa';
    if (cp >= 0x0B00 && cp <= 0x0B7F) return 'or';
    if (cp >= 0x0600 && cp <= 0x06FF) return 'ar';
    if (cp >= 0x4E00 && cp <= 0x9FFF) return 'zh';
    if (cp >= 0x3040 && cp <= 0x30FF) return 'ja';
    if (cp >= 0xAC00 && cp <= 0xD7AF) return 'ko';
    if (cp >= 0x0400 && cp <= 0x04FF) return 'ru';
  }
  return 'en';
}

function getEffectiveLang(text) {
  if (state.settings.language && state.settings.language !== 'auto') {
    return state.settings.language;
  }
  return detectLangFromScript(text);
}

// ============================================================================
// 3. STATE
// ============================================================================
const state = {
  currentStation: null,
  conversationHistory: [],
  isSending: false,
  lastSendAt: 0,
  isListening: false,
  recognition: null,
  currentlyPlayingMsgId: null,
  attachedScan: null,
  tempScan: null,
  pwaPromptEvent: null,
  weatherCache: new Map(),
  liveRefreshTimer: null,
  freshnessTickerTimer: null,
  lastTelemetryFetchTimestamp: null,
  lastTelemetryIsCached: false,
  lastTelemetryCacheAgeSec: 0,
  lastTelemetryStatus: 'live', // 'live', 'stale', 'offline'
  latestWeatherData: null,
  cameraStream: null,
  cameraFacingMode: 'environment', // 'environment' (rear) or 'user' (front)
  capturedImageBase64: null,
  activeAbortController: null,
  radarSpeed: 1.0,
  radarPaused: false,
  settings: {
    autoSpeak: false,
    speechRate: 1.0,
    voiceIndex: 0,
    language: 'auto',
  }
};
window.state = state;

try {
  const saved = localStorage.getItem('atmosx_settings_v2');
  if (saved) Object.assign(state.settings, JSON.parse(saved));
} catch (e) {}

// ============================================================================
// 4. DOM REFERENCES
// ============================================================================
const DOM = {
  statusStationName:          document.getElementById('statusStationName'),
  btnInstallPwa:              document.getElementById('btnInstallPwa'),
  btnOpenSettings:            document.getElementById('btnOpenSettings'),
  warningBanner:              document.getElementById('warningBanner'),
  warnSeverityBadge:          document.getElementById('warnSeverityBadge'),
  warnHeadline:               document.getElementById('warnHeadline'),
  warnProtocol:               document.getElementById('warnProtocol'),
  warnMeta:                   document.getElementById('warnMeta'),
  messagesContainer:          document.getElementById('messagesContainer'),
  emptyWelcome:               document.getElementById('emptyWelcome'),
  btnClearChat:               document.getElementById('btnClearChat'),
  waveformContainer:          document.getElementById('waveformContainer'),
  waveformCanvas:             document.getElementById('waveformCanvas'),
  waveformText:               document.getElementById('waveformText'),
  btnStopVoice:               document.getElementById('btnStopVoice'),
  composerAttachmentPreview:  document.getElementById('composerAttachmentPreview'),
  attachmentThumb:            document.getElementById('attachmentThumb'),
  attachmentTitle:            document.getElementById('attachmentTitle'),
  btnRemoveAttachment:        document.getElementById('btnRemoveAttachment'),
  inputPrompt:                document.getElementById('inputPrompt'),
  charCount:                  document.getElementById('charCount'),
  btnCameraTrigger:           document.getElementById('btnCameraTrigger'),
  btnDocUploadTrigger:        document.getElementById('btnDocUploadTrigger'),
  btnVoiceTrigger:            document.getElementById('btnVoiceTrigger'),
  btnSend:                    document.getElementById('btnSend'),
  stationSelect:              document.getElementById('stationSelect'),
  evidenceBody:               document.getElementById('evidenceBody'),
  valTemp:                    document.getElementById('valTemp'),
  valTempSub:                 document.getElementById('valTempSub'),
  valHumidity:                document.getElementById('valHumidity'),
  valPressure:                document.getElementById('valPressure'),
  valWind:                    document.getElementById('valWind'),
  valWindSub:                 document.getElementById('valWindSub'),
  valRain:                    document.getElementById('valRain'),
  valAqi:                     document.getElementById('valAqi'),
  valAqiSub:                  document.getElementById('valAqiSub'),
  confidenceFill:             document.getElementById('confidenceFill'),
  confidenceLabel:            document.getElementById('confidenceLabel'),
  cameraModal:                document.getElementById('cameraModal'),
  btnCloseCameraModal:        document.getElementById('btnCloseCameraModal'),
  uploadModal:                document.getElementById('uploadModal'),
  btnCloseUploadModal:        document.getElementById('btnCloseUploadModal'),
  fileDropzone:               document.getElementById('fileDropzone'),
  fileInput:                  document.getElementById('fileInput'),
  scannerResultsCard:         document.getElementById('scannerResultsCard'),
  scanPreviewImg:             document.getElementById('scanPreviewImg'),
  scanDetectedTitle:          document.getElementById('scanDetectedTitle'),
  scanTagsList:               document.getElementById('scanTagsList'),
  scanSummaryText:            document.getElementById('scanSummaryText'),
  btnAttachToQuery:           document.getElementById('btnAttachToQuery'),
  btnCancelScan:              document.getElementById('btnCancelScan'),
  settingsModal:              document.getElementById('settingsModal'),
  btnCloseSettingsModal:      document.getElementById('btnCloseSettingsModal'),
  toggleAutoSpeak:            document.getElementById('toggleAutoSpeak'),
  selectVoiceSpeed:           document.getElementById('selectVoiceSpeed'),
  selectVoiceChoice:          document.getElementById('selectVoiceChoice'),
  selectLanguage:             document.getElementById('selectLanguage'),
  btnSaveSettings:            document.getElementById('btnSaveSettings'),
  langBadge:                  document.getElementById('langBadge'),
  // Modern Glassmorphism Widgets
  valCondition:               document.getElementById('valCondition'),
  valTempRange:               document.getElementById('valTempRange'),
  heroWxIcon:                 document.getElementById('heroWxIcon'),
  valPressureBadge:           document.getElementById('valPressureBadge'),
  pressureScaleMarker:        document.getElementById('pressureScaleMarker'),
  valRainAccumBadge:          document.getElementById('valRainAccumBadge'),
  rainWaveLine:               document.getElementById('rainWaveLine'),
  rainWaveArea:               document.getElementById('rainWaveArea'),
  rainScrubberPoint:          document.getElementById('rainScrubberPoint'),
  valWindDirBadge:            document.getElementById('valWindDirBadge'),
  gaugeWindNeedle:            document.getElementById('gaugeWindNeedle'),
  ringFeelsLike:              document.getElementById('ringFeelsLike'),
  valFeelsLike:               document.getElementById('valFeelsLike'),
  ringVisibility:             document.getElementById('ringVisibility'),
  valVisibility:              document.getElementById('valVisibility'),
  valVisibilityStatus:        document.getElementById('valVisibilityStatus'),
  ringPrecip:                 document.getElementById('ringPrecip'),
  valAqiStatus:               document.getElementById('valAqiStatus'),
  ringAqiScore:               document.getElementById('ringAqiScore'),
  polPM25:                    document.getElementById('polPM25'),
  polPM10:                    document.getElementById('polPM10'),
  polSO2:                     document.getElementById('polSO2'),
  polNO2:                     document.getElementById('polNO2'),
  polO3:                      document.getElementById('polO3'),
  polCO:                      document.getElementById('polCO'),
  hourlyScrollTrack:          document.getElementById('hourlyScrollTrack'),
  radarCanvas:                document.getElementById('radarCanvas'),
  radarCoord:                 document.getElementById('radarCoord'),
  radarLiveInfo:              document.getElementById('radarLiveInfo'),
  radarTelemetryBadge:        document.getElementById('radarTelemetryBadge'),
  radarTelemetryIcon:         document.getElementById('radarTelemetryIcon'),
  radarStatusTag:             document.getElementById('radarStatusTag'),
  // Hero Overview Card (Section 10)
  heroOverviewCard:           document.getElementById('heroOverviewCard'),
  heroLocationName:           document.getElementById('heroLocationName'),
  heroObsTime:                document.getElementById('heroObsTime'),
  heroLargeTemp:              document.getElementById('heroLargeTemp'),
  heroConditionText:          document.getElementById('heroConditionText'),
  heroFeelsText:              document.getElementById('heroFeelsText'),
  heroConditionSvg:           document.getElementById('heroConditionSvg'),
  dynamicWeatherIcon:         document.getElementById('dynamic-weather-icon'),
  mainWeatherIcon:            document.getElementById('dynamic-weather-icon') || document.getElementById('main-weather-icon'),
  cityMoodWidget:             document.getElementById('cityMoodWidget'),
  moodScore:                  document.getElementById('mood-score'),
  moodEmoji:                  document.getElementById('mood-emoji'),
  heroStatHumidity:           document.getElementById('heroStatHumidity'),
  heroStatWind:               document.getElementById('heroStatWind'),
  heroStatPressure:           document.getElementById('heroStatPressure'),
  heroHourlyCarousel:         document.getElementById('heroHourlyCarousel'),
  // Location Switcher Modal
  btnChangeLocation:          document.getElementById('btnChangeLocation'),
  locationModal:              document.getElementById('locationModal'),
  btnCloseLocationModal:      document.getElementById('btnCloseLocationModal'),
  inputSearchCity:            document.getElementById('inputSearchCity'),
  btnSearchCity:              document.getElementById('btnSearchCity'),
  citySearchResults:          document.getElementById('citySearchResults'),
  popularStationsGrid:        document.getElementById('popularStationsGrid'),
  btnUseCurrentLocation:      document.getElementById('btnUseCurrentLocation'),
  recentStationsSection:      document.getElementById('recentStationsSection'),
  recentStationsGrid:         document.getElementById('recentStationsGrid'),
  btnToggleRadarPlay:         document.getElementById('btnToggleRadarPlay'),
  btnToggleRadarSpeed:        document.getElementById('btnToggleRadarSpeed'),
  toastContainer:             document.getElementById('toastContainer'),
  // Layout & Floating Island
  aiSection:                  document.getElementById('aiSection'),
  observatorySection:         document.getElementById('observatorySection'),
  floatingNav:                document.getElementById('floatingNav'),
  navBtnAi:                   document.getElementById('navBtnAi'),
  navBtnObservatory:          document.getElementById('navBtnObservatory'),
  btnScrollToTop:             document.getElementById('btnScrollToTop'),
  btnJumpObservatory:         document.getElementById('btnJumpObservatory'),
  topbarWeatherPill:          document.getElementById('topbarWeatherPill'),
  topbarWeatherText:          document.getElementById('topbarWeatherText'),
  // Atmospheric Pressure Features
  valPressureTendency:        document.getElementById('valPressureTendency'),
  pressureSparklinePath:      document.getElementById('pressureSparklinePath'),
  pressureRangeLabel:         document.getElementById('pressureRangeLabel'),
  btnOpenPressureDetails:     document.getElementById('btnOpenPressureDetails'),
  modalPressureDetails:       document.getElementById('modalPressureDetails'),
  btnClosePressureModal:      document.getElementById('btnClosePressureModal'),
  detailMslPressure:          document.getElementById('detailMslPressure'),
  detailSurfacePressure:      document.getElementById('detailSurfacePressure'),
  detailPressureTendency:     document.getElementById('detailPressureTendency'),
  detailTendencyBadge:        document.getElementById('detailTendencyBadge'),
  detailRegimeText:           document.getElementById('detailRegimeText'),
  detailPressureArea:         document.getElementById('detailPressureArea'),
  detailPressureLine:         document.getElementById('detailPressureLine'),
  detailPressureDots:         document.getElementById('detailPressureDots'),
  // Precipitation Trend Features
  btnRainModeMm:              document.getElementById('btnRainModeMm'),
  btnRainModeProb:            document.getElementById('btnRainModeProb'),
  rainfallChartBox:           document.getElementById('rainfallChartBox'),
  rainScrubberLine:           document.getElementById('rainScrubberLine'),
  rainChartTooltip:           document.getElementById('rainChartTooltip'),
  tooltipTime:                document.getElementById('tooltipTime'),
  tooltipVal:                 document.getElementById('tooltipVal'),
  btnOpenPrecipDetails:       document.getElementById('btnOpenPrecipDetails'),
  modalPrecipDetails:         document.getElementById('modalPrecipDetails'),
  btnClosePrecipModal:        document.getElementById('btnClosePrecipModal'),
  detailTotalRain:            document.getElementById('detailTotalRain'),
  detailPeakWindow:           document.getElementById('detailPeakWindow'),
  detailPeakAmount:           document.getElementById('detailPeakAmount'),
  detailMaxProb:              document.getElementById('detailMaxProb'),
  detailPrecipType:           document.getElementById('detailPrecipType'),
  detailRainCategory:         document.getElementById('detailRainCategory'),
  detailPrecipTableBody:      document.getElementById('detailPrecipTableBody'),
  valVisibilityDesc:          document.getElementById('valVisibilityDesc'),
  valVisibilitySub:           document.getElementById('valVisibilitySub'),
  valRainDesc:                document.getElementById('valRainDesc'),
  valRainSub:                 document.getElementById('valRainSub'),
  radarStatusTag:             document.getElementById('radarStatusTag'),

  // Best Time Today & Weather Impact DOM
  valBestTimeBadge:           document.getElementById('valBestTimeBadge'),
  valOptimalWindow:           document.getElementById('valOptimalWindow'),
  valOptimalReason:           document.getElementById('valOptimalReason'),
  valMorningCond:             document.getElementById('valMorningCond'),
  valMorningMeta:             document.getElementById('valMorningMeta'),
  valAfternoonCond:           document.getElementById('valAfternoonCond'),
  valAfternoonMeta:           document.getElementById('valAfternoonMeta'),
  valEveningCond:             document.getElementById('valEveningCond'),
  valEveningMeta:             document.getElementById('valEveningMeta'),

  valImpactOverallBadge:      document.getElementById('valImpactOverallBadge'),
  valImpactCommute:           document.getElementById('valImpactCommute'),
  valImpactFitness:           document.getElementById('valImpactFitness'),
  valImpactAir:               document.getElementById('valImpactAir'),
  valImpactSun:               document.getElementById('valImpactSun'),

  // Phase 2 Live Telemetry, Weather Pulse & Camera DOM
  aiSpeakingBanner:           document.getElementById('aiSpeakingBanner'),
  spkBannerText:              document.getElementById('spkBannerText'),
  btnStopSpeechBanner:        document.getElementById('btnStopSpeechBanner'),
  obsLiveStatusBadge:         document.getElementById('obsLiveStatusBadge'),
  obsPulseDot:                document.getElementById('obsPulseDot'),
  obsLiveStatusLabel:         document.getElementById('obsLiveStatusLabel'),
  obsFreshnessText:           document.getElementById('obsFreshnessText'),
  obsExactTime:               document.getElementById('obsExactTime'),

  weatherPulseCard:           document.getElementById('weatherPulseCard'),
  wpEmoji:                    document.getElementById('wpEmoji'),
  wpMainStatement:            document.getElementById('wpMainStatement'),
  wpCompBadge:                document.getElementById('wpCompBadge'),
  wpTimestamp:                document.getElementById('wpTimestamp'),
  wpValTemp:                  document.getElementById('wpValTemp'),
  wpValHumidity:              document.getElementById('wpValHumidity'),
  wpValPressure:              document.getElementById('wpValPressure'),
  wpValRain:                  document.getElementById('wpValRain'),

  dashSolarUvCard:            document.getElementById('dashSolarUvCard'),
  valUvIndex:                 document.getElementById('valUvIndex'),
  valUvMax:                   document.getElementById('valUvMax'),
  valUvBadge:                 document.getElementById('valUvBadge'),
  valUvMeterFill:             document.getElementById('valUvMeterFill'),
  valSunrise:                 document.getElementById('valSunrise'),
  valSunset:                  document.getElementById('valSunset'),
  valSolarNoon:               document.getElementById('valSolarNoon'),
  valDayLength:               document.getElementById('valDayLength'),
  valSolarProgressLabel:      document.getElementById('valSolarProgressLabel'),
  valSolarProgressPercent:    document.getElementById('valSolarProgressPercent'),
  valSolarProgressFill:       document.getElementById('valSolarProgressFill'),
  valSolarSunPin:             document.getElementById('valSolarSunPin'),
  valUvAdvice:                document.getElementById('valUvAdvice'),
  btnOpenUvDetails:           document.getElementById('btnOpenUvDetails'),

  // Camera Studio
  liveCameraVideo:            document.getElementById('liveCameraVideo'),
  cameraCanvas:               document.getElementById('cameraCanvas'),
  cameraSnapshotPreview:      document.getElementById('cameraSnapshotPreview'),
  cameraControlsLive:         document.getElementById('cameraControlsLive'),
  btnSnapPhoto:               document.getElementById('btnSnapPhoto'),
  btnSwitchCamera:            document.getElementById('btnSwitchCamera'),
  snapshotAnalysisBox:        document.getElementById('snapshotAnalysisBox'),
  cameraPromptInput:          document.getElementById('cameraPromptInput'),
  btnSubmitPhotoQuery:        document.getElementById('btnSubmitPhotoQuery'),
  btnRetakePhoto:             document.getElementById('btnRetakePhoto'),
  cameraStatusText:           document.getElementById('cameraStatusText'),

  // Clickable Detail Modals
  modalPressureDetails:       document.getElementById('modalPressureDetails'),
  btnClosePressureModal:      document.getElementById('btnClosePressureModal'),
  modalPrecipDetails:         document.getElementById('modalPrecipDetails'),
  btnClosePrecipModal:        document.getElementById('btnClosePrecipModal'),
  modalWindDetails:           document.getElementById('modalWindDetails'),
  btnCloseWindModal:          document.getElementById('btnCloseWindModal'),
  modalThermalDetails:        document.getElementById('modalThermalDetails'),
  btnCloseThermalModal:       document.getElementById('btnCloseThermalModal'),
  modalAqiDetails:            document.getElementById('modalAqiDetails'),
  btnCloseAqiModal:           document.getElementById('btnCloseAqiModal'),
  modalUvDetails:             document.getElementById('modalUvDetails'),
  btnCloseUvModal:            document.getElementById('btnCloseUvModal'),
};

// ============================================================================
// 5. SECURITY
// ============================================================================
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  for (const c of children) { if (c) node.appendChild(c); }
  return node;
}

function iconSvg(id, cls = 'icon') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

// ─── Toast Notification System ──────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  if (!DOM.toastContainer) {
    DOM.toastContainer = document.getElementById('toastContainer');
  }
  if (!DOM.toastContainer) return;

  const icons = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  };

  const toast = el('div', { className: `toast toast-${type}` }, [
    el('span', { className: 'toast-icon', text: icons[type] || 'ℹ️' }),
    el('div', { className: 'toast-message', text: message }),
    el('button', { className: 'toast-close', text: '×', attrs: { 'aria-label': 'Close notification' } })
  ]);

  const closeBtn = toast.querySelector('.toast-close');
  const dismiss = () => {
    toast.classList.add('toast-hide');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 220);
  };

  closeBtn?.addEventListener('click', dismiss);
  DOM.toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// Global safety net for uncaught errors
window.addEventListener('error', (event) => {
  console.warn('weatherGPT uncaught runtime error:', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.warn('weatherGPT unhandled promise rejection:', event.reason);
});


function sanitizeInput(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
            .trim()
            .slice(0, CONFIG.MAX_INPUT_LEN);
}

function detectPromptInjection(text) {
  const lower = text.toLowerCase();
  const patterns = [
    'ignore previous instructions', 'disregard all prior', 'system prompt override',
    'you are now dan', 'developer mode enabled', 'bypass safety',
    'reveal internal system', 'jailbreak', 'act as an unfiltered',
  ];
  return patterns.some(p => lower.includes(p));
}

async function validateFileSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (bytes[0]===0xFF && bytes[1]===0xD8 && bytes[2]===0xFF) return 'image/jpeg';
  if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return 'image/png';
  if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46) return 'image/webp';
  if (bytes[0]===0x25 && bytes[1]===0x50 && bytes[2]===0x44 && bytes[3]===0x46) return 'application/pdf';
  const isText = /\.(txt|csv|json)$/i.test(file.name);
  if (isText) return 'text/plain';
  return null;
}

// ============================================================================
// 6. BACKEND API CALLS
// ============================================================================

// Cache for weather data (90-second TTL)
function getCached(key) {
  const c = state.weatherCache.get(key);
  if (!c) return null;
  if (Date.now() - c.fetchedAt > CONFIG.WEATHER_CACHE_TTL_MS) { state.weatherCache.delete(key); return null; }
  return c.data;
}
function setCache(key, data) { state.weatherCache.set(key, { data, fetchedAt: Date.now() }); }

/**
 * THE main chat call — sends query to AtmosX backend.
 * Backend fetches live weather + calls Gemini with the hidden key.
 * Returns { answer, location, warning, has_weather_context }
 */
/**
 * High-speed streaming chat call — receives SSE tokens in real-time.
 */
async function callBackendChatStream(question, locationName, lang, onMeta, onToken, history = null, imageBase64 = null, imageMimeType = 'image/jpeg') {
  const controller = new AbortController();
  state.activeAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

  try {
    const payload = {
      query: question,
      location_name: locationName || null,
      language: lang || 'en',
      user_role: 'general',
      history: history || []
    };
    if (imageBase64 && typeof imageBase64 === 'string') {
      payload.image_base64 = imageBase64;
      payload.image_mime_type = imageMimeType || 'image/jpeg';
    }

    const res = await fetch(`${API_BASE_URL}/api/v1/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload)
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    const processBuffer = (flushAll = false) => {
      // Normalize line endings
      const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const blocks = normalized.split('\n\n');
      if (!flushAll) {
        buffer = blocks.pop() || '';
      } else {
        buffer = '';
      }

      for (const block of blocks) {
        const lines = block.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              const data = JSON.parse(raw);
              if (data.type === 'meta' && onMeta) {
                onMeta(data);
              } else if (data.type === 'token' && onToken) {
                onToken(data.text);
              } else if (data.type === 'error') {
                throw new Error(data.text || 'Error in AI service');
              }
            } catch (e) {
              if (e.name !== 'SyntaxError') throw e;
            }
          }
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processBuffer(false);
    }
    // Flush any remaining content in buffer
    if (buffer.trim()) {
      processBuffer(true);
    }
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timeout);
    state.activeAbortController = null;
  }
}

async function callBackendChat(question, locationName, lang, history = null, imageBase64 = null, imageMimeType = 'image/jpeg') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

  try {
    const payload = {
      query: question,
      location_name: locationName || null,
      language: lang || 'en',
      user_role: 'general',
      history: history || (state && state.conversationHistory ? state.conversationHistory : [])
    };
    if (imageBase64 && typeof imageBase64 === 'string') {
      payload.image_base64 = imageBase64;
      payload.image_mime_type = imageMimeType || 'image/jpeg';
    }

    const res = await fetch(`${API_BASE_URL}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload)
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/** Fetch weather data for dashboard panel */
async function fetchDashboardWeather(station) {
  if (!station?.coordinates) return null;
  const { lat, lon } = station.coordinates;
  const cacheKey = `dash_${lat}_${lon}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);
  try {
    const url = `${API_BASE_URL}/api/v1/dashboard-weather` +
      `?latitude=${lat}&longitude=${lon}&location_name=${encodeURIComponent(station.name)}`;
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    const data = await res.json();
    setCache(cacheKey, data);
    return data;
  } catch (err) {
    clearTimeout(timeout);
    console.warn('Dashboard fetch failed:', err.message);
    return null;
  }
}

// ============================================================================
// 7. LOCATION RESOLUTION
// ============================================================================
function extractExplicitCity(query) {
  if (!query) return null;
  const lower = query.toLowerCase();
  const knownCities = [
    'delhi', 'new delhi', 'mumbai', 'bombay', 'bengaluru', 'bangalore', 'chennai', 'madras',
    'kolkata', 'calcutta', 'hyderabad', 'pune', 'ahmedabad', 'jaipur', 'lucknow', 'kanpur',
    'nagpur', 'patna', 'bhopal', 'surat', 'kochi', 'cochin', 'thiruvananthapuram', 'chandigarh',
    'shimla', 'dehradun', 'srinagar', 'leh', 'ladakh', 'amritsar', 'agra', 'varanasi',
    'puri', 'bhubaneswar', 'guwahati', 'shillong', 'gangtok', 'darjeeling', 'manali',
    'london', 'paris', 'new york', 'tokyo', 'dubai', 'singapore', 'sydney', 'berlin',
    'toronto', 'moscow', 'rome', 'cairo', 'madrid', 'seoul', 'bangkok', 'mysore', 'mysuru'
  ];
  for (const c of knownCities) {
    const reg = new RegExp(`(^|\\s|[.,?!])${c}($|\\s|[.,?!])`, 'i');
    if (reg.test(lower)) return c;
  }
  const match = lower.match(/\b(?:in|at|for|near)\s+([a-z]{3,24})\b/i);
  if (match) {
    const cand = match[1].toLowerCase();
    const ignore = ['today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening', 'detail', 'english', 'hindi', 'tamil'];
    if (!ignore.includes(cand)) return cand;
  }
  return null;
}

function resolveStationFromQuery(query) {
  if (typeof WEATHER_STATIONS === 'undefined' || !query) return null;
  const lower = query.toLowerCase();
  return WEATHER_STATIONS.find(s =>
    (s.aliases || []).some(a => {
      const reg = new RegExp(`(^|\\s|[.,?!])${a.toLowerCase()}($|\\s|[.,?!])`, 'i');
      return reg.test(lower);
    })
  ) || null;
}

function extractLocationName(query, station) {
  if (station?.name) return station.name;
  const explicit = extractExplicitCity(query);
  if (explicit) return explicit;
  return null;
}

// ============================================================================
// 8. VOICE INTERFACE
// ============================================================================
let availableVoices = [];

function populateVoiceList() {
  if (!('speechSynthesis' in window) || !DOM.selectVoiceChoice) return;
  availableVoices = window.speechSynthesis.getVoices();
  DOM.selectVoiceChoice.innerHTML = '';
  availableVoices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${v.name} (${v.lang})${v.default ? ' — Default' : ''}`;
    DOM.selectVoiceChoice.appendChild(opt);
  });
  if (state.settings.voiceIndex < availableVoices.length)
    DOM.selectVoiceChoice.value = state.settings.voiceIndex;
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = populateVoiceList;
  populateVoiceList();
}

let waveAnimId = null;

function startWaveAnimation() {
  if (!DOM.waveformCanvas) return;
  const ctx = DOM.waveformCanvas.getContext('2d');
  const [W, H] = [DOM.waveformCanvas.width, DOM.waveformCanvas.height];
  let phase = 0;
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    const n = 16, bw = 4, gap = (W - n * bw) / (n - 1);
    for (let i = 0; i < n; i++) {
      const amp = Math.sin(phase + i * 0.4) * 0.5 + 0.5;
      const bh = Math.max(4, amp * (H - 4));
      ctx.fillStyle = i % 2 === 0 ? '#5BC0EB' : '#8FD4E8';
      ctx.fillRect(i * (bw + gap), (H - bh) / 2, bw, bh);
    }
    phase += 0.15;
    waveAnimId = requestAnimationFrame(draw);
  };
  draw();
}

function stopWaveAnimation() {
  if (waveAnimId) { cancelAnimationFrame(waveAnimId); waveAnimId = null; }
  if (DOM.waveformCanvas)
    DOM.waveformCanvas.getContext('2d').clearRect(0, 0, DOM.waveformCanvas.width, DOM.waveformCanvas.height);
}

function initSpeechRecognition() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return null;
  const rec = new SpeechRec();
  rec.continuous = false;
  rec.interimResults = true;
  const lang = state.settings.language;
  rec.lang = (lang && lang !== 'auto') ? (LANGUAGES[lang]?.bcp47 || 'en-IN') : 'en-IN';

  rec.onstart = () => {
    state.isListening = true;
    DOM.btnVoiceTrigger?.classList.add('listening');
    DOM.waveformContainer?.classList.add('active');
    if (DOM.waveformText) DOM.waveformText.textContent = 'Listening… speak in any language';
    startWaveAnimation();
  };
  rec.onresult = (e) => {
    let t = '';
    for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
    if (DOM.inputPrompt) { DOM.inputPrompt.value = t; updateCharCount(); }
  };
  rec.onerror = (e) => {
    console.warn('Speech error:', e.error);
    stopListening();
    if (e.error === 'not-allowed')
      addSystemMessage('Microphone access denied. Allow microphone permission to use voice input.');
  };
  rec.onend = () => {
    stopListening();
    if (DOM.inputPrompt?.value.trim()) DOM.inputPrompt.focus();
  };
  return rec;
}

function startListening() {
  if (!state.recognition) state.recognition = initSpeechRecognition();
  if (!state.recognition) {
    showToast('Voice input is not supported in this browser. Please use Chrome, Edge, or Safari.', 'warning');
    return;
  }
  try { state.recognition.start(); } catch (e) {}
}

function stopListening() {
  state.isListening = false;
  DOM.btnVoiceTrigger?.classList.remove('listening');
  DOM.waveformContainer?.classList.remove('active');
  stopWaveAnimation();
  if (state.recognition) { try { state.recognition.stop(); } catch (e) {} }
}

function speakText(text, msgId, btnRef) {
  if (!('speechSynthesis' in window)) return;
  if (window.speechSynthesis.speaking && state.currentlyPlayingMsgId === msgId) {
    window.speechSynthesis.cancel();
    state.currentlyPlayingMsgId = null;
    if (btnRef) { btnRef.classList.remove('playing'); if (btnRef.firstChild) btnRef.firstChild.textContent = 'Listen'; }
    return;
  }
  window.speechSynthesis.cancel();
  document.querySelectorAll('.btn-speak-msg').forEach(b => {
    b.classList.remove('playing');
    if (b.firstChild) b.firstChild.textContent = 'Listen';
  });
  const cleanText = text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[\*\-]\s+/gm, '')
    .replace(/---+/g, '')
    .trim();
  const utt = new SpeechSynthesisUtterance(cleanText);
  utt.rate = state.settings.speechRate || 1.0;
  if (availableVoices.length > 0 && state.settings.voiceIndex < availableVoices.length)
    utt.voice = availableVoices[state.settings.voiceIndex];
  utt.onstart = () => {
    state.currentlyPlayingMsgId = msgId;
    if (btnRef) { btnRef.classList.add('playing'); if (btnRef.firstChild) btnRef.firstChild.textContent = 'Stop'; }
    if (DOM.aiSpeakingBanner) DOM.aiSpeakingBanner.style.display = 'flex';
    if (DOM.spkBannerText) DOM.spkBannerText.textContent = 'AtmosX is speaking...';
  };
  utt.onend   = () => {
    state.currentlyPlayingMsgId = null;
    if (btnRef) { btnRef.classList.remove('playing'); if (btnRef.firstChild) btnRef.firstChild.textContent = 'Listen'; }
    if (DOM.aiSpeakingBanner) DOM.aiSpeakingBanner.style.display = 'none';
  };
  utt.onerror = utt.onend;
  window.speechSynthesis.speak(utt);
}

// ============================================================================
// 9. COMPUTER VISION & DOCUMENT SCANNER
// ============================================================================
async function scanWeatherPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 400;
        let [w, h] = [img.width, img.height];
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let totalLum = 0, blueSky = 0, darkStorm = 0, greyCloud = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b] = [d[i], d[i+1], d[i+2]];
          const lum = 0.2126*r + 0.7152*g + 0.0722*b;
          totalLum += lum;
          const max = Math.max(r,g,b), mn = Math.min(r,g,b);
          const sat = max === 0 ? 0 : (max - mn) / max;
          if (b > r+20 && b > g+10 && lum > 100) blueSky++;
          else if (lum < 75 && sat < 0.3) darkStorm++;
          else if (sat < 0.25 && lum >= 75 && lum <= 210) greyCloud++;
        }
        const px = w * h;
        const avgLum = Math.round(totalLum / px);
        const blueRatio = blueSky / px;
        const darkRatio = darkStorm / px;
        const cloudRatio = Math.min(1, (greyCloud + darkStorm) / px);
        let cloudType = 'Cumulus / Fair Weather', severity = 'Low',
            hazard = 'Normal conditions', rainProb = 15;
        if (darkRatio > 0.28) { cloudType = 'Cumulonimbus (Severe Convective)'; severity = 'High'; hazard = 'Imminent heavy rain, lightning, gusty wind'; rainProb = 92; }
        else if (cloudRatio > 0.65 && avgLum < 120) { cloudType = 'Nimbostratus (Continuous Rain)'; severity = 'Moderate'; hazard = 'Sustained precipitation, reduced visibility'; rainProb = 80; }
        else if (cloudRatio > 0.4) { cloudType = 'Stratocumulus / Overcast'; severity = 'Low'; hazard = 'Scattered showers possible'; rainProb = 45; }
        else if (blueRatio > 0.5) { cloudType = 'Clear / Cirrus Sky'; severity = 'None'; hazard = 'No convective risk'; rainProb = 5; }
        resolve({
          type: 'image', fileName: file.name, dataUrl: e.target.result,
          cloudType, cloudCoveragePct: Math.round(cloudRatio * 100),
          averageLuminance: avgLum, severity, hazard, estimatedRainProbPct: rainProb,
          summary: `Visual scan: ${cloudType} (~${Math.round(cloudRatio*100)}% coverage). Hazard: ${hazard}.`
        });
      };
      img.onerror = () => reject(new Error('Failed to decode image.'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('File read error.'));
    reader.readAsDataURL(file);
  });
}

async function scanWeatherDocument(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const text  = typeof e.target.result === 'string' ? e.target.result : new TextDecoder().decode(e.target.result);
      const lower = text.toLowerCase();
      const tempM = text.match(/(\d{1,2}(?:\.\d+)?)\s*(?:°C|deg\s*C)/i);
      const rainM = text.match(/(\d{1,3}(?:\.\d+)?)\s*(?:mm|millimeter)/i);
      const windM = text.match(/(\d{1,3}(?:\.\d+)?)\s*(?:km\/h|kmph|knots)/i);
      let alertLevel = 'Normal';
      if (lower.includes('red alert') || lower.includes('cyclonic')) alertLevel = 'Red Alert';
      else if (lower.includes('orange alert') || lower.includes('heavy rain')) alertLevel = 'Orange Alert';
      else if (lower.includes('yellow watch') || lower.includes('thunderstorm')) alertLevel = 'Yellow Watch';
      resolve({
        type: 'document', fileName: file.name, detectedType: 'Weather Bulletin / Sensor Log',
        alertLevel,
        extractedTemp: tempM ? tempM[0] : null,
        extractedRain: rainM ? rainM[0] : null,
        extractedWind: windM ? windM[0] : null,
        snippet: text.slice(0, 300).replace(/\s+/g, ' '),
        summary: `Document: Alert Level ${alertLevel}. ${tempM?'Temp: '+tempM[0]:''} ${rainM?'Rain: '+rainM[0]:''} ${windM?'Wind: '+windM[0]:''}`.trim()
      });
    };
    reader.onerror = () => reject(new Error('Failed to read document.'));
    reader.readAsText(file.slice(0, 50000));
  });
}

// ============================================================================
// 10. CHAT UI
// ============================================================================
let msgIdCounter = 0;

function hideWelcome() {
  if (DOM.emptyWelcome) { DOM.emptyWelcome.remove(); DOM.emptyWelcome = null; }
}

function addUserMessage(text, attachment = null) {
  hideWelcome();
  const children = [];
  if (attachment) {
    if (attachment.type === 'image' && attachment.dataUrl) {
      const imgThumb = document.createElement('img');
      imgThumb.src = attachment.dataUrl;
      imgThumb.alt = 'User captured sky observation';
      imgThumb.style.cssText = 'max-width:240px;max-height:160px;object-fit:cover;border-radius:8px;margin-bottom:8px;display:block;border:1px solid rgba(91,192,235,0.4);box-shadow:0 2px 10px rgba(0,0,0,0.3);';
      children.push(imgThumb);
    }
    children.push(el('div', {
      attrs: { style: 'margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.2);font-size:11.5px;opacity:0.9' }
    }, [
      iconSvg(attachment.type === 'image' ? 'i-camera' : 'i-doc'),
      el('span', { text: ` Attached: ${attachment.fileName}` })
    ]));
  }
  children.push(el('div', { text }));
  DOM.messagesContainer.appendChild(el('div', { className: 'msg-bubble user' }, children));
  DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
}

function addSystemMessage(text) {
  hideWelcome();
  DOM.messagesContainer.appendChild(el('div', { className: 'msg-bubble system', text }));
  DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
}

function addTypingIndicator() {
  hideWelcome();
  const row = el('div', { className: 'msg-bubble bot' }, [
    el('div', { className: 'bot-avatar' }, [iconSvg('i-radar')]),
    el('div', { className: 'bot-content-wrap' }, [
      el('div', { className: 'typing-indicator' }, [
        el('span', { className: 'typing-dot' }),
        el('span', { className: 'typing-dot' }),
        el('span', { className: 'typing-dot' }),
      ])
    ])
  ]);
  DOM.messagesContainer.appendChild(row);
  DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
  return row;
}

function renderMarkdownInto(container, markdownText) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!markdownText) return;

  const lines = markdownText.split(/\r?\n/);
  let currentList = null;

  function renderInline(text, targetEl) {
    const parts = text.split(/(\*\*.*?\*\*|\*[^*]+?\*)/g);
    for (const part of parts) {
      if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
        const strong = document.createElement('strong');
        strong.textContent = part.slice(2, -2);
        targetEl.appendChild(strong);
      } else if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
        const em = document.createElement('em');
        em.textContent = part.slice(1, -1);
        targetEl.appendChild(em);
      } else if (part) {
        targetEl.appendChild(document.createTextNode(part));
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      currentList = null;
      continue;
    }

    if (/^---+$|^\*\*\*+$/.test(trimmed)) {
      currentList = null;
      const hr = document.createElement('hr');
      hr.style.cssText = 'border:none;border-top:1px solid rgba(143,212,232,0.18);margin:10px 0;';
      container.appendChild(hr);
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (hMatch) {
      currentList = null;
      const hLevel = hMatch[1].length;
      const hTag = hLevel === 1 ? 'h3' : (hLevel === 2 ? 'h4' : 'h5');
      const headingEl = document.createElement(hTag);
      headingEl.style.cssText = 'margin:10px 0 4px;color:var(--accent-cyan);font-family:var(--font-sans);font-weight:600;font-size:' + (hLevel === 1 ? '15px' : '13.5px') + ';';
      renderInline(hMatch[2], headingEl);
      container.appendChild(headingEl);
      continue;
    }

    const bMatch = trimmed.match(/^[\*\-]\s+(.*)$/);
    if (bMatch) {
      if (!currentList || currentList.tagName !== 'UL') {
        currentList = document.createElement('ul');
        currentList.style.cssText = 'margin:4px 0 6px 18px;padding:0;';
        container.appendChild(currentList);
      }
      const li = document.createElement('li');
      li.style.cssText = 'margin:3px 0;';
      renderInline(bMatch[1], li);
      currentList.appendChild(li);
      continue;
    }

    const nMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (nMatch) {
      if (!currentList || currentList.tagName !== 'OL') {
        currentList = document.createElement('ol');
        currentList.style.cssText = 'margin:4px 0 6px 20px;padding:0;';
        container.appendChild(currentList);
      }
      const li = document.createElement('li');
      li.style.cssText = 'margin:3px 0;';
      renderInline(nMatch[2], li);
      currentList.appendChild(li);
      continue;
    }

    currentList = null;
    const p = document.createElement('p');
    p.style.cssText = 'margin:4px 0;line-height:1.55;';
    renderInline(trimmed, p);
    container.appendChild(p);
  }
}

function createStreamingBotMessage() {
  hideWelcome();
  const id = ++msgIdCounter;
  const bodyText = el('div', { className: 'bot-text' });
  const btnSpeak = el('button', {
    className: 'btn-speak-msg',
    attrs: { type: 'button', 'data-msg-id': id }
  }, [el('span', { text: 'Listen' }), iconSvg('i-volume')]);

  let fullText = '';
  btnSpeak.addEventListener('click', () => speakText(fullText, id, btnSpeak));

  const btnCopy = el('button', {
    className: 'btn-speak-msg btn-copy-msg',
    attrs: { type: 'button', title: 'Copy response to clipboard' }
  }, [iconSvg('i-copy'), el('span', { text: 'Copy' })]);
  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(fullText).then(() => {
      btnCopy.classList.add('copied');
      const span = btnCopy.querySelector('span');
      if (span) span.textContent = 'Copied!';
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        if (span) span.textContent = 'Copy';
      }, 2000);
    }).catch(() => {});
  });

  const suggestionsBox = el('div', { className: 'bot-suggestions-bar', attrs: { style: 'display:none;' } });
  const row = el('div', { className: 'msg-bubble bot' }, [
    el('div', { className: 'bot-avatar' }, [iconSvg('i-radar')]),
    el('div', { className: 'bot-content-wrap' }, [
      bodyText,
      el('div', { className: 'bot-audio-bar' }, [btnCopy, btnSpeak]),
      suggestionsBox
    ])
  ]);
  DOM.messagesContainer.appendChild(row);
  DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;

  return {
    row,
    appendToken(token) {
      fullText += token;
      const c = DOM.messagesContainer;
      const isNearBottom = c ? (c.scrollHeight - c.scrollTop - c.clientHeight) < 95 : true;
      renderMarkdownInto(bodyText, fullText);
      if (c && isNearBottom) {
        c.scrollTop = c.scrollHeight;
      }
    },
    finalize(finalText, suggestions = null) {
      if (finalText !== undefined) fullText = finalText;
      const c = DOM.messagesContainer;
      const isNearBottom = c ? (c.scrollHeight - c.scrollTop - c.clientHeight) < 95 : true;
      renderMarkdownInto(bodyText, fullText);
      if (suggestions && suggestions.length) {
        while (suggestionsBox.firstChild) suggestionsBox.removeChild(suggestionsBox.firstChild);
        suggestions.forEach(sug => {
          const btn = el('button', { className: 'btn-suggestion-chip', text: sug });
          btn.addEventListener('click', () => {
            const cleanQuery = sug.replace(/^[\p{Emoji}\s]+/gu, '').trim();
            const targetQ = cleanQuery || sug;
            if (DOM.inputPrompt) {
              DOM.inputPrompt.value = targetQ;
              updateCharCount();
            }
            handleSend(targetQ);
          });
          suggestionsBox.appendChild(btn);
        });
        suggestionsBox.style.display = 'flex';
      }
      if (c && isNearBottom) {
        c.scrollTop = c.scrollHeight;
      }
      if (state.settings.autoSpeak) {
        setTimeout(() => speakText(fullText, id, btnSpeak), 200);
      }
    },
    getFullText() {
      return fullText;
    }
  };
}

function addBotMessage(text, suggestions = null) {
  hideWelcome();
  const id = ++msgIdCounter;
  const bodyText = el('div', { className: 'bot-text' });
  renderMarkdownInto(bodyText, text);
  const btnSpeak = el('button', {
    className: 'btn-speak-msg',
    attrs: { type: 'button', 'data-msg-id': id }
  }, [el('span', { text: 'Listen' }), iconSvg('i-volume')]);
  btnSpeak.addEventListener('click', () => speakText(text, id, btnSpeak));

  const btnCopy = el('button', {
    className: 'btn-speak-msg btn-copy-msg',
    attrs: { type: 'button', title: 'Copy response to clipboard' }
  }, [iconSvg('i-copy'), el('span', { text: 'Copy' })]);
  btnCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      btnCopy.classList.add('copied');
      const span = btnCopy.querySelector('span');
      if (span) span.textContent = 'Copied!';
      setTimeout(() => {
        btnCopy.classList.remove('copied');
        if (span) span.textContent = 'Copy';
      }, 2000);
    }).catch(() => {});
  });

  const suggestionsBox = el('div', { className: 'bot-suggestions-bar', attrs: { style: 'display:none;' } });
  if (suggestions && suggestions.length) {
    suggestions.forEach(sug => {
      const btn = el('button', { className: 'btn-suggestion-chip', text: sug });
      btn.addEventListener('click', () => {
        const cleanQuery = sug.replace(/^[\p{Emoji}\s]+/gu, '').trim();
        const targetQ = cleanQuery || sug;
        if (DOM.inputPrompt) {
          DOM.inputPrompt.value = targetQ;
          updateCharCount();
        }
        handleSend(targetQ);
      });
      suggestionsBox.appendChild(btn);
    });
    suggestionsBox.style.display = 'flex';
  }

  const row = el('div', { className: 'msg-bubble bot' }, [
    el('div', { className: 'bot-avatar' }, [iconSvg('i-radar')]),
    el('div', { className: 'bot-content-wrap' }, [
      bodyText,
      el('div', { className: 'bot-audio-bar' }, [btnCopy, btnSpeak]),
      suggestionsBox
    ])
  ]);
  DOM.messagesContainer.appendChild(row);
  DOM.messagesContainer.scrollTop = DOM.messagesContainer.scrollHeight;
  if (state.settings.autoSpeak) setTimeout(() => speakText(text, id, btnSpeak), 200);
}

// ============================================================================
// 11. TELEMETRY DASHBOARD
// ============================================================================
function getAQILabel(v) {
  if (v == null) return 'N/A';
  if (v <= 50)  return 'Good';
  if (v <= 100) return 'Moderate';
  if (v <= 150) return 'Unhealthy (Sensitive)';
  if (v <= 200) return 'Unhealthy';
  if (v <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}

function getWeatherCondition(code) {
  const c = {0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Foggy',48:'Rime fog',51:'Light drizzle',53:'Moderate drizzle',55:'Dense drizzle',61:'Slight rain',63:'Moderate rain',65:'Heavy rain',71:'Slight snow',73:'Moderate snow',75:'Heavy snow',80:'Slight showers',81:'Moderate showers',82:'Violent showers',95:'Thunderstorm',96:'Thunderstorm+hail',99:'Thunderstorm+heavy hail'};
  return c[Number(code)] || 'Unknown';
}

function getWindDir(deg) {
  const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const v = Number(deg);
  return Number.isFinite(v) ? d[Math.round(v/22.5)%16] : '--';
}

function setPipelineStep(step) {
  document.querySelectorAll('.pipeline-step').forEach(n => n.classList.toggle('active', n.dataset.step === step));
}
function clearPipeline() {
  document.querySelectorAll('.pipeline-step').forEach(n => n.classList.remove('active'));
}

function renderEvidence(loc, scanned = null) {
  while (DOM.evidenceBody.firstChild) DOM.evidenceBody.removeChild(DOM.evidenceBody.firstChild);

  if (!loc && !scanned) {
    if (DOM.statusStationName) DOM.statusStationName.textContent = 'Select Station';
    DOM.valTemp.textContent = '--°C'; DOM.valHumidity.textContent = '--%';
    DOM.valPressure.textContent = '---- hPa'; DOM.valWind.textContent = '-- km/h';
    DOM.valRain.textContent = '-- mm';
    if (DOM.valAqi) DOM.valAqi.textContent = '-- AQI';
    DOM.confidenceFill.style.width = '15%';
    DOM.confidenceLabel.textContent = 'Unresolved (15%)';
    DOM.warningBanner.classList.remove('active');
    DOM.evidenceBody.appendChild(el('div', { className: 'evidence-card' }, [
      el('div', { className: 'ev-card-label observation', text: 'Grounding Status' }),
      el('div', { className: 'ev-card-body', text: 'No station resolved. Ask about a city to load live weather data.' })
    ]));
    return;
  }

  if (loc) {
    state.currentStation = loc;
    if (DOM.statusStationName) DOM.statusStationName.textContent = loc.state ? `${loc.name}, ${loc.state}` : loc.name;
    if (DOM.stationSelect && loc.id) DOM.stationSelect.value = loc.id;

    if (loc.observation) {
      DOM.valTemp.textContent = `${Math.round(loc.observation.tempC)}°C`;
      if (DOM.valTempSub) DOM.valTempSub.textContent = `Actual ${loc.observation.tempC}°C`;
      DOM.valHumidity.textContent = `${loc.observation.humidityPct}% Humidity`;
      DOM.valPressure.textContent = `${loc.observation.pressureHpa}`;
      DOM.valWind.textContent = `${loc.observation.windKmh}`;
      if (DOM.valWindSub) DOM.valWindSub.textContent = `Heading: ${loc.observation.windDir}`;
      DOM.valRain.textContent = `${loc.observation.rainNowMm}`;
      if (DOM.valAqi) DOM.valAqi.textContent = `${loc.observation.aqi}`;
      if (DOM.valAqiSub) DOM.valAqiSub.textContent = `Quality: ${getAQILabel(loc.observation.aqi)}`;

      // Modern widgets update from station telemetry
      const wxCode = loc.observation.rainNowMm > 10 ? 65 : 2;
      const tMin = loc.forecast?.tempMinC ?? loc.observation.tempC - 2;
      const tMax = loc.forecast?.tempMaxC ?? loc.observation.tempC + 2;
      updateHeroConditionPill(loc.forecast?.condition || 'Current Conditions', loc.observation.tempC, tMin, tMax, wxCode);
      updatePressureMeter(loc.observation.pressureHpa, loc.forecast?.hourly || null);
      updateRainfallWaveChart(loc.forecast?.hourly || null);
      if (DOM.topbarWeatherText) {
        DOM.topbarWeatherText.textContent = `${Math.round(loc.observation.tempC)}°C · ${loc.name}`;
      }
      updateRadialGauges({
        wind_speed_10m: loc.observation.windKmh,
        wind_direction_10m: 240, // default WSW
        apparent_temperature: loc.observation.feelsLikeC,
        temperature_2m: loc.observation.tempC,
        visibility: 10000,
        precipitation: loc.observation.rainNowMm,
        relative_humidity_2m: loc.observation.humidityPct
      }, null, loc.observation.windDir);
      updateAqiCard({ us_aqi: loc.observation.aqi });

      DOM.evidenceBody.appendChild(el('div', { className: 'evidence-card' }, [
        el('div', { className: 'ev-card-label observation', text: 'Surface Telemetry (loading live…)' }),
        el('div', { className: 'ev-card-body', text: `${loc.observation.tempC}°C (feels ${loc.observation.feelsLikeC}°C), ${loc.observation.humidityPct}% humidity, wind ${loc.observation.windKmh} km/h (${loc.observation.windDir}), pressure ${loc.observation.pressureHpa} hPa.` }),
        el('div', { className: 'ev-card-source', text: `${loc.observation.source} · Loading live data…` })
      ]));
    }

    if (loc.forecast) {
      DOM.evidenceBody.appendChild(el('div', { className: 'evidence-card' }, [
        el('div', { className: 'ev-card-label forecast', text: '24H Forecast' }),
        el('div', { className: 'ev-card-body', text: `${loc.forecast.next24hRainProbPct}% rain probability. Range: ${loc.forecast.tempMinC}–${loc.forecast.tempMaxC}°C. Expected: ${loc.forecast.rainfallExpectedMm}.` }),
        el('div', { className: 'ev-card-source', text: `${loc.forecast.source} · Loading live forecast…` })
      ]));
    }

    if (loc.warning) {
      DOM.evidenceBody.appendChild(el('div', { className: 'evidence-card' }, [
        el('div', { className: 'ev-card-label warning', text: `${loc.warning.severity} Alert — ${loc.warning.type}` }),
        el('div', { className: 'ev-card-body', text: `${loc.warning.headline} ${loc.warning.protocol}` }),
        el('div', { className: 'ev-card-source', text: `${loc.warning.issuedBy} · until ${loc.warning.validUntil}` })
      ]));
      if (DOM.warnSeverityBadge) DOM.warnSeverityBadge.textContent = `${loc.warning.severity} — ${loc.warning.type}`;
      if (DOM.warnHeadline) DOM.warnHeadline.textContent = loc.warning.headline;
      if (DOM.warnProtocol) DOM.warnProtocol.textContent = `Protocol: ${loc.warning.protocol}`;
      if (DOM.warnMeta) DOM.warnMeta.textContent = `${loc.warning.issuedBy} | Until ${loc.warning.validUntil}`;
      DOM.warningBanner.className = `warning-banner active severity-${loc.warning.severity}`;
    } else {
      DOM.warningBanner.classList.remove('active');
    }
  }

  if (scanned) {
    DOM.evidenceBody.appendChild(el('div', { className: 'evidence-card' }, [
      el('div', { className: 'ev-card-label vision', text: scanned.type === 'image' ? 'Photo Evidence' : 'Document Evidence' }),
      el('div', { className: 'ev-card-body', text: scanned.summary }),
      el('div', { className: 'ev-card-source', text: `Verified: ${scanned.fileName}` })
    ]));
  }

  const confPct = loc ? (loc.warning ? 94 : 85) : 70;
  DOM.confidenceFill.style.width = `${confPct}%`;
  DOM.confidenceLabel.textContent = `Grounded (${confPct}%)`;
}

function upsertLiveForecastEvidence(data) {
  if (!DOM.evidenceBody) return;
  const ex = document.getElementById('liveForecastEvidence');
  if (ex) ex.remove();

  const weather  = data.current || {};
  const forecast = (data.weather_context?.['7_day_forecast'] || []).slice(0, 7);
  const today    = forecast[0];
  const tomorrow = forecast[1];
  const cond     = data.condition || getWeatherCondition(weather.weather_code);
  const windDir  = data.wind_direction_label || getWindDir(weather.wind_direction_10m);
  const uv       = today?.uv_index_max ?? '--';
  const aqi      = data.air_quality?.us_aqi ?? '--';

  const forecastLine = tomorrow
    ? `Today: ${today?.rain_probability_pct ?? '--'}% rain, ${today?.temp_min_c ?? '--'}–${today?.temp_max_c ?? '--'}°C. Tomorrow: ${tomorrow.rain_probability_pct ?? '--'}% rain, ${tomorrow.temp_min_c ?? '--'}–${tomorrow.temp_max_c ?? '--'}°C.`
    : `Today: ${today?.rain_probability_pct ?? '--'}% rain, ${today?.temp_min_c ?? '--'}–${today?.temp_max_c ?? '--'}°C.`;

  DOM.evidenceBody.insertBefore(
    el('div', { className: 'evidence-card', id: 'liveForecastEvidence' }, [
      el('div', { className: 'ev-card-label forecast', text: '🛰️ Live Feed — Open-Meteo' }),
      el('div', { className: 'ev-card-body', text: `${cond}. Wind ${weather.wind_speed_10m ?? '--'} km/h from ${windDir}. Cloud ${weather.cloud_cover ?? '--'}%. UV max ${uv}. AQI ${aqi}. ${forecastLine}` }),
      el('div', { className: 'ev-card-source', text: `Open-Meteo NWP · ${data.grounding_metadata?.timestamp || 'latest'}` })
    ]),
    DOM.evidenceBody.firstChild
  );
}

function updateLiveWarningBanner(data) {
  if (!DOM.warningBanner) return;
  const active  = data.warning_flag ?? data.warning?.active;
  const msg     = data.official_warning ?? data.warning?.message;
  const level   = data.warning_level ?? data.warning?.level ?? 'Orange';
  if (!active) { DOM.warningBanner.classList.remove('active'); return; }
  if (DOM.warnSeverityBadge) DOM.warnSeverityBadge.textContent = `Live Alert — ${level}`;
  if (DOM.warnHeadline)      DOM.warnHeadline.textContent      = msg || 'Weather warning detected.';
  if (DOM.warnProtocol)      DOM.warnProtocol.textContent      = 'Follow local safety protocols.';
  if (DOM.warnMeta)          DOM.warnMeta.textContent          = `Open-Meteo NWP | ${data.grounding_metadata?.timestamp || 'latest'}`;
  DOM.warningBanner.className = `warning-banner active severity-${level}`;
}

function getWeatherIconSymbol(code) {
  const c = Number(code);
  if (c === 0) return 'i-wx-sun';
  if (c === 1 || c === 2) return 'i-wx-partly-cloudy';
  if (c === 3) return 'i-wx-cloud';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(c)) return 'i-wx-rain';
  if ([71, 73, 75, 77, 85, 86].includes(c)) return 'i-wx-snow';
  if ([95, 96, 99].includes(c)) return 'i-wx-storm';
  return 'i-wx-cloud';
}

function updateHeroConditionPill(conditionText, tempC, tempMin, tempMax, wxCode) {
  if (DOM.valCondition && conditionText) DOM.valCondition.textContent = conditionText;
  if (DOM.valTempRange && tempMin != null && tempMax != null) {
    DOM.valTempRange.textContent = `${Math.round(tempMax)}° / ${Math.round(tempMin)}°`;
  }
  if (DOM.heroWxIcon) {
    const iconId = getWeatherIconSymbol(wxCode);
    const use = DOM.heroWxIcon.querySelector('use');
    if (use) use.setAttribute('href', `#${iconId}`);
  }
  updateDynamicWeatherIcon(conditionText);
}

const weatherEmojis = { 'Clear': '☀️', 'Clouds': '☁️', 'Rain': '🌧️', 'Drizzle': '🌦️', 'Thunderstorm': '⛈️', 'Snow': '❄️', 'Mist': '🌫️', 'Fog': '🌫️' };

function getConditionEmoji(condition) {
  if (!condition) return '🌡️';
  if (weatherEmojis[condition]) return weatherEmojis[condition];
  const c = String(condition).trim().toLowerCase();
  if (c.includes('clear') || c.includes('sun')) return weatherEmojis['Clear'];
  if (c.includes('thunder') || c.includes('storm')) return weatherEmojis['Thunderstorm'];
  if (c.includes('snow') || c.includes('blizzard') || c.includes('ice') || c.includes('sleet') || c.includes('hail')) return weatherEmojis['Snow'];
  if (c.includes('drizzle')) return weatherEmojis['Drizzle'];
  if (c.includes('rain') || c.includes('shower')) return weatherEmojis['Rain'];
  if (c.includes('fog')) return weatherEmojis['Fog'];
  if (c.includes('mist') || c.includes('haze')) return weatherEmojis['Mist'];
  if (c.includes('cloud') || c.includes('overcast')) return weatherEmojis['Clouds'];
  return '🌡️';
}

function updateDynamicWeatherIcon(condition) {
  const emoji = weatherEmojis[condition] || getConditionEmoji(condition) || '🌡️';
  const target = document.getElementById('dynamic-weather-icon') || document.getElementById('main-weather-icon');
  if (target) {
    target.textContent = emoji;
  }
  return emoji;
}

/**
 * Atmospheric Sentiment Analysis:
 * Trigger secondary fetch() to /api/mood?city=... immediately after main weather data resolves.
 * Passes the returned score into updateMetricWithFlip('mood-score', data.score + '%').
 * Updates textContent of #mood-emoji.
 * Dynamically removes existing .mood-* classes from widget container and applies new one.
 */
async function fetchCityMood(city, condition = '') {
  if (!city) return;
  const cityName = city.split(',')[0].trim();
  const widget = document.getElementById('cityMoodWidget') || document.querySelector('.city-mood-widget');
  const moodEmoji = document.getElementById('mood-emoji');

  try {
    let url = `${API_BASE_URL}/api/mood?city=${encodeURIComponent(cityName)}`;
    if (condition) {
      url += `&weather_condition=${encodeURIComponent(condition)}`;
    }
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    // Pass returned score into updateMetricWithFlip('mood-score', data.score + '%')
    if (data.score != null) {
      updateMetricWithFlip('mood-score', data.score + '%');
    }

    // Update textContent of #mood-emoji
    if (moodEmoji && data.emoji) {
      moodEmoji.textContent = data.emoji;
    }

    // Dynamically remove existing .mood-* classes from widget container and apply new one
    if (widget && data.sentiment) {
      widget.classList.remove('mood-positive', 'mood-neutral', 'mood-negative');
      widget.classList.add(`mood-${data.sentiment.toLowerCase()}`);
    }
  } catch (err) {
    console.warn('Atmospheric sentiment fetch error:', err.message);
  }
}

/**
 * Maps a weather condition string (e.g. "Clear sky", "Partly cloudy", "Rain", "Thunderstorm", "Snow", "Foggy")
 * or WMO weather code to an appropriate visual icon (SVG or emoji).
 * @param {string} condition - Weather condition description string
 * @param {number|null} [code] - Optional WMO weather code fallback
 * @returns {string} Visual icon markup (SVG element with aria/emoji support)
 */
function mapConditionToVisualIcon(condition, code = null) {
  const cond = String(condition || '').trim().toLowerCase();
  let symbolId = 'i-wx-cloud';
  let emoji = '⛅';

  if (cond.includes('thunder') || cond.includes('storm') || cond.includes('lightning') || cond.includes('squall')) {
    symbolId = 'i-wx-storm';
    emoji = '⛈️';
  } else if (cond.includes('snow') || cond.includes('blizzard') || cond.includes('ice') || cond.includes('sleet') || cond.includes('hail') || cond.includes('flurr')) {
    symbolId = 'i-wx-snow';
    emoji = '❄️';
  } else if (cond.includes('rain') || cond.includes('drizzle') || cond.includes('shower') || cond.includes('precip')) {
    symbolId = 'i-wx-rain';
    emoji = '🌧️';
  } else if (cond.includes('clear') || cond.includes('sunny') || cond.includes('fair')) {
    symbolId = 'i-wx-sun';
    emoji = '☀️';
  } else if (cond.includes('partly') || cond.includes('scattered') || cond.includes('few clouds') || cond.includes('broken')) {
    symbolId = 'i-wx-partly-cloudy';
    emoji = '⛅';
  } else if (cond.includes('fog') || cond.includes('mist') || cond.includes('haze') || cond.includes('smoke')) {
    symbolId = 'i-wx-cloud';
    emoji = '🌫️';
  } else if (cond.includes('wind') || cond.includes('breeze') || cond.includes('gale') || cond.includes('gust')) {
    symbolId = 'i-wx-wind';
    emoji = '💨';
  } else if (cond.includes('overcast') || cond.includes('cloud')) {
    symbolId = 'i-wx-cloud';
    emoji = '☁️';
  } else if (code != null) {
    symbolId = getWeatherIconSymbol(code);
    if (symbolId === 'i-wx-sun') emoji = '☀️';
    else if (symbolId === 'i-wx-partly-cloudy') emoji = '⛅';
    else if (symbolId === 'i-wx-rain') emoji = '🌧️';
    else if (symbolId === 'i-wx-snow') emoji = '❄️';
    else if (symbolId === 'i-wx-storm') emoji = '⛈️';
    else if (symbolId === 'i-wx-wind') emoji = '💨';
    else emoji = '☁️';
  }

  return `<svg class="hero-big-svg" id="heroConditionSvg" aria-label="${emoji} ${condition || 'Weather'}" data-emoji="${emoji}"><use href="#${symbolId}"/></svg>`;
}

function updateMainWeatherIcon(condition, code = null) {
  const container = document.getElementById('main-weather-icon');
  if (!container) return;
  const iconMarkup = mapConditionToVisualIcon(condition, code);
  container.innerHTML = iconMarkup;
}

let lastPressureHpa = null;
let lastSurfacePressure = null;
let lastHourlyWeather = null;

function updatePressureMeter(pressureHpa, hourly = null, surfacePressure = null) {
  if (pressureHpa == null) return;
  const p = Number(pressureHpa);
  lastPressureHpa = p;
  lastSurfacePressure = surfacePressure != null ? Number(surfacePressure) : null;
  if (hourly) lastHourlyWeather = hourly;

  if (DOM.valPressure) DOM.valPressure.textContent = p.toFixed(1);
  if (DOM.pressureScaleMarker) {
    // 980 to 1040 hPa range (span 60)
    const pct = Math.max(0, Math.min(100, ((p - 980) / 60) * 100));
    DOM.pressureScaleMarker.style.left = `${pct}%`;
  }

  let badgeText = 'Normal Atmospheric';
  if (p < 1000) badgeText = 'Low Pressure (Depression)';
  else if (p > 1022) badgeText = 'High Pressure (Clear)';
  if (DOM.valPressureBadge) DOM.valPressureBadge.textContent = badgeText;

  // Calculate 3-hour tendency
  let tendencyLabel = 'Steady (±0.0 hPa/3h)';
  let diff = 0;
  if (hourly && Array.isArray(hourly.pressure_msl) && hourly.pressure_msl.length >= 4) {
    const p0 = Number(hourly.pressure_msl[0]);
    const p3 = Number(hourly.pressure_msl[3]);
    diff = p3 - p0;
    const sign = diff >= 0 ? '+' : '';
    if (Math.abs(diff) <= 0.4) {
      tendencyLabel = `Steady (${sign}${diff.toFixed(1)} hPa/3h)`;
    } else if (diff > 0.4) {
      tendencyLabel = `Rising (${sign}${diff.toFixed(1)} hPa/3h)`;
    } else {
      tendencyLabel = `Falling (${sign}${diff.toFixed(1)} hPa/3h)`;
    }
  }
  if (DOM.valPressureTendency) DOM.valPressureTendency.textContent = tendencyLabel;

  // Render 24H Mini Pressure Sparkline
  if (DOM.pressureSparklinePath) {
    const pArr = (hourly && Array.isArray(hourly.pressure_msl) && hourly.pressure_msl.length >= 12)
      ? hourly.pressure_msl.slice(0, 24).map(v => Number(v) || p)
      : Array.from({ length: 24 }, (_, i) => p + Math.sin(i / 3.8) * 1.8);

    const pMin = Math.min(...pArr);
    const pMax = Math.max(...pArr);
    const span = Math.max(1.5, pMax - pMin);

    if (DOM.pressureRangeLabel) {
      DOM.pressureRangeLabel.textContent = `${pMin.toFixed(1)} - ${pMax.toFixed(1)} hPa`;
    }

    const points = pArr.map((val, idx) => {
      const x = (idx / 23) * 400;
      const y = 38 - ((val - pMin) / span) * 30; // 45px height
      return { x, y };
    });

    let pathD = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const mx = (p0.x + p1.x) / 2;
      pathD += ` C ${mx.toFixed(1)},${p0.y.toFixed(1)} ${mx.toFixed(1)},${p1.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
    }
    DOM.pressureSparklinePath.setAttribute('d', pathD);
  }
}

function updateRadialGauges(current, daily, windDirLabel) {
  if (!current) return;
  
  // 1. Wind Speed & Compass
  const speed = current.wind_speed_10m ?? current.windKmh ?? 0;
  const deg = current.wind_direction_10m ?? 0;
  if (DOM.valWind) DOM.valWind.textContent = Number(speed).toFixed(1);
  if (DOM.valWindDirBadge) DOM.valWindDirBadge.textContent = windDirLabel || getWindDir(deg);
  if (DOM.valWindSub) DOM.valWindSub.textContent = `Heading: ${deg}° ${windDirLabel || getWindDir(deg)}`;
  if (DOM.gaugeWindNeedle) {
    DOM.gaugeWindNeedle.setAttribute('transform', `rotate(${deg})`);
  }

  // 2. Feels Like
  const feels = current.apparent_temperature ?? current.feelsLikeC ?? current.temperature_2m ?? current.tempC ?? 0;
  const actual = current.temperature_2m ?? current.tempC ?? 0;
  if (DOM.valFeelsLike) DOM.valFeelsLike.textContent = `${Math.round(feels)}°`;
  if (DOM.valTempSub) DOM.valTempSub.textContent = `Actual ${Number(actual).toFixed(1)}°C`;
  if (DOM.ringFeelsLike) {
    // Circumference = 2 * PI * 38 = 238.7
    // Map -10°C to 50°C (60° range)
    const pct = Math.max(0, Math.min(1, (feels + 10) / 60));
    const offset = 238.7 * (1 - pct);
    DOM.ringFeelsLike.style.strokeDashoffset = String(offset);
  }

  // 3. Visibility
  const visMeters = current.visibility ?? 10000;
  const visKm = visMeters >= 1000 ? (visMeters / 1000).toFixed(1) : (visMeters / 1000).toFixed(2);
  if (DOM.valVisibility) DOM.valVisibility.textContent = `${visKm} km`;
  if (DOM.valVisibilityStatus) {
    if (visMeters >= 9000) DOM.valVisibilityStatus.textContent = 'Clear Horizon';
    else if (visMeters >= 4000) DOM.valVisibilityStatus.textContent = 'Hazy / Mist';
    else DOM.valVisibilityStatus.textContent = 'Low Sight (Fog)';
  }
  if (DOM.valVisibilityDesc) {
    if (visMeters >= 9000) DOM.valVisibilityDesc.textContent = 'Surface Clear';
    else if (visMeters >= 5000) DOM.valVisibilityDesc.textContent = 'Moderate Sight';
    else if (visMeters >= 2000) DOM.valVisibilityDesc.textContent = 'Hazy / Light Mist';
    else DOM.valVisibilityDesc.textContent = 'Dense Fog';
  }
  if (DOM.valVisibilitySub) {
    DOM.valVisibilitySub.textContent = `Optical Sight: ${(visMeters).toLocaleString()} m`;
  }
  if (DOM.ringVisibility) {
    const pct = Math.max(0, Math.min(1, visMeters / 10000));
    DOM.ringVisibility.style.strokeDashoffset = String(238.7 * (1 - pct));
  }

  // 4. Precipitation
  const rain = current.precipitation ?? current.rainNowMm ?? 0;
  const hum = current.relative_humidity_2m ?? current.humidityPct ?? 0;
  if (DOM.valRain) DOM.valRain.textContent = Number(rain).toFixed(1);
  if (DOM.valHumidity) DOM.valHumidity.textContent = `${Math.round(hum)}% Humidity`;
  if (DOM.valRainDesc) {
    DOM.valRainDesc.textContent = rain > 0 ? `${Number(rain).toFixed(1)} mm/h` : '0.0 mm/h';
  }
  if (DOM.valRainSub) {
    DOM.valRainSub.textContent = rain > 0 ? 'Active Fall Rate' : 'No Active Fall';
  }
  if (DOM.ringPrecip) {
    const pct = Math.max(0, Math.min(1, rain / 25));
    DOM.ringPrecip.style.strokeDashoffset = String(238.7 * (1 - pct));
  }
}

function updateAqiCard(aqiData) {
  if (!aqiData) return;
  const aqi = aqiData.us_aqi ?? aqiData.aqi ?? 30;
  if (DOM.valAqi) DOM.valAqi.textContent = aqi;

  let levelText = 'Good';
  let levelClass = 'level-good';
  let note = 'Air quality is satisfactory and poses little or no risk.';
  let ringColor = '#48CA9B';

  if (aqi > 150) {
    levelText = 'Unhealthy'; levelClass = 'level-unhealthy';
    note = 'Everyone may begin to experience health effects; limit prolonged outdoor exertion.';
    ringColor = '#F26464';
  } else if (aqi > 50) {
    levelText = 'Moderate'; levelClass = 'level-moderate';
    note = 'Air quality is acceptable; sensitive groups should consider reducing heavy outdoor exertion.';
    ringColor = '#F6AE2D';
  }

  if (DOM.valAqiStatus) {
    DOM.valAqiStatus.textContent = levelText;
    DOM.valAqiStatus.className = `aqi-level-badge ${levelClass}`;
  }
  if (DOM.valAqiSub) DOM.valAqiSub.textContent = note;
  if (DOM.ringAqiScore) {
    // 2 * PI * 32 = 201
    const pct = Math.max(0, Math.min(1, aqi / 300));
    DOM.ringAqiScore.style.strokeDashoffset = String(201 * (1 - pct));
    DOM.ringAqiScore.style.stroke = ringColor;
  }

  // Pollutants
  if (DOM.polPM25 && aqiData.pm2_5 != null) DOM.polPM25.textContent = `${Number(aqiData.pm2_5).toFixed(1)} µg/m³`;
  if (DOM.polPM10 && aqiData.pm10 != null)  DOM.polPM10.textContent = `${Number(aqiData.pm10).toFixed(1)} µg/m³`;
  if (DOM.polSO2 && aqiData.so2 != null)    DOM.polSO2.textContent = `${Number(aqiData.so2).toFixed(1)} µg/m³`;
  if (DOM.polNO2 && (aqiData.nitrogen_dioxide != null || aqiData.no2 != null)) {
    DOM.polNO2.textContent = `${Number(aqiData.nitrogen_dioxide ?? aqiData.no2).toFixed(1)} µg/m³`;
  }
  if (DOM.polO3 && aqiData.ozone != null)   DOM.polO3.textContent = `${Number(aqiData.ozone).toFixed(1)} µg/m³`;
  if (DOM.polCO && (aqiData.carbon_monoxide != null || aqiData.co != null)) {
    DOM.polCO.textContent = `${Math.round(aqiData.carbon_monoxide ?? aqiData.co)} µg/m³`;
  }
}

let currentRainPoints = [];
let rainDisplayMode = "mm";

function formatTime(isoStr) {
  if (!isoStr) return '--:--';
  if (typeof isoStr === 'string' && isoStr.includes('T')) {
    return isoStr.split('T')[1].slice(0, 5);
  }
  return String(isoStr).slice(0, 5);
}

function updateRainfallWaveChart(hourly, mode = null) {
  if (mode) rainDisplayMode = mode;
  if (hourly) lastHourlyWeather = hourly;
  const h = hourly || lastHourlyWeather;
  if (!h) return;

  const precips = (h.precipitation || []).slice(0, 24).map(v => Number(v) || 0);
  const probs = (h.precipitation_probability || []).slice(0, 24).map(v => Number(v) || 0);
  while (precips.length < 24) precips.push(0);
  while (probs.length < 24) probs.push(0);

  const total = precips.reduce((a, b) => a + b, 0);
  if (DOM.valRainAccumBadge) {
    DOM.valRainAccumBadge.textContent = `${total.toFixed(1)} mm / 24h`;
  }

  const isProb = rainDisplayMode === 'prob';
  const values = isProb ? probs : precips;
  const maxVal = isProb ? 100 : Math.max(2.0, ...values);

  currentRainPoints = values.map((val, idx) => {
    const x = (idx / 23) * 400;
    // 130px height: y goes from 25 to 110
    const y = 110 - (val / maxVal) * 85;
    return {
      x, y,
      precip: precips[idx],
      prob: probs[idx],
      hour: idx,
      time: h.time?.[idx] ? formatTime(h.time[idx]) : `${String(idx).padStart(2, '0')}:00`
    };
  });

  // Construct smooth cubic Bézier SVG path across ALL 24 hours
  let pathD = `M ${currentRainPoints[0].x.toFixed(1)},${currentRainPoints[0].y.toFixed(1)}`;
  for (let i = 0; i < currentRainPoints.length - 1; i++) {
    const p0 = currentRainPoints[i];
    const p1 = currentRainPoints[i + 1];
    const mx = (p0.x + p1.x) / 2;
    pathD += ` C ${mx.toFixed(1)},${p0.y.toFixed(1)} ${mx.toFixed(1)},${p1.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
  }

  if (DOM.rainWaveLine) DOM.rainWaveLine.setAttribute('d', pathD);
  if (DOM.rainWaveArea) {
    DOM.rainWaveArea.setAttribute('d', `${pathD} L 400,125 L 0,125 Z`);
  }

  // Position default scrubber at peak rain hour or hour 12
  const peakIdx = values.reduce((maxI, v, i, arr) => v > arr[maxI] ? i : maxI, 0);
  const defPt = currentRainPoints[peakIdx] || currentRainPoints[0];
  if (DOM.rainScrubberPoint && defPt) {
    DOM.rainScrubberPoint.setAttribute('cx', defPt.x.toFixed(1));
    DOM.rainScrubberPoint.setAttribute('cy', defPt.y.toFixed(1));
  }
}

function handleRainChartScrub(e) {
  if (!DOM.rainfallChartBox || currentRainPoints.length < 24) return;
  const rect = DOM.rainfallChartBox.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const frac = relX / rect.width;
  const idx = Math.max(0, Math.min(23, Math.round(frac * 23)));
  const pt = currentRainPoints[idx];
  if (!pt) return;

  if (DOM.rainScrubberLine) {
    DOM.rainScrubberLine.style.display = 'block';
    DOM.rainScrubberLine.setAttribute('x1', pt.x.toFixed(1));
    DOM.rainScrubberLine.setAttribute('x2', pt.x.toFixed(1));
  }
  if (DOM.rainScrubberPoint) {
    DOM.rainScrubberPoint.setAttribute('cx', pt.x.toFixed(1));
    DOM.rainScrubberPoint.setAttribute('cy', pt.y.toFixed(1));
  }
  if (DOM.rainChartTooltip) {
    DOM.rainChartTooltip.style.display = 'block';
    DOM.rainChartTooltip.style.left = `${(pt.x / 400) * rect.width}px`;
    DOM.rainChartTooltip.style.top = `${(pt.y / 130) * rect.height}px`;
    if (DOM.tooltipTime) DOM.tooltipTime.textContent = pt.time;
    if (DOM.tooltipVal) DOM.tooltipVal.textContent = `${pt.precip.toFixed(1)} mm · ${pt.prob}% chance`;
  }
}

function hideRainChartScrub() {
  if (DOM.rainScrubberLine) DOM.rainScrubberLine.style.display = 'none';
  if (DOM.rainChartTooltip) DOM.rainChartTooltip.style.display = 'none';
}


// ============================================================================
// 11B. DETAIL INSPECTION MODALS: PRESSURE & PRECIPITATION
// ============================================================================
function openPressureDetailsModal() {
  if (!DOM.modalPressureDetails) return;
  const p = lastPressureHpa || 1012.0;
  const surf = lastSurfacePressure || (p - 1.2);
  const h = lastHourlyWeather;

  if (DOM.detailMslPressure) DOM.detailMslPressure.textContent = `${p.toFixed(1)} hPa`;
  if (DOM.detailSurfacePressure) DOM.detailSurfacePressure.textContent = `${surf.toFixed(1)} hPa`;

  let diff = 0;
  let tendencyLabel = 'Steady';
  if (h && Array.isArray(h.pressure_msl) && h.pressure_msl.length >= 4) {
    diff = Number(h.pressure_msl[3]) - Number(h.pressure_msl[0]);
    if (Math.abs(diff) <= 0.4) tendencyLabel = 'Steady';
    else if (diff > 0.4) tendencyLabel = 'Rising';
    else tendencyLabel = 'Falling';
  }
  const sign = diff >= 0 ? '+' : '';
  if (DOM.detailPressureTendency) DOM.detailPressureTendency.textContent = `${sign}${diff.toFixed(1)} hPa / 3h`;
  if (DOM.detailTendencyBadge) DOM.detailTendencyBadge.textContent = `${tendencyLabel} Trend`;

  if (DOM.detailRegimeText) {
    if (p < 1000) DOM.detailRegimeText.textContent = 'Cyclonic Depression (Low)';
    else if (p > 1022) DOM.detailRegimeText.textContent = 'Anticyclonic High';
    else DOM.detailRegimeText.textContent = 'Standard Barometric Field';
  }

  // Render 24-Hour detailed pressure SVG in modal
  if (DOM.detailPressureLine && DOM.detailPressureArea) {
    const pArr = (h && Array.isArray(h.pressure_msl) && h.pressure_msl.length >= 12)
      ? h.pressure_msl.slice(0, 24).map(v => Number(v) || p)
      : Array.from({ length: 24 }, (_, i) => p + Math.sin(i / 3.8) * 2.2);

    const pMin = Math.min(...pArr);
    const pMax = Math.max(...pArr);
    const span = Math.max(1.5, pMax - pMin);

    const points = pArr.map((val, idx) => {
      const x = (idx / 23) * 600;
      const y = 140 - ((val - pMin) / span) * 110;
      return { x, y, val };
    });

    let pathD = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const mx = (p0.x + p1.x) / 2;
      pathD += ` C ${mx.toFixed(1)},${p0.y.toFixed(1)} ${mx.toFixed(1)},${p1.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
    }
    DOM.detailPressureLine.setAttribute('d', pathD);
    DOM.detailPressureArea.setAttribute('d', `${pathD} L 600,155 L 0,155 Z`);

    // Add dots
    if (DOM.detailPressureDots) {
      while (DOM.detailPressureDots.firstChild) DOM.detailPressureDots.removeChild(DOM.detailPressureDots.firstChild);
      points.filter((_, i) => i % 3 === 0).forEach(pt => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', pt.x.toFixed(1));
        c.setAttribute('cy', pt.y.toFixed(1));
        c.setAttribute('r', '4');
        c.setAttribute('fill', '#FFFFFF');
        c.setAttribute('stroke', '#5BC0EB');
        c.setAttribute('stroke-width', '2');
        DOM.detailPressureDots.appendChild(c);
      });
    }
  }

  DOM.modalPressureDetails.style.display = 'flex';
  DOM.modalPressureDetails.classList.add('active');
}

function closePressureDetailsModal() {
  if (!DOM.modalPressureDetails) return;
  DOM.modalPressureDetails.style.display = 'none';
  DOM.modalPressureDetails.classList.remove('active');
}

function openPrecipDetailsModal() {
  if (!DOM.modalPrecipDetails) return;
  const h = lastHourlyWeather;
  const precips = (h?.precipitation || []).slice(0, 24).map(v => Number(v) || 0);
  const probs = (h?.precipitation_probability || []).slice(0, 24).map(v => Number(v) || 0);
  while (precips.length < 24) precips.push(0);
  while (probs.length < 24) probs.push(0);

  const total = precips.reduce((a, b) => a + b, 0);
  const maxProb = Math.max(0, ...probs);
  let peakIdx = 0;
  let maxRate = 0;
  precips.forEach((r, i) => {
    if (r > maxRate) { maxRate = r; peakIdx = i; }
  });

  if (DOM.detailTotalRain) DOM.detailTotalRain.textContent = `${total.toFixed(1)} mm`;
  if (DOM.detailRainCategory) {
    if (total > 50) DOM.detailRainCategory.textContent = 'Torrential / Flood Risk';
    else if (total > 20) DOM.detailRainCategory.textContent = 'Heavy Rainfall Window';
    else if (total > 5) DOM.detailRainCategory.textContent = 'Moderate Showers';
    else if (total > 0) DOM.detailRainCategory.textContent = 'Light Trace / Drizzle';
    else DOM.detailRainCategory.textContent = 'Completely Dry';
  }

  if (DOM.detailPeakWindow) {
    const peakTime = h?.time?.[peakIdx] ? formatTime(h.time[peakIdx]) : `${String(peakIdx).padStart(2, '0')}:00`;
    DOM.detailPeakWindow.textContent = total > 0 ? `Around ${peakTime}` : 'None expected';
  }
  if (DOM.detailPeakAmount) DOM.detailPeakAmount.textContent = `Max: ${maxRate.toFixed(1)} mm/h`;
  if (DOM.detailMaxProb) DOM.detailMaxProb.textContent = `${maxProb}%`;

  // Render 24-hour table rows
  if (DOM.detailPrecipTableBody) {
    while (DOM.detailPrecipTableBody.firstChild) DOM.detailPrecipTableBody.removeChild(DOM.detailPrecipTableBody.firstChild);
    for (let i = 0; i < 24; i++) {
      const timeStr = h?.time?.[i] ? formatTime(h.time[i]) : `${String(i).padStart(2, '0')}:00`;
      const mm = precips[i];
      const pr = probs[i];
      let intensity = 'None';
      if (mm > 15) intensity = 'Severe / Torrential';
      else if (mm > 5) intensity = 'Heavy';
      else if (mm > 1.5) intensity = 'Moderate';
      else if (mm > 0.1) intensity = 'Light / Drizzle';

      let condText = 'Clear';
      if (mm > 5) condText = 'Heavy Rain';
      else if (mm > 0.5) condText = 'Rain Showers';
      else if (pr > 50) condText = 'Overcast / Probable';
      else if (pr > 20) condText = 'Scattered Clouds';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:var(--font-mono);font-weight:600;">${timeStr}</td>
        <td>${condText}</td>
        <td style="font-family:var(--font-mono);color:${mm > 0 ? 'var(--accent-cyan)' : 'var(--text-faint)'};">${mm.toFixed(1)} mm</td>
        <td style="font-family:var(--font-mono);color:${pr > 40 ? 'var(--accent-amber)' : 'var(--text-soft)'};">${pr}%</td>
        <td><span style="font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(255,255,255,0.05);">${intensity}</span></td>
      `;
      DOM.detailPrecipTableBody.appendChild(tr);
    }
  }

  DOM.modalPrecipDetails.style.display = 'flex';
  DOM.modalPrecipDetails.classList.add('active');
}

function closePrecipDetailsModal() {
  if (!DOM.modalPrecipDetails) return;
  DOM.modalPrecipDetails.style.display = 'none';
  DOM.modalPrecipDetails.classList.remove('active');
}

function updateHourlyTimeline(hourly) {
  if (!DOM.hourlyScrollTrack || !hourly || !hourly.time) return;
  while (DOM.hourlyScrollTrack.firstChild) DOM.hourlyScrollTrack.removeChild(DOM.hourlyScrollTrack.firstChild);

  const times = hourly.time.slice(0, 16);
  const temps = hourly.temperature_2m || [];
  const rains = hourly.precipitation_probability || hourly.precipitation || [];
  const codes = hourly.weather_code || [];
  const winds = hourly.wind_speed_10m || [];

  times.forEach((t, i) => {
    const timeStr = i === 0 ? 'Now' : t.split('T')[1]?.slice(0, 5) || t;
    const tempVal = temps[i] != null ? `${Math.round(temps[i])}°` : '--°';
    const rainVal = rains[i] != null ? `${Math.round(rains[i])}%` : '0%';
    const windVal = winds[i] != null ? `${Math.round(winds[i])} km/h` : '';
    const iconId = getWeatherIconSymbol(codes[i]);

    const slot = el('div', { className: 'hourly-slot' }, [
      el('span', { className: 'slot-time', text: timeStr }),
      iconSvg(iconId, 'slot-icon'),
      el('span', { className: 'slot-rain', text: rainVal }),
      el('span', { className: 'slot-temp', text: tempVal }),
      el('span', { className: 'slot-wind', text: windVal })
    ]);
    DOM.hourlyScrollTrack.appendChild(slot);
  });
}

// Simulated Interactive Doppler Radar
let radarAnimationId = null;
let radarAngle = 0;
let radarLayer = 'precip';

function initRadarCanvas() {
  const canvas = DOM.radarCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  // Layer toggles
  document.querySelectorAll('.radar-layer-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.radar-layer-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      radarLayer = btn.dataset.layer || 'precip';
      if (state.radarPaused) {
        renderRadar();
      }
    };
  });

  // Responsive canvas resolution matching CSS viewport
  function syncCanvasSize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = Math.round(rect.width) || 700;
    const h = Math.round(rect.height) || 340;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  syncCanvasSize();
  window.addEventListener('resize', syncCanvasSize);

  // Animated flow particles for wind vectors
  const windParticles = [];
  for (let i = 0; i < 60; i++) {
    windParticles.push({
      x: Math.random() * 800,
      y: Math.random() * 400,
      len: 14 + Math.random() * 18,
      speed: 1.0 + Math.random() * 2.2,
      alpha: 0.35 + Math.random() * 0.55
    });
  }

  let lastTelemetryText = '';
  function updateLiveTelemetryHud(text, icon = '📡', borderColor = 'rgba(91, 192, 235, 0.35)') {
    if (DOM.radarLiveInfo && lastTelemetryText !== text) {
      DOM.radarLiveInfo.textContent = text;
      lastTelemetryText = text;
      if (DOM.radarTelemetryIcon) DOM.radarTelemetryIcon.textContent = icon;
      if (DOM.radarTelemetryBadge) DOM.radarTelemetryBadge.style.borderColor = borderColor;
    }
  }

  function renderRadar() {
    syncCanvasSize();
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    // Expanded radius for larger, clearer atmospheric simulation
    const maxR = Math.max(40, Math.min(cx, cy) - 24);

    // Synchronize coordinates in HUD
    if (DOM.radarCoord && state.latestWeatherData) {
      const lat = state.latestWeatherData.latitude || (state.currentStation ? state.currentStation.lat : 11.68);
      const lon = state.latestWeatherData.longitude || (state.currentStation ? state.currentStation.lon : 76.13);
      const latStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
      const lonStr = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
      DOM.radarCoord.textContent = `${latStr}, ${lonStr}`;
    }

    // 1. Concentric Range Rings (25km, 50km, 75km, 100km)
    [0.25, 0.5, 0.75, 1.0].forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2);
      ctx.strokeStyle = frac === 1.0 ? 'rgba(91, 192, 235, 0.32)' : 'rgba(91, 192, 235, 0.18)';
      ctx.lineWidth = frac === 1.0 ? 1.4 : 1.0;
      ctx.stroke();

      // Range text
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(91, 192, 235, 0.8)';
      ctx.textAlign = 'left';
      ctx.fillText(`${(frac * 100).toFixed(0)}km`, cx + 6, cy - maxR * frac + 11);
    });

    // 2. Crosshairs & Cardinal Direction Indicators
    ctx.beginPath();
    ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
    ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
    ctx.strokeStyle = 'rgba(91, 192, 235, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#5BC0EB';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - maxR + 14);
    ctx.fillText('S', cx, cy + maxR - 5);
    ctx.fillText('E', cx + maxR - 12, cy + 4);
    ctx.fillText('W', cx - maxR + 12, cy + 4);

    // Center Station Mark
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#5BC0EB';
    ctx.fill();

    // Live Atmospheric Observations Grounding
    const curRain = state.latestWeatherData?.current?.precipitation ?? 0;
    const hourlyPrecip = state.latestWeatherData?.hourly_weather?.precipitation || state.latestWeatherData?.hourly?.precipitation || [];
    const maxRain24h = hourlyPrecip.length ? Math.max(...hourlyPrecip) : 0;
    const windSpeed = state.latestWeatherData?.current?.wind_speed_10m ?? 12;
    const windDeg = state.latestWeatherData?.current?.wind_direction_10m ?? 240;
    const tempC = state.latestWeatherData?.current?.temperature_2m ?? 24;

    ctx.save();
    if (radarLayer === 'precip') {
      if (curRain > 0 || maxRain24h > 0) {
        // Render convective rain echoes
        const rainIntensity = Math.min(1.0, Math.max(0.25, curRain / 12 + maxRain24h / 25));
        const radRad = (windDeg - 90) * Math.PI / 180;
        const offsetDist = maxR * 0.35;
        const cellX = cx + Math.cos(radRad) * offsetDist;
        const cellY = cy + Math.sin(radRad) * offsetDist;

        // Outer Reflectivity (20-30 dBZ)
        const outerGrad = ctx.createRadialGradient(cellX, cellY, 4, cellX, cellY, 80 * rainIntensity);
        outerGrad.addColorStop(0, 'rgba(72, 202, 155, 0.7)');
        outerGrad.addColorStop(0.5, 'rgba(62, 146, 204, 0.45)');
        outerGrad.addColorStop(1, 'rgba(14, 28, 44, 0)');
        ctx.fillStyle = outerGrad;
        ctx.beginPath();
        ctx.arc(cellX, cellY, 80 * rainIntensity, 0, Math.PI * 2);
        ctx.fill();

        // Convective Core (35-55 dBZ)
        if (curRain > 1.0 || maxRain24h > 3.0) {
          const coreGrad = ctx.createRadialGradient(cellX + 4, cellY - 4, 2, cellX + 4, cellY - 4, 40 * rainIntensity);
          coreGrad.addColorStop(0, 'rgba(242, 100, 100, 0.88)');
          coreGrad.addColorStop(0.5, 'rgba(246, 174, 45, 0.75)');
          coreGrad.addColorStop(1, 'rgba(72, 202, 155, 0)');
          ctx.fillStyle = coreGrad;
          ctx.beginPath();
          ctx.arc(cellX + 4, cellY - 4, 40 * rainIntensity, 0, Math.PI * 2);
          ctx.fill();
        }

        const dbzVal = Math.round(18 + Math.min(45, curRain * 8 + maxRain24h * 2));
        updateLiveTelemetryHud(`Active Echo: ${dbzVal} dBZ · ${curRain.toFixed(1)} mm/h`, '🌧️', 'rgba(72, 202, 155, 0.55)');
      } else {
        // Zero Reflectivity: Clear Airmass Pulse Wave
        const pulseR = ((Date.now() / 25) % maxR);
        ctx.beginPath();
        ctx.arc(cx, cy, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(91, 192, 235, ${Math.max(0, (1 - pulseR / maxR) * 0.35)})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        updateLiveTelemetryHud('Clear Atmosphere · 0 dBZ Echo', '☀️', 'rgba(91, 192, 235, 0.35)');
      }
    } else if (radarLayer === 'wind') {
      // Wind streamline vector field
      const windAngleRad = (windDeg - 90) * Math.PI / 180;
      const vx = Math.cos(windAngleRad);
      const vy = Math.sin(windAngleRad);
      const speedMult = Math.min(3.5, Math.max(0.7, windSpeed / 8));

      ctx.lineWidth = 1.8;
      windParticles.forEach(p => {
        p.x += vx * p.speed * speedMult;
        p.y += vy * p.speed * speedMult;

        if (p.x < 10) p.x = w - 10;
        if (p.x > w - 10) p.x = 10;
        if (p.y < 10) p.y = h - 10;
        if (p.y > h - 10) p.y = 10;

        ctx.strokeStyle = `rgba(91, 192, 235, ${p.alpha})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - vx * p.len, p.y - vy * p.len);
        ctx.stroke();
      });

      updateLiveTelemetryHud(`Vector Streamflow: ${windDeg}° @ ${Number(windSpeed).toFixed(1)} km/h`, '💨', 'rgba(91, 192, 235, 0.55)');
    } else {
      // Thermal Gradient layer
      const thermalGrad = ctx.createRadialGradient(cx, cy, 12, cx, cy, maxR);
      if (tempC > 28) {
        thermalGrad.addColorStop(0, 'rgba(242, 100, 100, 0.45)');
        thermalGrad.addColorStop(0.6, 'rgba(246, 174, 45, 0.25)');
      } else if (tempC > 18) {
        thermalGrad.addColorStop(0, 'rgba(246, 174, 45, 0.35)');
        thermalGrad.addColorStop(0.6, 'rgba(72, 202, 155, 0.2)');
      } else {
        thermalGrad.addColorStop(0, 'rgba(62, 146, 204, 0.4)');
        thermalGrad.addColorStop(0.6, 'rgba(91, 192, 235, 0.18)');
      }
      thermalGrad.addColorStop(1, 'rgba(14, 28, 44, 0)');
      ctx.fillStyle = thermalGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.fill();

      [0.35, 0.7].forEach(frac => {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(246, 174, 45, 0.35)';
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      updateLiveTelemetryHud(`Surface Thermal: ${Number(tempC).toFixed(1)}°C Isotherm`, '🌡️', 'rgba(246, 174, 45, 0.55)');
    }
    ctx.restore();

    // 3. Prominent Rotating Sweep Beam with Cyan Phosphor Trailing Glow
    if (!state.radarPaused) {
      radarAngle = (radarAngle + 0.02 * (state.radarSpeed || 1.0)) % (Math.PI * 2);
    }
    ctx.save();
    ctx.translate(cx, cy);

    // Trailing Sector
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, maxR, radarAngle - 0.4, radarAngle);
    ctx.closePath();
    ctx.fillStyle = 'rgba(91, 192, 235, 0.16)';
    ctx.fill();

    // Bright Leading Sweep Ray
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(radarAngle) * maxR, Math.sin(radarAngle) * maxR);
    ctx.strokeStyle = 'rgba(220, 245, 255, 0.95)';
    ctx.lineWidth = 2.0;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#5BC0EB';
    ctx.stroke();
    ctx.restore();

    if (!state.radarPaused) {
      radarAnimationId = requestAnimationFrame(renderRadar);
    }
  }

  // Play / Pause Button Handler
  if (DOM.btnToggleRadarPlay) {
    DOM.btnToggleRadarPlay.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.radarPaused = !state.radarPaused;
      DOM.btnToggleRadarPlay.textContent = state.radarPaused ? '▶ Play' : '⏸ Pause';
      DOM.btnToggleRadarPlay.title = state.radarPaused ? 'Resume Sweep Animation' : 'Pause Sweep Animation';
      if (!state.radarPaused) {
        if (radarAnimationId) cancelAnimationFrame(radarAnimationId);
        radarAnimationId = requestAnimationFrame(renderRadar);
      }
    };
  }

  // Speed Cycle Button Handler
  if (DOM.btnToggleRadarSpeed) {
    const speeds = [0.5, 1.0, 2.0];
    DOM.btnToggleRadarSpeed.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = (speeds.indexOf(state.radarSpeed) + 1) % speeds.length;
      state.radarSpeed = speeds[idx];
      DOM.btnToggleRadarSpeed.textContent = `${state.radarSpeed}x`;
      DOM.btnToggleRadarSpeed.title = `Radar Speed: ${state.radarSpeed}x`;
    };
  }

  if (radarAnimationId) cancelAnimationFrame(radarAnimationId);
  renderRadar();
}


// ============================================================================
// 10B. HERO WEATHER OVERVIEW CARD & TODAY'S CAROUSEL
// ============================================================================
function updateHeroWeatherOverview(data) {
  if (!data) return;
  const w = data.current || {};
  const h = data.hourly_weather || {};
  const cond = data.condition || getWeatherCondition(w.weather_code);
  const iconId = getWeatherIconSymbol(w.weather_code);

  if (DOM.heroLocationName) DOM.heroLocationName.textContent = data.location || (state.currentStation ? state.currentStation.name : 'Selected City');
  if (DOM.heroLargeTemp && w.temperature_2m != null) updateMetricWithFlip('heroLargeTemp', `${Math.round(w.temperature_2m)}°`);
  if (DOM.heroConditionText) DOM.heroConditionText.textContent = cond;
  if (DOM.heroFeelsText && w.apparent_temperature != null) updateMetricWithFlip('heroFeelsText', `Feels like ${Math.round(w.apparent_temperature)}°C`);
  if (DOM.heroStatHumidity && w.relative_humidity_2m != null) updateMetricWithFlip('heroStatHumidity', `${Math.round(w.relative_humidity_2m)}% Hum`);
  if (DOM.heroStatWind && w.wind_speed_10m != null) updateMetricWithFlip('heroStatWind', `${Math.round(w.wind_speed_10m)} km/h`);
  if (DOM.heroStatPressure && w.pressure_msl != null) updateMetricWithFlip('heroStatPressure', `${Math.round(w.pressure_msl)} hPa`);

  if (DOM.heroConditionSvg) {
    DOM.heroConditionSvg.innerHTML = `<use href="#${iconId}"/>`;
  }

  // Live update: map the fetched weather condition to an emoji (default to '🌡️' if not found) and set it as textContent of #dynamic-weather-icon
  updateDynamicWeatherIcon(cond);

  // Populate Hero Hourly Carousel (Next 12 slots)
  if (DOM.heroHourlyCarousel && h.time) {
    while (DOM.heroHourlyCarousel.firstChild) DOM.heroHourlyCarousel.removeChild(DOM.heroHourlyCarousel.firstChild);
    const times = h.time.slice(0, 12);
    const temps = h.temperature_2m || [];
    const rains = h.precipitation_probability || h.precipitation || [];
    const codes = h.weather_code || [];

    times.forEach((t, i) => {
      const timeStr = i === 0 ? 'Now' : t.split('T')[1]?.slice(0, 5) || t;
      const tempVal = temps[i] != null ? `${Math.round(temps[i])}°` : '--°';
      const rainVal = rains[i] != null ? `${Math.round(rains[i])}%` : '0%';
      const slotIcon = getWeatherIconSymbol(codes[i]);

      const card = el('div', { className: 'hero-slot-card' }, [
        el('span', { className: 'hero-slot-time', text: timeStr }),
        iconSvg(slotIcon, 'hero-slot-icon'),
        el('span', { className: 'hero-slot-temp', text: tempVal }),
        el('span', { className: 'hero-slot-rain', text: rainVal })
      ]);

      card.addEventListener('click', () => {
        if (DOM.inputPrompt) {
          const loc = data.location ? data.location.split(',')[0] : 'today';
          DOM.inputPrompt.value = `What will the weather be like at ${timeStr} in ${loc}?`;
          updateCharCount();
          handleSend();
        }
      });
      DOM.heroHourlyCarousel.appendChild(card);
    });
  }
}

async function refreshDashboardWeather(station) {
  try {
    const data = await fetchDashboardWeather(station);
    if (!data) return;
    const w = data.current || {};
    const d = data.daily_weather || {};
    const h = data.hourly_weather || {};

    // Standard DOM texts with slot-machine reel flip animation (isolated updates)
    if (w.temperature_2m    != null && DOM.valTemp)      updateMetricWithFlip('valTemp',      `${Math.round(w.temperature_2m)}°C`);
    if (w.apparent_temperature != null && DOM.valTempSub) updateMetricWithFlip('valTempSub',  `Actual ${Number(w.temperature_2m).toFixed(1)}°C`);
    if (w.relative_humidity_2m != null && DOM.valHumidity) updateMetricWithFlip('valHumidity', `${Math.round(w.relative_humidity_2m)}% Humidity`);
    if (w.pressure_msl       != null && DOM.valPressure) updateMetricWithFlip('valPressure',  `${Number(w.pressure_msl).toFixed(1)}`);
    if (w.wind_speed_10m     != null && DOM.valWind)     updateMetricWithFlip('valWind',      `${Number(w.wind_speed_10m).toFixed(1)}`);
    if (w.wind_direction_10m != null && DOM.valWindSub)  DOM.valWindSub.textContent   = `Heading: ${data.wind_direction_label || getWindDir(w.wind_direction_10m)}`;
    if (w.precipitation      != null && DOM.valRain)     updateMetricWithFlip('valRain',      `${Number(w.precipitation).toFixed(1)}`);

    // Modern Glassmorphism Widgets Update
    const cond = data.condition || getWeatherCondition(w.weather_code);
    const tMin = d.temperature_2m_min?.[0] ?? (w.temperature_2m != null ? w.temperature_2m - 2 : 20);
    const tMax = d.temperature_2m_max?.[0] ?? (w.temperature_2m != null ? w.temperature_2m + 2 : 25);
    updateHeroConditionPill(cond, w.temperature_2m, tMin, tMax, w.weather_code);
    updateDynamicWeatherIcon(cond);
    updatePressureMeter(w.pressure_msl, h, w.surface_pressure);
    updateRadialGauges(w, d, data.wind_direction_label);
    if (data.air_quality) updateAqiCard(data.air_quality);
    updateRainfallWaveChart(h);
    updateHourlyTimeline(h);
    updateHeroWeatherOverview(data);

    // Trigger secondary fetch to /api/mood?city=... immediately after main weather data resolves
    const searchCity = data.location ? data.location.split(',')[0].trim() : (station.name || 'City');
    fetchCityMood(searchCity, cond).catch(() => {});

    // Weather Pulse Trend Intelligence & Solar Cycle
    updateWeatherPulse(w, h, d);
    updateSolarUvWidget(w, d, h);
    updateBestTimeToday(h);
    updateWeatherImpact(w, d, h, data.air_quality);

    // Track Freshness Metadata
    state.latestWeatherData = data;
    state.lastTelemetryFetchTimestamp = Date.now();
    state.lastTelemetryIsCached = !!data.grounding_metadata?.is_cached;
    state.lastTelemetryCacheAgeSec = data.grounding_metadata?.cache_age_seconds || 0;
    state.lastTelemetryStatus = 'live';
    updateLiveFreshnessBadge();

    // Update Topbar Ambience Pill
    if (DOM.topbarWeatherText && w.temperature_2m != null) {
      DOM.topbarWeatherText.textContent = `${Math.round(w.temperature_2m)}°C · ${data.location || station.name} (${cond})`;
    }

    if (DOM.radarCoord && data.latitude != null && data.longitude != null) {
      const latH = data.latitude >= 0 ? 'N' : 'S';
      const lonH = data.longitude >= 0 ? 'E' : 'W';
      DOM.radarCoord.textContent = `${Math.abs(data.latitude).toFixed(2)}°${latH}, ${Math.abs(data.longitude).toFixed(2)}°${lonH}`;
    }

    if (DOM.statusStationName) DOM.statusStationName.textContent = data.location || station.name;
    upsertLiveForecastEvidence(data);
    updateLiveWarningBanner(data);
    DOM.confidenceFill.style.width = data.warning_flag ? '96%' : '92%';
    DOM.confidenceLabel.textContent = data.warning_flag ? 'Live + Warning (96%)' : 'Live Grounded (92%)';
  } catch (e) {
    console.warn('Dashboard refresh error:', e.message);
  }
}

function startLiveDashboardRefresh(station) {
  if (state.liveRefreshTimer) clearInterval(state.liveRefreshTimer);
  if (state.freshnessTickerTimer) clearInterval(state.freshnessTickerTimer);
  if (!station) return;

  // 1-second UI relative freshness ticker
  state.freshnessTickerTimer = setInterval(updateLiveFreshnessBadge, 1000);

  // Background live telemetry polling every 60s
  state.liveRefreshTimer = setInterval(() => {
    const cur = state.currentStation || station;
    if (cur?.coordinates) {
      state.weatherCache.delete(`dash_${cur.coordinates.lat}_${cur.coordinates.lon}`);
    }
    refreshDashboardWeather(cur);
  }, CONFIG.LIVE_POLL_INTERVAL_MS);
}

// ============================================================================
// 12. LANGUAGE BADGE & RTL
// ============================================================================
function updateLanguageBadge(langCode) {
  if (!DOM.langBadge) return;
  const lang = LANGUAGES[langCode];
  if (lang && langCode !== 'auto' && langCode !== 'en') {
    DOM.langBadge.textContent = lang.nativeName;
    DOM.langBadge.style.display = 'inline-flex';
  } else {
    DOM.langBadge.style.display = 'none';
  }
  const isRtl = LANGUAGES[langCode]?.rtl || false;
  document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');
  document.body.classList.toggle('rtl-mode', isRtl);
}

// ============================================================================
// 13. MAIN QUERY HANDLER — calls backend, no Gemini key in browser
// ============================================================================

// ============================================================================
// PHASE 2 ENHANCEMENTS: LIVE FRESHNESS, WEATHER PULSE, SOLAR UV, CAMERA
// ============================================================================

function updateLiveFreshnessBadge() {
  if (!DOM.obsLiveStatusBadge) return;

  if (state.lastTelemetryStatus === 'offline') {
    DOM.obsLiveStatusBadge.className = 'obs-badge live-offline';
    if (DOM.obsLiveStatusLabel) DOM.obsLiveStatusLabel.textContent = 'OFFLINE';
    if (DOM.obsFreshnessText) DOM.obsFreshnessText.textContent = 'Unable to retrieve live atmospheric data';
    if (DOM.obsExactTime) DOM.obsExactTime.textContent = '';
    return;
  }

  if (!state.lastTelemetryFetchTimestamp) {
    DOM.obsLiveStatusBadge.className = 'obs-badge';
    if (DOM.obsLiveStatusLabel) DOM.obsLiveStatusLabel.textContent = 'CONNECTING';
    if (DOM.obsFreshnessText) DOM.obsFreshnessText.textContent = 'Querying Open-Meteo...';
    return;
  }

  const diffSec = Math.max(0, Math.floor((Date.now() - state.lastTelemetryFetchTimestamp) / 1000));
  const exactTimeStr = new Date(state.lastTelemetryFetchTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (diffSec >= 180 || (state.lastTelemetryIsCached && diffSec >= 90)) {
    DOM.obsLiveStatusBadge.className = 'obs-badge live-stale';
    if (DOM.obsLiveStatusLabel) DOM.obsLiveStatusLabel.textContent = 'CACHED';
    const m = Math.floor(diffSec / 60);
    if (DOM.obsFreshnessText) DOM.obsFreshnessText.textContent = `Last live update ${m}m ago`;
  } else {
    DOM.obsLiveStatusBadge.className = 'obs-badge';
    if (DOM.obsLiveStatusLabel) DOM.obsLiveStatusLabel.textContent = 'LIVE';
    if (DOM.obsFreshnessText) {
      DOM.obsFreshnessText.textContent = diffSec <= 4 ? 'Updated just now' : `Updated ${diffSec}s ago`;
    }
  }

  if (DOM.obsExactTime) {
    DOM.obsExactTime.textContent = `(${exactTimeStr})`;
  }
}

function updateWeatherPulse(current, hourly, daily) {
  if (!DOM.weatherPulseCard) return;

  if (!current || !hourly || !Array.isArray(hourly.time) || hourly.time.length < 2) {
    if (DOM.wpMainStatement) DOM.wpMainStatement.textContent = 'Weather Pulse: Waiting for enough live data to detect a trend.';
    if (DOM.wpCompBadge) DOM.wpCompBadge.textContent = 'Insufficient points';
    return;
  }

  // Determine index of current hour or closest hour
  const nowIsoHour = (current.time ? current.time.slice(0, 13) : new Date().toISOString().slice(0, 13)) + ':00';
  let hIdx = hourly.time.findIndex(t => t.startsWith(nowIsoHour.slice(0, 13)));
  if (hIdx < 0) {
    hIdx = Math.min(12, Math.floor(hourly.time.length / 2));
  }

  const prev1Idx = Math.max(0, hIdx - 1);
  const prev3Idx = Math.max(0, hIdx - 3);

  const curTemp = current.temperature_2m != null ? current.temperature_2m : (hourly.temperature_2m?.[hIdx] ?? 22);
  const prev1Temp = hourly.temperature_2m?.[prev1Idx] ?? curTemp;
  const tempDelta = curTemp - prev1Temp;

  const curHum = current.relative_humidity_2m != null ? current.relative_humidity_2m : (hourly.relative_humidity_2m?.[hIdx] ?? 80);
  const prev1Hum = hourly.relative_humidity_2m?.[prev1Idx] ?? curHum;
  const humDelta = curHum - prev1Hum;

  const curPress = current.pressure_msl != null ? current.pressure_msl : (hourly.pressure_msl?.[hIdx] ?? 1013);
  const prev3Press = hourly.pressure_msl?.[prev3Idx] ?? curPress;
  const pressDelta = curPress - prev3Press;

  const curRainProb = hourly.precipitation_probability?.[hIdx] ?? 0;
  const nextRainProb = hourly.precipitation_probability?.[Math.min(hourly.time.length - 1, hIdx + 2)] ?? curRainProb;
  const rainProbDelta = nextRainProb - curRainProb;

  // Build authentic meteorological sentence
  let pulseSentence = '';
  let emoji = '🌦️';

  if (Math.abs(tempDelta) >= 0.3) {
    const tempDir = tempDelta > 0 ? `increased by +${tempDelta.toFixed(1)}°C` : `dropped by ${tempDelta.toFixed(1)}°C`;
    const humDir = humDelta !== 0 ? `, while humidity ${humDelta > 0 ? 'rose +' + humDelta.toFixed(0) + '%' : 'decreased by ' + Math.abs(humDelta).toFixed(0) + '%'}` : '';
    pulseSentence = `Temperature has ${tempDir} over the last hour${humDir}.`;
    emoji = tempDelta > 0 ? '☀️' : '🌥️';
  } else if (pressDelta <= -1.2) {
    pulseSentence = `Barometric pressure is dropping (${pressDelta.toFixed(1)} hPa/3h), signaling an incoming convective trough.`;
    emoji = '⚠️';
  } else if (rainProbDelta >= 15 || nextRainProb >= 50) {
    pulseSentence = `Rain probability is increasing into the upcoming hours (peaking at ${nextRainProb}%).`;
    emoji = '🌧️';
  } else if (curRainProb <= 10 && curTemp >= 25) {
    pulseSentence = `Atmospheric conditions are stable and clear with minimal precipitation risk.`;
    emoji = '🌤️';
  } else {
    pulseSentence = `Atmospheric equilibrium is steady with moderate ${curHum}% humidity and ${curTemp.toFixed(1)}°C temperature.`;
    emoji = '⛅';
  }

  if (DOM.wpEmoji) DOM.wpEmoji.textContent = emoji;
  if (DOM.wpMainStatement) DOM.wpMainStatement.textContent = pulseSentence;
  if (DOM.wpCompBadge) DOM.wpCompBadge.textContent = 'Compared with 1 hour ago';
  if (DOM.wpTimestamp) DOM.wpTimestamp.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  if (DOM.wpValTemp) {
    DOM.wpValTemp.textContent = `${tempDelta >= 0 ? '+' : ''}${tempDelta.toFixed(1)}°C`;
    DOM.wpValTemp.style.color = tempDelta > 0 ? '#ff8a80' : (tempDelta < 0 ? '#80d8ff' : 'inherit');
  }
  if (DOM.wpValHumidity) {
    DOM.wpValHumidity.textContent = `${humDelta >= 0 ? '+' : ''}${humDelta.toFixed(0)}%`;
  }
  if (DOM.wpValPressure) {
    DOM.wpValPressure.textContent = `${pressDelta >= 0 ? '+' : ''}${pressDelta.toFixed(1)} hPa/3h`;
  }
  if (DOM.wpValRain) {
    DOM.wpValRain.textContent = `${curRainProb}% chance`;
  }
}

function updateSolarUvWidget(current, daily, hourly) {
  if (!DOM.dashSolarUvCard) return;

  // 1. Resolve current UV index accurately
  let uv = 0.0;
  if (current.uv_index != null) {
    uv = Number(current.uv_index);
  } else if (hourly?.uv_index && hourly.time) {
    // Find closest hourly slot to current time
    const nowIso = current.time || new Date().toISOString().slice(0, 13);
    const curHourPrefix = nowIso.slice(0, 13);
    const idx = hourly.time.findIndex(t => t.startsWith(curHourPrefix));
    if (idx !== -1 && hourly.uv_index[idx] != null) {
      uv = Number(hourly.uv_index[idx]);
    } else {
      uv = 0.0;
    }
  }

  const uvMax = daily.uv_index_max?.[0] != null ? Number(daily.uv_index_max[0]) : uv;

  if (DOM.valUvIndex) DOM.valUvIndex.textContent = uv.toFixed(1);
  if (DOM.valUvMax) DOM.valUvMax.textContent = `Max: ${uvMax.toFixed(1)} Today`;

  // Update UV WHO meter gauge (scale 0 to 11+)
  if (DOM.valUvMeterFill) {
    const pct = Math.min(100, Math.max(0, (uv / 11) * 100));
    DOM.valUvMeterFill.style.width = `${pct}%`;
  }

  // WHO Standard UV Classification & Guidance
  let uvLabel = 'Low';
  let badgeBg = 'rgba(72, 202, 155, 0.2)';
  let badgeColor = '#48ca9b';
  let advice = 'Low UV exposure. No sun protection required. Safe to stay outside.';

  if (uv >= 11) {
    uvLabel = 'Extreme';
    badgeBg = 'rgba(179, 136, 255, 0.25)';
    badgeColor = '#b388ff';
    advice = 'Extreme radiation danger: unprotected skin can burn in minutes. Avoid outdoor exposure around midday; SPF 50+, sunglasses, wide-brim hat essential.';
  } else if (uv >= 8) {
    uvLabel = 'Very High';
    badgeBg = 'rgba(242, 100, 100, 0.25)';
    badgeColor = '#f26464';
    advice = 'Very high radiation: extra protection essential. Avoid midday sun (11:00 - 15:00). Seek shade, apply SPF 50+, and wear UV-rated sunglasses.';
  } else if (uv >= 6) {
    uvLabel = 'High';
    badgeBg = 'rgba(246, 174, 45, 0.25)';
    badgeColor = '#f6ae2d';
    advice = 'High radiation: protection required. Seek shade during midday hours; wear SPF 30+ sunscreen, protective clothing, and UV-blocking eyewear.';
  } else if (uv >= 3) {
    uvLabel = 'Moderate';
    badgeBg = 'rgba(255, 202, 40, 0.2)';
    badgeColor = '#ffca28';
    advice = 'Moderate exposure: wear sunglasses and apply SPF 30+ sunscreen if spending extended time in direct sunlight.';
  } else {
    // uv < 3
    const isDay = current.is_day === 1;
    if (!isDay) {
      advice = 'Nighttime / zero UV radiation detected. Safe outdoors without UV protection.';
    } else {
      advice = 'Minimal UV radiation. Safe for normal outdoor activities. Wear sunglasses on bright glare days.';
    }
  }

  if (DOM.valUvBadge) {
    DOM.valUvBadge.textContent = uvLabel;
    DOM.valUvBadge.style.background = badgeBg;
    DOM.valUvBadge.style.color = badgeColor;
  }
  if (DOM.valUvAdvice) DOM.valUvAdvice.textContent = advice;

  // 2. Solar Ephemeris: Sunrise, Sunset, Solar Noon, Daylight Duration
  function fmtIsoTime(isoStr) {
    if (!isoStr) return '--:--';
    const parts = isoStr.split('T');
    if (parts.length < 2) return isoStr;
    const timeParts = parts[1].split(':');
    let h = parseInt(timeParts[0], 10);
    const m = timeParts[1] ? timeParts[1].slice(0, 2) : '00';
    if (isNaN(h)) return parts[1].slice(0, 5);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const srStr = daily.sunrise?.[0] || `${todayIso}T06:14`;
  const ssStr = daily.sunset?.[0] || `${todayIso}T18:28`;

  if (DOM.valSunrise && srStr) {
    DOM.valSunrise.textContent = fmtIsoTime(srStr);
  }
  if (DOM.valSunset && ssStr) {
    DOM.valSunset.textContent = fmtIsoTime(ssStr);
  }

  // Calculate Solar Noon & Daylight Progression
  if (srStr && ssStr) {
    const srParts = srStr.split('T')[1]?.split(':') || ['06', '00'];
    const ssParts = ssStr.split('T')[1]?.split(':') || ['18', '00'];
    const srMinutes = parseInt(srParts[0], 10) * 60 + parseInt(srParts[1], 10);
    const ssMinutes = parseInt(ssParts[0], 10) * 60 + parseInt(ssParts[1], 10);

    // Solar noon is exact arithmetic midpoint
    const noonMinutes = Math.round((srMinutes + ssMinutes) / 2);
    const noonH = Math.floor(noonMinutes / 60);
    const noonM = noonMinutes % 60;
    const noonAmPm = noonH >= 12 ? 'PM' : 'AM';
    const noonDisp12 = noonH % 12 === 0 ? 12 : noonH % 12;
    if (DOM.valSolarNoon) {
      DOM.valSolarNoon.textContent = `${String(noonDisp12).padStart(2, '0')}:${String(noonM).padStart(2, '0')} ${noonAmPm}`;
    }

    // Daylight duration
    const totalDayMins = Math.max(1, ssMinutes - srMinutes);
    const durH = Math.floor(totalDayMins / 60);
    const durM = totalDayMins % 60;
    if (DOM.valDayLength) {
      DOM.valDayLength.textContent = `${durH}h ${durM}m`;
    }

    // Compare with current station time or local time in minutes of day
    let curMinutes = 0;
    if (current.time && current.time.includes('T')) {
      const curParts = current.time.split('T')[1].split(':');
      curMinutes = parseInt(curParts[0], 10) * 60 + parseInt(curParts[1], 10);
    } else {
      const now = new Date();
      curMinutes = now.getHours() * 60 + now.getMinutes();
    }

    if (curMinutes < srMinutes) {
      // Pre-dawn / Night
      if (DOM.valSolarProgressLabel) DOM.valSolarProgressLabel.textContent = 'Pre-dawn (Night)';
      if (DOM.valSolarProgressPercent) DOM.valSolarProgressPercent.textContent = '0%';
      if (DOM.valSolarProgressFill) DOM.valSolarProgressFill.style.width = '0%';
      if (DOM.valSolarSunPin) {
        DOM.valSolarSunPin.style.left = '0%';
        DOM.valSolarSunPin.textContent = '🌙';
      }
    } else if (curMinutes > ssMinutes) {
      // Post-sunset / Night
      if (DOM.valSolarProgressLabel) DOM.valSolarProgressLabel.textContent = 'Post-sunset (Night)';
      if (DOM.valSolarProgressPercent) DOM.valSolarProgressPercent.textContent = '100%';
      if (DOM.valSolarProgressFill) DOM.valSolarProgressFill.style.width = '100%';
      if (DOM.valSolarSunPin) {
        DOM.valSolarSunPin.style.left = '100%';
        DOM.valSolarSunPin.textContent = '🌙';
      }
    } else {
      // Daytime: compute authentic progression fraction
      const elapsed = curMinutes - srMinutes;
      const fraction = Math.min(1.0, Math.max(0.0, elapsed / totalDayMins));
      const pct = Math.round(fraction * 100);
      const phase = fraction < 0.4 ? 'Morning Ascent' : (fraction < 0.6 ? 'Solar Noon Peak' : 'Afternoon Descent');
      if (DOM.valSolarProgressLabel) DOM.valSolarProgressLabel.textContent = phase;
      if (DOM.valSolarProgressPercent) DOM.valSolarProgressPercent.textContent = `${pct}% of daylight`;
      if (DOM.valSolarProgressFill) DOM.valSolarProgressFill.style.width = `${pct}%`;
      if (DOM.valSolarSunPin) {
        DOM.valSolarSunPin.style.left = `${pct}%`;
        DOM.valSolarSunPin.textContent = '☀️';
      }
    }
  } else if (daily.daylight_duration?.[0] && DOM.valDayLength) {
    const sec = daily.daylight_duration[0];
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    DOM.valDayLength.textContent = `${hrs}h ${mins}m`;
  }
}


// ============================================================================
// 10D. BEST TIME TODAY & WEATHER IMPACT
// ============================================================================
function updateBestTimeToday(hourly) {
  if (!hourly || !hourly.time || hourly.time.length === 0) return;

  const times = hourly.time;
  const temps = hourly.temperature_2m || [];
  const rains = hourly.precipitation_probability || hourly.precipitation || [];
  const uvs = hourly.uv_index || [];
  const winds = hourly.wind_speed_10m || [];

  // Break day into morning (6-12), afternoon (12-17), evening (17-22)
  const segments = {
    morning: { temps: [], rains: [], count: 0 },
    afternoon: { temps: [], rains: [], count: 0 },
    evening: { temps: [], rains: [], count: 0 }
  };

  // Find daytime hours (between 6:00 and 20:00) with lowest rain & comfortable temp
  let bestScore = -999;
  let bestHourIndex = 7; // default 07:00

  for (let i = 0; i < Math.min(24, times.length); i++) {
    const tStr = times[i];
    const hour = parseInt(tStr.split('T')[1]?.split(':')[0] || '0', 10);
    const temp = temps[i] ?? 22;
    const rain = rains[i] ?? 0;
    const uv = uvs[i] ?? 0;
    const wind = winds[i] ?? 5;

    if (hour >= 6 && hour < 12) {
      segments.morning.temps.push(temp);
      segments.morning.rains.push(rain);
    } else if (hour >= 12 && hour < 17) {
      segments.afternoon.temps.push(temp);
      segments.afternoon.rains.push(rain);
    } else if (hour >= 17 && hour < 22) {
      segments.evening.temps.push(temp);
      segments.evening.rains.push(rain);
    }

    if (hour >= 6 && hour <= 20) {
      // Score formula: high when rain is low, temp near 21-24°C, uv manageable
      const tempDiff = Math.abs(temp - 22);
      const score = 100 - (rain * 1.2) - (tempDiff * 3) - (uv > 7 ? 20 : 0) - (wind > 25 ? 15 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestHourIndex = i;
      }
    }
  }

  // Format segment helpers
  function segMeta(seg) {
    if (!seg.temps.length) return { cond: 'Normal', meta: '--°C · 0% Rain' };
    const avgT = Math.round(seg.temps.reduce((a, b) => a + b, 0) / seg.temps.length);
    const maxR = Math.round(Math.max(...seg.rains));
    let cond = 'Pleasant';
    if (maxR > 50) cond = 'Rain Risk';
    else if (avgT > 30) cond = 'Hot';
    else if (avgT < 15) cond = 'Cool';
    else if (maxR < 20) cond = 'Optimal';
    return { cond, meta: `${avgT}°C · ${maxR}% Rain` };
  }

  const mData = segMeta(segments.morning);
  const aData = segMeta(segments.afternoon);
  const eData = segMeta(segments.evening);

  if (DOM.valMorningCond) DOM.valMorningCond.textContent = mData.cond;
  if (DOM.valMorningMeta) DOM.valMorningMeta.textContent = mData.meta;
  if (DOM.valAfternoonCond) DOM.valAfternoonCond.textContent = aData.cond;
  if (DOM.valAfternoonMeta) DOM.valAfternoonMeta.textContent = aData.meta;
  if (DOM.valEveningCond) DOM.valEveningCond.textContent = eData.cond;
  if (DOM.valEveningMeta) DOM.valEveningMeta.textContent = eData.meta;

  // Set Optimal Window
  const bestStartHour = parseInt(times[bestHourIndex].split('T')[1]?.split(':')[0] || '7', 10);
  const endHour = Math.min(23, bestStartHour + 3);
  const windowStr = `${String(bestStartHour).padStart(2, '0')}:00 – ${String(endHour).padStart(2, '0')}:00`;
  if (DOM.valOptimalWindow) DOM.valOptimalWindow.textContent = windowStr;

  const bestRain = rains[bestHourIndex] ?? 0;
  const bestTemp = Math.round(temps[bestHourIndex] ?? 22);
  let reason = `Mild temperature around ${bestTemp}°C with low ${bestRain}% rain probability makes this the optimal slot for outdoor activities.`;
  if (bestRain > 50) {
    reason = `Persistent precipitation across the day; this slot has the lowest expected intensity (${bestTemp}°C, ${bestRain}% chance).`;
  }
  if (DOM.valOptimalReason) DOM.valOptimalReason.textContent = reason;

  if (DOM.valBestTimeBadge) {
    DOM.valBestTimeBadge.textContent = bestScore > 70 ? 'Ideal Window' : (bestScore > 40 ? 'Moderate' : 'Caution');
  }
}

function updateWeatherImpact(current, daily, hourly, aqiData) {
  const temp = current.temperature_2m ?? 24;
  const precip = current.precipitation ?? 0;
  const wind = current.wind_speed_10m ?? 8;
  const aqi = aqiData?.aqi ?? 40;
  const uv = current.uv_index ?? (hourly?.uv_index ? Math.max(...(hourly.uv_index.slice(0, 24))) : 4);

  // Commute Impact
  let commuteText = 'Clear road conditions and normal visibility for travel.';
  if (precip > 5 || wind > 40) {
    commuteText = 'Caution: Rain and gusty winds may cause delays and reduced braking traction.';
  } else if (precip > 0.5) {
    commuteText = 'Damp surfaces reported; allow 5-10 extra minutes for travel.';
  }
  if (DOM.valImpactCommute) DOM.valImpactCommute.textContent = commuteText;

  // Fitness Impact
  let fitnessText = 'Excellent conditions for running, cycling, or gym outdoor workouts.';
  if (temp > 34) {
    fitnessText = 'High heat stress; schedule intensive workouts early morning and stay hydrated.';
  } else if (temp < 10) {
    fitnessText = 'Cool conditions; warm up thoroughly indoors before intense cardio.';
  } else if (precip > 2) {
    fitnessText = 'Wet outdoors; indoor training or treadmill sessions recommended.';
  }
  if (DOM.valImpactFitness) DOM.valImpactFitness.textContent = fitnessText;

  // Air & Respiratory
  let airText = 'Air quality is clean; low particulate burden for sensitive groups.';
  if (aqi > 150) {
    airText = 'Unhealthy particulate levels; wear an N95 mask outdoors and run air filtration.';
  } else if (aqi > 100) {
    airText = 'Moderate pollutant burden; sensitive groups should limit strenuous exertion.';
  }
  if (DOM.valImpactAir) DOM.valImpactAir.textContent = airText;

  // Sun & Skin
  let sunText = 'Minimal UV radiation; standard daily skincare sufficient.';
  if (uv >= 8) {
    sunText = 'Very High UV: apply SPF 50+, wear protective shades, seek midday shade.';
  } else if (uv >= 5) {
    sunText = 'Moderate to High UV: sunscreen recommended between 11 AM and 3 PM.';
  }
  if (DOM.valImpactSun) DOM.valImpactSun.textContent = sunText;

  // Overall Badge
  if (DOM.valImpactOverallBadge) {
    if (precip > 5 || wind > 45 || aqi > 150) {
      DOM.valImpactOverallBadge.textContent = 'Advisory Active';
      DOM.valImpactOverallBadge.style.background = 'rgba(239, 83, 80, 0.2)';
      DOM.valImpactOverallBadge.style.color = '#ef5350';
    } else if (precip > 0.5 || aqi > 100 || uv >= 8) {
      DOM.valImpactOverallBadge.textContent = 'Moderate';
      DOM.valImpactOverallBadge.style.background = 'rgba(255, 202, 40, 0.2)';
      DOM.valImpactOverallBadge.style.color = '#ffca28';
    } else {
      DOM.valImpactOverallBadge.textContent = 'Favorable';
      DOM.valImpactOverallBadge.style.background = 'rgba(72, 202, 155, 0.2)';
      DOM.valImpactOverallBadge.style.color = '#48ca9b';
    }
  }
}

// ----------------------------------------------------------------------------
// Working WebRTC Camera Studio
// ----------------------------------------------------------------------------
async function startLiveCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (DOM.cameraStatusText) DOM.cameraStatusText.textContent = 'Camera not supported in browser';
    return;
  }

  stopLiveCamera(); // stop any active tracks

  try {
    const constraints = {
      video: {
        facingMode: state.cameraFacingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.cameraStream = stream;

    if (DOM.liveCameraVideo) {
      DOM.liveCameraVideo.srcObject = stream;
      DOM.liveCameraVideo.style.display = 'block';
      await DOM.liveCameraVideo.play().catch(() => {});
    }

    if (DOM.cameraSnapshotPreview) DOM.cameraSnapshotPreview.style.display = 'none';
    if (DOM.cameraControlsLive) DOM.cameraControlsLive.style.display = 'flex';
    if (DOM.snapshotAnalysisBox) DOM.snapshotAnalysisBox.style.display = 'none';
    if (DOM.cameraStatusText) DOM.cameraStatusText.textContent = 'Camera Active · Align Sky & Clouds';

  } catch (err) {
    console.warn('Camera access error:', err);
    if (DOM.cameraStatusText) {
      DOM.cameraStatusText.textContent = err.name === 'NotAllowedError'
        ? 'Camera permission denied'
        : 'Could not access camera';
    }
  }
}

function stopLiveCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
  }
  if (DOM.liveCameraVideo) {
    DOM.liveCameraVideo.srcObject = null;
  }
}

function flipCamera() {
  state.cameraFacingMode = state.cameraFacingMode === 'user' ? 'environment' : 'user';
  startLiveCamera();
}

function snapCameraPhoto() {
  if (!DOM.liveCameraVideo || !DOM.cameraCanvas) return;
  const video = DOM.liveCameraVideo;
  const canvas = DOM.cameraCanvas;

  if (video.videoWidth === 0 || video.videoHeight === 0) return;

  const maxDim = 800;
  let w = video.videoWidth;
  let h = video.videoHeight;
  if (w > maxDim || h > maxDim) {
    if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
  }

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  state.capturedImageBase64 = dataUrl;

  // Stop video stream to respect user privacy and turn off hardware indicator
  stopLiveCamera();

  // Show snapshot in preview
  if (DOM.cameraSnapshotPreview) {
    DOM.cameraSnapshotPreview.src = dataUrl;
    DOM.cameraSnapshotPreview.style.display = 'block';
  }
  if (DOM.liveCameraVideo) DOM.liveCameraVideo.style.display = 'none';
  if (DOM.cameraControlsLive) DOM.cameraControlsLive.style.display = 'none';
  if (DOM.snapshotAnalysisBox) DOM.snapshotAnalysisBox.style.display = 'block';
  if (DOM.cameraStatusText) DOM.cameraStatusText.textContent = 'Snapshot Captured · Ready to Ask';
}

function retakeCameraPhoto() {
  state.capturedImageBase64 = null;
  startLiveCamera();
}

function submitCameraQuery() {
  const queryText = (DOM.cameraPromptInput?.value || '').trim() || 'Does this sky look like rain is coming?';
  const imgData = state.capturedImageBase64;

  if (!imgData) return;

  stopLiveCamera();
  closeCameraModal();

  // Route directly through unified AtmosX chat stream with image thumbnail
  handleSend(queryText, {
    type: 'image',
    fileName: 'sky_snapshot.jpg',
    dataUrl: imgData,
    summary: 'Sky Observation Photo'
  });
}

/**
 * Canonical central query submission pipeline.
 * Coordinates input sanitization, security checks, multimodal attachment,
 * language detection, and SSE streaming AI chat dispatch.
 */
async function submitQuery(customText = null, customAttachment = null) {
  // If customText is not a string (e.g. MouseEvent or PointerEvent from addEventListener), treat as null
  if (typeof customText !== 'string') {
    customText = null;
  }
  if (customAttachment && typeof customAttachment !== 'object') {
    customAttachment = null;
  }

  const rawText = (typeof customText === 'string' && customText.trim()) ? customText : (DOM.inputPrompt ? DOM.inputPrompt.value : '');
  const text = sanitizeInput(rawText);
  const attachment = customAttachment !== null ? customAttachment : state.attachedScan;

  if (!text && !attachment) return;

  if (state.isSending) {
    if (state.activeAbortController) {
      state.activeAbortController.abort();
      state.activeAbortController = null;
    }
  }
  state.isSending = true;
  if (DOM.btnSend) {
    DOM.btnSend.disabled = false;
    DOM.btnSend.innerHTML = '<span style="font-size:14px;line-height:1;">⏹</span>';
    DOM.btnSend.title = 'Stop generating';
  }

  try {
    if (text && detectPromptInjection(text)) {
      addSystemMessage('⚠️ Security: Directive override pattern detected. Request blocked.');
      return;
    }

    if (DOM.inputPrompt) {
      DOM.inputPrompt.value = '';
      DOM.inputPrompt.style.height = '';
      updateCharCount();
    }

    clearAttachmentPreview();

    addUserMessage(text || `Analyze: ${attachment?.fileName || 'file'}`, attachment);
    const typingRow = addTypingIndicator();

    // Detect language from what the user typed
    const lang = getEffectiveLang(text || '');
    updateLanguageBadge(lang);

    setPipelineStep('understand');

    // Intelligent station / location detection with active station fallback
    const stationLoc = resolveStationFromQuery(text);
    const locationName = stationLoc ? stationLoc.name : (extractLocationName(text, null) || state.currentStation?.name || null);

    if (stationLoc) {
      setPipelineStep('ground');
      renderEvidence(stationLoc, attachment);
      refreshDashboardWeather(stationLoc).catch(() => {});
    }

    let streamMsg = null;
    let hasReceivedTokens = false;
    let receivedSuggestions = null;

    // Track user turn in history
    state.conversationHistory.push({ role: 'user', text: text });
    if (state.conversationHistory.length > 8) state.conversationHistory.shift();

    let queryText = text;
    if (attachment) {
      queryText = `${text ? text + '\n\n' : ''}[Attached ${attachment.type}: ${attachment.summary}]`;
    }

    const imgBase64 = (attachment && attachment.type === 'image' && attachment.dataUrl) ? attachment.dataUrl : null;

    try {
      await callBackendChatStream(
        queryText,
        locationName,
        lang,
        // onMeta callback
        (meta) => {
          setPipelineStep('act');
          if (meta.suggestions) receivedSuggestions = meta.suggestions;
          if (meta.location && meta.latitude != null && meta.longitude != null) {
            const dynamicStation = {
              id: meta.location.toLowerCase().replace(/[^a-z0-9]/g, '_'),
              name: meta.location,
              state: '',
              coordinates: { lat: meta.latitude, lon: meta.longitude }
            };
            refreshDashboardWeather(dynamicStation).catch(() => {});
          }
          if (meta.warning?.active && meta.warning.message) {
            if (DOM.warnSeverityBadge) DOM.warnSeverityBadge.textContent = `Live Alert`;
            if (DOM.warnHeadline) DOM.warnHeadline.textContent = meta.warning.message;
            DOM.warningBanner.className = `warning-banner active severity-${meta.warning.level || 'Orange'}`;
          }
        },
        // onToken callback
        (token) => {
          if (!hasReceivedTokens) {
            if (typingRow && typingRow.parentNode) typingRow.remove();
            streamMsg = createStreamingBotMessage();
            hasReceivedTokens = true;
          }
          streamMsg.appendToken(token);
        },
        // Prior turns only (current query is passed as queryText)
        state.conversationHistory.slice(0, -1),
        imgBase64,
        'image/jpeg'
      );
    } catch (streamErr) {
      console.warn('Streaming failed or was interrupted, falling back to direct chat endpoint:', streamErr.message);
    }

    // If stream produced valid tokens, finalize it
    if (streamMsg && hasReceivedTokens) {
      streamMsg.finalize(undefined, receivedSuggestions);
      state.conversationHistory.push({ role: 'model', text: streamMsg.getFullText() });
      if (state.conversationHistory.length > 8) state.conversationHistory.shift();
    } else {
      // Stream did not deliver tokens; execute seamless fallback to standard chat endpoint
      const priorHistory = state.conversationHistory.slice(0, -1);
      const chatRes = await callBackendChat(queryText, locationName, lang, priorHistory, imgBase64, 'image/jpeg');
      if (typingRow && typingRow.parentNode) typingRow.remove();

      if (chatRes && chatRes.answer) {
        addBotMessage(chatRes.answer, chatRes.suggestions || receivedSuggestions);
        state.conversationHistory.push({ role: 'model', text: chatRes.answer });
        if (state.conversationHistory.length > 8) state.conversationHistory.shift();
      } else {
        addBotMessage('I am currently observing atmospheric conditions. Please ask again in a moment.');
      }
    }

  } catch (err) {
    console.error('Chat error:', err);
    let errMsg = `Something went wrong: ${err.message}. Please check your connection and try again.`;
    if (err.message?.includes('AI service not configured')) {
      errMsg = '⚙️ The AI service is not configured yet. The server needs a GEMINI_API_KEY environment variable set.';
    } else if (err.name === 'AbortError' || err.message?.includes('timed out')) {
      errMsg = '⏱️ The request timed out. Please try again in a moment.';
    }
    addBotMessage(errMsg);
  } finally {
    clearPipeline();
    state.isSending = false;
    state.activeAbortController = null;
    if (DOM.btnSend) {
      DOM.btnSend.disabled = false;
      DOM.btnSend.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>';
      DOM.btnSend.title = 'Send Query';
    }
    if (DOM.inputPrompt) DOM.inputPrompt.focus();
  }
}

// Backward-compatible alias for existing call-sites
const handleSend = submitQuery;

// ============================================================================
// 14. HELPERS
// ============================================================================

/**
 * Safe numeric conversion with finite number guarantee and default fallback
 */
function safeNumber(val, fallback = 0) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safe array validation ensuring an Array is always returned
 */
function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

/**
 * Safe string coercion with null/undefined protection
 */
function safeString(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val);
}
function updateCharCount() {
  const rem = CONFIG.MAX_INPUT_LEN - (DOM.inputPrompt?.value.length || 0);
  if (DOM.charCount) {
    DOM.charCount.textContent = String(rem);
    DOM.charCount.style.color = rem < 30 ? 'var(--accent-red)' : 'var(--text-faint)';
  }
}

function clearAttachmentPreview() {
  state.attachedScan = null;
  DOM.composerAttachmentPreview?.classList.remove('active');
  if (DOM.attachmentTitle) DOM.attachmentTitle.textContent = '';
  if (DOM.attachmentThumb) { DOM.attachmentThumb.src = ''; DOM.attachmentThumb.style.display = 'none'; }
}

// ============================================================================
// 15. SKY CAMERA & UPLOAD SCANNER MODALS
// ============================================================================
function openCameraModal() {
  DOM.cameraModal?.classList.add('active');
  startLiveCamera();
}

function closeCameraModal() {
  stopLiveCamera();
  DOM.cameraModal?.classList.remove('active');
}

function openUploadModal()  { DOM.uploadModal?.classList.add('active'); }
function closeUploadModal() {
  DOM.uploadModal?.classList.remove('active');
  DOM.scannerResultsCard?.classList.remove('active');
  if (DOM.fileInput) DOM.fileInput.value = '';
}

async function processUploadedFile(file) {
  if (!file) return;
  if (file.size > CONFIG.MAX_FILE_SIZE_BYTES) {
    showToast(`File too large (${(file.size/1024/1024).toFixed(1)} MB). Maximum allowed size is 5 MB.`, 'warning');
    return;
  }
  const mime = await validateFileSignature(file);
  if (!mime) {
    showToast('Security: Invalid file signature. Only JPEG, PNG, WEBP, PDF, CSV, JSON, and TXT allowed.', 'error');
    return;
  }
  try {
    let scan;
    if (mime.startsWith('image/')) {
      scan = await scanWeatherPhoto(file);
      DOM.scanPreviewImg.src = scan.dataUrl;
      DOM.scanPreviewImg.style.display = 'block';
      DOM.scanDetectedTitle.textContent = scan.cloudType;
      DOM.scanTagsList.innerHTML = '';
      DOM.scanTagsList.appendChild(el('span', { className: 'scan-badge', text: `Coverage: ${scan.cloudCoveragePct}%` }));
      DOM.scanTagsList.appendChild(el('span', { className: 'scan-badge', text: `Rain: ${scan.estimatedRainProbPct}%` }));
      DOM.scanTagsList.appendChild(el('span', { className: 'scan-badge', text: `Severity: ${scan.severity}` }));
    } else {
      scan = await scanWeatherDocument(file);
      DOM.scanPreviewImg.style.display = 'none';
      DOM.scanDetectedTitle.textContent = scan.detectedType;
      DOM.scanTagsList.innerHTML = '';
      DOM.scanTagsList.appendChild(el('span', { className: 'scan-badge', text: `Alert: ${scan.alertLevel}` }));
      if (scan.extractedTemp) DOM.scanTagsList.appendChild(el('span', { className: 'scan-badge', text: `Temp: ${scan.extractedTemp}` }));
      if (scan.extractedRain) DOM.scanTagsList.appendChild(el('span', { className: 'scan-badge', text: `Rain: ${scan.extractedRain}` }));
    }
    DOM.scanSummaryText.textContent = scan.summary;
    state.tempScan = scan;
    DOM.scannerResultsCard?.classList.add('active');
  } catch (err) {
    showToast('Failed to scan file: ' + err.message, 'error');
  }
}

// ============================================================================
// 16. SETTINGS PANEL
// ============================================================================
function buildLanguageSelector() {
  if (!DOM.selectLanguage) return;
  DOM.selectLanguage.innerHTML = '';
  for (const [code, lang] of Object.entries(LANGUAGES)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${lang.nativeName} — ${lang.name}`;
    if (code === (state.settings.language || 'auto')) opt.selected = true;
    DOM.selectLanguage.appendChild(opt);
  }
}

function openSettings() {
  if (DOM.toggleAutoSpeak)  DOM.toggleAutoSpeak.checked  = state.settings.autoSpeak;
  if (DOM.selectVoiceSpeed) DOM.selectVoiceSpeed.value   = String(state.settings.speechRate);
  buildLanguageSelector();
  if (DOM.selectLanguage)   DOM.selectLanguage.value     = state.settings.language || 'auto';
  DOM.settingsModal?.classList.add('active');
}

function saveSettings() {
  if (DOM.toggleAutoSpeak)   state.settings.autoSpeak  = DOM.toggleAutoSpeak.checked;
  if (DOM.selectVoiceSpeed)  state.settings.speechRate = parseFloat(DOM.selectVoiceSpeed.value) || 1.0;
  if (DOM.selectVoiceChoice) state.settings.voiceIndex = parseInt(DOM.selectVoiceChoice.value, 10) || 0;
  if (DOM.selectLanguage)    state.settings.language   = DOM.selectLanguage.value;
  updateLanguageBadge(state.settings.language !== 'auto' ? state.settings.language : 'auto');
  state.recognition = null; // re-init with new language
  try { localStorage.setItem('atmosx_settings_v2', JSON.stringify(state.settings)); } catch (e) {}
  DOM.settingsModal?.classList.remove('active');
}

// ============================================================================
// 17. EVENT BINDING & BOOTSTRAP
// ============================================================================
function refreshDomReferences() {
  for (const key in DOM) {
    if (!DOM[key]) {
      DOM[key] = document.getElementById(key);
    }
  }
}

function autoResizePrompt() {
  if (!DOM.inputPrompt) return;
  DOM.inputPrompt.style.height = 'auto';
  DOM.inputPrompt.style.height = Math.min(DOM.inputPrompt.scrollHeight, 130) + 'px';
}

let isAppInitialized = false;

function initEvents() {
  if (isAppInitialized) return;
  isAppInitialized = true;
  refreshDomReferences();

  if (DOM.inputPrompt) {
    DOM.inputPrompt.addEventListener('input', () => {
      updateCharCount();
      autoResizePrompt();
    });
    DOM.inputPrompt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }

  if (DOM.btnSend) {
    DOM.btnSend.disabled = false;
    DOM.btnSend.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.isSending) {
        if (state.activeAbortController) {
          state.activeAbortController.abort();
          state.activeAbortController = null;
        }
        state.isSending = false;
        if (DOM.btnSend) {
          DOM.btnSend.disabled = false;
          DOM.btnSend.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>';
          DOM.btnSend.title = 'Send Query';
        }
        showToast('Generation cancelled.', 'info', 2000);
        return;
      }
      handleSend();
    });
  }

  DOM.btnClearChat?.addEventListener('click', () => {
    if (!confirm('Clear conversation?')) return;
    while (DOM.messagesContainer.firstChild) DOM.messagesContainer.removeChild(DOM.messagesContainer.firstChild);
    state.conversationHistory = [];
    addBotMessage('weatherGPT reset. Ask me anything about weather in any language — Hindi, Tamil, Arabic, French and 20+ more! 🌍');
  });

  // ─── Recent Locations & GPS Geolocation ──────────────────────────────────
  const RECENT_LOCATIONS_KEY = 'atmosx_recent_stations_v1';

  function getRecentLocations() {
    try {
      const raw = localStorage.getItem(RECENT_LOCATIONS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveRecentLocation(station) {
    if (!station || !station.name || !station.coordinates) return;
    try {
      let recents = getRecentLocations();
      recents = recents.filter(s => s.name.toLowerCase() !== station.name.toLowerCase());
      recents.unshift({
        id: station.id,
        name: station.name,
        state: station.state || '',
        coordinates: station.coordinates
      });
      recents = recents.slice(0, 6);
      localStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(recents));
      renderRecentLocations();
    } catch (e) {}
  }

  function renderRecentLocations() {
    if (!DOM.recentStationsGrid || !DOM.recentStationsSection) return;
    const recents = getRecentLocations();
    if (!recents.length) {
      DOM.recentStationsSection.style.display = 'none';
      return;
    }
    DOM.recentStationsSection.style.display = 'block';
    DOM.recentStationsGrid.innerHTML = '';
    recents.forEach(s => {
      const btn = el('button', {
        className: 'station-chip',
        text: `🕒 ${s.name}`,
        attrs: { type: 'button', 'data-name': s.name }
      });
      btn.addEventListener('click', async () => {
        state.currentStation = s;
        saveRecentLocation(s);
        if (DOM.statusStationName) DOM.statusStationName.textContent = s.name;
        if (DOM.locationModal) DOM.locationModal.classList.remove('active');
        showToast(`Switched to ${s.name}`, 'success');
        await refreshDashboardWeather(s);
        startLiveDashboardRefresh(s);
      });
      DOM.recentStationsGrid.appendChild(btn);
    });
  }

  async function detectUserGeolocation() {
    if (!('geolocation' in navigator)) {
      showToast('Geolocation is not supported by your browser.', 'warning');
      return;
    }
    showToast('Detecting your GPS location…', 'info', 2500);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        try {
          const res = await fetch(`${API_BASE_URL}/api/v1/resolve-location?latitude=${lat}&longitude=${lon}`);
          if (!res.ok) throw new Error('Location reverse geocode failed');
          const loc = await res.json();
          const station = {
            id: `gps_${lat.toFixed(2)}_${lon.toFixed(2)}`,
            name: loc.name || `My Location (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`,
            state: '',
            coordinates: { lat, lon }
          };
          state.currentStation = station;
          saveRecentLocation(station);
          if (DOM.statusStationName) DOM.statusStationName.textContent = station.name;
          if (DOM.locationModal) DOM.locationModal.classList.remove('active');
          showToast(`Switched to ${station.name}`, 'success');
          await refreshDashboardWeather(station);
          startLiveDashboardRefresh(station);
        } catch (err) {
          showToast(`Could not resolve location for (${lat.toFixed(2)}, ${lon.toFixed(2)})`, 'error');
        }
      },
      (err) => {
        let msg = 'Unable to retrieve GPS location.';
        if (err.code === 1) msg = 'Location permission was denied. Please allow location access in your browser settings.';
        else if (err.code === 2) msg = 'Location is unavailable. Please check your network or GPS.';
        else if (err.code === 3) msg = 'Location request timed out.';
        showToast(msg, 'warning');
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  }

  // Location Switcher Modal
  async function selectCityByName(cityName) {
    if (!cityName) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/resolve-location?name=${encodeURIComponent(cityName)}`);
      if (res.ok) {
        const loc = await res.json();
        const station = {
          id: loc.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          name: loc.name,
          state: '',
          coordinates: { lat: loc.latitude, lon: loc.longitude }
        };
        state.currentStation = station;
        saveRecentLocation(station);
        if (DOM.statusStationName) DOM.statusStationName.textContent = loc.name;
        if (DOM.locationModal) DOM.locationModal.classList.remove('active');
        showToast(`Switched to ${loc.name}`, 'success');
        await refreshDashboardWeather(station);
        startLiveDashboardRefresh(station);
        fetchCityMood(loc.name).catch(() => {});
      }
    } catch (e) {
      console.warn('City resolution error:', e);
      showToast(`Could not resolve city: ${cityName}`, 'error');
    }
  }

  if (DOM.btnChangeLocation) {
    DOM.btnChangeLocation.addEventListener('click', () => {
      if (DOM.locationModal) {
        DOM.locationModal.classList.add('active');
        renderRecentLocations();
        if (DOM.inputSearchCity) DOM.inputSearchCity.focus();
      }
    });
  }
  if (DOM.btnCloseLocationModal) {
    DOM.btnCloseLocationModal.addEventListener('click', () => {
      if (DOM.locationModal) DOM.locationModal.classList.remove('active');
    });
  }

  if (DOM.btnUseCurrentLocation) {
    DOM.btnUseCurrentLocation.addEventListener('click', detectUserGeolocation);
  }

  // Global Escape key dismisses all modals
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      [
        DOM.locationModal,
        DOM.cameraModal,
        DOM.uploadModal,
        DOM.settingsModal,
        DOM.modalPressureDetails,
        DOM.modalPrecipDetails,
        DOM.modalWindDetails,
        DOM.modalThermalDetails,
        DOM.modalAqiDetails,
        DOM.modalUvDetails
      ].forEach(m => {
        if (m) {
          m.classList.remove('active');
          m.style.display = 'none';
        }
      });
      stopLiveCamera();
    }
  });
  const citySearchForm = document.getElementById('citySearchForm');
  if (citySearchForm) {
    citySearchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = (DOM.inputSearchCity?.value || '').trim();
      if (q) selectCityByName(q);
    });
  }
  if (DOM.btnSearchCity) {
    DOM.btnSearchCity.addEventListener('click', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const q = (DOM.inputSearchCity?.value || '').trim();
      if (q) selectCityByName(q);
    });
  }
  if (DOM.inputSearchCity) {
    DOM.inputSearchCity.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = DOM.inputSearchCity.value.trim();
        if (q) selectCityByName(q);
      }
    });
  }
  document.querySelectorAll('.station-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      selectCityByName(chip.dataset.name);
    });
  });

  // Station selector
  if (typeof WEATHER_STATIONS !== 'undefined' && DOM.stationSelect) {
    WEATHER_STATIONS.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.state}) — ${s.warning ? s.warning.severity + ' Alert' : 'Normal'}`;
      DOM.stationSelect.appendChild(opt);
    });
    DOM.stationSelect.addEventListener('change', async e => {
      const s = WEATHER_STATIONS.find(s => s.id === e.target.value);
      if (s) { renderEvidence(s); await refreshDashboardWeather(s); startLiveDashboardRefresh(s); }
    });
    const initial = WEATHER_STATIONS[0];
    renderEvidence(initial);
    refreshDashboardWeather(initial);
    startLiveDashboardRefresh(initial);
  }

  // Prompt chips
  document.querySelectorAll('.prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.q || '';
      if (DOM.inputPrompt) {
        DOM.inputPrompt.value = q;
        updateCharCount();
      }
      handleSend(q);
    });
  });

  // Voice
  DOM.btnVoiceTrigger.addEventListener('click', () => state.isListening ? stopListening() : startListening());
  DOM.btnStopVoice.addEventListener('click', stopListening);

  // Camera Studio Trigger & Modal Wiring
  if (DOM.btnCameraTrigger) DOM.btnCameraTrigger.addEventListener('click', openCameraModal);
  if (DOM.btnCloseCameraModal) DOM.btnCloseCameraModal.addEventListener('click', closeCameraModal);
  if (DOM.cameraModal) {
    DOM.cameraModal.addEventListener('click', (e) => {
      if (e.target === DOM.cameraModal) closeCameraModal();
    });
  }

  // Upload Document Trigger & Modal Wiring
  if (DOM.btnDocUploadTrigger) {
    DOM.btnDocUploadTrigger.addEventListener('click', openUploadModal);
  }
  if (DOM.btnCloseUploadModal) DOM.btnCloseUploadModal.addEventListener('click', closeUploadModal);
  if (DOM.btnCancelScan) DOM.btnCancelScan.addEventListener('click', closeUploadModal);
  if (DOM.uploadModal) {
    DOM.uploadModal.addEventListener('click', (e) => {
      if (e.target === DOM.uploadModal) closeUploadModal();
    });
  }
  DOM.fileDropzone?.addEventListener('click', () => DOM.fileInput?.click());
  DOM.fileInput?.addEventListener('change', e => { if (e.target.files?.[0]) processUploadedFile(e.target.files[0]); });
  if (DOM.fileDropzone) {
    ['dragenter','dragover'].forEach(ev => DOM.fileDropzone.addEventListener(ev, e => { e.preventDefault(); DOM.fileDropzone.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => DOM.fileDropzone.addEventListener(ev, e => { e.preventDefault(); DOM.fileDropzone.classList.remove('dragover'); }));
    DOM.fileDropzone.addEventListener('drop', e => { if (e.dataTransfer?.files?.[0]) processUploadedFile(e.dataTransfer.files[0]); });
  }

  DOM.btnAttachToQuery.addEventListener('click', () => {
    if (!state.tempScan) return;
    state.attachedScan = state.tempScan;
    DOM.attachmentTitle.textContent = state.attachedScan.fileName;
    if (state.attachedScan.type === 'image') {
      DOM.attachmentThumb.src = state.attachedScan.dataUrl;
      DOM.attachmentThumb.style.display = 'block';
    } else {
      DOM.attachmentThumb.style.display = 'none';
    }
    DOM.composerAttachmentPreview.classList.add('active');
    closeUploadModal();
    DOM.inputPrompt.focus();
  });
  DOM.btnRemoveAttachment.addEventListener('click', clearAttachmentPreview);

  // Settings
  DOM.btnOpenSettings.addEventListener('click', openSettings);
  DOM.btnCloseSettingsModal.addEventListener('click', () => DOM.settingsModal?.classList.remove('active'));
  DOM.btnSaveSettings.addEventListener('click', saveSettings);

    // Floating Nav and Smooth Scrolling
  function jumpToSection(targetId) {
    if (targetId === 'aiSection') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const elTarget = document.getElementById(targetId);
      if (elTarget) {
        const topPos = elTarget.getBoundingClientRect().top + window.pageYOffset - 72;
        window.scrollTo({ top: topPos, behavior: 'smooth' });
      }
    }
  }

  if (DOM.navBtnAi) {
    DOM.navBtnAi.addEventListener('click', () => jumpToSection('aiSection'));
  }
  if (DOM.navBtnObservatory) {
    DOM.navBtnObservatory.addEventListener('click', () => jumpToSection('observatorySection'));
  }
  if (DOM.btnScrollToTop) {
    DOM.btnScrollToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }
  if (DOM.btnJumpObservatory) {
    DOM.btnJumpObservatory.addEventListener('click', () => jumpToSection('observatorySection'));
  }

  // IntersectionObserver for Floating Navigation
  if ('IntersectionObserver' in window && DOM.aiSection && DOM.observatorySection) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          if (entry.target.id === 'aiSection') {
            DOM.navBtnAi?.classList.add('active');
            DOM.navBtnObservatory?.classList.remove('active');
          } else if (entry.target.id === 'observatorySection') {
            DOM.navBtnObservatory?.classList.add('active');
            DOM.navBtnAi?.classList.remove('active');
          }
        }
      });
    }, { threshold: 0.25 });
    obs.observe(DOM.aiSection);
    obs.observe(DOM.observatorySection);
  }

  // Rainfall mode toggle
  if (DOM.btnRainModeMm) {
    DOM.btnRainModeMm.addEventListener('click', () => {
      DOM.btnRainModeMm.classList.add('active');
      DOM.btnRainModeProb?.classList.remove('active');
      updateRainfallWaveChart(null, 'mm');
    });
  }
  if (DOM.btnRainModeProb) {
    DOM.btnRainModeProb.addEventListener('click', () => {
      DOM.btnRainModeProb.classList.add('active');
      DOM.btnRainModeMm?.classList.remove('active');
      updateRainfallWaveChart(null, 'prob');
    });
  }

  // Rainfall interactive chart scrubber
  if (DOM.rainfallChartBox) {
    DOM.rainfallChartBox.addEventListener('mousemove', handleRainChartScrub);
    DOM.rainfallChartBox.addEventListener('mouseleave', hideRainChartScrub);
    DOM.rainfallChartBox.addEventListener('touchmove', handleRainChartScrub, { passive: true });
    DOM.rainfallChartBox.addEventListener('touchend', hideRainChartScrub);
  }

  // Detail Modal Open / Close buttons
  if (DOM.btnOpenPressureDetails) {
    DOM.btnOpenPressureDetails.addEventListener('click', openPressureDetailsModal);
  }
  if (DOM.btnClosePressureModal) {
    DOM.btnClosePressureModal.addEventListener('click', closePressureDetailsModal);
  }
  if (DOM.btnOpenPrecipDetails) {
    DOM.btnOpenPrecipDetails.addEventListener('click', openPrecipDetailsModal);
  }
  if (DOM.btnClosePrecipModal) {
    DOM.btnClosePrecipModal.addEventListener('click', closePrecipDetailsModal);
  }

  // PWA
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); state.pwaPromptEvent = e;
    if (DOM.btnInstallPwa) DOM.btnInstallPwa.style.display = 'inline-flex';
  });
  if (DOM.btnInstallPwa) {
    DOM.btnInstallPwa.addEventListener('click', async () => {
      if (!state.pwaPromptEvent) return;
      state.pwaPromptEvent.prompt();
      const choice = await state.pwaPromptEvent.userChoice;
      if (choice.outcome === 'accepted') DOM.btnInstallPwa.style.display = 'none';
      state.pwaPromptEvent = null;
    });
  }

  // Service Worker
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  // Camera Studio Event Wiring
  if (DOM.btnSnapPhoto) DOM.btnSnapPhoto.addEventListener('click', snapCameraPhoto);
  if (DOM.btnSwitchCamera) DOM.btnSwitchCamera.addEventListener('click', flipCamera);
  if (DOM.btnRetakePhoto) DOM.btnRetakePhoto.addEventListener('click', retakeCameraPhoto);
  if (DOM.btnSubmitPhotoQuery) DOM.btnSubmitPhotoQuery.addEventListener('click', submitCameraQuery);

  document.querySelectorAll('.cam-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (DOM.cameraPromptInput) DOM.cameraPromptInput.value = chip.dataset.q || '';
    });
  });

  // Clickable Detail Modals
  function wireModal(triggerEl, modalEl, closeBtnEl, onOpen) {
    if (!triggerEl || !modalEl) return;
    triggerEl.style.cursor = 'pointer';
    triggerEl.addEventListener('click', () => {
      modalEl.style.display = 'flex';
      if (onOpen) onOpen();
    });
    if (closeBtnEl) {
      closeBtnEl.addEventListener('click', () => { modalEl.style.display = 'none'; });
    }
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) modalEl.style.display = 'none';
    });
  }

  // Pressure Modal
  wireModal(DOM.btnOpenPressureDetails, DOM.modalPressureDetails, DOM.btnClosePressureModal);
  wireModal(DOM.pressureWidgetCard, DOM.modalPressureDetails, DOM.btnClosePressureModal);

  // Precipitation Modal
  wireModal(DOM.btnOpenPrecipDetails, DOM.modalPrecipDetails, DOM.btnClosePrecipModal);
  wireModal(DOM.rainfallWaveCard, DOM.modalPrecipDetails, DOM.btnClosePrecipModal);

  // Wind Modal
  wireModal(document.querySelector('.compass-visual-wrap')?.parentElement, DOM.modalWindDetails, DOM.btnCloseWindModal, () => {
    const cur = state.latestWeatherData?.current || {};
    const spd = cur.wind_speed_10m ?? 18;
    const dir = cur.wind_direction_10m ?? 240;
    const gusts = cur.wind_gusts_10m ?? Math.round(spd * 1.35);
    const dirLbl = state.latestWeatherData?.wind_direction_label || 'WSW';
    const dSpd = document.getElementById('detailWindSpeed');
    const dGust = document.getElementById('detailWindGusts');
    const dDir = document.getElementById('detailWindDirection');
    const dBft = document.getElementById('detailWindBeaufort');
    if (dSpd) dSpd.textContent = `${spd} km/h`;
    if (dGust) dGust.textContent = `${gusts} km/h`;
    if (dDir) dDir.textContent = `${dir}° (${dirLbl})`;
    if (dBft) dBft.textContent = `Beaufort: Force ${Math.min(12, Math.floor(spd / 6))}`;
  });

  // Thermal Modal
  wireModal(document.getElementById('ringFeelsLike')?.closest('.circular-gauge-card'), DOM.modalThermalDetails, DOM.btnCloseThermalModal, () => {
    const cur = state.latestWeatherData?.current || {};
    const t = cur.temperature_2m ?? 22;
    const ap = cur.apparent_temperature ?? 23;
    const hum = cur.relative_humidity_2m ?? 88;
    const dDry = document.getElementById('detailDryTemp');
    const dApp = document.getElementById('detailApparentTemp');
    const dHum = document.getElementById('detailHumidity');
    const dDew = document.getElementById('detailDewPoint');
    if (dDry) dDry.textContent = `${t}°C`;
    if (dApp) dApp.textContent = `${ap}°C`;
    if (dHum) dHum.textContent = `${hum}%`;
    if (dDew) dDew.textContent = `${(t - (100 - hum) / 5).toFixed(1)}°C`;
  });

  // AQI Modal
  wireModal(DOM.dashAqiCard, DOM.modalAqiDetails, DOM.btnCloseAqiModal, () => {
    const aqi = state.latestWeatherData?.air_quality || {};
    const dUs = document.getElementById('detailUsAqi');
    const dEu = document.getElementById('detailEuAqi');
    const dP25 = document.getElementById('detailPM25');
    const dP10 = document.getElementById('detailPM10');
    if (dUs) dUs.textContent = String(aqi.us_aqi || 38);
    if (dEu) dEu.textContent = String(aqi.european_aqi || 25);
    if (dP25) dP25.textContent = `${aqi.pm2_5 || 8.4} µg/m³`;
    if (dP10) dP10.textContent = `${aqi.pm10 || 16.2} µg/m³`;
  });

  // Solar UV Modal with complete hourly profile and WHO guidance
  wireModal(DOM.dashSolarUvCard, DOM.modalUvDetails, DOM.btnCloseUvModal, () => {
    const weather = state.latestWeatherData || {};
    const cur = weather.current || {};
    const daily = weather.daily_weather || {};
    const hourly = weather.hourly_weather || {};

    let uv = 0.0;
    if (cur.uv_index != null) {
      uv = Number(cur.uv_index);
    } else if (hourly?.uv_index && hourly.time) {
      const curHourPrefix = (cur.time || new Date().toISOString()).slice(0, 13);
      const idx = hourly.time.findIndex(t => t.startsWith(curHourPrefix));
      if (idx !== -1 && hourly.uv_index[idx] != null) uv = Number(hourly.uv_index[idx]);
    }

    const uvMax = daily.uv_index_max?.[0] != null ? Number(daily.uv_index_max[0]) : uv;

    const dUv = document.getElementById('detailUvIndex');
    const dCat = document.getElementById('detailUvCategory');
    const dPeak = document.getElementById('detailUvPeakHour');
    const dPeakVal = document.getElementById('detailUvPeakVal');
    const dBurn = document.getElementById('detailBurnTime');
    const dProt = document.getElementById('detailProtection');

    if (dUv) dUv.textContent = uv.toFixed(1);

    // Calculate category, burn time, protection
    let cat = 'Low';
    let burn = 'No sunburn risk';
    let prot = 'None required for normal exposure';
    if (uv >= 11) {
      cat = 'Extreme';
      burn = '< 10 minutes';
      prot = 'SPF 50+, UV sunglasses, hat, full shade';
    } else if (uv >= 8) {
      cat = 'Very High';
      burn = '~15 - 25 minutes';
      prot = 'SPF 50+, wide-brim hat, seek shade';
    } else if (uv >= 6) {
      cat = 'High';
      burn = '~30 - 40 minutes';
      prot = 'SPF 30+, sunglasses, hat';
    } else if (uv >= 3) {
      cat = 'Moderate';
      burn = '~45 - 60 minutes';
      prot = 'SPF 30+ & sunglasses if in direct sun';
    }

    if (dCat) dCat.textContent = cat;
    if (dBurn) dBurn.textContent = burn;
    if (dProt) dProt.textContent = prot;

    // Peak UV calculation from today's hourly data (first 24 slots)
    if (hourly.uv_index && hourly.time) {
      const todayUv = hourly.uv_index.slice(0, 24);
      let maxVal = -1;
      let maxHour = 12;
      todayUv.forEach((val, h) => {
        if (val != null && val > maxVal) {
          maxVal = val;
          maxHour = h;
        }
      });

      const startH = String(Math.max(0, maxHour - 1)).padStart(2, '0');
      const endH = String(Math.min(23, maxHour + 1)).padStart(2, '0');
      if (dPeak) dPeak.textContent = `${startH}:00 - ${endH}:00`;
      if (dPeakVal) dPeakVal.textContent = `Max UV: ${maxVal >= 0 ? maxVal.toFixed(1) : uvMax.toFixed(1)}`;

      // Render 24-Hour UV Bar Profile
      const track = document.getElementById('uvHourlyCurveTrack');
      if (track) {
        track.innerHTML = '';
        todayUv.forEach((val, h) => {
          const v = val != null ? Number(val) : 0;
          const heightPct = Math.min(100, Math.max(4, (v / 11) * 100));
          let barColor = '#48ca9b';
          if (v >= 11) barColor = '#b388ff';
          else if (v >= 8) barColor = '#f26464';
          else if (v >= 6) barColor = '#f6ae2d';
          else if (v >= 3) barColor = '#ffca28';

          const col = document.createElement('div');
          col.className = 'uv-bar-col';
          col.title = `${String(h).padStart(2, '0')}:00 - UV Index: ${v.toFixed(1)}`;
          col.innerHTML = `
            <span class="uv-bar-val" style="color:${barColor};">${v > 0.4 ? v.toFixed(1) : ''}</span>
            <div class="uv-bar-pill" style="height:${heightPct}%; background:${barColor};"></div>
            <span class="uv-bar-time">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
          `;
          track.appendChild(col);
        });
      }
    }
  });

  // Speaking Banner Stop button
  if (DOM.btnStopSpeechBanner) {
    DOM.btnStopSpeechBanner.addEventListener('click', () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (DOM.aiSpeakingBanner) DOM.aiSpeakingBanner.style.display = 'none';
      state.currentlyPlayingMsgId = null;
    });
  }

  // Deep-link actions
  const p = new URLSearchParams(window.location.search);
  if (p.get('action') === 'voice')  setTimeout(startListening, 600);
  if (p.get('action') === 'cam' || p.get('action') === 'camera') setTimeout(openCameraModal, 400);
  if (p.get('action') === 'upload' || p.get('action') === 'scan' || p.get('action') === 'doc') setTimeout(openUploadModal, 400);

  // Apply saved language on load
  if (state.settings.language && state.settings.language !== 'auto') {
    updateLanguageBadge(state.settings.language);
  }

  // Initialize interactive weather radar simulation
  initRadarCanvas();

  updateCharCount();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEvents);
} else {
  // DOM already interactive or complete — initialize immediately
  initEvents();
}


// Canonical Pipeline Exports
window.submitQuery = handleSend;
window.handleSend = handleSend;

// ============================================================================
// ATMOS-X UI ANIMATIONS MODULE
// Phase 2: Contextual Weather Loader  |  Phase 3: Dynamic Effects
// ============================================================================

// ── Phase 2: Loader element (injected once into the DOM) ──────────────────
const _loaderHTML = `
<div id="atmosLoader" class="atmos-loader" aria-live="polite" aria-label="Loading weather data">
  <div class="atmos-loader-sun">
    <div class="atmos-loader-ring"></div>
    <div class="atmos-loader-rays"></div>
    <div class="atmos-loader-core"></div>
  </div>
  <span class="atmos-loader-label">Fetching live telemetry…</span>
</div>
<div id="atmosLoaderError" class="atmos-loader-error" aria-live="assertive" role="alert">
  <span>⚡</span>
  <span id="atmosLoaderErrorMsg">Unable to fetch weather data. Please try again.</span>
</div>`;

function _injectLoader() {
  if (document.getElementById('atmosLoader')) return;
  const target = DOM.messagesContainer || document.body;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = _loaderHTML;
  while (wrapper.firstChild) target.prepend(wrapper.firstChild);
}

function showWeatherLoader(labelText) {
  _injectLoader();
  const loader = document.getElementById('atmosLoader');
  const errEl  = document.getElementById('atmosLoaderError');
  if (loader) {
    const lbl = loader.querySelector('.atmos-loader-label');
    if (lbl && labelText) lbl.textContent = labelText;
    loader.classList.add('active');
  }
  if (errEl) errEl.classList.remove('active');
}

function hideWeatherLoader() {
  const loader = document.getElementById('atmosLoader');
  if (loader) loader.classList.remove('active');
}

function showWeatherLoaderError(msg) {
  hideWeatherLoader();
  _injectLoader();
  const errEl  = document.getElementById('atmosLoaderError');
  const msgEl  = document.getElementById('atmosLoaderErrorMsg');
  if (errEl) {
    if (msgEl) msgEl.textContent = msg || 'Unable to fetch weather data. Please try again.';
    errEl.classList.add('active');
    // Auto-dismiss after 5s
    setTimeout(() => errEl.classList.remove('active'), 5000);
  }
}

// Expose loader API globally for use from refreshDashboardWeather patch
window.atmosUI = { showWeatherLoader, hideWeatherLoader, showWeatherLoaderError };

// ── Silent dashboard refresh — runs in background without loader / overlay ──
const _origRefreshDashboard = refreshDashboardWeather;
async function refreshDashboardWeatherSilent(station) {
  try {
    await _origRefreshDashboard(station);
    _applyWeatherStateClass(state.latestWeatherData);
  } catch (e) {
    console.warn('[AtmosX UI] Dashboard refresh error:', e.message);
  }
}
window.refreshDashboardWeather = refreshDashboardWeatherSilent;

// ── Phase 3: Weather-state body background class toggler ─────────────────
const WEATHER_STATE_CLASSES = ['bg-sunny', 'bg-rainy', 'bg-stormy', 'bg-cloudy', 'bg-foggy', 'bg-snowy'];

function _weatherCodeToStateClass(code) {
  const c = Number(code);
  if (c === 0 || c === 1)                                    return 'bg-sunny';
  if (c === 2 || c === 3)                                    return 'bg-cloudy';
  if (c === 45 || c === 48)                                  return 'bg-foggy';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(c))     return 'bg-rainy';
  if ([71, 73, 75, 77, 85, 86].includes(c))                  return 'bg-snowy';
  if ([95, 96, 99].includes(c))                              return 'bg-stormy';
  return 'bg-cloudy';
}

function _conditionTextToStateClass(condText) {
  if (!condText) return null;
  const lc = condText.toLowerCase();
  if (lc.includes('thunder') || lc.includes('storm') || lc.includes('cyclone') || lc.includes('lightning')) return 'bg-stormy';
  if (lc.includes('rain') || lc.includes('shower') || lc.includes('drizzle') || lc.includes('flood'))       return 'bg-rainy';
  if (lc.includes('snow') || lc.includes('hail') || lc.includes('sleet'))                                   return 'bg-snowy';
  if (lc.includes('fog') || lc.includes('mist') || lc.includes('haze'))                                     return 'bg-foggy';
  if (lc.includes('cloud') || lc.includes('overcast'))                                                      return 'bg-cloudy';
  if (lc.includes('clear') || lc.includes('sunny') || lc.includes('fair') || lc.includes('warm'))           return 'bg-sunny';
  return null;
}

function _applyWeatherStateClass(data) {
  if (!data) return;
  const code      = data.current?.weather_code;
  const condText  = data.condition || '';
  let stateClass  = (code != null) ? _weatherCodeToStateClass(code) : _conditionTextToStateClass(condText);
  if (!stateClass) stateClass = _conditionTextToStateClass(condText) || 'bg-cloudy';

  // Remove all existing state classes, then add the new one
  document.body.classList.remove(...WEATHER_STATE_CLASSES);
  document.body.classList.add(stateClass);
}

// Also apply class from static station data (WEATHER_STATIONS) when renderEvidence fires
const _origRenderEvidence = renderEvidence;
function renderEvidenceAnimated(loc, scanned) {
  _origRenderEvidence(loc, scanned);

  // Apply weather-state class from station condition text
  if (loc?.forecast?.condition) {
    const cls = _conditionTextToStateClass(loc.forecast.condition);
    if (cls) {
      document.body.classList.remove(...WEATHER_STATE_CLASSES);
      document.body.classList.add(cls);
    }
  }

  // Phase 3: Staggered fade-in for evidence cards
  if (DOM.evidenceBody) {
    const cards = DOM.evidenceBody.querySelectorAll('.evidence-card');
    cards.forEach((card, idx) => {
      card.classList.remove('fade-in-stagger');
      // Force reflow to restart animation
      void card.offsetWidth;
      card.style.setProperty('--stagger-index', String(idx));
      card.classList.add('fade-in-stagger');
    });
  }
}
// Override global
window.renderEvidence = renderEvidenceAnimated;

// ── Phase 3: Staggered fade-in for hourly timeline slots ─────────────────
const _origUpdateHourlyTimeline = updateHourlyTimeline;
function updateHourlyTimelineAnimated(hourly) {
  _origUpdateHourlyTimeline(hourly);
  if (!DOM.hourlyScrollTrack) return;
  const slots = DOM.hourlyScrollTrack.querySelectorAll('.hourly-slot, .hero-slot-card');
  slots.forEach((slot, idx) => {
    slot.style.setProperty('--stagger-index', String(idx));
    slot.classList.add('fade-in-stagger');
  });
}
window.updateHourlyTimeline = updateHourlyTimelineAnimated;

// ── Phase 3: Staggered fade-in for hero hourly carousel ──────────────────
const _origUpdateHeroOverview = typeof updateHeroWeatherOverview === 'function' ? updateHeroWeatherOverview : null;
if (_origUpdateHeroOverview) {
  window.updateHeroWeatherOverview = function(data) {
    _origUpdateHeroOverview(data);
    if (DOM.heroHourlyCarousel) {
      const cards = DOM.heroHourlyCarousel.querySelectorAll('.hero-slot-card');
      cards.forEach((c, i) => {
        c.style.setProperty('--stagger-index', String(i));
        c.classList.add('fade-in-stagger');
      });
    }
  };
}

// Re-bind top-level exports silently (no overlay/splash triggers during queries)
window.submitQuery = submitQuery;
window.handleSend  = submitQuery;
window.fetchDashboardWeather = fetchDashboardWeather;
window.callBackendChatStream = callBackendChatStream;
window.weatherEmojis = weatherEmojis;
window.getConditionEmoji = getConditionEmoji;
window.updateDynamicWeatherIcon = updateDynamicWeatherIcon;
window.fetchCityMood = fetchCityMood;

// ============================================================================
// 5-SECOND CINEMATIC SPLASH SCREEN (Isolated DOMContentLoaded Sequence)
// Triggers its 5000ms setTimeout, hides the splash screen, never called again.
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;

  setTimeout(() => {
    splash.classList.add('hide-splash');
    // Remove from DOM after fade transition to release memory
    setTimeout(() => {
      if (splash && splash.parentNode) {
        splash.parentNode.removeChild(splash);
      }
    }, 1000);
    if (typeof isInitialLoad !== 'undefined') {
      isInitialLoad = false;
    }
  }, 5000);
});


// ============================================================================
// STOP FORM SUBMISSIONS: Attach event.preventDefault() directly to search & form submit
// ============================================================================
document.addEventListener('submit', (event) => {
  event.preventDefault();
});
window.addEventListener('submit', (event) => {
  event.preventDefault();
});

// ============================================================================
// REEL FLIP ANIMATION MODULE (Isolated Value Updates)
// updateMetricWithFlip(elementId, newValue)
// Stacks old and new values in .flip-reel, slides without layout shifts, cleans up on transitionend
// ============================================================================

/**
 * Isolated Value Updates: updateMetricWithFlip(elementId, newValue)
 * Dynamically stacks the old and new values into the .flip-reel,
 * triggers the slide without layout shifts, and cleans up the DOM on transitionend.
 *
 * @param {string|HTMLElement} elementId - The target element or its DOM ID
 * @param {string|number} newValue      - The new value to display
 */
function updateMetricWithFlip(elementId, newValue) {
  if (elementId == null || newValue == null) return;
  const el = typeof elementId === 'string' ? document.getElementById(elementId) : elementId;
  if (!el) return;

  const valStr = String(newValue);

  // Check if counter & reel are already initialized inside element
  let counter = el.classList.contains('flip-counter') ? el : el.querySelector('.flip-counter');
  let reel = counter ? counter.querySelector('.flip-reel') : null;

  if (!counter || !reel) {
    // Isolate change to text node — never wipe card containers via innerHTML
    const existingText = el.textContent.trim();
    el.textContent = '';

    counter = document.createElement('span');
    counter.className = 'flip-counter';

    reel = document.createElement('span');
    reel.className = 'flip-reel';

    const item = document.createElement('span');
    item.className = 'flip-item';
    item.textContent = existingText || valStr;
    reel.appendChild(item);

    counter.appendChild(reel);
    el.appendChild(counter);

    // Initial placeholder bypass without animation
    if (!existingText || existingText === '--' || existingText === '--°C' || existingText === '--%' || existingText === '--°') {
      item.textContent = valStr;
      return;
    }
  }

  // Inspect current visible value (last .flip-item)
  const currentItem = reel.querySelector('.flip-item:last-child') || reel.lastElementChild;
  if (currentItem && currentItem.textContent.trim() === valStr.trim()) {
    return; // Value unchanged, no flip needed
  }

  // During initial splash screen load, update directly without animation
  if (typeof isInitialLoad !== 'undefined' && isInitialLoad) {
    if (currentItem) {
      currentItem.textContent = valStr;
    } else {
      const item = document.createElement('span');
      item.className = 'flip-item';
      item.textContent = valStr;
      reel.appendChild(item);
    }
    return;
  }

  // Clean up any in-flight transition on this reel before stacking
  if (reel._transitionTimer) {
    clearTimeout(reel._transitionTimer);
    reel._transitionTimer = null;
  }
  if (reel._onEnd) {
    reel.removeEventListener('transitionend', reel._onEnd);
    reel._onEnd = null;
  }
  while (reel.children.length > 1) {
    reel.removeChild(reel.firstElementChild);
  }
  reel.style.transition = 'none';
  reel.classList.remove('animate-flip');
  reel.style.transform = 'none';
  void reel.offsetHeight; // force layout reflow
  reel.style.transition = '';
  reel.style.transform = '';

  // Ensure current visible item has .flip-item class
  let oldItem = reel.querySelector('.flip-item:last-child') || reel.lastElementChild;
  if (!oldItem) {
    oldItem = document.createElement('span');
    oldItem.className = 'flip-item';
    oldItem.textContent = reel.textContent || '';
    reel.textContent = '';
    reel.appendChild(oldItem);
  }

  // Dynamically stack the new value into the .flip-reel
  const newItem = document.createElement('span');
  newItem.className = 'flip-item';
  newItem.textContent = valStr;
  reel.appendChild(newItem);

  // Clean up the DOM on transitionend
  const onTransitionEnd = (e) => {
    if (e && e.target !== reel) return;
    reel.removeEventListener('transitionend', onTransitionEnd);
    reel._onEnd = null;
    if (reel._transitionTimer) {
      clearTimeout(reel._transitionTimer);
      reel._transitionTimer = null;
    }

    // Remove the old value(s), keeping only the latest new value
    while (reel.children.length > 1) {
      reel.removeChild(reel.firstElementChild);
    }

    // Instantly reset track transform and transition without layout shifts
    reel.style.transition = 'none';
    reel.classList.remove('animate-flip');
    reel.style.transform = 'none';
    void reel.offsetHeight; // force layout reflow
    reel.style.transition = '';
    reel.style.transform = '';
  };

  reel._onEnd = onTransitionEnd;
  reel.addEventListener('transitionend', onTransitionEnd, { once: true });

  // Safety fallback in case the tab is in the background or transitionend is throttled
  reel._transitionTimer = setTimeout(onTransitionEnd, 520);

  // Trigger the slide without layout shifts on the next animation frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      reel.classList.add('animate-flip');
    });
  });
}

// Backward compatibility alias
const flipUpdate = updateMetricWithFlip;
window.updateMetricWithFlip = updateMetricWithFlip;
window.flipUpdate = updateMetricWithFlip;

/**
 * Topbar ambient pill helper
 */
function updateTopbarWeatherPill(w, data) {
  if (DOM.topbarWeatherText && w.temperature_2m != null) {
    const cond = data.condition || '';
    const loc  = data.location  || (state.currentStation?.name || '');
    updateMetricWithFlip(DOM.topbarWeatherText, `${Math.round(w.temperature_2m)}°C · ${loc} (${cond})`);
  }
}

// ============================================================================
// SCROLL-TRIGGERED POP-UP ANIMATIONS (Intersection Observer API)
// Mobile-friendly, threshold: 0.15, triggers on scroll up and down
// Does not alter window properties
// ============================================================================
function initScrollReveal() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.scroll-reveal').forEach((el) => {
      el.classList.add('is-visible');
    });
    return;
  }

  const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      } else {
        entry.target.classList.remove('is-visible');
      }
    });
  }, {
    threshold: 0.15
  });

  document.querySelectorAll('.scroll-reveal').forEach((el) => {
    scrollObserver.observe(el);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScrollReveal);
} else {
  initScrollReveal();
}


