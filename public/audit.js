// ---------------------------------------------------------------------------
// audit.js  —  Live audit session: continuous QR scanner + manual confirm.
// Loaded only on the active audit session page.
// ---------------------------------------------------------------------------
(function () {
  var confirmedCount = parseInt(document.getElementById('auditConfirmedCount').textContent, 10) || 0;

  // --- Mark a tool as confirmed in the DOM -----------------------------------
  function markConfirmed(toolId, toolName) {
    var row = document.getElementById('row-' + toolId);
    if (!row) return;

    // If it's in the pending list, move it to the confirmed list.
    var pendingList = document.getElementById('pendingList');
    var confirmedList = document.getElementById('confirmedList');

    if (pendingList && pendingList.contains(row)) {
      // Remove from pending
      row.parentNode.removeChild(row);
      // Update pending heading count
      updatePendingHeading();

      // Add to confirmed list
      if (confirmedList) {
        var li = document.createElement('li');
        li.className = 'audit-row audit-row--confirmed';
        li.id = 'row-' + toolId;
        li.innerHTML = '<div class="audit-row__info"><span style="color:var(--go)">✓</span><span>' + escHtml(toolName) + '</span></div>';
        confirmedList.insertBefore(li, confirmedList.firstChild);
        // Make sure the confirmed <details> is visible
        var det = confirmedList.closest('details');
        if (det) det.open = true;
      }
    }

    // Update counter
    confirmedCount++;
    document.getElementById('auditConfirmedCount').textContent = confirmedCount;
  }

  function updatePendingHeading() {
    var pending = document.getElementById('pendingList');
    if (!pending) return;
    var remaining = pending.querySelectorAll('.audit-row').length;
    var h2 = pending.closest('.card') ? pending.closest('.card').previousElementSibling : null;
    // Find the h2 above the pending card
    var el = document.getElementById('pendingList').closest('.card');
    if (el) {
      var prev = el.previousElementSibling;
      while (prev && prev.tagName !== 'H2') prev = prev.previousElementSibling;
      if (prev && prev.tagName === 'H2') {
        prev.textContent = 'Not yet confirmed (' + remaining + ')';
      }
    }
    if (remaining === 0) {
      // Replace with "all confirmed" message
      var card = document.getElementById('pendingList').closest('.card');
      if (card) {
        card.outerHTML = '<div class="card card--center" style="margin-top:1rem"><p class="muted">Every tool confirmed. 🎉</p></div>';
      }
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // --- POST a confirm to the server -----------------------------------------
  function confirmTool(shortId, onDone) {
    fetch(SCAN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'short_id=' + encodeURIComponent(shortId),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { onDone(data); })
      .catch(function () { onDone({ ok: false, error: 'Network error' }); });
  }

  // --- Manual confirm buttons ------------------------------------------------
  document.querySelectorAll('.audit-confirm-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var shortId = btn.getAttribute('data-short-id');
      var toolId  = parseInt(btn.getAttribute('data-tool-id'), 10);
      btn.disabled = true;
      confirmTool(shortId, function (data) {
        if (data.ok) {
          markConfirmed(toolId, data.tool.name);
        } else {
          btn.disabled = false;
        }
      });
    });
  });

  // --- QR scanner -----------------------------------------------------------
  var video     = document.getElementById('scanVideo');
  var canvas    = document.createElement('canvas');
  var ctx       = canvas.getContext('2d', { willReadFrequently: true });
  var statusEl  = document.getElementById('scanStatus');
  var resultEl  = document.getElementById('scanResult');
  var scannerDetails = document.getElementById('scannerDetails');
  var stream    = null;
  var scanning  = false;
  var cooldown  = false; // brief pause after each successful scan

  function toCode(text) {
    var m = String(text).match(/\/t\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    m = String(text).match(/^[A-Z0-9]{4,10}$/);
    return m ? m[0] : null;
  }

  function showResult(msg, isOk) {
    if (!resultEl) return;
    resultEl.textContent = msg;
    resultEl.className = 'audit-scan-result audit-scan-result--' + (isOk ? 'ok' : 'warn');
    resultEl.hidden = false;
    clearTimeout(resultEl._timer);
    resultEl._timer = setTimeout(function () { resultEl.hidden = true; }, 2500);
  }

  function tick() {
    if (!scanning) return;
    if (cooldown) { requestAnimationFrame(tick); return; }
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var result = (typeof jsQR === 'function')
        ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
        : null;
      if (result && result.data) {
        var code = toCode(result.data);
        if (code) {
          cooldown = true;
          statusEl.textContent = 'Found it…';
          confirmTool(code, function (data) {
            if (data.ok) {
              if (data.already) {
                showResult('✓ Already confirmed: ' + data.tool.name, false);
              } else {
                showResult('✓ Confirmed: ' + data.tool.name, true);
                markConfirmed(data.tool.id, data.tool.name);
              }
            } else {
              showResult(data.error || 'Not found', false);
            }
            statusEl.textContent = 'Point your camera at a tool\'s QR sticker.';
            setTimeout(function () { cooldown = false; }, 1500);
          });
        }
      }
    }
    requestAnimationFrame(tick);
  }

  function startScanner() {
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = 'Camera not available on this device.';
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.play();
        scanning = true;
        requestAnimationFrame(tick);
      })
      .catch(function () {
        statusEl.textContent = 'Could not access camera.';
      });
  }

  function stopScanner() {
    scanning = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  // Start/stop scanner when the <details> opens/closes
  if (scannerDetails) {
    scannerDetails.addEventListener('toggle', function () {
      if (scannerDetails.open) startScanner(); else stopScanner();
    });
    // Auto-open on mobile (screen width < 768)
    if (window.innerWidth < 768) {
      scannerDetails.open = true;
    }
  }

  window.addEventListener('pagehide', stopScanner);
})();
