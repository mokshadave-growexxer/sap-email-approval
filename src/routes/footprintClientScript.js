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
    var submitBtn = document.getElementById('decision-submit');
    var sessionInput = document.getElementById('session_id');
    var settled = false;

    if (retry) retry.addEventListener('click', function () { location.reload(); });

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
        return fetch(registerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (r) { return r.json(); });
      });
    }

    function applyResult(res, okMsg, blockedMsg) {
      if (res && res.session_id) {
        sessionInput.value = res.session_id;
        submitBtn.disabled = false;
        setStatus(okMsg, 'ok');
      } else {
        submitBtn.disabled = true;
        setStatus(blockedMsg, 'err');
        if (retry) retry.style.display = 'inline-block';
      }
    }

    function fail(msg) {
      submitBtn.disabled = true;
      setStatus(msg, 'err');
      if (retry) retry.style.display = 'inline-block';
    }

    function onGranted(pos) {
      if (settled) return;
      settled = true;
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      register({
        process_id: processId,
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timezone: tz,
      }).then(function (res) {
        applyResult(res, 'Verified — you may proceed.', 'Could not verify your location. Please enable location access and reload.');
      }).catch(function () {
        fail('Could not register your footprint. Please reload and try again.');
      });
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      var method = 'unavailable';
      if (err && err.code === 1) method = 'denied';
      else if (err && err.code === 3) method = 'timeout';
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      register({ process_id: processId, geo_method: method, timezone: tz }).then(function (res) {
        applyResult(
          res,
          'Verified (location unavailable) — you may proceed.',
          'Location access is required to confirm this decision. Please enable location permissions and reload this page.'
        );
      }).catch(function () {
        fail('Location access is required to confirm this decision. Please enable location permissions and reload this page.');
      });
    }

    if (!window.isSecureContext) {
      fail('This page must be opened over HTTPS (or on localhost) so your location can be verified.');
      return;
    }
    if (!navigator.geolocation) {
      onError({ code: 2 });
      return;
    }

    var watchdog = setTimeout(function () { onError({ code: 3 }); }, 12000);
    navigator.geolocation.getCurrentPosition(
      function (pos) { clearTimeout(watchdog); onGranted(pos); },
      function (err) { clearTimeout(watchdog); onError(err); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();`;
