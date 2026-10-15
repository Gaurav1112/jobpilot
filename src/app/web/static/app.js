// jobpilot dashboard: shows htmx request errors to the user (script-src 'self'; no inline script anywhere).
// htmx does not swap a 4xx/5xx answer, so without this a refused click would change nothing and say nothing.
(function () {
  'use strict';
  var region = function () { return document.getElementById('htmx-error'); };
  var show = function (text) {
    var el = region();
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  };
  document.addEventListener('htmx:beforeRequest', function () {
    var el = region();
    if (el) el.hidden = true;
  });
  document.addEventListener('htmx:responseError', function (e) {
    var xhr = e.detail && e.detail.xhr;
    var status = xhr ? xhr.status : 0;
    var body = xhr && typeof xhr.responseText === 'string' ? xhr.responseText.trim().slice(0, 300) : '';
    if (status === 403) show('Your session expired, reload the page and try again.');
    else if (status === 503) show(body || 'jobpilot is busy finishing today’s run — try again in a moment');
    else if (status === 413) show('That was too long to save.');
    else show(body ? body : 'Something went wrong (' + status + '). Reload the page and try again.');
  });
  document.addEventListener('htmx:sendError', function () {
    show('The dashboard did not answer. Is “jobpilot serve” still running?');
  });
})();

// Freelance (Task 10): the Copy button copies exactly the bytes of the recorded .txt file. It fetches the same file the
// .txt link serves (same origin, sha256-checked by the server) and puts its text on the clipboard unchanged. Without
// JavaScript the button stays hidden and the .txt link is the way to get the text.
(function () {
  'use strict';
  var say = function (btn, text) {
    var status = btn.parentNode && btn.parentNode.querySelector('.copy-status');
    if (status) status.textContent = text;
  };
  var wire = function () {
    var buttons = document.querySelectorAll('button.copy-btn[data-copy-src]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') continue;
      btn.hidden = false;
      btn.addEventListener('click', function (e) {
        var b = e.currentTarget;
        var src = b.getAttribute('data-copy-src');
        if (!src || src.charAt(0) !== '/') return;
        say(b, '');
        fetch(src, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('The text file could not be read (' + r.status + '). Reload the page.');
            return r.arrayBuffer();
          })
          .then(function (buf) {
            // fatal: a file that is not valid UTF-8 is refused rather than copied with replacement characters
            var text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
            return navigator.clipboard.writeText(text);
          })
          .then(function () { say(b, 'Copied. Paste it on the platform yourself.'); })
          .catch(function (err) { say(b, (err && err.message) || 'Could not copy. Use the .txt file below.'); });
      });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

// UX upgrade A12 (D7 2.4.3, 4.1.3): after an htmx swap, focus goes back to the control that was used (stable ids), else
// to the swapped element itself; the change is announced once in the polite live region #live. Without JavaScript none
// of this runs and the forms post as plain HTML.
(function () {
  'use strict';
  var lastId = null;
  var targetId = null;
  document.addEventListener('htmx:beforeRequest', function (e) {
    var a = document.activeElement;
    lastId = a && a.id ? a.id : null;
    var t = e.detail && e.detail.target;
    targetId = t && t.id ? t.id : null;
  });
  document.addEventListener('htmx:afterSettle', function () {
    var swapped = targetId ? document.getElementById(targetId) : null;
    var again = lastId ? document.getElementById(lastId) : null;
    if (again) again.focus();
    else if (swapped) {
      swapped.setAttribute('tabindex', '-1');
      swapped.focus();
    }
    var say = swapped ? swapped.getAttribute('data-live') : null;
    var live = document.getElementById('live');
    if (live && say) {
      if (live.textContent === say) {
        live.textContent = '';
        setTimeout(function () { live.textContent = say; }, 50);
      } else live.textContent = say;
    }
    lastId = null;
    targetId = null;
  });
})();
