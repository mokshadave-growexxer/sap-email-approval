// Client script for the bulk digest approval page. Served as an external file so
// it satisfies the app's CSP (script-src 'self'); inline scripts are blocked. It
// (1) captures the device/location footprint once and enables the action buttons,
// (2) drives select-all / per-row selection / search / expand, and (3) refuses to
// submit unless location is verified and at least one order is selected.
export const QUEUE_CLIENT_JS = `(function () {
  function init() {
    var form = document.querySelector('form[data-queue]');
    if (!form) return;
    var registerUrl = form.getAttribute('data-register-url');
    var processId = form.getAttribute('data-token');
    var statusBox = document.getElementById('geo-status');
    var statusText = document.getElementById('geo-text');
    var spinner = statusBox ? statusBox.querySelector('.spinner') : null;
    var retry = document.getElementById('geo-retry');
    var sessionInput = document.getElementById('session_id');
    var approveBtn = document.getElementById('approveBtn');
    var rejectBtn = document.getElementById('rejectBtn');
    var selectAll = document.getElementById('selectAll');
    var searchBox = document.getElementById('searchBox');
    var selectedCountEl = document.getElementById('selectedCount');
    var settled = false;
    // If the location cannot be fetched for ANY reason (denied, timed out, hung,
    // unsupported, non-HTTPS, register error), the approver may still decide
    // without it once this much time has passed since the page started.
    var FALLBACK_AFTER_MS = 10000;
    var REGISTER_TIMEOUT_MS = 15000;
    var startedAt = Date.now();
    var footprintOk = false;

    function checks() { return Array.prototype.slice.call(form.querySelectorAll('.row-check')); }
    function checkedCount() {
      return checks().filter(function (c) { return c.checked; }).length;
    }

    function updateButtons() {
      var n = checkedCount();
      if (selectedCountEl) selectedCountEl.textContent = String(n);
      var enabled = footprintOk && n > 0;
      if (approveBtn) approveBtn.disabled = !enabled;
      if (rejectBtn) rejectBtn.disabled = !enabled;
      syncSelectAll();
    }

    function syncSelectAll() {
      if (!selectAll) return;
      var all = checks();
      var visible = all.filter(function (c) { return !isRowHidden(c); });
      var checkedVisible = visible.filter(function (c) { return c.checked; });
      selectAll.checked = visible.length > 0 && checkedVisible.length === visible.length;
      selectAll.indeterminate = checkedVisible.length > 0 && checkedVisible.length < visible.length;
    }

    function isRowHidden(check) {
      var row = check.closest('.so-row');
      return row ? row.hasAttribute('hidden') : false;
    }

    function setStatus(text, kind) {
      if (statusText) statusText.textContent = text;
      if (statusBox) statusBox.className = 'status' + (kind ? ' ' + kind : '');
      if (kind && spinner) spinner.style.display = 'none';
    }

    function platformVersion() {
      try {
        if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
          return navigator.userAgentData
            .getHighEntropyValues(['platformVersion'])
            .then(function (h) { return h && h.platformVersion; })
            .catch(function () { return null; });
        }
      } catch (e) { /* ignore */ }
      return Promise.resolve(null);
    }

    function register(body) {
      return platformVersion().then(function (pv) {
        var payload = Object.assign({}, body, { ua_platform_version: pv });
        var request = fetch(registerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (r) { return r.json(); });
        var timeout = new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('register timeout')); }, REGISTER_TIMEOUT_MS);
        });
        return Promise.race([request, timeout]);
      });
    }

    function clientTimezone() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
    }

    function afterFallbackDelay(fn) {
      var remaining = FALLBACK_AFTER_MS - (Date.now() - startedAt);
      if (remaining > 0) setTimeout(fn, remaining);
      else fn();
    }

    function applyResult(res, okMsg, blockedMsg) {
      if (res && res.session_id) {
        sessionInput.value = res.session_id;
        footprintOk = true;
        setStatus(okMsg, 'ok');
      } else {
        footprintOk = false;
        setStatus(blockedMsg, 'err');
        if (retry) retry.style.display = 'inline-block';
      }
      updateButtons();
    }

    function fail(msg) {
      footprintOk = false;
      setStatus(msg, 'err');
      if (retry) retry.style.display = 'inline-block';
      updateButtons();
    }

    // Registers a location-less footprint immediately, but only unlocks the
    // decision once FALLBACK_AFTER_MS has elapsed since the page started.
    function proceedWithoutLocation(method) {
      setStatus('Location could not be fetched — you will be able to continue without it shortly…');
      var registration = register({ process_id: processId, geo_method: method, timezone: clientTimezone() })
        .then(function (res) { return { res: res }; }, function () { return { error: true }; });
      afterFallbackDelay(function () {
        registration.then(function (outcome) {
          if (outcome.error) {
            fail('Could not register your device. Please check your connection and reload this page.');
            return;
          }
          applyResult(
            outcome.res,
            'Location unavailable — you may approve or reject without it.',
            'This approval link could not be verified. Please reload this page or reopen the link from your email.'
          );
        });
      });
    }

    function onGranted(pos) {
      if (settled) return;
      settled = true;
      register({
        process_id: processId,
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timezone: clientTimezone(),
      }).then(function (res) {
        if (res && res.session_id) applyResult(res, 'Verified — you may approve or reject.', '');
        else proceedWithoutLocation('unavailable');
      }).catch(function () {
        proceedWithoutLocation('unavailable');
      });
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      var method = 'unavailable';
      if (err && err.code === 1) method = 'denied';
      else if (err && err.code === 3) method = 'timeout';
      proceedWithoutLocation(method);
    }

    // Selection wiring.
    form.addEventListener('change', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('row-check')) {
        updateButtons();
      }
    });
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        var visible = checks().filter(function (c) { return !isRowHidden(c); });
        visible.forEach(function (c) { c.checked = selectAll.checked; });
        updateButtons();
      });
    }

    // Expand / collapse line items.
    form.addEventListener('click', function (e) {
      var chev = e.target.closest ? e.target.closest('.chevron') : null;
      if (!chev) return;
      e.preventDefault();
      var row = chev.closest('.so-row');
      if (!row) return;
      var panel = row.querySelector('.so-items-panel');
      if (!panel) return;
      var isHidden = panel.hasAttribute('hidden');
      if (isHidden) { panel.removeAttribute('hidden'); row.classList.add('expanded'); }
      else { panel.setAttribute('hidden', ''); row.classList.remove('expanded'); }
    });

    // Search filter.
    if (searchBox) {
      searchBox.addEventListener('input', function () {
        var q = searchBox.value.trim().toLowerCase();
        checks().forEach(function (c) {
          var row = c.closest('.so-row');
          if (!row) return;
          var hay = (row.getAttribute('data-search') || '').toLowerCase();
          if (!q || hay.indexOf(q) !== -1) row.removeAttribute('hidden');
          else row.setAttribute('hidden', '');
        });
        updateButtons();
      });
    }

    // Refuse to submit without verification and a selection.
    form.addEventListener('submit', function (e) {
      if (!footprintOk || checkedCount() === 0) {
        e.preventDefault();
      }
    });

    if (retry) retry.addEventListener('click', function () { location.reload(); });

    updateButtons();

    if (!window.isSecureContext || !navigator.geolocation) {
      onError({ code: 2 });
      return;
    }

    var watchdog = setTimeout(function () { onError({ code: 3 }); }, FALLBACK_AFTER_MS);
    try {
      navigator.geolocation.getCurrentPosition(
        function (pos) { clearTimeout(watchdog); onGranted(pos); },
        function (err) { clearTimeout(watchdog); onError(err); },
        { enableHighAccuracy: false, timeout: FALLBACK_AFTER_MS, maximumAge: 0 }
      );
    } catch (e) {
      clearTimeout(watchdog);
      onError({ code: 2 });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();`;
