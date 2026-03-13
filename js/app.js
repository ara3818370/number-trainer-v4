// app.js — Orchestrator: navigation, lifecycle, event wiring
// Phase 2d: Reading mode fallback, mode toggle, voiceschanged handling

import * as tts from './tts.js';
import * as game from './game.js';
import * as ui from './ui.js';
import * as storage from './storage.js';
import { CATEGORY_GROUPS, CATEGORY_META } from './categories.js';
import {
  initI18n, t, applyTranslations, getUILang, setUILang,
  getLearnLang, setLearnLang, getCategoryLabel, getCategoryDesc,
  getGroupLabel, getLangName,
} from './i18n.js';

// ── Constants ──────────────────────────────────────────────────────────────

const AUTO_ADVANCE_DELAY_MS = 1500;
const WRONG_REPLAY_DELAY_MS = 500;

// ── State ──────────────────────────────────────────────────────────────────

let currentSpeed = 'normal';
let lastMode = null;
let ttsReady = false;
let currentTheme = 'auto';
let sessionLength = 10;

// ── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize i18n FIRST (before any UI rendering)
  initI18n();

  ui.initScreens();

  // Load saved preferences
  currentSpeed = storage.get('speed', 'normal');
  ui.setActiveSpeed(currentSpeed);

  currentTheme = storage.get('theme', 'auto');
  applyTheme(currentTheme);

  sessionLength = storage.get('sessionLength', 10);
  ui.setActiveSessionLength(sessionLength);

  // Initialize TTS (also loads TTS mode from localStorage)
  ttsReady = await tts.init();

  // Set up voice change listener for async voice loading
  tts.onVoiceChange((availableLangs) => {
    // Voice availability changed — update mode toggle and reading mode state
    updateModeUI();

    // If we were in auto mode and voice just became available, notify user
    if (tts.getTTSMode() === 'auto' && tts.hasVoiceForLearnLang()) {
      ui.showToast(t('reading.voice_available'));
    }
  });

  // Show reading mode notification if no voice (instead of error screen)
  if (!tts.hasVoiceForLearnLang()) {
    const learnLang = getLearnLang();
    const langName = getLangName(learnLang);
    // Don't block with error screen — show toast and enable reading mode
    if (learnLang === 'uk' && tts.hasNoUkrainianVoice()) {
      ui.showToast(t('toast.no_voice_uk'));
    } else if (learnLang === 'de' && tts.hasNoGermanVoice()) {
      ui.showToast(t('toast.no_voice_de'));
    } else if (tts.hasNoEnglishVoice()) {
      ui.showToast(t('toast.no_voice_en'));
    }
  }

  tts.onInterrupt(() => {});

  // Build category menu
  renderCategoryGroups();

  // Wire up all event handlers
  wireOnboarding();
  wireMenu();
  wireTraining();
  wireSummary();
  wireSpeedControls();
  wireThemeToggle();
  wireSessionLength();
  wireBackButton();
  wireError();
  wireLanguageSwitchers();
  wireModeToggle();

  // Apply i18n translations to static elements
  applyTranslations();

  // Update mode toggle initial state
  updateModeUI();

  // Decide which screen to show
  const onboarded = storage.get('onboarded', false);
  if (!onboarded) {
    ui.showScreen('onboarding');
  } else {
    ui.showScreen('menu');
  }

  registerSW();
});

// ── Service Worker Registration ────────────────────────────────────────────

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ── Theme ──────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.removeAttribute('data-theme');
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

  storage.set('theme', theme);
  ui.updateThemeIcon(theme);

  const isDark = theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const color = isDark ? '#1c1c1e' : '#f5f5f7';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.setAttribute('content', color);
  });
}

function wireThemeToggle() {
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.addEventListener('click', () => {
      currentTheme = ui.nextTheme(currentTheme);
      applyTheme(currentTheme);
      ui.showToast(t('theme.' + currentTheme));
    });
  }
}

function wireSessionLength() {
  document.querySelectorAll('.session-length-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sessionLength = parseInt(btn.dataset.length, 10);
      storage.set('sessionLength', sessionLength);
      ui.setActiveSessionLength(sessionLength);
    });
  });
}

function wireBackButton() {
  const btn = document.getElementById('btn-back');
  if (btn) {
    btn.addEventListener('click', () => {
      tts.stop();
      game.endSession();
      ui.showScreen('menu');
    });
  }
}

// ── Mode Toggle (Audio ↔ Reading) ──────────────────────────────────────────

/**
 * Update all mode-related UI: toggle button, reading indicator, speed control.
 */
