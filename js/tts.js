// tts.js — Web Speech API wrapper with iOS workarounds, offline detection, error handling
// Phase 2d: Hybrid TTS with reading mode fallback, voiceschanged handling, mode persistence

import { getLearnLang } from './i18n.js';

// ── Constants ──────────────────────────────────────────────────────────────

const VOICE_WAIT_TIMEOUT_MS = 3000;
const VOICE_POLL_INTERVAL_MS = 250;
const VOICE_POLL_MAX_MS = 3000;

const RATE_MAP = {
  slow: 0.7,
  normal: 1.0,
  fast: 1.3,
};

// Alternative voice codes to try when primary is missing
const VOICE_FALLBACKS = {
  en: ['en-US', 'en-GB', 'en-AU', 'en-NZ', 'en-ZA', 'en-IN', 'en-IE'],
  de: ['de-DE', 'de-AT', 'de-CH'],
  uk: ['uk-UA'],
  // NOTE: Russian (ru-RU) is FORBIDDEN as fallback for Ukrainian
};

// ── State ──────────────────────────────────────────────────────────────────

/** @type {SpeechSynthesisVoice|null} */
let selectedEnVoice = null;
/** @type {SpeechSynthesisVoice|null} */
let selectedDeVoice = null;
/** @type {SpeechSynthesisVoice|null} */
let selectedUkVoice = null;
let available = false;
let initialized = false;
let onInterruptCallback = null;
let noEnglishVoiceWarning = false;
let noGermanVoiceWarning = false;
let noUkrainianVoiceWarning = false;

/** @type {'auto'|'reading'} */
let ttsMode = 'auto';

/** @type {function|null} Callback when voice availability changes */
let onVoiceChangeCallback = null;

// ── TTS Mode (reading vs audio) ───────────────────────────────────────────

const TTS_MODE_KEY = 'nlt-tts-mode';

/**
 * Load TTS mode from localStorage.
 */
function loadTTSMode() {
  try {
    const saved = localStorage.getItem(TTS_MODE_KEY);
    if (saved === 'reading' || saved === 'auto') {
      ttsMode = saved;
    }
  } catch { /* ignore */ }
}

/**
 * Save TTS mode to localStorage.
 */
function saveTTSMode() {
  try {
    localStorage.setItem(TTS_MODE_KEY, ttsMode);
  } catch { /* ignore */ }
}

/**
 * Get the current TTS mode.
 * @returns {'auto'|'reading'}
 */
export function getTTSMode() {
  return ttsMode;
}

/**
 * Set the TTS mode.
 * @param {'auto'|'reading'} mode
 */
export function setTTSMode(mode) {
  if (mode !== 'auto' && mode !== 'reading') return;
  ttsMode = mode;
  saveTTSMode();
}

/**
 * Check if the app should be in reading mode right now.
 * Reading mode if: user chose 'reading' OR (mode is 'auto' AND no voice for current language).
 * @returns {boolean}
 */
export function isReadingMode() {
  if (ttsMode === 'reading') return true;
  if (ttsMode === 'auto' && !hasVoiceForLearnLang()) return true;
  return false;
}

// ── Voice selection ────────────────────────────────────────────────────────

/**
 * Select the best English voice from a list.
 * @param {SpeechSynthesisVoice[]} voices
 * @returns {SpeechSynthesisVoice|null}
 */
function selectBestEnglishVoice(voices) {
  if (!voices || voices.length === 0) return null;

  const preferred = voices.find(v =>
    /samantha|daniel/i.test(v.name) && v.lang.startsWith('en')
  );
  if (preferred) { noEnglishVoiceWarning = false; return preferred; }

  // Try fallback codes in order
  for (const code of VOICE_FALLBACKS.en) {
    const match = voices.find(v => v.lang === code);
    if (match) { noEnglishVoiceWarning = false; return match; }
  }

  const enAny = voices.find(v => v.lang.startsWith('en'));
  if (enAny) { noEnglishVoiceWarning = false; return enAny; }

  noEnglishVoiceWarning = true;
  return null;
}

/**
 * Select the best German voice from a list.
 * @param {SpeechSynthesisVoice[]} voices
 * @returns {SpeechSynthesisVoice|null}
 */
