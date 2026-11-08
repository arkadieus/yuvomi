/**
 * Stała sekcja „Zainstaluj aplikację” dla stron przed zalogowaniem (rejestracja, zaproszenie, logowanie).
 * Zawsze widoczna (poza zainstalowaną aplikacją); gdy przeglądarka nie daje instalacji jednym kliknięciem,
 * instrukcja ręczna jest pokazywana od razu.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { getPwaInstallState, onPwaInstallStateChanged, promptPwaInstall } from '/utils/pwa-install.js';

const SHARE_ICON = "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23007AFF%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8%22/><polyline points=%2216 6 12 2 8 6%22/><line x1=%2212%22 y1=%222%22 x2=%2212%22 y2=%2215%22/></svg>') center/contain no-repeat";
// Baner na SAMEJ GÓRZE stron logowania/rejestracji: ma być nie do przeoczenia.
// Kolory celowo stałe (ciemny granat + żółty przycisk) — czytelne w jasnym i ciemnym motywie.
const BANNER = 'width:100%;max-width:28rem;box-sizing:border-box;margin:0 auto 1rem;padding:1rem 1.1rem;border-radius:14px;background:#14213d;color:#fff;border:3px solid #fca311;box-shadow:0 4px 14px rgba(0,0,0,.25)';
const BANNER_TEXT = 'margin:0 0 .75rem;font-size:.95rem;line-height:1.4;color:#e8ecf5';
const BANNER_BTN = 'width:100%;padding:.85rem 1rem;font-size:1.1rem;font-weight:800;border:0;border-radius:10px;background:#fca311;color:#14213d;cursor:pointer;text-transform:uppercase;letter-spacing:.03em';

export function installSectionHtml() {
  return `
        <div data-install-section role="region" aria-label="Zainstaluj aplikację" style="${BANNER}">
          <p style="margin:0 0 .35rem;font-size:1.25rem;font-weight:800;letter-spacing:.02em;color:#fca311">📲 ZAINSTALUJ APLIKACJĘ</p>
          <p style="${BANNER_TEXT}">Dodaj ${esc(t('install.title').replace(/^Zainstaluj\s+/i, ''))} na ekran główny telefonu — działa jak zwykła aplikacja, otwiera się jednym kliknięciem i dostajesz powiadomienia.</p>
          <div data-install-ios hidden style="${BANNER_TEXT}">
            <strong>iPhone / iPad:</strong> ${esc(t('install.iosTip1'))}<span aria-label="udostępnij" style="display:inline-block;vertical-align:middle;width:1.2em;height:1.2em;background:${SHARE_ICON}"></span>${esc(t('install.iosTip2'))}
          </div>
          <p data-install-manual hidden style="${BANNER_TEXT}"><strong>Jak zainstalować:</strong> ${esc(t('settings.pwaInstallUnavailable'))}</p>
          <button type="button" data-install-btn style="${BANNER_BTN}" hidden>⬇ ${esc(t('install.installButton'))}</button>
        </div>`;
}

/**
 * @param {ParentNode} container
 * @param {{ onInstalled?: () => void }} [opts] wywoływane po instalacji, gdy `markDone()` już zawołano
 * @returns {{ markDone: () => void }}
 */
export function wireInstallSection(container, { onInstalled } = {}) {
  const section = container.querySelector('[data-install-section]');
  if (!section) return { markDone() {} };
  const iosHint = section.querySelector('[data-install-ios]');
  const manualHint = section.querySelector('[data-install-manual]');
  const btn = section.querySelector('[data-install-btn]');
  let done = false;

  const applyState = (s) => {
    if (s.installed) {
      if (done) { unsub?.(); onInstalled?.(); return; }
      section.hidden = true;
      return;
    }
    section.hidden = false;
    // iOS: instrukcja tekstowa, bez przycisku
    if (iosHint) iosHint.hidden = !s.ios;
    // Instrukcja ręczna: pokaż gdy przeglądarka nie obsługuje instalacji
    // jednym kliknięciem (nie iOS, nie canPrompt).
    if (manualHint) manualHint.hidden = s.ios || s.canPrompt;
    // Przycisk: tylko gdy jest co klikać (canPrompt). Na iOS instrukcja
    // zastępuje przycisk. Gdy brak obu — ukryj przycisk zamiast pokazywać
    // martwy element bez efektu.
    if (btn) btn.hidden = !s.canPrompt;
  };

  const unsub = onPwaInstallStateChanged(applyState);

  btn?.addEventListener('click', async () => {
    let outcome;
    try { ({ outcome } = await promptPwaInstall()); } catch { outcome = 'unavailable'; }
    if (outcome === 'unavailable') {
      // canPrompt przepadł (odrzucono lub zniknął) — pokaż instrukcję ręczną,
      // ukryj przycisk żeby nie kusić do ponownego kliknięcia.
      if (manualHint) manualHint.hidden = false;
      if (btn) btn.hidden = true;
    }
    if (outcome === 'ios' && iosHint) iosHint.hidden = false;
    if (outcome === 'accepted' && done) onInstalled?.();
  });

  return {
    markDone() {
      done = true;
      if (getPwaInstallState().installed) setTimeout(() => onInstalled?.(), 1500);
    },
  };
}
