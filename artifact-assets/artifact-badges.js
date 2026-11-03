(() => {
  'use strict';
  const items = [{"id": "805c51", "selector": "main > header", "title": "Tweet Planner und Vorschau"}, {"id": "cdcdcf", "selector": "#summary", "title": "Entwurfszusammenfassung"}, {"id": "edf2ab", "selector": "#thread", "title": "Beitragsarbeitsbereich"}, {"id": "cbb31f", "selector": ".planner-list", "title": "Gespeicherte Entwürfe"}, {"id": "71f933", "selector": "#post-editors", "title": "Beitragseditor"}, {"id": "e1fedf", "selector": ".preview-pane", "title": "Live-Vorschau"}, {"id": "74d093", "selector": ".versions", "title": "Benannte Versionen"}, {"id": "a0c5a8", "selector": ".history", "title": "Änderungsverlauf"}, {"id": "99dff0", "selector": ".media-page", "title": "Medienbibliothek"}, {"id": "d5faaa", "selector": ".ideas", "title": "Beitragsideen"}];
  function attach() {
    for (const item of items) {
      const host = document.querySelector(item.selector);
      if (!host || Array.from(host.children).some(n => n.dataset.aid === item.id)) continue;
      if (item.selector === '#summary' && !host.textContent.trim()) continue;
      host.classList.add('aid-host');
      const badge = document.createElement('span');
      badge.className = 'aid'; badge.dataset.aid = item.id;
      badge.textContent = 'a#' + item.id; badge.title = 'Artefakt-ID – klicken zum Kopieren';
      badge.setAttribute('role', 'button'); badge.tabIndex = 0;
      badge.setAttribute('aria-label', item.title + ': a#' + item.id + ' kopieren');
      async function copy(event) {
        event.preventDefault(); event.stopPropagation();
        const text = 'a#' + item.id;
        try {
          if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
          else {
            const field = document.createElement('textarea');
            field.value = text; field.style.position = 'fixed'; field.style.opacity = '0';
            document.body.append(field); field.select();
            const ok = document.execCommand('copy'); field.remove(); badge.focus();
            if (!ok) throw new Error('copy failed');
          }
          badge.title = 'Kopiert: ' + text;
        } catch { badge.title = 'Kopieren nicht möglich: ' + text; }
      }
      badge.addEventListener('click', copy);
      badge.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') copy(event); });
      host.append(badge);
    }
  }
  let queued = false;
  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; attach(); }); }
  });
  attach(); observer.observe(document.body, {childList:true, subtree:true});
})();