function updateModeUI() {
  const isReading = tts.isReadingMode();
  const voiceAvailable = tts.hasVoiceForLearnLang();
  const learnLang = getLearnLang();
  const langName = getLangName(learnLang);

  ui.updateModeToggle(isReading, voiceAvailable);

  // Show reading mode indicator only if in reading mode and no voice
  // (user chose reading mode manually = don't show "no voice" indicator)
  if (isReading && !voiceAvailable) {
    ui.showReadingModeIndicator(true, langName);
  } else if (isReading && voiceAvailable) {
    // User chose reading mode manually — show lighter indicator
    ui.showReadingModeIndicator(false);
  } else {
    ui.showReadingModeIndicator(false);
  }

  // Show/hide speed control based on mode
  ui.showTrainingSpeedControl(!isReading);
}

/**
 * Wire the mode toggle button (🔊/📖).
 */
function wireModeToggle() {
  const btn = document.getElementById('btn-mode-toggle');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const currentMode = tts.getTTSMode();
    const voiceAvailable = tts.hasVoiceForLearnLang();

    if (currentMode === 'auto' || (currentMode !== 'reading')) {
      // Switch to reading mode
      tts.setTTSMode('reading');
      tts.stop();
      ui.showToast(t('reading.mode_reading'));
    } else {
      // Switch to auto (audio if voice available)
      if (voiceAvailable) {
        tts.setTTSMode('auto');
        ui.showToast(t('reading.mode_audio'));
      }
      // If no voice, can't switch — button should be disabled
    }

    updateModeUI();

    // If we're in a game, update the current round display
    const target = game.getCurrentTarget();
    if (target) {
      if (tts.isReadingMode()) {
        ui.showReadingCard(target.ttsText);
      } else {
        ui.hideReadingCard();
        // Replay audio for current round
        speakCurrent();
      }
    }
  });
}

// ── Language Switchers ─────────────────────────────────────────────────────

function wireLanguageSwitchers() {
  // UI language buttons
  document.querySelectorAll('.ui-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newLang = btn.dataset.lang;
      setUILang(newLang);
      updateLangButtonStates();
      renderCategoryGroups();
    });
  });

  // Learning language buttons
  document.querySelectorAll('.learn-lang-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newLang = btn.dataset.lang;
      setLearnLang(newLang);
      updateLangButtonStates();

      // Check voice availability for new learning language
      if (!tts.hasVoiceForLearnLang()) {
        if (newLang === 'uk') {
          ui.showToast(t('toast.no_voice_uk'));
        } else if (newLang === 'de') {
          ui.showToast(t('toast.no_voice_de'));
        } else {
          ui.showToast(t('toast.no_voice_en'));
        }
      }

      // Update mode UI (reading mode might change with language)
      updateModeUI();

      renderCategoryGroups();
    });
  });

  updateLangButtonStates();
}

function updateLangButtonStates() {
  const uiLang = getUILang();
  const learnLang = getLearnLang();

  document.querySelectorAll('.ui-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === uiLang);
  });

  document.querySelectorAll('.learn-lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === learnLang);
  });
}

// ── Category group rendering ───────────────────────────────────────────────

function renderCategoryGroups() {
  const container = document.getElementById('category-groups');
  if (!container) return;
  container.innerHTML = '';

  for (const group of CATEGORY_GROUPS) {
    const groupEl = document.createElement('div');
    groupEl.className = 'category-group';

    const label = document.createElement('div');
    label.className = 'category-group-label';
    label.textContent = getGroupLabel(group.id);
    groupEl.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'category-grid';
    if (group.categories.length === 1) {
      grid.classList.add('category-grid--single');
    }

    for (const catId of group.categories) {
      const meta = CATEGORY_META[catId];
      if (!meta) continue;

      const btn = document.createElement('button');
      btn.className = 'mode-btn';
      btn.dataset.mode = catId;
      btn.innerHTML = `<span class="mode-icon" aria-hidden="true">${meta.icon}</span>` +
        `<span>${getCategoryLabel(catId)}</span><br><small>${getCategoryDesc(catId)}</small>`;

      btn.addEventListener('click', () => {
        // No longer block on missing voice — reading mode handles it
        startTraining(catId);
      });

      grid.appendChild(btn);
    }

    groupEl.appendChild(grid);
    container.appendChild(groupEl);
  }
}

// ── Onboarding ─────────────────────────────────────────────────────────────

function wireOnboarding() {
  const btnStart = document.getElementById('btn-onboarding-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      storage.set('onboarded', true);
      if (ttsReady && !tts.isReadingMode()) tts.warmUp();
      ui.showScreen('menu');
    });
  }
}

// ── Menu ───────────────────────────────────────────────────────────────────

function wireMenu() {
  const btnHelp = document.getElementById('btn-help');
  if (btnHelp) {
    btnHelp.addEventListener('click', () => ui.showScreen('onboarding'));
  }
}

// ── Training ───────────────────────────────────────────────────────────────

