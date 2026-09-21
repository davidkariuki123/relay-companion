/* The share-link explanation lives in the top layer, outside the scrolling row. */
(function (root) {
  root.RelayLinkTooltip = {
    install(document) {
      const view = document.defaultView;
      const tip = document.createElement('div');
      tip.id = 'relayLinkTooltip';
      tip.className = 'relay-link-tooltip';
      tip.setAttribute('popover', 'manual');
      tip.setAttribute('role', 'tooltip');
      tip.textContent = 'This link contains the Relay for you to share with others.';
      document.body.append(tip);
      let anchor = null, showTimer = null, hideTimer = null;
      const buttonOf = target => target?.closest?.('[data-relay-link]');
      function hide() {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        anchor = null;
        if (tip.matches(':popover-open')) tip.hidePopover();
      }
      function show(button) {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        if (!button?.isConnected) return;
        anchor = button; tip.showPopover();
        const box = button.getBoundingClientRect(), bounds = tip.getBoundingClientRect();
        tip.style.left = Math.max(12, Math.min(box.right - bounds.width, view.innerWidth - bounds.width - 12)) + 'px';
        tip.style.top = (box.top - bounds.height - 9 >= 8 ? box.top - bounds.height - 9 : box.bottom + 9) + 'px';
      }
      document.addEventListener('pointerover', event => {
        const button = buttonOf(event.target);
        if (!button || button.contains(event.relatedTarget)) return;
        clearTimeout(showTimer); clearTimeout(hideTimer);
        showTimer = setTimeout(() => show(button), 180);
      });
      document.addEventListener('pointerout', event => {
        const button = buttonOf(event.target);
        if (!button || button.contains(event.relatedTarget) || tip.contains(event.relatedTarget)) return;
        clearTimeout(showTimer);
        if (document.activeElement !== button) hideTimer = setTimeout(hide, 100);
      });
      document.addEventListener('focusin', event => { const button = buttonOf(event.target); if (button) show(button); });
      document.addEventListener('focusout', event => { if (buttonOf(event.target)) hide(); });
      document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
      document.addEventListener('scroll', hide, true);
      view.addEventListener('blur', hide);
      view.addEventListener('resize', hide);
      tip.addEventListener('pointerenter', () => clearTimeout(hideTimer));
      tip.addEventListener('pointerleave', () => { if (document.activeElement !== anchor) hide(); });
      new MutationObserver(() => { if (anchor && !anchor.isConnected) hide(); }).observe(document.body, { childList: true, subtree: true });
      return { hide, contains: target => tip.contains(target) };
    },
  };
})(window);
