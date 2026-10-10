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