function selectBestGermanVoice(voices) {
  if (!voices || voices.length === 0) return null;

  const preferred = voices.find(v =>
    /anna|helena|petra|markus|yannick/i.test(v.name) && v.lang.startsWith('de')
  );
  if (preferred) { noGermanVoiceWarning = false; return preferred; }

  for (const code of VOICE_FALLBACKS.de) {
    const match = voices.find(v => v.lang === code);
    if (match) { noGermanVoiceWarning = false; return match; }
  }

  const deAny = voices.find(v => v.lang.startsWith('de'));
  if (deAny) { noGermanVoiceWarning = false; return deAny; }

  noGermanVoiceWarning = true;
  return null;
}

/**
 * Select the best Ukrainian voice from a list.
 * NOTE: Russian is FORBIDDEN as fallback.
 * @param {SpeechSynthesisVoice[]} voices
 * @returns {SpeechSynthesisVoice|null}
 */
function selectBestUkrainianVoice(voices) {
  if (!voices || voices.length === 0) return null;

  const preferred = voices.find(v =>
    /lesya|лесь|kateryna|катерин|olena|олен|dmytro|дмитр/i.test(v.name) && v.lang.startsWith('uk')
  );
  if (preferred) { noUkrainianVoiceWarning = false; return preferred; }

  for (const code of VOICE_FALLBACKS.uk) {
    const match = voices.find(v => v.lang === code);
    if (match) { noUkrainianVoiceWarning = false; return match; }
  }

  const ukAny = voices.find(v => v.lang.startsWith('uk'));
  if (ukAny) { noUkrainianVoiceWarning = false; return ukAny; }

  noUkrainianVoiceWarning = true;
  return null;
}

/**
 * Get the currently active voice based on learning language.
 * @returns {SpeechSynthesisVoice|null}
 */
function getActiveVoice() {
  const l = getLearnLang();
  if (l === 'uk') return selectedUkVoice;
  if (l === 'de') return selectedDeVoice;
  return selectedEnVoice;
}

// ── Voice availability detection ───────────────────────────────────────────

/**
 * Get a map of which languages have voices available.
 * @returns {{ en: boolean, de: boolean, uk: boolean }}
 */
export function getAvailableLanguages() {
  return {
    en: !!selectedEnVoice,
    de: !!selectedDeVoice,
    uk: !!selectedUkVoice,
  };
}

// ── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize TTS: wait for voices, select best voices for all languages.
 * Must be called once at startup. Returns true if TTS is usable.
 * @returns {Promise<boolean>}
 */
export function init() {
  // Load persisted TTS mode
  loadTTSMode();

  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      available = false;
      initialized = true;
      resolve(false);
      return;
    }

    /**
     * Process available voices and select best for each language.
     * @param {SpeechSynthesisVoice[]} voices
     */
    function processVoices(voices) {
      const prevEn = !!selectedEnVoice;
      const prevDe = !!selectedDeVoice;
      const prevUk = !!selectedUkVoice;

      selectedEnVoice = selectBestEnglishVoice(voices);
      selectedDeVoice = selectBestGermanVoice(voices);
      selectedUkVoice = selectBestUkrainianVoice(voices);
      available = !!(selectedEnVoice || selectedDeVoice || selectedUkVoice);
      initialized = true;

      // Notify if voice availability changed (for async voiceschanged)
      const changed = (!!selectedEnVoice !== prevEn) ||
                      (!!selectedDeVoice !== prevDe) ||
                      (!!selectedUkVoice !== prevUk);
      if (changed && onVoiceChangeCallback) {
        onVoiceChangeCallback(getAvailableLanguages());
      }
    }

    let voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      processVoices(voices);
      resolve(available);
      // Still listen for future voice changes
      setupVoicesChangedListener(processVoices);
      return;
    }

    let resolved = false;

    const onVoicesChanged = () => {
      if (resolved) return;
      voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        processVoices(voices);
        resolved = true;
        resolve(available);
      }
    };

    speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);

    let pollElapsed = 0;
    const pollTimer = setInterval(() => {
      pollElapsed += VOICE_POLL_INTERVAL_MS;
      voices = speechSynthesis.getVoices();
      if (voices.length > 0 && !resolved) {
        clearInterval(pollTimer);
        onVoicesChanged();
      }
      if (pollElapsed >= VOICE_POLL_MAX_MS && !resolved) {
        clearInterval(pollTimer);
        voices = speechSynthesis.getVoices();
        processVoices(voices);
        resolved = true;
        resolve(available);
      }
    }, VOICE_POLL_INTERVAL_MS);

    setTimeout(() => {
      if (!resolved) {
        clearInterval(pollTimer);
        voices = speechSynthesis.getVoices();
        processVoices(voices);
        resolved = true;
        resolve(available);
      }
    }, VOICE_WAIT_TIMEOUT_MS);

    // Set up persistent listener for future voice changes
    setupVoicesChangedListener(processVoices);
  });
}

