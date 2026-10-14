// Client script for the approval confirm page. Served as an external file so it
// satisfies the app's Content-Security-Policy (script-src 'self'); inline scripts
// are blocked by helmet's default CSP. The process id is read from a data
// attribute rather than interpolated into inline JS.
export const FOOTPRINT_CLIENT_JS = `(function () {
  function init() {
    var form = document.querySelector('form[data-process-id]');
    if (!form) return;
    var processId = form.getAttribute('data-process-id');
    var registerUrl = form.getAttribute('data-register-url') || '/api/v1/footprint/register';
    var statusBox = document.getElementById('geo-status');
    var statusText = document.getElementById('geo-text');
    var spinner = statusBox ? statusBox.querySelector('.spinner') : null;
    var retry = document.getElementById('geo-retry');
    var decisionBtns = form.querySelectorAll('.decision-btn');
    var sessionInput = document.getElementById('session_id');
    var settled = false;
    // If the location cannot be fetched for ANY reason (denied, timed out, hung,
    // unsupported, non-HTTPS, register error), the approver may still decide
    // without it once this much time has passed since the page started.
    var FALLBACK_AFTER_MS = 10000;
    var REGISTER_TIMEOUT_MS = 15000;
    var startedAt = Date.now();

    if (retry) retry.addEventListener('click', function () { location.reload(); });

    function setDecisionsEnabled(enabled) {
      for (var i = 0; i < decisionBtns.length; i++) decisionBtns[i].disabled = !enabled;
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
        setDecisionsEnabled(true);
        setStatus(okMsg, 'ok');
      } else {
        setDecisionsEnabled(false);
        setStatus(blockedMsg, 'err');
        if (retry) retry.style.display = 'inline-block';
      }
    }

    function fail(msg) {
      setDecisionsEnabled(false);
      setStatus(msg, 'err');
      if (retry) retry.style.display = 'inline-block';
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
            'Location unavailable — you may proceed without it.',
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
        if (res && res.session_id) applyResult(res, 'Verified — you may proceed.', '');
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
