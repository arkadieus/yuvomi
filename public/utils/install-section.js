/**
 * Stała sekcja „Zainstaluj aplikację” dla stron przed zalogowaniem (rejestracja, zaproszenie, logowanie).
 * Zawsze widoczna (poza zainstalowaną aplikacją); gdy przeglądarka nie daje instalacji jednym kliknięciem,
 * instrukcja ręczna jest pokazywana od razu.
 */
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { getPwaInstallState, onPwaInstallStateChanged, promptPwaInstall } from '/utils/pwa-install.js';

const SHARE_ICON = "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23007AFF%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8%22/><polyline points=%2216 6 12 2 8 6%22/><line x1=%2212%22 y1=%222%22 x2=%2212%22 y2=%2215%22/></svg>') center/contain no-repeat";
const HINT = 'font-size:.875rem;color:var(--color-text-secondary,#666);margin:0 0 .75rem';

export function installSectionHtml() {
  return `
        <div data-install-section style="margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--color-border,#e5e3dd)">
          <p style="${HINT}">${esc(t('install.title'))}</p>
          <div data-install-ios hidden style="${HINT}">
            ${esc(t('install.iosTip1'))}<span aria-label="udostępnij" style="display:inline-block;vertical-align:middle;width:1.1em;height:1.1em;background:${SHARE_ICON}"></span>${esc(t('install.iosTip2'))}
          </div>
          <p data-install-manual hidden style="${HINT}">${esc(t('settings.pwaInstallUnavailable'))}</p>
          <button type="button" data-install-btn class="btn btn--secondary" style="width:100%" hidden>${esc(t('install.installButton'))}</button>
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