/**
 * Set up a persistent voiceschanged listener to handle async voice loading.
 * @param {function} processVoices
 */
function setupVoicesChangedListener(processVoices) {
  if (!window.speechSynthesis) return;

  // Use a debounced listener to avoid rapid re-processing
  let debounceTimer = null;
  speechSynthesis.addEventListener('voiceschanged', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        processVoices(voices);
      }
    }, 100);
  });
}

// ── Voice change callback ──────────────────────────────────────────────────

/**
 * Register a callback for when voice availability changes.
 * Used by app.js to update UI when voices load asynchronously.
 * @param {function} callback - Receives { en: boolean, de: boolean, uk: boolean }
 */
export function onVoiceChange(callback) {
  onVoiceChangeCallback = callback;
}

// ── Speak ──────────────────────────────────────────────────────────────────

/**
 * Speak the given text using Web Speech API.
 * Uses the voice appropriate for the current learning language.
 * @param {string} text - Text to speak
 * @param {'slow'|'normal'|'fast'} speed - Speed preset name
 * @returns {Promise<void>} Resolves when speech ends, rejects on error
 */
export function speak(text, speed = 'normal') {
  return new Promise((resolve, reject) => {
    // In reading mode, don't attempt speech
    if (isReadingMode()) {
      resolve();
      return;
    }

    const voice = getActiveVoice();
    if (!available || !voice) {
      reject(new Error('TTS not available'));
      return;
    }

    speechSynthesis.cancel();

    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      const langMap = { de: 'de-DE', uk: 'uk-UA', en: 'en-US' };
      utterance.lang = voice.lang || langMap[getLearnLang()] || 'en-US';
      utterance.rate = RATE_MAP[speed] || 1.0;
      utterance.pitch = 1.0;

      utterance.onend = () => resolve();

      utterance.onerror = (event) => {
        if (!navigator.onLine) {
          reject(new Error('offline'));
        } else if (event.error === 'canceled') {
          resolve();
        } else {
          reject(new Error('tts_error'));
        }
      };

      speechSynthesis.speak(utterance);
    }, 100);
  });
}

// ── Warm-up (UX-002) ───────────────────────────────────────────────────────

/**
 * Silent warm-up for iOS: triggers speech in a user gesture handler.
 */
export function warmUp() {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(' ');
  utterance.volume = 0;
  const voice = getActiveVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || 'en-US';
  }
  speechSynthesis.speak(utterance);
}

// ── Stop ───────────────────────────────────────────────────────────────────

/**
 * Stop any ongoing speech.
 */
export function stop() {
  if (window.speechSynthesis) {
    speechSynthesis.cancel();
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

/**
 * Check if TTS is available and initialized.
 * @returns {boolean}
 */
export function isAvailable() {
  return available;
}

/**
 * Get the name of the selected voice for the current learn language.
 * @returns {string}
 */
export function getVoiceName() {
  const voice = getActiveVoice();
  return voice ? `${voice.name} (${voice.lang})` : 'none';
}

/**
 * Check if no English voice was found.
 * @returns {boolean}
 */
export function hasNoEnglishVoice() {
  return noEnglishVoiceWarning;
}

/**
 * Check if no German voice was found.
 * @returns {boolean}
 */
export function hasNoGermanVoice() {
  return noGermanVoiceWarning;
}

/**
 * Check if no Ukrainian voice was found.
 * @returns {boolean}
 */
export function hasNoUkrainianVoice() {
  return noUkrainianVoiceWarning;
}

/**
 * Check if the current learning language has a voice available.
 * @returns {boolean}
 */
export function hasVoiceForLearnLang() {
  return !!getActiveVoice();
}

// ── Visibility change handler ──────────────────────────────────────────────

/**
 * Set a callback for when TTS may have been interrupted by tab switch.
 * @param {function} callback
 */
export function onInterrupt(callback) {
  onInterruptCallback = callback;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
    } else if (onInterruptCallback) {
      onInterruptCallback();
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => stop());
}