function startTraining(mode) {
  lastMode = mode;
  game.startSession(mode);
  ui.showScreen('training');
  ui.showCategoryIndicator(mode);
  ui.updateScore(0, 0);
  updateModeUI();
  playNextRound();
}

function playNextRound() {
  const round = game.nextRound();
  ui.clearFeedback();
  ui.showNextButton(false);
  ui.showSkipButton(true);

  ui.renderOptions(round.options, handleAnswer);

  if (tts.isReadingMode()) {
    // Reading mode: show text card instead of playing audio
    ui.showReadingCard(round.target.ttsText);
  } else {
    // Audio mode: hide reading card, play audio
    ui.hideReadingCard();
    speakCurrent();
  }
}

function handleAnswer(selectedDisplay, buttonIndex) {
  const result = game.submitAnswer(selectedDisplay);
  if (!result) return;

  const score = game.getScore();
  ui.updateScore(score.correct, score.total);

  if (sessionLength > 0 && score.total >= sessionLength) {
    ui.showCorrect(result.correctIndex);
    if (!result.isCorrect) ui.showWrong(buttonIndex, result.correctIndex);
    ui.showSkipButton(false);
    setTimeout(() => {
      tts.stop();
      const stats = game.endSession();
      ui.showSummary(stats);
    }, AUTO_ADVANCE_DELAY_MS);
    return;
  }

  if (result.isCorrect) {
    ui.showCorrect(result.correctIndex);
    ui.showSkipButton(false);
    setTimeout(() => playNextRound(), AUTO_ADVANCE_DELAY_MS);
  } else {
    ui.showWrong(buttonIndex, result.correctIndex);
    ui.showSkipButton(false);
    ui.showNextButton(true);
    // In reading mode, don't replay audio on wrong answer
    if (!tts.isReadingMode()) {
      setTimeout(() => speakCurrent(), WRONG_REPLAY_DELAY_MS);
    }
  }
}

function speakCurrent() {
  // Don't attempt speech in reading mode
  if (tts.isReadingMode()) return;

  const sentence = game.getCurrentSentence();
  tts.speak(sentence, currentSpeed).catch(err => {
    if (err.message === 'offline') {
      ui.showOfflineWarning();
    } else if (err.message === 'tts_error') {
      ui.showToast(t('toast.tts_failed'));
    } else if (err.message === 'TTS not available') {
      // Voice became unavailable — switch to reading mode automatically
      tts.setTTSMode('auto'); // auto will detect no voice → reading mode
      updateModeUI();
      const target = game.getCurrentTarget();
      if (target) {
        ui.showReadingCard(target.ttsText);
      }
    }
  });
}

function wireTraining() {
  const btnReplay = document.getElementById('btn-replay');
  if (btnReplay) {
    btnReplay.addEventListener('click', () => speakCurrent());
  }

  const btnSkip = document.getElementById('btn-skip');
  if (btnSkip) {
    btnSkip.addEventListener('click', () => {
      const result = game.skipRound();
      if (!result) return;

      const score = game.getScore();
      ui.updateScore(score.correct, score.total);
      ui.lockButtons();
      ui.showCorrect(result.correctIndex);
      ui.showSkipButton(false);

      setTimeout(() => playNextRound(), AUTO_ADVANCE_DELAY_MS);
    });
  }

  const btnNext = document.getElementById('btn-next');
  if (btnNext) {
    btnNext.addEventListener('click', () => playNextRound());
  }

  const btnEnd = document.getElementById('btn-end');
  if (btnEnd) {
    btnEnd.addEventListener('click', () => {
      tts.stop();
      const stats = game.endSession();
      ui.showSummary(stats);
    });
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

function wireSummary() {
  const btnNewSession = document.getElementById('btn-new-session');
  if (btnNewSession) {
    btnNewSession.addEventListener('click', () => {
      if (lastMode) {
        startTraining(lastMode);
      } else {
        ui.showScreen('menu');
      }
    });
  }

  const btnHome = document.getElementById('btn-home');
  if (btnHome) {
    btnHome.addEventListener('click', () => ui.showScreen('menu'));
  }
}

// ── Speed controls ─────────────────────────────────────────────────────────

function wireSpeedControls() {
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSpeed = btn.dataset.speed;
      storage.set('speed', currentSpeed);
      ui.setActiveSpeed(currentSpeed);
    });
  });
}

// ── Error screen ───────────────────────────────────────────────────────────

function wireError() {
  const btnRetry = document.getElementById('btn-error-retry');
  if (btnRetry) {
    btnRetry.addEventListener('click', async () => {
      ttsReady = await tts.init();
      if (ttsReady && tts.hasVoiceForLearnLang()) {
        ui.showScreen('menu');
        updateModeUI();
      } else {
        // Instead of staying on error, go to menu with reading mode
        ui.showToast(t('toast.tts_still_unavailable'));
        ui.showScreen('menu');
        updateModeUI();
      }
    });
  }
}
